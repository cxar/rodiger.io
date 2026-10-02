'use strict';

// Insight engine: runs the detectors, applies the one notability rule (E = m*p < 1 per health dimension),
// dates each finding by re-running only its own detector as of earlier days, collapses windows, ranks by
// Pareto dominance (no weights) and clusters findings that share a root cause.

const { performance } = require('node:perf_hooks');
const S = require('./stats');
const D = require('./detectors');
const C = require('./copy');

const DIMENSIONS = ['supply', 'market', 'chains', 'peg', 'defi', 'usage', 'portfolio', 'economics', 'data'];
const MAX_AGE = Math.max(...Object.values(D.NATIVE)); // longest source-native window (30 d): older = standing
const DEBOUNCE = D.NATIVE.week; // a gap shorter than a native week does not end an episode
const BY_ID = new Map(D.DETECTORS.map((d) => [d.id, d]));

function runDetectors(model, opts, list = D.DETECTORS) {
  const tests = [], errors = [], timings = {};
  for (const d of list) {
    const t0 = performance.now();
    try {
      for (const t of d.fn(model, opts)) { t.source = d.id; tests.push(t); }
    } catch (e) {
      errors.push({ detector: d.id, error: e && e.message ? e.message : String(e), ...(opts.cut ? { cut: opts.cut } : {}), ...(opts.assets ? { assets: [...opts.assets] } : {}) });
    }
    timings[d.id] = (timings[d.id] || 0) + performance.now() - t0;
  }
  return { tests, errors, timings };
}

// Family = one health dimension, pooled across assets; context items are descriptive and not tests.
// (A per-cell family degenerates for cells holding one or two tests, where any p < 1 or p < 1/2 would
// pass.) The family size used is m_eff = max(m_dimension, round(M / D)), M = tests counted in the load,
// D = dimensions with at least one counted test: fewer than one chance finding per dimension per load,
// and no dimension is judged more leniently than an average-sized one (a dimension of 11 tests would
// otherwise pass p < 0.09). A test that cannot reach significance even at its smallest possible p
// (minP * m_eff >= 1) is underpowered: it is reported but not counted, so detectors that can never fire
// do not raise everyone else's threshold. Counting is done in two passes (all tests, then without the
// underpowered ones); a test left out of the count cannot be notable.
const familyOf = (t) => t.dimension;
const minPOf = (t) => (t.stat && S.isNum(t.stat.minP) ? t.stat.minP : t.stat && t.stat.nEff ? 2 / (t.stat.nEff + 1) : t.stat && t.stat.n ? 1 / (t.stat.n + 1) : null);
function effectiveSizes(counted) {
  const mDim = {};
  for (const t of counted) mDim[familyOf(t)] = (mDim[familyOf(t)] || 0) + 1;
  const M = counted.length, D = Object.keys(mDim).length, floor = D ? Math.round(M / D) : 0;
  const mEff = Object.fromEntries(Object.entries(mDim).map(([k, v]) => [k, Math.max(v, floor)]));
  return { M, D, floor, mDim, mEff };
}
// -> { m: { dimension: m_eff }, m1: first-pass sizes (decide what is underpowered), family: {...} }.
// Dimensions whose tests are all underpowered get the average size (floor).
function familySizes(tests) {
  const all = tests.filter((t) => !t.context);
  const pass1 = effectiveSizes(all);
  const size1 = (t) => pass1.mEff[familyOf(t)] || 1;
  const powered = all.filter((t) => { const mp = minPOf(t); return mp === null || mp * size1(t) < 1; });
  const pass2 = effectiveSizes(powered);
  const m = { ...Object.fromEntries(Object.keys(pass1.mDim).map((k) => [k, Math.max(1, pass2.floor)])), ...pass2.mEff };
  const underpowered = {}, kept = new Set(powered);
  for (const t of all) if (!kept.has(t)) underpowered[familyOf(t)] = (underpowered[familyOf(t)] || 0) + 1;
  return { m, m1: pass1.mEff, family: { M: pass2.M, D: pass2.D, floor: pass2.floor, mDim: pass2.mDim, mEff: m, underpowered, testsIncludingUnderpowered: pass1.M } };
}
// E = m_eff*p: expected number of counted tests in the dimension at least this extreme by chance;
// notable iff E < 1. adjustedBits = -log2 E. Underpowered (not counted, never notable): even the
// smallest p the test can produce cannot pass at the first-pass family size. `sizes` is the result of
// familySizes or a plain { dimension: m } map.
function evaluate(tests, sizes) {
  const m = sizes && sizes.m ? sizes.m : sizes || {}, m1 = sizes && sizes.m1 ? sizes.m1 : m;
  for (const t of tests) {
    const p = t.stat && S.isNum(t.stat.p) ? Math.min(1, Math.max(t.stat.p, Number.MIN_VALUE)) : 1;
    t.p = p;
    t.m = m[familyOf(t)] || 1;
    t.E = p * t.m;
    t.surprise = S.surprisalBits(p);
    t.adjustedBits = -Math.log2(Math.max(t.E, Number.MIN_VALUE));
    // An underpowered test is judged at the first-pass size that excluded it, so its E is >= 1 too.
    const minP = minPOf(t), mFirst = Math.max(t.m, m1[familyOf(t)] || 1);
    t.underpowered = minP !== null && minP * mFirst >= 1;
    if (t.underpowered) { t.m = mFirst; t.E = p * t.m; t.adjustedBits = -Math.log2(Math.max(t.E, Number.MIN_VALUE)); }
    t.notable = !t.context && !t.underpowered && t.E < 1;
    t.polarity = !t.good || !t.direction ? 'neutral' : t.direction * t.good > 0 ? 'positive' : 'negative';
  }
}

