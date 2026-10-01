# Paxos Health dashboard

`/paxos` (`paxos.rodiger.io/` redirects there) is a health dashboard for every Paxos-issued asset. Assets,
chains, contract addresses, peer sets, reference assets, thresholds and windows are discovered or
derived from public data on each build; nothing about specific assets is hard-coded. An insight
engine reports findings that are statistically unusual for the asset's own history or its peers,
and every figure carries its source and age.

## Architecture

```
GET /api/paxos  (api/paxos.js, Vercel function, maxDuration 60 s)
  lib/paxos/index.js      buildPaxosHealth(): orchestration, memoisation, timings
    sources.js            collectRaw(): every upstream request, provenance per source
      http.js             fetch with timeout, per-host concurrency/spacing, 429 cool-down; never throws
      cache.js            module-scope TTL + LRU cache (survives warm invocations; stale-on-error)
      registry.js         discovery tiers, identity joins, chain-name normalisation, peers, references
    model.js              buildModel(): normalised series per asset (pure, no clock)
    engine.js             run(): 34 detectors -> E = m x p -> novelty -> Pareto rank -> clusters, health grid
      detectors.js, stats.js, format.js
    attribution.js        deterministic "what changed" by asset and chain
    payload.js            buildPayload(): the schemaVersion 1 JSON (Compact series, rounding, no NaN)
pages/paxos/index.html + app.js   static page; one fetch of /api/paxos, everything derived from it
```

This document is the reference for the data contracts between the modules (model, engine output,
payload); the dashboard check validates the payload against them on every build.

## Sources and cadences

Each logical source reports `status` (ok / partial / stale / error / skipped), requests, failures,
bytes, latency, `fetchedAt`, `dataAsOf` and `ageHours`. Age is judged against the source's own
cadence: a source is **stale** when even its freshest series is older than two publication
intervals, or when a cached last-good copy had to be served after an upstream failure; **partial**
when some requests failed, some series lag, rows were dropped as malformed or out of range, or a
parser self-check failed (docs table not recognised, fee labels naming no asset, empty category); the
message says which. A daily series reports the instant of its last point as its as-of (DefiLlama's
CDN-fill `Last-Modified` is never used as a data time); the stablecoin list reports its own
`Last-Modified`, which is a real snapshot time. `ageHours` is the age at `generatedAt`: it is
recomputed whenever a payload is built or restamped (memo hit), and a reused payload keeps both, so
a reader's current age is `ageHours + (now - generatedAt)` (the page does this).

| id | upstream | used for | cadence |
|---|---|---|---|
| llama-stablecoins | stablecoins.llama.fi `/stablecoins`, `/stablecoin/{id}`, `/stablecoincharts?stablecoin=` | supply, per-chain balances, peers | 1 h |
| llama-market | stablecoins.llama.fi `/stablecoincharts/all`, `/stablecoincharts/{chain}` | market totals, chain totals (every chain the engine treats as material) | 24 h |
| coingecko | api.coingecko.com markets, coin details, market_chart (USD and XAU) | discovery, price, volume, gold | 15 min |
| llama-coins | coins.llama.fi hourly/daily charts, first price | peg, peg peers, gold references; daily price history for supply valuation (500-day chunks) | 1 h |
| llama-yields | yields.llama.fi `/pools`, `/lendBorrow`, `/chart/{pool}` | DeFi footprint and pool trends | 1 h |
| llama-fees | api.llama.fi fee adapter `paxos-stablecoin-issuer` (fees, revenue) | issuer economics (model estimate) | 24 h |
| coinmetrics | community-api.coinmetrics.io asset metrics | activity (3 years), gold supply history since inception | 24 h |
| onchain | Blockscout instances (via Chainscout), Jupiter + Solana RPC | holders, token supply per chain | 15 min |
| paxos-docs | docs.paxos.com `llms.txt` -> mainnet address tables | discovery, addresses | 24 h |
| llama-protocol | api.llama.fi protocol graph `paxos`, `/v2/chains` | discovery, chain names | 24 h |
| chainscout | chains.blockscout.com | explorer hosts per chain | 24 h |

Keyless CoinGecko is the binding constraint (it rate-limits after a handful of calls per IP). Set
`COINGECKO_DEMO_API_KEY` in the Vercel environment to raise the spacing from 2 s to 0.65 s; without
it, CoinGecko-only figures (turnover, XAU premium, gold references) may be missing on a cold
instance and the source shows `partial` or `error`. Dune was removed: the account's plan has no API
access, and a build-time snapshot would have been stale data presented next to live data.

