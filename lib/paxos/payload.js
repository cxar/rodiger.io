'use strict';

// Model + engine results -> the GET /api/paxos payload (schemaVersion 1, see docs/paxos-dashboard.md).
// Pure: no I/O, no clock (generatedAt is passed in). Every number is rounded for size and passed
// through fin(), so the payload never carries NaN/Infinity. Each section is built inside its own
// guard: a failure there nulls that section and is listed in insights.errors, never the whole payload.
// Size: chart-only series (per-chain history, market totals) carry 4 significant digits; asset-level
// supply series and the aggregate stay exact, because the hero, the attribution and net issuance must
// reconcile on them. The watchlist keeps every data note plus the most unusual others.
//
// Two conventions hold for every "current" figure:
// - One snapshot per number: the hero total, the asset table, the chain table and the attribution all
//   use the last point of each asset's daily supply series, and say when that is from (supplyAsOf;
//   DefiLlama's daily snapshot is labelled 00:00 UTC). dataAsOf is that time, never a fetch time. The
//   peers table uses DefiLlama's hourly list and carries its own asOf.
// - Changes are token flows: USD stablecoin supply is valued at today's price (tokenFlowView), so a peg
//   wobble is not a supply change. Other assets (gold) report USD market-value changes plus the same
//   figures in their own unit (changeNative, athNative, drawdownNativePct).

const S = require('./stats');
const D = require('./detectors');
const R = require('./registry');
const { toInsight } = require('./engine');

const H = D.helpers;
const DAY = 86400;
const NATIVE = D.NATIVE;
const CHAIN_DAYS = 400; // chain series window (the page's chain heatmap covers at most this)
const PRICE_DAYS = 1100; // ~3 years of daily prices; hourly covers the recent weeks
const ACTIVITY_DAYS = 400;
const PEERS_TOP = 25;
const POOLS_MAX = 25; // per asset, by TVL; poolCount/footprint always cover every matched pool
const WATCH_SPARK = 60; // watchlist/context sparklines keep their last 60 days (feed/standing keep B's 120)
// CDN policy. stale-while-revalidate serves the last copy while the CDN refetches; stale-if-error keeps
// serving it for a day while rebuilds fail (502). A payload missing a core supply/market source, or the
// USD value of an active asset, is re-checked after 5 min; one with any other source down after 10 min
// (cachePolicy).
const CACHE = { sMaxAge: 1800, staleWhileRevalidate: 86400, staleIfError: 86400 };
const CACHE_SOURCE_ERROR = { ...CACHE, sMaxAge: 600 };
const CACHE_DEGRADED = { ...CACHE, sMaxAge: 300 };
const WATCH_OTHERS = 20; // watchlist: every data-dimension item plus this many others, in engine order
const WINDOWS = [['d1', 1], ['d7', 7], ['d30', 30], ['d90', 90], ['d365', 365]];

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
// Source identifiers ("coinmetrics:SplyCur") in the notes the page shows, in words ("Coin Metrics supply").
const SOURCE_WORDS = { 'coinmetrics:SplyCur': 'Coin Metrics supply', 'defillama:fees-label': 'DefiLlama fee labels', 'defillama:protocol': 'the DefiLlama protocol graph', 'defillama:stablecoincharts': 'DefiLlama stablecoin charts', 'coingecko:category': 'the CoinGecko category', 'coingecko:market_chart(mcap/price)': 'CoinGecko market cap ÷ price', 'paxos-docs': 'Paxos docs' };
const sourceWords = (id) => SOURCE_WORDS[id] || String(id);
const r0 = (x) => (fin(x) ? Math.round(x) + 0 : null); // + 0 turns -0 into 0
const sig = (d) => (x) => (fin(x) ? Number(x.toPrecision(d)) + 0 : null);
const fix = (d) => (x) => (fin(x) ? Number(x.toFixed(d)) + 0 : null);
const s4 = sig(4), s6 = sig(6), s7 = sig(7), s8 = sig(8);
const nat = (x) => (fin(x) && Math.abs(x) >= 1e4 ? r0(x) : s6(x)); // native-unit amounts: whole units once large
const dayOf = (t) => Math.floor(Number(t) / DAY) * DAY;
const date = (t) => (fin(t) ? new Date(t * 1000).toISOString().slice(0, 10) : null);
const isoTime = (t) => (fin(t) ? new Date(t * 1000).toISOString() : null);
const parseTime = (s) => { const t = Date.parse(s); return fin(t) ? t / 1000 : null; };
const num = (x) => (fin(x) ? x : typeof x === 'string' && x.trim() !== '' && fin(Number(x)) ? Number(x) : null);
// A model timestamp as unix seconds: seconds, milliseconds (> 1e11) or an ISO string.
const timeOf = (x) => { const n = num(x); return n !== null ? (Math.abs(n) > 1e11 ? n / 1000 : n) : typeof x === 'string' ? parseTime(x) : null; };

// ---------- series helpers ----------
function lastPoint(s) {
  if (!s || !s.t) return null;
  for (let i = s.t.length - 1; i >= 0; i--) if (fin(s.v[i])) return { t: s.t[i], v: s.v[i] };
  return null;
}
// Value on day t or the nearest earlier observation (null before the series starts).
function valueAt(s, t) {
  if (!s || !s.t || !s.t.length || t < s.t[0]) return null;
  let lo = 0, hi = s.t.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s.t[mid] <= t) lo = mid; else hi = mid - 1; }
  for (let i = lo; i >= 0; i--) if (fin(s.v[i])) return s.v[i];
  return null;
}
// Series {t, v} -> Compact {start, values}: contiguous days from the first to the last observation
// (or the last `days` of them), null where a day is missing.
function compact(s, round, days = null) {
  if (!s || !s.t || !s.t.length) return null;
  let a = 0, b = s.t.length - 1;
  while (a <= b && !fin(s.v[a])) a++;
  while (b >= a && !fin(s.v[b])) b--;
  if (a > b) return null;
  const t1 = dayOf(s.t[b]);
  const t0 = days ? Math.max(dayOf(s.t[a]), t1 - (days - 1) * DAY) : dayOf(s.t[a]);
  const n = Math.round((t1 - t0) / DAY) + 1;
  const values = new Array(n).fill(null);
  for (let i = a; i <= b; i++) {
    const k = Math.round((dayOf(s.t[i]) - t0) / DAY);
    if (k >= 0 && k < n && fin(s.v[i])) values[k] = round(s.v[i]);
  }
  return { start: date(t0), values };
}
// Time of the latest observation on or before day t (null before the series starts).
function obsTimeAt(s, t) {
  if (!s || !s.t) return null;
  for (let i = s.t.length - 1; i >= 0; i--) if (s.t[i] <= t && fin(s.v[i])) return s.t[i];
  return null;
}
const mapSeries = (s, f) => (s && s.t ? { t: s.t, v: s.v.map((v, i) => (fin(v) ? f(v, s.t[i], i) : null)) } : null);
const delta = (prev, curr, round = r0) => (fin(prev) && fin(curr) ? { abs: round(curr - prev), pct: prev ? fix(4)((100 * (curr - prev)) / prev) : null } : null);
// Changes over the native windows, measured back from the series' last observation (pct in percent).
function changes(s, round = r0) {
  const lp = lastPoint(s), out = {};
  for (const [k, d] of WINDOWS) out[k] = lp ? delta(valueAt(s, lp.t - d * DAY), lp.v, round) : null;
  return out;
}

