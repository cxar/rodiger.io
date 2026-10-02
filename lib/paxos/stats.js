'use strict';

// Pure statistical helpers for the Paxos insight engine. No I/O, no clock, no domain constants.
// Numeric literals are mathematical (normal-consistency factors, the +1 of an unbiased empirical
// p-value, the n^(1/3) dependence scale, Kendall's bias term) or computational bounds, and are named
// where they appear.

const MAD_TO_SIGMA = 1.482602218505602; // 1/Phi^-1(3/4): MAD -> sigma under normality
const MEANAD_TO_SIGMA = 1.2533141373155001; // sqrt(pi/2): mean |dev| -> sigma (fallback when MAD == 0)

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clean = (xs) => { const out = []; for (const x of xs) if (isNum(x)) out.push(x); return out; };
const sum = (xs) => { let s = 0; for (const x of xs) s += x; return s; };
const mean = (xs) => { const c = clean(xs); return c.length ? sum(c) / c.length : null; };

function quantileSorted(s, q) {
  if (!s.length) return null;
  const h = (s.length - 1) * q, lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}
// Type-7 quantile (R default / numpy linear).
const quantile = (xs, q) => quantileSorted(clean(xs).sort((a, b) => a - b), q);
const median = (xs) => quantile(xs, 0.5);
function mad(xs) {
  const c = clean(xs), m = median(c);
  return m === null ? null : median(c.map((x) => Math.abs(x - m)));
}

// MAD scaled to sigma; when more than half the sample is identical (MAD == 0, e.g. a pegged price)
// fall back to the mean absolute deviation.
function robustScale(xs) {
  const c = clean(xs);
  if (c.length < 2) return null;
  const m = median(c), madv = mad(c);
  if (madv > 0) return madv * MAD_TO_SIGMA;
  const meanAd = c.reduce((a, x) => a + Math.abs(x - m), 0) / c.length;
  return meanAd > 0 ? meanAd * MEANAD_TO_SIGMA : null;
}
function robustZ(x, sample) {
  if (!isNum(x)) return null;
  const s = robustScale(sample);
  return s ? (x - median(sample)) / s : null;
}

// Unbiased empirical tail probability (Davison & Hinkley 1997, eq. 4.11): (1 + #as extreme)/(n + 1).
function empiricalP(x, sample, side = 'two') {
  if (!isNum(x)) return null;
  let n = 0, ge = 0, le = 0;
  for (const s of sample) {
    if (!isNum(s)) continue;
    n++;
    if (s >= x) ge++;
    if (s <= x) le++;
  }
  if (!n) return null;
  const up = (1 + ge) / (n + 1), lo = (1 + le) / (n + 1);
  return side === 'upper' ? up : side === 'lower' ? lo : Math.min(1, 2 * Math.min(up, lo));
}
// Smallest p an empirical test on n points can produce.
const minEmpiricalP = (n, side = 'two') => Math.min(1, (side === 'two' ? 2 : 1) / (n + 1));

// Mid-rank percentile in [0, 1].
function percentileRank(x, sample) {
  if (!isNum(x)) return null;
  let n = 0, lt = 0, eq = 0;
  for (const s of sample) {
    if (!isNum(s)) continue;
    n++;
    if (s < x) lt++; else if (s === x) eq++;
  }
  return n ? (lt + 0.5 * eq) / n : null;
}
// Share of total weight below x (ties count half), e.g. "share of stablecoin dollars that grew slower".
function weightedPercentileRank(x, values, weights) {
  let below = 0, total = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i], w = weights[i];
    if (!isNum(v) || !isNum(w) || w <= 0) continue;
    total += w;
    if (v < x) below += w; else if (v === x) below += w / 2;
  }
  return total > 0 ? below / total : null;
}

const surprisalBits = (p) => (isNum(p) && p > 0 ? -Math.log2(Math.min(1, p)) : null);