Ingestion rules (data layer): every daily point means "the value at 00:00 UTC of that day" (DefiLlama
day labels; CoinGecko's exact-midnight points, its intraday "now" point dropped; coins.llama.fi
near-midnight prints rounded to midnight; Coin Metrics rows shifted one day, since a row covers its
day). Rows dated before 2009-01-03 or later than now + 1 day are dropped (counted, source `partial`).
coins.llama.fi hourly charts are requested with a search width of half the period, so every print is
assigned to its nearest hour (the API default, 10% of the period, drops prints more than 6 minutes off
the hour, which made live hourly feeds look stopped). Only same-host https redirects are followed.
**Consensus daily price** (`asset.priceConsensus`): per
day, the median of the available daily sources (DefiLlama implied price, coins.llama.fi daily,
CoinGecko daily close); when only two disagree by more than the asset's own robust daily price scale,
the one agreeing with the neighbouring days wins. The peg chart (`series.price`) and the peg detectors
use this same series, so one bad print cannot drive a finding the chart contradicts.

## Discovery

The issuer is defined only by: the CoinGecko category `paxos-ecosystem`, the Paxos docs index, the
DefiLlama fee adapter `paxos-stablecoin-issuer` (labels "Yields from X backing") and the DefiLlama
parent protocol `paxos`. Assets are the union of those tiers, merged by CoinGecko id, DefiLlama id or
(chain, contract address); joins to DefiLlama list entries use gecko id, exact name or contract
address, never a ticker alone. Status: **dead** = DefiLlama `deadFrom`; **active** = found by an
active-issuance tier (CoinGecko category or Paxos docs); **legacy** = otherwise. Peg peers (largest
non-Paxos fiat-backed coins of the same peg type until half the segment is covered, and at least three,
the smallest set whose daily median ignores one bad print) and gold references (largest same-unit
tokenized gold assets) are selected the same way. Chain names are normalised onto DefiLlama
display names.

`colorIndex`: active assets sorted by first date (earliest of first price, supply or chain start) get
slots 0..n-1; legacy and dead assets are drawn in neutral gray.

## Insight engine

**Detectors** (34; each returns tests with a p-value, a direction and a USD materiality):

| dimension | detectors | what is tested |
|---|---|---|
| supply | supply.move, supply.drawdown, supply.streak, supply.regime, supply.bridged_out | net issuance over 1/7/30-day (and longer) windows vs non-overlapping history; current drawdown vs completed episodes; run length; growth regime breaks (rank CUSUM on calendar weeks ending Sunday, persistence-aware null); share minted on a home chain sitting bridged elsewhere |
| market | market.share, market.peer_growth | share of the same-peg stablecoin market (from `market.coverageFrom`); growth rank among live peers (p counts coins; the share of peer dollars that grew slower is descriptive) |
| chains | chain.attribution, chain.move, chain.concentration, chain.dominance, chain.lifecycle | offsetting moves across chains; every material asset x chain series; effective number of chains (as a change); the asset's share of a chain; new chains vs launch rate |
| peg | peg.deviation, peg.regime, peg.flow_coupling, peg.gold_tracking | deviation from $1 (consensus daily price), on its own and relative to the same-peg majority peers (non-Paxos only); regime breaks; whether discounts lead redemptions (circular-shift null); gold premium to spot XAU and to other gold tokens |
| defi | defi.utilization, defi.yield_outlier, defi.footprint (context), defi.tvl_trend, defi.divergence | lending utilisation vs other stablecoin markets; pool APY vs same-chain stablecoin pools; pool TVL trends; pooled TVL vs supply |
| usage | usage.turnover, usage.activity | volume / market cap (weekly means); Coin Metrics active addresses, transfers, holders |
| portfolio | portfolio.mix, portfolio.leadership | offsetting moves across the active Paxos USD stablecoins (issuance in one matched by redemptions in another; no conversion is observed); lead of the largest over the second |
| economics | economics.reserve_income, economics.rate_regime | modelled fee income; implied reserve yield regimes |
| data | dq.tracking_change, dq.freshness, dq.history_gap, dq.cross_source, dq.price_sanity, dq.list_reconciliation, dq.frozen | (neutral: they describe the data, not the asset) coverage changes; overdue series (overdue time vs the pooled gaps of every series of the same feed, material when the hidden flow, floor x days overdue, reaches the floor); missing history; source disagreement (decomposed per chain with the on-chain supply); placeholder prices; list-vs-chart breaks; frozen dead assets |