// Token-flow view of the model: every live USD stablecoin's supplyUsd is its native supply valued at
// today's price (H.priceOf: the latest implied daily price, the chain table's convention), so a change
// of the series is a token flow and a peg wobble is not a supply change. The last point equals the
// model's own last USD value. Everything else is the model itself. The payload's totals and assets and
// the attribution (index.js) use this view; memoised per model so they share one object.
const views = new WeakMap();
function tokenFlowView(model) {
  if (!model || !Array.isArray(model.assets)) return model;
  if (views.has(model)) return views.get(model);
  const assets = model.assets.map((a) => {
    if (!a || a.kind !== 'usd-stablecoin' || !a.supply || !a.supply.t || !a.supply.t.length) return a;
    const px = H.priceOf(a);
    return fin(px) && px > 0 ? { ...a, supplyUsd: { t: a.supply.t, v: a.supply.v.map((v) => (fin(v) ? v * px : null)) } } : a;
  });
  const view = { ...model, assets };
  views.set(model, view);
  return view;
}

// Time the last point of an asset's supply series represents: the model's supplyAsOf when it falls on
// that point's UTC day, else the day label (00:00 UTC, DefiLlama's daily snapshot time), so a figure is
// never presented as fresher than it is.
function supplyTimeOf(a, t) {
  if (!fin(t)) return null;
  const lp = lastPoint(a.supplyUsd) || lastPoint(a.supply);
  const own = timeOf(a.supplyAsOf);
  return lp && dayOf(lp.t) === dayOf(t) && own !== null && dayOf(own) === dayOf(t) ? own : dayOf(t);
}
function peak(s) {
  let best = null;
  if (s && s.t) s.v.forEach((v, i) => { if (fin(v) && (!best || v > best.value)) best = { value: v, date: date(s.t[i]) }; });
  return best;
}
const hourly = (arr) => (arr && arr.length ? { t: arr.map((x) => Math.round(x.t)), v: arr.map((x) => s6(x.p)) } : null);
// Hourly history counts as current while its last point is within the shortest native window (1 day)
// of now; an older hourly series is dropped from the charts (the daily series covers that span).
// One rule with the engine (detectors' hourlyFresh): within the shortest native window of now.
const hourlyFresh = (arr, now) => H.hourlyFresh(arr, now);

// ---------- sections ----------
function sourcesOut(model, generatedAtSec) {
  return (model.sources || []).map((s) => {
    const asOf = parseTime(s.dataAsOf);
    // Age is recomputed at serve time; a source fetched after the run's reference time is 0 h old.
    const ageHours = asOf === null ? null : fix(2)(Math.max(0, (generatedAtSec - asOf) / 3600));
    return {
      id: s.id, label: s.label, host: s.host || null, kind: s.kind, status: s.status,
      requests: r0(s.requests) || 0, failed: r0(s.failed) || 0, bytes: r0(s.bytes) || 0, latencyMs: r0(s.latencyMs),
      fetchedAt: s.fetchedAt || null, dataAsOf: s.dataAsOf || null, cadenceHours: fin(s.cadenceHours) ? s.cadenceHours : null,
      // Age at which the data layer calls this source stale (null: not stated; the documented rule is two cadences).
      staleAfterHours: fin(s.staleAfterHours) ? s.staleAfterHours : null,
      // Upstream error bodies can be long (a 429 JSON per failed request); the first 300 characters say why.
      ageHours, message: s.message ? (s.message.length > 300 ? s.message.slice(0, 299) + '…' : s.message) : null,
    };
  });
}

function usdPegOf(model) {
  return (model.assets.find((a) => a.kind === 'usd-stablecoin' && a.pegType) || {}).pegType || 'peggedUSD';
}

// Live USD stablecoins on the DefiLlama list (largest first), without list-vs-chart glitches.
function usdList(model) {
  const peg = usdPegOf(model);
  const excluded = new Set(((model.listSanity && model.listSanity.excluded) || []).map((x) => String(x.id)));
  const rows = ((model.list && model.list.peggedAssets) || [])
    .filter((x) => x && x.pegType === peg && !x.deadFrom && !excluded.has(String(x.id)) && fin(x.circulating && x.circulating[peg]) && x.circulating[peg] > 0)
    .sort((x, y) => y.circulating[peg] - x.circulating[peg]);
  return { peg, rows };
}

function firstDateOf(a) {
  const cands = [a.firstPriceT, a.supply && a.supply.t[0], a.supplyUsd && a.supplyUsd.t[0], ...Object.values(a.chains || {}).map((c) => c.first)].filter(fin);
  return cands.length ? date(Math.min(...cands)) : null;
}

// Native unit: USD for USD stablecoins; troy ounces for gold tokens unless their XAU price says one
// token is not one ounce; the peg currency for other fiat pegs.
function unitOf(a) {
  if (a.kind === 'usd-stablecoin') return 'USD';
  if (a.kind === 'gold') { const x = lastPoint(a.xauDaily); return x && Math.round(x.v) !== 1 ? 'token' : 'oz'; }
  if (a.pegType && /^pegged/.test(a.pegType)) return a.pegType.slice(6);
  return 'token';
}

