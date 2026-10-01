'use strict';

// Builds the normalised model the insight engine consumes from the raw bundle
// of sources.collectRaw(). Pure: no I/O, no clock (now is passed in). Nothing
// about specific assets is hard-coded: assets come from discovery, chains from
// the data, peers and references from the market.
//
// Time semantics: every daily Series point t (00:00 UTC) is the value AT that
// instant. DefiLlama labels its ~00:00 snapshot with the day; CoinGecko's daily
// points sit exactly on 00:00 (its intraday "now" point is dropped, so a live
// price is never paired with a stale reference rate); coins.llama.fi daily
// points sit a few minutes either side of midnight and are rounded to the
// nearest one; a Coin Metrics daily row covers its whole day, so its level
// (SplyCur) is the value at the next 00:00. Points outside the plausible time
// range (timeOk) are dropped before anything is built on them.
//
// Each asset section is built inside its own guard: an unexpected upstream
// value drops that section (listed in model.errors), never the asset or the
// model.

const S = require('./stats');
const R = require('./registry');

const DAY = 86400;
const YEAR = 365; // DefiLlama's 1y window: "the past year"
const MONTH = 30; // DefiLlama circulatingPrevMonth window
const dayOf = (t) => Math.floor(Number(t) / DAY) * DAY;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const sumVals = (o) => Object.values(isObj(o) ? o : {}).reduce((s, v) => s + (num(v) || 0), 0);
const lastOf = (xs) => xs[xs.length - 1];

// Plausible time range of an upstream observation: not before the Bitcoin
// genesis block (no on-chain asset or crypto price predates it) and not later
// than one day after now (clock skew). A unit slip (milliseconds for seconds or
// the reverse) or a corrupt row falls outside and is dropped, so one bad date
// can never stretch a daily grid across centuries.
const GENESIS = Date.UTC(2009, 0, 3) / 1000;
const timeOk = (t, now) => Number.isFinite(t) && t >= GENESIS && (!Number.isFinite(now) || t <= now + DAY);

// A daily series: parallel arrays, ascending, one point per UTC day (last value wins).
// opts.now bounds the time range (timeOk); opts.nearest rounds to the nearest midnight instead of
// the day's start and drops labels that have not started yet (a near-midnight daily print).
function daily(points, opts = {}) {
  const { now, nearest = false } = opts;
  const m = new Map();
  for (const p of points || []) {
    if (!p) continue;
    const t = Number(p.t), v = p.v;
    if (!Number.isFinite(v) || !timeOk(t, now)) continue;
    const d = nearest ? Math.round(t / DAY) * DAY : dayOf(t);
    if (nearest && Number.isFinite(now) && d > now) continue;
    m.set(d, v);
  }
  const t = [...m.keys()].sort((a, b) => a - b);
  return { t, v: t.map((k) => m.get(k)) };
}

const nonEmpty = (s) => (s && s.t.length ? s : null);
const lastPoint = (s) => {
  if (!s || !s.t) return null;
  for (let i = s.t.length - 1; i >= 0; i--) if (num(s.v[i]) !== null) return { t: s.t[i], v: s.v[i] };
  return null;
};