// "Highest since ...": under exchangeability P(last of k+1 values is the max) = 1/(k+1), so the
// number of prior points exceeded converts directly into a p-value.
function recordDepth(values, idx = values.length - 1) {
  const x = values[idx];
  if (!isNum(x)) return null;
  let hiSince = null, loSince = null, valid = 0, hiDepth = null, loDepth = null;
  for (let i = idx - 1; i >= 0; i--) {
    const v = values[i];
    if (!isNum(v)) continue;
    if (hiSince === null && v >= x) { hiSince = i; hiDepth = valid; }
    if (loSince === null && v <= x) { loSince = i; loDepth = valid; }
    valid++;
  }
  const highDepth = hiDepth === null ? valid : hiDepth, lowDepth = loDepth === null ? valid : loDepth;
  return {
    isAllTimeHigh: hiSince === null && valid > 0, isAllTimeLow: loSince === null && valid > 0,
    highestSinceIndex: hiSince, lowestSinceIndex: loSince, highDepth, lowDepth,
    pHigh: 1 / (highDepth + 1), pLow: 1 / (lowDepth + 1), history: valid,
  };
}

// Run-length encoding of a predicate (non-numbers are skipped, they neither extend nor break a run).
function runs(values, pred) {
  const out = [];
  let cur = null;
  values.forEach((v, i) => {
    if (!isNum(v)) return;
    const ok = Boolean(pred(v));
    if (cur && cur.value === ok) { cur.length++; cur.end = i; } else { cur = { value: ok, start: i, end: i, length: 1 }; out.push(cur); }
  });
  return out;
}
// Current streak vs COMPLETED streaks of the same kind: p = (1 + #completed >= L)/(1 + #completed).
// With no completed runs, fall back to a geometric model with the empirical rate q: q^(L-1).
function streak(values, pred) {
  const r = runs(values, pred);
  if (!r.length) return null;
  const current = r[r.length - 1];
  const done = r.slice(0, -1).filter((x) => x.value === current.value);
  const longer = done.filter((x) => x.length >= current.length).length;
  const longest = done.reduce((m, x) => Math.max(m, x.length), 0);
  const total = r.reduce((s, x) => s + x.length, 0);
  const trues = r.reduce((s, x) => s + (x.value ? x.length : 0), 0);
  const q = current.value ? trues / total : 1 - trues / total;
  const p = done.length ? (1 + longer) / (1 + done.length) : Math.pow(q, current.length - 1);
  return { value: current.value, length: current.length, startIndex: current.start, longestCompleted: longest, isRecord: current.length > longest, completedRuns: done.length, p, minP: done.length ? 1 / (1 + done.length) : p };
}

// h-step changes (overlapping windows) indexed by window end; log ratios or differences.
function changes(values, h, kind = 'log') {
  const out = new Array(values.length).fill(null);
  for (let i = h; i < values.length; i++) {
    const a = values[i - h], b = values[i];
    if (!isNum(a) || !isNum(b)) continue;
    out[i] = kind === 'log' ? (a > 0 && b > 0 ? Math.log(b / a) : null) : b - a;
  }
  return out;
}

// Scale-free horizons: powers of two up to n/4 (>= 4 non-overlapping windows each) plus source-native ones.
function horizonLadder(n, native = []) {
  const set = new Set(native.filter((h) => h <= n / 4));
  for (let h = 1; h <= n / 4; h *= 2) set.add(h);
  return [...set].sort((a, b) => a - b);
}

// Rolling mean over h points via prefix sums (O(n)); a window needs at least minCount numbers
// (default: half the window) or it is null.
function rollingMean(xs, h, minCount = Math.ceil(h / 2)) {
  const n = xs.length, ps = new Float64Array(n + 1), pc = new Int32Array(n + 1), out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) { const ok = isNum(xs[i]); ps[i + 1] = ps[i] + (ok ? xs[i] : 0); pc[i + 1] = pc[i] + (ok ? 1 : 0); }
  for (let i = h - 1; i < n; i++) {
    const c = pc[i + 1] - pc[i + 1 - h];
    if (c >= minCount && c > 0) out[i] = (ps[i + 1] - ps[i + 1 - h]) / c;
  }
  return out;
}