function colorIndexes(model) {
  const out = new Map();
  model.assets.filter((a) => a.status === 'active')
    .map((a) => ({ key: a.key, first: firstDateOf(a) }))
    .sort((x, y) => (x.first === y.first ? (x.key < y.key ? -1 : 1) : x.first === null ? 1 : y.first === null ? -1 : x.first < y.first ? -1 : 1))
    .forEach((x, i) => out.set(x.key, i));
  return out;
}

// Latest USD price: the most recent of CoinGecko markets, DefiLlama hourly and the implied daily price.
function currentPrice(a, listAsOf) {
  const c = [];
  if (a.cg && fin(a.cg.current_price)) c.push({ p: a.cg.current_price, t: parseTime(a.cg.last_updated) || 0, src: 'coingecko' });
  if (a.hourly && a.hourly.length) { const h = a.hourly[a.hourly.length - 1]; if (fin(h.p)) c.push({ p: h.p, t: h.t, src: 'defillama-coins' }); }
  if (a.list && fin(a.list.price) && listAsOf) c.push({ p: a.list.price, t: listAsOf, src: 'defillama-list' });
  const d = lastPoint(a.priceDaily) || lastPoint(a.priceLlamaDaily);
  if (d) c.push({ p: d.v, t: d.t, src: 'daily' });
  if (!c.length) return null;
  // Freshest quote, but among quotes within two hours of it prefer the most precise: CoinGecko rounds
  // stablecoin prices to ~6 decimals (1.000083 shows as 1), which would read as an exact 0.0 bp peg.
  const newest = Math.max(...c.map((x) => x.t));
  const decimals = (p) => { const s = String(p); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
  return c.filter((x) => x.t >= newest - 2 * 3600).sort((x, y) => decimals(y.p) - decimals(x.p) || y.t - x.t)[0];
}

function chainsOut(model, a, now) {
  const px = H.priceOf(a) || (a.kind === 'usd-stablecoin' ? 1 : null);
  if (!fin(px)) return [];
  const entries = Object.entries(a.chains || {});
  // Changes are measured back from the asset's latest chain day, not each chain's own last point: a
  // chain that lags carries its last value (no flow), one whose tracking ended is 0 from then on.
  const ref = Math.max(...entries.map(([, c]) => (c.t && c.t.length ? c.t[c.t.length - 1] : -Infinity)));
  const rows = entries.map(([chain, c]) => {
    const ended = (c.notes || []).find((n) => n.kind === 'tracking_ended');
    // USD at today's price, so chain flows are token flows (a price move is not a flow).
    const usd = mapSeries(c, (v) => v * px);
    const lp = lastPoint(usd);
    const level = (t) => (ended && lp && t > lp.t ? 0 : valueAt(usd, t));
    const first = fin(c.first) ? c.first : c.t && c.t.length ? c.t[0] : null;
    const notes = (c.notes || []).map((n) => (n.kind === 'tracking_ended'
      ? `DefiLlama stopped reporting this chain after ${date(n.from)}; it counts as 0 in the asset total`
      : n.kind === 'interior_gap_filled' ? `${n.gapSteps}-day gap after ${date(n.from)} filled with the last value` : String(n.kind)));
    if (!ended && lp && lp.t < ref) notes.push(`Last DefiLlama value is from ${date(lp.t)}; carried forward`);
    const ch = {};
    for (const [k, d] of WINDOWS.slice(0, 3)) ch[k] = lp && fin(ref) ? delta(level(ref - d * DAY), level(ref)) : null;
    return {
      chain,
      currentUsd: ended ? 0 : lp ? r0(lp.v) : null,
      share: null,
      first: date(first),
      status: ended ? 'tracking_ended' : fin(first) && first >= now - NATIVE.month * DAY ? 'new' : 'tracked',
      change: ch,
      series: compact(usd, s4, CHAIN_DAYS), // chart-only: 4 significant digits (currentUsd and change stay exact)
      notes,
    };
  });
  const total = rows.reduce((s, r) => s + (r.currentUsd || 0), 0);
  for (const r of rows) r.share = total > 0 && fin(r.currentUsd) ? s6(r.currentUsd / total) : null;
  return rows.sort((x, y) => (y.currentUsd || 0) - (x.currentUsd || 0) || (x.chain < y.chain ? -1 : 1));
}

function defiOut(model, a, supplyUsd) {
  const pools = (H.paxosPools(model) || {})[a.key];
  if (!pools || !pools.length) return null;
  const lb = new Map((model.lendBorrow || []).map((r) => [r.pool, r]));
  const tvl = S.sum(pools.map((p) => (fin(p.tvlUsd) ? p.tvlUsd : 0)));
  // Same definitions as the defi.footprint context item: footprint counts pair pools in full, so it
  // is an upper bound; reward share = TVL-weighted share of APY paid as incentives.
  const reward = tvl ? S.sum(pools.map((p) => (fin(p.tvlUsd) ? p.tvlUsd : 0) * (fin(p.apyReward) && p.apy ? p.apyReward / p.apy : 0))) / tvl : null;
  return {
    footprintUsd: r0(tvl),
    footprintShare: fin(supplyUsd) && supplyUsd > 0 ? s4(tvl / supplyUsd) : null,
    poolCount: pools.length,
    effectivePools: fix(2)(S.effectiveN(pools.map((p) => (fin(p.tvlUsd) ? p.tvlUsd : 0)))),
    rewardShare: s4(reward),
    pools: pools.slice().sort((x, y) => (y.tvlUsd || 0) - (x.tvlUsd || 0) || (x.pool < y.pool ? -1 : 1)).slice(0, POOLS_MAX).map((p) => {
      const l = lb.get(p.pool);
      const sup = l && fin(l.totalSupplyUsd) ? l.totalSupplyUsd : null, bor = l && fin(l.totalBorrowUsd) ? l.totalBorrowUsd : null;
      return {
        pool: String(p.pool), project: String(p.project || ''), chain: String(p.chain || ''),
        symbol: String(p.symbol || '') + (p.poolMeta ? ` (${p.poolMeta})` : ''),
        tvlUsd: r0(p.tvlUsd), apy: fix(3)(p.apy), apyBase: fix(3)(p.apyBase), apyReward: fix(3)(p.apyReward),
        utilization: sup > 0 && fin(bor) ? s4(bor / sup) : null, supplyUsd: r0(sup), borrowUsd: r0(bor),
        url: /^[A-Za-z0-9-]{1,80}$/.test(String(p.pool)) ? `https://defillama.com/yields/pool/${p.pool}` : null,
      };
    }),
  };
}

function activityOut(a) {
  if (!a.cm || !Array.isArray(a.cm.rows) || !a.cm.rows.length) return null;
  const ser = (f) => {
    const m = new Map();
    for (const r of a.cm.rows) { const t = parseTime(r.time), v = num(r[f]); if (t !== null && v !== null) m.set(dayOf(t), v); }
    const t = [...m.keys()].sort((x, y) => x - y);
    return compact({ t, v: t.map((d) => m.get(d)) }, r0, ACTIVITY_DAYS);
  };
  // chain: the one chain the Coin Metrics series covers when the model knows it (null: all or unknown).
  const chain = typeof a.cm.chain === 'string' && a.cm.chain ? a.cm.chain : null;
  return { source: 'coinmetrics', key: a.cm.key, chain, series: { activeAddresses: ser('AdrActCnt'), transfers: ser('TxTfrCnt'), holders: ser('AdrBalCnt') } };
}

// Daily volume / market cap from CoinGecko, as a trailing 7-day mean (complete weeks only).
function turnover7d(a) {
  const cg = a.cgDaily;
  if (!cg || !cg.vol || !cg.mcap) return null;
  const mc = H.grid(cg.mcap), vol = new Map((cg.vol.t || []).map((t, i) => [t, cg.vol.v[i]]));
  if (!mc) return null;
  const to = mc.t.map((t, i) => { const v = vol.get(t); return mc.v[i] > 0 && fin(v) && v >= 0 ? v / mc.v[i] : null; });
  const w = NATIVE.week, v = to.map((_, i) => { if (i < w - 1) return null; const seg = to.slice(i - w + 1, i + 1); return seg.every(fin) ? S.sum(seg) / w : null; });
  return compact({ t: mc.t, v }, s4);
}

// Daily price series shipped as series.price (the peg chart): exactly the series every peg detector
// tests (detectors.helpers.pegPrice: the model's consensus daily price when it has one, else the implied
// DefiLlama price when it covers more than a native month, else CoinGecko's, else coins.llama.fi's).
const priceSeriesOf = (a) => H.pegPrice(a);

// The model's current level when it covers more than the supply history does (the history covers one
// chain, the current level adds the other issuer chains' on-chain supply): source '<series>+onchain'.
// Such an asset's current supply, value, price and time come from it; changes, peak and drawdown stay
// on the history (its note says so). Other assets' current figures are the history's last point.
function wideCurrent(a) {
  const c = a.current;
  return c && typeof c.source === 'string' && /\+onchain$/.test(c.source) && fin(c.supply) && Array.isArray(c.parts) && c.parts.length > 1 ? c : null;
}

// `a` is the token-flow view's asset (tokenFlowView): for USD stablecoins supplyUsd is native supply at
// today's price, so change/ath/drawdown are token flows. For other assets supplyUsd is the market value.
function assetOut(model, a, ctx) {
  const usd = a.kind === 'usd-stablecoin';
  const sUsd = lastPoint(a.supplyUsd), sNat = lastPoint(a.supply);
  const wide = wideCurrent(a);
  const px = wide && fin(wide.price) ? { p: wide.price, t: timeOf(wide.priceAsOf) } : currentPrice(a, ctx.listAsOf);
  const xau = lastPoint(a.xauDaily);
  const unit = unitOf(a);
  const listIdx = a.llamaId ? ctx.usd.rows.findIndex((x) => String(x.id) === String(a.llamaId)) : -1;
  const pk = peak(a.supplyUsd), pkNat = usd ? null : peak(a.supply);
  const mkt = sUsd ? valueAt(model.marketUsd, sUsd.t) : null;
  const asOf = wide && timeOf(wide.asOf) !== null ? timeOf(wide.asOf) : sUsd ? supplyTimeOf(a, sUsd.t) : sNat ? supplyTimeOf(a, sNat.t) : null;
  const curNat = wide ? wide.supply : sNat ? sNat.v : null, curUsd = wide ? (fin(wide.supplyUsd) ? wide.supplyUsd : null) : sUsd ? sUsd.v : null;
  const pegAsOf = usd ? (px ? px.t : null) : unit === 'oz' && xau ? xau.t : null;
  const notes = [];
  if (wide && (wide.note || a.supplyNote)) notes.push(String(wide.note || a.supplyNote));
  if (a.status === 'dead') notes.push(`DefiLlama marks this asset dead${a.dead ? ' from ' + a.dead : ''}`);
  if (a.status === 'legacy') notes.push(`Legacy: found via ${(a.via || []).map(sourceWords).join(', ') || 'n/a'}, not by an active-issuance source (CoinGecko category or Paxos docs)`);
  if (a.supplySource && a.supplySource !== 'defillama:stablecoincharts' && a.supplySource !== 'none') notes.push(`Supply history from ${sourceWords(a.supplySource)}${sNat ? ` through ${date(sNat.t)}` : ''}${a.cg && fin(a.cg.circulating_supply) ? `; CoinGecko reports ${Math.round(a.cg.circulating_supply).toLocaleString('en-US')} ${unit === 'USD' ? 'tokens' : unit} in circulation` : ''}`);
  if (!a.supply) notes.push('No supply history from any source in this snapshot');
  if (usd && !Object.keys(a.chains || {}).length) notes.push(a.status === 'active' ? 'No per-chain balances from DefiLlama in this snapshot' : 'Per-chain history is fetched for active assets only');
  if (a.hourly && a.hourly.length && !hourlyFresh(a.hourly, ctx.now)) notes.push(`Hourly prices (DefiLlama coins) end ${isoTime(a.hourly[a.hourly.length - 1].t).slice(0, 16)}Z; price charts use daily data`);
  if (px && ctx.now - px.t > NATIVE.day * DAY) notes.push(`Latest price is from ${date(px.t)}`);
  return {
    key: a.key, symbol: a.symbol, name: a.name, kind: a.kind, status: a.status, unit, colorIndex: ctx.colors.has(a.key) ? ctx.colors.get(a.key) : null,
    current: {
      supply: s8(curNat),
      supplyUsd: r0(curUsd),
      supplyAsOf: isoTime(asOf),
      // Where the current level comes from: the supply history's source, or '<history>+onchain' when
      // other issuer chains are added from on-chain reads (see notes).
      supplySource: wide ? String(wide.source) : a.supplySource || null,
      price: px ? s7(px.p) : null,
      priceAsOf: px ? isoTime(px.t) : null,
      // USD stablecoins: deviation from $1 of that price; gold: premium of the daily price in XAU over
      // one ounce (pegAsOf = the daily point's time).
      pegDevBp: usd && px ? fix(2)((px.p - 1) * 1e4) : unit === 'oz' && xau ? fix(2)((xau.v - 1) * 1e4) : null,
      pegAsOf: isoTime(pegAsOf),
      // USD stablecoins: token flows at today's price; other assets: change of the USD market value.
      changeBasis: usd ? 'token-flow' : 'market-value',
      change: changes(a.supplyUsd),
      ath: pk ? { value: r0(pk.value), date: pk.date } : null,
      drawdownPct: pk && sUsd && pk.value > 0 ? fix(3)(100 * (sUsd.v / pk.value - 1)) : null,
      // Non-USD assets: the same supply figures in the asset's own unit (gold: ounces), price excluded.
      changeNative: usd ? null : changes(a.supply, nat),
      athNative: pkNat ? { value: nat(pkNat.value), date: pkNat.date } : null,
      drawdownNativePct: pkNat && sNat && pkNat.value > 0 ? fix(3)(100 * (sNat.v / pkNat.value - 1)) : null,
      rank: usd && listIdx >= 0 ? listIdx + 1 : null,
      rankOf: usd && listIdx >= 0 ? ctx.usd.rows.length : null,
      marketShare: usd && sUsd && mkt > 0 ? s6(sUsd.v / mkt) : null,
      volume24hUsd: a.cg ? r0(a.cg.total_volume) : null,
      turnover24h: a.cg && a.cg.market_cap > 0 && fin(a.cg.total_volume) ? s4(a.cg.total_volume / a.cg.market_cap) : null,
    },
    series: {
      supplyUsd: compact(a.supplyUsd, r0),
      supply: usd ? null : compact(a.supply, nat), // USD stablecoins: supplyUsd is the native-unit history at today's price
      price: compact(priceSeriesOf(a), s6, PRICE_DAYS),
      priceHourly: hourlyFresh(a.hourly, ctx.now) ? hourly(a.hourly) : null,
      xau: compact(a.xauDaily, s7),
      turnover7d: turnover7d(a),
    },
    chains: chainsOut(model, a, ctx.now),
    defi: defiOut(model, a, curUsd),
    onchain: (a.onchain || []).map((o) => ({ chain: o.chain, address: o.address ? String(o.address) : null, holders: r0(o.holders), totalSupply: s8(o.totalSupply), source: o.source || null, asOf: o.asOf || null })),
    activity: activityOut(a),
    notes,
  };
}

const USD_LABEL = 'Active Paxos USD stablecoins';
const ALL_LABEL = 'All Paxos-issued assets not marked dead, incl. legacy and gold (USD)';

// All Paxos-issued value: never counts an asset without a USD value as $0. current is null when any
// asset not marked dead lacks one (missing lists them; coveredUsd sums the others).
function allUsdOut(model, assetsOut) {
  // An asset whose section failed to build counts as missing too, never as $0.
  const live = model.assets.filter((a) => a.status !== 'dead');
  const has = (a) => Boolean(assetsOut[a.key]) && fin(assetsOut[a.key].current.supplyUsd);
  const covered = live.filter(has), missing = live.filter((a) => !has(a)).map((a) => a.key);
  const sum = S.sum(covered.map((a) => assetsOut[a.key].current.supplyUsd));
  const asOfs = covered.map((a) => parseTime(assetsOut[a.key].current.supplyAsOf)).filter(fin);
  return { label: ALL_LABEL, current: missing.length || !covered.length ? null : r0(sum), coveredUsd: covered.length ? r0(sum) : null, missing, supplyAsOf: asOfs.length ? isoTime(Math.min(...asOfs)) : null };
}

// `view` = tokenFlowView(model): the level, changes, peak and drawdown are token flows at today's price.
// The market share is the engine's aggregate over DefiLlama's USD market total (the series the
// market.share detector tests), from the day that total became comparable with today's
// (market.coverageFrom): before it the total lacked large coins and the share is an artefact.
function totalsOut(model, view, assetsOut, usd, coverageFrom) {
  const agg = H.aggregate(view), aggValue = H.aggregate(model);
  const allUsd = allUsdOut(model, assetsOut);
  if (!agg) return { usd: { key: D.AGG, label: USD_LABEL, assets: [], current: null, supplyAsOf: null, supplyUsd: null, change: changes(null), ath: null, drawdownPct: null, marketShare: null, shareCurrent: null, rankEquivalent: null }, allUsd };
  const s = { t: agg.t, v: agg.v };
  const lp = lastPoint(s), pk = peak(s);
  const shareOf = aggValue || agg;
  const share = mapSeries({ t: shareOf.t, v: shareOf.v }, (v, t) => { const m = valueAt(model.marketUsd, t); return m > 0 && !(fin(coverageFrom) && t < coverageFrom) ? v / m : null; });
  const shareNow = lastPoint(share);
  const members = new Set(model.assets.filter((a) => agg.members.includes(a.key) && a.llamaId).map((a) => String(a.llamaId)));
  // The total is as old as its oldest member's observation on the aggregate's last day.
  const memberAsOf = lp ? view.assets.filter((a) => agg.members.includes(a.key)).map((a) => supplyTimeOf(a, obsTimeAt(a.supplyUsd, lp.t))).filter(fin) : [];
  return {
    usd: {
      key: D.AGG, // the pseudo-asset key the insights and the health grid use for this aggregate
      label: USD_LABEL,
      assets: agg.members.slice(),
      current: lp ? r0(lp.v) : null,
      supplyAsOf: memberAsOf.length ? isoTime(Math.min(...memberAsOf)) : lp ? isoTime(lp.t) : null,
      supplyUsd: compact(s, r0),
      change: changes(s),
      ath: pk ? { value: r0(pk.value), date: pk.date } : null,
      drawdownPct: pk && lp && pk.value > 0 ? fix(3)(100 * (lp.v / pk.value - 1)) : null,
      marketShare: compact(share, s4),
      shareCurrent: shareNow ? s6(shareNow.v) : null,
      // Rank the combined Paxos USD supply would have among live USD stablecoins (other issuers' coins).
      rankEquivalent: lp ? usd.rows.filter((x) => !members.has(String(x.id)) && x.circulating[usd.peg] > lp.v).length + 1 : null,
    },
    allUsd,
  };
}

// Peers come from DefiLlama's hourly list (current vs its prevDay/prevWeek/prevMonth values), a fresher
// snapshot than the daily series behind the hero and asset table; asOf says which.
function peersOut(model, usd, listAsOf) {
  const byLlama = new Map(model.assets.filter((a) => a.llamaId).map((a) => [String(a.llamaId), a.key]));
  const v = (x, k) => (x[k] && fin(x[k][usd.peg]) ? x[k][usd.peg] : null);
  const rows = usd.rows.filter((x, i) => i < PEERS_TOP || byLlama.has(String(x.id))).map((x) => {
    const cur = x.circulating[usd.peg];
    return {
      id: String(x.id), symbol: String(x.symbol || ''), name: String(x.name || ''), supplyUsd: r0(cur),
      change: { d1: delta(v(x, 'circulatingPrevDay'), cur), d7: delta(v(x, 'circulatingPrevWeek'), cur), d30: delta(v(x, 'circulatingPrevMonth'), cur) },
      isPaxos: byLlama.has(String(x.id)), assetKey: byLlama.get(String(x.id)) || null,
    };
  });
  const excluded = ((model.listSanity && model.listSanity.excluded) || []).map((e) => ({ id: String(e.id), symbol: String(e.symbol || ''), pegType: e.pegType || null, jumpUsd: r0(e.jumpUsd), prevDay: r0(e.prevDay), current: r0(e.current), listSum: r0(e.listSum), chartSum: r0(e.chartSum), tolerance: s4(e.tolerance) }));
  return { pegType: usd.peg, asOf: rows.length ? isoTime(listAsOf) : null, count: usd.rows.length, rows, excluded };
}

function economicsOut(model) {
  if (!model.fees) return null;
  const fm = H.feeModel(model);
  const rate = fm ? { t: fm.f.t, v: fm.rate } : null;
  const lr = lastPoint(rate);
  const base = fm ? [...fm.base].reverse().find(fin) : null;
  const labels = model.fees.labels || [];
  return {
    label: 'DefiLlama model estimate',
    // Asset keys the fee model covers: the ones the adapter's fee labels name (discovery tier
    // defillama:fees-label), so the page can say which coins the estimate is for.
    assets: model.assets.filter((a) => a.feeModelled).map((a) => a.key),
    note: `Modelled by DefiLlama's "${R.ISSUER.feesSlug}" fee adapter as yield on the reserves backing the modelled assets${labels.length ? ` (${labels.join('; ')})` : ''}${fm && fm.members.length ? `; implied yield = daily fees x 365 / supply of ${fm.members.join(', ')}` : ''}. Not reported by Paxos. Daily series cover the last ${PRICE_DAYS} days.`,
    // Same ~3-year window as daily prices; the 1y totals in `current` come from DefiLlama directly.
    fees: compact(model.fees.series, r0, PRICE_DAYS),
    revenue: model.revenue ? compact(model.revenue.series, r0, PRICE_DAYS) : null,
    impliedYield: compact(rate, fix(5), PRICE_DAYS), // fraction; 1e-5 = 0.1 bp of yield
    current: { fees24h: r0(model.fees.total24h), revenue24h: model.revenue ? r0(model.revenue.total24h) : null, fees1y: r0(model.fees.total1y), impliedYield: lr ? s4(lr.v) : null, baseUsd: r0(base) },
  };
}

function healthOut(h) {
  if (!h) return null;
  const cells = {};
  for (const [a, row] of Object.entries(h.cells || {})) {
    cells[a] = {};
    for (const [d, c] of Object.entries(row)) cells[a][d] = { ...c, evidence: c.evidence ? { ...c.evidence, p: s4(c.evidence.p), E: s4(c.evidence.E) } : null };
  }
  return { dimensions: h.dimensions.slice(), assets: h.assets.slice(), cells, summary: h.summary || {} };
}

// Watchlist diet: every data-dimension item (the page's data notes) plus the WATCH_OTHERS most unusual
// others, keeping engine order (most unusual first). Watch and context items ship without facts: the
// page shows them collapsed, and their title and why are already rendered from those facts.
function capWatch(list) {
  let others = 0;
  return list.filter((t) => t.dimension === 'data' || others++ < WATCH_OTHERS);
}
function lean(ins) {
  delete ins.facts;
  return ins;
}

function shortSpark(ins) {
  const sp = ins.evidence && ins.evidence.series;
  if (sp && sp.values.length > WATCH_SPARK) {
    const cut = sp.values.length - WATCH_SPARK;
    ins.evidence.series = { start: date(Date.parse(sp.start) / 1000 + cut * DAY), values: sp.values.slice(cut) };
  }
  return ins;
}

const RULE = 'A finding is notable when E = m x p < 1. p is the probability of a result at least this extreme under the asset\'s own history (or its peer set), computed from non-overlapping windows with an effective-sample floor. m is the size of the finding\'s family, its health dimension (supply, market, chains, peg, ...) pooled across assets: the number of checks run in that dimension, but never fewer than the load\'s average per dimension (all checks divided by the number of dimensions that ran one), so no dimension is judged more leniently than an average-sized one. A check that could not reach significance even with its smallest possible p is reported as underpowered and not counted in m. E is the number of equally extreme results expected by chance, so fewer than one chance finding per dimension is expected per load (not zero). A notable finding is shown only if it is material: it moves at least the asset\'s floor, the median non-flat daily net flow of the past year at today\'s price. Data-quality findings (the data dimension) describe the sources, not the assets, and are neutral. Each finding is dated by re-running its own detector as of earlier days: it is in the feed while its episode is younger than 30 days (a 7-day gap ends an episode) and a standing condition after that. The watchlist holds material checks that are surprising (at least 1 bit) but not notable.';

function insightsOut(res, extraErrors) {
  const errors = [];
  const seen = new Set();
  for (const e of [...((res && res.errors) || []), ...extraErrors]) {
    const k = `${e.detector}|${e.error}`;
    if (!seen.has(k)) { seen.add(k); errors.push({ detector: String(e.detector), error: String(e.error).slice(0, 300) }); }
  }
  if (!res) return { rule: { text: RULE }, testsRun: 0, groups: 0, families: {}, family: null, floorsUsd: {}, feed: [], standing: [], watch: [], watchTotal: 0, context: [], health: null, errors };
  return {
    rule: { text: RULE },
    testsRun: res.testsRun,
    groups: res.groups,
    families: res.m,
    // How many chance findings to expect: counted = checks in the family sizes (underpowered ones left
    // out), dimensions = health dimensions that ran a counted check (fewer than one chance finding per
    // dimension is expected per load, so up to about this many in all).
    family: res.family ? { counted: res.family.M, dimensions: res.family.D, floor: res.family.floor, underpowered: Object.values(res.family.underpowered || {}).reduce((s, x) => s + x, 0) } : null,
    floorsUsd: Object.fromEntries(Object.entries(res.floors || {}).map(([k, v]) => [k, r0(v)])),
    feed: res.clusters.map((c) => ({ rootKey: c.rootKey, lead: toInsight(c.lead), related: c.related.map(toInsight) })),
    standing: res.standing.map(toInsight),
    watch: capWatch(res.watch).map((t) => lean(shortSpark(toInsight(t)))),
    // How many watch items the engine found before any cap (data notes included); watch.length are held.
    watchTotal: Number.isInteger(res.watchTotal) ? Math.max(res.watchTotal, res.watch.length) : res.watch.length,
    context: res.context.map((t) => lean(shortSpark(toInsight(t)))),
    health: healthOut(res.health),
    errors,
  };
}

// Defensive pass: no NaN/Infinity can reach JSON (counted so checks can assert there were none).
function sanitize(x, stats = { replaced: 0 }) {
  if (typeof x === 'number') { if (Number.isFinite(x)) return x; stats.replaced++; return null; }
  if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) x[i] = sanitize(x[i], stats); return x; }
  if (x && typeof x === 'object') { for (const k of Object.keys(x)) x[k] = sanitize(x[k], stats); return x; }
  return x;
}