// ---------- materiality (shared with the engine's rule) ----------
// Floor = median |daily net flow| of the native supply over the past year (flat days skipped, a day
// counts only when it and the previous day are observed), valued at today's price. A chain is
// material when its largest native balance over the past month, at today's price, reaches the floor.
// sources.js uses this to choose which chain totals to fetch; the engine applies the same rule.
function gridOf(s) {
  if (!s || !s.t || !s.t.length) return null;
  let a = 0, b = s.t.length - 1;
  while (a <= b && num(s.v[a]) === null) a++;
  while (b >= a && num(s.v[b]) === null) b--;
  if (a > b) return null;
  const t0 = dayOf(s.t[a]), n = Math.round((dayOf(s.t[b]) - t0) / DAY) + 1;
  const v = new Array(n).fill(null);
  for (let i = a; i <= b; i++) if (num(s.v[i]) !== null) v[Math.round((dayOf(s.t[i]) - t0) / DAY)] = s.v[i];
  return { t: Array.from({ length: n }, (_, i) => t0 + i * DAY), v };
}
function medianFlow(vals) {
  const d = [];
  for (let i = Math.max(1, vals.length - YEAR); i < vals.length; i++) if (num(vals[i]) !== null && num(vals[i - 1]) !== null && vals[i] !== vals[i - 1]) d.push(Math.abs(vals[i] - vals[i - 1]));
  return d.length ? S.median(d) : null;
}
// Native supply Series + USD supply Series -> { floorUsd, px } (px = latest implied price within a month).
function materialityFloor(supply, supplyUsd, fallbackPx = null) {
  const s = gridOf(supply), u = gridOf(supplyUsd);
  let px = null;
  if (s && u) {
    const at = new Map(u.t.map((t, i) => [t, u.v[i]]));
    for (let i = s.t.length - 1; i >= Math.max(0, s.t.length - MONTH); i--) { const x = at.get(s.t[i]); if (num(x) !== null && s.v[i] > 0) { px = x / s.v[i]; break; } }
  }
  if (px === null) px = num(fallbackPx);
  const f = s ? medianFlow(s.v) : null;
  return { floorUsd: f !== null && px !== null ? f * px : null, px };
}
const recentMax = (s) => { const g = gridOf(s); return g ? Math.max(0, ...g.v.slice(-MONTH).filter((x) => num(x) !== null)) : 0; };
const materialChain = (chainSeries, px, floorUsd) => num(px) !== null && num(floorUsd) !== null && recentMax(chainSeries) * px >= floorUsd;

// List vs chart reconciliation per peg type. The list's per-asset values must
// add up to the chart total for the same peg; the peg type with the largest
// chart total sets the tolerance. Where a peg type is far outside it (and the
// gap exceeds a typical day's change of the whole market), the asset with the
// largest 1-day jump is the likely culprit and is excluded from peer sets.
function listSanity(list, chartsAll) {
  const rows = (chartsAll || []).filter(isObj);
  const lastChart = (rows.length && isObj(rows[rows.length - 1].totalCirculatingUSD) && rows[rows.length - 1].totalCirculatingUSD) || {};
  const live = ((list && Array.isArray(list.peggedAssets) && list.peggedAssets) || []).filter((x) => isObj(x) && !x.deadFrom);
  const sums = {};
  for (const x of live) for (const [k, v] of Object.entries(isObj(x.circulating) ? x.circulating : {})) if (num(v) !== null) sums[k] = (sums[k] || 0) + v;
  const rel = Object.fromEntries(Object.keys(sums).filter((k) => lastChart[k] > 0 && sums[k] > 0).map((k) => [k, Math.abs(Math.log(sums[k] / lastChart[k]))]));
  const top = Math.max(...Object.values(lastChart).filter((v) => num(v) !== null));
  const tol = Math.min(...Object.entries(rel).filter(([k]) => lastChart[k] === top).map(([, v]) => v));
  const tolerance = Number.isFinite(tol) ? tol : null;
  const excluded = [];
  if (tolerance === null) return { tolerance, excluded };
  const mk = daily(rows.map((r) => ({ t: r.date, v: sumVals(r.totalCirculatingUSD) }))).v.slice(-YEAR);
  const marketDailyFlow = S.median(mk.slice(1).map((v, i) => Math.abs(v - mk[i])));
  for (const [peg, r] of Object.entries(rel)) {
    if (r <= tolerance || Math.abs(sums[peg] - lastChart[peg]) <= marketDailyFlow) continue;
    const first = (o) => num(Object.values(isObj(o) ? o : {})[0]) || 0;
    const cands = live
      .filter((x) => x.pegType === peg)
      .map((x) => ({ x, jump: first(x.circulating) - first(x.circulatingPrevDay) }))
      .sort((a, b) => Math.abs(b.jump) - Math.abs(a.jump));
    const c = cands[0];
    if (c && Math.abs(sums[peg] - c.jump - lastChart[peg]) < Math.abs(sums[peg] - lastChart[peg]) / 2) {
      excluded.push({ id: c.x.id, symbol: c.x.symbol, pegType: peg, jumpUsd: c.jump, prevDay: first(c.x.circulatingPrevDay), current: first(c.x.circulating), listSum: sums[peg], chartSum: lastChart[peg], tolerance });
    }
  }
  return { tolerance, excluded };
}