const materialIn = (floors) => (t) => t.materialityUsd === null || t.materialityUsd === undefined || !S.isNum(floors[t.asset]) || t.materialityUsd >= floors[t.asset];

// One test per group (detector|asset|chain|variant): material+powered > material+underpowered >
// immaterial, then lowest E, then larger materiality. Other windows stay as evidence. Regime chains
// (preferLatest) show the MOST RECENT split that is notable and material, because a later notable split
// supersedes an earlier one even when the earlier one is more surprising; with none, the rule above.
function collapseGroups(tests, isMaterial) {
  const by = new Map();
  const tier = (x) => (isMaterial(x) ? (x.underpowered ? 1 : 2) : 0);
  const live = (x) => x.preferLatest && x.notable && isMaterial(x);
  for (const t of tests) {
    const cur = by.get(t.group);
    const better = !cur || (live(t) || live(cur) ? live(t) && (!live(cur) || t.ageDays < cur.ageDays)
      : tier(t) > tier(cur) || (tier(t) === tier(cur) && (t.E < cur.E || (t.E === cur.E && (t.materialityUsd || 0) > (cur.materialityUsd || 0)))));
    if (better) by.set(t.group, t);
  }
  for (const t of by.values()) t.otherWindows = [];
  for (const t of tests) { const keep = by.get(t.group); if (keep !== t) keep.otherWindows.push({ window: t.window, p: t.p }); }
  return [...by.values()];
}

// Novelty = age of the current firing episode, found without stored state: re-run ONLY the detector
// that produced a notable+material backtestable group, restricted to that asset, as of 1, 2, ... days
// ago, with today's family sizes and floors. The episode ends at the first earlier day from which it
// did not fire for a full native week (7-day debounce: flapping near E = 1 does not restart the age).
function novelty(model, items, sizes, isMaterial, now, detectors = D.DETECTORS) {
  const errors = [], byId = detectors === D.DETECTORS ? BY_ID : new Map(detectors.map((d) => [d.id, d]));
  let reruns = 0;
  const jobs = items.filter((t) => t.notable && isMaterial(t) && byId.get(t.source) && byId.get(t.source).backtest && !S.isNum(t.ageDays));
  const buckets = new Map();
  for (const t of jobs) {
    const k = t.source + '\u0000' + t.asset;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push({ t, key: t.group + '|' + t.direction, lastFired: 0, done: false });
  }
  const perJob = {};
  for (const list of buckets.values()) {
    const { source, asset } = list[0].t, tj = performance.now();
    const det = byId.get(source), opts = { now, assets: new Set([asset]) };
    for (let k = 1; k <= MAX_AGE + DEBOUNCE - 1 && list.some((j) => !j.done); k++) {
      const res = runDetectors(model, { ...opts, cut: k }, [det]);
      reruns++;
      errors.push(...res.errors);
      evaluate(res.tests, sizes);
      const fired = new Set(res.tests.filter((t) => t.notable && isMaterial(t)).map((t) => t.group + '|' + t.direction));
      for (const j of list.filter((x) => !x.done)) {
        if (fired.has(j.key)) j.lastFired = k;
        if (j.lastFired >= MAX_AGE || k - j.lastFired >= DEBOUNCE) j.done = true;
      }
    }
    for (const j of list) j.t.ageDays = Math.min(j.lastFired, MAX_AGE);
    perJob[source + ':' + asset] = Math.round(performance.now() - tj);
  }
  return { errors, jobs: jobs.length, reruns, perJob };
}