function buildPayload(model0, res, att, { generatedAt, timingsMs = {}, errors = [] } = {}) {
  const genSec = Date.parse(generatedAt) / 1000;
  const now = fin(model0.now) ? model0.now : genSec;
  // The same bounded model the engine and attribution see: points dated after now + 1 day dropped (none
  // in the normal case; the data layer bounds ingestion too). Keeps every Compact series finite.
  const model = H.bounded(model0, now);
  // Records or sections the model had to drop (one malformed upstream record degrades only itself).
  const errs = [...errors, ...(Array.isArray(model.errors) ? model.errors : []).map((e) => ({ detector: 'model', error: String(e) }))];
  const guard = (name, fn, fallback = null) => {
    try {
      return fn();
    } catch (e) {
      errs.push({ detector: 'payload.' + name, error: (e && e.message) || String(e) });
      return fallback;
    }
  };
  const sources = guard('sources', () => sourcesOut(model, genSec), []);
  const listSrc = sources.find((s) => s.id === 'llama-stablecoins');
  // Time of DefiLlama's hourly list: the model's own (the list response's Last-Modified) when it has one,
  // else the stablecoin source's freshest as-of.
  const listAsOf = timeOf(model.listAsOf) !== null ? timeOf(model.listAsOf) : listSrc ? parseTime(listSrc.dataAsOf) : null;
  const usd = guard('peers', () => usdList(model), { peg: 'peggedUSD', rows: [] });
  const ctx = { now, usd, colors: guard('discovery', () => colorIndexes(model), new Map()), listAsOf };
  const view = guard('assets', () => tokenFlowView(model), model);
  const assets = {};
  for (const a of view.assets) { const o = guard('asset ' + a.key, () => assetOut(model, a, ctx)); if (o) assets[a.key] = o; }
  const coverageFrom = guard('market', () => H.coverageStart(model.marketUsd), null);
  const totals = guard('totals', () => totalsOut(model, view, assets, usd, coverageFrom), null);
  // dataAsOf = the time of the supply snapshot the page leads with (the hero total), else the newest
  // asset supply snapshot; never a fetch time.
  const assetAsOfs = Object.values(assets).map((a) => parseTime(a.current.supplyAsOf)).filter(fin);
  const dataAsOf = (totals && totals.usd && totals.usd.supplyAsOf) || (assetAsOfs.length ? isoTime(Math.max(...assetAsOfs)) : null);
  // An active asset without a USD value leaves the all-assets total incomplete: re-checked after 5 min.
  const missingActive = model.assets.some((a) => a.status === 'active' && !(assets[a.key] && fin(assets[a.key].current.supplyUsd)));
  const payload = {
    schemaVersion: 1,
    generatedAt,
    dataAsOf,
    status: null, // statusOf(payload), once every section is in
    cache: cachePolicy(sources, missingActive),
    timingsMs: { fetch: r0(timingsMs.fetch), model: r0(timingsMs.model), engine: r0(timingsMs.engine), total: r0(timingsMs.total) },
    sources,
    discovery: guard('discovery', () => ({
      tiers: ((model.discovery && model.discovery.tiers) || []).map((t) => ({ id: t.id, label: t.label, ok: Boolean(t.ok), found: (t.found || []).slice() })),
      assets: model.assets.map((a) => ({ key: a.key, symbol: a.symbol, name: a.name, kind: a.kind, status: a.status, unit: unitOf(a), geckoId: a.geckoId || null, llamaId: a.llamaId ? String(a.llamaId) : null, via: (a.via || []).slice(), firstDate: firstDateOf(a), colorIndex: ctx.colors.has(a.key) ? ctx.colors.get(a.key) : null })),
      // role: 'issuer' | 'unverified' (issuer contracts) or 'bridged' | 'unlisted' (third-party contracts
      // that carry the asset's name; listed so the page can label them, never counted as issuance).
      addresses: model.assets.flatMap((a) => [...(a.addresses || []).map((x) => [x, 'issuer']), ...(a.thirdPartyAddresses || []).map((x) => [x, 'bridged'])]
        .map(([x, role]) => ({ asset: a.key, chain: x.chain, address: x.address, decimals: fin(x.decimals) ? x.decimals : null, role: String(x.role || role), via: (x.via || []).slice() }))),
    }), { tiers: [], assets: [], addresses: [] }),
    totals,
    market: guard('market', () => {
      // From the first day any Paxos asset has supply data: the market before that is never a denominator.
      const t0 = Math.min(...model.assets.map((a) => (a.supplyUsd && a.supplyUsd.t.length ? a.supplyUsd.t[0] : Infinity)));
      const from = (s) => (s && fin(t0) ? { t: s.t.filter((t) => t >= t0), v: s.v.filter((_, i) => s.t[i] >= t0) } : s);
      return {
        definition: `DefiLlama circulating supply of stablecoins in USD. usdTotal counts the ${usd.peg} peg type only (the denominator of every USD market share) from the first day a Paxos asset has supply data; allTotal sums every peg type over the last ${CHAIN_DAYS} days. coverageFrom is the first day the USD total is comparable with today's (the last one-day rise larger than every later weekly move, judged with a year of later history: coins added to DefiLlama's total, not growth); market shares start there.`,
        coverageFrom: date(coverageFrom),
        // usdTotal: 6 significant digits, so the market's move over a period (a ratio of two days) is exact
        // at the printed precision (0.01%); allTotal is chart-only: 4 significant digits.
        usdTotal: compact(from(model.marketUsd), s6),
        allTotal: compact(model.market, s4, CHAIN_DAYS),
      };
    }, null),
    assets,
    peers: guard('peers', () => peersOut(model, usd, listAsOf), null),
    pegPeers: guard('pegPeers', () => (model.pegPeers || []).map((p) => ({ symbol: p.symbol, geckoId: p.geckoId || null, priceHourly: hourlyFresh(p.hourly, now) ? hourly(p.hourly) : null, price: compact(p.daily, s6, PRICE_DAYS) })), []),
    goldRefs: guard('goldRefs', () => (model.goldRefs || []).map((g) => ({ symbol: g.symbol, geckoId: g.geckoId || null, name: g.name || null, priceHourly: hourlyFresh(g.hourly, now) ? hourly(g.hourly) : null })), []),
    economics: guard('economics', () => economicsOut(model), null),
    attribution: att && att.windows ? att : null,
    insights: null,
  };
  payload.insights = guard('insights', () => insightsOut(res, errs), null) || insightsOut(null, errs);
  attachBriefing(payload);
  payload.status = statusOf(payload);
  const stats = { replaced: 0 };
  sanitize(payload, stats);
  return { payload, nonFinite: stats.replaced };
}

