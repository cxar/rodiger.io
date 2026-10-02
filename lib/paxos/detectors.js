'use strict';

// Detector catalog. Each detector is a pure function (model, opts) -> tests[]. A test is a candidate
// insight carrying its own p-value and USD materiality; only the engine decides what is notable.
// opts = { now, cut, assets }: `cut` drops the last k daily points of every series (k days of hours for
// hourly data) so the engine can ask "would this have fired k days ago?" without stored state; detectors
// that only ever see a current snapshot return [] for cut > 0. `assets` (Set of keys) restricts work.
// Nothing here names an asset, chain, pool or address: every subject is discovered by the model.

const S = require('./stats');
const F = require('./format');

const DAY = 86400;
const NATIVE = { day: 1, week: 7, month: 30 }; // DefiLlama circulatingPrevDay/Week/Month
const NATIVE_H = Object.values(NATIVE);
const YEAR = 365; // DefiLlama's 1y summary window: "the past year" for floors and the fee-lag search
const AGG = 'Paxos USD'; // pseudo-asset: sum of the active Paxos USD stablecoins
const AGG_SOURCE = 'sum of the active Paxos USD stablecoins';
const { isNum } = S;

// ---------- memoised, model-derived context (shared by detectors, novelty re-runs and attribution) ----------
const memo = new WeakMap();
function cached(obj, key, fn) {
  let m = memo.get(obj);
  if (!m) memo.set(obj, (m = new Map()));
  if (!m.has(key)) m.set(key, fn());
  return m.get(key);
}
const want = (opts, key) => !opts.assets || opts.assets.has(key);
const live = (a) => a.status !== 'dead' && !a.dead;
const usdMember = (a) => live(a) && a.kind === 'usd-stablecoin' && a.supplyUsd && a.supplyUsd.t && a.supplyUsd.t.length > 0;
// Aggregate members are ACTIVE issuance only: a legacy wind-down (e.g. a coin in redemption-only mode)
// would otherwise put its historic peak into the aggregate's drawdown and growth statistics. Legacy
// assets are still analysed individually.
const aggMember = (a) => usdMember(a) && a.status === 'active';
const liveAssets = (model, opts, pred = () => true) => model.assets.filter((a) => live(a) && want(opts, a.key) && pred(a));
const dayOf = (t) => Math.floor(Number(t) / DAY) * DAY;
const last = (xs) => xs[xs.length - 1];

// Contiguous daily grid: model Series are unique ascending days but may skip days (missing -> null).
// Leading/trailing missing values are trimmed so the last point is the last real observation.
function grid(s) {
  if (!s || !s.t || !s.t.length) return null;
  return cached(s, 'grid', () => {
    let a = 0, b = s.t.length - 1;
    while (a <= b && !isNum(s.v[a])) a++;
    while (b >= a && !isNum(s.v[b])) b--;
    if (a > b) return null;
    const t0 = dayOf(s.t[a]), n = Math.round((dayOf(s.t[b]) - t0) / DAY) + 1;
    const t = new Array(n), v = new Array(n).fill(null);
    for (let i = 0; i < n; i++) t[i] = t0 + i * DAY;
    for (let i = a; i <= b; i++) { const k = Math.round((dayOf(s.t[i]) - t0) / DAY); if (isNum(s.v[i])) v[k] = s.v[i]; }
    return { t, v };
  });
}
const cutS = (s, cut) => (!s || !cut ? s : s.t.length > cut ? { t: s.t.slice(0, -cut), v: s.v.slice(0, -cut) } : null);
const cutH = (h, cut) => (!h || !h.length || !cut ? h : h.filter((x) => x.t <= last(h).t - cut * DAY));
const at = (s, t) => { const k = Math.round((t - s.t[0]) / DAY); return k >= 0 && k < s.t.length ? s.v[k] : null; };
// An hourly series counts as current while its last print is at most one native day old (the page
// uses the same rule before charting hourly prices).
const hourlyFresh = (arr, now) => Boolean(arr && arr.length && isNum(now) && now - last(arr).t <= NATIVE.day * DAY);

// Upstream timestamps are trusted only up to `now` plus one day of clock skew. One far-future label (a
// unit slip, a bad row) would otherwise stretch every dense daily grid, and the O(n^2) lead-lag search,
// to that date, and silently move every "latest" value. Returns the model itself when nothing is out of
// range (the normal case: model series are ascending, so only last points are checked), else a copy in
// which only the out-of-range points are dropped. The data layer bounds ingestion as well; this keeps
// the engine and attribution safe whatever the model holds.
const SNAPSHOT_KEYS = new Set(['util', 'list', 'listSanity', 'pools', 'lendBorrow', 'sources', 'discovery', 'cg']); // no dated series inside
function bounded(model, now) {
  if (!model || !isNum(now)) return model;
  const maxT = now + DAY;
  const tOf = (x) => (x && typeof x === 'object' ? (isNum(x.t) ? x.t : typeof x.time === 'string' ? Date.parse(x.time) / 1000 : typeof x.timestamp === 'string' ? Date.parse(x.timestamp) / 1000 : null) : null);
  const walk = (x, depth) => {
    if (!x || typeof x !== 'object' || depth > 6) return x;
    if (Array.isArray(x)) {
      const lt = x.length ? tOf(last(x)) : null;
      if (lt !== null) return lt > maxT ? x.filter((q) => !(tOf(q) > maxT)) : x;
      let changed = false;
      const out = x.map((y) => { const z = walk(y, depth + 1); if (z !== y) changed = true; return z; });
      return changed ? out : x;
    }
    let out = x;
    if (Array.isArray(x.t) && Array.isArray(x.v) && x.t.length === x.v.length && x.t.length && last(x.t) > maxT) {
      let k = x.t.length;
      while (k > 0 && !(x.t[k - 1] <= maxT)) k--;
      out = { ...x, t: x.t.slice(0, k), v: x.v.slice(0, k) };
    }
    for (const [key, val] of Object.entries(x)) {
      if (key === 't' || key === 'v' || SNAPSHOT_KEYS.has(key) || !val || typeof val !== 'object') continue;
      const z = walk(val, depth + 1);
      if (z !== val) { if (out === x) out = { ...x }; out[key] = z; }
    }
    return out;
  };
  return cached(model, 'bounded:' + maxT, () => walk(model, 0));
}

// USD per native unit today (implied by supplyUsd/supply), falling back to the market price.
function priceOf(a) {
  return cached(a, 'px', () => {
    const s = grid(a.supply), u = grid(a.supplyUsd);
    if (s && u) for (let i = s.t.length - 1; i >= Math.max(0, s.t.length - NATIVE.month); i--) { const x = at(u, s.t[i]); if (isNum(x) && s.v[i] > 0) return x / s.v[i]; }
    if (a.cg && isNum(a.cg.current_price)) return a.cg.current_price;
    return a.kind === 'usd-stablecoin' ? 1 : null;
  });
}

// USD value of an asset's supply as token flows: for USD stablecoins the native supply at today's price
// (priceOf), so a peg wobble or a one-day bad price print is not a supply change (the page's convention
// for every "change"); other assets keep their USD value series.
function usdFlow(a) {
  return cached(a, 'usdFlow', () => {
    const s = grid(a.supply), px = priceOf(a);
    if (a.kind === 'usd-stablecoin' && s && isNum(px) && px > 0) return { t: s.t, v: s.v.map((x) => (isNum(x) ? x * px : null)) };
    return grid(a.supplyUsd);
  });
}
// A member whose supply history starts well after its market price does (the dq.history_gap rule: more
// than a native month) enters the aggregate with its whole balance on its first day: coverage, not
// issuance.
const lateStart = (a, s) => s && isNum(a.firstPriceT) && (s.t[0] - dayOf(a.firstPriceT)) / DAY > NATIVE.month;

// Paxos USD aggregate (token flows) on a daily grid ending at the last day EVERY member reported (a
// member whose latest day is missing would otherwise read as a phantom dip); interior gaps carry the last
// value. `flow` is the same series with each late-starting member's opening balance chain-linked out (like
// flowSupply), for flow statistics; `v` keeps the levels.
function aggregate(model) {
  return cached(model, 'agg', () => {
    const mem = model.assets.filter(aggMember).map((a) => ({ key: a.key, a, s: usdFlow(a) })).filter((x) => x.s);
    if (!mem.length) return null;
    const start = Math.min(...mem.map((x) => x.s.t[0])), end = Math.min(...mem.map((x) => last(x.s.t)));
    const n = Math.round((end - start) / DAY) + 1;
    if (n < 2) return null;
    const t = Array.from({ length: n }, (_, i) => start + i * DAY), v = new Array(n).fill(0), parts = {}, coverage = [];
    for (const x of mem) {
      const arr = new Array(n).fill(0);
      let prev = null;
      for (let i = 0; i < n; i++) { const val = at(x.s, t[i]); if (isNum(val)) prev = val; arr[i] = prev === null ? 0 : prev; v[i] += arr[i]; }
      parts[x.key] = arr;
      const k = Math.round((x.s.t[0] - start) / DAY);
      if (k > 0 && lateStart(x.a, x.s) && arr[k] > 0) coverage.push({ asset: x.key, k, t: t[k], usd: arr[k] });
    }
    const fv = v.slice();
    for (const c of coverage.sort((x, y) => x.k - y.k)) {
      const lvl = fv[c.k];
      if (!(lvl - c.usd > 0)) continue;
      const f = lvl / (lvl - c.usd);
      for (let i = 0; i < c.k; i++) fv[i] *= f;
    }
    return { t, v, parts, members: mem.map((x) => x.key), flow: { t, v: fv }, coverage: coverage.map(({ asset, t: ct, usd }) => ({ asset, t: ct, usd })) };
  });
}

// First day DefiLlama's market total is comparable with today's: the last one-day rise in its log that
// exceeds every later native-week move, judged only with a year of later history (a coverage step: coins
// added to the total, not market growth). null when there is none. One rule for the page and the engine.
function coverageStart(series) {
  const g = grid(series);
  if (!g) return null;
  const k = S.coverageStep(g.v, NATIVE.week, YEAR);
  return k === null ? null : g.t[k];
}

// Materiality floor = median |daily net flow| over the past year at today's price. Flat days are
// skipped (small assets repeat the last value on days nothing was reported). A move smaller than an
// ordinary day's flow is noise for that asset.
function medFlow(v) {
  const d = [];
  for (let i = Math.max(1, v.length - YEAR); i < v.length; i++) if (isNum(v[i]) && isNum(v[i - 1]) && v[i] !== v[i - 1]) d.push(Math.abs(v[i] - v[i - 1]));
  return d.length ? S.median(d) : null;
}
function floors(model) {
  return cached(model, 'floors', () => {
    const out = {};
    for (const a of model.assets) {
      const s = grid(a.supply), px = priceOf(a), f = s ? medFlow(s.v) : null;
      if (f !== null && isNum(px)) out[a.key] = f * px;
    }
    const agg = aggregate(model), f = agg ? medFlow(agg.v) : null;
    if (f !== null) out[AGG] = f;
    return out;
  });
}

// Per-asset chain panel (native units) on one daily grid. The panel ends at the last day every live,
// material chain reported, so a chain that is merely late does not read as an outflow; dust chains and
// lagging chains carry their last value; a chain whose tracking ended is 0 afterwards (as in the total).
function chainPanel(model, a) {
  return cached(a, 'panel', () => {
    const fl = floors(model)[a.key] || 0, px = priceOf(a) || 1;
    const ch = Object.entries(a.chains || {}).map(([name, c]) => ({ name, g: grid(c), ended: (c.notes || []).some((x) => x.kind === 'tracking_ended') })).filter((x) => x.g);
    if (!ch.length) return null;
    const recentMax = (g) => Math.max(0, ...g.v.slice(-NATIVE.month).filter(isNum));
    const start = Math.min(...ch.map((x) => x.g.t[0]));
    const hold = ch.filter((x) => !x.ended && recentMax(x.g) * px >= fl);
    const end = hold.length ? Math.min(...hold.map((x) => last(x.g.t))) : Math.max(...ch.map((x) => last(x.g.t)));
    const n = Math.round((end - start) / DAY) + 1;
    const days = Array.from({ length: n }, (_, i) => start + i * DAY), m = {};
    for (const x of ch) {
      const arr = new Float64Array(n), off = Math.round((x.g.t[0] - start) / DAY), stop = off + x.g.t.length - 1;
      let prev = 0;
      for (let i = Math.max(0, off); i < n; i++) {
        if (i > stop) { arr[i] = x.ended ? 0 : prev; continue; }
        const val = x.g.v[i - off];
        if (isNum(val)) prev = val;
        arr[i] = prev;
      }
      m[x.name] = arr;
    }
    return { days, names: ch.map((x) => x.name), m, px };
  });
}
const panelCut = (p, cut) => (!p || !cut ? p : p.days.length > cut ? { ...p, days: p.days.slice(0, -cut), m: Object.fromEntries(Object.entries(p.m).map(([k, v]) => [k, v.subarray(0, v.length - cut)])) } : null);
const column = (p, i) => Object.fromEntries(p.names.map((k) => [k, p.m[k][i]]));

function chainDrivers(model, a, t0, t1, k = 3) {
  const p = chainPanel(model, a);
  if (!p) return null;
  const i0 = Math.round((t0 - p.days[0]) / DAY), i1 = Math.round((t1 - p.days[0]) / DAY);
  if (i0 < 0 || i1 >= p.days.length || i1 <= i0) return null;
  const top = S.decompose(column(p, i0), column(p, i1)).parts.filter((x) => x.delta !== 0).slice(0, k);
  return top.length ? top.map((x) => ({ asset: a.key, chain: x.key, usd: x.delta * p.px })) : null;
}

// Several chains first appearing on one day = a tracking change (coverage), not launches.
function chainFirsts(a) {
  return Object.entries(a.chains || {}).map(([name, c]) => ({ name, c, first: isNum(c.first) ? dayOf(c.first) : c.t && c.t.length ? dayOf(c.t[0]) : null })).filter((x) => x.first !== null);
}
function coverageClusters(a) {
  return cached(a, 'clusters', () => S.trackingClusters(chainFirsts(a).map((x) => x.first), DAY));
}
// Supply with the coverage steps of later tracking changes taken out, so they never read as issuance.
function flowSupply(a) {
  return cached(a, 'flowSupply', () => {
    const s = grid(a.supply);
    const firsts = chainFirsts(a);
    if (!s || !firsts.length) return s;
    const start = Math.min(...firsts.map((x) => x.first));
    const firstVal = (x) => { const g = grid(x.c), v = g ? at(g, x.first) : null; return isNum(v) ? v : 0; };
    const steps = coverageClusters(a).filter((c) => c.date > start)
      .map((c) => ({ t: c.date, v: S.sum(firsts.filter((x) => x.first === c.date).map(firstVal)) })).filter((x) => x.v > 0);
    if (!steps.length) return s;
    // Chain-link like an index rebase: values before a coverage step are scaled by S/(S - step), so a
    // window spanning the step measures flows only and every level stays positive.
    const v = s.v.slice();
    for (const st of steps) {
      const k = Math.round((st.t - s.t[0]) / DAY), lvl = v[k];
      if (!(k > 0 && k < v.length && isNum(lvl) && lvl - st.v > 0)) continue;
      const f = lvl / (lvl - st.v);
      for (let i = 0; i < k; i++) if (isNum(v[i])) v[i] *= f;
    }
    return { t: s.t, v };
  });
}

// Address -> asset key, for joining yields pools/markets by underlying token.
const normAddr = (x) => (typeof x === 'string' && x.startsWith('0x') ? x.toLowerCase() : x);
function addrIndex(model) {
  return cached(model, 'addr', () => {
    const idx = new Map();
    for (const a of model.assets) for (const ad of a.addresses || []) if (ad && ad.address) idx.set(normAddr(ad.address), a.key);
    return idx;
  });
}
const poolAssets = (model, p) => [...new Set((p.underlyingTokens || []).map((x) => addrIndex(model).get(normAddr(x))).filter(Boolean))];
// Yields chain labels differ from the stablecoin API's display names; map by normalised comparison.
const normChain = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function displayChain(model, name) {
  const map = cached(model, 'chains', () => {
    const m = new Map();
    for (const a of model.assets) for (const c of Object.keys(a.chains || {})) m.set(normChain(c), c);
    for (const c of Object.keys(model.chainTotals || {})) if (!m.has(normChain(c))) m.set(normChain(c), c);
    return m;
  });
  return map.get(normChain(name)) || name;
}
function paxosPools(model) {
  return cached(model, 'pools', () => {
    const by = {};
    for (const p of model.pools || []) for (const k of poolAssets(model, p)) (by[k] = by[k] || []).push(p);
    return by;
  });
}

// ---------- test construction ----------
const mk = (o) => ({ chain: null, drivers: null, ...o });
const statOf = (r, extra) => ({ p: r.p, minP: r.minP, n: r.n, nEff: r.nEff, z: r.z, pct: r.pct, ...extra });
// Share of the sample the latest value is beyond, in its own direction.
const beyond = (r) => (r.x >= r.baseline ? r.pct : 1 - r.pct);
// Record clauses. "The largest X since D" checks every earlier window, overlapping ones included
// (windowTest.sinceIndex); when a window overlapping today's was at least as extreme there is no
// record to report and the clause is left out (null). Same for levels: "the highest since D" only when
// D is before the window start i0, i.e. today is above every value inside the window. Either way D must
// lie at least one native week before the window start ("largest since yesterday" says nothing), and a
// change of exactly 0 has no record. sinceRec/levelRec return the record as data ({ since: unix | null,
// null = on record }) for facts.record; sinceWords/levelWords word the same record for the headline.
const WEEK_S = NATIVE.week * DAY;
const farEnough = (s, i0, idx) => isNum(s.t[i0]) && isNum(s.t[idx]) && s.t[i0] - s.t[idx] >= WEEK_S;
function sinceRec(s, r) {
  if (!r || r.inWindow || r.x === 0) return null;
  if (r.sinceIndex === null) return { since: null };
  return farEnough(s, s.t.length - 1 - r.h, r.sinceIndex) ? { since: s.t[r.sinceIndex] } : null;
}
const sinceWords = (s, r, noun) => { const rec = sinceRec(s, r); return !rec ? null : rec.since === null ? `the largest ${noun} in the record (since ${F.date(s.t[0])})` : `the largest ${noun} since ${F.date(rec.since)}`; };
// startT: when the tested value covers several days (a 7-day average), its first day; default s.t[i0].
function levelRec(s, depth, hi, i0 = s.t.length - 1, chg, startT = s.t[i0]) {
  if (!depth || chg === 0) return null;
  const idx = hi ? depth.highestSinceIndex : depth.lowestSinceIndex;
  if (idx === null) return { hi, since: null };
  return idx < i0 && isNum(startT) && isNum(s.t[idx]) && startT - s.t[idx] >= WEEK_S ? { hi, since: s.t[idx] } : null;
}
const levelWords = (s, depth, hi, word = ['highest', 'lowest'], i0 = s.t.length - 1, chg, startT) => {
  const rec = levelRec(s, depth, hi, i0, chg, startT);
  return !rec ? null : rec.since === null ? `${hi ? word[0] : word[1]} on record (since ${F.date(s.t[0])})` : `${hi ? word[0] : word[1]} since ${F.date(rec.since)}`;
};
// facts.record of a change window / a level: { word, since: 'YYYY-MM-DD' | null (on record) } or null.
const recFact = (rec, word) => (rec ? { word, since: rec.since === null ? null : F.date(rec.since) } : null);
// Money resolution: the payload counts whole dollars (payload.js r0), so a change of less than one dollar
// is no change: it is tested as exactly 0, a tie (windowTest: p = 1), and has no record.
const DOLLAR = 1;
const flatBelowDollar = (ch, v, h, usdPerUnit) => (isNum(usdPerUnit) ? ch.map((x, i) => (isNum(x) && i >= h && Math.abs(v[i] - v[i - h]) * usdPerUnit < DOLLAR ? 0 : x)) : ch);
const clause = (x, sep = ', ') => (x ? sep + x : '');
// Unsigned magnitude after a directional verb ("fell 3.5%", never "fell -3.5%").
const mag = (x, d = 1) => F.share(Math.abs(x), d);