// One sort serves every statistic of a reference sample: tail counts and ranks by binary search,
// median and MAD-based robust scale (same definitions as above).
function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
function upperBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; }
function sampleStats(sample) {
  const c = Float64Array.from(clean(sample)).sort(), n = c.length;
  if (!n) return null;
  const med = quantileSorted(c, 0.5), dev = new Float64Array(n);
  for (let i = 0; i < n; i++) dev[i] = Math.abs(c[i] - med);
  dev.sort();
  const madv = quantileSorted(dev, 0.5);
  let scale = null;
  if (n >= 2) { if (madv > 0) scale = madv * MAD_TO_SIGMA; else { const md = sum(dev) / n; scale = md > 0 ? md * MEANAD_TO_SIGMA : null; } }
  return { sorted: c, n, median: med, scale };
}
function statsP(x, st, side = 'two') {
  const le = upperBound(st.sorted, x), ge = st.n - lowerBound(st.sorted, x);
  const up = (1 + ge) / (st.n + 1), lo = (1 + le) / (st.n + 1);
  return side === 'upper' ? up : side === 'lower' ? lo : Math.min(1, 2 * Math.min(up, lo));
}
function statsPct(x, st) { const lt = lowerBound(st.sorted, x), eq = upperBound(st.sorted, x) - lt; return (lt + 0.5 * eq) / st.n; }

// The latest h-window statistic ch[n-1] against every earlier window that ENDS before the current one
// STARTS (no overlap). Overlapping windows are autocorrelated, so p is floored at the resolution the
// history really supports: nEff = #non-overlapping windows, floor = k/(nEff+1) (k = 2 two-sided).
// The "largest since" date is a different question and looks at EVERY earlier window, overlapping ones
// included: sinceIndex = the most recent earlier window at least as extreme in the same direction (null:
// none, a record). When that window ends inside the current one (inWindow), a window that overlaps
// today's was at least as extreme, so no "largest since" claim holds and callers say nothing.
// An observed change of exactly 0 is a tie with every flat window of the history (sources repeat the
// last value on days nothing was reported), never an extreme: p = 1 (tie: true), whatever the sample.
function windowTest(ch, h, side = 'two') {
  const n = ch.length, x = ch[n - 1];
  if (!isNum(x)) return null;
  const sample = [];
  for (let i = h; i <= n - 1 - h; i++) if (isNum(ch[i])) sample.push(ch[i]);
  if (sample.length < 2) return null;
  const nEff = Math.max(1, Math.floor(sample.length / h));
  const st = sampleStats(sample), tie = x === 0, pEmp = tie ? 1 : statsP(x, st, side), minP = minEmpiricalP(nEff, side);
  const up = side === 'upper' || (side === 'two' && x >= 0);
  let sinceIndex = null;
  for (let i = n - 2; i >= 0; i--) if (isNum(ch[i]) && (up ? ch[i] >= x : ch[i] <= x)) { sinceIndex = i; break; }
  return {
    x, p: Math.max(pEmp, minP), pEmp, minP, nEff, n: sample.length, baseline: st.median, z: st.scale ? (x - st.median) / st.scale : null, pct: statsPct(x, st),
    sinceIndex, inWindow: sinceIndex !== null && sinceIndex > n - 1 - h, h, tie,
  };
}