// CDN freshness budget: 5 min when a core (supply/market) source is down or an active asset has no USD
// value, 10 min when any other source is down, else 30 min. Only a source in error shortens it: partial
// (some requests failed over, or a series lags; onchain is partial by design) and stale do not.
function cachePolicy(sources, missingActive) {
  const down = (sources || []).filter((s) => s.status === 'error');
  return { ...(missingActive || down.some((s) => s.kind === 'supply' || s.kind === 'market') ? CACHE_DEGRADED : down.length ? CACHE_SOURCE_ERROR : CACHE) };
}

// The briefing (lib/paxos/briefing.js): verdict and per-period bullets, a pure function of the payload
// (so a memo hit's restamped payload keeps a correct one); applyBriefing also sets insight.tier in place.
// Built after insights, before sanitize. Without the module the payload has no briefing key, which the
// page reads as an older payload; any failure nulls the section and is listed in insights.errors.
function attachBriefing(payload) {
  try {
    let lib;
    try {
      lib = require('./briefing');
    } catch (e) {
      if (e && e.code === 'MODULE_NOT_FOUND' && /Cannot find module '\.\/briefing'/.test(String(e.message))) return;
      throw e;
    }
    const b = lib.applyBriefing(payload);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('applyBriefing returned no briefing');
    payload.briefing = b;
  } catch (e) {
    payload.briefing = null;
    payload.insights.errors.push({ detector: 'payload.briefing', error: String((e && e.message) || e).slice(0, 300) });
  }
}