// Pareto fronts on (adjusted surprise, materiality share, recency); inside a front by adjusted surprise.
function paretoRank(items) {
  const fronts = S.paretoFronts(items, (t) => [t.adjustedBits, t.materialityShare || 0, -(S.isNum(t.ageDays) ? t.ageDays : 0)]);
  items.forEach((t, i) => { t.front = fronts[i]; });
  return items.slice().sort((a, b) => a.front - b.front || b.adjustedBits - a.adjustedBits || (b.materialityShare || 0) - (a.materialityShare || 0) || (a.id < b.id ? -1 : 1));
}

// Root cause = largest USD driver (asset, chain, sign). Flow-type findings (supply, market, chains,
// portfolio, defi flows) about one asset moving one way also join that asset's card, so "supply fell",
// "share fell", "chain X drove it" and "peers grew faster" read as one event.
const FLOW_DIMS = new Set(['supply', 'market', 'chains', 'portfolio']);
function topDriver(t) {
  return t.drivers && t.drivers.length ? t.drivers.reduce((a, b) => (Math.abs(b.usd) > Math.abs(a.usd) ? b : a)) : null;
}
function rootKey(t) {
  const d = topDriver(t);
  return d ? `${d.asset}|${d.chain || '*'}|${Math.sign(d.usd)}` : `${t.asset}|${t.chain || '*'}|${t.dimension}|${t.direction}`;
}
function flowKey(t) {
  const d = topDriver(t);
  if (d && d.usd && (FLOW_DIMS.has(t.dimension) || t.dimension === 'defi')) return `${d.asset}|${Math.sign(d.usd)}`;
  if (!d && FLOW_DIMS.has(t.dimension) && t.direction) return `${t.asset}|${t.direction}`;
  return null;
}
function cluster(items) {
  const out = [], byRoot = new Map(), byFlow = new Map();
  for (const t of items) {
    const rk = rootKey(t), fk = flowKey(t);
    const c = byRoot.get(rk) || (fk && byFlow.get(fk));
    if (c) { c.related.push(t); continue; }
    const nc = { rootKey: rk, lead: t, related: [] };
    out.push(nc);
    byRoot.set(rk, nc);
    if (fk && !byFlow.has(fk)) byFlow.set(fk, nc);
  }
  return out;
}

function healthGrid(collapsed, assets) {
  const cells = {}, summary = {};
  for (const a of assets) {
    cells[a] = {};
    const counts = { neg: 0, pos: 0, neu: 0, normal: 0, thin: 0, tests: 0, dims: 0 };
    for (const d of DIMENSIONS) {
      const cell = collapsed.filter((t) => t.asset === a && t.dimension === d && !t.context);
      if (!cell.length) { cells[a][d] = { state: 'no_data', tests: 0, notable: 0, negative: 0, positive: 0, evidence: null }; continue; }
      // A dated event (regime change, tracking change, history gap) older than the feed window is history,
      // not current health: it stays a standing condition but does not colour the cell. Measured
      // conditions (levels, deviations, overdue data) count for as long as they stay notable.
      const notable = cell.filter((t) => t.notable && t.material && (t.isNew !== false || !t.eventKey || t.holding));
      const neg = notable.filter((t) => t.polarity === 'negative'), pos = notable.filter((t) => t.polarity === 'positive');
      const top = (neg.length ? neg : pos.length ? pos : notable).slice().sort((x, y) => y.adjustedBits - x.adjustedBits)[0];
      const state = neg.length ? 'notable_negative' : pos.length ? 'notable_positive' : notable.length ? 'notable_neutral' : cell.some((t) => !t.underpowered) ? 'within_own_history' : 'insufficient_history';
      const tests = cell.reduce((s, t) => s + 1 + t.otherWindows.length, 0);
      cells[a][d] = { state, tests, notable: notable.length, negative: neg.length, positive: pos.length, evidence: top ? { id: top.id, headline: top.headline, polarity: top.polarity, p: top.p, E: top.E } : null };
      counts.tests += tests;
      counts.dims++;
      if (state === 'notable_negative') counts.neg++; else if (state === 'notable_positive') counts.pos++; else if (state === 'notable_neutral') counts.neu++; else if (state === 'within_own_history') counts.normal++; else counts.thin++;
    }
    summary[a] = `${counts.tests} checks in ${counts.dims} dimensions: ${counts.neg} notable negative, ${counts.pos} notable positive, ${counts.neu} notable neutral, ${counts.normal} within own history${counts.thin ? ', ' + counts.thin + ' insufficient history' : ''}`;
  }
  return { dimensions: DIMENSIONS, assets, cells, summary };
}