// Lag-1 autocorrelation over consecutive numeric pairs.
function lag1(xs) {
  const pairs = [];
  for (let i = 1; i < xs.length; i++) if (isNum(xs[i]) && isNum(xs[i - 1])) pairs.push([xs[i - 1], xs[i]]);
  return pairs.length < 3 ? null : pearsonPairs(pairs);
}
// Effective sample size of an AR(1)-like level series (Bartlett): n(1-r)/(1+r), clamped to [1, n].
function effectiveSampleSize(xs) {
  const n = clean(xs).length, r = lag1(xs);
  if (!n) return 0;
  if (r === null || r <= 0) return n;
  return Math.max(1, Math.min(n, (n * (1 - r)) / (1 + r)));
}
// Today's LEVEL against the level history. A persistent series visits each extreme for many days in a
// row, so p is floored at the resolution of its effective sample size (same guard as windowTest).
function levelTest(x, hist, side = 'two') {
  const c = clean(hist);
  if (!isNum(x) || c.length < 2) return null;
  const nEff = Math.floor(effectiveSampleSize(hist)), st = sampleStats(c);
  const pEmp = statsP(x, st, side), minP = minEmpiricalP(nEff, side);
  return { x, p: Math.max(pEmp, minP), pEmp, minP, nEff, n: c.length, baseline: st.median, z: st.scale ? (x - st.median) / st.scale : null, pct: statsPct(x, st) };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ranks(xs) {
  const idx = [];
  xs.forEach((x, i) => { if (isNum(x)) idx.push([x, i]); });
  idx.sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length).fill(null);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

// Standard normal draws (Box-Muller, both values of each pair used) from a uniform generator.
function gaussianSource(rand) {
  let spare = null;
  return () => {
    if (spare !== null) { const z = spare; spare = null; return z; }
    const rad = Math.sqrt(-2 * Math.log(1 - rand())), ang = 2 * Math.PI * rand();
    spare = rad * Math.sin(ang);
    return rad * Math.cos(ang);
  };
}

// Weighted CUSUM scan of a series around its own mean: [max |S_k| / w_k, split index].
function cusumScan(y, w) {
  const n = y.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += y[i];
  m /= n;
  let s = 0, best = 0, arg = -1;
  for (let k = 0; k < n - 1; k++) { s += y[k] - m; const v = Math.abs(s) / w[k]; if (v > best) { best = v; arg = k + 1; } }
  return [best, arg];
}
const cusumWeights = (n) => { const w = new Float64Array(n); for (let k = 0; k < n - 1; k++) w[k] = Math.sqrt(((k + 1) * (n - k - 1)) / n); return w; }; // favours no edge
// Lag-1 autocorrelation of the residuals around the two segment means at the best split.
function splitPersistence(y, w) {
  const n = y.length, at = cusumScan(y, w)[1];
  let m1 = 0, m2 = 0;
  for (let i = 0; i < n; i++) { if (i < at) m1 += y[i]; else m2 += y[i]; }
  m1 /= at; m2 /= n - at;
  // lag-1 autocorrelation of the residuals (their mean is 0 by construction)
  let num = 0, den = 0, prev = 0;
  for (let i = 0; i < n; i++) { const e = y[i] - (i < at ? m1 : m2); den += e * e; if (i) num += e * prev; prev = e; }
  return den > 0 ? num / den : 0;
}
// Persistence (AR(1) coefficient) of a series that may contain one level shift. Measured around the
// best split, so a genuine break does not read as persistence (the whole-series lag-1 of a clean step
// is up to 0.75 in ranks and would hide every break). That estimate is biased low for persistent series,
// because the best split absorbs their slowest wandering, so it is bias-corrected by a parametric
// bootstrap (Efron & Tibshirani 1993, ch. 10): r = 2*r0 - mean(r0* on `draws` stationary Gaussian AR(r0)
// paths of the same length, ranked when the data are). Clipped to [0, 1 - 1/n].
function persistence(c, w, { draws = 40, ranked = true, rand = mulberry32(2) } = {}) {
  const n = c.length, clip = (x) => Math.min(Math.max(0, x), 1 - 1 / n), r0 = clip(splitPersistence(c, w));
  const g = new Float64Array(n), sorted = new Float64Array(n), rk = new Float64Array(n), mu = (n + 1) / 2, sd0 = 1 / Math.sqrt(1 - r0 * r0), z = gaussianSource(rand);
  let acc = 0;
  for (let k = 0; k < draws; k++) {
    let v = sd0 * z();
    for (let i = 0; i < n; i++) { g[i] = v; v = r0 * v + z(); }
    if (!ranked) { acc += splitPersistence(g, w); continue; }
    sorted.set(g);
    sorted.sort(); // continuous draws: no ties, so rank = position in the sorted copy
    for (let i = 0; i < n; i++) rk[i] = lowerBound(sorted, g[i]) + 1 - mu;
    acc += splitPersistence(rk, w);
  }
  return clip(2 * r0 - acc / draws);
}

// Single changepoint by standardised CUSUM (on ranks by default: a Pettitt / Mann-Whitney style
// statistic that one launch-day outlier cannot dominate). The null keeps the series' own persistence
// r (see persistence): an AR(1) sieve bootstrap with the centred innovations resampled with
// replacement, each path started from a random observed value after a burn-in of 5/(1-r) steps. A
// level-shift test on a persistent series compared with shuffles of it (or short blocks) is wildly
// anti-conservative: a random walk "breaks" almost surely. Below an effective sample of two minimum
// segments (Bartlett n(1-r)/(1+r) < 2*minSeg) a break cannot be told apart from the series' own
// wandering: p = 1, minP = 1 (untestable). Measured with the detectors' minimum segment of 8, null rates
// P(p <= 0.01) stay at or near 0.01 for AR(1) from 0 to a random walk (they were 0.66 for AR(0.95) and
// 0.96 for a random walk with short-block permutations; check-paxos-engine.mjs). Up to B = 999 simulations (p resolution 0.001,
// Davison & Hinkley 1997), stopped sequentially once EXCEED simulated statistics reach the observed one
// (Besag & Clifford 1991: p = EXCEED/L after L simulations is an exact p-value, and a clearly
// unremarkable split costs a few dozen simulations instead of 999). `stopAbove`: also stop once
// p >= stopAbove is certain.
const EXCEED = 20; // sequential Monte Carlo stopping count (Besag & Clifford 1991)
function changepoint(values, { permutations = null, rand = mulberry32(1), robust = true, stopAbove = null, minSeg = 4 } = {}) {
  const raw = clean(values), n = raw.length;
  if (n < Math.max(8, 2 * minSeg)) return null;
  const xs = robust ? ranks(raw) : raw;
  const mu = sum(xs) / n, c = new Float64Array(n), w = cusumWeights(n);
  for (let i = 0; i < n; i++) c[i] = xs[i] - mu;
  const [obs, at] = cusumScan(c, w);
  const r = persistence(c, w, { ranked: robust }), nEff = (n * (1 - r)) / (1 + r);
  const before = raw.slice(0, at), after = raw.slice(at);
  const out = {
    index: at, stat: obs, r, nEff,
    before: { n: before.length, median: median(before), mean: sum(before) / before.length },
    after: { n: after.length, median: median(after), mean: sum(after) / after.length },
  };
  if (nEff < 2 * minSeg) return { ...out, p: 1, minP: 1, permutations: 0, untestable: true };
  const e = new Float64Array(n - 1);
  let em = 0;
  for (let i = 1; i < n; i++) { e[i - 1] = c[i] - r * c[i - 1]; em += e[i - 1]; }
  em /= n - 1;
  for (let i = 0; i < n - 1; i++) e[i] -= em;
  const burn = Math.min(n, Math.ceil(5 / (1 - r))), y = new Float64Array(n), draw = () => e[Math.floor(rand() * (n - 1))];
  const B = permutations || 999;
  let ge = 0, done = 0, p = null;
  for (let b = 0; b < B; b++) {
    let v = c[Math.floor(rand() * n)];
    for (let i = 0; i < burn; i++) v = r * v + draw();
    for (let i = 0; i < n; i++) { v = r * v + draw(); y[i] = v; }
    done++;
    if (cusumScan(y, w)[0] >= obs) ge++;
    if (ge >= EXCEED) { p = ge / done; break; }
    if (stopAbove !== null && (1 + ge) / (1 + B) >= stopAbove) { p = Math.max(stopAbove, ge / done); break; }
  }
  return { ...out, p: p === null ? (1 + ge) / (1 + B) : p, minP: 1 / (1 + B), permutations: done };
}

// Regime chain: binary segmentation that recurses into the latest segment while the split is at least
// one bit of surprise (p < 1/2) and the segment still holds minSeg points on each side (effective
// points, see changepoint). Every split is returned (with absolute index and the start of the segment
// it split), so callers can test each one: reporting only the last split would let a weak late split
// hide a strong earlier break. Input must be numbers only.
function regimeChain(values, minSeg, opts = {}) {
  const out = [];
  let off = 0, seg = values;
  while (seg.length >= 2 * minSeg) {
    const cp = changepoint(seg, { ...opts, minSeg, stopAbove: 0.5 });
    if (!cp || cp.p >= 0.5) break;
    out.push({ ...cp, index: cp.index + off, segStart: off });
    off += cp.index;
    seg = seg.slice(cp.index);
  }
  return out;
}

// Concentration.
function hhi(parts) {
  const v = clean(parts).filter((x) => x > 0), t = sum(v);
  return t ? v.reduce((a, x) => a + (x / t) ** 2, 0) : null;
}
const effectiveN = (parts) => { const h = hhi(parts); return h ? 1 / h : null; };

// Change decomposition across parts (chains, assets):
//   net = sum(d_i); gross = sum|d_i|; rotation = (gross - |net|)/2 (dollars that moved BETWEEN parts)
//   contrib_i = d_i/net; scale_i = s_i(prev)*net (shift-share); differential_i = d_i - scale_i
//   drivers = 1/HHI(|d_i|) (effective number of parts driving the change)
function decompose(prev, curr) {
  const keys = [...new Set([...Object.keys(prev), ...Object.keys(curr)])];
  const val = (o, k) => (isNum(o[k]) ? o[k] : 0);
  let P = 0, C = 0;
  for (const k of keys) { P += val(prev, k); C += val(curr, k); }
  const net = C - P;
  const parts = keys.map((k) => {
    const p = val(prev, k), c = val(curr, k), delta = c - p, sharePrev = P ? p / P : 0, shareCurr = C ? c / C : 0, scale = sharePrev * net;
    return { key: k, prev: p, curr: c, delta, contrib: net ? delta / net : null, sharePrev, shareCurr, shareShift: shareCurr - sharePrev, scale, differential: delta - scale };
  });
  parts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (a.key < b.key ? -1 : 1));
  const gross = parts.reduce((a, x) => a + Math.abs(x.delta), 0);
  return { prevTotal: P, currTotal: C, net, gross, rotation: (gross - Math.abs(net)) / 2, drivers: effectiveN(parts.map((x) => Math.abs(x.delta))), parts };
}