Cross-asset tests use the pseudo-asset **Paxos USD** (the sum of the active Paxos USD stablecoins,
token flows at today's price; legacy wind-downs are analysed individually but not summed). Flow tests
on it chain-link the opening balance of a member whose supply history starts after its market price,
so a coverage start is not counted as issuance.

**Notability.** Each test's p-value is computed against the asset's own non-overlapping history (or
its peers), with an effective-sample-size floor for persistent levels. A finding is notable when
`E = m x p < 1`. The family is the health dimension pooled across assets, and its size is
`m = max(m_dimension, round(M / D))`: the tests run in that dimension, but never fewer than the
load's average per dimension (M non-context tests over the D dimensions that ran one), so no
dimension is judged more leniently than an average-sized one. A test that cannot reach significance
even at its smallest possible p (minP x m >= 1) is reported as underpowered and counted in neither M
nor m_dimension, so detectors that structurally cannot fire do not inflate m. E is the number of
equally extreme results expected by chance; this caps the expected number of chance findings at one
per dimension per load; it does not promise zero. `surprise.m` is this m. (A per-cell family, asset x
dimension, was rejected: cells holding one or two tests let p = 0.5 count as notable.)
`insights.family` reports the counted tests, the number of dimensions (about that many chance findings
per load at most) and how many tests were underpowered. Regime tests (rank CUSUM) use a null that keeps
the series' own persistence (AR(1) sieve bootstrap, persistence measured around the best split and
bias-corrected by a parametric bootstrap); a series whose effective sample n(1-r)/(1+r) is below two
minimum segments (16 points) is untestable (a random walk or a T-bill-like rate cannot show a regime
distinguishable from its own wandering). Up to 999 simulations with sequential stopping (Besag &
Clifford). Measured null rate P(p <= 0.01) <= about 0.02 from i.i.d. noise to a random walk. Windows of
one test group are collapsed to the strongest (the others stay as evidence). "Largest/highest since D"
claims consider every earlier window, overlapping ones included; when a window overlapping today's was
at least as extreme no record clause is printed. The engine and the attribution ignore points dated
after now + 1 day (the data layer drops them too), and the lead-lag search uses at most the latest 4096
days.

**Data-quality findings** (`dq.*`, the data dimension) describe the sources, not the assets: they are
neutral (never negative or positive), are labelled as data-quality items, and never set an asset's
supply, peg or market cell.

**Materiality.** A finding must move at least the asset's floor: the median of non-flat daily net
flows over the past 365 days at today's price (supply-equivalent USD for economics).

**Novelty.** Every notable and material backtestable finding is dated by re-running only its own
detector for that asset as of 1, 2, ... days ago (same m and floors). The episode starts after the
last full native week (7 days) without firing; age is capped at 30 days. Younger than 30 days ->
feed ("What's unusual"); 30 days or more -> standing conditions. The watchlist holds material,
non-notable tests that are at least 1 bit surprising (p <= 0.5), at most 40.

**Ranking and clustering.** Feed items are ranked by Pareto fronts on (adjusted surprise -log2 E,
materiality share, recency) without weights, and clustered by root cause (largest USD driver: asset,
chain, sign), so "supply fell", "share fell" and "chain X drove it" form one card.

**Attribution** ("What changed") is deterministic: the Paxos USD change over 1/7/30/90/365 days and
all history, split by asset and by asset x chain (chains below the floor and coverage differences
fold into "Other chains", so rows add up exactly). It runs on the payload's token-flow view (USD
stablecoins valued at today's price, see below), so every window's total equals the hero's change.

## Payload (GET /api/paxos, schemaVersion 1)

Top level: `schemaVersion, generatedAt, dataAsOf, cache, timingsMs, sources, discovery, totals,
market, assets, peers, pegPeers, goldRefs, economics, attribution, insights`. Conventions:

- `Compact = { start: 'YYYY-MM-DD', values: [...] }`, contiguous days, `null` = no observation.
- Changes `{ d1, d7, d30, d90, d365 }`, each `{ abs, pct }` with `pct` in **percent**; `drawdownPct` in
  percent (<= 0). Shares, `marketShare`, `turnover24h`, `turnover7d`, `utilization`, `impliedYield`,
  `footprintShare` and `rewardShare` are **fractions**. `pegDevBp` in basis points (gold: premium of
  the XAU price over one ounce). Pool `apy*` in percent (DefiLlama native). Hourly `t` in unix seconds.
- **One snapshot per number.** The hero total, the asset table, the chain table and the attribution
  all use the last point of each asset's daily supply series. `assets[k].current.supplyAsOf` and
  `totals.usd.supplyAsOf` say when that is from: DefiLlama's daily charts are a snapshot taken around
  00:00 UTC and labelled with that day, so the time is 00:00 UTC of the last day unless the model
  knows a later time for that point (`asset.supplyAsOf` on the same day). The total is as old as its
  oldest member's observation on its last day. `dataAsOf` equals `totals.usd.supplyAsOf` (the figure
  the page leads with), never a fetch or cache-fill time. `peers.rows` come from DefiLlama's hourly
  list (current vs its `circulatingPrevDay/Week/Month`), which is fresher than the daily snapshot;
  `peers.asOf` is that list's time, so the two can differ by up to a day and each says when it is from.
