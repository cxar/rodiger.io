# Paxos Health dashboard

`/paxos` (`paxos.rodiger.io/` redirects there) is a health dashboard for every Paxos-issued asset. Assets,
chains, contract addresses, peer sets, reference assets, thresholds and windows are discovered or
derived from public data on each build; nothing about specific assets is hard-coded. An insight
engine reports findings that are statistically unusual for the asset's own history or its peers; a
deterministic briefing turns them, the supply attribution and the peg into one verdict and three to
five short lines per period; and every figure carries its source and age. The page answers "is
everything OK, what moved and where, anything to look at?" in one screen (about 140 words, 7 graphics)
and keeps every number reachable within two clicks.

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
      copy.js             render(test): plain title, why, role and evidence labels from the detector's facts
    attribution.js        deterministic "what changed" by asset and chain
    payload.js            buildPayload(): the schemaVersion 1 JSON (Compact series, rounding, no NaN),
                          status, cache policy; briefing.js applyBriefing() after the insights
pages/paxos/index.html + app.js + paxos.css + vendor/chart.umd.min.js
                          static page; one fetch of /api/paxos (preloaded), everything derived from it
scripts/monitor-paxos.mjs + .github/workflows/paxos-monitor.yml
                          production monitor and CDN warmer (see Monitoring)
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
| onchain | Blockscout (PRO API with `BLOCKSCOUT_API_KEY`, else public instances via Chainscout), EVM public RPCs (via the chainid.network registry), Jupiter + Solana RPC | holders (explorers), token supply per chain (`totalSupply` over RPC, explorer as fallback) | 15 min |
| paxos-docs | docs.paxos.com `llms.txt` -> mainnet address tables | discovery, addresses | 24 h |
| llama-protocol | api.llama.fi protocol graph `paxos`, `/v2/chains` | discovery, chain names | 24 h |
| chainscout | chains.blockscout.com | explorer hosts per chain | 24 h |
| chainlist | chainid.network `chains_mini.json` | EVM chain ids by name (last resort after DefiLlama and CoinGecko) and public RPC endpoints | 24 h |

Keyless CoinGecko is the binding constraint (it rate-limits after a handful of calls per IP). Set
`COINGECKO_DEMO_API_KEY` in the Vercel environment to raise the spacing from 2 s to 0.65 s; without
it, CoinGecko-only figures (turnover, XAU premium, gold references) may be missing on a cold
instance and the source shows `partial` or `error`.

Blockscout's public per-chain explorers (e.g. robinhoodchain.blockscout.com) sit behind bot protection
and can answer scripted requests with a 403 challenge page. Set `BLOCKSCOUT_API_KEY` (free at
dev.blockscout.com: 5 requests/s, 100K credits/day, about 20 credits per token read) to read every
Blockscout chain through `api.blockscout.com/{chainId}`, the supported route; without it the public
hosts are tried and a blocked one is named in the `onchain` source message. Token supply does not
depend on an explorer: it is read from each chain with ERC-20 `totalSupply()` over the public RPCs that
the chainid.network registry lists (https on a public name, no templated keys), trying them in turn
and remembering the last one that answered. An endpoint that fails while another answers is reported
as a fail-over, not a data gap. Dune was removed: the account's plan has no API
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
feed (stage `new`); 30 days or more -> standing conditions (`ongoing` while a measured condition holds, `past` for a dated event; a peg widening that is the coin's latest split and still describes its last week is a condition holding, `ongoing`, so a coin still off its peg never drops out of the verdict at 30 days). The watchlist holds material,
non-notable tests that are at least 1 bit surprising (p <= 0.5), at most 40.

**Ranking and clustering.** Feed items are ranked by Pareto fronts on (adjusted surprise -log2 E,
materiality share, recency) without weights, and clustered by root cause (largest USD driver: asset,
chain, sign), so "supply fell", "share fell" and "chain X drove it" form one card.

**Attribution** ("What changed") is deterministic: the Paxos USD change over 1/7/30/90/365 days and
all history, split by asset and by asset x chain (chains below the floor and coverage differences
fold into "Other chains", so rows add up exactly). It runs on the payload's token-flow view (USD
stablecoins valued at today's price, see below), so every window's total equals the hero's change.

## Insight copy (lib/paxos/copy.js)

Detectors emit numbers (`facts`), not page copy. `copy.render(test)` is the one place that writes the
words the page shows; it never reads `headline`, which stays the technical sentence for the API and the
page's Method panel. The rules (FINAL-SPEC §4.1, checked on the fixture, a synthetic model that fires
every detector, and the replays):