// Rate x base decomposition of y = r*b; the three effects sum exactly to the total.
function productDecomposition(r0, b0, r1, b1) {
  return { total: r1 * b1 - r0 * b0, rateEffect: (r1 - r0) * b0, baseEffect: r0 * (b1 - b0), interaction: (r1 - r0) * (b1 - b0) };
}

function pearsonPairs(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (const [x, y] of pairs) { mx += x; my += y; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// Best lag L in [-maxLag, maxLag] of the rank correlation of a[t] with b[t+L] (maxLag defaults to
// n^(1/3), a standard dependence scale for daily series). Computed as the circular
// cross-correlation of centred ranks (missing values sit at the centre, i.e. contribute nothing).
// Null: EVERY non-zero circular shift of b (keeps both series' autocorrelation; exact, deterministic).
// Shifts next to zero must stay in: dropping them (as a "non-overlapping" null would) removes exactly
// the windows that share the observed maximum and makes p anti-conservative (measured: p<0.01 in 5%
// of independent pairs). The price is resolution: p >= (1 + 2*maxLag)/n. O(n^2), so only the most
// recent LEADLAG_MAX_N points are used: a computational bound (about 11 years of daily data, ~17M
// multiply-adds) that keeps one implausibly long series from stalling the build.
const LEADLAG_MAX_N = 4096;
function leadLag(a, b, { maxLag = null, maxN = LEADLAG_MAX_N } = {}) {
  const len = Math.min(a.length, b.length), n = Math.min(len, maxN);
  const centred = (xs) => {
    const r = ranks(xs.slice(len - n, len)), out = new Float64Array(n);
    const v = clean(r), mu = v.length ? sum(v) / v.length : 0;
    for (let i = 0; i < n; i++) out[i] = isNum(r[i]) ? r[i] - mu : 0;
    return out;
  };
  const ra = centred(a), rb = centred(b);
  let saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { saa += ra[i] * ra[i]; sbb += rb[i] * rb[i]; }
  const L = maxLag || Math.max(1, Math.round(Math.cbrt(n)));
  if (!saa || !sbb || n < 4 * L + 4) return null;
  const norm = Math.sqrt(saa * sbb), cc = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let t = 0, u = k; t < n; t++, u++) { if (u === n) u = 0; s += ra[t] * rb[u]; }
    cc[k] = s / norm;
  }
  const at = (lag) => cc[((lag % n) + n) % n];
  let best = { lag: 0, rho: at(0) };
  for (let lag = -L; lag <= L; lag++) if (Math.abs(at(lag)) > Math.abs(best.rho)) best = { lag, rho: at(lag) };
  let ge = 0;
  for (let s = 1; s < n; s++) {
    let m = 0;
    for (let j = -L; j <= L; j++) m = Math.max(m, Math.abs(at(s + j)));
    if (m >= Math.abs(best.rho)) ge++;
  }
  return { ...best, maxLag: L, n, p: (1 + ge) / n, minP: Math.min(1, (1 + 2 * L) / n), nullSize: n - 1 };
}