// Generic latest-h-window change tests over the horizon ladder (log or difference changes). With
// usdPerUnit (a series of token amounts), changes worth less than a dollar are flat (exactly 0).
function changeTests(s, kind, extraH = NATIVE_H, side = 'two', usdPerUnit = null) {
  const out = [];
  if (!s || s.v.length < 8) return out;
  for (const h of S.horizonLadder(s.v.length, extraH)) {
    const r = S.windowTest(flatBelowDollar(S.changes(s.v, h, kind), s.v, h, usdPerUnit), h, side);
    if (r) out.push({ h, r, i0: s.v.length - 1 - h, i1: s.v.length - 1 });
  }
  return out;
}

// ======================= SUPPLY =======================

// Subjects of the supply tests: every live asset (flow-adjusted for coverage steps when asked) and the
// Paxos USD aggregate, whose drivers are its member assets.
function assetDrivers(agg, t0, t1, k = 3) {
  const i0 = Math.round((t0 - agg.t[0]) / DAY), i1 = Math.round((t1 - agg.t[0]) / DAY);
  if (i0 < 0 || i1 >= agg.t.length) return null;
  const d = agg.members.map((m) => ({ asset: m, chain: null, usd: agg.parts[m][i1] - agg.parts[m][i0] })).filter((x) => x.usd).sort((x, y) => Math.abs(y.usd) - Math.abs(x.usd));
  return d.length ? d.slice(0, k) : null;
}
// Unit an asset's supply is counted in: USD for USD stablecoins, oz for gold that trades at one ounce a
// token (the payload's unitOf rule), else the peg currency or 'token'.
function nativeUnit(a) {
  if (!a || a.kind === 'usd-stablecoin') return 'USD';
  if (a.kind === 'gold') { const x = grid(a.xauDaily); return x && Math.round(last(x.v)) !== 1 ? 'token' : 'oz'; }
  return a.pegType && /^pegged/.test(a.pegType) ? a.pegType.slice(6) : 'token';
}
// The same move in the asset's own unit (gold: ounces), when that is not USD.
const nativeFact = (unit, x) => (unit === 'USD' ? {} : unit === 'oz' ? { ounces: x } : { native: x });
// facts.driver: the largest named driver of a move ({ name: chain or asset, usd, share of the move }).
function topDriverFact(drivers, delta) {
  const d = (drivers || []).filter((x) => isNum(x.usd) && (x.chain || x.asset)).sort((x, y) => Math.abs(y.usd) - Math.abs(x.usd))[0];
  return d && delta ? { name: d.chain || d.asset, usd: d.usd, share: d.usd / delta } : null;
}
function supplySubjects(model, opts, flow) {
  const out = [];
  for (const a of liveAssets(model, opts, (x) => x.supply)) {
    out.push({ key: a.key, s: flow ? flowSupply(a) : grid(a.supply), raw: grid(a.supply), px: priceOf(a), unit: nativeUnit(a), source: a.supplySource, drivers: (t0, t1, usd) => chainDrivers(model, a, t0, t1) || [{ asset: a.key, chain: null, usd }] });
  }
  const agg = aggregate(model);
  if (agg && agg.members.length > 1 && want(opts, AGG)) {
    out.push({ key: AGG, s: flow ? agg.flow : { t: agg.t, v: agg.v }, raw: { t: agg.t, v: agg.v }, px: 1, unit: 'USD', source: AGG_SOURCE, drivers: (t0, t1, usd) => assetDrivers(agg, t0, t1) || [{ asset: AGG, chain: null, usd }] });
  }
  return out;
}

function supplyMove(model, opts) {
  const out = [];
  for (const sub of supplySubjects(model, opts, true)) {
    const s = cutS(sub.s, opts.cut), px = sub.px;
    if (!s || !isNum(px)) continue;
    for (const { h, r, i0, i1 } of changeTests(s, 'log', NATIVE_H, 'two', px)) {
      const delta = (s.v[i1] - s.v[i0]) * px, drivers = sub.drivers(s.t[i0], s.t[i1], delta);
      out.push(mk({
        detector: 'supply.move', dimension: 'supply', asset: sub.key, metric: 'supply_log_change', window: h + 'd', horizon: h,
        direction: Math.sign(r.x), good: +1, value: r.x, baseline: r.baseline, materialityUsd: Math.abs(delta), stat: statOf(r),
        drivers,
        facts: { usd: delta, pct: Math.expm1(r.x), days: h, unit: sub.unit, ...nativeFact(sub.unit, s.v[i1] - s.v[i0]), usual: Math.expm1(r.baseline), beat: beyond(r), driver: topDriverFact(drivers, delta), record: recFact(sinceRec(s, r), r.x < 0 ? 'drop' : 'rise') },
        headline: `${sub.key} supply ${r.x < 0 ? 'fell' : 'grew'} ${mag(Math.expm1(r.x))} (${F.susd(delta)}) over ${F.days(h)}${clause(sinceWords(s, r, r.x < 0 ? 'decline' : 'increase'))}`,
        detail: `Beyond ${F.beat(beyond(r))} of ${r.n} earlier ${h}-day windows that end before this one starts (robust z ${F.fixed(r.z, 1)}; median ${h}-day change ${F.pct(Math.expm1(r.baseline))}). Source: ${sub.source || 'n/a'}.`,
        evidence: { metric: 'log change of supply', value: r.x, baseline: r.baseline, window: h + 'd', stat: 'two-sided empirical p vs non-overlapping earlier windows, floored at 2/(nEff+1)' },
        group: `supply.move|${sub.key}`, asOf: s.t[i1], series: cutS(sub.raw, opts.cut), // sparkline: reported supply
      }));
    }
  }
  return out;
}

// Drawdown of the CURRENT episode vs COMPLETED episodes. Episodes shallower than one ordinary day's
// flow (in USD) are wiggles, not drawdowns, and are not counted.
function supplyDrawdown(model, opts) {
  const out = [], fl = floors(model);
  for (const sub of supplySubjects(model, opts, false)) {
    const a = { key: sub.key }, s = cutS(sub.s, opts.cut), px = sub.px;
    if (!s || s.v.length < 8 || !isNum(px)) continue;
    const { completed, current: cur } = S.drawdownEpisodes(s.v);
    if (!cur || !(cur.depth < 0)) continue;
    const floor = fl[a.key] || 0;
    const eps = completed.filter((e) => -e.depth * e.peak * px >= floor);
    const deeper = eps.filter((e) => e.depth <= cur.depth);
    const p = (1 + deeper.length) / (1 + eps.length);
    const lossUsd = (cur.peak - s.v[cur.lastIdx]) * px;
    const lastDeeper = deeper.slice().sort((x, y) => y.peakIdx - x.peakIdx)[0];
    const med = eps.length ? S.median(eps.map((e) => e.depth)) : null;
    out.push(mk({
      detector: 'supply.drawdown', dimension: 'supply', asset: a.key, metric: 'drawdown_episode_depth', window: 'since ' + F.date(s.t[cur.peakIdx]),
      direction: -1, good: +1, value: cur.depth, baseline: med, materialityUsd: lossUsd, stat: { p, minP: 1 / (1 + eps.length), n: eps.length, deeper: deeper.length },
      drivers: sub.drivers(s.t[cur.peakIdx], s.t[cur.lastIdx], -lossUsd),
      facts: { depth: -cur.depth, lossUsd, peakDate: F.date(s.t[cur.peakIdx]), deeper: deeper.length, of: eps.length, medianDepth: isNum(med) ? -med : null, unit: sub.unit },
      headline: `${a.key} supply is ${mag(cur.depth)} (${F.usd(lossUsd)}) below its ${F.date(s.t[cur.peakIdx])} peak; ` + (!eps.length ? 'no earlier completed drawdown in the record'
        : deeper.length ? `${deeper.length} of ${eps.length} earlier drawdowns went deeper (most recent: ${F.date(s.t[lastDeeper.peakIdx])}, ${F.pct(lastDeeper.depth)}, recovered ${F.date(s.t[lastDeeper.recoveredIdx])})`
          : `deeper than all ${eps.length} earlier drawdowns (deepest ${F.pct(Math.min(...eps.map((e) => e.depth)))})`),
      detail: `${Math.round((s.t[cur.lastIdx] - s.t[cur.peakIdx]) / DAY)} days since the peak; deepest point of this episode ${F.pct(cur.maxDepth)} on ${F.date(s.t[cur.troughIdx])}. Earlier episodes count when their USD depth is at least one ordinary day's flow (${F.usd(floor)}); median completed depth ${F.pct(med)}.`,
      evidence: { metric: 'supply / running peak - 1 (current episode)', value: cur.depth, baseline: med, window: 'since ' + F.date(s.t[cur.peakIdx]), stat: 'share of completed drawdown episodes at least as deep' },
      group: `supply.drawdown|${a.key}`, asOf: s.t[cur.lastIdx], series: s,
    }));
  }
  return out;
}

function supplyStreak(model, opts) {
  const out = [];
  for (const a of liveAssets(model, opts, (x) => x.supply)) {
    const s = cutS(flowSupply(a), opts.cut), px = priceOf(a);
    if (!s || s.v.length < 8 || !isNum(px)) continue;
    // Flat days (no change, or under a dollar: flatBelowDollar) are neither mint nor burn.
    const d = flatBelowDollar(S.changes(s.v, 1, 'diff'), s.v, 1, px).map((x) => (x === 0 ? null : x));
    const st = S.streak(d, (x) => x > 0);
    if (!st) continue;
    let i0 = st.startIndex - 1;
    while (i0 > 0 && !isNum(s.v[i0])) i0--;
    const total = (last(s.v) - s.v[i0]) * px;
    out.push(mk({
      detector: 'supply.streak', dimension: 'supply', asset: a.key, metric: st.value ? 'net_mint_streak' : 'net_burn_streak', window: st.length + 'd',
      direction: st.value ? +1 : -1, good: +1, value: st.length, baseline: st.longestCompleted, materialityUsd: Math.abs(total),
      stat: { p: st.p, minP: st.minP, n: st.completedRuns, record: st.isRecord },
      drivers: chainDrivers(model, a, s.t[i0], last(s.t)) || [{ asset: a.key, chain: null, usd: total }],
      facts: { days: st.length, usd: total, dir: st.value ? 'up' : 'down', longestEarlier: st.longestCompleted, isRecord: st.isRecord, unit: nativeUnit(a) },
      headline: st.length === 1 ? `${a.key} supply ${st.value ? 'grew' : 'shrank'} on the latest reporting day (${F.susd(total)})`
        : `${a.key} supply has ${st.value ? 'grown' : 'shrunk'} on ${st.length} consecutive reporting days (${F.susd(total)})${st.isRecord ? ', the longest such streak on record' : ''}`,
      detail: `Streak began ${F.date(s.t[st.startIndex])}. Longest earlier ${st.value ? 'growth' : 'decline'} streak ${st.longestCompleted} days; ${st.completedRuns} completed streaks of this kind since ${F.date(s.t[0])}.`,
      evidence: { metric: 'consecutive same-sign daily supply changes', value: st.length, baseline: st.longestCompleted, window: st.length + 'd', stat: 'share of completed streaks at least as long' },
      group: `supply.streak|${a.key}`, asOf: last(s.t), series: cutS(grid(a.supply), opts.cut),
    }));
  }
  return out;
}

// Growth regimes: binary segmentation (rank CUSUM, persistence-aware null) of non-overlapping
// native-week log changes; each split with p < 1/2 is a test (the engine shows the most recent split
// that is notable, see collapseGroups). The weeks are calendar weeks (blocks end on Sundays, the last
// day of an ISO week), so the block grid and the split dates stay put as days are added; up to six
// trailing days are left out of the segmentation and still count in the "since" growth, which comes
// from endpoints (exact), not a median of daily flows.
const WEEK_END = 3; // day number (days since 1970-01-01, a Thursday) of the first Sunday
const isWeekEnd = (t) => (((Math.round(t / DAY) - WEEK_END) % NATIVE.week) + NATIVE.week) % NATIVE.week === 0;
// Identity of a dated event = the calendar week (ending Sunday) it falls in: a split located a day
// earlier or later as data accrues keeps its id (and its "seen" state on the page).
const weekKey = (t) => F.date(t + ((((WEEK_END - Math.round(t / DAY)) % NATIVE.week) + NATIVE.week) % NATIVE.week) * DAY);
function supplyRegime(model, opts) {
  const out = [], w = NATIVE.week, fl = floors(model);
  for (const a of liveAssets(model, opts, (x) => x.supply)) {
    const s = cutS(flowSupply(a), opts.cut), px = priceOf(a);
    if (!s || s.v.length < 8 * w || !isNum(px)) continue;
    let end = s.v.length - 1;
    while (end > 0 && !isWeekEnd(s.t[end])) end--;
    const pts = [];
    for (let i = end; i - w >= 0; i -= w) if (s.v[i] > 0 && s.v[i - w] > 0) pts.unshift({ i, x: Math.log(s.v[i] / s.v[i - w]) });
    const n = s.v.length - 1;
    for (const cp of S.regimeChain(pts.map((q) => q.x), 8)) {
      const startI = pts[cp.index].i - w, segI = pts[cp.segStart].i - w;
      const before = Math.log(s.v[startI] / s.v[segI]) / ((startI - segI) / NATIVE.month), after = Math.log(s.v[n] / s.v[startI]) / ((n - startI) / NATIVE.month);
      const delta = (s.v[n] - s.v[startI]) * px;
      // Growth from a base below one ordinary day's flow (a launch) is not a rate worth quoting.
      const launch = s.v[segI] * px < (fl[a.key] || 0), beforeTxt = launch ? `launch phase from ${F.date(s.t[segI])}` : `${F.pct(Math.expm1(before))} per 30 days`;
      out.push(mk({
        detector: 'supply.regime', dimension: 'supply', asset: a.key, metric: 'growth_regime', window: 'since ' + F.date(s.t[startI]), eventKey: F.date(s.t[startI]),
        // The end of a launch phase is a transition, not a good or bad change.
        direction: Math.sign(after - before), good: launch ? 0 : +1, value: after, baseline: before, materialityUsd: Math.abs(delta), stat: { p: cp.p, minP: cp.minP, n: pts.length, nEff: Math.round(cp.nEff), persistence: cp.r },
        ageDays: Math.round((s.t[n] - s.t[startI]) / DAY), drivers: chainDrivers(model, a, s.t[startI], s.t[n]) || [{ asset: a.key, chain: null, usd: delta }],
        facts: { since: F.date(s.t[startI]), beforePerMonth: launch ? null : Math.expm1(before), afterPerMonth: Math.expm1(after), launch, usdSince: delta, unit: nativeUnit(a) },
        headline: `${a.key} supply growth changed regime on ${F.date(s.t[startI])}: ${beforeTxt} before, ${F.pct(Math.expm1(after))} per 30 days since (${F.susd(delta)})`,
        detail: `Rank-CUSUM binary segmentation of ${pts.length} calendar-week log changes (weeks ending Sunday); this split has p=${F.pval(cp.p)} against a null that keeps the weekly changes' own persistence (lag-1 ${F.fixed(cp.r)}, effective sample ${Math.round(cp.nEff)}). The regime before it began ${F.date(s.t[segI])}.`,
        evidence: { metric: '30-day-equivalent log growth', value: after, baseline: before, window: F.date(s.t[startI]) + '..' + F.date(s.t[n]), stat: 'rank CUSUM, AR(1)-sieve null with the series\' own persistence' },
        group: `supply.regime|${a.key}`, asOf: s.t[n], series: cutS(grid(a.supply), opts.cut), preferLatest: true,
      }));
    }
  }
  return out;
}

// Home-chain supply that sits bridged on other chains: (minted - circulating)/minted on a chain where
// the asset is minted. Tested as a change in that share (percentage points) over the ladder; only chains
// where the bridged-out amount reached the asset's floor within the last native month are tested.
function bridgedOut(model, opts) {
  const out = [], fl = floors(model);
  for (const a of liveAssets(model, opts, (x) => x.chains)) {
    const px = priceOf(a) || 1;
    for (const [chain, c] of Object.entries(a.chains)) {
      const mg = grid(c.minted), cg = grid(c);
      if (!mg || !cg) continue;
      const days = mg.t.filter((t) => isNum(at(cg, t)) && at(mg, t) > 0);
      if (days.length < 8) continue;
      const t0 = days[0], n = Math.round((last(days) - t0) / DAY) + 1;
      const full = { t: Array.from({ length: n }, (_, i) => t0 + i * DAY), v: null };
      full.v = full.t.map((t) => { const m = at(mg, t), c1 = at(cg, t); return m > 0 && isNum(c1) && c1 <= m ? (m - c1) / m : null; });
      const sh = cutS(full, opts.cut);
      if (!sh || !isNum(last(sh.v)) || !currentChain(model, a, c, cutS(cg, opts.cut), opts.cut)) continue;
      const outUsd = sh.t.slice(-NATIVE.month).map((t, i, arr) => { const v = sh.v[sh.v.length - arr.length + i]; return isNum(v) ? v * at(mg, t) * px : 0; });
      if (!(Math.max(0, ...outUsd) >= (fl[a.key] || 0))) continue;
      for (const { h, r, i0, i1 } of changeTests(sh, 'diff')) {
        const m1 = at(mg, sh.t[i1]), m0 = at(mg, sh.t[i0]), o1 = sh.v[i1] * m1, o0 = sh.v[i0] * m0;
        out.push(mk({
          detector: 'supply.bridged_out', dimension: 'chains', asset: a.key, chain, metric: 'bridged_out_share', window: h + 'd', horizon: h,
          direction: Math.sign(r.x), good: 0, value: sh.v[i1], baseline: sh.v[i0], materialityUsd: Math.abs(o1 - o0) * px, stat: statOf(r),
          drivers: [{ asset: a.key, chain, usd: -(o1 - o0) * px }],
          facts: { chain, bridgedUsd: o1 * px, mintedUsd: m1 * px, share: sh.v[i1], shareBefore: sh.v[i0], days: h, change: r.x, usual: r.baseline, record: recFact(sinceRec(sh, r), r.x < 0 ? 'drop' : 'rise') },
          headline: `${a.key}: ${F.usd(o1 * px)} of the ${F.usd(m1 * px)} minted on ${chain} sits bridged on other chains (${F.share(sh.v[i1])}, ${F.share(sh.v[i0])} ${F.ago(h)})${clause(sinceWords(sh, r, r.x < 0 ? 'decrease' : 'increase'))}`,
          detail: `Bridged-out share = (minted - circulating)/minted on ${chain}. The ${h}-day change of ${F.pp(r.x)} is beyond ${F.beat(beyond(r))} of ${r.n} earlier non-overlapping windows (median ${F.pp(r.baseline)}).`,
          evidence: { metric: 'change in bridged-out share of home-chain minted supply', value: r.x, baseline: r.baseline, window: h + 'd', stat: 'two-sided empirical p, floored at 2/(nEff+1)' },
          group: `supply.bridged_out|${a.key}|${chain}`, asOf: sh.t[i1], series: sh,
        }));
      }
    }
  }
  return out;
}