// coins.llama.fi daily prices ([{t, p}], near-midnight timestamps) -> daily Series.
const pricesSeries = (arr, now) => (Array.isArray(arr) && arr.length ? nonEmpty(daily(arr.filter(isObj).map((p) => ({ t: p.t, v: p.p })), { now, nearest: true })) : null);
// CoinGecko market_chart [[ms, v]] -> daily Series of the exact 00:00 UTC points only. The last
// point of a daily chart is an intraday "now" value; for the XAU chart it is a live USD price
// converted at the start-of-day gold rate, so it must not stand in for the day.
const msSeries = (arr, now) => daily((Array.isArray(arr) ? arr : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && p[0] % (DAY * 1000) === 0).map(([t, v]) => ({ t: t / 1000, v })), { now });

// Consensus daily price (one series for the page's peg chart and the peg detectors): per day the
// median of the available daily sources. Where exactly two sources report and they disagree by
// more than the asset's own robust daily price scale (robust sigma of its day-to-day log changes
// over the past year), the one closer to the neighbouring days wins, so one bad print cannot move
// the consensus. priceSources = number of sources behind each day.
function priceConsensus(sources) {
  const by = new Map();
  for (const s of sources) {
    if (!s || !s.t) continue;
    for (let i = 0; i < s.t.length; i++) { const v = s.v[i]; if (num(v) !== null && v > 0) (by.get(s.t[i]) || by.set(s.t[i], []).get(s.t[i])).push(v); }
  }
  const t = [...by.keys()].sort((a, b) => a - b);
  if (!t.length) return { consensus: null, count: null };
  const med = t.map((d) => S.median(by.get(d)));
  const end = lastOf(t), steps = [];
  for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] === DAY && t[i] > end - YEAR * DAY) steps.push(Math.log(med[i] / med[i - 1]));
  const scale = steps.length >= 2 ? S.robustScale(steps) || 0 : 0;
  const v = t.map((d, i) => {
    const xs = by.get(d);
    if (xs.length !== 2 || Math.abs(Math.log(xs[0] / xs[1])) <= scale) return med[i];
    const nb = [];
    for (let k = 1; k <= 7 && nb.length < 2; k++) nb.push(...(by.get(d - k * DAY) || []), ...(by.get(d + k * DAY) || []));
    if (!nb.length) return med[i];
    const ref = S.median(nb);
    return Math.abs(Math.log(xs[0] / ref)) <= Math.abs(Math.log(xs[1] / ref)) ? xs[0] : xs[1];
  });
  return { consensus: { t, v }, count: { t: t.slice(), v: t.map((d) => by.get(d).length) } };
}

// Per-chain history of a DefiLlama detail chainBalances entry (native units), repaired: untracked
// chains jump straight to a fake 0 dated today, interior gaps are forward-filled (see
// stats.repairChainSeries). Shared with sources.js, which picks material chains on the same series.
function chainSeries(cb, pegType, now) {
  const val = (o) => (isObj(o) ? num(pegType && o[pegType] !== undefined ? o[pegType] : Object.values(o)[0]) : null);
  const pts = (cb && Array.isArray(cb.tokens) ? cb.tokens : [])
    .filter(isObj)
    .map((x) => ({ t: Number(x.date), v: val(x.circulating), minted: val(x.minted) }))
    .filter((x) => timeOk(x.t, now))
    .sort((x, y) => x.t - y.t);
  const rep = S.repairChainSeries(pts.filter((x) => Number.isFinite(x.v)).map((x) => ({ t: x.t, v: x.v })), DAY);
  return { ...daily(rep.points, { now }), notes: rep.notes, first: pts.length ? pts[0].t : null, minted: daily(pts.map((x) => ({ t: x.t, v: x.minted })), { now }) };
}