// Series hygiene: interior gaps are forward-filled (annotated); a final 0 after a gap is "tracking ended",
// not a burn, and is dropped.
function repairChainSeries(points, stepSec) {
  const notes = [];
  if (!points.length) return { points, notes };
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const cur = points[i], prev = out[out.length - 1];
    if (prev) {
      const gapSteps = Math.round((cur.t - prev.t) / stepSec) - 1;
      if (gapSteps > 0 && i === points.length - 1 && cur.v === 0) { notes.push({ kind: 'tracking_ended', from: prev.t, to: cur.t, gapSteps }); continue; }
      if (gapSteps > 0) {
        notes.push({ kind: 'interior_gap_filled', from: prev.t, to: cur.t, gapSteps });
        for (let g = 1; g <= gapSteps; g++) out.push({ t: prev.t + g * stepSec, v: prev.v, filled: true });
      }
    }
    out.push(cur);
  }
  return { points: out, notes };
}

// P(Poisson(lambda) >= k).
function poissonTail(k, lambda) {
  if (k <= 0) return 1;
  let cdf = 0, term = Math.exp(-lambda);
  for (let i = 0; i < k; i++) { cdf += term; term *= lambda / (i + 1); }
  return Math.max(0, 1 - cdf);
}
// Days on which several series start together: P(Poisson(rate) >= count) on one day, kept when it
// survives the family of distinct start dates (p * #dates < 1). p is floored at 1/(span+1).
function trackingClusters(firsts, stepSec) {
  if (firsts.length < 3) return [];
  const lo = Math.min(...firsts), hi = Math.max(...firsts), span = (hi - lo) / stepSec + 1, rate = firsts.length / span;
  const counts = new Map();
  for (const d of firsts) counts.set(d, (counts.get(d) || 0) + 1);
  const out = [];
  for (const [date, count] of counts) {
    const p = Math.max(poissonTail(count, rate), 1 / (span + 1));
    if (count > 1 && p * counts.size < 1) out.push({ date, count, expected: rate, p, dates: counts.size });
  }
  return out.sort((a, b) => a.date - b.date);
}