// ======================= MARKET =======================

// Share of the stablecoin market of the asset's own peg type (USD assets vs the USD-pegged total).
// The share starts where the market total became comparable with today's (coverageStart): before that
// DefiLlama's total lacked most of the market and the "share" was a coverage artefact.
function marketShare(model, opts) {
  const out = [], mkt0 = grid(model.marketUsd), from = coverageStart(model.marketUsd);
  if (!mkt0) return out;
  const k0 = from === null ? 0 : Math.round((from - mkt0.t[0]) / DAY), mkt = { t: mkt0.t.slice(k0), v: mkt0.v.slice(k0) };
  if (!mkt.t.length) return out;
  const agg = aggregate(model);
  const subjects = [];
  if (agg && agg.members.length > 1 && want(opts, AGG)) subjects.push({ key: AGG, s: { t: agg.t, v: agg.v }, pegType: null });
  for (const a of model.assets.filter((x) => usdMember(x) && want(opts, x.key))) subjects.push({ key: a.key, s: usdFlow(a), a });
  const pegWord = F.pegLabel((model.assets.find(usdMember) || {}).pegType);
  for (const sub of subjects) {
    const t0 = Math.max(sub.s.t[0], mkt.t[0]), t1 = Math.min(last(sub.s.t), last(mkt.t));
    if (t1 - t0 < 16 * DAY) continue;
    const n = Math.round((t1 - t0) / DAY) + 1, t = Array.from({ length: n }, (_, i) => t0 + i * DAY);
    const full = { t, v: t.map((d) => { const x = at(sub.s, d), y = at(mkt, d); return x > 0 && y > 0 ? x / y : null; }) };
    const sh = cutS(full, opts.cut);
    if (!sh || sh.v.length < 16 || !isNum(last(sh.v))) continue;
    const depth = S.recordDepth(sh.v);
    for (const { h, r, i0, i1 } of changeTests(sh, 'log')) {
      const s0 = sh.v[i0], s1 = sh.v[i1], m0 = at(mkt, sh.t[i0]), m1 = at(mkt, sh.t[i1]);
      if (!isNum(s0) || !isNum(m0)) continue;
      const a0 = s0 * m0, a1 = s1 * m1, beta = s0 * (m1 - m0), idio = a1 - a0 - beta;
      const drivers = sub.a ? chainDrivers(model, sub.a, sh.t[i0], sh.t[i1]) || [{ asset: sub.key, chain: null, usd: idio }]
        : agg.members.map((k) => ({ asset: k, chain: null, usd: at({ t: agg.t, v: agg.parts[k] }, sh.t[i1]) - at({ t: agg.t, v: agg.parts[k] }, sh.t[i0]) })).filter((x) => x.usd).sort((x, y) => Math.abs(y.usd) - Math.abs(x.usd)).slice(0, 3);
      out.push(mk({
        detector: 'market.share', dimension: 'market', asset: sub.key, metric: 'share_of_peg_market', window: h + 'd', horizon: h,
        direction: Math.sign(r.x), good: +1, value: r.x, baseline: r.baseline, materialityUsd: Math.abs(idio), stat: statOf(r), drivers,
        facts: { from: s0, to: s1, days: h, usual: Math.expm1(r.baseline), ownFlowUsd: idio, marketPct: m1 / m0 - 1, peg: pegWord, record: recFact(levelRec(sh, depth, s1 >= s0, i0, s1 - s0), s1 >= s0 ? 'highest' : 'lowest') },
        headline: `${sub.key} share of the ${pegWord} stablecoin market moved ${F.shareSig(s0)} -> ${F.shareSig(s1)} over ${F.days(h)}${clause(levelWords(sh, depth, s1 >= s0, undefined, i0, s1 - s0), '; the share is the ')}`,
        detail: `The ${pegWord} stablecoin market moved ${F.susd(m1 - m0)}; at a constant share ${sub.key} would have moved ${F.susd(beta)}, it moved ${F.susd(a1 - a0)}: ${F.susd(idio)} of its own flow. The share change is beyond ${F.beat(beyond(r))} of ${r.n} earlier non-overlapping ${h}-day windows${from !== null ? ` since ${F.date(sh.t[0])} (the market total is comparable with today's from ${F.date(from)})` : ''}.`,
        evidence: { metric: 'log change of market share', value: r.x, baseline: r.baseline, window: h + 'd', stat: 'two-sided empirical p, floored at 2/(nEff+1)' },
        group: `market.share|${sub.key}`, asOf: sh.t[i1], series: sh,
      }));
    }
  }
  return out;
}

// Cross-section: the asset's growth among live peers of the same peg type. The p-value counts coins
// (two-sided empirical p of the asset among its k peers): a size-weighted percentile compares a small,
// volatile coin with the two largest, smoothest ones and flags ordinary moves (measured: 13% of all peers
// "notable" at a 1.4% nominal rate). The share of peer dollars that grew slower is reported as text
// only. Peers excluded by the list-vs-chart reconciliation are left out.
function peerGrowth(model, opts) {
  const out = [];
  if (opts.cut || !model.list || !model.list.peggedAssets) return out;
  const bad = new Set(((model.listSanity && model.listSanity.excluded) || []).map((e) => String(e.id)));
  const val = (x, f) => (x[f] && isNum(x[f][x.pegType]) ? x[f][x.pegType] : null);
  const all = model.list.peggedAssets.filter((x) => !x.deadFrom && !bad.has(String(x.id)) && val(x, 'circulating') > 0);
  const subjects = model.assets.filter((a) => live(a) && a.llamaId && a.pegType).map((a) => ({ key: a.key, ids: [String(a.llamaId)], pegType: a.pegType }));
  const aggIds = model.assets.filter((a) => aggMember(a) && a.llamaId).map((a) => String(a.llamaId));
  if (aggIds.length > 1) subjects.push({ key: AGG, ids: aggIds, pegType: (model.assets.find(usdMember) || {}).pegType, agg: true });
  for (const [name, h] of Object.entries(NATIVE)) {
    const field = 'circulatingPrev' + name[0].toUpperCase() + name.slice(1);
    for (const sub of subjects.filter((x) => want(opts, x.key))) {
      const pool = all.filter((x) => x.pegType === sub.pegType && val(x, field) > 0);
      const mine = pool.filter((x) => sub.ids.includes(String(x.id)));
      if (!mine.length) continue;
      const rows = (sub.agg ? pool.filter((x) => !sub.ids.includes(String(x.id))) : pool).map((x) => ({ id: String(x.id), sym: x.symbol, prev: val(x, field), cur: val(x, 'circulating') }));
      const self = { id: sub.ids.join('+'), sym: sub.key, prev: S.sum(mine.map((x) => val(x, field))), cur: S.sum(mine.map((x) => val(x, 'circulating'))) };
      if (sub.agg) rows.push(self);
      const me = sub.agg ? self : rows.find((x) => x.id === sub.ids[0]);
      if (rows.length < 3 || !me) continue;
      const x = me.cur / me.prev - 1, peers = rows.filter((o) => o !== me), others = peers.map((o) => o.cur / o.prev - 1), k = others.length;
      const p = S.empiricalP(x, others, 'two'), pct = S.percentileRank(x, others), W = S.sum(peers.map((o) => o.prev));
      const below = S.sum(peers.map((o, i) => (others[i] < x ? o.prev : others[i] === x ? o.prev / 2 : 0)));
      const byNow = rows.slice().sort((u, v) => v.cur - u.cur).map((r) => r.id), byPrev = rows.slice().sort((u, v) => v.prev - u.prev).map((r) => r.id);
      const rn = byNow.indexOf(me.id) + 1, rp = byPrev.indexOf(me.id) + 1, sym = new Map(rows.map((r) => [r.id, r.sym]));
      const passedBy = byNow.slice(0, rn - 1).filter((id) => byPrev.indexOf(id) > rp - 1).map((id) => sym.get(id));
      const passed = byPrev.slice(0, rp - 1).filter((id) => byNow.indexOf(id) > rn - 1).map((id) => sym.get(id));
      const dUsd = me.cur - me.prev, absRank = rows.filter((o) => o.cur - o.prev < dUsd).length + 1;
      out.push(mk({
        detector: 'market.peer_growth', dimension: 'market', asset: sub.key, metric: 'growth_vs_peers', window: h + 'd', horizon: h,
        direction: Math.sign(pct - 0.5), good: +1, value: x, baseline: S.median(others), materialityUsd: Math.abs(dUsd),
        stat: { p, minP: S.minEmpiricalP(k), n: k, pct, weightedPct: below / W, rankNow: rn, rankPrev: rp },
        // rankUsd: place by dollar change in the move's own direction (1 = the largest outflow, or inflow).
        facts: { usd: dUsd, pct: x, days: h, rankUsd: rows.filter((o) => (dUsd < 0 ? o.cur - o.prev < dUsd : o.cur - o.prev > dUsd)).length + 1, of: rows.length, fasterThan: pct, slowerThan: 1 - pct, medianPct: S.median(others), peg: F.pegLabel(sub.pegType) },
        headline: `${sub.key} ${h}-day growth ${F.pct(x)} (${F.susd(dUsd)}) is ${x >= S.median(others) ? 'faster' : 'slower'} than ${F.beat(x >= S.median(others) ? pct : 1 - pct)} of ${k} live ${F.pegLabel(sub.pegType)} stablecoins; by dollar change it ranks ${absRank === 1 ? 'last' : absRank === rows.length ? 'first' : '#' + absRank + ' from the bottom'} of ${rows.length}`,
        detail: `Median peer growth ${F.pct(S.median(others))}. ${F.share(below / W, 0)} of peer dollars grew slower (descriptive only: those dollars sit in an effective ${F.fixed(S.effectiveN(peers.map((o) => o.prev)), 1)} coins). Supply rank ${rp} -> ${rn} by DefiLlama ${field}.${passedBy.length ? ' Overtaken by ' + F.list(passedBy.slice(0, 5)) + '.' : ''}${passed.length ? ' Overtook ' + F.list(passed.slice(0, 5)) + '.' : ''}${sub.agg ? ' Peers exclude the Paxos assets themselves.' : ''} DefiLlama list snapshot; not dated by re-running earlier days.`,
        evidence: { metric: h + '-day growth vs peers', value: x, baseline: S.median(others), window: h + 'd', stat: 'two-sided empirical p by coin count among same-peg peers' },
        drivers: sub.agg ? mine.map((m) => ({ asset: (model.assets.find((a) => String(a.llamaId) === String(m.id)) || {}).key, chain: null, usd: val(m, 'circulating') - val(m, field) })).filter((d) => d.asset && d.usd) : null,
        group: `market.peer_growth|${sub.key}`, asOf: null,
      }));
    }
  }
  return out;
}

// ======================= CHAINS =======================

const materialChain = (g, px, floor) => g && Math.max(0, ...g.v.slice(-NATIVE.month).filter(isNum)) * px >= floor;
// A chain is tested only while it is still reported up to the asset's complete day: a chain whose
// tracking ended (or that stopped updating) would otherwise be tested "as of" its last, stale day.
function currentChain(model, a, c0, g, cut) {
  if (!g || (c0.notes || []).some((x) => x.kind === 'tracking_ended')) return false;
  const p = panelCut(chainPanel(model, a), cut);
  return Boolean(p) && last(g.t) >= last(p.days);
}

// How much moved BETWEEN chains (rotation intensity) vs the asset's own history; who drove the net change.
function chainAttribution(model, opts) {
  const out = [];
  for (const a of liveAssets(model, opts)) {
    const p = panelCut(chainPanel(model, a), opts.cut);
    if (!p || p.names.length < 2 || p.days.length < 16) continue;
    const n = p.days.length, cols = p.names.map((k) => p.m[k]);
    for (const h of NATIVE_H) {
      if (n < 4 * h) continue;
      const rot = new Array(n).fill(null);
      for (let i = h; i < n; i++) {
        let gross = 0, net = 0, tot = 0;
        for (const c of cols) { const d = c[i] - c[i - h]; gross += Math.abs(d); net += d; tot += c[i]; }
        // Offsetting moves worth less than a dollar are none (money resolution, see flatBelowDollar).
        rot[i] = tot > 0 ? ((gross - Math.abs(net)) / 2) * p.px < DOLLAR ? 0 : (gross - Math.abs(net)) / 2 / tot : null;
      }
      const r = S.windowTest(rot, h, 'upper');
      if (!r) continue;
      const d = S.decompose(column(p, n - 1 - h), column(p, n - 1)), top = d.parts.filter((x) => x.delta !== 0).slice(0, 3);
      if (!top.length) continue;
      out.push(mk({
        detector: 'chain.attribution', dimension: 'chains', asset: a.key, chain: top[0].key, metric: 'cross_chain_rotation', window: h + 'd', horizon: h,
        direction: 0, good: 0, value: r.x, baseline: r.baseline, materialityUsd: d.rotation * p.px, stat: statOf(r, { drivers: d.drivers }),
        drivers: top.map((x) => ({ asset: a.key, chain: x.key, usd: x.delta * p.px })),
        facts: { shiftedUsd: d.rotation * p.px, netUsd: d.net * p.px, days: h, share: r.x, usual: r.baseline, top: { chain: top[0].key, usd: top[0].delta * p.px } },
        headline: `${a.key}: ${F.usd(d.rotation * p.px)} of offsetting moves across chains over ${F.days(h)} while net supply moved ${F.susd(d.net * p.px)}; ${top[0].key} ${F.susd(top[0].delta * p.px)} (share ${F.share(top[0].sharePrev)} -> ${F.share(top[0].shareCurr)})`,
        detail: top.map((x) => `${x.key} ${F.susd(x.delta * p.px)} (${F.share(x.sharePrev)} -> ${F.share(x.shareCurr)})`).join('; ') + `. Offsetting moves = (sum of |chain change| - |net change|)/2: increases on some chains matched by decreases on others, whether or not tokens were bridged. ${F.share(r.x)} of supply is higher than ${F.beat(r.pct)} of ${r.n} earlier non-overlapping ${h}-day windows; effective number of driving chains ${F.fixed(d.drivers)}.`,
        evidence: { metric: 'rotation / supply = (sum|chain change| - |net change|)/2 / supply', value: r.x, baseline: r.baseline, window: h + 'd', stat: 'upper-tail empirical p, floored at 1/(nEff+1)' },
        group: `chain.attribution|${a.key}`, asOf: last(p.days), series: { t: p.days, v: rot },
      }));
    }
  }
  return out;
}

// Sweep of every material asset x chain series. Dust chains (below the asset's floor for the whole last
// native month) are skipped before testing, so they neither alert nor inflate the cell's multiplicity.
function chainMove(model, opts) {
  const out = [], fl = floors(model);
  for (const a of liveAssets(model, opts)) {
    const px = priceOf(a) || 1;
    for (const [chain, c0] of Object.entries(a.chains || {})) {
      if (opts.chain && opts.chain !== chain) continue;
      const c = cutS(grid(c0), opts.cut);
      if (!c || c.v.length < 16 || !materialChain(c, px, fl[a.key] || 0) || !currentChain(model, a, c0, c, opts.cut)) continue;
      for (const { h, r, i0, i1 } of changeTests(c, 'log', NATIVE_H, 'two', px)) {
        const delta = (c.v[i1] - c.v[i0]) * px, unit = nativeUnit(a);
        out.push(mk({
          detector: 'chain.move', dimension: 'chains', asset: a.key, chain, metric: 'chain_supply_log_change', window: h + 'd', horizon: h,
          direction: Math.sign(r.x), good: +1, value: r.x, baseline: r.baseline, materialityUsd: Math.abs(delta), stat: statOf(r),
          drivers: [{ asset: a.key, chain, usd: delta }],
          facts: { chain, usd: delta, pct: Math.expm1(r.x), days: h, unit, ...nativeFact(unit, c.v[i1] - c.v[i0]), usual: Math.expm1(r.baseline), beat: beyond(r), record: recFact(sinceRec(c, r), r.x < 0 ? 'drop' : 'rise') },
          headline: `${a.key} on ${chain} ${r.x < 0 ? 'fell' : 'grew'} ${mag(Math.expm1(r.x))} (${F.susd(delta)}) over ${F.days(h)}${clause(sinceWords(c, r, r.x < 0 ? 'decline' : 'increase'))}${r.inWindow ? '' : ' on this chain'}`,
          detail: `Chain series since ${F.date(c.t[0])} (${c.v.length} days); beyond ${F.beat(beyond(r))} of ${r.n} earlier non-overlapping ${h}-day windows.${(c0.notes || []).length ? ' Data notes: ' + c0.notes.map((x) => x.kind.replace(/_/g, ' ') + ' ' + F.date(x.from) + '..' + F.date(x.to)).join(', ') + '.' : ''}`,
          evidence: { metric: 'log change of chain circulating supply', value: r.x, baseline: r.baseline, window: h + 'd', stat: 'two-sided empirical p, floored at 2/(nEff+1)' },
          group: `chain.move|${a.key}|${chain}`, asOf: c.t[i1], series: c,
        }));
      }
    }
  }
  return out;
}

// Effective number of chains (1/HHI). Tested as a CHANGE over the ladder: the level is persistent, so
// "most diversified on record" alone is not rare; the record is reported in the wording.
function chainConcentration(model, opts) {
  const out = [];
  for (const a of liveAssets(model, opts)) {
    const p = panelCut(chainPanel(model, a), opts.cut);
    if (!p || p.names.length < 2 || p.days.length < 16) continue;
    const n = p.days.length, cols = p.names.map((k) => p.m[k]);
    const effN = { t: p.days, v: p.days.map((_, i) => S.effectiveN(cols.map((c) => c[i]))) };
    const depth = S.recordDepth(effN.v), x = last(effN.v);
    if (!isNum(x)) continue;
    const shares = p.names.map((k) => [k, p.m[k][n - 1]]).sort((u, v) => v[1] - u[1]), tot = S.sum(shares.map((q) => q[1]));
    for (const { h, r, i0 } of changeTests(effN, 'log')) {
      const d = S.decompose(column(p, i0), column(p, n - 1)), more = x >= effN.v[i0];
      out.push(mk({
        detector: 'chain.concentration', dimension: 'chains', asset: a.key, metric: 'effective_number_of_chains', window: h + 'd', horizon: h,
        direction: Math.sign(r.x), good: +1, value: x, baseline: effN.v[i0], materialityUsd: d.rotation * p.px, stat: statOf(r),
        drivers: d.parts.filter((q) => q.delta !== 0).slice(0, 3).map((q) => ({ asset: a.key, chain: q.key, usd: q.delta * p.px })),
        // record.word 'most' = most spread out (highest effective count), 'least' = most concentrated.
        facts: { effective: x, effectiveBefore: effN.v[i0], days: h, usual: Math.expm1(r.baseline), record: recFact(levelRec(effN, depth, more, i0, x - effN.v[i0]), more ? 'most' : 'least'), top: { chain: shares[0][0], share: tot ? shares[0][1] / tot : null } },
        headline: `${a.key} is spread over an effective ${F.fixed(x)} chains (${F.fixed(effN.v[i0])} ${F.ago(h)}${clause(more ? levelWords(effN, depth, true, ['most diversified', 'least diversified'], i0, x - effN.v[i0]) : levelWords(effN, depth, false, ['most diversified', 'most concentrated'], i0, x - effN.v[i0]), '; ')}); largest: ${shares[0][0]} ${F.share(shares[0][1] / tot)}`,
        detail: `1/HHI of chain balances. The ${h}-day change is beyond ${F.beat(beyond(r))} of ${r.n} earlier non-overlapping windows. Top chains: ${shares.slice(0, 3).map(([k, v]) => k + ' ' + F.share(v / tot)).join(', ')}.`,
        evidence: { metric: 'log change of 1/HHI(chain balances)', value: r.x, baseline: r.baseline, window: h + 'd', stat: 'two-sided empirical p, floored at 2/(nEff+1)' },
        group: `chain.concentration|${a.key}`, asOf: last(p.days), series: effN,
      }));
    }
  }
  return out;
}

// The asset's share of all stablecoins on a chain (dependency both ways).
function chainDominance(model, opts) {
  const out = [], fl = floors(model);
  for (const a of liveAssets(model, opts)) {
    const px = priceOf(a) || 1;
    for (const [chain, c0] of Object.entries(a.chains || {})) {
      if (opts.chain && opts.chain !== chain) continue;
      const tot = model.chainTotals && model.chainTotals[chain], T = tot && grid(tot.hist), c = grid(c0);
      if (!T || !c || !materialChain(c, px, fl[a.key] || 0) || !currentChain(model, a, c0, cutS(c, opts.cut), opts.cut)) continue;
      const t0 = Math.max(T.t[0], c.t[0]), t1 = Math.min(last(T.t), last(c.t));
      if (t1 - t0 < 16 * DAY) continue;
      const days = Array.from({ length: Math.round((t1 - t0) / DAY) + 1 }, (_, i) => t0 + i * DAY);
      const sh = cutS({ t: days, v: days.map((d) => { const x = at(c, d), y = at(T, d); return x > 0 && y > 0 ? (x * px) / y : null; }) }, opts.cut);
      if (!sh || sh.v.length < 16 || !isNum(last(sh.v))) continue;
      const depth = S.recordDepth(sh.v);
      for (const { h, r, i0, i1 } of changeTests(sh, 'log')) {
        const s0 = sh.v[i0], s1 = sh.v[i1], T0 = at(T, sh.t[i0]), T1 = at(T, sh.t[i1]);
        if (!isNum(s0)) continue;
        out.push(mk({
          detector: 'chain.dominance', dimension: 'chains', asset: a.key, chain, metric: 'share_of_chain_stablecoins', window: h + 'd', horizon: h,
          direction: Math.sign(r.x), good: 0, value: s1, baseline: s0, materialityUsd: Math.abs(s1 - s0) * T1, stat: statOf(r),
          drivers: [{ asset: a.key, chain, usd: (s1 * T1 - s0 * T0) }],
          facts: { chain, from: s0, to: s1, days: h, usual: Math.expm1(r.baseline), chainTotalPct: T1 / T0 - 1, record: recFact(levelRec(sh, depth, s1 >= s0, i0, s1 - s0), s1 >= s0 ? 'highest' : 'lowest') },
          headline: `${a.key} is ${F.shareSig(s1)} of all stablecoins on ${chain} (${F.shareSig(s0)} ${F.ago(h)}${clause(levelWords(sh, depth, s1 >= s0, undefined, i0, s1 - s0), '; ')}); the chain's stablecoin total moved ${F.pct(T1 / T0 - 1)}`,
          detail: `Share change beyond ${F.beat(beyond(r))} of ${r.n} earlier non-overlapping ${h}-day windows on this chain (series since ${F.date(sh.t[0])}).`,
          evidence: { metric: 'log change of asset share of chain stablecoins', value: r.x, baseline: r.baseline, window: h + 'd', stat: 'two-sided empirical p, floored at 2/(nEff+1)' },
          group: `chain.dominance|${a.key}|${chain}`, asOf: sh.t[i1], series: sh,
        }));
      }
    }
  }
  return out;
}

// Chains first appearing in the last native month (tracking-change clusters excluded), Poisson tail at
// the asset's historical launch rate.
function chainLifecycle(model, opts) {
  const out = [];
  for (const a of liveAssets(model, opts)) {
    const lastDay = cutLastDay(a, opts.cut);
    if (lastDay === null) continue;
    const firsts = chainFirsts(a).filter((x) => x.first <= lastDay);
    if (firsts.length < 3) continue;
    const clusterDays = new Set(S.trackingClusters(firsts.map((x) => x.first), DAY).map((c) => c.date));
    const lo = Math.min(...firsts.map((x) => x.first)), rate = firsts.length / ((lastDay - lo) / DAY + 1);
    const recent = firsts.filter((x) => (lastDay - x.first) / DAY < NATIVE.month && !clusterDays.has(x.first));
    if (!recent.length) continue;
    const lam = rate * NATIVE.month, k = recent.length, p = S.poissonTail(k, lam);
    const valOf = (x) => chainNowUsd(model, a, x.c, opts.cut);
    out.push(mk({
      detector: 'chain.lifecycle', dimension: 'chains', asset: a.key, metric: 'new_chains', window: NATIVE.month + 'd', eventKey: F.date(Math.max(...recent.map((x) => x.first))),
      direction: +1, good: +1, value: k, baseline: lam, materialityUsd: S.sum(recent.map(valOf)), stat: { p, minP: S.poissonTail(k, lam), n: firsts.length },
      ageDays: Math.round((lastDay - Math.max(...recent.map((x) => x.first))) / DAY),
      drivers: recent.map((x) => ({ asset: a.key, chain: x.name, usd: valOf(x) })).filter((d) => d.usd > 0),
      facts: { chains: recent.map((x) => ({ chain: x.name, first: F.date(x.first), usd: valOf(x) })), usualPerMonth: lam, days: NATIVE.month },
      headline: `${a.key} started reporting supply on ${F.list(recent.map((x) => `${x.name} (${F.date(x.first)}, ${F.usd(valOf(x))} now)`))} in the last ${NATIVE.month} days`,
      detail: `Historical rate ${F.fixed(lam)} new chains per ${NATIVE.month} days over ${firsts.length} chains (Poisson tail p=${F.pval(p)}); same-day multi-chain starts are counted as tracking changes, not launches.`,
      evidence: { metric: 'chains with a first observation in the window', value: k, baseline: lam, window: NATIVE.month + 'd', stat: 'Poisson tail at the historical launch rate' },
      group: `chain.lifecycle|${a.key}`, asOf: lastDay,
    }));
  }
  return out;
}
// USD on a chain as of the (cut) complete day; 0 once the chain is no longer reported.
function chainNowUsd(model, a, c, cut) {
  const g = cutS(grid(c), cut);
  return g && isNum(last(g.v)) && currentChain(model, a, c, g, cut) ? last(g.v) * (priceOf(a) || 1) : 0;
}
function cutLastDay(a, cut) {
  let lastDay = null;
  for (const c of Object.values(a.chains || {})) { const g = cutS(grid(c), cut); if (g && (lastDay === null || last(g.t) > lastDay)) lastDay = last(g.t); }
  return lastDay;
}

// Coverage changes: multi-chain same-day starts (incl. where tracking begins) and tracking ends.
function trackingChange(model, opts) {
  const out = [];
  for (const a of liveAssets(model, opts)) {
    const lastDay = cutLastDay(a, opts.cut);
    if (lastDay === null) continue;
    const px = priceOf(a) || 1, firsts = chainFirsts(a).filter((x) => x.first <= lastDay);
    const start = firsts.length ? Math.min(...firsts.map((x) => x.first)) : null;
    const valOf = (x) => chainNowUsd(model, a, x.c, opts.cut);
    for (const cl of S.trackingClusters(firsts.map((x) => x.first), DAY)) {
      const members = firsts.filter((x) => x.first === cl.date), now = S.sum(members.map(valOf));
      out.push(mk({
        detector: 'dq.tracking_change', dimension: 'data', asset: a.key, metric: 'chain_start_cluster', window: F.date(cl.date), eventKey: F.date(cl.date),
        direction: -1, good: 0, value: cl.count, baseline: cl.expected, materialityUsd: now, stat: { p: cl.p, minP: cl.p, n: cl.dates },
        ageDays: Math.round((lastDay - cl.date) / DAY),
        facts: { variant: 'start', count: cl.count, date: F.date(cl.date), usd: now, begins: cl.date === start, expected: cl.expected },
        headline: cl.date === start ? `${a.key}: DefiLlama chain tracking begins ${F.date(cl.date)} with ${cl.count} chains at once; supply before this date is not in the series`
          : `${a.key}: ${cl.count} chains first appear on ${F.date(cl.date)}, a DefiLlama tracking change rather than ${cl.count} launches (${F.usd(now)} on those chains now)`,
        detail: `${F.list(members.map((x) => x.name))}. Expected ${F.fixed(cl.expected)} chain starts on any one day at the historical rate (Poisson tail p=${F.pval(cl.p)} across ${cl.dates} start dates). Supply steps on that date are coverage, not issuance, and are removed from flow tests.`,
        evidence: { metric: 'chains with the same first date', value: cl.count, baseline: cl.expected, window: '1d', stat: 'Poisson tail, family of distinct start dates' },
        group: `dq.tracking_change|${a.key}|${F.date(cl.date)}`, asOf: cl.date,
      }));
    }
    const ended = Object.entries(a.chains || {}).map(([chain, c]) => {
      const note = (c.notes || []).find((x) => x.kind === 'tracking_ended' && x.to <= lastDay), g = grid(c);
      return note ? { chain, note, usd: g ? Math.abs(last(g.v)) * px : 0 } : null;
    }).filter(Boolean).sort((x, y) => y.note.from - x.note.from);
    if (ended.length) {
      const latest = ended[0], gap = latest.note.gapSteps, total = S.sum(ended.map((e) => e.usd)), recent = ended.filter((e) => latest.note.from - e.note.from < NATIVE.month * DAY);
      out.push(mk({
        detector: 'dq.tracking_change', dimension: 'data', asset: a.key, chain: ended.length === 1 ? latest.chain : null, metric: 'tracking_ended', window: F.date(latest.note.from) + '..' + F.date(latest.note.to), eventKey: F.date(latest.note.from),
        direction: -1, good: 0, value: ended.length, baseline: null, materialityUsd: S.sum(recent.map((e) => e.usd)), stat: { p: 1 / (gap + 1), minP: 1 / (gap + 1), n: null },
        ageDays: Math.round((lastDay - latest.note.from) / DAY),
        facts: { variant: 'ended', count: ended.length, chain: latest.chain, date: F.date(latest.note.from), usd: total, gapDays: gap },
        headline: ended.length === 1 ? `${a.key}: DefiLlama stopped reporting ${latest.chain} after ${F.date(latest.note.from)} (a ${gap}-day gap ending in a synthetic zero); read as end of tracking, not a burn of ${F.usd(total)}`
          : `${a.key}: DefiLlama stopped reporting ${ended.length} chains (latest ${latest.chain} after ${F.date(latest.note.from)}, a ${gap}-day gap ending in a synthetic zero); read as end of tracking, not a burn (${F.usd(total)} on those chains when last reported)`,
        detail: `${ended.slice(0, 8).map((e) => `${e.chain} after ${F.date(e.note.from)} (${F.usd(e.usd)})`).join('; ')}${ended.length > 8 ? '; ...' : ''}. The synthetic final zero is dropped from each chain series; the chain counts as 0 afterwards, as in the DefiLlama total.`,
        evidence: { metric: 'chains whose series ends in a synthetic zero after a gap', value: ended.length, baseline: null, window: F.date(latest.note.from) + '..' + F.date(latest.note.to), stat: 'record-style 1/(gap+1) for the latest end' },
        group: `dq.tracking_change|${a.key}|ended`, asOf: latest.note.to,
      }));
    }
  }
  return out;
}

// ======================= PEG =======================

const pegAssets = (model, opts) => liveAssets(model, opts, (a) => a.kind === 'usd-stablecoin');
// The one daily price every peg statistic uses, and the page charts: the model's consensus series (per
// day the median of the available daily sources, so one bad print from one source cannot drive a
// finding) when present, else the series the page falls back to.
function pegPrice(a) {
  if (a.priceConsensus && a.priceConsensus.t && a.priceConsensus.t.length && a.priceConsensus.v.some(isNum)) return a.priceConsensus;
  if (a.priceDaily && a.priceDaily.t && a.priceDaily.t.length > NATIVE.month) return a.priceDaily;
  if (a.cgDaily && a.cgDaily.price && a.cgDaily.price.t && a.cgDaily.price.t.length) return a.cgDaily.price;
  return a.priceLlamaDaily || null;
}
function pegPriceLabel(a) {
  const s = pegPrice(a);
  return !s ? 'n/a' : s === a.priceConsensus ? 'consensus daily price (median of the daily price sources)' : s === a.priceDaily ? 'daily price implied by DefiLlama circulating USD / circulating units'
    : s === (a.cgDaily && a.cgDaily.price) ? 'CoinGecko daily price' : 'DefiLlama coins daily price';
}
// Peers with the asset's own peg type only (a peer is skipped when the list says it is pegged elsewhere).
// Peg peers are non-Paxos coins by construction (registry.selectPegPeers).
function pegRefs(model, a) {
  return cached(a, 'pegRefs', () => {
    const list = (model.list && model.list.peggedAssets) || [];
    const peg = (p) => { const x = list.find((y) => (p.llamaId && String(y.id) === String(p.llamaId)) || (p.geckoId && y.gecko_id === p.geckoId)); return x ? x.pegType : null; };
    return { peers: (model.pegPeers || []).filter((p) => { const t = peg(p); return t === null || t === a.pegType; }) };
  });
}
// Reference |deviation| per day: median over the same-peg majority peers. Sibling Paxos assets are not
// part of it: issuer-wide stress would otherwise move the reference with the asset and hide itself.
function refDaily(model, a) {
  return cached(a, 'refDaily', () => {
    const m = new Map();
    for (const s of pegRefs(model, a).peers.map((p) => grid(p.daily)).filter(Boolean)) {
      s.t.forEach((t, i) => { if (isNum(s.v[i])) (m.get(t) || m.set(t, []).get(t)).push(Math.abs(s.v[i] - 1)); });
    }
    return new Map([...m].map(([t, v]) => [t, S.median(v)]));
  });
}

// Hourly detail line: only hourly series that are current as of the test's own date are used, and the
// window is described by its real time span (a feed that stopped is named with its end, not as "the
// last N hours").
function hourlyPegText(model, a, opts) {
  const asOf = isNum(opts.now) ? opts.now - (opts.cut || 0) * DAY : null;
  const hr = cutH(a.hourly, opts.cut);
  const hMed = (h) => S.median(h.map((q) => Math.abs(q.p - 1)));
  if (!hr || !hr.length) return '';
  if (!hourlyFresh(hr, asOf)) return ` Hourly prices for ${a.key} end ${F.dateTime(last(hr).t)} and are not compared.`;
  const worst = hr.reduce((w, q) => (Math.abs(q.p - 1) > Math.abs(w.p - 1) ? q : w));
  const peers = pegRefs(model, a).peers.map((x) => ({ name: x.symbol, h: cutH(x.hourly, opts.cut) })).filter((x) => hourlyFresh(x.h, asOf));
  const span = Math.round((last(hr).t - hr[0].t) / 3600);
  return ` Hourly median |deviation| over ${hr.length} prints from ${F.dateTime(hr[0].t)} to ${F.dateTime(last(hr).t)} (${span} h): ${F.bp(hMed(hr))}${peers.length ? ' vs ' + peers.map((x) => `${x.name} ${F.bp(hMed(x.h))}`).join(', ') : ''}; widest hour ${F.fixed(worst.p, 5)} at ${F.dateTime(worst.t)}.`;
}

// Peg peers over a set of days: their symbols and the widest peer's mean |price - 1| on those days (the
// briefing's peer bar, measured on the same daily prices the page charts). gap is null without peer data.
function peerGapOn(model, a, days) {
  const set = new Set(days), names = [], gaps = [];
  for (const p of pegRefs(model, a).peers) {
    const g = grid(p.daily), d = g ? g.t.map((t, i) => (set.has(t) && isNum(g.v[i]) ? Math.abs(g.v[i] - 1) : null)).filter(isNum) : [];
    if (d.length && p.symbol) { names.push(p.symbol); gaps.push(S.sum(d) / d.length); }
  }
  return { peers: names, peerGap: gaps.length ? Math.max(...gaps) : null };
}

function pegDeviation(model, opts) {
  const out = [];
  for (const a of pegAssets(model, opts)) {
    const px = priceOf(a) || 1, sup = grid(a.supply), exposure = sup ? last(sup.v) * px : null;
    const ref = refDaily(model, a), own = cutS(grid(pegPrice(a)), opts.cut), peerNames = F.list(pegRefs(model, a).peers.map((x) => x.symbol));
    if (!own) continue;
    const variants = [{ key: 'abs', s: own, dev: own.v.map((p) => (isNum(p) ? Math.abs(p - 1) : null)) }];
    if (ref.size) variants.push({ key: 'excess', s: own, dev: own.v.map((p, i) => (isNum(p) && ref.has(own.t[i]) ? Math.abs(p - 1) - ref.get(own.t[i]) : null)) });
    const hourTxt = hourlyPegText(model, a, opts);
    for (const vr of variants) {
      const n = vr.dev.length, valid = vr.dev.filter(isNum).length;
      for (const h of S.horizonLadder(valid, NATIVE_H)) {
        const roll = S.rollingMean(vr.dev, h), r = S.windowTest(roll, h, 'upper');
        if (!r) continue;
        const signed = vr.s.v.slice(n - h).filter(isNum), meanSigned = signed.length ? S.sum(signed.map((v) => v - 1)) / signed.length : 0, side = meanSigned < 0 ? 'below' : 'above';
        // A window mean dominated by one day says so: more than half of the window's total from one day.
        const win = vr.dev.slice(n - h).map((d, j) => ({ d, t: vr.s.t[n - h + j] })).filter((q) => isNum(q.d));
        const top = win.length > 1 ? win.reduce((m, q) => (q.d > m.d ? q : m)) : null, tot = S.sum(win.map((q) => q.d));
        const oneDay = top && tot > 0 && top.d > tot / 2 ? ` (mostly ${F.date(top.t)}: ${F.bp(top.d)})` : '';
        const record = r.x > r.baseline ? sinceWords(vr.s, r, vr.key === 'excess' ? 'relative deviation' : 'deviation') : null;
        const pg = peerGapOn(model, a, vr.s.t.slice(n - h));
        out.push(mk({
          detector: 'peg.deviation', dimension: 'peg', asset: a.key, metric: vr.key === 'abs' ? 'mean_abs_deviation' : 'excess_deviation_vs_peers', variant: vr.key, window: h + 'd', horizon: h,
          direction: r.x > r.baseline ? +1 : -1, good: -1, value: r.x, baseline: r.baseline, materialityUsd: exposure, stat: statOf(r),
          facts: { variant: vr.key, gap: r.x, side, days: h, usual: r.baseline, peers: pg.peers, peerGap: pg.peerGap, record: r.x > r.baseline ? recFact(sinceRec(vr.s, r), 'gap') : null },
          headline: vr.key === 'excess'
            ? `${a.key} deviated ${F.bp(Math.abs(r.x))} ${r.x >= 0 ? 'more' : 'less'} from peg than ${peerNames} on average over ${F.days(h)}${oneDay} (${side} peg; median ${F.sbp(r.baseline)})${clause(record)}`
            : `${a.key} averaged ${F.bp(r.x)} from peg (${side}) over ${F.days(h)}${oneDay}${clause(record)}`,
          detail: `Wider than ${F.beat(r.pct)} of ${r.n} earlier non-overlapping ${h}-day windows (median ${F.bp(r.baseline)}). Price: ${pegPriceLabel(a)}.${vr.key === 'excess' ? ` Reference = daily median |deviation| of the same-peg majority peers (${peerNames}).` : ''}${hourTxt}`,
          evidence: { metric: vr.key === 'abs' ? 'rolling mean |price - 1|' : 'rolling mean (|price - 1| - reference |price - 1|)', value: r.x, baseline: r.baseline, window: h + 'd', stat: 'upper-tail empirical p, floored at 1/(nEff+1)' },
          group: `peg.deviation|${a.key}|${vr.key}`, asOf: last(vr.s.t), series: { t: vr.s.t, v: vr.dev },
        }));
      }
    }
  }
  return out;
}

function pegRegime(model, opts) {
  const out = [];
  for (const a of pegAssets(model, opts)) {
    const s = cutS(grid(pegPrice(a)), opts.cut);
    if (!s) continue;
    const idx = [];
    s.v.forEach((v, i) => { if (isNum(v)) idx.push(i); });
    const x = idx.map((i) => Math.abs(s.v[i] - 1)), px = priceOf(a) || 1, sup = grid(a.supply);
    const chain = S.regimeChain(x, 8), recent = x.length >= NATIVE.week ? S.median(x.slice(-NATIVE.week)) : null;
    for (const [k, cp] of chain.entries()) {
      // A widening that is the latest split and still describes the last week is a condition still
      // holding (stage ongoing, engine.stageOf), not a dated past event: the coin is still off its peg.
      const holding = k === chain.length - 1 && cp.after.median > cp.before.median && isNum(recent) && recent >= (cp.before.median + cp.after.median) / 2;
      const t0 = s.t[idx[cp.index]], seg0 = s.t[idx[cp.segStart]];
      const since = s.t.filter((t) => t >= t0), pg = peerGapOn(model, a, since), signed = idx.slice(cp.index).map((i) => s.v[i] - 1);
      out.push(mk({
        detector: 'peg.regime', dimension: 'peg', asset: a.key, metric: 'deviation_regime', window: 'since ' + F.date(t0), eventKey: 'week-' + weekKey(t0),
        direction: Math.sign(cp.after.median - cp.before.median), good: -1, value: cp.after.median, baseline: cp.before.median,
        materialityUsd: sup ? last(sup.v) * px : null, stat: { p: cp.p, minP: cp.minP, n: x.length, nEff: Math.round(cp.nEff), persistence: cp.r }, ageDays: Math.round((last(s.t) - t0) / DAY),
        facts: { since: F.date(t0), before: cp.before.median, after: cp.after.median, side: S.sum(signed) < 0 ? 'below' : 'above', peers: pg.peers, peerGap: pg.peerGap },
        headline: `${a.key} peg regime shifted on ${F.date(t0)}: median daily deviation ${F.bp(cp.before.median)} -> ${F.bp(cp.after.median)}`,
        detail: `Rank-CUSUM binary segmentation of daily |price - 1| (${cp.before.n} days from ${F.date(seg0)}, ${cp.after.n} after; ${pegPriceLabel(a)}); this split has p=${F.pval(cp.p)} against a null that keeps the series' own persistence (lag-1 ${F.fixed(cp.r)}, effective sample ${Math.round(cp.nEff)}).`,
        evidence: { metric: 'median |price - 1|', value: cp.after.median, baseline: cp.before.median, window: F.date(t0) + '..' + F.date(last(s.t)), stat: 'rank CUSUM, AR(1)-sieve null with the series\' own persistence' },
        group: `peg.regime|${a.key}`, asOf: last(s.t), series: { t: s.t, v: s.v.map((v) => (isNum(v) ? Math.abs(v - 1) : null)) }, preferLatest: true, holding,
      }));
    }
  }
  return out;
}

// Do discounts and redemptions move together? Rank correlation of daily (price - 1) with the daily log
// supply change L days later, best |L| <= n^(1/3), over the full history (exact circular-shift null).
function pegFlowCoupling(model, opts) {
  const out = [], w = NATIVE.week;
  for (const a of pegAssets(model, opts)) {
    const s = cutS(flowSupply(a), opts.cut), pr = grid(pegPrice(a)), px = priceOf(a) || 1;
    if (!s || !pr || s.v.length < 2 * w) continue;
    const dev = s.t.map((t) => { const p = at(pr, t); return isNum(p) ? p - 1 : null; });
    const flow = S.changes(s.v, 1, 'log');
    const ll = S.leadLag(dev, flow);
    if (!ll) continue;
    const n = s.v.length, devNow = dev.slice(-w).filter(isNum), devMean = devNow.length ? S.sum(devNow) / devNow.length : 0;
    const flowNow = s.v[n - 1] > 0 && s.v[n - 1 - w] > 0 ? Math.log(s.v[n - 1] / s.v[n - 1 - w]) : 0;
    const quadrant = devMean < 0 && flowNow < 0 ? 'a discount with net redemptions' : devMean > 0 && flowNow > 0 ? 'a premium with net issuance' : devMean < 0 ? 'a discount with net issuance' : 'a premium with net redemptions';
    const lagTxt = ll.lag > 0 ? `supply moving ${F.days(ll.lag)} after price` : ll.lag < 0 ? `supply moving ${F.days(-ll.lag)} before price` : 'same-day';
    out.push(mk({
      detector: 'peg.flow_coupling', dimension: 'peg', asset: a.key, metric: 'deviation_flow_rank_correlation', window: 'since ' + F.date(s.t[0]),
      direction: Math.sign(ll.rho), good: 0, value: ll.rho, baseline: 0, materialityUsd: Math.abs(s.v[n - 1] - s.v[n - 1 - w]) * px,
      stat: { p: ll.p, minP: ll.minP, n: ll.n, lag: ll.lag, maxLag: ll.maxLag },
      facts: { rho: ll.rho, lag: ll.lag, from: F.date(s.t[0]), days: w, gap: devMean, side: devMean < 0 ? 'below' : 'above', flowPct: Math.expm1(flowNow), flow: flowNow < 0 ? 'redemptions' : 'issuance' },
      headline: `${a.key} price deviation and supply flow: rank correlation ${F.fixed(ll.rho)} (${lagTxt}) since ${F.date(s.t[0])}; the last ${w} days show ${quadrant} (mean ${F.bp(Math.abs(devMean))} ${devMean < 0 ? 'below' : 'above'} peg, supply ${F.pct(Math.expm1(flowNow))})`,
      detail: `Spearman correlation of daily (price - 1) with the daily log supply change at the best lag within +/-${ll.maxLag} days; the null is every circular shift of the flow series (${ll.nullSize} shifts), which keeps both series' autocorrelation; p=${F.pval(ll.p)}.`,
      evidence: { metric: 'rank correlation of (price - 1) with later log supply change', value: ll.rho, baseline: 0, window: 'full history', stat: 'exact circular-shift permutation p' },
      group: `peg.flow_coupling|${a.key}`, asOf: last(s.t),
    }));
  }
  return out;
}

// Gold tokens: premium to spot gold (price in XAU - 1) and to other large tokenized-gold assets
// (median of the discovered references each hour/day). Level tests with an effective-sample floor.
function goldTracking(model, opts) {
  const out = [];
  for (const a of liveAssets(model, opts, (x) => x.kind === 'gold')) {
    const sup = grid(a.supply), px = priceOf(a) || 0, mcap = sup ? last(sup.v) * px : a.cg ? a.cg.market_cap : null;
    const add = (variant, s, x, hist, label, ref, extra) => {
      const r = S.levelTest(x, hist, 'two');
      if (!r) return;
      const depth = S.recordDepth(s.v);
      const rich = x >= r.baseline;
      out.push(mk({
        detector: 'peg.gold_tracking', dimension: 'peg', asset: a.key, metric: 'premium_vs_' + variant, variant, window: 'level',
        direction: Math.sign(Math.abs(x) - Math.abs(r.baseline)), good: -1, value: x, baseline: r.baseline, materialityUsd: isNum(mcap) ? Math.abs(x) * mcap : null, stat: statOf(r),
        facts: { variant, ref: label, refs: extra.refs || [], premium: x, usual: r.baseline, days: r.n, record: recFact(levelRec(s, depth, rich), rich ? 'richest' : 'cheapest') },
        headline: `${a.key} trades at ${F.sbp(x)} vs ${label} (median ${F.sbp(r.baseline)} over ${r.n} ${extra.unit}${clause(depth ? levelWords(s, depth, rich, ['richest', 'cheapest']) : null, '; ')})`,
        detail: `Percentile ${F.beat(r.pct)} of its own history; robust z ${F.fixed(r.z, 1)}; effective sample ${r.nEff} of ${r.n}. ${ref}${extra.note || ''}`,
        evidence: { metric: 'premium vs ' + label, value: x, baseline: r.baseline, window: r.n + ' ' + extra.unit, stat: 'two-sided empirical p, floored at 2/(effective n + 1)' },
        group: `peg.gold_tracking|${a.key}|${variant}`, asOf: last(s.t), series: extra.daily ? s : null,
      }));
    };
    const xau = cutS(grid(a.xauDaily), opts.cut);
    if (xau && xau.v.length >= NATIVE.month) {
      const prem = { t: xau.t, v: xau.v.map((v) => (isNum(v) ? v - 1 : null)) };
      add('spot', prem, last(prem.v), prem.v.slice(0, -1), 'spot gold', 'Spot gold does not trade at weekends while the token does; weekend prints are part of the baseline.', { unit: 'days', daily: true });
    }
    const refs = (model.goldRefs || []).filter((g) => g && g.geckoId !== a.geckoId);
    const names = F.list(refs.map((g) => g.symbol || g.name));
    const own = cutS(grid(pegPrice(a)), opts.cut);
    const refD = refs.map((g) => grid(g.daily)).filter(Boolean);
    if (own && refD.length) {
      const v = own.t.map((t, i) => { const rs = refD.map((g) => at(g, t)).filter((x) => x > 0); return isNum(own.v[i]) && rs.length ? own.v[i] / S.median(rs) - 1 : null; });
      // Latest hourly reading against the same references, for the detail line only.
      const asOf = isNum(opts.now) ? opts.now - (opts.cut || 0) * DAY : null, cur = (h) => (hourlyFresh(h, asOf) ? h : null);
      const hr = cur(cutH(a.hourly, opts.cut)), hm = new Map();
      for (const g of refs) for (const q of cur(cutH(g.hourly, opts.cut)) || []) { const k = Math.round(q.t / 3600); (hm.get(k) || hm.set(k, []).get(k)).push(q.p); }
      const hp = (hr || []).map((q) => { const k = Math.round(q.t / 3600); return hm.has(k) ? { t: q.t, v: q.p / S.median(hm.get(k)) - 1 } : null; }).filter(Boolean);
      const hTxt = hp.length > 1 ? ` Latest hour (${F.dateTime(last(hp).t)}): ${F.sbp(last(hp).v)}, percentile ${F.beat(S.percentileRank(last(hp).v, hp.slice(0, -1).map((q) => q.v)))} of the previous ${hp.length - 1} hours.` : '';
      if (v.filter(isNum).length >= 2 * NATIVE.month && isNum(last(v))) add('refs', { t: own.t, v }, last(v), v.slice(0, -1), names, `Reference = median daily price of ${names}.${hTxt}`, { unit: 'days', daily: true, refs: refs.map((g) => g.symbol || g.name).filter(Boolean) });
    }
  }
  return out;
}

// ======================= DEFI =======================

function defiUtilization(model, opts) {
  const out = [];
  if (opts.cut || !model.lendBorrow || !model.pools) return out;
  const poolById = cached(model, 'poolById', () => new Map(model.pools.map((p) => [p.pool, p])));
  const seen = new Set();
  // Rows repeating one market's supply/borrow (e.g. per-position rows of one collateral pool) count once.
  const rows = model.lendBorrow.map((r) => ({ ...r, meta: poolById.get(r.pool) }))
    .filter((r) => r.meta && r.meta.stablecoin && r.totalSupplyUsd > 0 && r.totalBorrowUsd >= 0 && r.borrowable !== false)
    .filter((r) => { const k = [r.meta.project, r.meta.chain, r.meta.symbol, Math.round(r.totalSupplyUsd), Math.round(r.totalBorrowUsd)].join('|'); return seen.has(k) ? false : seen.add(k); });
  const util = rows.map((r) => r.totalBorrowUsd / r.totalSupplyUsd), w = rows.map((r) => r.totalSupplyUsd), W = S.sum(w);
  rows.forEach((r, i) => {
    const key = poolAssets(model, r.meta).find((k) => want(opts, k) && live(model.assets.find((a) => a.key === k)));
    if (!key) return;
    const u = util[i], chain = displayChain(model, r.meta.chain);
    const others = util.filter((_, j) => j !== i);
    const p = S.empiricalP(u, others, 'upper'); // market-count p: a tiny market cannot dominate
    const tight = S.sum(w.filter((_, j) => util[j] >= u)) / W;
    out.push(mk({
      detector: 'defi.utilization', dimension: 'defi', asset: key, chain, metric: 'lending_utilization', window: 'now',
      direction: +1, good: -1, value: u, baseline: S.median(util), materialityUsd: r.totalSupplyUsd, stat: { p, minP: S.minEmpiricalP(others.length, 'upper'), n: others.length, weightedShareAsTight: tight },
      drivers: [{ asset: key, chain, usd: r.totalBorrowUsd }],
      facts: { project: r.meta.project, symbol: r.meta.symbol, chain, poolMeta: r.meta.poolMeta || null, utilization: u, borrowUsd: r.totalBorrowUsd, supplyUsd: r.totalSupplyUsd, beat: S.percentileRank(u, others), of: others.length, median: S.median(util) },
      headline: `${r.meta.project} ${r.meta.symbol}${r.meta.poolMeta ? ' (' + r.meta.poolMeta + ')' : ''} on ${chain} is ${F.share(u)} utilised (${F.usd(r.totalBorrowUsd)} of ${F.usd(r.totalSupplyUsd)} borrowed); tighter than ${F.beat(S.percentileRank(u, others))} of ${others.length} other stablecoin lending markets`,
      detail: `Peer set: ${rows.length} deduplicated stablecoin lending markets on DefiLlama yields; ${F.share(tight)} of their supplied dollars are at least this utilised. Borrow APY ${isNum(r.apyBaseBorrow) ? r.apyBaseBorrow.toFixed(2) + '%' : 'n/a'}; supply APY ${isNum(r.meta.apy) ? r.meta.apy.toFixed(2) + '%' : 'n/a'}. High utilisation limits instant withdrawals from this market.`,
      evidence: { metric: 'totalBorrowUsd / totalSupplyUsd', value: u, baseline: S.median(util), window: 'snapshot', stat: 'upper-tail empirical p by market count' },
      group: `defi.utilization|${key}|${r.pool}`, asOf: null,
    }));
  });
  return out;
}

function defiYieldOutlier(model, opts) {
  const out = [];
  if (opts.cut || !model.pools) return out;
  const stable = cached(model, 'stablePools', () => model.pools.filter((q) => q.stablecoin && q.exposure === 'single' && q.tvlUsd > 0 && isNum(q.apy)));
  for (const [key, pools] of Object.entries(paxosPools(model))) {
    if (!want(opts, key) || !live(model.assets.find((a) => a.key === key))) continue;
    // Like-for-like: only pools the yields API itself marks as stablecoin pools are compared with
    // stablecoin peers; rows repeating one market (same project/chain/symbol/TVL/APY) count once.
    const seen = new Set();
    for (const p of pools.filter((q) => q.stablecoin && q.exposure === 'single' && isNum(q.apy))) {
      const k = [p.project, p.chain, p.symbol, p.poolMeta, Math.round(p.tvlUsd), p.apy].join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      const peers = stable.filter((q) => q.chain === p.chain && q.pool !== p.pool);
      if (peers.length < 2) continue;
      const vals = peers.map((q) => q.apy), wp = S.weightedPercentileRank(p.apy, vals, peers.map((q) => q.tvlUsd));
      const pv = S.empiricalP(p.apy, vals, 'two'), chain = displayChain(model, p.chain); // pool-count p
      out.push(mk({
        detector: 'defi.yield_outlier', dimension: 'defi', asset: key, chain, metric: 'supply_apy_vs_chain_peers', window: 'now',
        direction: Math.sign(p.apy - S.median(vals)), good: 0, value: p.apy, baseline: S.median(vals), materialityUsd: p.tvlUsd, stat: { p: pv, minP: S.minEmpiricalP(vals.length), n: vals.length, weightedPct: wp },
        drivers: [{ asset: key, chain, usd: p.tvlUsd }],
        // Yields as fractions (the API reports percent); beat = share of peer pool dollars below this pool.
        facts: { project: p.project, symbol: p.symbol, chain, poolMeta: p.poolMeta || null, tvlUsd: p.tvlUsd, apy: p.apy / 100, apyReward: isNum(p.apyReward) ? p.apyReward / 100 : null, median: S.median(vals) / 100, beat: wp, of: vals.length },
        headline: `${p.project} ${p.symbol}${p.poolMeta ? ' (' + p.poolMeta + ')' : ''} on ${chain} pays ${p.apy.toFixed(2)}% (${p.apyReward ? F.share(p.apyReward / p.apy, 0) + ' incentives' : 'no incentives'}), ${p.apy >= S.median(vals) ? 'higher' : 'lower'} than ${F.beat(p.apy >= S.median(vals) ? wp : 1 - wp)} of single-asset stablecoin pool dollars on ${chain}`,
        detail: `TVL ${F.usd(p.tvlUsd)}; 30-day APY change ${isNum(p.apyPct30D) ? p.apyPct30D.toFixed(2) + 'pp' : 'n/a'}; peer median ${S.median(vals).toFixed(2)}% across ${vals.length} pools (p by pool count, so a tiny pool cannot dominate).`,
        evidence: { metric: 'pool APY', value: p.apy, baseline: S.median(vals), window: 'snapshot', stat: 'two-sided empirical p by pool count' },
        group: `defi.yield_outlier|${key}|${p.pool}`, asOf: null,
      }));
    }
  }
  return out;
}

function defiFootprint(model, opts) {
  const out = [];
  if (opts.cut || !model.pools) return out;
  for (const [key, pools] of Object.entries(paxosPools(model))) {
    const a = model.assets.find((x) => x.key === key);
    if (!want(opts, key) || !live(a)) continue;
    const tvl = S.sum(pools.map((p) => p.tvlUsd || 0)), sup = grid(a.supplyUsd), supplyUsd = sup ? last(sup.v) : a.cg ? a.cg.market_cap : null;
    const effN = S.effectiveN(pools.map((p) => p.tvlUsd)), reward = tvl ? S.sum(pools.map((p) => (p.tvlUsd || 0) * (isNum(p.apyReward) && p.apy ? p.apyReward / p.apy : 0))) / tvl : null;
    const top = pools.slice().sort((x, y) => y.tvlUsd - x.tvlUsd).slice(0, 3);
    // Pools holding the same tokens on the same chain as a larger listed pool: either separate pools
    // (fee tiers, other DEXs) or wrappers that stake the larger pool's LP tokens (counted twice). The
    // yields data does not say which, so the total is an upper bound and this is how much it may repeat.
    const pairKey = (q) => displayChain(model, q.chain) + '|' + (q.underlyingTokens || []).map((x) => String(normAddr(x))).sort().join(',');
    const groups = new Map();
    for (const q of pools.filter((x) => x.exposure !== 'single' && (x.underlyingTokens || []).length > 1)) (groups.get(pairKey(q)) || groups.set(pairKey(q), []).get(pairKey(q))).push(q.tvlUsd || 0);
    const shared = S.sum([...groups.values()].map((v) => S.sum(v) - Math.max(...v)));
    out.push(mk({
      detector: 'defi.footprint', dimension: 'defi', asset: key, metric: 'defi_footprint', window: 'now', direction: 0, good: 0,
      value: supplyUsd ? tvl / supplyUsd : null, baseline: null, materialityUsd: tvl, stat: { p: 1, minP: 1, n: pools.length, effectivePools: effN, rewardShare: reward, sharedPairUsd: shared }, context: true,
      facts: { tvlUsd: tvl, share: supplyUsd ? tvl / supplyUsd : null, pools: pools.length, effective: effN, rewardShare: reward, sharedUsd: shared },
      headline: `${key} DeFi footprint: ${F.usd(tvl)} across ${pools.length} pools (${supplyUsd ? F.share(tvl / supplyUsd, 0) + ' of supply, an upper bound' : 'n/a'}); ${F.fixed(effN, 1)} effective pools; ${F.share(reward, 0)} of TVL-weighted yield is incentives`,
      detail: 'Largest: ' + top.map((p) => `${p.project} ${p.symbol} on ${displayChain(model, p.chain)} ${F.usd(p.tvlUsd)}`).join('; ') + `. Pair pools count in full for each matched asset. ${F.usd(shared)} sits in pair pools that hold the same tokens on the same chain as a larger listed pool: separate pools, or vaults staking that pool's LP tokens and so counted twice (the yields data does not say which).`,
      evidence: { metric: 'sum(pool TVL) / supply', value: supplyUsd ? tvl / supplyUsd : null, baseline: null, window: 'snapshot', stat: 'context (no history)' },
      group: `defi.footprint|${key}`, asOf: null,
    }));
  }
  return out;
}

// Pool TVL histories (yields chart) for the top pools by TVL.
function poolSeries(model) {
  return cached(model, 'poolSeries', () => {
    const meta = cached(model, 'poolById', () => new Map((model.pools || []).map((p) => [p.pool, p])));
    const out = [];
    for (const [id, rows] of Object.entries(model.poolCharts || {})) {
      const p = meta.get(id);
      if (!p || !Array.isArray(rows)) continue;
      const pts = rows.map((r) => ({ t: Math.floor(Date.parse(r.timestamp) / 1000), v: r.tvlUsd })).filter((q) => isNum(q.t) && isNum(q.v));
      const m = new Map();
      for (const q of pts) m.set(dayOf(q.t), q.v); // several prints on one day: the last one wins
      const t = [...m.keys()].sort((x, y) => x - y), s = grid({ t, v: t.map((d) => m.get(d)) });
      if (s) out.push({ id, p, s, keys: poolAssets(model, p), chain: displayChain(model, p.chain) });
    }
    return out;
  });
}

function defiTvlTrend(model, opts) {
  const out = [];
  for (const ps of poolSeries(model)) {
    const s = cutS(ps.s, opts.cut);
    if (!s || s.v.length < 16) continue;
    for (const key of ps.keys.filter((k) => want(opts, k) && live(model.assets.find((a) => a.key === k)))) {
      for (const { h, r, i0, i1 } of changeTests(s, 'log', NATIVE_H, 'two', 1)) {
        const delta = s.v[i1] - s.v[i0];
        out.push(mk({
          detector: 'defi.tvl_trend', dimension: 'defi', asset: key, chain: ps.chain, metric: 'pool_tvl_log_change', window: h + 'd', horizon: h,
          direction: Math.sign(r.x), good: 0, value: r.x, baseline: r.baseline, materialityUsd: Math.abs(delta), stat: statOf(r),
          drivers: [{ asset: key, chain: ps.chain, usd: delta }],
          facts: { project: ps.p.project, symbol: ps.p.symbol, chain: ps.chain, poolMeta: ps.p.poolMeta || null, tvlUsd: s.v[i1], usd: delta, pct: Math.expm1(r.x), days: h, usual: Math.expm1(r.baseline), multi: ps.keys.length > 1 || ps.p.exposure !== 'single', record: recFact(sinceRec(s, r), r.x < 0 ? 'drop' : 'rise') },
          headline: `${ps.p.project} ${ps.p.symbol}${ps.p.poolMeta ? ' (' + ps.p.poolMeta + ')' : ''} on ${ps.chain}: TVL ${F.usd(s.v[i1])}, ${F.pct(Math.expm1(r.x))} (${F.susd(delta)}) over ${F.days(h)}${clause(sinceWords(s, r, r.x < 0 ? 'decline' : 'increase'))}`,
          detail: `DefiLlama yields pool history since ${F.date(s.t[0])} (${s.v.length} days); beyond ${F.beat(beyond(r))} of ${r.n} earlier non-overlapping ${h}-day windows.${ps.keys.length > 1 || ps.p.exposure !== 'single' ? ' Multi-asset pool: TVL includes the other tokens.' : ''} Pools are selected by current TVL, which favours pools that grew recently.`,
          evidence: { metric: 'log change of pool TVL', value: r.x, baseline: r.baseline, window: h + 'd', stat: 'two-sided empirical p, floored at 2/(nEff+1)' },
          group: `defi.tvl_trend|${key}|${ps.id}`, asOf: s.t[i1], series: s,
        }));
      }
    }
  }
  return out;
}

// Divergence: do the top single-asset pools grow faster or slower than supply? Spread of log changes
// (pools present at both ends of a window only, so a pool's tracking start is not read as deposits).
function defiDivergence(model, opts) {
  const out = [];
  const agg = aggregate(model);
  const subjects = [];
  for (const a of liveAssets(model, opts, (x) => x.supply)) subjects.push({ key: a.key, keys: [a.key], s: usdFlow(a) || null });
  if (agg && agg.members.length > 1 && want(opts, AGG)) subjects.push({ key: AGG, keys: agg.members, s: { t: agg.t, v: agg.v } });
  const series = poolSeries(model).filter((ps) => ps.p.exposure === 'single' && ps.keys.length === 1);
  for (const sub of subjects) {
    const pools = series.filter((ps) => sub.keys.includes(ps.keys[0]));
    const s = cutS(sub.s, opts.cut);
    if (!pools.length || !s) continue;
    const t0 = Math.min(...pools.map((ps) => ps.s.t[0]));
    const days = s.t.filter((t) => t >= t0), n = days.length;
    if (n < 16) continue;
    const tv = pools.map((ps) => days.map((t) => at(ps.s, t))), sv = days.map((t) => at(s, t));
    const pair = (i, h) => {
      let a0 = 0, a1 = 0;
      for (const v of tv) if (isNum(v[i - h]) && isNum(v[i]) && v[i - h] > 0) { a0 += v[i - h]; a1 += v[i]; }
      return a0 > 0 && a1 > 0 && sv[i - h] > 0 && sv[i] > 0 ? { a0, a1, s0: sv[i - h], s1: sv[i] } : null;
    };
    for (const h of S.horizonLadder(n, NATIVE_H)) {
      const ch = new Array(n).fill(null);
      for (let i = h; i < n; i++) { const q = pair(i, h); if (q) ch[i] = Math.log(q.a1 / q.a0) - Math.log(q.s1 / q.s0); }
      const r = S.windowTest(ch, h), q = pair(n - 1, h);
      if (!r || !q) continue;
      const idio = q.a1 - q.a0 - (q.a0 / q.s0) * (q.s1 - q.s0);
      const daily = (k) => { const out2 = new Array(n).fill(null); for (let i = 1; i < n; i++) { const z = pair(i, 1); if (z) out2[i] = k === 'tvl' ? Math.log(z.a1 / z.a0) : Math.log(z.s1 / z.s0); } return out2; };
      const ll = h === NATIVE.month ? S.leadLag(daily('tvl'), daily('supply')) : null;
      out.push(mk({
        detector: 'defi.divergence', dimension: 'defi', asset: sub.key, metric: 'pool_tvl_vs_supply_spread', window: h + 'd', horizon: h,
        direction: Math.sign(r.x), good: 0, value: r.x, baseline: r.baseline, materialityUsd: Math.abs(idio), stat: statOf(r),
        facts: { poolUsd: q.a1 - q.a0, poolPct: q.a1 / q.a0 - 1, supplyUsd: q.s1 - q.s0, supplyPct: q.s1 / q.s0 - 1, days: h, shareBefore: q.a0 / q.s0, shareAfter: q.a1 / q.s1, pools: pools.length, usual: r.baseline },
        drivers: pools.map((ps) => ({ asset: ps.keys[0], chain: ps.chain, usd: isNum(at(ps.s, days[n - 1])) && isNum(at(ps.s, days[n - 1 - h])) ? at(ps.s, days[n - 1]) - at(ps.s, days[n - 1 - h]) : 0 })).filter((d) => d.usd).sort((x, y) => Math.abs(y.usd) - Math.abs(x.usd)).slice(0, 3),
        headline: `Top single-asset pools holding ${sub.key} moved ${F.susd(q.a1 - q.a0)} (${F.pct(q.a1 / q.a0 - 1)}) over ${F.days(h)} while ${sub.key} supply moved ${F.susd(q.s1 - q.s0)} (${F.pct(q.s1 / q.s0 - 1)}); pooled share of supply ${F.share(q.a0 / q.s0)} -> ${F.share(q.a1 / q.s1)}${clause(sinceWords({ t: days }, r, 'divergence'))}`,
        detail: `Spread = log change of pool TVL minus log change of supply, for the ${pools.length} charted single-asset pools present at both ends of each window; beyond ${F.beat(beyond(r))} of ${r.n} earlier non-overlapping ${h}-day windows. ${F.susd(idio)} of TVL change is not explained by pools keeping their share of supply.${ll ? ` Daily TVL and supply flows: rank correlation ${F.fixed(ll.rho)} at lag ${ll.lag} days (circular-shift p=${F.pval(ll.p)}).` : ''} Pools are selected by current TVL, which favours pools that grew recently.`,
        evidence: { metric: 'log change of pool TVL - log change of supply', value: r.x, baseline: r.baseline, window: h + 'd', stat: 'two-sided empirical p, floored at 2/(nEff+1)' },
        group: `defi.divergence|${sub.key}`, asOf: days[n - 1], series: { t: days, v: days.map((_, i) => { let a1 = 0; for (const v of tv) if (isNum(v[i])) a1 += v[i]; return sv[i] > 0 ? a1 / sv[i] : null; }) },
      }));
    }
  }
  return out;
}

// ======================= USAGE =======================

// Volume / market cap, as non-overlapping 7-day means anchored today (the week removes the weekday
// cycle); today's week vs earlier weeks with an effective-sample floor (turnover regimes persist).
function usageTurnover(model, opts) {
  const out = [], w = NATIVE.week;
  for (const a of liveAssets(model, opts, (x) => x.cgDaily && x.cgDaily.mcap && x.cgDaily.vol)) {
    const mc = cutS(grid(a.cgDaily.mcap), opts.cut), vol = grid(a.cgDaily.vol);
    if (!mc || !vol) continue;
    const to = mc.t.map((t, i) => { const v = at(vol, t); return mc.v[i] > 0 && isNum(v) && v >= 0 ? v / mc.v[i] : null; });
    const wk = [];
    for (let i = to.length - 1; i - w + 1 >= 0; i -= w) { const seg = to.slice(i - w + 1, i + 1); if (seg.every(isNum)) wk.unshift({ t: mc.t[i], v: S.sum(seg) / w }); else wk.unshift({ t: mc.t[i], v: null }); }
    if (wk.length < 8 || !isNum(last(wk).v)) continue;
    const x = last(wk).v, r = S.levelTest(x, wk.slice(0, -1).map((q) => q.v), 'two');
    if (!r) continue;
    // The latest week's average covers its 7 days: a record must predate their first day by a native week.
    const ws = { t: wk.map((q) => q.t), v: wk.map((q) => q.v) }, depth = S.recordDepth(ws.v), hi = x >= r.baseline, wkStart = last(ws.t) - (w - 1) * DAY;
    out.push(mk({
      detector: 'usage.turnover', dimension: 'usage', asset: a.key, metric: 'volume_to_mcap_7d', window: w + 'd avg',
      direction: Math.sign(x - r.baseline), good: 0, value: x, baseline: r.baseline, materialityUsd: Math.abs(x - r.baseline) * last(mc.v), stat: statOf(r),
      facts: { level: x, usual: r.baseline, days: w, record: recFact(levelRec(ws, depth, hi, undefined, undefined, wkStart), hi ? 'highest' : 'lowest') },
      headline: `${a.key} trades ${F.share(x)} of its market cap per day (7-day average) vs a ${F.share(r.baseline)} median week${clause(levelWords(ws, depth, hi, undefined, undefined, undefined, wkStart), '; ')}`,
      detail: `CoinGecko total volume / market cap; percentile ${F.beat(r.pct)} of ${r.n} earlier non-overlapping weeks (effective sample ${r.nEff}). ${F.susd((x - r.baseline) * last(mc.v))} per day of volume above or below the median week.`,
      evidence: { metric: 'volume / market cap (7-day mean)', value: x, baseline: r.baseline, window: w + 'd', stat: 'two-sided empirical p vs earlier weeks, floored at 2/(effective n + 1)' },
      group: `usage.turnover|${a.key}`, asOf: last(mc.t), series: { t: mc.t, v: to },
    }));
  }
  return out;
}

const CM_METRICS = { AdrActCnt: 'active addresses', TxTfrCnt: 'transfers', AdrBalCnt: 'addresses with a balance' };
const CM_FACT = { AdrActCnt: 'activeAddresses', TxTfrCnt: 'transfers', AdrBalCnt: 'holders' };
function cmSeries(rows, metric) {
  return Array.isArray(rows) ? cached(rows, 'cm:' + metric, () => cmSeriesRaw(rows, metric)) : null;
}
function cmSeriesRaw(rows, metric) {
  const t = [], v = [];
  for (const r of rows || []) { const x = Number(r[metric]), d = dayOf(Date.parse(r.time) / 1000); if (Number.isFinite(x) && isNum(d)) { t.push(d); v.push(x); } }
  return grid({ t, v });
}
function usageActivity(model, opts) {
  const out = [], w = NATIVE.week;
  for (const a of liveAssets(model, opts, (x) => x.cm && x.cm.rows && x.cm.rows.length)) {
    for (const [metric, label] of Object.entries(CM_METRICS)) {
      const raw = cutS(cmSeries(a.cm.rows, metric), opts.cut);
      if (!raw) continue;
      const sm = { t: raw.t, v: S.rollingMean(raw.v, w, w) };
      for (const { h, r, i0, i1 } of changeTests(sm, 'log', [NATIVE.week, NATIVE.month]).filter((q) => q.h >= w)) {
        const peers = Object.entries(model.cmPeers || {}).map(([k, rows]) => {
          const ps = cmSeries(rows, metric), a0 = ps && at(ps, sm.t[i0]), a1 = ps && at(ps, sm.t[i1]);
          return `${k} ${a0 > 0 && a1 > 0 ? F.pct(a1 / a0 - 1) : 'n/a'}`;
        });
        out.push(mk({
          detector: 'usage.activity', dimension: 'usage', asset: a.key, metric, window: h + 'd', horizon: h,
          direction: Math.sign(r.x), good: +1, value: r.x, baseline: r.baseline, materialityUsd: null, stat: statOf(r),
          facts: { metric: CM_FACT[metric], chain: a.cm.chain || null, pct: Math.expm1(r.x), days: h, avg: sm.v[i1], usual: Math.expm1(r.baseline), record: recFact(sinceRec(sm, r), r.x < 0 ? 'drop' : 'rise') },
          headline: `${a.key} ${label} (Coin Metrics ${a.cm.key}) ${r.x < 0 ? 'fell' : 'rose'} ${mag(Math.expm1(r.x))} over ${F.days(h)} to a 7-day average of ${F.num(sm.v[i1])}${clause(sinceWords(sm, r, r.x < 0 ? 'drop' : 'rise'))}`,
          detail: `Beyond ${F.beat(beyond(r))} of ${r.n} earlier non-overlapping ${h}-day windows since ${F.date(sm.t[0])}. Peer daily values over the same days (single-day change): ${peers.join(', ') || 'none'}.`,
          evidence: { metric: label + ' (7-day mean), log change', value: r.x, baseline: r.baseline, window: h + 'd', stat: 'two-sided empirical p, floored at 2/(nEff+1)' },
          group: `usage.activity|${a.key}|${metric}`, asOf: sm.t[i1], series: sm,
        }));
      }
    }
  }
  return out;
}

// ======================= PORTFOLIO (Paxos USD) =======================

function portfolioMix(model, opts) {
  const out = [], agg = aggregate(model);
  if (!agg || !want(opts, AGG) || agg.members.length < 2) return out;
  const n = agg.t.length - (opts.cut || 0), keys = agg.members;
  if (n < 16) return out;
  const t = agg.t.slice(0, n);
  const col = (i) => Object.fromEntries(keys.map((k) => [k, agg.parts[k][i]]));
  for (const h of NATIVE_H) {
    if (n < 4 * h) continue;
    const rot = new Array(n).fill(null);
    for (let i = h; i < n; i++) {
      let gross = 0, net = 0, tot = 0;
      for (const k of keys) { const d = agg.parts[k][i] - agg.parts[k][i - h]; gross += Math.abs(d); net += d; tot += agg.parts[k][i]; }
      rot[i] = tot > 0 ? (gross - Math.abs(net)) / 2 < DOLLAR ? 0 : (gross - Math.abs(net)) / 2 / tot : null;
    }
    const r = S.windowTest(rot, h, 'upper');
    if (!r) continue;
    const d = S.decompose(col(n - 1 - h), col(n - 1)), moved = d.parts.filter((p) => p.delta !== 0);
    out.push(mk({
      detector: 'portfolio.mix', dimension: 'portfolio', asset: AGG, metric: 'cross_asset_rotation', window: h + 'd', horizon: h,
      direction: 0, good: 0, value: r.x, baseline: r.baseline, materialityUsd: d.rotation, stat: statOf(r, { drivers: d.drivers }),
      drivers: moved.slice(0, 3).map((p) => ({ asset: p.key, chain: null, usd: p.delta })),
      facts: { offsetUsd: d.rotation, netUsd: d.net, days: h, share: r.x, usual: r.baseline, moves: moved.map((p) => ({ asset: p.key, usd: p.delta })) },
      headline: `${F.usd(d.rotation)} of offsetting moves across the active Paxos USD stablecoins over ${F.days(h)} (${F.share(r.x, 2)} of supply): ${moved.slice(0, 3).map((p) => `${p.key} ${F.susd(p.delta)}`).join(', ')}; net ${F.susd(d.net)}`,
      detail: `Offsetting moves = (sum of |asset change| - |net change|)/2: issuance in some assets matched by redemptions in others; no conversion between them is observed. Mix ${d.parts.slice(0, 4).map((p) => `${p.key} ${F.share(p.sharePrev)} -> ${F.share(p.shareCurr)}`).join(', ')}. Higher than ${F.beat(r.pct)} of ${r.n} earlier non-overlapping ${h}-day windows.`,
      evidence: { metric: 'offsetting moves across assets / Paxos USD supply', value: r.x, baseline: r.baseline, window: h + 'd', stat: 'upper-tail empirical p, floored at 1/(nEff+1)' },
      group: 'portfolio.mix|' + AGG, asOf: t[n - 1], series: { t, v: agg.v.slice(0, n) },
    }));
  }
  return out;
}

// Lead of the largest over the second-largest active Paxos USD stablecoin, tested as a change (the lead is a level
// and persists, so "narrowest since" is wording, not the p-value).
function portfolioLeadership(model, opts) {
  const out = [], agg = aggregate(model);
  if (!agg || !want(opts, AGG) || agg.members.length < 2) return out;
  const n = agg.t.length - (opts.cut || 0);
  if (n < 16) return out;
  const [A, B] = agg.members.slice().sort((x, y) => agg.parts[y][n - 1] - agg.parts[x][n - 1]);
  const first = agg.t.findIndex((_, i) => agg.parts[A][i] > 0 && agg.parts[B][i] > 0);
  if (first < 0 || n - first < 16) return out;
  const lead = { t: agg.t.slice(first, n), v: agg.t.slice(first, n).map((_, j) => agg.parts[A][first + j] - agg.parts[B][first + j]) };
  const depth = S.recordDepth(lead.v);
  let cross = null;
  for (let j = lead.v.length - 1; j > 0; j--) if (Math.sign(lead.v[j]) !== Math.sign(lead.v[j - 1])) { cross = j; break; }
  for (const { h, r, i0, i1 } of changeTests(lead, 'diff')) {
    const dA = agg.parts[A][first + i1] - agg.parts[A][first + i0], dB = agg.parts[B][first + i1] - agg.parts[B][first + i0];
    out.push(mk({
      detector: 'portfolio.leadership', dimension: 'portfolio', asset: AGG, metric: 'lead_of_largest_asset', window: h + 'd', horizon: h,
      direction: Math.sign(r.x), good: 0, value: lead.v[i1], baseline: lead.v[i0], materialityUsd: Math.abs(r.x), stat: statOf(r),
      drivers: [{ asset: A, chain: null, usd: dA }, { asset: B, chain: null, usd: dB }].sort((x, y) => Math.abs(y.usd) - Math.abs(x.usd)),
      // largerSince: the day the leader last became the larger (overlapStart: the start of the overlap).
      facts: { leader: A, other: B, leadUsd: lead.v[i1], leadBefore: lead.v[i0], days: h, usual: r.baseline, leaderUsd: dA, otherUsd: dB, largerSince: F.date(lead.t[cross === null ? 0 : cross]), overlapStart: cross === null, record: recFact(levelRec(lead, depth, r.x >= 0, i0, r.x), r.x >= 0 ? 'widest' : 'narrowest') },
      headline: `${A} leads ${B} by ${F.usd(lead.v[i1])} (${F.usd(lead.v[i0])} ${F.ago(h)}; ${A} ${F.susd(dA)}, ${B} ${F.susd(dB)}); ${A} has been the larger since ${cross === null ? F.date(lead.t[0]) + ', the start of the overlap' : F.date(lead.t[cross])}${clause(levelWords(lead, depth, r.x >= 0, ['widest', 'narrowest'], i0, r.x), '; the lead is the ')}`,
      detail: `Change in the lead beyond ${F.beat(beyond(r))} of ${r.n} earlier non-overlapping ${h}-day windows (median ${F.susd(r.baseline)}).`,
      evidence: { metric: `${A} - ${B} supply (USD), change`, value: r.x, baseline: r.baseline, window: h + 'd', stat: 'two-sided empirical p, floored at 2/(nEff+1)' },
      group: `portfolio.leadership|${AGG}|${A}|${B}`, asOf: lead.t[i1], series: lead,
    }));
  }
  return out;
}

// ======================= ECONOMICS (Paxos USD) =======================

// DefiLlama's fee model = modelled supply x T-bill rate / 365. The day alignment between fee labels and
// supply labels is the lag that makes the implied rate smoothest (median |day-to-day change|).
function feeModel(model) {
  return cached(model, 'feeModel', () => {
    const f0 = model.fees && grid(model.fees.series);
    if (!f0) return null;
    let end = f0.v.length;
    while (end > 0 && f0.v[end - 1] === 0) end--; // an incomplete trailing day is reported as 0
    const f = { t: f0.t.slice(0, end), v: f0.v.slice(0, end) };
    const mem = model.assets.filter((a) => a.feeModelled && (a.supplyUsd || a.supply)).map((a) => grid(a.supplyUsd || a.supply)).filter(Boolean);
    if (!mem.length || f.t.length < 2 * NATIVE.month) return null;
    const baseAt = (lag) => f.t.map((t) => { let s = 0, ok = false; for (const g of mem) { const x = at(g, t + lag * DAY); if (isNum(x)) { s += x; ok = true; } } return ok ? s : null; });
    let lag = 0, rough = Infinity;
    for (let L = -NATIVE.week; L <= NATIVE.week; L++) {
      const b = baseAt(L), r = f.v.map((v, i) => (b[i] > 0 && isNum(v) ? v / b[i] : null)).slice(-YEAR), d = [];
      for (let i = 1; i < r.length; i++) if (isNum(r[i]) && isNum(r[i - 1])) d.push(Math.abs(r[i] - r[i - 1]));
      const md = d.length ? S.median(d) : null;
      if (md !== null && md < rough) { rough = md; lag = L; }
    }
    const base = baseAt(lag);
    return { f, base, lag, rough, rate: f.v.map((v, i) => (base[i] > 0 && v > 0 ? (v * YEAR) / base[i] : null)), members: model.assets.filter((a) => a.feeModelled).map((a) => a.key) };
  });
}

function reserveIncome(model, opts) {
  const out = [], fm = feeModel(model);
  if (!fm || !want(opts, AGG)) return out;
  const f = cutS(fm.f, opts.cut), n = f ? f.v.length : 0;
  if (n < 16) return out;
  const rate = fm.rate.slice(0, n), base = fm.base.slice(0, n);
  for (const h of [NATIVE.month, YEAR]) {
    if (n < 4 * h) continue;
    const r = S.windowTest(S.changes(f.v, h, 'log'), h);
    if (!r || !isNum(rate[n - 1]) || !isNum(rate[n - 1 - h])) continue;
    const dc = S.productDecomposition(rate[n - 1 - h] / YEAR, base[n - 1 - h], rate[n - 1] / YEAR, base[n - 1]);
    // In supply-equivalent dollars: the supply change that would move income as much at today's rate.
    const supplyEq = Math.abs(f.v[n - 1] - f.v[n - 1 - h]) * YEAR / rate[n - 1];
    out.push(mk({
      detector: 'economics.reserve_income', dimension: 'economics', asset: AGG, metric: 'modelled_reserve_income', window: h + 'd', horizon: h,
      direction: Math.sign(r.x), good: +1, value: f.v[n - 1], baseline: f.v[n - 1 - h], materialityUsd: supplyEq, stat: statOf(r),
      facts: { perDay: f.v[n - 1], perDayBefore: f.v[n - 1 - h], pct: f.v[n - 1] / f.v[n - 1 - h] - 1, days: h, usual: Math.expm1(r.baseline), rateEffect: dc.rateEffect, supplyEffect: dc.baseEffect, yield: rate[n - 1] },
      headline: `Modelled Paxos reserve income ${F.usd(f.v[n - 1])}/day (${F.pct(f.v[n - 1] / f.v[n - 1 - h] - 1)} over ${F.days(h)}): rate effect ${F.susd(dc.rateEffect)}/day, supply effect ${F.susd(dc.baseEffect)}/day`,
      detail: `Implied yield ${F.share(rate[n - 1], 2)} on ${F.date(f.t[n - 1])} vs ${F.share(rate[n - 1 - h], 2)} on ${F.date(f.t[n - 1 - h])}, on a ${F.usd(base[n - 1])} modelled base (${F.list(fm.members)}). Fee day D aligns with supply day D${fm.lag >= 0 ? '+' : ''}${fm.lag} (median day-to-day rate change ${F.bp(fm.rough * YEAR, 2)}). DefiLlama models fees as supply x 3-month T-bill yield; an estimate, not reported financials.`,
      evidence: { metric: 'log change of modelled daily fees', value: r.x, baseline: r.baseline, window: h + 'd', stat: 'two-sided empirical p, floored at 2/(nEff+1); rate x base decomposition' },
      group: 'economics.reserve_income|' + AGG, asOf: f.t[n - 1], series: f,
    }));
  }
  return out;
}

function rateRegime(model, opts) {
  const out = [], fm = feeModel(model);
  if (!fm || !want(opts, AGG)) return out;
  const n = fm.f.t.length - (opts.cut || 0);
  const idx = [];
  for (let i = 0; i < n; i++) if (isNum(fm.rate[i])) idx.push(i);
  const b = fm.base[idx[idx.length - 1]];
  for (const cp of S.regimeChain(idx.map((i) => fm.rate[i]), 8)) {
    const t0 = fm.f.t[idx[cp.index]];
    out.push(mk({
      detector: 'economics.rate_regime', dimension: 'economics', asset: AGG, metric: 'implied_reserve_yield_regime', window: 'since ' + F.date(t0), eventKey: 'week-' + weekKey(t0),
      direction: Math.sign(cp.after.median - cp.before.median), good: +1, value: cp.after.median, baseline: cp.before.median,
      // Supply-equivalent dollars: |rate change| / rate x base.
      materialityUsd: cp.after.median > 0 ? (Math.abs(cp.after.median - cp.before.median) / cp.after.median) * b : null,
      stat: { p: cp.p, minP: cp.minP, n: idx.length, nEff: Math.round(cp.nEff), persistence: cp.r }, ageDays: Math.round((fm.f.t[n - 1] - t0) / DAY),
      facts: { since: F.date(t0), before: cp.before.median, after: cp.after.median },
      headline: `Implied reserve yield of the modelled Paxos base changed regime on ${F.date(t0)}: ${F.share(cp.before.median, 2)} -> ${F.share(cp.after.median, 2)}`,
      detail: `Rank-CUSUM binary segmentation of fees x 365 / modelled supply since ${F.date(fm.f.t[idx[cp.segStart]])}; this split has p=${F.pval(cp.p)} against a null that keeps the yield's own persistence (lag-1 ${F.fixed(cp.r, 3)}, effective sample ${Math.round(cp.nEff)}).`,
      evidence: { metric: 'implied yield = fees x 365 / modelled supply', value: cp.after.median, baseline: cp.before.median, window: F.date(t0) + '..' + F.date(fm.f.t[n - 1]), stat: 'rank CUSUM, AR(1)-sieve null with the series\' own persistence' },
      group: 'economics.rate_regime|' + AGG, asOf: fm.f.t[n - 1], series: { t: fm.f.t.slice(0, n), v: fm.rate.slice(0, n) }, preferLatest: true,
    }));
  }
  return out;
}

// ======================= DATA QUALITY =======================
// Data-quality findings describe the data, not the asset: they are neutral (good = 0), stay in the data
// dimension and never colour an asset's supply, peg or market cell.

// Is a series overdue? A daily label is complete at the next 00:00, so a daily series is on schedule
// while its last label is no older than the last completed day. The overdue time is compared with the
// gaps between prints of EVERY series of the same feed in the model (all assets, peg peers and gold
// references, Coin Metrics peers): a long-run gap distribution that does not shrink with the asset's
// own fetch window, so a feed that went quiet stays flagged, even when the window holds 0 to 2 prints.
// Materiality = the flow the stale data can hide: the asset's ordinary daily flow (its floor) times the
// days overdue, so a feed must be at least a day late to matter (an hourly feed an hour late does not).
const feedKind = (s) => String(s || '').split(':')[0] || 'unknown';
function freshness(model, opts) {
  const out = [];
  if (opts.cut || !isNum(opts.now)) return out;
  const now = opts.now, srcs = [], refs = [], fl = floors(model);
  const add = (list, kind, label, t, a, extra = {}) => list.push({ kind, label, t: (t || []).filter(isNum), a, ...extra });
  for (const a of model.assets.filter(live)) {
    const mine = want(opts, a.key) ? srcs : refs;
    if (a.supply) add(mine, 'supply:' + feedKind(a.supplySource), `${a.key} supply (${a.supplySource || 'n/a'})`, a.supply.t, a);
    if (a.hourly && a.hourly.length) add(mine, 'hourly', `${a.key} hourly price`, a.hourly.map((x) => x.t), a);
    // Daily coin prices arrive but the hourly window is empty: the hourly feed stopped before it.
    else if (a.priceLlamaDaily && a.priceLlamaDaily.t.length) add(mine, 'hourly', `${a.key} hourly price`, [], a, { empty: true });
    if (a.cm && a.cm.rows && a.cm.rows.length) add(mine, 'cm', `${a.key} Coin Metrics (${a.cm.key})`, a.cm.rows.map((r) => Date.parse(r.time) / 1000), a);
    if (a.cgDaily && a.cgDaily.mcap) add(mine, 'cgDaily', `${a.key} CoinGecko daily market data`, a.cgDaily.mcap.t, a);
  }
  for (const r of [...(model.pegPeers || []), ...(model.goldRefs || [])]) if (r && r.hourly && r.hourly.length) add(refs, 'hourly', `${r.symbol} hourly price`, r.hourly.map((x) => x.t), null);
  for (const rows of Object.values(model.cmPeers || {})) if (Array.isArray(rows)) add(refs, 'cm', 'peer', rows.map((r) => Date.parse(r.time) / 1000), null);
  if (model.fees && model.fees.series && want(opts, AGG)) add(srcs, 'fees', 'Paxos fee model (DefiLlama)', model.fees.series.t, null);
  // Per feed kind: gaps beyond each series' own cadence, pooled; the kind's typical cadence; window start.
  const kinds = new Map();
  for (const x of srcs.concat(refs)) {
    const k = kinds.get(x.kind) || kinds.set(x.kind, { excess: [], cadences: [], start: Infinity }).get(x.kind);
    if (x.t.length) k.start = Math.min(k.start, x.t[0]);
    if (x.t.length < 3) continue;
    const gaps = x.t.slice(1).map((t, i) => t - x.t[i]), cad = S.median(gaps);
    k.cadences.push(cad);
    for (const g of gaps) k.excess.push(g - cad);
  }
  for (const x of srcs) {
    const k = kinds.get(x.kind), own = x.t.length >= 3 ? S.median(x.t.slice(1).map((t, i) => t - x.t[i])) : null;
    const cadence = own !== null ? own : k.cadences.length ? S.median(k.cadences) : null;
    if (!isNum(cadence) || !k.excess.length) continue;
    // With no print in the window the last print is before the window start: a lower bound.
    const lastT = x.t.length ? last(x.t) : isNum(k.start) && k.start !== Infinity ? k.start : null;
    if (lastT === null) continue;
    const due = cadence >= DAY ? dayOf(now) - DAY : now - cadence, overdue = due - lastT;
    const p = overdue <= 0 ? 1 : S.empiricalP(overdue, k.excess, 'upper'), longer = k.excess.filter((g) => g < overdue).length;
    const asset = x.a ? x.a.key : AGG, ageTxt = overdue >= DAY ? F.days(Math.round(overdue / DAY)) : Math.round(overdue / 3600) + 'h';
    const cadTxt = cadence >= DAY ? F.days(Math.round(cadence / DAY)) : Math.round(cadence / 60) + ' min';
    const vsGaps = longer === k.excess.length ? `longer than all ${k.excess.length} gaps between prints in this feed's series` : `longer than ${F.beat(longer / k.excess.length)} of ${k.excess.length} gaps between prints in this feed's series`;
    out.push(mk({
      detector: 'dq.freshness', dimension: 'data', asset, metric: 'staleness', variant: x.label, window: 'now',
      direction: -1, good: 0, value: overdue, baseline: cadence, materialityUsd: overdue > 0 && isNum(fl[asset]) ? (fl[asset] * overdue) / DAY : 0, stat: { p, minP: S.minEmpiricalP(k.excess.length, 'upper'), n: k.excess.length, points: x.t.length },
      ageDays: Math.max(0, Math.floor(overdue / DAY)), // the condition's own age: a feed dead for a month is a standing condition
      // feed: supply | hourly | cm | cgDaily | fees; source: the supply source's name (supply feeds only).
      facts: { feed: x.kind.split(':')[0], source: x.kind.startsWith('supply:') ? sourceName(x.kind.slice(7)) : null, overdueHours: overdue / 3600, cadenceHours: cadence / 3600, lastAt: F.isoTime(lastT), empty: Boolean(x.empty) },
      headline: overdue <= 0 ? `${x.label} is current (last point ${F.dateTime(lastT)})`
        : x.empty ? `${x.label}: no print since at least ${F.dateTime(lastT)} (${ageTxt}; daily prices continue to ${F.date(last(x.a.priceLlamaDaily.t))}), ${vsGaps}`
          : `${x.label} is ${ageTxt} overdue (last point ${F.dateTime(lastT)}, usual cadence ${cadTxt}); ${vsGaps}`,
      detail: `Overdue time = expected latest label minus actual latest label, compared with the gaps between labels (beyond each series' own cadence) of all ${x.kind.split(':')[0]} series in this snapshot.${x.t.length < 3 ? ` Only ${x.t.length} print${x.t.length === 1 ? '' : 's'} in the fetch window.` : ''}`,
      evidence: { metric: 'expected latest label - actual latest label (s)', value: overdue, baseline: cadence, window: 'now', stat: 'upper-tail empirical p vs the pooled gap distribution of the same feed' },
      group: `dq.freshness|${asset}|${x.label}`, asOf: now,
    }));
  }
  return out;
}

// Price history starts long before supply history: supply-based statements cover only the tracked part.
function historyGap(model, opts) {
  const out = [];
  for (const a of liveAssets(model, opts, (x) => x.supply && isNum(x.firstPriceT))) {
    const s = cutS(grid(a.supply), opts.cut);
    if (!s) continue;
    const gapDays = Math.round((s.t[0] - dayOf(a.firstPriceT)) / DAY);
    if (gapDays <= NATIVE.month) continue;
    const months = Math.floor(gapDays / NATIVE.month);
    // The first tracked supply valued on its own date (USD series), else stated in native units.
    const u = grid(a.supplyUsd), firstUsd = u ? at(u, s.t[0]) : null, isUsd = a.kind === 'usd-stablecoin';
    const firstTxt = isNum(firstUsd) ? `${F.usd(firstUsd)}${isUsd ? '' : ` (${F.num(s.v[0])} tokens at that day's price)`}` : isUsd ? F.usd(s.v[0]) : `${F.num(s.v[0])} tokens (${F.usd(s.v[0] * (priceOf(a) || 0))} at today's price)`;
    out.push(mk({
      detector: 'dq.history_gap', dimension: 'data', asset: a.key, metric: 'supply_history_starts_late', window: F.date(a.firstPriceT) + '..' + F.date(s.t[0]), eventKey: F.date(s.t[0]),
      direction: -1, good: 0, value: gapDays, baseline: 0, materialityUsd: isNum(firstUsd) ? firstUsd : s.v[0] * (priceOf(a) || 1), stat: { p: 1 / (1 + months), minP: 1 / (1 + months), n: null },
      ageDays: Math.round((last(s.t) - s.t[0]) / DAY),
      facts: { date: F.date(s.t[0]), firstPrice: F.date(a.firstPriceT), days: gapDays, usd: isNum(firstUsd) ? firstUsd : null },
      headline: `${a.key} has a market price since ${F.date(a.firstPriceT)} but supply history only from ${F.date(s.t[0])} (${gapDays} days missing; first tracked supply already ${firstTxt})`,
      detail: `All-time-high, drawdown and growth statements for ${a.key} cover only the tracked period (source ${a.supplySource || 'n/a'}).`,
      evidence: { metric: 'days between first price and first supply observation', value: gapDays, baseline: 0, window: 'days', stat: '1/(1 + months missing)' },
      group: `dq.history_gap|${a.key}`, asOf: s.t[0],
    }));
  }
  return out;
}

// Supply source vs CoinGecko supply (CoinGecko supply = market cap / price, daily), in units of an
// ordinary day's net flow. The gap is decomposed per chain with the explorers' on-chain totalSupply:
// each chain's on-chain supply minus the supply source's current value for it (its latest per-chain
// snapshot, asset.current.parts, else the chain series; 0 where it does not track the chain), naming
// the chains whose difference exceeds an ordinary day's flow (smaller ones are timing). Where the
// source's chain value is its minted amount minus supply it counts as bridged out, and chains it counts
// as bridged in (no minted supply of their own) have their own issuer supply controller, the text says
// the subtraction may double count. The on-chain-based total (on-chain where available, the source
// elsewhere) is reported next to both.
const SOURCE_NAMES = { defillama: 'DefiLlama', coinmetrics: 'Coin Metrics', coingecko: 'CoinGecko' };
const sourceName = (s) => SOURCE_NAMES[String(s || '').split(':')[0]] || String(s || 'the supply source');
function crossSource(model, opts) {
  const out = [];
  for (const a of liveAssets(model, opts, (x) => x.supply && x.cgDaily && x.cgDaily.mcap && x.cgDaily.price && !/coingecko/i.test(x.supplySource || ''))) {
    const s = cutS(grid(a.supply), opts.cut), mc = grid(a.cgDaily.mcap), pr = grid(a.cgDaily.price), px = priceOf(a) || 1;
    if (!s || !mc || !pr) continue;
    let k = s.t.length - 1;
    while (k >= 0 && !(at(mc, s.t[k]) > 0 && at(pr, s.t[k]) > 0)) k--;
    if (k < 1 || s.t.length - 1 - k > NATIVE.week) continue;
    const cgSup = at(mc, s.t[k]) / at(pr, s.t[k]), gap = cgSup - s.v[k];
    const flows = S.changes(s.v.slice(0, k + 1), 1, 'diff').filter((x) => isNum(x) && x !== 0).map(Math.abs);
    if (flows.length < 2) continue;
    const p = S.empiricalP(Math.abs(gap), flows, 'upper'), typical = S.median(flows);
    const src = sourceName(a.supplySource), chains = a.chains || {}, byNorm = new Map(Object.keys(chains).map((c) => [normChain(c), c]));
    const have = new Set(byNorm.keys());
    const missing = have.size ? [...new Set((a.addresses || []).map((x) => x.chain).filter((c) => c && !have.has(normChain(c))))] : [];
    // Per-chain decomposition (latest source day vs the explorers' current totalSupply), only while the
    // source's chain panel reaches the tested day.
    const lastOf = (ser) => { const g = cutS(grid(ser), opts.cut); return g && isNum(last(g.v)) ? { t: last(g.t), v: last(g.v) } : null; };
    const parts = !opts.cut && a.current && Array.isArray(a.current.parts) && a.current.parts.some((q) => q && q.chain) ? new Map(a.current.parts.filter((q) => q && q.chain && isNum(q.supply)).map((q) => [normChain(q.chain), q.supply])) : null;
    const srcNow = (name) => (parts ? (parts.has(normChain(name)) ? parts.get(normChain(name)) : null) : chains[name] ? (lastOf(chains[name]) || {}).v : null);
    const rows = opts.cut ? [] : (a.onchain || []).filter((o) => isNum(o.totalSupply)).map((o) => {
      const name = byNorm.get(normChain(o.chain)) || o.chain, c = chains[name], cv = srcNow(name), mv = c && c.minted ? lastOf(c.minted) : null, dv = c ? lastOf(c) : null;
      const bridged = mv && dv && mv.v > dv.v ? mv.v - dv.v : 0;
      return { chain: name, onchain: o.totalSupply, src: isNum(cv) ? cv : 0, tracked: isNum(cv), minted: mv ? mv.v : null, bridged, diff: o.totalSupply - (isNum(cv) ? cv : 0), asOf: o.asOf };
    });
    // Chains the source counts as bridged in (circulating, no minted supply) that have their own issuer
    // supply controller (issuance there is native, so nothing sits in an escrow on the source chain).
    const controlled = new Set(((a.controls && a.controls.supplyControl) || []).map((x) => normChain(x.chain)));
    const bridgedIn = Object.keys(chains).map((c) => { const dv = lastOf(chains[c]), mv = chains[c].minted ? lastOf(chains[c].minted) : null; return { c, v: dv ? dv.v : 0, minted: mv ? mv.v : 0 }; })
      .filter((x) => x.v > 0 && !(x.minted > 0) && controlled.has(normChain(x.c)));
    const explain = rows.filter((r) => Math.abs(r.diff) >= typical).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
    const why = (r) => `${r.chain} ${F.susd(r.diff * px)} (` + (!r.tracked ? `on-chain ${F.usd(r.onchain * px)}, not tracked by ${src}`
      : r.bridged >= typical ? `${src} counts ${F.usd(r.src * px)}: ${F.usd(r.minted * px)} minted minus ${F.usd(r.bridged * px)} it treats as bridged out; on-chain totalSupply ${F.usd(r.onchain * px)}`
        : `on-chain ${F.usd(r.onchain * px)} vs ${src} ${F.usd(r.src * px)}`) + ')';
    const doubleTxt = bridgedIn.length && explain.slice(0, 3).some((r) => r.tracked && r.bridged >= typical)
      ? `; ${F.list(bridgedIn.map((x) => x.c))} (${F.usd(S.sum(bridgedIn.map((x) => x.v)) * px)}) ${bridgedIn.length === 1 ? 'is' : 'are'} counted as bridged in but ${bridgedIn.length === 1 ? 'has its' : 'have their'} own issuer supply controller, so the bridged-out subtraction may double count` : '';
    const covered = new Set(rows.map((r) => normChain(r.chain)));
    const srcChains = parts ? [...parts.keys()].map((k) => byNorm.get(k) || k) : Object.keys(chains);
    const onchainTotal = rows.length ? S.sum(rows.map((r) => r.onchain)) + S.sum(srcChains.filter((c) => !covered.has(normChain(c))).map((c) => srcNow(c) || 0)) : null;
    const missingTxt = missing.filter((c) => !explain.some((r) => normChain(r.chain) === normChain(c)));
    const gapTxt = F.usd(Math.abs(gap) * px) === '$0' ? `${a.key}: CoinGecko and ${src} report the same supply on ${F.date(s.t[k])}` : `${a.key}: CoinGecko supply ${gap > 0 ? 'exceeds' : 'is below'} ${src} by ${F.usd(Math.abs(gap) * px)} (${F.pct(gap / s.v[k], 2)}), ${F.times(Math.abs(gap) / typical)} an ordinary day's net flow`;
    out.push(mk({
      detector: 'dq.cross_source', dimension: 'data', asset: a.key, metric: 'supply_disagreement', window: 'now',
      direction: -1, good: 0, value: gap * px, baseline: typical * px, materialityUsd: Math.abs(gap) * px,
      stat: { p, minP: S.minEmpiricalP(flows.length, 'upper'), n: flows.length, days: Math.abs(gap) / typical, onchainTotalUsd: isNum(onchainTotal) ? onchainTotal * px : null },
      // gapUsd > 0: CoinGecko shows more supply than `other`; flowDays = the gap in typical days' flows.
      facts: { source: 'CoinGecko', other: src, gapUsd: gap * px, gapPct: gap / s.v[k], date: F.date(s.t[k]), flowDays: Math.abs(gap) / typical, typicalUsd: typical * px, chains: explain.slice(0, 3).map((r) => ({ chain: r.chain, usd: r.diff * px })), onchain: rows.length > 0 },
      headline: gapTxt + (explain.length ? `; by chain, on-chain supply explains ${F.list(explain.slice(0, 3).map(why))}` : '') + doubleTxt + (missingTxt.length ? `; ${src} has no chain series for ${F.list(missingTxt)}` : ''),
      detail: `As of ${F.date(s.t[k])}; CoinGecko supply = market cap / price. Day-level supply changes smaller than this gap cannot be told apart from coverage differences between the two sources.${rows.length ? ` On-chain totalSupply (explorers, ${F.dateTime(Date.parse(rows[0].asOf) / 1000)}) per chain minus the ${src} ${parts ? 'latest per-chain snapshot' : `chain values of ${F.date(s.t[k])}`}: ${rows.map((r) => `${r.chain} ${F.susd(r.diff * px)}`).join(', ')}. On-chain where available and ${src} elsewhere: ${F.usd(onchainTotal * px)} (CoinGecko ${F.usd(cgSup * px)}, ${src} ${F.usd(s.v[k] * px)}). Differences below an ordinary day's flow (${F.usd(typical * px)}) are timing.` : ''}`,
      evidence: { metric: `CoinGecko supply - ${src} supply (USD)`, value: gap * px, baseline: typical * px, window: 'latest common day', stat: 'upper-tail empirical p vs |daily net flow|' },
      drivers: null, group: `dq.cross_source|${a.key}`, asOf: s.t[k],
    }));
  }
  return out;
}

// A list price shared verbatim by many assets is a placeholder, not a quote.
function priceSanity(model, opts) {
  const out = [];
  if (opts.cut || !model.list || !model.list.peggedAssets) return out;
  const counts = new Map();
  for (const x of model.list.peggedAssets) if (isNum(x.price)) counts.set(x.price, (counts.get(x.price) || 0) + 1);
  const N = model.list.peggedAssets.length;
  for (const a of liveAssets(model, opts, (x) => x.list)) {
    const c = counts.get(a.list.price), isNull = !isNum(a.list.price);
    if (!isNull && !(c > 1)) continue;
    const cur = a.list.circulating && isNum(a.list.circulating[a.list.pegType]) ? a.list.circulating[a.list.pegType] : 0;
    out.push(mk({
      detector: 'dq.price_sanity', dimension: 'data', asset: a.key, metric: 'placeholder_price', window: 'now', direction: -1, good: 0,
      value: isNull ? null : a.list.price, baseline: null, materialityUsd: cur, stat: { p: isNull ? 1 / N : c / N, minP: 1 / N, n: N },
      facts: { price: isNull ? null : a.list.price, shared: isNull ? null : c, usd: cur },
      headline: isNull ? `${a.key} has no price in the DefiLlama stablecoin list` : `${a.key} list price ${a.list.price} is shared verbatim by ${c} listed assets, a placeholder rather than a quote`,
      detail: 'USD conversions for this asset use the implied daily price where available.',
      evidence: { metric: 'list price', value: isNull ? null : a.list.price, baseline: null, window: 'snapshot', stat: 'frequency of the identical price across the list' },
      group: `dq.price_sanity|${a.key}`, asOf: null,
    }));
  }
  return out;
}

// The list's per-asset values must add up to the chart total of each peg type; the model names the
// culprit of a break (largest one-day jump) and it is kept out of peer comparisons. Reported as context:
// the exclusion is already applied, so the glitch has no effect on any Paxos figure.
function listReconciliation(model, opts) {
  const out = [];
  if (opts.cut || !want(opts, AGG) || !model.listSanity) return out;
  const N = model.list && model.list.peggedAssets ? model.list.peggedAssets.length : 1;
  for (const e of model.listSanity.excluded || []) {
    out.push(mk({
      detector: 'dq.list_reconciliation', dimension: 'data', asset: AGG, metric: 'list_vs_chart_total', window: '1d', direction: -1, good: 0,
      value: e.listSum / e.chartSum, baseline: Math.exp(e.tolerance), materialityUsd: Math.abs(e.jumpUsd), stat: { p: 1, minP: 1, n: N }, context: true, // descriptive: not a test
      facts: { symbol: String(e.symbol || ''), ratio: e.listSum / e.chartSum, jumpUsd: e.jumpUsd, prevUsd: e.prevDay, usd: e.current },
      headline: `DefiLlama list shows ${e.symbol} (${e.pegType}) moving ${F.usd(e.prevDay)} -> ${F.usd(e.current)} in a day; that peg type's list total is ${F.times(e.listSum / e.chartSum)} its chart total, so ${e.symbol} is left out of peer rankings`,
      detail: `The best-reconciled peg type agrees within ${F.share(Math.expm1(e.tolerance), 2)}. Without the exclusion ${e.symbol} would rank above Paxos assets by supply.`,
      evidence: { metric: 'sum(list circulating) / chart total for the peg type', value: e.listSum / e.chartSum, baseline: Math.exp(e.tolerance), window: 'latest', stat: 'accounting identity; culprit = largest one-day jump' },
      group: `dq.list_reconciliation|${e.id}`, asOf: null,
    }));
  }
  return out;
}

// Dead assets the list still values: the figure is frozen.
function frozen(model, opts) {
  const out = [];
  if (opts.cut || !isNum(opts.now)) return out;
  for (const a of model.assets.filter((x) => !live(x) && x.list && want(opts, x.key))) {
    const cur = a.list.circulating && isNum(a.list.circulating[a.list.pegType]) ? a.list.circulating[a.list.pegType] : 0;
    const deadT = typeof a.dead === 'string' ? Date.parse(a.dead) / 1000 : isNum(a.dead) ? a.dead : null;
    const age = isNum(deadT) ? Math.max(0, Math.round((opts.now - deadT) / DAY)) : null;
    const s = grid(a.supply);
    out.push(mk({
      detector: 'dq.frozen', dimension: 'data', asset: a.key, metric: 'dead_asset_still_valued', window: 'since ' + (isNum(deadT) ? F.date(deadT) : 'n/a'), eventKey: isNum(deadT) ? F.date(deadT) : 'dead',
      direction: -1, good: 0, value: cur, baseline: 0, materialityUsd: cur, stat: { p: cur > 0 && age !== null ? 1 / (1 + age) : 1, minP: age !== null ? 1 / (1 + age) : 1, n: null }, ageDays: age,
      facts: { usd: cur, since: isNum(deadT) ? F.date(deadT) : null, days: age },
      headline: `${a.key} is marked dead from ${isNum(deadT) ? F.date(deadT) : 'n/a'} but the DefiLlama list still reports ${F.usd(cur)} circulating (series last updated ${s ? F.date(last(s.t)) : 'n/a'}); it is not part of the active Paxos USD stablecoins total`,
      detail: 'A frozen figure: the dead flag means DefiLlama no longer updates this asset.',
      evidence: { metric: 'list circulating of a dead asset', value: cur, baseline: 0, window: 'since dead date', stat: 'state; p = 1/(1 + days frozen)' },
      group: `dq.frozen|${a.key}`, asOf: s ? last(s.t) : null,
    }));
  }
  return out;
}

// backtest: the detector can be re-run "as of" earlier days (cut) and has no event age of its own.
const DETECTORS = [
  { id: 'supply.move', fn: supplyMove, backtest: true },
  { id: 'supply.drawdown', fn: supplyDrawdown, backtest: true },
  { id: 'supply.streak', fn: supplyStreak, backtest: true },
  { id: 'supply.regime', fn: supplyRegime },
  { id: 'supply.bridged_out', fn: bridgedOut, backtest: true },
  { id: 'market.share', fn: marketShare, backtest: true },
  { id: 'market.peer_growth', fn: peerGrowth },
  { id: 'chain.attribution', fn: chainAttribution, backtest: true },
  { id: 'chain.move', fn: chainMove, backtest: true },
  { id: 'chain.concentration', fn: chainConcentration, backtest: true },
  { id: 'chain.dominance', fn: chainDominance, backtest: true },
  { id: 'chain.lifecycle', fn: chainLifecycle },
  { id: 'peg.deviation', fn: pegDeviation, backtest: true },
  { id: 'peg.regime', fn: pegRegime },
  { id: 'peg.flow_coupling', fn: pegFlowCoupling, backtest: true },
  { id: 'peg.gold_tracking', fn: goldTracking, backtest: true },
  { id: 'defi.utilization', fn: defiUtilization },
  { id: 'defi.yield_outlier', fn: defiYieldOutlier },
  { id: 'defi.footprint', fn: defiFootprint },
  { id: 'defi.tvl_trend', fn: defiTvlTrend, backtest: true },
  { id: 'defi.divergence', fn: defiDivergence, backtest: true },
  { id: 'usage.turnover', fn: usageTurnover, backtest: true },
  { id: 'usage.activity', fn: usageActivity, backtest: true },
  { id: 'portfolio.mix', fn: portfolioMix, backtest: true },
  { id: 'portfolio.leadership', fn: portfolioLeadership, backtest: true },
  { id: 'economics.reserve_income', fn: reserveIncome, backtest: true },
  { id: 'economics.rate_regime', fn: rateRegime },
  { id: 'dq.tracking_change', fn: trackingChange },
  { id: 'dq.freshness', fn: freshness },
  { id: 'dq.history_gap', fn: historyGap },
  { id: 'dq.cross_source', fn: crossSource, backtest: true },
  { id: 'dq.price_sanity', fn: priceSanity },
  { id: 'dq.list_reconciliation', fn: listReconciliation },
  { id: 'dq.frozen', fn: frozen },
];

module.exports = {
  DETECTORS, NATIVE, YEAR, AGG, DAY,
  helpers: { grid, priceOf, usdFlow, aggregate, coverageStart, floors, chainPanel, panelCut, column, flowSupply, live, usdMember, aggMember, cutS, at, feeModel, paxosPools, pegPrice, hourlyFresh, bounded },
};