// Freshest USD quote of an asset: CoinGecko markets (last_updated), coins.llama.fi hourly, consensus daily.
function quoteOf(a) {
  const q = [];
  if (a.cg && num(a.cg.current_price) > 0) { const t = Date.parse(a.cg.last_updated) / 1000; if (Number.isFinite(t)) q.push({ p: a.cg.current_price, t, source: 'coingecko:markets' }); }
  if (a.hourly && a.hourly.length) { const h = lastOf(a.hourly); if (num(h.p) > 0) q.push({ p: h.p, t: h.t, source: 'defillama:coins-hourly' }); }
  const d = lastPoint(a.priceConsensus);
  if (d && d.v > 0) q.push({ p: d.v, t: d.t, source: 'consensus-daily' });
  return q.sort((x, y) => y.t - x.t)[0] || null;
}

function buildAsset(ra, raw, namer, ctx) {
  const now = ctx.now;
  const id = ra.id || R.assetId(ra);
  const coinKey = (raw.coinKeys && raw.coinKeys[id]) || R.coinKeyOf(ra);
  const a = {
    key: ra.key,
    name: ra.name,
    symbol: ra.symbol,
    geckoId: ra.geckoId || null,
    llamaId: ra.llamaId || null,
    via: ra.via,
    kind: ra.kind,
    status: ra.status,
    pegType: ra.pegType || null,
    dead: ra.dead || null,
    feeModelled: Boolean(ra.feeModelled),
    list: ra.list || null,
    cg: ra.cg || null,
    supply: null,
    supplyUsd: null,
    supplySource: 'none',
    supplyAsOf: null,
    supplyNote: null,
    current: null,
    priceDaily: null,
    hourly: null,
    priceLlamaDaily: null,
    priceConsensus: null,
    priceSources: null,
    chains: {},
    cgDaily: null,
    xauDaily: null,
    firstPriceT: null,
    addresses: [],
    thirdPartyAddresses: [],
    controls: ra.controls || null,
    cm: null,
    onchain: [],
  };
  const guard = (section, fn) => {
    try {
      fn();
    } catch (e) {
      ctx.errors.push(`model.asset ${a.key}.${section}: ${String((e && e.message) || e).slice(0, 160)}`);
    }
  };
  const inT = (t) => timeOk(Number(t), now);

  // Supply: DefiLlama asset chart (native units and USD). Its implied price
  // usd/native equals /stablecoinprices exactly, except that days without a
  // price come back as exactly 1.0: those are missing, not a perfect peg.
  guard('supply', () => {
    const charts = a.llamaId && raw.charts ? raw.charts[a.llamaId] : null;
    if (!Array.isArray(charts) || !charts.length) return;
    const pick = (o) => (isObj(o) ? (a.pegType && num(o[a.pegType]) !== null ? o[a.pegType] : num(Object.values(o)[0])) : null);
    const pts = charts.filter(isObj).map((r) => ({ t: Number(r.date), nat: pick(r.totalCirculating), usd: pick(r.totalCirculatingUSD) })).filter((p) => inT(p.t));
    a.supply = nonEmpty(daily(pts.map((p) => ({ t: p.t, v: p.nat })), { now }));
    a.supplyUsd = nonEmpty(daily(pts.map((p) => ({ t: p.t, v: p.usd })), { now }));
    a.priceDaily = nonEmpty(daily(pts.map((p) => ({ t: p.t, v: p.nat > 0 && p.usd !== null && p.usd / p.nat !== 1 ? p.usd / p.nat : null })), { now }));
    if (a.supply) a.supplySource = 'defillama:stablecoincharts';
  });

  guard('coingecko', () => {
    const cgc = a.geckoId && raw.cgCharts ? raw.cgCharts[a.geckoId] : null;
    if (!cgc) return;
    a.cgDaily = { mcap: msSeries(cgc.market_caps, now), vol: msSeries(cgc.total_volumes, now), price: msSeries(cgc.prices, now) };
    if (!a.supply) {
      // Assets DefiLlama does not track as stablecoins (gold tokens): supply = market cap / price (same 00:00 pair).
      const px = new Map(a.cgDaily.price.t.map((t, i) => [t, a.cgDaily.price.v[i]]));
      a.supply = nonEmpty(daily(a.cgDaily.mcap.t.map((t, i) => ({ t, v: px.get(t) > 0 ? a.cgDaily.mcap.v[i] / px.get(t) : null })), { now }));
      a.supplyUsd = nonEmpty(a.cgDaily.mcap);
      if (a.supply) a.supplySource = 'coingecko:market_chart(mcap/price)';
    }
  });
  guard('xau', () => {
    const xau = a.geckoId && raw.cgXau ? raw.cgXau[a.geckoId] : null;
    if (xau) a.xauDaily = nonEmpty(msSeries(xau.prices, now));
  });

  guard('prices', () => {
    if (coinKey && raw.hourly && Array.isArray(raw.hourly[coinKey])) a.hourly = raw.hourly[coinKey].filter((p) => isObj(p) && inT(p.t) && num(p.p) !== null).map((p) => ({ t: p.t, p: p.p }));
    if (a.hourly && !a.hourly.length) a.hourly = null;
    if (coinKey && raw.daily) a.priceLlamaDaily = pricesSeries(raw.daily[coinKey], now);
    if (coinKey && raw.first && num(raw.first[coinKey]) !== null && inT(raw.first[coinKey])) a.firstPriceT = raw.first[coinKey];
  });

  guard('price consensus', () => {
    const { consensus, count } = priceConsensus([a.priceDaily, a.priceLlamaDaily, a.cgDaily && a.cgDaily.price]);
    a.priceConsensus = consensus;
    a.priceSources = count;
  });

  // Per-chain history from the DefiLlama detail (native units), repaired:
  // untracked chains jump straight to a fake 0 dated today, interior gaps are
  // forward-filled (see stats.repairChainSeries).
  guard('chains', () => {
    const det = a.llamaId && raw.details ? raw.details[a.llamaId] : null;
    if (!det) return;
    for (const [chain, cb] of Object.entries(isObj(det.chainBalances) ? det.chainBalances : {})) a.chains[namer.name(chain)] = chainSeries(cb, a.pegType, now);
  });

  // Coin Metrics series for a validated mapping. An unsuffixed CM id covers the
  // asset (or, when the match says so, one chain of it); where DefiLlama has no
  // supply series (gold) and CM's history is longer than CoinGecko's 365 days,
  // CM SplyCur becomes the supply series. A CM daily row is the level at the end
  // of its day, i.e. at the next 00:00, and is valued at that instant's price.
  let cmScope = null;
  guard('coinmetrics', () => {
    const m = raw.cm && raw.cm.map ? raw.cm.map[id] : null;
    const rows = m && raw.cm.rows ? raw.cm.rows[m.id] : null;
    if (!Array.isArray(rows) || !rows.length) return;
    // chain: the one chain the series covers (an id suffix, or an unsuffixed id that matched one chain's
    // supply), as a display name; null when it covers the whole asset.
    a.cm = { key: m.id, rows, chain: m.scope ? namer.name(m.scope) : null };
    if (m.id.includes('_') || a.supplySource.startsWith('defillama')) return;
    const long = raw.cm.supply && Array.isArray(raw.cm.supply[m.id]) && raw.cm.supply[m.id].length ? raw.cm.supply[m.id] : rows;
    const sup = nonEmpty(daily(long.filter(isObj).map((r) => ({ t: Date.parse(r.time) / 1000 + DAY, v: Number(r.SplyCur) })), { now }));
    if (!sup || (a.supply && sup.t.length <= a.supply.t.length)) return;
    // Valued at the consensus daily price of the same instant. Daily price sources have holes; carry
    // the last price forward for at most a native week so the USD value does not drop to "missing"
    // on days the token supply is known.
    const px = new Map();
    if (a.priceConsensus) a.priceConsensus.t.forEach((t, i) => { if (a.priceConsensus.v[i] > 0) px.set(t, a.priceConsensus.v[i]); });
    let lastPx = null, lastT = null;
    a.supply = sup;
    a.supplyUsd = nonEmpty({ t: sup.t, v: sup.t.map((t, i) => {
      if (px.get(t) > 0) { lastPx = px.get(t); lastT = t; }
      return lastPx !== null && t - lastT <= 7 * DAY ? lastPx * sup.v[i] : null;
    }) });
    a.supplySource = 'coinmetrics:SplyCur';
    cmScope = m.scope || null;
    if (cmScope) a.supplyNote = `Coin Metrics ${m.id} covers ${cmScope} only; other chains' supply is added to the current level from on-chain reads, history is ${cmScope}-only`;
  });
  if (a.supply) a.supplyAsOf = lastOf(a.supply.t);

  guard('addresses', () => {
    const oc = (raw.onchain && Array.isArray(raw.onchain[id]) ? raw.onchain[id] : []).filter(isObj);
    a.onchain = oc.map((o) => ({ chain: namer.name(o.chain), address: o.address || null, holders: num(o.holders), totalSupply: num(o.totalSupply), source: o.source || null, asOf: o.asOf || null }));
    const addr = (x) => {
      const o = oc.find((y) => R.normAddr(y.address) === R.normAddr(x.address) && R.chainKey(y.chain) === R.chainKey(x.chain));
      return {
        chain: namer.name(x.chain),
        address: x.address,
        decimals: num(x.decimals) !== null ? x.decimals : o && num(o.decimals) !== null ? o.decimals : null,
        chainId: x.chainId || namer.chainId(namer.name(x.chain)) || null,
        llamaKey: x.llamaKey || null,
        cgPlatform: x.cgPlatform || null,
        role: x.role || 'issuer',
        via: x.via,
      };
    };
    a.addresses = (ra.addresses || []).map(addr);
    a.thirdPartyAddresses = (ra.thirdPartyAddresses || []).map(addr);
  });

  // Current snapshot: the freshest complete level of the asset, with the time it represents.
  // DefiLlama list members: the list (hourly; circulating is valued at the list price, so native =
  // circulating / price). Others: the supply series' last point plus, when that series covers one
  // chain only, the on-chain supply of the asset's other issuer contracts; valued at the freshest quote.
  guard('current', () => {
    const peg = a.pegType;
    const l = a.list;
    const lv = (o) => (isObj(o) ? num(peg && o[peg] !== undefined ? o[peg] : Object.values(o)[0]) : null);
    if (l && lv(l.circulating) !== null && num(ctx.listAsOf) !== null && a.status !== 'dead') {
      const p = num(l.price) > 0 ? l.price : null;
      const toNat = (usd) => (usd === null ? null : p ? usd / p : usd);
      const parts = Object.entries(isObj(l.chainCirculating) ? l.chainCirculating : {})
        .map(([chain, cc]) => ({ chain: namer.name(chain), supply: toNat(lv(cc && cc.current)), asOf: ctx.listAsOf, source: 'defillama:list' }))
        .filter((x) => x.supply !== null)
        .sort((x, y) => y.supply - x.supply || (x.chain < y.chain ? -1 : 1));
      a.current = {
        supply: toNat(lv(l.circulating)), price: p, supplyUsd: lv(l.circulating), asOf: ctx.listAsOf, priceAsOf: p ? ctx.listAsOf : null,
        source: 'defillama:list', parts, note: p ? null : 'DefiLlama list has no price for this asset; supply shown in USD terms',
      };
      return;
    }
    const lp = lastPoint(a.supply);
    if (!lp) return;
    const parts = [{ chain: cmScope, supply: lp.v, asOf: lp.t, source: a.supplySource }];
    if (cmScope) {
      for (const o of a.onchain) if (num(o.totalSupply) > 0 && R.chainKey(o.chain) !== R.chainKey(cmScope) && a.addresses.some((x) => R.chainKey(x.chain) === R.chainKey(o.chain) && R.normAddr(x.address) === R.normAddr(o.address))) {
        const t = Date.parse(o.asOf) / 1000;
        parts.push({ chain: o.chain, supply: o.totalSupply, asOf: Number.isFinite(t) ? t : null, source: o.source });
      }
    }
    const q = quoteOf(a);
    const supply = parts.reduce((s, x) => s + x.supply, 0);
    const asOfs = parts.map((x) => x.asOf).filter((t) => num(t) !== null);
    a.current = {
      supply, price: q ? q.p : null, supplyUsd: q ? supply * q.p : null, asOf: asOfs.length ? Math.min(...asOfs) : null, priceAsOf: q ? q.t : null,
      source: parts.length > 1 ? `${a.supplySource}+onchain` : a.supplySource, parts, note: parts.length > 1 ? a.supplyNote : null,
    };
  });
  return a;
}