- **Changes are token flows.** For USD stablecoins `series.supplyUsd`, `current.change`, `ath`,
  `drawdownPct`, every `totals.usd` figure and the attribution are native supply valued at today's
  price (the latest implied daily price; the last point equals DefiLlama's own USD value), so a peg
  wobble is not a supply change (`current.changeBasis = 'token-flow'`). `totals.usd.marketShare`
  divides DefiLlama's per-day USD values by the market total valued the same way. Other assets
  (gold) keep USD market-value semantics for `change`/`ath`/`drawdownPct`
  (`changeBasis = 'market-value'`) and add `changeNative`, `athNative` and `drawdownNativePct` in
  their own unit (`unit`, e.g. oz); these three are null for USD stablecoins.
- USD stablecoins carry `series.supplyUsd` only (`series.supply` is null); gold carries both (oz, USD).
- Where a history covers fewer chains than the asset (gold: Coin Metrics is Ethereum-only), the
  current level comes from the model's complete snapshot (`asset.current`: history's last point plus
  the other issuer chains' on-chain supply, valued at the freshest quote); `current.supplySource`
  then ends in `+onchain`, `supplyAsOf` is its oldest part, and a note explains. Otherwise
  `supplySource` is the history's source and the current level is its last point.
- `current.priceAsOf` is the time of the quote behind `price` (the freshest of CoinGecko, coins.llama.fi
  hourly, the DefiLlama list and the daily price, preferring the most precise within two hours);
  `pegAsOf` dates `pegDevBp` (USD stablecoins: that quote; gold: the 00:00 UTC daily XAU point).
- `discovery.addresses[].role`: `issuer` or `unverified` (issuer contracts; unverified when there is
  no issuer docs table to check against), `bridged` or `unlisted` (third-party contracts carrying the
  asset's name: DefiLlama counts them only as bridged, or only an aggregator lists them). Third-party
  contracts are listed for labelling only, never counted as issuance. `assets[k].onchain[].address`
  is the contract each holder/supply reading is for.
- `totals.allUsd = { label, current, coveredUsd, missing, supplyAsOf }`: every Paxos-issued asset not
  marked dead (incl. legacy and gold) in USD. An asset without a USD value is never counted as $0:
  `current` is null and `missing` lists it, `coveredUsd` sums the others.
- `series.price` is the model's consensus daily price (`asset.priceConsensus`: the series the peg
  detectors test) when present, else DefiLlama's implied daily price, CoinGecko's or coins.llama.fi's.
- Chain `series` are USD at today's price (token flows; a price move is not a flow), last 400 days.
  Chain changes are measured back from the asset's latest chain day; a chain whose DefiLlama tracking
  ended counts as 0 from then on, a lagging chain carries its last value.
- `series.priceHourly` (and peg peers' / gold references') is omitted when the hourly series is more
  than a day old; the asset's notes say so and the page falls back to daily prices.
- `peers.rows` = the 25 largest live USD stablecoins plus every Paxos list member; `market.usdTotal`
  starts on the first Paxos supply day, `market.allTotal` covers the last 400 days.
- `market.coverageFrom`: the first day DefiLlama's USD total is comparable with today's (the last
  one-day rise in its log that exceeds every later 7-day move, judged only with a year of later
  history: coins being added to the total, not growth; 2020-04-03 on current data).
  `totals.usd.marketShare` starts there, as does the `market.share` detector (one rule,
  `detectors.helpers.coverageStart`); before it the "share" was a coverage artefact (58 % in 2018).
- `totals.usd.key` is the aggregate's pseudo-asset key in insights and the health grid ('Paxos USD');
  `totals.usd.label` is how to show it.
- `assets[k].activity.chain`: the one chain a Coin Metrics series covers when the model knows it (e.g.
  an Ethereum-only ERC-20 series), null when it covers every chain or is not stated.
- `sources[].staleAfterHours`: the age at which the data layer calls the source stale (null: not
  stated; the rule is two publication intervals). The page re-judges ages at view time with it.
- `insights.watch` and `insights.context` sparklines keep their last 60 points (feed and standing 120).
- `insights.family = { counted, dimensions, floor, underpowered }`: the tests counted in the family
  sizes, the dimensions that ran one (up to about that many findings per load can be chance), the
  average size per dimension, and the tests left out as underpowered. `insights.families` maps each
  dimension to the size `m` its findings were judged with.
- `timingsMs` are the stage timings of the build that produced this payload; `engine` is null when the
  insights were reused from an identical model (memo hit, see below).
- Size on the recorded fixture: about 630 KB raw, 192 KB gzip (gold supply history runs from 2019;
  three peg peers with hourly and daily prices); the dashboard check fails above 650 KB.

`insights.errors` lists detector errors, records or sections the data layer had to drop
(`sources`, `model`: one malformed upstream record degrades only itself) and any payload section that
could not be built (`payload.<section>`); such a section is `null` and the rest of the payload is
unaffected.

## Caching and failure behaviour

- CDN: `Cache-Control: public, s-maxage=1800, stale-while-revalidate=86400` on success. If a core
  source (stablecoin supply or market totals) is in `error`, or an active asset has no USD value (the
  all-assets total is then incomplete), `s-maxage` drops to 300 s so the page recovers sooner. The
  payload repeats the policy in `cache`. A snapshot is current while `now - generatedAt <=
  cache.sMaxAge`; after that the page says "Snapshot from <time>" and refetches
  (stale-while-revalidate is the CDN's mechanism for serving it meanwhile, not a freshness promise).
  The header's `s-maxage` is what is left of that budget (`sMaxAge` minus the payload's age when a
  memoised payload is served), so the CDN never holds a payload as fresh past `generatedAt + sMaxAge`.
- Warm instances: upstream responses are cached per endpoint (TTL 5 min to 24 h, last good copy kept
  for stale-on-error). The last payload is kept too (`X-Paxos-Memo` says which path served a request):
  `reuse` = younger than 15 minutes and than its own `sMaxAge`, returned as is (same `generatedAt`, no
  upstream call), which bounds an instance to at most 4 rebuilds an hour whatever requests reach it;
  `shared` = joined a build in flight; `hit` = rebuilt, and the model was identical (sha1 of the model
  plus source statuses, within the same UTC hour), so the insights are reused without re-running the
  engine and the payload is restamped with the new `generatedAt`, source records and timings;
  `miss` = full build (`off` when memoisation is disabled, as in the offline checks). `Server-Timing` lists only the stages that ran for that request (`reuse`:
  `memo;desc="reuse", total;dur=0`; `hit`: no engine) plus `memo;desc=...`.
- If no asset has any supply data at all, the API answers 502 with `Cache-Control: no-store` and a
  generic message (the detail is only in the server log); the CDN keeps serving the last good
  response under stale-while-revalidate. Every other failure degrades only what depends on the failed
  source.
- Methods: GET and HEAD (same headers, no body), OPTIONS (CORS preflight); others 405.
- The API reads only the method; query strings are ignored (no redirect: a self-redirect would loop
  if the platform ever appended a parameter). Cache-busting URLs miss the CDN cache but cannot fan out
  upstream: the memo serves the same payload for up to 15 minutes per instance (`reuse`), so one
  instance rebuilds at most four times an hour. No user input reaches an upstream request.

Measured locally against live upstreams (keyless CoinGecko): cold build 2 to 11 s (fetch dominates;
the long runs wait on CoinGecko's 2 s spacing, the short ones had CoinGecko already rate-limited),
model about 20 ms, engine about 340 ms (detectors about 210 ms, novelty about 125 ms), payload about
10 ms; peak RSS about 445 MB; payload 550 to 570 KB raw, about 180 KB gzip.

## Running and testing

- Offline checks (no network, about 15 s; run by `scripts/build-vercel.sh` before the site build):
  `node scripts/check-paxos-dashboard.mjs`. It runs `check-paxos-sources.mjs` (data layer),
  `check-paxos-engine.mjs` (statistics and engine) and `check-paxos-page.mjs` (the page's own
  behaviour rules under its DOM shim: freshness labels, coverage starts, net issuance, focus, units,
  data-quality presentation; `PAXOS_CHECK_KEEP_GOING=1` lists every failure), builds the payload from
  the recorded fixture and validates it against the contract, then checks semantics, not just shapes:
  - units: every share, turnover, peg deviation, drawdown and change is checked against the figures
    it is derived from (a x100 slip fails);
  - one snapshot per number: `dataAsOf = totals.usd.supplyAsOf`, every `supplyAsOf` falls on its
    series' last day, attribution totals equal the hero's changes in every window;
  - token flows: a 50 bp price wobble in the model must not change a USD stablecoin's supply change;
    a gold price move must not change `changeNative`;
  - freshness: hourly series older than a day are dropped with a note; a lagging source is not `ok`;
    a source older than two cadences is `stale` (synthetic `createClient` runs); a memo hit recomputes
    source ages; a degraded payload is not reused past its own budget; rebuilds per hour are bounded;
  - `api/paxos.js` with a fake request: 200, HEAD, query string -> 308 without building, OPTIONS,
    405, reuse headers (remaining `s-maxage`, truthful `Server-Timing`), CoinGecko down, both price
    providers down (incomplete total, short cache), everything down -> 502 with a generic message;
  - the deploy config: host redirect (not a rewrite), security headers, and a CSP derived from what
    `index.html` and `app.js` actually load;
  - the page: hard-coded assets, chains, addresses, dual axes, pie charts, `innerHTML`, eval; the pure
    helpers and formatters in a `vm`; and the page itself rendered under a small DOM shim against the
    payload for every asset filter and range (plus a narrow viewport, a stale snapshot and a failed
    load). Any "could not be rendered" section, "could not be drawn" chart, `console.error`, NaN or
    undefined text, or chart config breaking the dataviz rules (pie, second value axis, non-numeric
    points, throwing tick or tooltip callbacks) fails the build. The shim supports simple compound
    selectors only and names any DOM member it lacks.
  Wall-clock time is reported, not asserted, so a slow build machine cannot fail a deploy;
  `PAXOS_PERF_STRICT=1` turns the 60 s budget into a failure.
- Fixture: `scripts/fixtures/paxos/upstream.json.gz` (recorded responses, replayed by
  `fixture-fetch.mjs`). Re-record when the request set changes:
  `node scripts/record-paxos-fixtures.mjs` (live, about 3.5 min keyless; it refuses to write a
  fixture whose CoinGecko or DefiLlama requests failed, writes a temporary file and replaces the
  fixture only after verifying that replay reproduces the model).
- Live: `node scripts/dev-paxos.mjs [port]` serves `pages/paxos`, `static/` and `api/paxos.js` (live
  upstreams) on 127.0.0.1 (set `HOST` to expose it; every cold build spends upstream requests,
  including CoinGecko calls on your key when it is set). It applies vercel.json's redirects and headers
  as Vercel would, so the CSP and the host redirect behave locally as in production; `/` is 404 unless
  the Host is `paxos.rodiger.io` (`curl -H 'Host: paxos.rodiger.io' http://127.0.0.1:8790/`). Like
  Vercel's CDN it strips `s-maxage` and `stale-while-revalidate` from the browser's `Cache-Control`
  (the browser would otherwise serve stale copies itself); the CDN policy is in
  `x-dev-cdn-cache-control`.
  `vercel dev` also works.

## Page behaviour

- Freshness: "Current snapshot" only while the snapshot's age (`now - generatedAt`) is at most
  `cache.sMaxAge`; older, it says "Snapshot from <time>; refreshing" and refetches once promptly
  (about 4 s) before the minute tick takes over. Source ages and ok -> stale are re-judged at view time
  (`ageHours + (now - generatedAt)` against `staleAfterHours`, else two cadences), since a CDN copy
  keeps the ages it was generated with.
- Every current figure is labelled with its own time: the hero and asset table with `supplyAsOf`
  ("Supply snapshot ..."), the peers table with `peers.asOf`.
- Net issuance is computed per member from each series; a series that starts later than its asset's
  `discovery.assets[].firstDate` never books its opening balance as issuance (the bucket says which
  member it excludes). The engine's aggregate does the same for flow statistics (`aggregate().flow`).
- The market-share line starts at `market.coverageFrom`, and the chart says why.
- Data-quality findings are shown as neutral "Data quality" notes, after asset-health findings; the
  health grid's data column reads "Source note" and is excluded from the hero verdict.
- Gold: changes and drawdown are shown in ounces (`changeNative`, `athNative`, `drawdownNativePct`);
  the USD change is labelled as a value change including the gold price.
- `totals.allUsd.current` null is shown as ">= coveredUsd; excludes <missing> (no USD value)".

## Deployment notes

- `vercel.json` sets `maxDuration: 60` for `api/paxos.js` and redirects `paxos.rodiger.io/` to `/paxos`
  (307, host match). It is a redirect, not a rewrite: Vercel applies rewrites after the filesystem,
  and `dist/index.html` (the site root) matches `/` first. The domain must be added to the Vercel
  project and pointed at Vercel in DNS by the owner; until then the redirect is inert.
- Security headers (`vercel.json` `headers`): `/paxos` and `/paxos/*` get `X-Content-Type-Options:
  nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` and an
  enforced CSP that allows exactly what the page loads: `default-src 'none'`; scripts from `'self'`
  and the one pinned Chart.js file URL (not all of cdn.jsdelivr.net, which would let any npm package's
  script run); styles from `'self'` plus `'unsafe-inline'` for the page's inline `<style>` block (a
  hash would have to be re-pinned on every page edit; there are no inline scripts and app.js only
  sets styles through the CSSOM); images (favicons) and `fetch` same-origin; no framing, `<base>` or
  form targets. `/api/paxos` gets nosniff, `Referrer-Policy: no-referrer` and a deny-all CSP. When the
  page starts loading anything new (a Chart.js upgrade, another script, fonts), update the CSP in
  both `/paxos` entries; the dashboard check derives the requirement from index.html and fails until
  it matches.
- Environment variable `COINGECKO_DEMO_API_KEY` (CoinGecko demo key, sent only to api.coingecko.com,
  never logged): optional, but recommended for production, where keyless CoinGecko is mostly
  rate-limited from Vercel's shared IPs. A cold build makes about 13 CoinGecko calls; a warm instance
  rebuilds at most 4 times an hour and query-string variants never build.

## Known limitations

- Keyless CoinGecko: see above. Turnover, the XAU premium and gold references depend on it.
- The on-chain source is usually `partial`: some explorers block automated requests (Cloudflare) and
  some chains have no public Blockscout instance; holder counts cover the chains that answer.
- When a coins.llama.fi hourly series does stop, the dashboard says so (`dq.freshness`, a neutral
  data-quality note, and the asset notes) and uses daily data instead.
- Gold supply history comes from Coin Metrics `SplyCur` (from inception) when it is longer than
  CoinGecko's 365 days. It covers the Coin Metrics id's chain only (Ethereum); the current level adds
  the other issuer chains' on-chain supply (`current.supplySource` ends in `+onchain`, and a note says
  so), while changes, peak and drawdown stay on the Ethereum history. USD history is valued at the
  consensus daily price of the same instant; days without one are missing rather than interpolated.
- `defi.tvl_trend` and `defi.divergence` use the pools that are largest today (top pools covering half
  of the asset's matched footprint, at most 8), which favours pools that grew recently; the finding
  text says so. DeFi footprint counts pair pools in full and is an upper bound.
- Per-chain history is fetched for active assets only; legacy and dead assets show totals.
- Issuer economics are DefiLlama's model (reserve yield on modelled supply), not reported figures.
- Each dimension is judged at its own size or the load's average per dimension, whichever is larger
  (about 30 counted tests on current data, so p < ~0.03); single-window chain moves on short histories
  rarely qualify, and the deterministic "What changed" attribution shows them regardless.
- Holders by chain lists material or issuer-contract chains without an on-chain reading as "not available";
  it cannot say whether the explorer failed or none exists for that chain, because the on-chain source
  records only the chains that answered.
