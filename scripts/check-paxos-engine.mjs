#!/usr/bin/env node
// Offline, deterministic checks for the Paxos insight engine (lib/paxos/{stats,format,detectors,engine,
// attribution}.js): statistics unit tests and null calibration, engine logic (notability, collapse,
// novelty, Pareto, clustering, health grid), detectors on synthetic series with planted events, the
// toInsight schema, and a scan for hard-coded assets/chains/addresses. No network. Run: node scripts/check-paxos-engine.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../lib/paxos/stats.js');
const F = require('../lib/paxos/format.js');
const D = require('../lib/paxos/detectors.js');
const E = require('../lib/paxos/engine.js');
const A = require('../lib/paxos/attribution.js');

const DAY = 86400;
const T0 = 1704067200; // 2024-01-01T00:00Z
const gauss = (r) => { let u = 0; for (let i = 0; i < 12; i++) u += r(); return u - 6; };
const daysFrom = (n, t0 = T0) => Array.from({ length: n }, (_, i) => t0 + i * DAY);
const iso = (t) => new Date(t * 1000).toISOString();
// Wall-clock budgets are advisory (a warning) unless PAXOS_PERF_STRICT=1: a busy build machine must not
// fail a deploy (review #34); measured margins are several times the budget.
const perf = (ok, msg) => { if (process.env.PAXOS_PERF_STRICT === '1') assert.ok(ok, msg); else if (!ok) console.warn('perf budget exceeded (advisory): ' + msg); };

// ---------- synthetic model builders (the model contract of lib/paxos/model.js) ----------
function mkAsset(key, { t, supply, chains = {}, price = null, kind = 'usd-stablecoin', status = 'active', ...rest }) {
  const px = price || t.map(() => 1);
  return {
    key, name: key + ' synthetic', symbol: key, geckoId: null, llamaId: null, via: ['synthetic'], kind, status,
    pegType: kind === 'usd-stablecoin' ? 'peggedUSD' : null, dead: null, feeModelled: false, list: null, cg: null,
    supply: { t, v: supply }, supplyUsd: { t, v: supply.map((x, i) => (x === null ? null : x * px[i])) }, supplySource: 'synthetic:test',
    priceDaily: price ? { t, v: price } : null, hourly: null, priceLlamaDaily: null,
    chains: Object.fromEntries(Object.entries(chains).map(([name, c]) => {
      const ct = c.t || t;
      return [name, { t: ct, v: c.v || c, notes: c.notes || [], first: ct[0], minted: c.minted || null }];
    })),
    cgDaily: null, xauDaily: null, firstPriceT: null, addresses: [], cm: null, onchain: [], ...rest,
  };
}
function mkModel(assets, extra = {}) {
  const t = extra.t || assets[0].supply.t;
  const mk = extra.market || t.map((_, i) => 2e11 + i * 1e8);
  return {
    now: t[t.length - 1] + DAY / 2, list: { peggedAssets: [], chains: [] }, listSanity: { tolerance: 0, excluded: [] }, assets,
    market: { t, v: mk }, marketUsd: { t, v: mk }, pegPeers: [], goldRefs: [], chainTotals: {}, pools: null, lendBorrow: null,
    fees: null, revenue: null, cmPeers: {}, poolCharts: {}, sources: [], ...extra,
  };
}
// Pure noise: three chains doing independent random walks; the supply is their sum.
function noiseAsset(key, seed, n = 400) {
  const r = S.mulberry32(seed), t = daysFrom(n);
  const lv = [5e8, 3e8, 2e8], sd = [4e6, 3e6, 2e6], ch = [[], [], []], sup = [];
  for (let i = 0; i < n; i++) { for (let k = 0; k < 3; k++) { lv[k] = Math.max(1e6, lv[k] + sd[k] * gauss(r)); ch[k].push(lv[k]); } sup.push(lv[0] + lv[1] + lv[2]); }
  return mkAsset(key, { t, supply: sup, price: t.map(() => 1 + 0.0005 * gauss(r)), chains: { 'Chain A': ch[0], 'Chain B': ch[1], 'Chain C': ch[2] } });
}
function noiseMarket(seed, n = 400) {
  const r = S.mulberry32(seed + 99991);
  let m = 2e11;
  return daysFrom(n).map(() => (m += 4e8 * gauss(r)));
}

// A rich synthetic model that exercises every detector (used for schema validation and errors[]).
function richModel() {
  const r = S.mulberry32(42), n = 420, t = daysFrom(n);
  const walk = (start, sd, drift = 0) => { let x = start; return t.map(() => (x = Math.max(start * 0.05, x * (1 + drift) + sd * gauss(r)))); };
  const cA = walk(6e8, 5e6, 0.001), cB = walk(2e8, 3e6), cC = walk(1e8, 2e6), dust = t.map((_, i) => (i === n - 1 ? 6000 : 1000));
  const supA = t.map((_, i) => cA[i] + cB[i] + cC[i] + dust[i]);
  const pxA = t.map(() => 1 + 0.0004 * gauss(r));
  const bA = walk(4e8, 4e6), bB = walk(1e8, 1e6), supB = t.map((_, i) => bA[i] + bB[i]);
  const hours = (n2, base, sd) => Array.from({ length: n2 }, (_, i) => ({ t: t[n - 1] + DAY / 2 - (n2 - 1 - i) * 3600, p: base + sd * gauss(r) }));
  const daily = (base, sd) => ({ t, v: t.map(() => base + sd * gauss(r)) });
  const cmRows = (k) => t.slice(20).map((d) => ({ asset: k, time: iso(d), AdrActCnt: String(Math.round(3000 + 300 * gauss(r))), TxTfrCnt: String(Math.round(12000 + 900 * gauss(r))), AdrBalCnt: String(Math.round(90000 + 500 * gauss(r))) }));
  const addrA = '0x' + 'ab'.repeat(20), addrB = 'SyntheticBase58Address111111111111111111111';
  const aaa = mkAsset('AAA', {
    t, supply: supA, price: pxA, llamaId: '1001', geckoId: 'aaa-synthetic', feeModelled: true,
    chains: { 'Chain A': { v: cA, minted: { t, v: cA.map((x, i) => x + 4e7 + 2e7 * Math.sin(i / 9)) } }, 'Chain B': cB, 'Chain C': cC, Dust: dust },
    priceLlamaDaily: { t, v: pxA.map((x) => x + 0.0001 * gauss(r)) }, hourly: hours(500, 1, 0.0003), firstPriceT: t[0] - 120 * DAY,
    cgDaily: { mcap: { t, v: supA.map((x) => x * 1.01) }, vol: { t, v: supA.map((x) => x * (0.05 + 0.01 * gauss(r))) }, price: { t, v: pxA } },
    cg: { circulating_supply: supA[n - 1] * 1.01, market_cap: supA[n - 1] * 1.01, current_price: 1 },
    addresses: [{ chain: 'Chain A', address: addrA, decimals: 6, chainId: 1, llamaKey: 'chaina', cgPlatform: 'chain-a', via: ['synthetic'] }, { chain: 'Chain Z', address: addrB, decimals: 6, chainId: null, llamaKey: null, cgPlatform: 'chain-z', via: ['synthetic'] }],
    cm: { key: 'aaa_x', rows: cmRows('aaa_x') },
  });
  const bbb = mkAsset('BBB', { t, supply: supB, price: t.map((_, i) => 1 - (i < 380 ? 0.0002 : 0.003) * Math.abs(gauss(r))), llamaId: '1002', feeModelled: true,
    chains: { 'Chain A': bA, 'Chain B': bB, 'Chain N': { t: t.slice(-10), v: t.slice(-10).map((_, i) => 2e7 + i * 1e6) } }, priceLlamaDaily: daily(1, 0.0002), hourly: hours(500, 1, 0.0002) });
  const gPx = t.map((_, i) => 2000 + i + 20 * gauss(r)), gSup = walk(4e5, 800);
  const gld = mkAsset('GLD', {
    t, supply: gSup, price: gPx, kind: 'gold', xauDaily: { t, v: t.map(() => 1 + 0.002 * gauss(r)) }, priceLlamaDaily: { t, v: gPx }, hourly: hours(500, gPx[n - 1], 3),
    cgDaily: { mcap: { t, v: gSup.map((x, i) => x * gPx[i]) }, vol: { t, v: gSup.map((x, i) => x * gPx[i] * 0.03) }, price: { t, v: gPx } },
  });
  gld.priceDaily = null;
  const old = mkAsset('OLD', { t: t.slice(0, 200), supply: walk(5e6, 1e4).slice(0, 200), status: 'dead', llamaId: '1003' });
  old.dead = '2024-07-20';
  old.list = { id: '1003', symbol: 'OLD', pegType: 'peggedUSD', circulating: { peggedUSD: 5e6 }, price: 1 };
  const listRow = (id, sym, cur, prev, extra2 = {}) => ({ id, symbol: sym, name: sym, gecko_id: sym.toLowerCase(), pegType: 'peggedUSD', pegMechanism: 'fiat-backed', price: 1.0001, circulating: { peggedUSD: cur }, circulatingPrevDay: { peggedUSD: prev.d }, circulatingPrevWeek: { peggedUSD: prev.w }, circulatingPrevMonth: { peggedUSD: prev.m }, ...extra2 });
  const peers = Array.from({ length: 40 }, (_, i) => { const cur = 1e7 * (i + 1) ** 1.5; return listRow(String(2000 + i), 'P' + i, cur, { d: cur * (1 + 0.002 * gauss(r)), w: cur * (1 + 0.01 * gauss(r)), m: cur * (1 + 0.03 * gauss(r)) }); });
  const at = (s, k) => s[s.length - 1 - k];
  const list = {
    peggedAssets: [...peers, listRow('1001', 'AAA', at(supA, 0), { d: at(supA, 1), w: at(supA, 7), m: at(supA, 30) }), listRow('1002', 'BBB', at(supB, 0), { d: at(supB, 1), w: at(supB, 7), m: at(supB, 30) }), { ...old.list, deadFrom: old.dead, gecko_id: 'old' }],
    chains: [],
  };
  aaa.list = list.peggedAssets.find((x) => x.id === '1001');
  bbb.list = list.peggedAssets.find((x) => x.id === '1002');
  const pegPeers = [{ symbol: 'P39', geckoId: 'p39', llamaId: '2039', share: 0.6, hourly: hours(500, 1, 0.0001), daily: daily(1, 0.0001) }];
  const goldRefs = [{ symbol: 'GREF', geckoId: 'gref', name: 'Gold Ref', hourly: hours(500, gPx[n - 1] * 0.999, 3), daily: { t, v: gPx.map((x) => x * (1 + 0.001 * gauss(r))) } }];
  const chainTotals = { 'Chain A': { current: 3e9, hist: { t, v: t.map((_, i) => 3e9 + cA[i] + 1e7 * gauss(r)) } }, 'Chain B': { current: 1e9, hist: { t, v: t.map((_, i) => 1e9 + cB[i] + 5e6 * gauss(r)) } } };
  const pool = (id, chain, sym, tvl, apy, tok, extra2 = {}) => ({ pool: id, chain, project: 'proj-' + id, symbol: sym, tvlUsd: tvl, apy, apyBase: apy * 0.8, apyReward: apy * 0.2, stablecoin: true, exposure: 'single', underlyingTokens: tok, poolMeta: null, apyPct30D: 0.1, ...extra2 });
  const pools = [pool('pool-a1', 'chain a', 'AAA', 1.5e8, 6.5, [addrA]), pool('pool-a2', 'chain a', 'AAA-X', 2e7, 3, [addrA.toUpperCase().replace('0X', '0x')], { exposure: 'multi' }),
    ...Array.from({ length: 30 }, (_, i) => pool('peer-' + i, 'chain a', 'S' + i, 1e6 * (i + 1), 2 + 0.1 * i, ['0x' + String(i).padStart(40, '0')]))];
  const lendBorrow = [{ pool: 'pool-a1', totalSupplyUsd: 1.5e8, totalBorrowUsd: 1.4e8, borrowable: true, apyBaseBorrow: 7, underlyingTokens: [addrA] },
    ...Array.from({ length: 30 }, (_, i) => ({ pool: 'peer-' + i, totalSupplyUsd: 1e6 * (i + 1), totalBorrowUsd: 1e6 * (i + 1) * (0.2 + 0.02 * i), borrowable: true, apyBaseBorrow: 4, underlyingTokens: ['0x' + String(i).padStart(40, '0')] }))];
  const poolCharts = { 'pool-a1': t.slice(-200).map((d, i) => ({ timestamp: new Date((d + 82800) * 1000).toISOString(), tvlUsd: 5e7 + i * 5e5 + 2e6 * gauss(r), apy: 6, apyBase: 5, apyReward: 1 })) };
  const base = t.map((_, i) => supA[i] + supB[i]), rate = t.map((_, i) => (i < 300 ? 0.045 : 0.0425));
  const fees = { series: { t, v: t.map((_, i) => (i ? (base[i - 1] * rate[i]) / 365 : null)) }, total24h: 1, total1y: 1, labels: [] };
  return mkModel([aaa, bbb, gld, old], {
    t, list, listSanity: { tolerance: 0.0015, excluded: [{ id: '3001', symbol: 'GLITCH', pegType: 'peggedVAR', jumpUsd: 9.8e9, prevDay: 1.2e4, current: 9.8e9, listSum: 9.81e9, chartSum: 1.2e7, tolerance: 0.0015 }] },
    pegPeers, goldRefs, chainTotals, pools, lendBorrow, poolCharts, fees, revenue: { series: fees.series, total24h: 1 }, cmPeers: { peer_cm: cmRows('peer_cm') },
  });
}