const idOf = (t) => [t.group.replace(/\|/g, ':'), t.eventKey || (t.direction > 0 ? 'up' : t.direction < 0 ? 'down' : 'flat')].join(':').replace(/\s+/g, '_');

function run(model0, opts = {}) {
  const tStart = performance.now(), now = S.isNum(opts.now) ? opts.now : model0.now;
  const model = D.helpers.bounded(model0, now); // drops future-dated points (none in the normal case)
  const floors = D.helpers.floors(model);
  const agg = D.helpers.aggregate(model);
  const paxosUsd = agg ? agg.v[agg.v.length - 1] : null;
  const det = runDetectors(model, { now });
  const tests = det.tests;
  const sizes = familySizes(tests), m = sizes.m;
  evaluate(tests, sizes);
  const isMaterial = materialIn(floors);
  const collapsed = collapseGroups(tests, isMaterial);
  for (const t of collapsed) {
    t.id = idOf(t);
    t.refT = now; // the copy's "current year" (dates in it print as "Sep 11", older ones as "Mar 2023")
    t.material = isMaterial(t);
    t.materialityShare = S.isNum(t.materialityUsd) && paxosUsd ? t.materialityUsd / paxosUsd : null;
    t.materialityFloor = S.isNum(floors[t.asset]) ? floors[t.asset] : null;
  }
  const tDet = performance.now();
  const nov = novelty(model, collapsed, sizes, isMaterial, now);
  const tNov = performance.now();
  for (const t of collapsed) t.isNew = !(S.isNum(t.ageDays) && t.ageDays >= MAX_AGE);
  const notable = collapsed.filter((t) => t.notable && t.material);
  const feed = paretoRank(notable.filter((t) => t.isNew));
  const standing = paretoRank(notable.filter((t) => !t.isNew));
  const watchAll = paretoRank(collapsed.filter((t) => !t.notable && !t.context && t.material && (t.surprise || 0) >= 1));
  const assets = [D.AGG, ...model.assets.map((a) => a.key).filter((k) => k !== D.AGG)];
  return {
    m,
    family: sizes.family,
    testsRun: tests.length,
    groups: collapsed.length,
    errors: det.errors.concat(nov.errors),
    timingsMs: { detectors: Math.round(tDet - tStart), novelty: Math.round(tNov - tDet), total: Math.round(performance.now() - tStart), byDetector: Object.fromEntries(Object.entries(det.timings).map(([k, v]) => [k, Math.round(v * 10) / 10])) },
    novelty: { jobs: nov.jobs, reruns: nov.reruns, maxAgeDays: MAX_AGE, debounceDays: DEBOUNCE, msByJob: nov.perJob },
    clusters: cluster(feed),
    standing,
    // Every watch item in engine order (payload.js keeps the data notes plus the most unusual others).
    watch: watchAll,
    watchTotal: watchAll.length,
    context: collapsed.filter((t) => t.context),
    health: healthGrid(collapsed, assets),
    paxosUsd,
    floors,
    collapsed,
  };
}

const sig = (x, d = 4) => (S.isNum(x) ? Number(x.toPrecision(d)) : null);
const round = (x, d) => (S.isNum(x) ? Number(x.toFixed(d)) : null);
const ISO = (t) => (S.isNum(t) ? new Date(t * 1000).toISOString() : null);
const DATE = (t) => ISO(t) && ISO(t).slice(0, 10);

// Sparkline of the tested series: last <= 120 daily points, gaps carried forward, 4 significant digits.
function sparkline(s) {
  if (!s || !s.t || s.t.length < 2) return undefined;
  const n = s.t.length, from = Math.max(0, n - 120);
  let i = from;
  while (i < n && !S.isNum(s.v[i])) i++;
  if (n - i < 2) return undefined;
  const values = [];
  let prev = null;
  for (let k = i; k < n; k++) { if (S.isNum(s.v[k])) prev = s.v[k]; values.push(sig(prev)); }
  return { start: DATE(s.t[i]), values };
}