// One status rule, shared by the response header (X-Paxos-Status), the page and the monitor: degraded
// when a source is stale or down, a section is missing, an asset not marked dead has no USD value, or
// the build reported errors (one reason each: a source's id and status, a section's name, an error's
// detector). Pure on the payload, so a memo hit (re-aged sources) is re-judged with it.
const SECTIONS = ['discovery', 'totals', 'market', 'peers', 'economics', 'attribution', 'insights', 'briefing'];
function statusOf(p) {
  const reasons = [];
  for (const s of p.sources || []) if (s.status === 'stale' || s.status === 'error') reasons.push({ kind: 'source', id: s.id, status: s.status, message: s.message || null });
  for (const k of SECTIONS) if (p[k] === null) reasons.push({ kind: 'section', id: k, status: null, message: `${k} is not in this snapshot` });
  const missing = (p.totals && p.totals.allUsd && p.totals.allUsd.missing) || [];
  if (missing.length) reasons.push({ kind: 'section', id: 'totals.allUsd', status: null, message: `no USD value for ${missing.join(', ')}` });
  for (const e of (p.insights && p.insights.errors) || []) reasons.push({ kind: 'engine', id: String(e.detector), status: 'error', message: String(e.error) });
  return { level: reasons.length ? 'degraded' : 'ok', reasons };
}

module.exports = { buildPayload, sourcesOut, tokenFlowView, compact, changes, valueAt, lastPoint, sanitize, statusOf, cachePolicy, CACHE, CACHE_SOURCE_ERROR, CACHE_DEGRADED, CHAIN_DAYS, PEERS_TOP, WATCH_OTHERS, RULE };