function buildModel(raw, { now } = {}) {
  raw = raw || {};
  now = Number.isFinite(now) ? now : raw.now;
  const errors = [];
  const guard = (section, fn, fallback) => {
    try {
      return fn();
    } catch (e) {
      errors.push(`model.${section}: ${String((e && e.message) || e).slice(0, 160)}`);
      return fallback;
    }
  };
  const list = isObj(raw.list) && Array.isArray(raw.list.peggedAssets) && Array.isArray(raw.list.chains) ? raw.list : { peggedAssets: [], chains: [] };
  const namer = guard('chain names', () => R.makeChainNamer({ listChains: list.chains, llamaChains: raw.llamaChains, cgPlatforms: raw.cgPlatforms, evmChains: raw.chainlist }), null) || R.makeChainNamer({});
  const reg = isObj(raw.registry) && Array.isArray(raw.registry.assets) ? raw.registry : { assets: [], tiers: [] };
  const rows = (Array.isArray(raw.chartsAll) ? raw.chartsAll : []).filter((r) => isObj(r) && timeOk(Number(r.date), now));
  const listAsOf = num(raw.listAsOf) !== null ? Math.floor(raw.listAsOf) : null;

  // USD peg type = the one the discovered USD stablecoins carry (DefiLlama: peggedUSD).
  const usdPeg = reg.assets.filter((a) => a && a.kind === 'usd-stablecoin' && a.pegType).map((a) => a.pegType)[0] || 'peggedUSD';
  const market = guard('market', () => daily(rows.map((r) => ({ t: r.date, v: sumVals(r.totalCirculatingUSD) })), { now }), { t: [], v: [] });
  const marketUsd = guard('market', () => daily(rows.map((r) => ({ t: r.date, v: num((isObj(r.totalCirculatingUSD) ? r.totalCirculatingUSD : {})[usdPeg]) })), { now }), { t: [], v: [] });
  const ctx = { now, listAsOf, errors };
  const assets = [];
  for (const ra of reg.assets) {
    if (!isObj(ra) || !ra.key) continue;
    const a = guard(`asset ${ra.key}`, () => buildAsset(ra, raw, namer, ctx), null);
    if (a) assets.push(a);
  }

  const priceRef = (p) => {
    const k = 'coingecko:' + p.geckoId;
    const h = raw.hourly && Array.isArray(raw.hourly[k]) ? raw.hourly[k].filter((x) => isObj(x) && timeOk(x.t, now) && num(x.p) !== null) : null;
    return { hourly: h && h.length ? h : null, daily: pricesSeries(raw.daily && raw.daily[k], now) };
  };
  const pegPeers = guard('pegPeers', () => (raw.pegPeers || []).map((p) => ({ symbol: p.symbol, geckoId: p.geckoId, llamaId: p.llamaId, share: p.share, ...priceRef(p) })), []);
  const goldRefs = guard('goldRefs', () => (raw.goldRefs || []).map((g) => ({ symbol: g.symbol, geckoId: g.geckoId, name: g.name, ...priceRef(g) })), []);

  const chainTotals = guard('chainTotals', () => {
    const out = {};
    for (const c of list.chains) {
      if (!isObj(c) || typeof c.name !== 'string') continue;
      const h = raw.chainTotals && Array.isArray(raw.chainTotals[c.name]) ? raw.chainTotals[c.name] : null;
      out[namer.name(c.name)] = { current: sumVals(c.totalCirculatingUSD), hist: h ? nonEmpty(daily(h.filter(Array.isArray).map(([t, v]) => ({ t, v })), { now })) : null };
    }
    return out;
  }, {});

  // Fee model series are daily totals; a point dated today (the parent
  // adapter appends [today, 0]) is an incomplete day and is dropped.
  const feeSeries = (j) => daily((Array.isArray(j.totalDataChart) ? j.totalDataChart : []).filter((p) => Array.isArray(p) && Number(p[0]) < dayOf(now)).map(([t, v]) => ({ t: Number(t), v: num(v) })), { now });
  const fees = guard('fees', () => (isObj(raw.fees) ? { series: feeSeries(raw.fees), total24h: num(raw.fees.total24h), total1y: num(raw.fees.total1y), labels: R.feeLabels(raw.fees) } : null), null);
  const revenue = guard('revenue', () => (isObj(raw.revenue) ? { series: feeSeries(raw.revenue), total24h: num(raw.revenue.total24h) } : null), null);

  const cmPeers = guard('cmPeers', () => {
    const out = {};
    const used = new Set(assets.filter((a) => a.cm).map((a) => a.cm.key));
    for (const m of Object.values((raw.cm && raw.cm.peers) || {})) {
      const r = raw.cm.rows && raw.cm.rows[m.id];
      if (Array.isArray(r) && r.length && !used.has(m.id)) out[m.id] = r;
    }
    return out;
  }, {});

  return {
    now,
    list,
    listAsOf,
    listSanity: guard('listSanity', () => listSanity(list, rows), { tolerance: null, excluded: [] }),
    assets,
    market,
    marketUsd,
    pegPeers,
    goldRefs,
    chainTotals,
    pools: guard('pools', () => (Array.isArray(raw.pools) ? raw.pools.filter(isObj).map((p) => ({ ...p, chain: namer.name(p.chain) })) : null), null),
    lendBorrow: Array.isArray(raw.lendBorrow) ? raw.lendBorrow.filter(isObj) : null,
    fees,
    revenue,
    cmPeers,
    poolCharts: isObj(raw.poolCharts) ? raw.poolCharts : {},
    sources: raw.sources || [],
    errors,
    // Extension for the payload's discovery section: which tier found what, and how each DefiLlama join was made.
    discovery: {
      tiers: reg.tiers || [],
      joins: reg.assets.filter(isObj).map((a) => ({ key: a.key, llama: (a.joins && a.joins.llama) || null, gecko: (a.joins && a.joins.gecko) || null })),
    },
  };
}

module.exports = { buildModel, listSanity, daily, iso, dayOf, DAY, GENESIS, timeOk, priceConsensus, materialityFloor, materialChain, medianFlow, gridOf, chainSeries };