// Drawdown episodes: peak -> trough -> new peak. Comparing the CURRENT episode with COMPLETED ones (not
// day-by-day levels) stops a managed wind-down from being a "record" every day.
function drawdownEpisodes(v) {
  const eps = [];
  let i0 = 0;
  while (i0 < v.length && !isNum(v[i0])) i0++;
  if (i0 >= v.length) return { completed: [], current: null };
  let peak = v[i0], peakIdx = i0, trough = 0, troughIdx = i0, last = i0;
  for (let i = i0 + 1; i < v.length; i++) {
    if (!isNum(v[i])) continue;
    last = i;
    // A flat stretch at the peak keeps its first day (the page's peak date); a return to the peak after
    // a dip completes the episode and starts a new one there.
    if (v[i] > peak || (v[i] === peak && trough < 0)) {
      if (trough < 0) eps.push({ peakIdx, troughIdx, depth: trough, peak, recoveredIdx: i });
      peak = v[i]; peakIdx = i; trough = 0; troughIdx = i;
    } else if (v[i] === peak) {
      troughIdx = i;
    } else if (peak > 0) {
      const d = v[i] / peak - 1;
      if (d < trough) { trough = d; troughIdx = i; }
    }
  }
  return { completed: eps, current: { peakIdx, peak, depth: peak > 0 ? v[last] / peak - 1 : 0, maxDepth: trough, troughIdx, lastIdx: last } };
}