- `title`: at most 14 counted words and 100 characters; it starts with its subject (the asset key,
  `{asset} on {chain}`, `{asset}:` for lens and data notes, `Paxos USD`, or `Est.` for economics), the
  number comes right after it, and it states its own window (`over 4 days`, `yesterday`, `since Sep 11`).
- `why`: at most 20 counted words, one plain comparison (peers, rank, record, driver or share); it never
  repeats the value and baseline, which print in the facts row.
- Counted words: every whitespace token whose first letter-or-digit is a letter (tickers, chain names and
  months count; `$5.85B`, `−1.0%`, `7d` and glyphs do not).
- Banned in titles, `why`, the briefing and the page's default view: `p =`, `E =`, bit(s), materiality,
  material, rotation, regime, effective, notable, Pareto, CUSUM, robust, percentile, drawdown, dimension,
  cluster, novelty, underpowered, null, bp(s), basis point(s), utilised, should, consider, warning, risk.
  The statistics live under Method and in About this data. Never advice.
- Formats (one formatter set on server and page): money `$5.85B` / `$99M` / `$2.0M` / `$850K`; U+2212
  minus, `+` for gains, `flat` for an exact zero; percent changes 1 decimal below 10% and none from 10%;
  shares to 2 significant digits below 1%; peg as a percent of $1 with 2 decimals (`0.44% below $1`,
  `≈ $1` under 0.005%); gold in ounces; dates `Sep 11` within the current year, else `Mar 2023`.
- A record clause (`; largest drop since Aug 22`) needs a non-zero change and a date at least one native
  week before the window starts; `on record` when nothing earlier matches. A change of exactly zero is a
  tie, never an extreme (`stats.windowTest` gives p = 1), and a change worth less than one dollar counts
  as zero (sources repeat or round the last value), so dust moves never become findings.
- A detector without a template would fall back to the headline cut at its first `;` or `:`: the engine
  check fails on any fallback, so none ships.

Each insight also carries `stage` (`new`, `ongoing`, `past`, `watch`, `context`), `role` (where the page
places it: `headline`, `evidence`, `lens`, `context`, `note` for data notes, `api` for API-only),
`novelty.since` (a regime's split date or a dated event's day, else the as-of day minus the episode's
age) and `tier` (below).

## Briefing and verdict (lib/paxos/briefing.js)

`applyBriefing(payload)` builds `payload.briefing` from the payload alone (no clock, so a memo hit stays
correct) and sets each insight's `tier` in place. It never throws: a failing builder drops only its own
bullets and is listed in `briefing.errors`.

- **Tiers** (`tierOf`): a peg finding is `major` when the coin's mean distance from $1 over the finding's
  own days is wider than every peg peer's (no peer data: major; a peer's isolated bad print, a day at least
  0.1% from $1 and over four times as far as both neighbours, is left out of the peer bar everywhere); any other finding is `major` at the All
  scope when it involves at least the **business floor** (`insights.floorsUsd` of the total, its median
  daily flow: $21.8M on the fixture), and always within an asset's own scope (its floor already gated the
  feed). Gold tracking and activity findings have no dollar size and are `minor` at All. Data notes,
  API-only and context items get no tier. Legacy assets and data notes never reach the All-scope verdict
  or briefing.
- **Verdict** (per scope): `unknown` without insights or tests; `unusual` when a feed cluster (or a
  standing item still holding, which joins the cluster about the same asset and area) has a major
  headline or evidence member (an evidence member states the unit only when it is alone: an excess-only
  peg unit is still a peg finding); `partial` when `insights.errors` is not empty; `minor` when any other
  unit is in scope (minor ones, and lens-only units of any size: `verdict.minor` counts them all, so the
  verdict never says "Nothing unusual" over a listed item); else `clear`. In an asset's scope, an item
  about the total belongs to the asset when its title names it or the asset is its largest driver by at
  least the asset's floor. Copy: `Unusual: USDP peg`,
  `3 unusual: USDP peg, USDG supply +1 more`, `Nothing major · 1 smaller finding`,
  `Nothing unusual · 851 checks` (`USDG: nothing unusual · 214 checks` in an asset scope),
  `Partly checked · 2 checks could not run`, `Checks unavailable in this snapshot`.