// Where a test stands: context (descriptive), watch (not notable, or notable but below the asset's floor),
// new (notable, episode younger than MAX_AGE), ongoing (older, a measured condition still holding, or a
// dated split the detector reports as still holding: a peg widening that is the latest split) or past
// (older, a dated event: eventKey).
function stageOf(t) {
  if (t.context) return 'context';
  if (!t.notable || t.material === false) return 'watch';
  if (t.isNew !== false) return 'new';
  return t.eventKey && !t.holding ? 'past' : 'ongoing';
}
// Episode start: a dated event's own date (facts.since: a regime split or a dead date; facts.date: a
// tracking change or the first supply), else the test's date minus the age of its firing episode.
function sinceOf(t) {
  const f = t.facts || {};
  if (t.eventKey && typeof f.since === 'string') return f.since;
  if (t.eventKey && typeof f.date === 'string') return f.date;
  return S.isNum(t.asOf) && S.isNum(t.ageDays) ? DATE(t.asOf - t.ageDays * D.DAY) : null;
}
// facts for the payload: whole dollars (and other large amounts), 6 significant digits otherwise.
function factsOut(x) {
  if (typeof x === 'number') return !Number.isFinite(x) ? null : Number.isInteger(x) ? x : Math.abs(x) >= 1e6 ? Math.round(x) : sig(x, 6);
  if (Array.isArray(x)) return x.map(factsOut);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined).map(([k, v]) => [k, factsOut(v)]));
  return x === undefined ? null : x;
}

function toInsight(t) {
  const ev = t.evidence || {}, copy = C.render(t);
  const evidence = {
    metric: ev.metric || t.metric,
    value: S.isNum(ev.value) ? sig(ev.value) : null,
    baseline: S.isNum(ev.baseline) ? sig(ev.baseline) : null,
    window: ev.window || t.window,
    stat: ev.stat || null,
    n: S.isNum(t.stat && t.stat.n) ? t.stat.n : null,
    nEff: S.isNum(t.stat && t.stat.nEff) ? t.stat.nEff : null,
    otherWindows: (t.otherWindows || []).map((o) => ({ window: o.window, p: sig(o.p) })),
    unit: copy.evidence.unit,
    valueLabel: copy.evidence.valueLabel,
    valueText: copy.evidence.valueText,
    baselineLabel: copy.evidence.baselineLabel,
    baselineText: copy.evidence.baselineText,
  };
  const series = sparkline(t.series);
  if (series) evidence.series = series;
  return {
    id: t.id,
    detector: t.detector,
    asset: t.asset,
    chain: t.chain || null,
    dimension: t.dimension,
    polarity: t.polarity,
    title: copy.title || C.fallbackTitle(t.headline),
    why: copy.why,
    stage: stageOf(t),
    role: copy.role,
    tier: null, // set by briefing.applyBriefing (the all-coins tier of new and ongoing items)
    surprise: { bits: round(t.surprise, 2), adjustedBits: round(t.adjustedBits, 2), p: sig(t.p), E: sig(t.E), m: t.m, notable: Boolean(t.notable), underpowered: Boolean(t.underpowered) },
    materialityUsd: S.isNum(t.materialityUsd) ? Math.round(t.materialityUsd) : null,
    materialityShare: sig(t.materialityShare),
    materialityFloorUsd: S.isNum(t.materialityFloor) ? Math.round(t.materialityFloor) : null,
    novelty: { ageDays: S.isNum(t.ageDays) ? t.ageDays : null, isNew: t.isNew !== false, front: S.isNum(t.front) ? t.front : null, since: sinceOf(t) },
    headline: t.headline,
    detail: t.detail,
    evidence,
    facts: t.facts ? factsOut(t.facts) : null,
    drivers: t.drivers && t.drivers.length ? t.drivers.map((d) => ({ asset: d.asset, chain: d.chain || null, usd: Math.round(d.usd) })) : null,
    asOf: ISO(t.asOf),
  };
}

module.exports = { run, toInsight, evaluate, familySizes, materialIn, collapseGroups, paretoRank, cluster, rootKey, healthGrid, novelty, runDetectors, DIMENSIONS, MAX_AGE, DEBOUNCE };