// Coverage step of a level series: the LAST index k whose one-day rise in log level exceeds every later
// `week`-step |log move|, provided at least `horizon` points follow it (without that horizon ordinary late
// days qualify). Such a jump is a change in what the series covers (items added), not growth. null: none.
function coverageStep(values, week, horizon) {
  const n = values.length;
  if (n < week + horizon + 2) return null;
  const L = values.map((v) => (isNum(v) && v > 0 ? Math.log(v) : null)), suffix = new Array(n + 1).fill(-Infinity);
  for (let j = n - 1; j >= 0; j--) suffix[j] = Math.max(suffix[j + 1], j + week < n && L[j] !== null && L[j + week] !== null ? Math.abs(L[j + week] - L[j]) : -Infinity);
  let lastK = null;
  for (let k = 1; k < n - horizon; k++) if (L[k] !== null && L[k - 1] !== null && L[k] - L[k - 1] > 0 && L[k] - L[k - 1] > suffix[k]) lastK = k;
  return lastK;
}

// Pareto (non-dominated) fronts, all axes maximised; returns the front number (1 = best) per item.
function paretoFronts(items, axes) {
  const pts = items.map(axes), front = new Array(items.length).fill(0);
  const dominates = (A, B) => { let strict = false; for (let i = 0; i < A.length; i++) { if (A[i] < B[i]) return false; if (A[i] > B[i]) strict = true; } return strict; };
  let rest = items.map((_, i) => i), f = 1;
  while (rest.length) {
    const nd = rest.filter((i) => !rest.some((j) => j !== i && dominates(pts[j], pts[i])));
    for (const i of nd) front[i] = f;
    const set = new Set(nd);
    rest = rest.filter((i) => !set.has(i));
    f++;
  }
  return front;
}

module.exports = {
  MAD_TO_SIGMA, isNum, clean, sum, mean, quantile, median, mad, robustScale, robustZ,
  empiricalP, minEmpiricalP, percentileRank, weightedPercentileRank, surprisalBits, recordDepth, runs, streak,
  changes, horizonLadder, rollingMean, sampleStats, statsP, statsPct, windowTest, lag1, effectiveSampleSize, levelTest,
  mulberry32, ranks, changepoint, regimeChain, hhi, effectiveN, decompose, productDecomposition,
  leadLag, LEADLAG_MAX_N, repairChainSeries, poissonTail, trackingClusters, drawdownEpisodes, coverageStep, paretoFronts,
};