- **Frames** `d7`, `d30`, `d90`, `d365` over the attribution windows (a gold asset's own frames end on its
  own supply day). Bullets, 3 to 5 per frame and scope, in this order: the state (the hero on the page),
  up to three major findings (stated by the member whose precedence is highest: the peg deviation before
  the regime, supply before chains), events (a record, a new chain, a change of the largest coin), movers
  (the largest asset moves with the chains behind them, signed: `USDG −$99M (−3.1%): X Layer −$85M,
  Ethereum −$25M, Solana +$21M`, plus `others ±$X` when the named chains leave a tenth unexplained; a single
  chain never reads larger than the whole: `led by Ethereum −$52M; other chains +$15M`), the steady lines
  (peg against the peg peers: `within X% of $1` for coins inside the peers' widest day, `{coin}'s widest
  day X% below $1 (Sep 25)` for one outside; `Steady:` and tone `positive` only when no coin is outside,
  every peg cell is within its own history and no peg item or split is about the coin; gold:
  `PAXG supply steady: …`), and filler (kind `filler`: another period, the period first, `30 days: …`)
  only while fewer than three lines exist. `within X%` and `X% or less` are bounds, so X is rounded up to
  0.01% unless it exceeds the rounded figure by under 0.001% (then it prints as a table would).
- **A peg finding is restated on the period** from the series the cards and the Peg lens use (the daily
  consensus price): `USDP 0.44% below $1 on average over 7 days`, or, when the widening began inside the
  period, `… since Sep 11`; the detail gives the peers over the same days and the typical gap before the
  split; `values = { gap, days, peerGap, before }`. The detector's own window stays in Method.
- Yesterday, when it moved the total by at least the business floor, is folded into its asset's mover
  (`…; +$113M yesterday`, its chains or what the other days did in the detail) or is its own line
  (`Yesterday, PYUSD +$113M (+4.1%): …`). Records read `Up from {level} on {period start}`; a new chain
  folds into its asset's mover detail, and a chain whose first day already held the asset's floor reads
  `first tracked {D} at {usd}` (a tracking start, not a launch). A record or "largest since" clause needs
  its date at least min(3 windows, 90 days) before the window starts.
- Numbers agree: the state's `values.deltaUsd` is `totals.usd.change[w].abs`, a mover's is its
  `attribution.windows[w].assets` row, and the market's move is the `market.usdTotal` ratio over the frame.

## Payload (GET /api/paxos, schemaVersion 1)

Top level: `schemaVersion, generatedAt, dataAsOf, status, cache, timingsMs, sources, discovery, totals,
market, assets, peers, pegPeers, goldRefs, economics, attribution, insights, briefing`. The contract is
`scripts/fixtures/paxos/contract-v2.mjs` (`validate(payload)` lists every shape, enum, cap and rule
violation; every check uses it), and `scripts/fixtures/paxos/contract-v2.sample.json` is the day-1 slice
of the v2 additions on the recorded fixture (deep-merge it onto a v1 payload: `mergeSample`). Conventions:

- `Compact = { start: 'YYYY-MM-DD', values: [...] }`, contiguous days, `null` = no observation.
- Changes `{ d1, d7, d30, d90, d365 }`, each `{ abs, pct }` with `pct` in **percent**; `drawdownPct` in
  percent (<= 0). Shares, `marketShare`, `turnover24h`, `turnover7d`, `utilization`, `impliedYield`,
  `footprintShare` and `rewardShare` are **fractions**. `pegDevBp` in basis points (gold: premium of
  the XAU price over one ounce). Pool `apy*` in percent (DefiLlama native). Hourly `t` in unix seconds.
- **One snapshot per number.** The hero total, the cards, the chain table and the attribution
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
  `insights.watch` holds every data note plus the 20 most unusual other items, in engine order;
  `insights.watchTotal` is the count before that cap. `facts` is dropped from watch and context items.
- v2 insight fields (every list): `title`, `why`, `stage`, `role`, `tier`, `novelty.since`,
  `evidence.unit` (`usd`, `fraction`, `count`, `oz`, `ratio`, `usdPerDay`: the unit of `evidence.series`,
  null without a series), `evidence.valueLabel`/`valueText` and `baselineLabel`/`baselineText` (formatted
  strings for the facts row), and on feed and standing items `facts` (per detector: USD in dollars, shares,
  gaps, growth and yields as fractions (`defi.yield_outlier.facts.apy` 0.0991 = 9.91%), days as
  integers, dates `YYYY-MM-DD`, `record` as `{ word, since }` or null; peg facts carry `peers` and
  `peerGap`, the widest peer's mean |price − 1| over the same days; the field names per detector are the
  `facts` literals in `lib/paxos/detectors.js`). `evidence.unit` describes `evidence.series`, or
  `evidence.value` when there is no series (`ratio` is a plain number: effective chains, a correlation,
  an APY in percent units). See Insight copy above.
- `briefing = { version: 1, asOf (= totals.usd.supplyAsOf), key, floorUsd, peers, verdict, frames: { d7,
  d30, d90, d365 }, byAsset: { [asset key]: { verdict, frames } }, errors }`; `verdict = { level, tone,
  items: [{ id (the unit's lead insight), asset, chain, area, lens, tone, since }], minor, checks, text }`;
  each frame `{ window, days, from, to, label, more, bullets }` (3 to 5 bullets; an asset with no supply
  figure in the snapshot has its state bullet only); each bullet `{ kind: state | finding | event | mover
  | steady | filler, tone, tier (findings), since, text (≤14 words), detail (≤20), subject: { asset,
  chain }, link: { lens, focus, insight }, refs, values? }`. `null` (with an `insights.errors` entry
  `payload.briefing`) if it could not be built.
- `status = { level: 'ok' | 'degraded', reasons: [{ kind: 'source' | 'section' | 'engine', id, status,
  message }] }`: degraded when a source is `stale` or `error`, a section is null, an asset has no USD
  value (`totals.allUsd.missing`, reason id `totals.allUsd`) or `insights.errors` is not empty; one reason
  each. The response header `X-Paxos-Status` and the monitor use the same rule.
- `economics.assets`: the asset keys DefiLlama's fee model covers (the fee-label discovery tier).
- Rounding (size): `assets[k].chains[].series` and `market.allTotal` carry 4 significant digits,
  `market.usdTotal` 6 (a ratio input); asset supply series, `totals.usd` and the attribution stay exact, so the hero, the
  briefing and "Where supply moved" reconcile to the dollar.
- `insights.family = { counted, dimensions, floor, underpowered }`: the tests counted in the family
  sizes, the dimensions that ran one (up to about that many findings per load can be chance), the
  average size per dimension, and the tests left out as underpowered. `insights.families` maps each
  dimension to the size `m` its findings were judged with.
- `timingsMs` are the stage timings of the build that produced this payload; `engine` is null when the
  insights were reused from an identical model (memo hit, see below).
- Size on the recorded fixture: about 633 KB raw, 170 KB gzip, of which the briefing is about 31 KB (gold
  supply history runs from 2019; three peg peers with hourly and daily prices); the dashboard check fails
  above 700 KB raw or 190 KB gzip and warns above 680 / 180.

`insights.errors` lists detector errors, records or sections the data layer had to drop
(`sources`, `model`: one malformed upstream record degrades only itself) and any payload section that
could not be built (`payload.<section>`); such a section is `null` and the rest of the payload is
unaffected.

## Caching and failure behaviour

- CDN: `Cache-Control: public, s-maxage=1800, stale-while-revalidate=86400, stale-if-error=86400` on
  success. If a core source (stablecoin supply or market totals) is in `error`, or an active asset has no
  USD value (the all-assets total is then incomplete), `s-maxage` drops to 300 s so the page recovers
  sooner; any other source in `error` gives 600 s (`partial` and `stale` never shorten it). The payload
  repeats the policy in `cache` (`sMaxAge`, `staleWhileRevalidate`, `staleIfError`). Every response also
  sends `X-Paxos-Status` (the `status.level`), `X-Paxos-Generated-At`, `Access-Control-Allow-Origin: *`
  and `Cross-Origin-Resource-Policy: cross-origin`, so `curl -I` answers "healthy, and how old?". Each
  build logs one JSON line, `{"evt":"paxos.build","memo","status","totalMs","fetchMs","engineMs",
  "sources":{"ok","partial","stale","error"},"cgCalls","tests","feed","errors","briefingErrors","bytes"}`
  (`cgCalls` audits the CoinGecko quota); a failed build logs `{"evt":"paxos.build_failed"}`. A snapshot is
  current while `now - generatedAt <= cache.sMaxAge`; after that the page says "Snapshot {HH:MM} UTC"
  and refetches
  (stale-while-revalidate is the CDN's mechanism for serving it meanwhile, not a freshness promise).
  The header's `s-maxage` is what is left of that budget (`sMaxAge` minus the payload's age when a
  memoised payload is served), so the CDN never holds a payload as fresh past `generatedAt + sMaxAge`.
- Warm instances: upstream responses are cached per endpoint (TTL 5 min to 24 h, 7 days for CoinGecko identity data:
  coin details, asset platforms, the gold category; last good copy kept
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

- Offline checks (no network; about 7 s locally, run by `scripts/build-vercel.sh` before the site build):
  `node scripts/check-paxos-dashboard.mjs`. It starts its four sub-checks as child processes at once and
  awaits them at the end:
  - `check-paxos-sources.mjs`: the data layer (discovery, model invariants, http robustness, stale-on-error,
    the 7-day CoinGecko identity TTL, on-chain routes);
  - `check-paxos-engine.mjs`: statistics, engine and detectors, the insight schema, the copy rules on every
    detector (caps, banned words, no fallback title, `copy.js` never reads `headline`), the zero-change
    and record-clause fixes, and the golden feed;
  - `check-paxos-briefing.mjs`: the briefing's shape and copy, reconciliation with the totals and the
    attribution, tiers and verdict items recomputed independently from the payload, today's output on the
    fixture, the damaged-payload set, the partial / smaller-finding / busy-day variants, a newly discovered
    asset, and a replay of the fixture truncated to 6 earlier days (`PAXOS_REPLAY=31` replays all 31),
    each without `briefing.errors`;
  - `check-paxos-page.mjs`: the page under a DOM shim (`scripts/fixtures/paxos/dom-shim.mjs`): the default
    view's word budget (≤180 words, ≤110 without tickers, chain names and months; ≤350 anywhere), one
    sentence per line, no banned word, ≤8 graphics, no table before a Table toggle, ≤2,500 elements;
    briefing rows and links; hero = Net = "Where supply moved" rows, In + Out = Net; card peg = the Peg
    table's Average = the daily-price mean; every asset × period × lens; focus after period, asset and lens changes; live regions, nested controls, the tab keys, a
    Table toggle per figure, a throw in each component; the Cache Storage snapshot, the chip states and
    the verdict's late-source override; older (v1), degraded, busy, quiet and newly discovered payloads;
    375 px; the palette.

  The dashboard check itself builds the payload from the recorded fixture and validates it against the
  contract (and the day-1 sample), then checks semantics, not just shapes:
  - units: every share, turnover, peg deviation, drawdown and change is checked against the figures it is
    derived from (a x100 slip fails);
  - one snapshot per number: `dataAsOf = totals.usd.supplyAsOf`, every `supplyAsOf` falls on its series'
    last day, attribution totals equal the hero's changes in every window;
  - token flows: a 50 bp price wobble in the model must not change a USD stablecoin's supply change; a gold
    price move must not change `changeNative`;
  - freshness: hourly series older than a day are dropped with a note; a lagging source is not `ok`; a
    source older than two cadences is `stale`; a memo hit recomputes source ages;
  - status and cache: the TTL rule (ok, partial, stale, a non-core and a core source in error), the status
    reasons, the watch cap (every data note kept), rounding, size guards;
  - memoisation with the engine stubbed (it tests the memo, not the engine): shared builds, reuse, hits,
    at most 4 rebuilds an hour, a degraded payload not reused past its budget; two real builds are
    byte-identical;
  - `api/paxos.js` with a fake request and stub builds: 200, HEAD, the exact Cache-Control per TTL variant,
    `X-Paxos-Status` / `X-Paxos-Generated-At` / CORP, the JSON build log line, query string ignored,
    OPTIONS, 405, reuse headers; real builds with CoinGecko down, both price providers down and the
    stablecoin list down; everything down -> 502 with a generic message;
  - the deploy config: host redirect (not a rewrite), the exact strict CSP for `/paxos` (no
    `'unsafe-inline'`, no external origin), Permissions-Policy, COOP and CORP, the vendored Chart.js hash,
    the API preload before the scripts, no inline styles, the build script's skip guard (executed), the
    monitor workflow's triggers; and nothing hard-coded in the page (assets, chains, addresses).

  `PAXOS_CHECK_KEEP_GOING=1` lists every failure instead of stopping at the first (the dashboard check and
  its sub-checks). Wall-clock time is reported, not asserted, so a slow build machine cannot fail a
  deploy; `PAXOS_PERF_STRICT=1` turns the 30 s budget into a failure.
- Build: `scripts/build-vercel.sh` skips the Paxos checks when `VERCEL_GIT_PREVIOUS_SHA` (the last
  successful deployment) is in the clone and nothing they cover changed since (`lib/paxos`, `api/paxos.js`,
  `pages/paxos`, the check scripts and fixtures, `dev-paxos.mjs`, the monitor script and workflow, the build
  script, `vercel.json`, `static`), logging `paxos unchanged since <sha>`; the daily same-commit cron
  redeploy takes that path. Any doubt (no SHA, a shallow clone without it, no git, a diff) runs them.
  Vercel exposes `VERCEL_GIT_PREVIOUS_SHA` only to projects with an Ignored Build Step, so `vercel.json`
  sets `"ignoreCommand": "exit 1"` (exit 1 = always build). Confirm on the first redeploy after merge that
  the build log shows `paxos unchanged since …`.
- Fixture: `scripts/fixtures/paxos/upstream.json.gz` (recorded responses, replayed by
  `fixture-fetch.mjs`). Re-record when the request set changes:
  `node scripts/record-paxos-fixtures.mjs` (live, about 3.5 min keyless; it refuses to write a
  fixture whose CoinGecko or DefiLlama requests failed, writes a temporary file and replaces the
  fixture only after verifying that replay reproduces the model). The golden feed in the engine check and
  today's output in the briefing check then need a reviewed refresh.
- Live: `node scripts/dev-paxos.mjs [port]` serves `pages/paxos`, `static/` and `api/paxos.js` (live
  upstreams) on 127.0.0.1 (set `HOST` to expose it; every cold build spends upstream requests,
  including CoinGecko calls on your key when it is set). It applies vercel.json's redirects and headers
  as Vercel would, so the CSP and the host redirect behave locally as in production; `/` is 404 unless
  the Host is `paxos.rodiger.io` (`curl -H 'Host: paxos.rodiger.io' http://127.0.0.1:8790/`). Like
  Vercel's CDN it strips `s-maxage`, `stale-while-revalidate` and `stale-if-error` from the browser's
  `Cache-Control`; the CDN policy is in `x-dev-cdn-cache-control`. `PAXOS_DEV_PAYLOAD=<file.json>` serves
  a saved payload instead (`error:<status>` simulates a failure, `PAXOS_DEV_DELAY_MS` a slow build).
  `vercel dev` also works.

## Monitoring

`.github/workflows/paxos-monitor.yml` runs `node scripts/monitor-paxos.mjs https://www.rodiger.io` (no
dependencies, no secrets) after every successful **Production** deployment (Vercel posts
`deployment_status` to GitHub), once a day at 07:17 UTC (after the 06:00 cron redeploy) and on demand
(`workflow_dispatch`). After a deployment it polls `/api/paxos` every 10 s for up to 120 s until the payload
is newer than the deployment, which also warms the new deployment's CDN cache.

- **Fails** (a failed run; GitHub notifies the owner as for any failed workflow): not 200 or not JSON;
  `schemaVersion` not 1; a payload older than `cache.sMaxAge` + 1 h also on a second request 45 s later
  (`PAXOS_MONITOR_RETRY_MS`; the first may be a stale-while-revalidate copy whose rebuild it started); a supply
  or market source in `error`; `totals.allUsd.missing` not empty; `status.level` `degraded` on this run
  and the previous one (the workflow keeps the previous level in an Actions cache); after a deployment, no
  newer payload within 120 s.
- **Warns** (annotations): any source `stale` or `error`; `insights.errors`; `briefing.errors`; a payload
  over 650 KB; a `Server-Timing` total over 30 s; an `X-Paxos-Status` header that disagrees with the body;
  a single degraded run.
- Each run writes a step summary: generatedAt and age, status, cache headers, `x-vercel-cache`,
  `X-Paxos-Memo`, sources by status, feed, verdict, build time and payload size.
- Locally: `node scripts/monitor-paxos.mjs http://127.0.0.1:8790` against the dev server (exit 0 or 1).
- GitHub stops scheduled workflows in a public repository after 60 days without activity; the deployment
  trigger keeps working regardless.

## Page behaviour

The page renders one scope (`All` or one asset, legacy coins behind `+n legacy`) and one period (`7d`,
`30d`, `90d`, `1y`, `All`; default 7d) everywhere: verdict, hero, briefing, cards and the six lenses
(`Supply`, `Chains`, `Peg`, `Market`, `Usage`, `Income (est.)`). The URL holds the state
(`?asset=&range=&lens=&legacy=1&focus=#f=<insight id>`, defaults omitted, `lens=defi` and `lens=revenue`
still work); nothing is remembered in the browser, so a shared link renders the same for everyone.

- **Freshness chip** (never "Live"): `Supply as of {Mon D} · prices {HH:MM} UTC` while `now - generatedAt <=
  cache.sMaxAge` (plus `· n sources late|down`, judged at view time, and `· n figure(s) missing` for each
  `status.reasons` entry of kind `section`, e.g. an asset without a USD value); `Snapshot {HH:MM} UTC · updating` or
  `· no newer data yet` for an older copy; `· couldn't refresh` with "Showing the last saved data." and
  Retry when a refresh fails; `Offline · snapshot …`; `Loading…` (after 3 s: "Building a fresh snapshot;
  this can take up to 15 seconds."); `Data unavailable` with Retry and the raw JSON link when there is
  nothing to show (a 200 the page cannot read says "The data service sent a snapshot this page cannot
  read."). Source ages are re-judged at view time (`ageHours + (now - generatedAt)` against
  `staleAfterHours`, else two cadences; `ok` and `partial` sources alike), since a CDN copy keeps the ages
  it was generated with.
- **Last good snapshot**: each validated payload is saved in Cache Storage (`paxos-health:s1`); on the next
  visit the fetch starts first (the API is preloaded) and the snapshot renders if the network has not
  answered within 150 ms; a failed fetch waits for the snapshot read before choosing the error panel, and
  an older network copy never replaces (or overwrites) a newer snapshot. Snapshots older than 7 days or of
  another schema are ignored; every Cache Storage call is guarded; there is no service worker.
- **Verdict**: the briefing's verdict for the scope. It never says "Nothing unusual" when `insights.errors`
  is not empty (`Partly checked …`) or when a supply or market source is late at view time (`Nothing
  unusual in available data · supply data {age} old`). Without a briefing (older payloads) it is derived
  from the health cells.
- **Hero**: the total (or the asset; gold in ounces with `worth $…`), the period's change, a sparkline of
  at least 90 days with the period drawn in ink and shaded (captioned `90 days` / `7d`), the share of USD
  stablecoins with its change in percentage points (`(flat)` under 0.005 pp) and `all USD stablecoins
  ±x%`, and the distance from the peak plus everything Paxos issues (`≥ $X with gold and legacy (PAXG
  missing)`, "Excludes {key}: no USD value." when a value is missing). An asset without a supply figure
  says "No supply figure in this snapshot" (hero and card, the failing sources in the tooltip).
- **Briefing**: the frame's bullets after the state (2 to 4 lines), each with its lens link (`Peg ›`) that
  sets lens, focus and `#f=` and moves focus to the lens (on narrow screens the link sits at the end of the
  last line); a `since` badge the text already states is left out; ✓ only on a positive steady line, `·`
  on other steady lines and fillers; the full-history period's eyebrow adds "(longest summary)". A finding
  expands into its evidence panel (mini chart, facts row, why, rarity in plain words, size, related lines,
  Copy link, Method); a restated peg finding's facts row is `Last 7 days: 0.44% · Before Sep 11: 0.05% ·
  Peers: ≤0.07%` and its size `Covers all $26M of USDP.` The verdict's `Details ›` opens the first finding.
- **Cards**: one per asset (All) or chain (asset scope): value, period change, sparkline, the main chain
  behind the move and the peg as the period's mean distance from $1 on daily prices (the same figure as the
  Peg table's Average); a flag button when the verdict names the asset; `ⓘ` for a material data note.
- **Lenses**: two figures each, with a computed title and a Table toggle (tables are built on first open;
  charts in view draw at once, those further down lazily), and a list of that lens's new and ongoing
  findings (at most 3, then Show more), headed "Unusual here" when the verdict names one of them and
  "Smaller findings" otherwise. A unit the briefing states reads as its bullet there and in All findings
  (same words, same start date, led by the same member). Supply's
  "Where supply moved" is exact arithmetic on the attribution (rows + Other + Unattributed = Net = the
  hero's change; In + Out = Net). Market starts at `market.coverageFrom` and says so. Market is disabled
  for gold, Income for assets outside `economics.assets`.
- **All findings** (Unusual, Earlier, Watching, Data notes) and **About this data** (sources, how findings
  work, checks by area, data notes, terms, what was found, build notes) are closed by default.
- Data notes (`dq.*`) are neutral notes, never unusual, never in the verdict or the briefing; gold changes
  and peaks are in ounces; legacy coins never enter `totals.usd` or the All-scope briefing.
- Every component renders in isolation: one that fails shows `Not in this snapshot.` (a chart: `This part
  couldn't be drawn. The table has the numbers.`) and the rest of the page stands. Without Chart.js every
  chart starts in table view ("Charts unavailable; showing tables.").
- Copy on the page follows the insight-copy rules above: no statistics vocabulary outside Method and About,
  one sentence per line, generated text drops a clause rather than print `n/a`, and a status colour (with
  an icon and a word) only for major findings: a finding line is coloured when its unit is one of the
  current scope's `verdict.items`, so the verdict, the lens-tab badges, the lists and About › Checks by
  area (`·` for a flagged cell the verdict does not name) always agree; a lens-only unit is a smaller
  finding and `verdict.minor` counts it.

## Deployment notes

- `vercel.json` sets `maxDuration: 60` for `api/paxos.js` and redirects `paxos.rodiger.io/` to `/paxos`
  (307, host match). It is a redirect, not a rewrite: Vercel applies rewrites after the filesystem,
  and `dist/index.html` (the site root) matches `/` first. The domain must be added to the Vercel
  project and pointed at Vercel in DNS by the owner; until then the redirect is inert.
- Security headers (`vercel.json` `headers`): `/paxos` and `/paxos/*` get `X-Content-Type-Options:
  nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`,
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin` and an enforced
  CSP that allows only the page's own origin: `default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';
  upgrade-insecure-requests`. Chart.js 4.5.1 is vendored at `pages/paxos/vendor/chart.umd.min.js` (its
  sha256 is the SRI the CDN copy was pinned to, `sha256-SERKgtTty1vsDxll+qzd4Y2cF9swY9BCq62i9wXJ9Uo=`; the
  check verifies it); styles live in `pages/paxos/paxos.css` (no inline `<style>`, no `style` attributes;
  app.js sets styles through the CSSOM only). `/api/paxos` gets nosniff, `Referrer-Policy: no-referrer`, a
  deny-all CSP and `Cross-Origin-Resource-Policy: cross-origin` (public data, set by the handler). When the
  page starts loading anything new, vendor it or update both `/paxos` entries; the dashboard check derives
  the requirement from index.html and fails until it matches.
- Environment variable `COINGECKO_DEMO_API_KEY` (CoinGecko demo key, sent only to api.coingecko.com,
  never logged): optional, but recommended for production, where keyless CoinGecko is mostly
  rate-limited from Vercel's shared IPs. A cold build makes about 13 CoinGecko calls; a warm instance
  rebuilds at most 4 times an hour whatever URL variant is requested.
- Environment variable `BLOCKSCOUT_API_KEY` (Blockscout PRO API key, free tier; sent only to
  api.blockscout.com as `authorization: Bearer`, never in a URL or log): **required for holder coverage**.
  Without it, holder counts are missing on chains whose public explorer blocks scripted requests: on
  2026-10-01 USDG's counts covered chains holding only 31% of its supply (Robinhood Chain, 22%, is
  blocked; X Layer, 46%, has no Blockscout instance), and the Usage lens marks the gap (`36,929+`,
  "Missing: …").

## Owner actions (not automated)

1. Set `BLOCKSCOUT_API_KEY` in the Vercel project (Production and Preview), a free key from
   https://dev.blockscout.com. Done when the `onchain` source message no longer names a blocked host and
   USDG holder coverage reaches at least half of its supply.
2. Keep `COINGECKO_DEMO_API_KEY` set (identity data is now cached for 7 days, so a warm instance spends its
   calls on prices and charts).
3. The monitor needs no secret: Actions must be enabled for the repository and Vercel's GitHub integration
   must post deployment statuses (it does by default). Failed runs notify through GitHub's usual
   workflow-failure notifications.

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
- Holders by chain lists material or issuer-contract chains without an on-chain reading as missing (the
  `+` marker and its tooltip); it cannot say whether the explorer failed or none exists for that chain,
  because the on-chain source records only the chains that answered.
- `market.usdTotal` carries 6 significant digits (4 misprinted about a quarter of 7-day market moves at
  their printed precision), so the market's move over a period is exact at 0.01%.
- The monitor runs from one GitHub runner (US East), so it warms that CDN region only.