// ---------- 1. statistics ----------
test('quantile / median / mad', () => {
  assert.equal(S.median([3, 1, 2]), 2);
  assert.equal(S.quantile([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(S.mad([1, 1, 2, 2, 4, 6, 9]), 1);
});
test('robustZ ignores an outlier and falls back when MAD = 0', () => {
  assert.ok(Math.abs(S.robustZ(3, [0, 1, -1, 0.5, -0.5, 1000])) < 6);
  assert.ok(Number.isFinite(S.robustZ(1.5, [1, 1, 1, 1, 1, 2])));
  assert.equal(S.robustZ(1, [1, 1, 1]), null);
});
test('empiricalP is never 0 and resolves to 1/(n+1)', () => {
  const xs = Array.from({ length: 99 }, (_, i) => i);
  assert.equal(S.empiricalP(1000, xs, 'upper'), 1 / 100);
  assert.equal(S.empiricalP(-5, xs, 'lower'), 1 / 100);
  assert.equal(S.empiricalP(1000, xs, 'two'), 2 / 100);
  assert.equal(S.empiricalP(49, xs, 'two'), 1);
});
test('percentile ranks (plain and size-weighted)', () => {
  assert.equal(S.percentileRank(2, [1, 2, 3]), 0.5);
  assert.equal(S.weightedPercentileRank(2, [1, 2, 3], [98, 1, 1]), 0.985);
});
test('sorted-sample statistics equal the direct definitions', () => {
  const r = S.mulberry32(5), xs = Array.from({ length: 501 }, () => r() - 0.5);
  xs[7] = null;
  const st = S.sampleStats(xs);
  for (const x of [0.49, -0.3, 0.1, xs[3], 2]) {
    assert.equal(S.statsP(x, st), S.empiricalP(x, xs));
    assert.equal(S.statsP(x, st, 'upper'), S.empiricalP(x, xs, 'upper'));
    assert.ok(Math.abs(S.statsPct(x, st) - S.percentileRank(x, xs)) < 1e-12);
    assert.ok(Math.abs((x - st.median) / st.scale - S.robustZ(x, xs)) < 1e-12);
  }
});
test('recordDepth gives "highest since" and an exchangeable p', () => {
  const r = S.recordDepth([5, 1, 2, 3, 4]);
  assert.equal(r.highestSinceIndex, 0);
  assert.equal(r.highDepth, 3);
  assert.equal(r.pHigh, 1 / 4);
  assert.equal(S.recordDepth([1, 2, 3]).isAllTimeHigh, true);
});
test('streak: current run vs completed runs', () => {
  const st = S.streak([1, -1, -1, 1, -1, -1, -1], (x) => x > 0);
  assert.deepEqual([st.value, st.length, st.longestCompleted, st.isRecord, st.p], [false, 3, 2, true, 1 / 2]);
});
test('changes and horizonLadder', () => {
  assert.deepEqual(S.changes([1, 2, 4], 1, 'diff'), [null, 1, 2]);
  assert.ok(Math.abs(S.changes([1, Math.E], 1, 'log')[1] - 1) < 1e-12);
  assert.deepEqual(S.horizonLadder(40, [7, 30]), [1, 2, 4, 7, 8]);
});
test('rollingMean (prefix sums) equals the naive window mean, with gaps', () => {
  const r = S.mulberry32(9), xs = Array.from({ length: 300 }, (_, i) => (i % 11 === 3 ? null : r()));
  for (const h of [1, 2, 7, 30]) {
    const fast = S.rollingMean(xs, h);
    xs.forEach((_, i) => {
      const w = i < h - 1 ? [] : xs.slice(i - h + 1, i + 1).filter((v) => v !== null);
      const naive = i < h - 1 || w.length < Math.ceil(h / 2) ? null : w.reduce((a, b) => a + b, 0) / w.length;
      assert.ok(naive === null ? fast[i] === null : Math.abs(fast[i] - naive) < 1e-12, `h=${h} i=${i}`);
    });
  }
});
test('windowTest: p from non-overlapping windows (floored at 2/(nEff+1)); "since" over every earlier window', () => {
  const r = S.mulberry32(11), v = Array.from({ length: 120 }, (_, i) => 100 + r() + (i >= 117 ? 100 : 0));
  // a level jump two days ago: every window containing it overlaps the current 8-day window
  const h = 8, ch = S.changes(v, h, 'diff'), res = S.windowTest(ch, h);
  assert.equal(res.n, v.length - 2 * h);
  assert.equal(res.nEff, Math.floor(res.n / h));
  assert.ok(res.p >= 2 / (res.nEff + 1) - 1e-12);
  assert.equal(res.minP, 2 / (res.nEff + 1));
  // The 8-day change ending yesterday also contains the jump and is at least as large: it overlaps the
  // current window, so there is no record to report (review #25).
  assert.equal(res.inWindow, true);
  assert.ok(res.sinceIndex > v.length - 1 - h);
  for (let i = res.sinceIndex + 1; i < ch.length - 1; i++) assert.ok(!(ch[i] >= res.x), 'sinceIndex is the most recent at-least-as-extreme window');
  assert.ok(ch[res.sinceIndex] >= res.x);
  // A record: nothing earlier, overlapping or not, is as extreme.
  const w = v.slice(0, 117).concat([300]), rec = S.windowTest(S.changes(w, h, 'diff'), h);
  assert.deepEqual([rec.sinceIndex, rec.inWindow], [null, false]);
});
test('levelTest: a persistent series has a smaller effective sample than white noise', () => {
  const r = S.mulberry32(13);
  const iid = Array.from({ length: 400 }, () => gauss(r));
  let x = 0;
  const ar = Array.from({ length: 400 }, () => (x = 0.97 * x + gauss(r)));
  const a = S.levelTest(5, iid), b = S.levelTest(Math.max(...ar) + 1, ar);
  assert.ok(a.nEff > 200 && b.nEff < 20, `${a.nEff} ${b.nEff}`);
  assert.ok(b.p >= b.minP && b.minP >= 2 / 21);
});
test('changepoint (rank CUSUM) finds a level shift despite a launch outlier; early stop', () => {
  const x = Array.from({ length: 60 }, (_, i) => (i < 40 ? 0 : 1) + 0.1 * Math.sin(i * 1.7));
  x[0] = 1e9;
  const cp = S.changepoint(x);
  assert.equal(cp.index, 40);
  assert.ok(cp.p < 0.05);
  const noise = Array.from({ length: 60 }, (_, i) => (Math.sin(i * 12.9898) * 43758.5453) % 1);
  const full = S.changepoint(noise), early = S.changepoint(noise, { stopAbove: 0.5 });
  assert.ok(full.p > 0.05);
  if (full.p >= 0.5) assert.ok(early.p >= 0.5 && early.permutations <= full.permutations);
});
test('decompose: net, gross, rotation, contributions, shift-share', () => {
  const d = S.decompose({ A: 100, B: 50 }, { A: 60, B: 80 });
  assert.deepEqual([d.net, d.gross, d.rotation], [-10, 70, 30]);
  const a = d.parts.find((p) => p.key === 'A');
  assert.equal(a.contrib, 4);
  assert.ok(Math.abs(a.differential - (-40 - (100 / 150) * -10)) < 1e-9);
});
test('productDecomposition sums exactly; hhi / effectiveN', () => {
  const p = S.productDecomposition(0.04, 100, 0.05, 90);
  assert.ok(Math.abs(p.rateEffect + p.baseEffect + p.interaction - p.total) < 1e-12);
  assert.equal(S.effectiveN([1, 1, 1, 1]), 4);
  assert.equal(S.hhi([1, 0]), 1);
});
test('leadLag recovers a planted 2-step lead at the exact test resolution', () => {
  const rnd = S.mulberry32(3);
  const a = Array.from({ length: 200 }, () => rnd() - 0.5);
  const b = a.map((_, i) => (i >= 2 ? a[i - 2] : 0) + 0.1 * (rnd() - 0.5));
  const ll = S.leadLag(a, b, { maxLag: 4 });
  assert.equal(ll.lag, 2);
  assert.ok(ll.rho > 0.8);
  assert.equal(ll.p, ll.minP);
  assert.equal(ll.minP, 9 / 200); // (1 + 2*maxLag)/n: the max over 9 lags is shared by 9 shifts
});
test('null calibration: P(p < alpha) <= alpha (+ Monte Carlo slack) for every test family', () => {
  const slack = (a, k) => a + 3 * Math.sqrt((a * (1 - a)) / k); // 3 binomial SDs
  const rate = (ps, a) => ps.filter((p) => p < a).length / ps.length;
  const K = 200, win = [], lvl = [], cps = [], lls = [];
  for (let k = 0; k < K; k++) {
    const r = S.mulberry32(10000 + k);
    let x = 1e9;
    const walk = Array.from({ length: 300 }, () => (x += 1e7 * gauss(r)));
    for (const h of [1, 7, 30]) { const w = S.windowTest(S.changes(walk, h, 'log'), h); if (w) win.push(w.p); }
    let y = 0;
    const ar = Array.from({ length: 300 }, () => (y = 0.9 * y + gauss(r)));
    lvl.push(S.levelTest(ar[299], ar.slice(0, -1)).p);
    if (k < 120) cps.push(S.changepoint(Array.from({ length: 80 }, () => gauss(r))).p);
    if (k < 120) lls.push(S.leadLag(Array.from({ length: 150 }, () => gauss(r)), Array.from({ length: 150 }, () => gauss(r))).p);
  }
  for (const [name, ps] of [['windowTest', win], ['levelTest', lvl], ['changepoint', cps], ['leadLag', lls]]) {
    for (const a of [0.05, 0.2]) assert.ok(rate(ps, a) <= slack(a, ps.length), `${name}: P(p<${a}) = ${rate(ps, a)}`);
  }
});
test('repairChainSeries fills interior gaps and drops a synthetic final zero', () => {
  const r = S.repairChainSeries([{ t: 0, v: 5 }, { t: 2 * DAY, v: 6 }, { t: 10 * DAY, v: 0 }], DAY);
  assert.equal(r.points.length, 3);
  assert.deepEqual(r.notes.map((n) => n.kind), ['interior_gap_filled', 'tracking_ended']);
});
test('drawdown episodes, Poisson clusters, Pareto fronts', () => {
  const ep = S.drawdownEpisodes([10, 8, 12, 9, 9.5, 13, 6]);
  assert.equal(ep.completed.length, 2);
  assert.ok(Math.abs(ep.completed[1].depth - (9 / 12 - 1)) < 1e-12);
  assert.ok(Math.abs(ep.current.depth - (6 / 13 - 1)) < 1e-12);
  const firsts = [0, 40, 90, 150, 200, 200, 200, 200, 260, 300].map((d) => d * DAY);
  const cl = S.trackingClusters(firsts, DAY);
  assert.deepEqual(cl.map((c) => [c.date / DAY, c.count]), [[200, 4]]);
  assert.ok(Math.abs(S.poissonTail(2, 0.5) - (1 - Math.exp(-0.5) * 1.5)) < 1e-12);
  const fr = S.paretoFronts([[5, 0.1, 0], [3, 0.2, 0], [2, 0.05, 0], [1, 0.01, -20]], (x) => x);
  assert.deepEqual(fr, [1, 1, 2, 3]);
});
test('format helpers (no unit rollover: $1.0M not $1000K; T tier) (review #54)', () => {
  assert.deepEqual([F.usd(1.234e9), F.usd(-5.06e6), F.susd(12000), F.usd(950), F.pct(0.0512), F.pct(-0.1), F.bp(0.00123), F.sbp(-0.0005), F.date(T0), F.share(0.5, 0)],
    ['$1.23B', '-$5.1M', '+$12K', '$950', '+5.1%', '-10.0%', '12.3bp', '-5.0bp', '2024-01-01', '50%']);
  assert.deepEqual([F.usd(999999), F.usd(999.96e6), F.usd(1.2e12), F.usd(999.6), F.usd(-999999), F.usd(-0.2)], ['$1.0M', '$1.00B', '$1.20T', '$1K', '-$1.0M', '$0']);
  assert.deepEqual([F.shareSig(0.0001004), F.shareSig(0.0188), F.shareSig(0.5)], ['0.0100%', '1.88%', '50.0%']);
  assert.equal(F.list(['a', 'b', 'c']), 'a, b and c');
  assert.equal(F.pegLabel('peggedUSD'), 'USD');
});

// ---------- 2. engine logic ----------
const T = (o) => ({ detector: 'x.y', dimension: 'supply', asset: 'AAA', chain: null, window: '1d', direction: -1, good: 1, materialityUsd: 1e9, stat: { p: 0.5 }, group: 'g', otherWindows: [], ...o });
test('evaluate: E = m*p, notable iff E < 1, underpowered tests are not counted, polarity', () => {
  const ts = [T({ stat: { p: 0.2, minP: 0.01 } }), T({ stat: { p: 0.3, minP: 0.3 } }), T({ stat: { p: 0.01 }, good: 0 }), T({ stat: { p: 0.4 }, direction: 1 })];
  E.evaluate(ts, E.familySizes(ts));
  // minP 0.3 x 4 >= 1: underpowered, left out of the count (m = 3) and judged at the size that excluded it.
  assert.equal(ts[0].m, 3);
  assert.ok(Math.abs(ts[0].E - 0.6) < 1e-12);
  assert.deepEqual(ts.map((t) => t.notable), [true, false, true, false]);
  assert.deepEqual(ts.map((t) => t.underpowered), [false, true, false, false]);
  assert.ok(ts[1].E >= 1 && ts[1].m === 4, 'an underpowered test reports E >= 1');
  assert.deepEqual(ts.map((t) => t.polarity), ['negative', 'negative', 'neutral', 'positive']);
});
test('family = dimension pooled across assets, m_eff = max(m_dimension, round(M/D)), underpowered tests excluded (review #19, #64, #65)', () => {
  // Two assets in one dimension share one family (a per-cell family would give m = 2 each).
  const pooled = [...Array.from({ length: 2 }, () => T({ asset: 'AAA' })), ...Array.from({ length: 2 }, () => T({ asset: 'BBB' }))];
  const f1 = E.familySizes(pooled);
  assert.deepEqual(f1.m, { supply: 4 });
  // A small dimension is judged like an average one: 30 market tests and 2 economics tests -> 16 each.
  const mixed = [...Array.from({ length: 30 }, () => T({ dimension: 'market', stat: { p: 0.5, minP: 0.001 } })), ...Array.from({ length: 2 }, () => T({ dimension: 'economics', stat: { p: 0.08, minP: 0.001 } }))];
  const f2 = E.familySizes(mixed);
  assert.deepEqual(f2.m, { market: 30, economics: 16 });
  E.evaluate(mixed, f2);
  assert.ok(mixed.filter((t) => t.dimension === 'economics').every((t) => !t.notable && Math.abs(t.E - 1.28) < 1e-9), 'p = 0.08 is not notable in a 2-test dimension');
  // Tests that can never reach significance do not raise anyone's threshold.
  const dead = Array.from({ length: 200 }, () => T({ dimension: 'chains', stat: { p: 0.9, minP: 0.5 } }));
  const f3 = E.familySizes([...mixed, ...dead]);
  assert.equal(f3.m.market, 30);
  assert.equal(f3.family.underpowered.chains, 200);
  assert.equal(f3.family.M, 32);
});
test('materiality filter: a notable but immaterial test never reaches feed or standing (review #19)', () => {
  const isMat = E.materialIn({ AAA: 1e6 });
  assert.equal(isMat(T({ materialityUsd: 5e5 })), false);
  assert.equal(isMat(T({ materialityUsd: 2e6 })), true);
  assert.equal(isMat(T({ materialityUsd: null })), true);
  const r = S.mulberry32(77), n = 300, t = daysFrom(n);
  let x = 1e8;
  const sup = t.map((_, i) => (x += 2e5 * gauss(r) + (i === n - 1 ? 3e6 : 0)));
  const res = runOn(mkModel([mkAsset('AAA', { t, supply: sup })]));
  for (const k of [...res.clusters.flatMap((c) => [c.lead, ...c.related]), ...res.standing]) assert.ok(!(k.materialityUsd < res.floors[k.asset]), `${k.id} below its floor`);
});
test('regime collapse: the most recent notable split wins over an older, more surprising one (review #19)', () => {
  const g = (o) => T({ group: 'r|AAA', preferLatest: true, ...o });
  const ts = [g({ window: 'since a', stat: { p: 0.0001 }, ageDays: 400, eventKey: 'a' }), g({ window: 'since b', stat: { p: 0.01 }, ageDays: 20, eventKey: 'b' }), g({ window: 'since c', stat: { p: 0.9 }, ageDays: 5, eventKey: 'c' })];
  E.evaluate(ts, { supply: 10 });
  const [c] = E.collapseGroups(ts, () => true);
  assert.equal(c.eventKey, 'b');
});
test('collapseGroups: material+powered beats lower E elsewhere; other windows kept', () => {
  const ts = [T({ window: '1d', stat: { p: 0.001 }, materialityUsd: 1 }), T({ window: '7d', stat: { p: 0.02 } }), T({ window: '30d', stat: { p: 0.01, minP: 0.9 } })];
  E.evaluate(ts, E.familySizes(ts));
  const [c] = E.collapseGroups(ts, (t) => t.materialityUsd >= 10);
  assert.equal(c.window, '7d');
  assert.deepEqual(c.otherWindows.map((o) => o.window).sort(), ['1d', '30d']);
});
test('paretoRank orders fronts, then adjusted surprise', () => {
  const it = [{ id: 'c', adjustedBits: 2, materialityShare: 0.05, ageDays: 0 }, { id: 'b', adjustedBits: 3, materialityShare: 0.2, ageDays: 0 }, { id: 'a', adjustedBits: 5, materialityShare: 0.1, ageDays: 0 }, { id: 'd', adjustedBits: 1, materialityShare: 0.01, ageDays: 20 }];
  assert.deepEqual(E.paretoRank(it).map((t) => t.id + t.front), ['a1', 'b1', 'c2', 'd3']);
});
test('cluster: one card per root cause (shared driver, or same asset moving the same way)', () => {
  const items = [
    T({ id: 1, detector: 'supply.move', drivers: [{ asset: 'AAA', chain: 'Chain X', usd: -3e8 }, { asset: 'AAA', chain: 'Chain Y', usd: 1e8 }] }),
    T({ id: 2, detector: 'chain.attribution', dimension: 'chains', drivers: [{ asset: 'AAA', chain: 'Chain X', usd: -3.1e8 }] }),
    T({ id: 3, detector: 'market.peer_growth', dimension: 'market', drivers: null, direction: -1 }),
    T({ id: 4, detector: 'portfolio.mix', dimension: 'portfolio', asset: 'Paxos USD', drivers: [{ asset: 'AAA', chain: null, usd: -2e8 }, { asset: 'BBB', chain: null, usd: 5e7 }] }),
    T({ id: 5, detector: 'peg.regime', dimension: 'peg', drivers: null, direction: 1 }),
    T({ id: 6, detector: 'chain.move', dimension: 'chains', drivers: [{ asset: 'AAA', chain: 'Chain Y', usd: 1e8 }], direction: 1 }),
  ];
  const cl = E.cluster(items);
  assert.deepEqual(cl.map((c) => [c.lead.id, c.related.map((x) => x.id)]), [[1, [2, 3, 4]], [5, []], [6, []]]);
  assert.equal(cl[0].rootKey, 'AAA|Chain X|-1');
});
test('health grid states and evidence', () => {
  const mkc = (o) => ({ ...T(o), id: o.id || 'i', headline: 'h', p: 0.01, E: 0.1, adjustedBits: 3, otherWindows: [], material: true, notable: false, underpowered: false, polarity: 'neutral', ...o });
  const h = E.healthGrid([
    mkc({ dimension: 'supply', notable: true, polarity: 'negative', id: 'neg' }), mkc({ dimension: 'supply', notable: true, polarity: 'positive' }),
    mkc({ dimension: 'market', notable: true, polarity: 'positive', id: 'pos' }), mkc({ dimension: 'peg', notable: true, polarity: 'neutral' }),
    mkc({ dimension: 'chains' }), mkc({ dimension: 'usage', underpowered: true }), mkc({ dimension: 'defi', notable: true, material: false }),
    mkc({ dimension: 'data', context: true }),
  ], ['AAA']);
  const st = Object.fromEntries(h.dimensions.map((d) => [d, h.cells.AAA[d].state]));
  assert.deepEqual(st, { supply: 'notable_negative', market: 'notable_positive', chains: 'within_own_history', peg: 'notable_neutral', defi: 'within_own_history', usage: 'insufficient_history', portfolio: 'no_data', economics: 'no_data', data: 'no_data' });
  assert.equal(h.cells.AAA.supply.evidence.id, 'neg');
  assert.equal(h.cells.AAA.supply.tests, 2);
  assert.deepEqual(h.dimensions, ['supply', 'market', 'chains', 'peg', 'defi', 'usage', 'portfolio', 'economics', 'data']);
});
test('novelty: re-runs only the firing detector, stops after a native week without firing, debounces gaps', () => {
  const cases = [[[0], 0, 7], [[0, 1, 2], 2, 9], [[0, 1, 2, 5, 6], 6, 13], [[0, 10], 0, 7], [Array.from({ length: 41 }, (_, i) => i), 30, 30]];
  for (const [fires, age, reruns] of cases) {
    const set = new Set(fires), calls = [];
    const det = { id: 'fake.det', backtest: true, fn: (model, opts) => { calls.push(opts); return [T({ detector: 'fake.det', group: 'fake|AAA', stat: { p: set.has(opts.cut || 0) ? 0.001 : 1 } })]; } };
    const [t] = det.fn(null, {});
    t.source = 'fake.det';
    E.evaluate([t], { supply: 1 });
    const res = E.novelty({}, [t], { supply: 1 }, () => true, 0, [det]);
    assert.equal(t.ageDays, age, `fires ${fires}`);
    assert.equal(res.reruns, reruns, `fires ${fires}`);
    assert.ok(calls.slice(1).every((o) => o.assets && o.assets.has('AAA') && o.assets.size === 1 && o.cut >= 1));
  }
});

test('errors are isolated per detector, including during novelty re-runs', () => {
  const ok = { id: 'ok.det', backtest: true, fn: () => [T({ detector: 'ok.det', group: 'ok|AAA', stat: { p: 0.001 } })] };
  const bad = { id: 'bad.det', backtest: true, fn: (m, o) => { if (o.cut) throw new Error('boom at ' + o.cut); return [T({ detector: 'bad.det', group: 'bad|AAA', stat: { p: 0.001 } })]; } };
  const worse = { id: 'worse.det', fn: () => { throw new Error('always'); } };
  const r = E.runDetectors({}, { now: 0 }, [ok, bad, worse]);
  assert.equal(r.tests.length, 2);
  assert.deepEqual(r.errors.map((e) => e.detector), ['worse.det']);
  E.evaluate(r.tests, E.familySizes(r.tests));
  const nov = E.novelty({}, r.tests, E.familySizes(r.tests), () => true, 0, [ok, bad]);
  assert.ok(nov.errors.length >= 1 && nov.errors.every((e) => e.detector === 'bad.det' && e.cut >= 1 && e.assets[0] === 'AAA'));
  assert.equal(r.tests.find((t) => t.source === 'ok.det').ageDays, 30);
});

// ---------- 3. detectors on synthetic series with planted events ----------
const runOn = (model) => E.run(model, { now: model.now });
const notableOf = (res) => res.collapsed.filter((t) => t.notable && t.material);

test('level shift: growth regime detected at the planted date with p at its resolution floor', () => {
  const r = S.mulberry32(21), n = 420, t = daysFrom(n), brk = 300;
  let x = 1e8;
  const sup = t.map((_, i) => (x *= 1 + (i < brk ? 0.003 : -0.002) + 0.001 * gauss(r)));
  const res = D.DETECTORS.find((d) => d.id === 'supply.regime').fn(mkModel([mkAsset('AAA', { t, supply: sup })]), { now: t[n - 1] });
  const best = res.slice().sort((x, y) => x.stat.p - y.stat.p)[0]; // what the engine's collapse shows
  assert.ok(Math.abs(best.ageDays - (n - 1 - brk)) <= 7, `age ${best.ageDays}`);
  assert.ok(best.stat.p <= 2 * best.stat.minP && best.stat.p < 0.05, `p ${best.stat.p}`);
  assert.equal(best.direction, -1);
});
test('peg level shift: deviation regime detected with small p', () => {
  const r = S.mulberry32(22), n = 400, t = daysFrom(n);
  const price = t.map((_, i) => 1 - (i < 340 ? 0.0005 : 0.003) * Math.abs(gauss(r)) - (i < 340 ? 0 : 0.002));
  const res = D.DETECTORS.find((d) => d.id === 'peg.regime').fn(mkModel([mkAsset('AAA', { t, supply: t.map(() => 1e8), price })]), { now: t[n - 1] });
  const best = res.slice().sort((x, y) => x.stat.p - y.stat.p)[0];
  assert.ok(Math.abs(best.ageDays - (n - 1 - 340)) <= 3, `age ${best.ageDays}`);
  assert.ok(best.stat.p < 0.01 && best.direction === 1, `p ${best.stat.p}`);
});
test('pure noise: false alarms stay within the rule (< 1 notable per cell) across 20 seeds', () => {
  let notable = 0, cells = 0, strong = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const res = runOn(mkModel([noiseAsset('AAA', seed)], { market: noiseMarket(seed) }));
    cells += Object.keys(res.m).length;
    notable += notableOf(res).length;
    strong += notableOf(res).filter((t) => t.E < 0.01).length;
    assert.deepEqual(res.errors, []);
  }
  // E = m*p < 1 bounds the EXPECTED number of chance findings per dimension at 1; calibrated, floored
  // p-values keep the realised rate below it. "Nothing at all" is not a property any calibrated rule can
  // promise; nothing at E < 0.01 is.
  assert.ok(notable / cells < 1, `${notable} notable in ${cells} cells`);
  assert.ok(notable / cells < 0.75, `${notable} notable in ${cells} cells`);
  assert.equal(strong, 0);
});
test('pure noise, three assets with persistent peg deviations: fewer than one chance finding per counted dimension (review #64, #65)', () => {
  let perDim = 0, strong = 0;
  const K = 10;
  for (let seed = 1; seed <= K; seed++) {
    const n = 700, assets = ['AAA', 'BBB', 'CCC'].map((k, j) => {
      const a = noiseAsset(k, seed + 1000 * j, n), r = S.mulberry32(seed + 77 * j);
      let e = 0;
      a.priceDaily = { t: a.supply.t, v: a.supply.t.map(() => 1 + 0.0005 * (e = 0.6 * e + 0.8 * gauss(r))) };
      return a;
    });
    const res = runOn(mkModel(assets, { market: noiseMarket(seed, n) }));
    const found = notableOf(res);
    perDim += found.length / res.family.D / K;
    strong += found.filter((t) => t.E < 0.01).length;
  }
  assert.ok(perDim < 0.75, `${perDim.toFixed(2)} chance findings per counted dimension per load`);
  assert.equal(strong, 0);
});
test('dust chain move is not tested, not material and folded into "Other chains"', () => {
  const m = richModel(), res = runOn(m);
  assert.ok(!res.collapsed.some((t) => t.chain === 'Dust' && (t.detector === 'chain.move' || t.detector === 'chain.dominance')));
  assert.ok(!notableOf(res).some((t) => t.chain === 'Dust' || (t.drivers || []).some((d) => d.chain === 'Dust' && Math.abs(d.usd) >= res.floors.AAA)));
  const w = A.attribution(m).windows.d1;
  assert.ok(!w.chains.some((c) => c.chain === 'Dust'));
  assert.ok(w.chains.some((c) => c.asset === 'AAA' && c.chain === A.OTHER));
});
test('overlapping windows: a jump inside the current window never yields "largest since <inside it>"', () => {
  const r = S.mulberry32(23), n = 300, t = daysFrom(n);
  let x = 1e8;
  const sup = t.map((_, i) => (x += 2e5 * gauss(r) + (i === n - 3 ? 3e7 : 0)));
  const tests = D.DETECTORS.find((d) => d.id === 'supply.move').fn(mkModel([mkAsset('AAA', { t, supply: sup })]), { now: t[n - 1] });
  assert.ok(tests.length >= 6);
  for (const k of tests) {
    const since = /since (\d{4}-\d{2}-\d{2})/.exec(k.headline);
    if (since) assert.ok(Date.parse(since[1]) / 1000 <= t[n - 1 - k.horizon], `${k.window}: ${k.headline}`);
    assert.ok(k.stat.p >= 2 / (k.stat.nEff + 1) - 1e-12);
    assert.equal(k.stat.nEff, Math.max(1, Math.floor((n - 2 * k.horizon) / k.horizon)));
  }
});
test('wind-down: the deepest drawdown is a standing condition, not a new finding every day', () => {
  const r = S.mulberry32(24), n = 420, t = daysFrom(n);
  let x = 1e8;
  const sup = t.map((_, i) => (x *= 1 + (i < 300 ? 0.003 : -0.012) + (i < 300 ? 0.012 : 0.004) * gauss(r)));
  const res = runOn(mkModel([mkAsset('AAA', { t, supply: sup })]));
  const dd = res.collapsed.find((k) => k.detector === 'supply.drawdown' && k.asset === 'AAA');
  assert.ok(dd && dd.notable && dd.material, 'the wind-down drawdown is notable');
  assert.match(dd.headline, /deeper than all \d+ earlier drawdowns/);
  assert.equal(dd.ageDays, 30);
  assert.equal(dd.isNew, false);
  assert.ok(res.standing.includes(dd));
  assert.ok(!res.clusters.some((c) => c.lead === dd || c.related.includes(dd)));
});
test('tracking change today: coverage step is flagged and not read as issuance', () => {
  const r = S.mulberry32(25), n = 300, t = daysFrom(n);
  const walk = (s) => { let y = s; return t.map(() => (y += s * 0.002 * gauss(r))); };
  const big = walk(5e8), mid = walk(2e8), one = walk(1e7);
  const late = (v) => ({ t: [t[n - 1]], v: [v] });
  const chains = { 'Chain A': big, 'Chain B': mid, 'Chain C': { t: t.slice(120), v: one.slice(120) }, 'Chain D': late(1e7), 'Chain E': late(1.2e7), 'Chain F': late(9e6), 'Chain G': late(1.1e7) };
  const sup = t.map((_, i) => big[i] + mid[i] + (i >= 120 ? one[i] : 0) + (i === n - 1 ? 4.2e7 : 0));
  const res = runOn(mkModel([mkAsset('AAA', { t, supply: sup, chains })]));
  assert.ok(res.collapsed.some((k) => k.detector === 'dq.tracking_change' && k.metric === 'chain_start_cluster' && k.window === F.date(t[n - 1])));
  const mv = res.collapsed.find((k) => k.detector === 'supply.move' && k.asset === 'AAA');
  assert.ok(!mv.notable || mv.window !== '1d', `1-day move read as issuance: ${mv.headline}`);
  const raw = S.windowTest(S.changes(sup, 1, 'log'), 1);
  assert.ok(raw.pEmp <= 2 / raw.n + 1e-12, 'without the adjustment the step would be the most extreme day');
});
test('phantom dips: a chain that is one day late does not read as an outflow', () => {
  const r = S.mulberry32(26), n = 200, t = daysFrom(n);
  const a = t.map(() => 3e8 + 1e6 * gauss(r)), b = t.map(() => 2e8 + 1e6 * gauss(r));
  const m = mkModel([mkAsset('AAA', { t, supply: t.map((_, i) => a[i] + b[i]), chains: { 'Chain A': a, 'Chain B': { t: t.slice(0, -1), v: b.slice(0, -1) } } })]);
  const p = D.helpers.chainPanel(m, m.assets[0]);
  assert.equal(p.days[p.days.length - 1], t[n - 2]);
  const w = A.attribution(m).windows.d1;
  const rowB = w.chains.find((c) => c.chain === 'Chain B');
  assert.ok(Math.abs(rowB.deltaUsd) < 1e7, `phantom outflow ${rowB.deltaUsd}`);
});
test('dead assets only produce dq.frozen', () => {
  const res = runOn(richModel());
  const dead = res.collapsed.filter((k) => k.asset === 'OLD');
  assert.ok(dead.length === 1 && dead[0].detector === 'dq.frozen');
});

// ---------- 4. schema, determinism, timing ----------
const INSIGHT_KEYS = ['id', 'detector', 'asset', 'chain', 'dimension', 'polarity', 'surprise', 'materialityUsd', 'materialityShare', 'materialityFloorUsd', 'novelty', 'headline', 'detail', 'evidence', 'drivers', 'asOf'];
const numOrNull = (x) => x === null || (typeof x === 'number' && Number.isFinite(x));
const ADVICE = /\b(investigate|recommend\w*|should|consider|verify|we suggest|you may want)\b/i;
function validateInsight(x) {
  const where = x && x.id;
  assert.deepEqual(Object.keys(x).sort(), [...INSIGHT_KEYS].sort(), where);
  for (const k of ['id', 'detector', 'asset', 'headline', 'detail']) assert.ok(typeof x[k] === 'string' && x[k].length, `${where} ${k}`);
  assert.ok(x.chain === null || typeof x.chain === 'string');
  assert.ok(E.DIMENSIONS.includes(x.dimension), where);
  assert.ok(['positive', 'negative', 'neutral'].includes(x.polarity), where);
  assert.deepEqual(Object.keys(x.surprise).sort(), ['E', 'adjustedBits', 'bits', 'm', 'notable', 'p', 'underpowered']);
  assert.ok(x.surprise.p > 0 && x.surprise.p <= 1 && Number.isInteger(x.surprise.m) && x.surprise.m >= 1, where);
  assert.ok(Math.abs(x.surprise.E - x.surprise.m * x.surprise.p) <= 1e-3 * Math.max(1, x.surprise.E), where);
  assert.equal(x.surprise.notable, x.surprise.E < 1, where);
  for (const k of ['bits', 'adjustedBits']) assert.ok(numOrNull(x.surprise[k]));
  assert.ok(x.materialityUsd === null || Number.isInteger(x.materialityUsd));
  assert.ok(numOrNull(x.materialityShare) && (x.materialityFloorUsd === null || Number.isInteger(x.materialityFloorUsd)));
  assert.deepEqual(Object.keys(x.novelty).sort(), ['ageDays', 'front', 'isNew']);
  assert.ok((x.novelty.ageDays === null || Number.isInteger(x.novelty.ageDays)) && typeof x.novelty.isNew === 'boolean' && (x.novelty.front === null || Number.isInteger(x.novelty.front)));
  const ev = x.evidence, evKeys = ['baseline', 'metric', 'n', 'nEff', 'otherWindows', 'stat', 'value', 'window'];
  assert.deepEqual(Object.keys(ev).filter((k) => k !== 'series').sort(), evKeys, where);
  assert.ok(typeof ev.metric === 'string' && typeof ev.window === 'string' && typeof ev.stat === 'string', where);
  for (const k of ['value', 'baseline', 'n', 'nEff']) assert.ok(numOrNull(ev[k]), `${where} evidence.${k}`);
  assert.ok(Array.isArray(ev.otherWindows) && ev.otherWindows.every((o) => Object.keys(o).sort().join() === 'p,window' && typeof o.window === 'string' && o.p > 0 && o.p <= 1));
  if ('series' in ev) {
    assert.deepEqual(Object.keys(ev.series).sort(), ['start', 'values']);
    assert.match(ev.series.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(ev.series.values.length >= 2 && ev.series.values.length <= 120 && ev.series.values.every((v) => typeof v === 'number' && Number.isFinite(v)), where);
  }
  assert.ok(x.drivers === null || (Array.isArray(x.drivers) && x.drivers.length && x.drivers.every((d) => Object.keys(d).sort().join() === 'asset,chain,usd' && typeof d.asset === 'string' && (d.chain === null || typeof d.chain === 'string') && Number.isInteger(d.usd))), where);
  assert.ok(x.asOf === null || (typeof x.asOf === 'string' && Number.isFinite(Date.parse(x.asOf))), where);
  for (const s of [x.headline, x.detail]) {
    assert.ok(!/NaN|undefined|Infinity|\[object/.test(s), `${where}: ${s}`);
    assert.ok(!ADVICE.test(s), `advice wording in ${where}: ${s}`);
  }
}
test('engine output shape and toInsight schema on a synthetic model that exercises every detector', () => {
  const m = richModel(), t0 = performance.now(), res = runOn(m), ms = performance.now() - t0;
  assert.deepEqual(res.errors, []);
  for (const k of ['m', 'testsRun', 'groups', 'errors', 'timingsMs', 'clusters', 'standing', 'watch', 'context', 'health', 'paxosUsd', 'floors', 'collapsed']) assert.ok(k in res, k);
  assert.ok(Number.isFinite(res.timingsMs.detectors) && Number.isFinite(res.timingsMs.novelty));
  assert.ok(res.watch.length <= 40);
  perf(ms < 3000, `engine on the rich model ${ms} ms`);
  const produced = new Set(res.collapsed.map((k) => k.source));
  const missing = D.DETECTORS.map((d) => d.id).filter((id) => !produced.has(id));
  assert.deepEqual(missing, [], 'every detector produced at least one test');
  const all = [...res.clusters.flatMap((c) => [c.lead, ...c.related]), ...res.standing, ...res.watch, ...res.context, ...res.collapsed].map(E.toInsight);
  all.forEach(validateInsight);
  assert.ok(new Set(res.collapsed.map((k) => k.id)).size === res.collapsed.length, 'ids are unique');
  for (const c of res.clusters) assert.ok(typeof c.rootKey === 'string' && c.lead && Array.isArray(c.related));
  const h = res.health;
  assert.deepEqual(h.dimensions, E.DIMENSIONS);
  assert.equal(h.assets[0], 'Paxos USD');
  for (const a of h.assets) for (const d of h.dimensions) {
    const c = h.cells[a][d];
    assert.ok(['notable_negative', 'notable_positive', 'notable_neutral', 'within_own_history', 'insufficient_history', 'no_data'].includes(c.state));
    assert.ok(c.evidence === null || (typeof c.evidence.id === 'string' && typeof c.evidence.headline === 'string'));
  }
});
test('deterministic: two runs give identical insights', () => {
  const strip = (res) => JSON.stringify(res.collapsed.map(E.toInsight));
  assert.equal(strip(runOn(richModel())), strip(runOn(richModel())));
});
test('attribution: assets and chains add up exactly in every window', () => {
  const w = A.attribution(richModel()).windows;
  assert.deepEqual(Object.keys(w), ['d1', 'd7', 'd30', 'd90', 'd365', 'all']);
  for (const [k, x] of Object.entries(w)) {
    assert.match(x.from, /^\d{4}-\d{2}-\d{2}$/);
    const sa = x.assets.reduce((s, a) => s + a.deltaUsd, 0);
    assert.ok(Math.abs(sa - x.totalDeltaUsd) <= x.assets.length, k);
    for (const a of x.assets) {
      const rows = x.chains.filter((c) => c.asset === a.asset);
      assert.ok(Math.abs(rows.reduce((s, c) => s + c.deltaUsd, 0) - a.deltaUsd) <= rows.length + 1, `${k} ${a.asset}`);
      assert.ok(Math.abs(rows.reduce((s, c) => s + c.currUsd, 0) - a.currUsd) <= rows.length + 1, `${k} ${a.asset}`);
    }
    assert.ok(x.grossUsd >= Math.abs(x.totalDeltaUsd) - 1 && x.rotationUsd >= 0, k);
  }
  assert.ok(!w.d30.assets.some((a) => a.asset === 'OLD' || a.asset === 'GLD'), 'only active USD stablecoins (the aggregate members)');
});

// Optional integration: the data layer's recorded upstream fixture, replayed offline (skipped when the
// data layer or fixture is absent, or fails on its own; engine failures on it are real failures).
let fixture;
async function fixtureModel() {
  if (fixture === undefined) {
    try {
      const { createFixtureFetch, DEFAULT_FIXTURE } = await import('./fixtures/paxos/fixture-fetch.mjs');
      const { collectRaw } = require('../lib/paxos/sources.js');
      const { createCache } = require('../lib/paxos/cache.js');
      const { buildModel } = require('../lib/paxos/model.js');
      const fetch = createFixtureFetch(DEFAULT_FIXTURE);
      fixture = { model: buildModel(await collectRaw({ fetch, now: fetch.now, cache: createCache(), budgetMs: 20000 }), { now: fetch.now }) };
    } catch (e) {
      fixture = { error: e };
    }
  }
  return fixture;
}
let fixtureRes;
async function fixtureRun() {
  const fx = await fixtureModel();
  if (!fx.model) return [];
  if (!fixtureRes) fixtureRes = runOn(fx.model);
  return [fixtureRes];
}
test('recorded upstream fixture through the data layer: engine runs clean and fast, insights valid', async (t) => {
  const fx = await fixtureModel(), model = fx.model;
  if (!model) {
    t.skip('data layer / fixture unavailable: ' + (fx.error && fx.error.message));
    return;
  }
  const t0 = performance.now(), res = runOn(model), ms = performance.now() - t0;
  assert.deepEqual(res.errors, []);
  perf(ms < 3000, `engine on the fixture ${ms} ms`);
  assert.ok(res.testsRun > 100 && res.health.assets.length > 1);
  [...res.clusters.flatMap((c) => [c.lead, ...c.related]), ...res.standing, ...res.watch, ...res.context].map(E.toInsight).forEach(validateInsight);
  for (const w of Object.values(A.attribution(model).windows)) {
    assert.ok(Math.abs(w.assets.reduce((x, a) => x + a.deltaUsd, 0) - w.totalDeltaUsd) <= w.assets.length);
    assert.ok(Math.abs(w.chains.reduce((x, c) => x + c.deltaUsd, 0) - w.totalDeltaUsd) <= w.chains.length + w.assets.length);
  }
});

// ---------- 6. regressions for the review findings (numbers refer to the review) ----------
const detFn = (id) => D.DETECTORS.find((d) => d.id === id).fn;
const arPath = (phi, n, r) => { let v = 0; const out = []; for (let i = 0; i < n + 300; i++) { v = phi === 1 ? v + gauss(r) : phi * v + gauss(r); if (i >= 300) out.push(v); } return out; };
const slackOf = (a, k) => a + 3 * Math.sqrt((a * (1 - a)) / k);

test('#8 changepoint null keeps the series persistence: AR(0.6), AR(0.95), random walk stay calibrated; clean breaks are found', () => {
  const K = 80;
  for (const [phi, n] of [[0.6, 300], [0.95, 400], [1, 400]]) {
    const ps = [];
    for (let k = 0; k < K; k++) { const c = S.changepoint(arPath(phi, n, S.mulberry32(5000 + 31 * k + n)), { minSeg: 8, permutations: 199, rand: S.mulberry32(k + 1) }); ps.push(c ? c.p : 1); }
    for (const a of [0.05, 0.2]) { const rate = ps.filter((p) => p < a).length / K; assert.ok(rate <= slackOf(a, K), `AR(${phi}) n=${n}: P(p<${a}) = ${rate}`); }
  }
  // Power is kept for genuine breaks, including a clean step in a short series (whose whole-series
  // persistence would otherwise read as "untestable").
  let hits = 0;
  for (let k = 0; k < 20; k++) { const x = arPath(0.3, 60, S.mulberry32(900 + k)); for (let i = 43; i < 60; i++) x[i] += 4 / Math.sqrt(1 - 0.09); if (S.changepoint(x, { minSeg: 8, rand: S.mulberry32(k) }).p <= 0.01) hits++; }
  assert.ok(hits >= 16, `clean break found in ${hits}/20`);
  // A random walk is untestable rather than a break.
  const rw = S.changepoint(arPath(1, 1100, S.mulberry32(3)), { minSeg: 8 });
  assert.ok(rw.untestable && rw.p === 1 && rw.minP === 1);
});
test('#8 economics.rate_regime: a T-bill-like near-random-walk yield produces no regime finding', () => {
  const n = 500, t = daysFrom(n), r = S.mulberry32(8);
  let y = 0.04;
  const rate = t.map(() => (y = Math.max(0.001, y + 0.0004 * gauss(r) * (r() < 0.05 ? 5 : 1))));
  const sup = t.map(() => 1e9);
  const a = mkAsset('AAA', { t, supply: sup, feeModelled: true }), b = mkAsset('BBB', { t, supply: sup.map((x) => x / 2), feeModelled: true });
  const fees = { series: { t, v: t.map((_, i) => (1.5e9 * rate[i]) / 365) }, total24h: 1, total1y: 1, labels: [] };
  const tests = detFn('economics.rate_regime')(mkModel([a, b], { fees }), { now: t[n - 1] + DAY });
  assert.ok(tests.every((k) => k.stat.p * 10 >= 1), tests.map((k) => `${k.window} p=${k.stat.p}`).join('; '));
});

test('#9 market.peer_growth: p counts coins; an ordinary move of a small coin among volatile peers is not rare', () => {
  const r = S.mulberry32(9), n = 60, t = daysFrom(n);
  const row = (id, cur, g) => ({ id, symbol: 'P' + id, name: 'P' + id, gecko_id: 'p' + id, pegType: 'peggedUSD', pegMechanism: 'fiat-backed', price: 1, circulating: { peggedUSD: cur }, circulatingPrevDay: { peggedUSD: cur / (1 + g / 7) }, circulatingPrevWeek: { peggedUSD: cur / (1 + g) }, circulatingPrevMonth: { peggedUSD: cur / (1 + 3 * g) } });
  const peers = [row('1', 1.8e11, 0.001), row('2', 7.5e10, 0.002), ...Array.from({ length: 298 }, (_, i) => row(String(10 + i), 1e6 * (1 + 100 * r()), 0.05 * gauss(r)))];
  const me = row('999', 2.6e7, -0.071);
  const a = mkAsset('AAA', { t, supply: t.map(() => 2.6e7), llamaId: '999', list: me });
  const tests = detFn('market.peer_growth')(mkModel([a], { list: { peggedAssets: [...peers, me], chains: [] } }), { now: t[n - 1] });
  const w7 = tests.find((k) => k.window === '7d');
  const others = peers.map((x) => x.circulating.peggedUSD / x.circulatingPrevWeek.peggedUSD - 1);
  assert.ok(Math.abs(w7.stat.p - S.empiricalP(me.circulating.peggedUSD / me.circulatingPrevWeek.peggedUSD - 1, others)) < 1e-12);
  assert.ok(w7.stat.p > 0.05, `p ${w7.stat.p}`); // the dollar-weighted p was ~0.003 here: the two giants grew
  assert.equal(w7.stat.minP, 2 / (others.length + 1));
  assert.match(w7.headline, /slower than \d+% of 300 live USD stablecoins/);
});

function pegModel({ consensus = false, badPrint = true, sibStress = false } = {}) {
  const r = S.mulberry32(27), n = 400, t = daysFrom(n);
  const implied = t.map(() => 1 - 0.001 - 0.0004 * gauss(r));
  const coins = implied.map((x, i) => (badPrint && i === n - 4 ? 1.08 : x + 0.00005 * gauss(r)));
  const cons = implied.map((x) => x + 0.0002);
  const a = mkAsset('AAA', { t, supply: t.map(() => 3.4e7), price: implied, priceLlamaDaily: { t, v: coins }, ...(consensus ? { priceConsensus: { t, v: cons } } : {}) });
  const sibPx = t.map(() => (sibStress ? 0.995 : 1) + 0.0001 * gauss(r));
  const b = mkAsset('BBB', { t, supply: t.map(() => 1e9), price: sibPx, priceLlamaDaily: { t, v: sibPx } });
  const c = mkAsset('CCC', { t, supply: t.map(() => 1e9), price: sibPx, priceLlamaDaily: { t, v: sibPx } });
  const peer = { symbol: 'PEER', geckoId: 'peer', llamaId: '7', share: 0.6, hourly: null, daily: { t, v: t.map(() => 1 + 0.0002 * gauss(r)) } };
  return { m: mkModel([a, b, c], { pegPeers: [peer] }), t, n, cons };
}
test('#2 #6 #7 #27 peg.deviation: one bad single-source print cannot drive a finding; the consensus price is used when present', () => {
  const { m, t, n } = pegModel();
  const tests = detFn('peg.deviation')(m, { now: t[n - 1] }).filter((k) => k.asset === 'AAA');
  assert.ok(tests.length);
  for (const k of tests) {
    assert.ok(k.stat.p > 0.05, `${k.variant} ${k.window}: p ${k.stat.p} from a single bad print`);
    assert.ok(!/\b(7|8)\d\d\.\dbp/.test(k.headline), k.headline);
  }
  const { m: mc, cons } = pegModel({ consensus: true });
  const abs = detFn('peg.deviation')(mc, { now: t[n - 1] }).find((k) => k.asset === 'AAA' && k.variant === 'abs');
  assert.ok(Math.abs(abs.series.v[n - 1] - Math.abs(cons[n - 1] - 1)) < 1e-12, 'peg statistics use asset.priceConsensus');
  assert.equal(D.helpers.pegPrice(mc.assets[0]), mc.assets[0].priceConsensus);
});
test('#63 peg.deviation excess: the reference is non-Paxos peers only, so issuer-wide stress is not hidden', () => {
  const { m, t, n } = pegModel({ badPrint: false, sibStress: true });
  const ex = detFn('peg.deviation')(m, { now: t[n - 1] }).find((k) => k.asset === 'BBB' && k.variant === 'excess' && k.window === '1d');
  assert.ok(ex.value > 0.004, `excess vs peers ${ex.value}`); // ~50bp: siblings at -50bp would have cancelled it
  assert.match(ex.headline, /than PEER /);
  assert.match(ex.headline, /below peg/);
});
test('#21 #30 peg details never present stale hourly prints as "the last N hours"', () => {
  const { m, t, n } = pegModel({ badPrint: false });
  const now = t[n - 1] + DAY / 2, stale = (k) => Array.from({ length: k }, (_, i) => ({ t: now - 13 * DAY - (k - 1 - i) * 3600, p: 0.996 }));
  m.assets[0].hourly = stale(27);
  m.pegPeers[0].hourly = Array.from({ length: 48 }, (_, i) => ({ t: now - (47 - i) * 3600, p: 1.0001 }));
  m.assets[1].hourly = stale(1);
  const tests = detFn('peg.deviation')(m, { now });
  const aaa = tests.find((k) => k.asset === 'AAA'), bbb = tests.find((k) => k.asset === 'BBB');
  assert.ok(!/last \d+ hours/.test(aaa.detail) && /end \d{4}-\d{2}-\d{2}/.test(aaa.detail), aaa.detail);
  m.assets[1].hourly = Array.from({ length: 48 }, (_, i) => ({ t: now - (47 - i) * 3600, p: 0.999 }));
  const fresh = detFn('peg.deviation')(pegModelWith(m), { now }).find((k) => k.asset === 'BBB');
  assert.match(fresh.detail, /over 48 prints from .* \(47 h\): .* vs PEER /);
  assert.ok(bbb);
});
const pegModelWith = (m) => ({ ...m, assets: m.assets.map((a) => ({ ...a })) }); // fresh memo for changed hourly data

test('#24 far-future timestamps: the engine ignores points after now; lead-lag work is bounded', () => {
  const r = S.mulberry32(24), n = 400, t = daysFrom(n);
  let x = 1e8;
  const sup = t.map(() => (x += 3e5 * gauss(r)));
  const clean = mkModel([mkAsset('AAA', { t, supply: sup, price: t.map(() => 1 + 0.0003 * gauss(S.mulberry32(1))) })]);
  const base = runOn(clean);
  const bad = mkModel([mkAsset('AAA', { t: [...t, t[n - 1] * 3], supply: [...sup, sup[n - 1]], price: [...clean.assets[0].priceDaily.v, 1] })], { t });
  bad.now = clean.now;
  const t0 = performance.now(), res = runOn(bad), ms = performance.now() - t0;
  perf(ms < 3000, `engine with a far-future point ${ms} ms`);
  assert.ok(ms < 30000, `engine with a far-future point ${ms} ms`); // unbounded, this was minutes or an OOM
  const sig = (rr) => rr.collapsed.filter((k) => k.asset === 'AAA' && k.detector.startsWith('supply.')).map((k) => `${k.id} ${k.p}`).sort();
  assert.deepEqual(sig(res), sig(base));
  assert.ok(A.attribution(bad).windows.d1.to === A.attribution(clean).windows.d1.to);
  const long = Array.from({ length: S.LEADLAG_MAX_N + 3000 }, () => gauss(r));
  assert.equal(S.leadLag(long, long.map((v) => v + gauss(r))).n, S.LEADLAG_MAX_N);
});

test('#25 record clauses: no "largest since" when a window overlapping today was at least as extreme', () => {
  const r = S.mulberry32(25), n = 300, t = daysFrom(n);
  let x = 1e8;
  // a 6% drop four days ago: the 7-day change ending yesterday is larger than today's
  const sup = t.map((_, i) => (x += 2e5 * gauss(r) - (i === n - 4 ? 6e6 : 0) + (i === n - 1 ? 1e6 : 0)));
  const tests = detFn('supply.move')(mkModel([mkAsset('AAA', { t, supply: sup })]), { now: t[n - 1] });
  for (const k of tests.filter((q) => q.horizon > 1)) {
    const ch = S.changes(sup, k.horizon, 'log'), xx = ch[n - 1], m = /since (\d{4}-\d{2}-\d{2})/.exec(k.headline);
    if (!m) continue;
    const d = Date.parse(m[1]) / 1000;
    for (let i = n - 2; i >= 0 && t[i] > d; i--) assert.ok(!(xx < 0 ? ch[i] <= xx : ch[i] >= xx), `${k.window}: window ending ${new Date(t[i] * 1000).toISOString().slice(0, 10)} was at least as extreme: ${k.headline}`);
  }
  const w7 = tests.find((k) => k.horizon === 7);
  assert.ok(!/since/.test(w7.headline), w7.headline);
});

test('#28 supply.regime split dates do not move with the day the data ends (calendar-week blocks)', () => {
  const r = S.mulberry32(28), n = 420, t = daysFrom(n);
  let x = 1e8;
  const sup = t.map((_, i) => (x *= 1 + (i < 250 ? 0.003 : -0.002) + 0.002 * gauss(r)));
  const keys = [];
  for (let drop = 0; drop < 7; drop++) {
    const tt = t.slice(0, n - drop), ss = sup.slice(0, n - drop);
    const tests = detFn('supply.regime')(mkModel([mkAsset('AAA', { t: tt, supply: ss })]), { now: tt[tt.length - 1] });
    const best = tests.slice().sort((a, b) => a.stat.p - b.stat.p)[0];
    keys.push(best.eventKey);
    assert.equal(new Date(Date.parse(best.eventKey)).getUTCDay(), 0, 'blocks end on Sundays');
  }
  assert.equal(new Set(keys).size, 1, keys.join(' '));
});

test('#29 dq.freshness: a dead hourly feed stays flagged with 0, 1 or many prints; data-quality items are neutral', () => {
  const n = 120, t = daysFrom(n), now = t[n - 1] + DAY / 2;
  const hours = (k, end) => Array.from({ length: k }, (_, i) => ({ t: end - (k - 1 - i) * 3600, p: 1 }));
  const mkA = (key, hourly) => mkAsset(key, { t, supply: t.map((_, i) => 1e8 + 1e6 * Math.sin(i)), hourly, priceLlamaDaily: { t, v: t.map(() => 1) } });
  const peers = [{ symbol: 'P', geckoId: 'p', llamaId: '1', share: 1, hourly: hours(500, now - 1800), daily: null }];
  const m = mkModel([mkA('LIVE', hours(500, now - 1800)), mkA('ONE', hours(1, now - 13 * DAY)), mkA('MANY', hours(27, now - 13 * DAY)), mkA('NONE', null), mkA('LATE', hours(400, now - 2.5 * 3600))], { pegPeers: peers });
  m.now = now;
  const tests = detFn('dq.freshness')(m, { now }).filter((k) => /hourly/.test(k.variant));
  const by = Object.fromEntries(tests.map((k) => [k.asset, k]));
  assert.ok(by.LIVE.stat.p === 1);
  for (const k of ['ONE', 'MANY', 'NONE']) {
    assert.ok(by[k] && by[k].stat.p === by[k].stat.minP && by[k].stat.minP < 0.002, `${k} p ${by[k] && by[k].stat.p}`);
    assert.match(by[k].headline, /longer than all \d+ gaps/);
  }
  assert.match(by.NONE.headline, /no print since at least/);
  assert.ok(by.MANY.ageDays >= 12 && by.MANY.ageDays <= 13, 'a dead feed carries its own age (feed while < 30 days, standing after)');
  // Materiality = ordinary daily flow x days overdue: a feed an hour or two late is not material.
  const isMat = E.materialIn(D.helpers.floors(m));
  assert.ok(['ONE', 'MANY', 'NONE'].every((k) => isMat(by[k])) && !isMat(by.LATE), `LATE ${by.LATE.materialityUsd}`);
  E.evaluate(tests, { data: 10 });
  assert.ok(tests.every((k) => k.polarity === 'neutral'));
});
test('decision 2: every data-quality finding is neutral (rich model and fixture)', async () => {
  for (const res of [runOn(richModel()), ...(await fixtureRun())]) {
    const dq = res.collapsed.filter((k) => k.detector.startsWith('dq.'));
    assert.ok(dq.length && dq.every((k) => k.polarity === 'neutral' && k.dimension === 'data'), dq.filter((k) => k.polarity !== 'neutral').map((k) => k.id).join(' '));
  }
});

test('#12 dq.cross_source names the chains that explain the gap from on-chain supply', () => {
  const r = S.mulberry32(12), n = 120, t = daysFrom(n);
  const ea = t.map(() => 2.565e8 + 1e6 * gauss(r)), sol = t.map(() => 6.52e8 + 1e6 * gauss(r)), ink = t.map(() => 6.42e7);
  const sup = t.map((_, i) => ea[i] + sol[i] + ink[i]);
  const build = (extra = {}) => mkAsset('AAA', {
    t, supply: sup, chains: { 'Chain E': { v: ea, minted: { t, v: ea.map((x) => x + 6.42e7) } }, 'Chain S': { v: sol, minted: { t, v: sol } }, 'Chain I': { v: ink, minted: { t, v: t.map(() => 0) } } },
    cgDaily: { mcap: { t, v: sup.map((x) => x + 6.42e7 + 1.4e7) }, vol: { t, v: sup.map(() => 1e7) }, price: { t, v: t.map(() => 1) } },
    onchain: [{ chain: 'Chain E', holders: 1, totalSupply: ea[n - 1] + 6.42e7 + 7e6, source: 'x', asOf: iso(t[n - 1] + DAY / 2) }, { chain: 'Chain S', holders: 1, totalSupply: sol[n - 1] - 1e5, source: 'x', asOf: iso(t[n - 1]) }, { chain: 'Chain A', holders: 1, totalSupply: 1.4e7, source: 'x', asOf: iso(t[n - 1]) }],
    controls: { supplyControl: [{ chain: 'Chain E', address: 'x' }, { chain: 'Chain I', address: 'y' }] }, ...extra,
  });
  const [k] = detFn('dq.cross_source')(mkModel([build()]), { now: t[n - 1] });
  assert.match(k.headline, /Chain E \+\$71\.\dM \(synthetic:test counts \$25\d\.\dM: \$32\d\.\dM minted minus \$64\.2M it treats as bridged out/);
  assert.match(k.headline, /Chain A \+\$14\.0M \(on-chain \$14\.0M, not tracked by synthetic:test\)/);
  assert.match(k.headline, /Chain I \(\$64\.2M\) is counted as bridged in but has its own issuer supply controller, so the bridged-out subtraction may double count/);
  assert.ok(!/Chain S/.test(k.headline), 'a difference below an ordinary day is timing');
  assert.ok(Math.abs(k.stat.onchainTotalUsd - (ea[n - 1] + 6.42e7 + 7e6 + sol[n - 1] - 1e5 + 1.4e7 + 6.42e7)) < 1);
  // With the source's latest per-chain snapshot (asset.current.parts) the comparison uses it instead of the daily label.
  const parts = [{ chain: 'Chain E', supply: ea[n - 1] + 5e6 }, { chain: 'Chain S', supply: sol[n - 1] }, { chain: 'Chain I', supply: 6.42e7 }];
  const [k2] = detFn('dq.cross_source')(mkModel([build({ current: { parts } })]), { now: t[n - 1] });
  assert.match(k2.headline, /Chain E \+\$66\.2M/);
});

test('#55 dq.history_gap values the first tracked supply on its own date', () => {
  const n = 200, t = daysFrom(n, T0 + 400 * DAY);
  const gold = mkAsset('GLD', { t, supply: t.map(() => 2.5e5), kind: 'gold', price: t.map((_, i) => 1800 + 12 * i), firstPriceT: T0 });
  const [k] = detFn('dq.history_gap')(mkModel([gold]), { now: t[n - 1] });
  assert.match(k.headline, /first tracked supply already \$450\.0M \(250,000 tokens at that day's price\)/);
  gold.supplyUsd = { t: t.slice(100), v: gold.supplyUsd.v.slice(100) };
  const [k2] = detFn('dq.history_gap')(mkModel([mkAsset('GLD', { ...gold, t, supply: gold.supply.v, supplyUsd: gold.supplyUsd })]), { now: t[n - 1] });
  assert.match(k2.headline, /250,000 tokens \(\$\d+\.\d+[MB] at today's price\)/);
});

test('#54 #66 #67 wording: no double signs after verbs, "offsetting moves" not "moved between", "active" aggregate', async () => {
  const runs = [runOn(richModel()), ...(await fixtureRun())];
  const bad = /\b(fell|grew|rose|shrank|declined|is) [+-]\d|\b[+-]\d[\d.]*% \(\S+\) below/;
  for (const res of runs) for (const k of res.collapsed) assert.ok(!bad.test(k.headline), k.headline);
  const mix = runs[0].collapsed.find((k) => k.detector === 'portfolio.mix');
  assert.match(mix.headline, /offsetting moves across the active Paxos USD stablecoins/);
  const src = readFileSync(new URL('../lib/paxos/detectors.js', import.meta.url), 'utf8');
  assert.ok(!/moved between|sum of live/.test(src));
});

test('#56 no dead exports in the engine helpers', () => {
  const root = new URL('../', import.meta.url);
  const others = (self) => ['lib/paxos', 'api', 'scripts', 'pages/paxos'].flatMap((d) => readdirSync(new URL(d + '/', root)).filter((f) => /\.m?js$/.test(f)).map((f) => d + '/' + f)).filter((f) => f !== self).map((f) => readFileSync(new URL(f, root), 'utf8')).join('\n');
  for (const [file, mod] of [['lib/paxos/format.js', F], ['lib/paxos/stats.js', S]]) {
    const rest = others(file), own = readFileSync(new URL(file, root), 'utf8');
    for (const k of Object.keys(mod)) assert.ok(new RegExp('\\b' + k + '\\b').test(rest) || (own.match(new RegExp('\\b' + k + '\\b', 'g')) || []).length > 2, `${file}: ${k} is exported but never used`);
  }
});

// Golden snapshot (review #19): the exact feed and standing ids on the recorded fixture, so any change to
// the notability rule, a detector or the data layer shows up as a reviewed diff. After reviewing a change,
// refresh with: PAXOS_GOLDEN=print node scripts/check-paxos-engine.mjs (prints the object to paste here).
const GOLDEN = {
  fixture: 'd890b37fbf4f1ee672f1d38f96a967a3169c0c87',
  feed: [
    'peg.deviation:USDP:abs:up',
    'peg.deviation:USDP:excess:up',
    'peg.regime:USDP:week-2026-09-13',
  ],
  standing: [
    'dq.tracking_change:USDG:2025-07-12:2025-07-12',
    'peg.regime:BUSD:week-2025-09-28',
    'peg.regime:PYUSD:week-2025-09-07',
    'peg.regime:USDG:week-2026-02-15',
    'supply.regime:BUSD:2024-01-21',
    'supply.regime:PAXG:2026-08-30',
    'supply.regime:PYUSD:2023-10-29',
    'supply.regime:USDP:2021-12-19',
  ],
};
test('golden: feed and standing ids on the recorded fixture (review #19)', async (t) => {
  const fx = await fixtureModel();
  if (!fx.model) { t.skip('fixture unavailable'); return; }
  const [res] = await fixtureRun();
  const { DEFAULT_FIXTURE } = await import('./fixtures/paxos/fixture-fetch.mjs');
  const fixtureSha = createHash('sha1').update(readFileSync(DEFAULT_FIXTURE)).digest('hex');
  const got = { fixture: fixtureSha, feed: res.clusters.flatMap((c) => [c.lead, ...c.related]).map((k) => k.id).sort(), standing: res.standing.map((k) => k.id).sort() };
  if (process.env.PAXOS_GOLDEN === 'print') { console.log('GOLDEN = ' + JSON.stringify(got, null, 2)); return; }
  assert.equal(got.fixture, GOLDEN.fixture, `the recorded fixture changed: review this feed and refresh GOLDEN (PAXOS_GOLDEN=print)\n${JSON.stringify(got, null, 1)}`);
  assert.deepEqual(got, GOLDEN, 'feed or standing changed on the same fixture: review the diff, then refresh GOLDEN (PAXOS_GOLDEN=print)');
});

// ---------- 5. nothing about Paxos is hard-coded in the engine ----------
test('no hard-coded symbols, gecko ids, chain names, addresses or advice in engine sources', () => {
  const files = ['detectors', 'engine', 'attribution', 'format'].map((f) => [f, readFileSync(new URL(`../lib/paxos/${f}.js`, import.meta.url), 'utf8')]);
  const banned = [
    [/\b(USDG|PYUSD|USDP|PAXG|BUSD|USDL|XAUT|USDT|USDC|CDT|EUROe)\b/, 'asset symbol'],
    [/global-dollar|paypal-usd|paxos-standard|pax-gold|tether-gold|binance-usd|lift-dollar|tether\b|usd-coin/i, 'gecko id'],
    [/\b(Ethereum|Solana|Arbitrum|X ?Layer|Xlayer|Robinhood|Polygon|BSC|Optimism|OP Mainnet|Avalanche|Mantle|Stellar|Tron|Sui|Aptos|Fraxtal|Harmony|Glue)\b/, 'chain name'],
    [/0x[0-9a-fA-F]{8,}/, 'hex address'],
    [/stablecoin[=/]\d+|llamaId\s*===?\s*['"]?\d/, 'DefiLlama id'],
    [/peggedUSD|peggedEUR|peggedVAR/, 'peg-type literal'],
  ];
  for (const [f, src] of files) {
    for (const [re, what] of banned) assert.ok(!re.test(src), `${what} in lib/paxos/${f}.js: ${(src.match(re) || [])[0]}`);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    assert.ok(!ADVICE.test(code), `advice wording in lib/paxos/${f}.js: ${(code.match(ADVICE) || [])[0]}`);
  }
});
