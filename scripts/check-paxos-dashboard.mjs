#!/usr/bin/env node
// Offline, deterministic checks for the Paxos health dashboard (run by scripts/build-vercel.sh):
//   1. the data-layer, engine, briefing and page checks (check-paxos-{sources,engine,briefing,page}.mjs),
//      started at once as child processes and awaited at the end (they share nothing but the fixture)
//   2. end to end on the recorded upstream fixture: buildPaxosHealth -> payload validated against the
//      contract (scripts/fixtures/paxos/contract-v2.mjs: schemaVersion 1 plus the v2 additions; the
//      day-1 sample contract-v2.sample.json must validate too), units and ranges, one snapshot per
//      number, token-flow changes, freshness rules, status and cache rules (H7, H11), the watch cap and
//      rounding (H12), size guards, memoisation (engine stubbed: it tests the memo, not the engine),
//      determinism
//   3. api/paxos.js with a fake req/res: 200 + headers (Cache-Control with stale-if-error, X-Paxos-Status,
//      X-Paxos-Generated-At, CORP), the JSON build log line, HEAD, query string ignored, OPTIONS/405, memo
//      reuse headers, CoinGecko down still 200, prices down -> incomplete total + short cache, everything
//      down 502 no-store with a generic message
//   4. static checks on pages/paxos and the deploy config: strict CSP derived from the page (no
//      'unsafe-inline', no external origin), the vendored Chart.js hash, the API preload, no inline styles,
//      host redirect, the build script's skip-unchanged guard, nothing hard-coded
//   5. app.js's pure helpers in a vm against the payload
// No network: every upstream request is answered from scripts/fixtures/paxos/upstream.json.gz.
// Wall-clock time is reported, not asserted (a slow build machine must not fail the deploy); set
// PAXOS_PERF_STRICT=1 to turn the time budget into a failure.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createFixtureFetch, loadFixture } from './fixtures/paxos/fixture-fetch.mjs';
import * as C from './fixtures/paxos/contract-v2.mjs';

const require = createRequire(import.meta.url);
const T0 = performance.now();
const here = (p) => new URL(p, import.meta.url).pathname;
const read = (p) => fs.readFileSync(here(p), 'utf8');
let checks = 0;
// PAXOS_CHECK_KEEP_GOING=1 lists every failing check instead of stopping at the first.
const KEEP_GOING = process.env.PAXOS_CHECK_KEEP_GOING === '1', failed = [];
const ok = (cond, msg) => { if (KEEP_GOING && !cond) return void failed.push(msg); assert.ok(cond, msg); checks++; };
if (KEEP_GOING) process.on('exit', (code) => { if (failed.length) { console.log(`check-paxos-dashboard: ${failed.length} FAILED:\n  ${failed.map((m) => String(m).split('\n').slice(0, 4).join('\n    ')).join('\n  ')}`); process.exitCode = 1; } });
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

// ---------- 1. sub-checks, concurrently ----------
// The timeout is a hang guard, not a performance gate.
const children = new Set();
process.on('exit', () => { for (const c of children) c.kill('SIGKILL'); });
const SUBCHECKS = ['./check-paxos-sources.mjs', './check-paxos-engine.mjs', './check-paxos-briefing.mjs', './check-paxos-page.mjs'];
const subResults = SUBCHECKS.map((script) => new Promise((resolve) => {
  const t0 = performance.now();
  const child = spawn(process.execPath, [here(script)], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  children.add(child);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 300e3);
  child.on('error', (e) => { clearTimeout(timer); children.delete(child); resolve({ script, code: -1, out: out + e.message, ms: performance.now() - t0 }); });
  child.on('close', (code, signal) => { clearTimeout(timer); children.delete(child); resolve({ script, code, signal, out, ms: performance.now() - t0 }); });
}));

// ---------- 2. end to end on the fixture ----------
const { buildPaxosHealth, resetMemo, REUSE_MS } = require('../lib/paxos/index.js');
const { createCache } = require('../lib/paxos/cache.js');
const { hostOf } = require('../lib/paxos/http.js');
const engine = require('../lib/paxos/engine.js');
const { DIMENSIONS } = engine;
const { collectRaw, createClient, SOURCES } = require('../lib/paxos/sources.js');
const { buildModel } = require('../lib/paxos/model.js');
const { buildPayload, tokenFlowView } = require('../lib/paxos/payload.js');
const { attribution } = require('../lib/paxos/attribution.js');
const { createHandler } = require('../api/paxos.js');

const fixture = loadFixture();
const NOW = fixture.now;
const DAY = 86400;
const clockAt = (ms) => () => NOW * 1000 + ms;
const quiet = () => {};
const build = (extra = {}) => buildPaxosHealth({ fetch: createFixtureFetch(fixture, extra.override ? { override: extra.override } : {}), now: NOW, cache: createCache(), clock: clockAt(5000), memoize: false, log: quiet, ...extra });

const tBuild = performance.now();
const { payload, meta } = await build();
const buildMs = performance.now() - tBuild;
const body = JSON.stringify(payload);
ok(meta.nonFinite === 0, `payload builder replaced ${meta.nonFinite} non-finite numbers`);
// Determinism first, with the real engine on both runs (the memo tests below stub it).
const again = await build();
// Measured provenance (latency, wall-clock fetchedAt, stage timings) is the only thing allowed to differ.
const strip = (p) => JSON.stringify({ ...p, timingsMs: null, sources: p.sources.map((s) => ({ ...s, latencyMs: null, fetchedAt: null })) });
ok(strip(again.payload) === strip(payload), 'two builds on the same data are byte-identical (measured timings aside)');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
function validate(p, label) {
  const errors = C.validate(p, label);
  ok(!errors.length, `${label} violates the payload contract (${errors.length} errors):\n${errors.slice(0, 25).join('\n')}`);
}
validate(payload, 'payload');
// The day-1 contract sample still describes this contract and this fixture: merged onto today's payload
// without its v2 fields (what C built against before A and B landed), it validates.
const SAMPLE = JSON.parse(read('./fixtures/paxos/contract-v2.sample.json'));
validate(C.mergeSample(C.stripV2(payload), SAMPLE), 'contract-v2.sample.json merged onto the fixture payload');

// Compact helpers (the page has its own; these keep the server checks independent of it).
const cEnd = (c) => (c && c.values.length ? new Date(Date.parse(c.start) + (c.values.length - 1) * DAY * 1000).toISOString().slice(0, 10) : null);
const cAt = (c, d) => { if (!c) return null; const k = Math.round((Date.parse(d) - Date.parse(c.start)) / 864e5); return k >= 0 && k < c.values.length ? c.values[k] : null; };
const cLast = (c) => { if (!c) return null; for (let i = c.values.length - 1; i >= 0; i--) if (isNum(c.values[i])) return c.values[i]; return null; };

// --- contract semantics beyond shapes ---
const keys = payload.discovery.assets.map((a) => a.key);
ok(keys.length >= 4 && new Set(keys).size === keys.length, 'discovery finds every Paxos asset once');
ok(JSON.stringify(Object.keys(payload.assets).sort()) === JSON.stringify(keys.slice().sort()), 'assets map and discovery list agree');
const active = payload.discovery.assets.filter((a) => a.status === 'active');
const byFirst = active.slice().sort((a, b) => (a.firstDate === b.firstDate ? (a.key < b.key ? -1 : 1) : a.firstDate === null ? 1 : b.firstDate === null ? -1 : a.firstDate < b.firstDate ? -1 : 1));
ok(byFirst.every((a, i) => a.colorIndex === i), 'colorIndex = order of firstDate among active assets');
ok(payload.discovery.assets.filter((a) => a.status !== 'active').every((a) => a.colorIndex === null), 'legacy/dead assets have no colour slot');
ok(payload.discovery.assets.every((a) => payload.assets[a.key].colorIndex === a.colorIndex && payload.assets[a.key].unit === a.unit), 'asset colour/unit consistent');
// The aggregate is exactly the ACTIVE USD stablecoins that have supply (legacy wind-downs excluded).
const usdKeys = payload.totals.usd.assets;
const activeUsd = Object.values(payload.assets).filter((a) => a.kind === 'usd-stablecoin' && a.status === 'active' && a.series.supplyUsd).map((a) => a.key);
ok(usdKeys.length >= 2 && JSON.stringify(usdKeys.slice().sort()) === JSON.stringify(activeUsd.sort()), `Paxos USD = active USD stablecoins (${usdKeys} vs ${activeUsd})`);
ok(/active/i.test(payload.totals.usd.label) && !/\blive\b/i.test(payload.totals.usd.label), `aggregate label says active (${payload.totals.usd.label})`);
ok(Math.abs(payload.totals.usd.current - payload.totals.usd.supplyUsd.values.at(-1)) <= 1, 'totals.usd.current is the last aggregate point');
ok(payload.totals.usd.shareCurrent > 0 && payload.totals.usd.shareCurrent < 1 && payload.totals.usd.marketShare && payload.market.usdTotal && payload.market.allTotal && payload.totals.usd.rankEquivalent >= 1, 'USD market share is a fraction; market series and rank present');
ok(payload.sources.length >= 10 && payload.sources.every((s) => s.status === 'ok' || s.message), 'every degraded source says why');
const cov = payload.market.coverageFrom;
ok(!cov || (payload.totals.usd.marketShare.start >= cov && cov < cEnd(payload.market.usdTotal)), `the market share starts at the market coverage start (${payload.totals.usd.marketShare.start} vs ${cov})`);

// Units and ranges (shares and turnover are fractions, pct and drawdown in percent, peg in bp): each
// field is checked against the figures it is derived from, so a x100 or x1e3 slip cannot pass.
const t = payload.totals.usd;
const pk = Math.max(...t.supplyUsd.values.filter(isNum));
ok(t.drawdownPct <= 0 && t.drawdownPct > -100 && near(t.drawdownPct, 100 * (t.current / pk - 1), 1e-2) && t.ath.value === pk, `totals: drawdown in percent from the series peak (${t.drawdownPct})`);
// (the share uses DefiLlama's per-day USD values, the total today's price: equal within a peg wobble;
// the market total carries 4 significant digits, H12)
ok(near(t.shareCurrent, t.current / cAt(payload.market.usdTotal, cEnd(t.supplyUsd)), 2e-3 * t.shareCurrent), 'totals: shareCurrent = total / USD market on the same day');
for (const [w, d] of [['d1', 1], ['d7', 7], ['d30', 30], ['d90', 90], ['d365', 365]]) {
  const prev = cAt(t.supplyUsd, new Date(Date.parse(cEnd(t.supplyUsd)) - d * 864e5).toISOString().slice(0, 10));
  if (isNum(prev)) ok(near(t.change[w].abs, t.current - prev, 2) && near(t.change[w].pct, (100 * (t.current - prev)) / prev, 1e-3), `totals ${w}: change abs in USD, pct in percent`);
}
for (const a of Object.values(payload.assets)) {
  const c = a.current;
  for (const ch of a.chains) ok(!ch.series || ch.series.values.length <= 400, `${a.key}/${ch.chain}: chain series <= 400 d`);
  if (a.chains.length) ok(Math.abs(a.chains.reduce((s, ch) => s + (ch.share || 0), 0) - 1) < 1e-3 && a.chains.every((ch) => ch.share === null || (ch.share >= 0 && ch.share <= 1)), `${a.key}: chain shares are fractions summing to 1`);
  for (const ch of a.chains.filter((x) => x.status === 'tracking_ended')) ok(ch.currentUsd === 0 && ch.share === 0 && ch.notes.length > 0, `${a.key}/${ch.chain}: tracking ended -> 0 with a note`);
  if (a.kind === 'usd-stablecoin') ok(a.series.supply === null && a.unit === 'USD' && c.changeBasis === 'token-flow' && c.changeNative === null, `${a.key}: USD asset uses supplyUsd (token flows) only`);
  else ok(c.changeBasis === 'market-value' && c.changeNative && a.series.supply, `${a.key}: non-USD asset reports market-value changes plus changeNative`);
  const wide = /\+onchain$/.test(c.supplySource || '');
  const lastUsd = cLast(a.series.supplyUsd), lastNat = a.series.supply ? cLast(a.series.supply) : null;
  if (wide) ok(c.supply >= lastNat && c.supplyUsd > 0 && a.notes.length > 0, `${a.key}: a current level wider than its history (${c.supplySource}) covers at least the history and is explained`);
  else if (a.series.supplyUsd) ok(Math.abs(c.supplyUsd - a.series.supplyUsd.values.at(-1)) <= 1, `${a.key}: current.supplyUsd = last series point`);
  if (c.ath && isNum(lastUsd)) ok(c.drawdownPct <= 0 && c.drawdownPct > -100 && near(c.drawdownPct, 100 * (lastUsd / c.ath.value - 1), 1e-2) && c.ath.value === Math.max(...a.series.supplyUsd.values.filter(isNum)), `${a.key}: drawdown in percent from the series peak (${c.drawdownPct})`);
  if (c.athNative && isNum(lastNat)) ok(c.drawdownNativePct <= 0 && c.drawdownNativePct > -100 && near(c.drawdownNativePct, 100 * (lastNat / c.athNative.value - 1), 1e-2), `${a.key}: native drawdown in percent (${c.drawdownNativePct})`);
  if (a.unit === 'USD') ok(c.pegAsOf === c.priceAsOf, `${a.key}: the peg deviation is dated by its price quote`);
  if (a.unit === 'oz' && a.series.xau) ok(c.pegAsOf && c.pegAsOf.slice(0, 10) === cEnd(a.series.xau), `${a.key}: the gold premium is dated by its daily XAU point`);
  if (c.priceAsOf) ok(c.priceAsOf <= payload.generatedAt, `${a.key}: price quote not after generatedAt`);
  if (isNum(c.marketShare)) ok(c.marketShare > 0 && c.marketShare < 1 && near(c.marketShare, c.supplyUsd / cAt(payload.market.usdTotal, cEnd(a.series.supplyUsd)), 2e-3 * c.marketShare), `${a.key}: marketShare is a fraction of the USD market (${c.marketShare})`);
  if (isNum(c.turnover24h) && c.volume24hUsd > 0) { const r = c.turnover24h / (c.volume24hUsd / c.supplyUsd); ok(r > 0.5 && r < 2, `${a.key}: turnover24h is a fraction (volume / market cap), ${c.turnover24h}`); }
  if (a.unit === 'USD' && isNum(c.price)) ok(near(c.pegDevBp, (c.price - 1) * 1e4, 0.02), `${a.key}: pegDevBp = (price - 1) x 1e4 (${c.pegDevBp} vs price ${c.price})`);
  if (a.unit === 'oz' && a.series.xau) ok(near(c.pegDevBp, (cLast(a.series.xau) - 1) * 1e4, 0.02), `${a.key}: gold premium in bp of the XAU price`);
  if (a.defi) {
    ok(near(a.defi.footprintShare, a.defi.footprintUsd / c.supplyUsd, 1e-3 * a.defi.footprintShare + 1e-6), `${a.key}: footprintShare = footprint / supply (${a.defi.footprintShare})`);
    ok(a.defi.rewardShare === null || (a.defi.rewardShare >= 0 && a.defi.rewardShare <= 1), `${a.key}: rewardShare is a fraction`);
  }
}
const gold = Object.values(payload.assets).filter((a) => a.kind === 'gold');
ok(gold.length >= 1 && gold.every((a) => a.unit === 'oz' && a.series.supply && a.series.xau && Number.isFinite(a.current.pegDevBp)), 'gold assets: oz series, XAU series and premium');
for (const a of gold) {
  const end = cEnd(a.series.supply), prev = cAt(a.series.supply, new Date(Date.parse(end) - 7 * 864e5).toISOString().slice(0, 10));
  if (isNum(prev)) ok(near(a.current.changeNative.d7.abs, cLast(a.series.supply) - prev, 1), `${a.key}: changeNative.d7 is in ounces`);
  ok(a.current.athNative && a.current.athNative.value === Math.max(...a.series.supply.values.filter(isNum)), `${a.key}: athNative is the ounce peak`);
}

// One snapshot per number.
ok(payload.dataAsOf === t.supplyAsOf, `dataAsOf = totals.usd.supplyAsOf (${payload.dataAsOf} vs ${t.supplyAsOf})`);
ok(t.supplyAsOf.slice(0, 10) === cEnd(t.supplyUsd) && t.supplyAsOf <= payload.generatedAt, 'totals.usd.supplyAsOf falls on the last aggregate day, not after generatedAt');
for (const a of Object.values(payload.assets)) {
  if (!isNum(a.current.supplyUsd)) continue;
  const s = a.unit === 'USD' ? a.series.supplyUsd : a.series.supplyUsd || a.series.supply;
  ok(a.current.supplyAsOf && a.current.supplyAsOf.slice(0, 10) >= cEnd(s) && a.current.supplyAsOf <= payload.generatedAt, `${a.key}: supplyAsOf not before its last supply day, not after generatedAt (${a.current.supplyAsOf} vs ${cEnd(s)})`);
  if (!/\+onchain$/.test(a.current.supplySource || '')) ok(a.current.supplyAsOf.slice(0, 10) === cEnd(s), `${a.key}: supplyAsOf on its last supply day`);
}
ok(payload.peers.asOf && payload.peers.asOf <= payload.generatedAt, 'peers carry the list snapshot time');
ok(payload.totals.allUsd.missing.length === 0 && payload.totals.allUsd.current === payload.totals.allUsd.coveredUsd && payload.totals.allUsd.supplyAsOf === Object.values(payload.assets).filter((a) => a.status !== 'dead' && isNum(a.current.supplyUsd)).map((a) => a.current.supplyAsOf).sort()[0], 'allUsd: complete, dated by its oldest member');

// Hero, asset table and attribution use the same snapshot and the same (token-flow) basis.
const att = payload.attribution.windows;
for (const w of ['d1', 'd7', 'd30', 'd90', 'd365']) {
  ok(att[w].to === cEnd(t.supplyUsd) && near(att[w].totalDeltaUsd, t.change[w].abs, 1), `attribution ${w} = hero change (${att[w].totalDeltaUsd} vs ${t.change[w].abs})`);
  for (const r of att[w].assets) {
    const a = payload.assets[r.asset];
    if (cEnd(a.series.supplyUsd) === att[w].to && a.current.change[w]) ok(near(r.deltaUsd, a.current.change[w].abs, 1), `attribution ${w} ${r.asset} = asset change`);
  }
}
ok(['d1', 'd7', 'd30', 'd90', 'd365', 'all'].every((w) => att[w]), 'attribution has every window');
for (const [w, x] of Object.entries(att)) {
  const sumA = x.assets.reduce((s, r) => s + r.deltaUsd, 0), sumC = x.chains.reduce((s, r) => s + r.deltaUsd, 0);
  ok(Math.abs(sumA - x.totalDeltaUsd) <= x.assets.length && Math.abs(sumC - x.totalDeltaUsd) <= x.chains.length + x.assets.length, `attribution ${w}: assets and chains add up to the total`);
}
// The aggregate's members add up to the aggregate, today (H12: asset-level series stay exact).
ok(near(usdKeys.reduce((s, k) => s + payload.assets[k].current.supplyUsd, 0), t.current, usdKeys.length), 'the active USD assets add up to the hero total within $1 each (exact asset series)');

// Freshness: an hourly series is shipped only while its last point is within a day of now.
const hourlyOk = (h) => h === null || NOW - h.t.at(-1) <= DAY;
ok(Object.values(payload.assets).every((a) => hourlyOk(a.series.priceHourly)) && payload.pegPeers.every((x) => hourlyOk(x.priceHourly)) && payload.goldRefs.every((x) => hourlyOk(x.priceHourly)), 'no hourly series older than a day is shipped');
ok(Object.values(payload.assets).filter((a) => a.notes.some((n) => /^Hourly prices/.test(n))).every((a) => a.series.priceHourly === null), 'assets noted as stale-hourly ship no hourly series');
ok(payload.sources.filter((s) => / series lag/.test(s.message || '')).every((s) => s.status !== 'ok'), 'a source with lagging series is not reported ok');

const listed = payload.peers.rows;
ok(listed.length >= Math.min(25, payload.peers.count) && listed.filter((r) => r.isPaxos).every((r) => payload.assets[r.assetKey]), 'peers: top 25 + every Paxos list member, joined to asset keys');
ok(Object.values(payload.assets).filter((a) => a.kind === 'usd-stablecoin' && a.current.rank).every((a) => listed.some((r) => r.assetKey === a.key)), 'every ranked Paxos USD asset appears in the peer rows');
ok(payload.pegPeers.length >= 1 && payload.goldRefs.length >= 1, 'peg peers and gold references discovered');
ok(payload.economics && payload.economics.current.impliedYield > 0 && payload.economics.current.impliedYield < 1, 'economics: implied yield is a fraction');
// E7: the modelled assets are the fee-label discovery tier's (the fixture's DefiLlama fee adapter labels).
const feeTier = payload.discovery.tiers.find((x) => x.id === 'defillama:fees-label');
ok(feeTier && JSON.stringify(payload.economics.assets) === JSON.stringify(feeTier.found) && JSON.stringify(payload.economics.assets) === JSON.stringify(['USDG', 'PYUSD', 'BUSD']), `economics.assets = the fee-label tier (${JSON.stringify(payload.economics.assets)})`);
const ins = payload.insights;
ok(ins.testsRun > 300 && ins.groups > 50 && ins.errors.length === 0, `insights ran clean (${ins.testsRun} tests, errors ${JSON.stringify(ins.errors).slice(0, 200)})`);
ok(ins.feed.length >= 1, 'feed non-empty');
ok(JSON.stringify(ins.health.dimensions) === JSON.stringify(DIMENSIONS), 'health grid uses the fixed dimension vocabulary');
ok(ins.health.assets[0] === payload.totals.usd.key && keys.every((k) => ins.health.assets.includes(k)), 'health rows: the aggregate (totals.usd.key) + every asset');
const allIns = [...ins.feed.flatMap((c) => [c.lead, ...c.related]), ...ins.standing, ...ins.watch, ...ins.context];
ok(new Set(allIns.map((i) => i.id)).size === allIns.length, 'insight ids are unique');
ok(allIns.every((i) => !/NaN|undefined|Infinity/.test(i.headline + ' ' + (i.detail || ''))), 'no NaN/undefined in insight text');
ok(allIns.every((i) => !i.evidence.series || i.evidence.series.values.length <= 120), 'evidence sparklines <= 120 points');
ok(ins.feed.every((c) => c.lead.surprise.notable && c.lead.surprise.E < 1), 'feed leads are notable (E < 1)');
ok(/E = m x p < 1/.test(ins.rule.text) && /average/.test(ins.rule.text) && /underpowered/.test(ins.rule.text) && /neutral/.test(ins.rule.text), 'rule text states the family size, underpowered and data-quality rules');
ok(payload.status.level === 'ok' && payload.status.reasons.length === 0 && payload.cache.sMaxAge === 1800, `the fixture payload is ok with a 30-minute CDN budget (${payload.status.level}, ${payload.cache.sMaxAge})`);
ok(payload.briefing && payload.briefing.errors.length === 0 && payload.briefing.verdict.text === 'Unusual: USDP peg', `the fixture briefing built clean (${payload.briefing && payload.briefing.verdict.text})`);

// H12 size guards on the fixture payload: fail above 700 KB raw / 190 KB gzip; warn above 180 KB gzip
// (target 680 / 180).
const raw = Buffer.byteLength(body), gz = zlib.gzipSync(body).length;
ok(raw <= 700 * 1024, `payload ${Math.round(raw / 1024)} KB raw is above the 700 KB guard (target 680 KB)`);
ok(gz <= 190 * 1024, `payload ${Math.round(gz / 1024)} KB gzip is above the 190 KB guard (target 180 KB)`);
if (gz > 180 * 1024 || raw > 680 * 1024) console.warn(`warning: payload ${Math.round(raw / 1024)} KB raw / ${Math.round(gz / 1024)} KB gzip is above the 680 / 180 KB target`);
// H12 rounding: chart-only series carry at most 4 significant digits; ratio inputs that must reconcile
// (asset supply series, the aggregate) stay exact.
const sig4 = (x) => x === null || Number(x.toPrecision(4)) === x;
ok(Object.values(payload.assets).every((a) => a.chains.every((ch) => !ch.series || ch.series.values.every(sig4))), 'assets[k].chains[].series at 4 significant digits');
// market.usdTotal is a ratio input (the market's move over a period): 6 significant digits, so that move
// is exact at its printed 0.01% (truth review: 4 digits misprinted 24% of 7-day moves).
const sig6 = (x) => x === null || Number(x.toPrecision(6)) === x;
ok(payload.market.usdTotal.values.every(sig6) && payload.market.allTotal.values.every(sig4), 'market.usdTotal at 6 and allTotal at 4 significant digits');
ok(payload.totals.usd.supplyUsd.values.filter(isNum).some((x) => !sig4(x)) && Object.values(payload.assets).every((a) => !a.series.supplyUsd || a.series.supplyUsd.values.filter(isNum).length < 10 || a.series.supplyUsd.values.filter(isNum).some((x) => !sig4(x))), 'asset and aggregate supply series are not rounded to 4 digits');

// --- the engine run behind the payload (also the memo tests' stub) ---
const rawBundle = await collectRaw({ fetch: createFixtureFetch(fixture), now: NOW, cache: createCache(), log: quiet });
const model = buildModel(rawBundle, { now: NOW });
const realRun = engine.run;
const fixtureRes = realRun(model, { now: NOW });
// H12 watch cap: every data note survives, plus the 20 most unusual others in engine order; watchTotal is
// the count before the cap (recomputed from the engine's collapsed tests, independently of its own cap).
{
  const watchSet = fixtureRes.collapsed.filter((x) => !x.notable && !x.context && x.material && (x.surprise || 0) >= 1);
  const idsW = ins.watch.map((i) => i.id);
  const dataIds = watchSet.filter((x) => x.dimension === 'data').map((x) => x.id);
  ok(dataIds.length >= 1 && dataIds.every((id) => idsW.includes(id)), `every data note survives the watch cap (${dataIds.filter((id) => !idsW.includes(id)).join(', ') || 'all kept'})`);
  ok(ins.watchTotal === watchSet.length, `insights.watchTotal = the uncapped watch count (${ins.watchTotal} vs ${watchSet.length})`);
  const others = ins.watch.filter((i) => i.dimension !== 'data').map((i) => i.id);
  const engineOthers = fixtureRes.watch.filter((x) => x.dimension !== 'data').map((x) => x.id);
  ok(others.length === Math.min(20, watchSet.length - dataIds.length) && JSON.stringify(others) === JSON.stringify(engineOthers.slice(0, others.length)), `watch keeps the ${others.length} most unusual non-data items, in engine order`);
  const order = fixtureRes.watch.map((x) => x.id);
  const shown = idsW.filter((id) => order.includes(id));
  ok(JSON.stringify(shown) === JSON.stringify(order.filter((id) => shown.includes(id))), 'watch keeps engine order');
}

// --- payload rules on a model, isolated from the data (mutations of the fixture model) ---
const genAt = new Date(NOW * 1000 + 5000).toISOString();
const payloadOf = (m, res = null, a = null) => buildPayload(m, res, a, { generatedAt: genAt, timingsMs: { fetch: 0, model: 0, engine: res ? 0 : null, total: 0 } }).payload;
const base = payloadOf(model);
const withAsset = (m, key, f) => ({ ...m, assets: m.assets.map((a) => (a.key === key ? f(a) : a)) });
const bump = (s, tt, factor) => ({ t: s.t, v: s.v.map((x, i) => (s.t[i] === tt && Number.isFinite(x) ? x * factor : x)) });
const lastT = (s) => s.t[s.t.length - 1];
const usdA = model.assets.find((a) => a.kind === 'usd-stablecoin' && a.status === 'active' && a.supply && a.supplyUsd);
const goldA = model.assets.find((a) => a.kind === 'gold' && a.supply && a.supplyUsd);
// Decision 4: a peg wobble (USD value moves, token supply does not) is not a supply change.
{
  const t7 = lastT(usdA.supplyUsd) - 7 * DAY;
  const m = withAsset(model, usdA.key, (a) => ({ ...a, supplyUsd: bump(a.supplyUsd, t7, 1.005) }));
  const p = payloadOf(m);
  ok(near(p.assets[usdA.key].current.change.d7.abs, base.assets[usdA.key].current.change.d7.abs, 1) && near(p.totals.usd.change.d7.abs, base.totals.usd.change.d7.abs, 1), `${usdA.key}: a 50 bp price wobble 7 days ago does not change the 7-day supply change (token flows)`);
  const att1 = attribution(tokenFlowView(m)).windows.d7, att0 = base.totals.usd.change.d7.abs;
  ok(near(att1.totalDeltaUsd, att0, 1), 'attribution is unaffected by the same price wobble');
  const pToday = payloadOf(withAsset(model, usdA.key, (a) => ({ ...a, supplyUsd: bump(a.supplyUsd, lastT(a.supplyUsd), 1.005) })));
  const d1 = base.assets[usdA.key].current.change.d1.abs;
  ok(near(pToday.assets[usdA.key].current.change.d1.abs, d1 * 1.005, Math.abs(d1) * 1e-3 + 2), `${usdA.key}: a price move today revalues the flow, it does not add the level's price change`);
}
// Gold: the ounce figures ignore the gold price; the USD value change follows it.
{
  const t7 = lastT(goldA.supplyUsd) - 7 * DAY;
  const p = payloadOf(withAsset(model, goldA.key, (a) => ({ ...a, supplyUsd: bump(a.supplyUsd, t7, 1.01) })));
  const g1 = p.assets[goldA.key].current, g0 = base.assets[goldA.key].current;
  ok(JSON.stringify(g1.changeNative) === JSON.stringify(g0.changeNative) && g1.drawdownNativePct === g0.drawdownNativePct && g1.change.d7.abs !== g0.change.d7.abs, `${goldA.key}: changeNative ignores a gold price move; the value change does not`);
}
// Decision 3: the model's own snapshot time is used when it falls on the last day, never otherwise.
{
  const tl = lastT(usdA.supplyUsd);
  const p1 = payloadOf(withAsset(model, usdA.key, (a) => ({ ...a, supplyAsOf: tl + 5 * 3600 })));
  ok(p1.assets[usdA.key].current.supplyAsOf === new Date((tl + 5 * 3600) * 1000).toISOString(), 'model supplyAsOf on the last day is shipped');
  const p2 = payloadOf(withAsset(model, usdA.key, (a) => ({ ...a, supplyAsOf: tl + 30 * 3600 })));
  ok(p2.assets[usdA.key].current.supplyAsOf === new Date(tl * 1000).toISOString(), 'a supplyAsOf on another day is ignored (day label used)');
  const members = model.assets.filter((a) => p1.totals.usd.assets.includes(a.key));
  const allLate = { ...model, assets: model.assets.map((a) => (members.includes(a) ? { ...a, supplyAsOf: lastT(a.supplyUsd) + 5 * 3600 } : a)) };
  const p3 = payloadOf(allLate);
  const aggEnd = Date.parse(base.totals.usd.supplyAsOf) / 1000;
  const together = members.every((a) => Math.floor(lastT(a.supplyUsd) / DAY) * DAY === aggEnd);
  ok(p1.totals.usd.supplyAsOf === base.totals.usd.supplyAsOf && (together ? p3.totals.usd.supplyAsOf === new Date((aggEnd + 5 * 3600) * 1000).toISOString() : p3.totals.usd.supplyAsOf <= base.totals.usd.supplyAsOf) && p3.dataAsOf === p3.totals.usd.supplyAsOf, 'the total is as old as its oldest member; dataAsOf follows it');
  const pms = payloadOf({ ...model, listAsOf: (NOW - 1234) * 1000 });
  ok(pms.peers.asOf === new Date((NOW - 1234) * 1000).toISOString(), 'a millisecond list time is read as such');
  const p4 = payloadOf({ ...model, listAsOf: NOW - 1234 });
  ok(p4.peers.asOf === new Date((NOW - 1234) * 1000).toISOString(), 'peers.asOf is the model list snapshot time');
}
// Decision 5: a consensus daily price is what the peg chart gets.
{
  const s = usdA.priceDaily || usdA.priceLlamaDaily;
  const cons = { t: s.t.slice(-60), v: s.t.slice(-60).map((_, i) => 1 + (i % 3) * 1e-4) };
  const p = payloadOf(withAsset(model, usdA.key, (a) => ({ ...a, priceConsensus: cons })));
  ok(p.assets[usdA.key].series.price.values.at(-1) === cons.v.at(-1) && p.assets[usdA.key].series.price.values.length === 60, 'series.price is the model consensus price when present');
}
// The hourly rule, isolated from the fixture's own staleness.
{
  const hA = model.assets.find((a) => a.hourly && a.hourly.length > 1);
  ok(hA, 'the fixture has an asset with hourly prices');
  const shift = (a, to) => ({ ...a, hourly: a.hourly.map((x) => ({ t: x.t - a.hourly.at(-1).t + to, p: x.p })) });
  const old = payloadOf(withAsset(model, hA.key, (a) => shift(a, NOW - 2 * DAY))).assets[hA.key];
  const fresh = payloadOf(withAsset(model, hA.key, (a) => shift(a, NOW - 3600))).assets[hA.key];
  ok(old.series.priceHourly === null && old.notes.some((n) => /^Hourly prices/.test(n)) && fresh.series.priceHourly && !fresh.notes.some((n) => /^Hourly prices/.test(n)), 'hourly series older than a day: dropped with a note; within a day: shipped');
}
// A current level wider than the history is what the asset and the all-assets total show; changes and
// drawdown stay on the history. Model errors reach insights.errors (and so the status, H11).
{
  const lp = { t: lastT(goldA.supply), v: goldA.supply.v.at(-1) };
  const extra = lp.v * 0.01, px = goldA.supplyUsd.v.at(-1) / lp.v;
  const cur = { supply: lp.v + extra, price: px, supplyUsd: (lp.v + extra) * px, asOf: lp.t, priceAsOf: NOW - 60, source: `${goldA.supplySource}+onchain`, parts: [{ chain: 'a', supply: lp.v, asOf: lp.t }, { chain: 'b', supply: extra, asOf: NOW - 60 }], note: 'history covers one chain' };
  const p = payloadOf(withAsset({ ...model, errors: ['model.asset X.section: boom'] }, goldA.key, (a) => ({ ...a, current: cur })));
  const g = p.assets[goldA.key].current, g0 = base.assets[goldA.key].current;
  ok(near(g.supply, cur.supply, 1e-3 * cur.supply) && near(g.supplyUsd, cur.supplyUsd, 1) && g.supplySource === cur.source && p.assets[goldA.key].notes.includes(cur.note) && g.priceAsOf === new Date((NOW - 60) * 1000).toISOString(), `${goldA.key}: a wider current level is shipped with its source, quote time and note`);
  ok(JSON.stringify(g.changeNative) === JSON.stringify(g0.changeNative) && g.drawdownNativePct === g0.drawdownNativePct, `${goldA.key}: changes and drawdown stay on the history`);
  ok(near(p.totals.allUsd.current - base.totals.allUsd.current, cur.supplyUsd - base.assets[goldA.key].current.supplyUsd, 2), 'the all-assets total uses the wider current level');
  ok(p.insights.errors.some((e) => e.detector === 'model' && /boom/.test(e.error)) && p.status.level === 'degraded' && p.status.reasons.some((r) => r.kind === 'engine' && r.id === 'model'), 'model errors are listed in insights.errors and degrade the status');
}
// Finding #24 (payload side): a point dated far in the future is dropped, not stretched into every series.
{
  const far = NOW + 400 * DAY;
  const t0 = performance.now();
  const p = payloadOf(withAsset(model, usdA.key, (a) => ({ ...a, supply: { t: [...a.supply.t, far], v: [...a.supply.v, a.supply.v.at(-1)] }, supplyUsd: { t: [...a.supplyUsd.t, far], v: [...a.supplyUsd.v, a.supplyUsd.v.at(-1)] } })));
  const ends = [p.totals.usd.supplyUsd, ...Object.values(p.assets).map((a) => a.series.supplyUsd)].filter(Boolean).map(cEnd);
  ok(ends.every((d) => d <= new Date((NOW + DAY) * 1000).toISOString().slice(0, 10)) && JSON.stringify(p.assets[usdA.key].current.change) === JSON.stringify(base.assets[usdA.key].current.change) && performance.now() - t0 < 30e3, 'a far-future point changes no series end and no change');
}
// Finding #14: an asset without a USD value is never counted as $0, and the CDN rechecks soon.
{
  const p = payloadOf(withAsset(model, goldA.key, (a) => ({ ...a, supplyUsd: null, current: a.current ? { ...a.current, supplyUsd: null, price: null } : null })));
  ok(p.totals.allUsd.current === null && p.totals.allUsd.missing.includes(goldA.key) && near(p.totals.allUsd.coveredUsd, base.totals.allUsd.current - base.assets[goldA.key].current.supplyUsd, 2) && p.cache.sMaxAge === 300 && p.status.level === 'degraded', 'missing USD value: total null, gap listed, 5-minute cache, degraded status');
}
// H7 + H11 on the same data: the CDN budget and the status follow the source statuses, judged from the
// payload by the contract's own rule (contract-v2.mjs); 'partial' never shortens the budget.
const srcVariant = (f) => payloadOf({ ...model, sources: (model.sources || []).map((s) => f(s) || s) }, fixtureRes, attribution(tokenFlowView(model)));
const CORE = (model.sources || []).find((s) => s.kind === 'supply'), OTHER = (model.sources || []).find((s) => s.kind === 'price');
const variants = {
  ok: srcVariant(() => null),
  partial: srcVariant((s) => (s.id === OTHER.id ? { ...s, status: 'partial', message: 'some requests failed over' } : null)),
  stale: srcVariant((s) => (s.id === OTHER.id ? { ...s, status: 'stale', message: 'served from the last good copy' } : null)),
  nonCoreError: srcVariant((s) => (s.id === OTHER.id ? { ...s, status: 'error', message: '429' } : null)),
  coreError: srcVariant((s) => (s.id === CORE.id ? { ...s, status: 'error', message: '503' } : null)),
};
const wantTtl = { ok: 1800, partial: 1800, stale: 1800, nonCoreError: 600, coreError: 300 };
const wantLevel = { ok: 'ok', partial: 'ok', stale: 'degraded', nonCoreError: 'degraded', coreError: 'degraded' };
for (const [k, p] of Object.entries(variants)) {
  ok(p.cache.sMaxAge === wantTtl[k] && p.cache.staleIfError === 86400 && p.cache.staleWhileRevalidate === 86400, `H7 ${k}: cache ${JSON.stringify(p.cache)} (want sMaxAge ${wantTtl[k]})`);
  ok(p.status.level === wantLevel[k], `H11 ${k}: status ${p.status.level} (want ${wantLevel[k]}), reasons ${JSON.stringify(p.status.reasons.map((r) => r.id))}`);
  validate(p, `payload with sources ${k}`);
}
// A null section degrades the status and names the section.
{
  const p = payloadOf(model, fixtureRes, null);
  ok(p.attribution === null && p.status.level === 'degraded' && p.status.reasons.some((r) => r.kind === 'section' && r.id === 'attribution'), 'a null section (attribution) degrades the status with a section reason');
  validate(p, 'payload without attribution');
}

// Source freshness rules (sources.createClient).
{
  const okJson = async () => new Response('[1]', { status: 200, headers: { 'content-type': 'application/json' } });
  okJson.noThrottle = true;
  const src = SOURCES.find((s) => s.cadenceHours >= 1);
  const cad = src.cadenceHours * 3.6e6, nowMs = NOW * 1000;
  const run = async (asOfs) => {
    const c = createClient({ fetch: okJson, cache: createCache(), deadline: Date.now() + 20e3, now: NOW });
    for (const [i, a] of asOfs.entries()) await c.get(src.id, `https://freshness-${i}.invalid/x`, { ttlMs: 1, asOf: () => a });
    return c.summary(NOW).find((x) => x.id === src.id);
  };
  const fresh = await run([nowMs - cad / 2]);
  const lag = await run([nowMs - cad / 2, nowMs - 5 * cad]);
  const aged = await run([nowMs - 3 * cad]);
  ok(fresh.status === 'ok', `a fresh ${src.id} is ok (${fresh.status})`);
  ok(lag.status !== 'ok' && /lag/.test(lag.message || ''), `a lagging ${src.id} series is reported (${lag.status}: ${lag.message})`);
  ok(aged.status === 'stale', `${src.id} older than two cadences is stale (${aged.status})`);
}

// --- memoisation, single flight, reuse window (H15: the engine is stubbed; these test the memo) ---
// engine.run is replaced by a lookup of the fixture result by model fingerprint (index.js calls it through
// the module object); a model never seen runs the real engine once.
const { fingerprint } = require('../lib/paxos/index.js');
const engineMemo = new Map([[fingerprint(model), fixtureRes]]);
let engineRuns = 0;
engine.run = (m, o) => { const k = fingerprint(m); if (!engineMemo.has(k)) { engineRuns++; engineMemo.set(k, realRun(m, o)); } return engineMemo.get(k); };
resetMemo();
const fx = createFixtureFetch(fixture);
let calls = 0;
const counting = async (url, init) => { calls++; return fx(url, init); };
counting.noThrottle = true;
const mopts = (ms, cache = createCache()) => ({ fetch: counting, now: NOW, cache, clock: clockAt(ms), log: quiet });
const [m1, m2] = await Promise.all([buildPaxosHealth(mopts(0)), buildPaxosHealth(mopts(0))]);
ok(m1.payload === m2.payload && m1.meta.memo === 'miss' && m2.meta.memo === 'shared', 'concurrent callers share one build');
const callsAfterFirst = calls;
const m3 = await buildPaxosHealth(mopts(REUSE_MS - 60e3));
ok(m3.meta.memo === 'reuse' && calls === callsAfterFirst && m3.payload === m1.payload && m3.meta.ageMs === REUSE_MS - 60e3 && !('fetch' in m3.meta.timingsMs), 'a payload younger than REUSE_MS is reused as is (no upstream call, no stage timings)');
ok(REUSE_MS >= 15 * 60e3 && REUSE_MS * 1e-3 <= 1800, 'reuse window bounds rebuilds to <= 4 an hour and stays within the CDN freshness budget');
const m4 = await buildPaxosHealth(mopts(REUSE_MS + 60e3));
ok(m4.meta.memo === 'hit' && calls > callsAfterFirst && m4.payload.insights === m1.payload.insights && m4.payload.generatedAt === new Date(NOW * 1000 + REUSE_MS + 60e3).toISOString(), 'identical upstream data reuses the insights (no engine run), restamped with the new build time');
ok(m4.payload.timingsMs.engine === null && m4.payload.timingsMs.fetch >= 0 && !('engine' in m4.meta.timingsMs), 'memo hit: timings say the engine did not run');
const ageAt = (s, gen) => Math.max(0, (Date.parse(gen) - Date.parse(s.dataAsOf)) / 3.6e6);
ok(m4.payload.sources.filter((s) => s.dataAsOf).every((s) => near(s.ageHours, ageAt(s, m4.payload.generatedAt), 0.006)) && m4.payload.sources.some((s) => s.ageHours > (m1.payload.sources.find((x) => x.id === s.id) || {}).ageHours), 'memo hit: source ages recomputed against the new generatedAt');
ok(JSON.stringify(m4.payload.briefing) === JSON.stringify(m1.payload.briefing), 'memo hit: the briefing (a pure function of the reused data) is unchanged');
validate(m4.payload, 'memo-hit payload');
// Over an hour of requests every 5 minutes, one instance rebuilds at most 4 times after its first build.
{
  resetMemo();
  const cache = createCache();
  const paths = [];
  for (let k = 0; k <= 12; k++) paths.push((await buildPaxosHealth(mopts(k * 5 * 60e3, cache))).meta.memo);
  ok(paths.filter((x) => x !== 'reuse').length <= 5, `rebuilds per hour are bounded (${paths.join(',')})`);
}
// A degraded payload (5-minute CDN budget) is not reused past its own budget.
{
  resetMemo();
  const listDownF = createFixtureFetch(fixture, { override: (url) => (hostOf(url) === 'stablecoins.llama.fi' ? new Response('down', { status: 503 }) : null) });
  const dopts = (ms) => ({ fetch: listDownF, now: NOW, cache: createCache(), clock: clockAt(ms), log: quiet });
  const d0 = await buildPaxosHealth(dopts(0));
  const d1 = await buildPaxosHealth(dopts((d0.payload.cache.sMaxAge - 60) * 1000));
  const d2 = await buildPaxosHealth(dopts((d0.payload.cache.sMaxAge + 60) * 1000));
  ok(d0.payload.cache.sMaxAge === 300 && d1.meta.memo === 'reuse' && d2.meta.memo !== 'reuse', `degraded payload reused only within its ${d0.payload.cache.sMaxAge} s budget (${d1.meta.memo}, ${d2.meta.memo})`);
}
resetMemo();
ok(engineRuns <= 1, `the memo tests ran the real engine at most once (${engineRuns})`);
engine.run = realRun;

// ---------- 3. API handler ----------
function fakeRes() {
  const r = { statusCode: 0, headers: {}, body: undefined, ended: false };
  r.setHeader = (k, val) => { r.headers[k.toLowerCase()] = val; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = JSON.parse(JSON.stringify(b)); r.ended = true; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}
const logs = [];
const silent = { log: (m) => logs.push(String(m)), warn: quiet, error: (m) => logs.push(String(m)) };
const handlerWith = (override) => createHandler({ build: (o) => build({ ...o, log: quiet, override }), log: silent });
const call = async (h, method, url = '/api/paxos') => { const res = fakeRes(); await h({ method, url, query: {}, headers: {} }, res); return res; };
const CC = (s) => `public, s-maxage=${s}, stale-while-revalidate=86400, stale-if-error=86400`;
const apiHeaders = (res, label) => {
  ok(res.headers['x-paxos-status'] === res.body.status.level && res.headers['x-paxos-generated-at'] === res.body.generatedAt, `${label}: X-Paxos-Status / X-Paxos-Generated-At match the body (${res.headers['x-paxos-status']}, ${res.headers['x-paxos-generated-at']})`);
  ok(res.headers['access-control-allow-origin'] === '*' && res.headers['cross-origin-resource-policy'] === 'cross-origin', `${label}: ACAO * and CORP cross-origin`);
};

logs.length = 0;
const okRes = await call(handlerWith(null), 'GET');
ok(okRes.statusCode === 200 && okRes.ended, 'GET /api/paxos -> 200');
ok(okRes.headers['cache-control'] === CC(1800), `Cache-Control on success (${okRes.headers['cache-control']})`);
apiHeaders(okRes, 'GET');
ok(/total;dur=\d+/.test(okRes.headers['server-timing'] || '') && /memo;desc="off"/.test(okRes.headers['server-timing']), 'Server-Timing header with the memo path');
ok(okRes.body.schemaVersion === 1 && okRes.body.cache.sMaxAge === 1800 && okRes.body.cache.staleIfError === 86400, 'payload carries its cache policy');
validate(okRes.body, 'api body');
// H11: one JSON log line per build.
{
  const lines = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && x.evt === 'paxos.build');
  const k = ['memo', 'totalMs', 'fetchMs', 'engineMs', 'sources', 'cgCalls', 'feed', 'errors', 'bytes'];
  ok(lines.length === 1 && k.every((x) => x in lines[0]) && ['ok', 'partial', 'stale', 'error'].every((s) => Number.isInteger(lines[0].sources[s])) && lines[0].memo === 'off' && lines[0].bytes === Buffer.byteLength(JSON.stringify(okRes.body)) && Number.isInteger(lines[0].cgCalls), `one JSON build log line with ${k.join(', ')} (${JSON.stringify(lines[0] || logs[0] || null).slice(0, 300)})`);
}
// Handler-only behaviour uses a stub build that returns a fixture payload.
const stubHandler = (p = payload, metaX = {}) => createHandler({ build: async () => ({ payload: p, meta: { memo: 'off', ageMs: 0, timingsMs: { total: 0 }, ...metaX } }), log: silent });
const head = await call(stubHandler(), 'HEAD');
ok(head.statusCode === 200 && head.headers['cache-control'] === okRes.headers['cache-control'] && head.headers['x-paxos-status'] === 'ok', 'HEAD /api/paxos -> 200 with the GET cache policy and status');
// H7 through the handler: each status variant gets its budget in the header.
for (const [k, p] of Object.entries(variants)) {
  const r = await call(stubHandler(p), 'GET');
  ok(r.headers['cache-control'] === CC(wantTtl[k]), `H7 ${k}: Cache-Control ${r.headers['cache-control']}`);
  apiHeaders(r, `H11 ${k}`);
}
const qs = await call(stubHandler(), 'GET', '/api/paxos?asset=https://evil.example/&api=http://127.0.0.1/');
ok(qs.statusCode === 200 && !qs.headers.location && qs.headers['cache-control'] === okRes.headers['cache-control'] && qs.body.schemaVersion === 1, `query string is ignored (${qs.statusCode})`);
const sealed = new Proxy({}, { get: (_, k) => { if (k === 'method') return 'GET'; if (k === 'url') return '/api/paxos?x=1'; if (typeof k === 'string' && /^(query|headers|body|cookies|params|rawHeaders)$/.test(k)) throw new Error('handler read req.' + k); return undefined; } });
const sealedRes = fakeRes();
await stubHandler()(sealed, sealedRes);
ok(sealedRes.statusCode === 200, `handler ignores request input (${sealedRes.statusCode} ${sealedRes.body && sealedRes.body.message})`);
const opt = await call(stubHandler(), 'OPTIONS');
ok(opt.statusCode === 204 && opt.headers['access-control-allow-methods'] === 'GET, HEAD, OPTIONS', 'OPTIONS -> 204');
const post = await call(stubHandler(), 'POST');
ok(post.statusCode === 405 && post.headers.allow === 'GET, HEAD, OPTIONS', 'POST -> 405');
// Memo reuse through the handler (stub build): only what ran is timed; the CDN gets the remaining freshness.
{
  const r = await call(stubHandler(payload, { memo: 'reuse', ageMs: 600e3 }), 'GET');
  ok(r.headers['x-paxos-memo'] === 'reuse' && r.headers['server-timing'] === 'memo;desc="reuse", total;dur=0', `reuse: Server-Timing lists no stage that did not run (${r.headers['server-timing']})`);
  ok(r.headers['cache-control'] === CC(1800 - 600), `reuse: s-maxage is the remaining freshness (${r.headers['cache-control']})`);
  const late = await call(stubHandler(payload, { memo: 'reuse', ageMs: 4000e3 }), 'GET');
  ok(late.headers['cache-control'] === CC(0), `an over-age payload gets s-maxage=0 (${late.headers['cache-control']})`);
}

// CoinGecko down: still 200 with USD assets, CoinGecko reported as error, nothing invented (real build).
const cgDown = (url) => (hostOf(url) === 'api.coingecko.com' ? new Response('{"status":{"error_code":429}}', { status: 429, headers: { 'content-type': 'application/json' } }) : null);
const deg = await call(handlerWith(cgDown), 'GET');
ok(deg.statusCode === 200, 'CoinGecko down -> still 200');
validate(deg.body, 'degraded body');
ok(deg.body.sources.find((s) => s.id === 'coingecko').status === 'error' && deg.body.status.level === 'degraded' && deg.headers['x-paxos-status'] === 'degraded', 'CoinGecko source status error, payload degraded');
const usdLive = deg.body.totals.usd.assets.filter((k) => deg.body.assets[k].status === 'active');
ok(usdLive.length >= 2 && usdLive.every((k) => deg.body.assets[k].current.supplyUsd > 0 && deg.body.assets[k].current.volume24hUsd === null), 'USD assets keep DefiLlama supply; CoinGecko-only fields are null');
ok(deg.body.insights.testsRun > 100 && deg.body.briefing && deg.body.briefing.verdict, 'engine and briefing still run without CoinGecko');
// Both price providers down: the gold value is unknown, so the all-assets total is not a number and the
// CDN rechecks after 5 minutes (finding #14).
const pricesDown = (url) => (hostOf(url) === 'api.coingecko.com' || hostOf(url) === 'coins.llama.fi' ? new Response('{"status":{"error_code":429}}', { status: 429, headers: { 'content-type': 'application/json' } }) : null);
const noPx = await call(handlerWith(pricesDown), 'GET');
validate(noPx.body, 'prices-down body');
const noPxMissing = Object.values(noPx.body.assets).filter((a) => a.status !== 'dead' && a.current.supplyUsd === null).map((a) => a.key);
ok(noPxMissing.length >= 1 && noPx.body.totals.allUsd.current === null && JSON.stringify(noPx.body.totals.allUsd.missing) === JSON.stringify(noPxMissing) && noPx.body.totals.allUsd.coveredUsd > 0, `prices down: allUsd is null and lists ${noPxMissing} instead of counting them as $0`);
ok(noPx.headers['cache-control'] === CC(300), `prices down: degraded CDN cache (${noPx.headers['cache-control']})`);
// Every upstream down: 502, not cached, no internal error text in the body.
const allDown = () => new Response('down', { status: 503, headers: { 'content-type': 'text/plain' } });
const dead = await call(handlerWith(allDown), 'GET');
ok(dead.statusCode === 502 && dead.headers['cache-control'] === 'no-store' && dead.body.error === 'paxos_health_unavailable', 'no data at all -> 502 no-store');
const crash = await call(createHandler({ build: async () => { throw new TypeError('(arr || []).map is not a function'); }, log: silent }), 'GET');
ok(crash.statusCode === 502 && !/is not a function|arr \|\|/.test(crash.body.message), `502 body carries a generic message (${crash.body.message})`);
// Supply source down: shorter CDN cache so the page recovers sooner.
const listDown = (url) => (hostOf(url) === 'stablecoins.llama.fi' ? new Response('down', { status: 503 }) : null);
const part = await call(handlerWith(listDown), 'GET');
ok(part.statusCode === 200 && part.headers['cache-control'] === CC(300) && part.body.cache.sMaxAge === 300, `DefiLlama stablecoins down -> 200 from CoinGecko supply with a 5-minute CDN cache (${part.statusCode} ${part.headers['cache-control']})`);
validate(part.body, 'stablecoins-down body');

// Queued, spaced requests must keep a bare process alive until served (the limiter's timers are not
// unref'd). A child process with nothing else scheduled sends 3 CoinGecko-host requests to a stub.
const child = spawnSync(process.execPath, ['-e', `
  const { fetchJson } = require(${JSON.stringify(here('../lib/paxos/http.js'))});
  const f = async () => new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } });
  let n = 0;
  process.on('exit', () => console.log('settled ' + n));
  for (let i = 0; i < 3; i++) fetchJson({ url: 'https://api.coingecko.com/api/v3/ping?i=' + i, fetch: f }).then((r) => { if (r.ok) n++; });
`], { encoding: 'utf8', timeout: 120e3, env: { ...process.env, COINGECKO_DEMO_API_KEY: 'offline-check-not-a-key' } });
ok(/settled 3/.test(child.stdout), `queued requests settle before the process exits (${(child.stdout || child.stderr).trim()})`);

// ---------- 4. static checks: page + deploy config ----------
const html = read('../pages/paxos/index.html');
const app = read('../pages/paxos/app.js');
const tags = (re) => [...html.matchAll(re)].map((m) => ({ at: m.index, attrs: Object.fromEntries([...m[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((a) => [a[1].toLowerCase(), a[2] ?? ''])) }));
const scriptTags = tags(/<script\b([^>]*)>/g), linkTags = tags(/<link\b([^>]*)\/?>/g);
ok(scriptTags.length === 2 && scriptTags.every((s) => 'defer' in s.attrs && /^\/paxos\//.test(s.attrs.src || '')), `index.html loads exactly two same-origin deferred scripts (${scriptTags.map((s) => s.attrs.src)})`);
const chartTag = scriptTags.find((s) => s.attrs.src === '/paxos/vendor/chart.umd.min.js'), appTag = scriptTags.find((s) => s.attrs.src === '/paxos/app.js');
ok(chartTag && appTag && chartTag.at < appTag.at, 'the vendored Chart.js loads before app.js');
// H14: Chart.js 4.5.1 vendored; its sha256 is the SRI the CDN copy was pinned to.
const CHART_SRI = 'sha256-SERKgtTty1vsDxll+qzd4Y2cF9swY9BCq62i9wXJ9Uo=';
const vendored = fs.existsSync(here('../pages/paxos/vendor/chart.umd.min.js')) ? fs.readFileSync(here('../pages/paxos/vendor/chart.umd.min.js')) : null;
ok(vendored && 'sha256-' + crypto.createHash('sha256').update(vendored).digest('base64') === CHART_SRI && /Chart\.js v4\.5\.1/.test(vendored.slice(0, 400).toString('utf8')), 'pages/paxos/vendor/chart.umd.min.js is Chart.js 4.5.1 with the pinned hash');
ok(!chartTag || !chartTag.attrs.integrity || chartTag.attrs.integrity === CHART_SRI, 'a same-origin SRI attribute, when present, is the pinned hash');
// H2: preload the API before any script, fetched without custom headers (so the preload is used).
const preload = linkTags.find((l) => l.attrs.rel === 'preload' && l.attrs.href === '/api/paxos');
ok(preload && preload.attrs.as === 'fetch' && preload.attrs.crossorigin === 'anonymous' && preload.at < Math.min(...scriptTags.map((s) => s.at)), 'H2: <link rel="preload" href="/api/paxos" as="fetch" crossorigin="anonymous"> precedes the first script');
const fetchCalls = [...app.matchAll(/\bfetch\(/g)].map((m) => { let d = 0, i = m.index + 5; for (; i < app.length; i++) { if (app[i] === '(') d++; else if (app[i] === ')' && --d === 0) break; } return app.slice(m.index, i + 1); });
ok(fetchCalls.length >= 1 && fetchCalls.every((s) => /^fetch\(API\b/.test(s) && !/headers\s*:|credentials\s*:|mode\s*:/.test(s)), `every fetch is fetch(API…) without headers, credentials or mode (${fetchCalls.map((s) => s.slice(0, 60))})`);
ok(/const API = '\/api\/paxos'/.test(app) && !/[?&]api=/.test(app), 'one same-origin API URL, not user-controlled');
ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline scripts in index.html');
// H14: styles from paxos.css only (no <style>, no style attributes, none set from script).
const sheets = linkTags.filter((l) => l.attrs.rel === 'stylesheet').map((l) => l.attrs.href);
ok(!/<style\b/i.test(html) && !/\sstyle\s*=/i.test(html), 'no inline <style> or style= attribute in index.html');
ok(sheets.includes('/paxos/paxos.css') && sheets.every((s) => /^\/[^/]/.test(s)) && fs.existsSync(here('../pages/paxos/paxos.css')), `stylesheets are same-origin and include /paxos/paxos.css (${sheets})`);
ok(!/setAttribute\(\s*['"]style['"]|\.cssText\b|style\s*=\s*['"`]/.test(app), 'app.js never writes a style attribute (the CSP blocks them; CSSOM properties only)');
assert.doesNotThrow(() => new vm.Script(app, { filename: 'app.js' }), 'app.js parses');
checks++;
ok(!/\.innerHTML\b|outerHTML\s*=|insertAdjacentHTML|document\.write/.test(app + html), 'external text never goes through innerHTML (textContent via h())');
ok(!/\beval\s*\(|new Function\s*\(|setTimeout\(\s*['"`]/.test(app), 'no eval-like code (the CSP forbids it)');
ok(!/\by[12]\s*:\s*\{|yAxisID|position:\s*['"]right['"]/.test(app), 'no dual-axis chart config');
ok(!/doughnut|['"]pie['"]|polarArea/.test(app), 'no donut/pie charts');
// Nothing about the discovered assets is hard-coded in the page.
const lits = new Set();
for (const a of payload.discovery.assets) for (const s of [a.key, a.symbol, a.name, a.geckoId]) if (s) lits.add(s);
for (const s of [...payload.pegPeers, ...payload.goldRefs]) for (const x of [s.symbol, s.geckoId, s.name]) if (x) lits.add(x);
const chainNames = new Set(Object.values(payload.assets).flatMap((a) => a.chains.map((c) => c.chain)).concat(payload.discovery.addresses.map((x) => x.chain)));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const css = fs.existsSync(here('../pages/paxos/paxos.css')) ? read('../pages/paxos/paxos.css') : '';
for (const s of lits) ok(!new RegExp(`\\b${esc(s)}\\b`).test(app) && !new RegExp(`\\b${esc(s)}\\b`).test(html.replace(/<meta[^>]*>/g, '')) && !new RegExp(`\\b${esc(s)}\\b`).test(css), `page hard-codes "${s}"`);
for (const c of chainNames) ok(!new RegExp(`['"\`]${esc(c)}['"\`]`).test(app), `app.js hard-codes chain "${c}"`);
for (const x of payload.discovery.addresses) ok(!app.toLowerCase().includes(x.address.toLowerCase()), `app.js hard-codes address ${x.address}`);
ok(!/0x[0-9a-fA-F]{40}/.test(app + html), 'no contract addresses in the page');

const vercel = JSON.parse(read('../vercel.json'));
const buildSh = read('./build-vercel.sh');
ok(vercel.functions && vercel.functions['api/paxos.js'] && vercel.functions['api/paxos.js'].maxDuration === 60, 'vercel.json: api/paxos.js maxDuration 60');
ok(!(vercel.rewrites || []).some((r) => r.source === '/'), 'vercel.json: no rewrite of "/" (the filesystem index would win)');
ok((vercel.redirects || []).some((r) => r.source === '/' && r.destination === '/paxos' && r.permanent === false && (r.has || []).some((h) => h.type === 'host' && h.value === 'paxos.rodiger.io')), 'vercel.json: paxos.rodiger.io/ redirects to /paxos (temporary)');
ok((vercel.redirects || []).some((r) => r.source === '/usdg' && r.destination === '/paxos') && (vercel.crons || []).some((c) => c.path === '/api/redeploy'), 'vercel.json keeps the /usdg redirect and the cron');
// Security headers (H14). The page's CSP allows exactly what index.html and app.js load: everything
// same-origin, no 'unsafe-inline', no external origin.
const headersFor = (path) => Object.fromEntries((vercel.headers || []).filter((r) => new RegExp('^' + r.source.split('(.*)').map(esc).join('.*') + '$').test(path)).flatMap((r) => r.headers.map((x) => [x.key.toLowerCase(), x.value])));
const parseCsp = (s) => Object.fromEntries(String(s || '').split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...vals]) => [k.toLowerCase(), vals]));
for (const path of ['/paxos', '/paxos/app.js', '/paxos/vendor/chart.umd.min.js', '/paxos/paxos.css']) {
  const hs = headersFor(path), csp = parseCsp(hs['content-security-policy']);
  ok(hs['x-content-type-options'] === 'nosniff' && hs['x-frame-options'] === 'DENY' && /^(strict-origin-when-cross-origin|no-referrer|same-origin)$/.test(hs['referrer-policy'] || ''), `${path}: nosniff, X-Frame-Options and Referrer-Policy`);
  const want = { 'default-src': ["'none'"], 'script-src': ["'self'"], 'style-src': ["'self'"], 'img-src': ["'self'"], 'connect-src': ["'self'"], 'base-uri': ["'none'"], 'form-action': ["'none'"], 'frame-ancestors': ["'none'"], 'upgrade-insecure-requests': [] };
  const sorted = (o) => JSON.stringify(Object.entries(o).map(([k, v]) => [k, v.slice().sort()]).sort());
  ok(sorted(csp) === sorted(want), `${path}: CSP is exactly ${Object.entries(want).map(([k, v]) => [k, ...v].join(' ')).join('; ')} (got ${hs['content-security-policy']})`);
  ok(!/unsafe-inline|unsafe-eval|https?:|\*/.test(hs['content-security-policy'] || 'x'), `${path}: CSP has no 'unsafe-inline', eval or external origin`);
  ok(hs['permissions-policy'] === 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' && hs['cross-origin-opener-policy'] === 'same-origin' && hs['cross-origin-resource-policy'] === 'same-origin', `${path}: Permissions-Policy, COOP and CORP (${hs['permissions-policy']}, ${hs['cross-origin-opener-policy']}, ${hs['cross-origin-resource-policy']})`);
}
// What the page loads is covered by that CSP: same-origin scripts, sheets, icons and the API.
const icons = linkTags.filter((l) => /^(icon|apple-touch-icon)$/.test(l.attrs.rel)).map((l) => l.attrs.href);
ok([...scriptTags.map((s) => s.attrs.src), ...sheets, ...icons].every((u) => /^\/[^/]/.test(u)), 'every script, stylesheet and icon index.html loads is same-origin');
ok(!/url\(\s*['"]?(https?:)?\/\//.test(css) && !/@import/.test(css), 'paxos.css loads nothing external');
const apiH = headersFor('/api/paxos');
ok(apiH['x-content-type-options'] === 'nosniff' && /frame-ancestors 'none'/.test(apiH['content-security-policy'] || ''), '/api/paxos: nosniff and a deny-all CSP');
const dev = read('./dev-paxos.mjs');
ok(/process\.env\.HOST \|\| '127\.0\.0\.1'/.test(dev) && /\.listen\(PORT, HOST/.test(dev) && !/pathname === '\/' \|\|/.test(dev), 'dev server listens on loopback and serves "/" only via vercel.json redirects');
// The build runs this check before cargo, skipping it only when nothing it covers changed since the
// last successful deployment (H15). The guard is executed here with the check replaced by an echo.
ok(buildSh.indexOf('node scripts/check-paxos-dashboard.mjs') >= 0 && buildSh.indexOf('node scripts/check-paxos-dashboard.mjs') < buildSh.indexOf('cargo'), 'build runs this check before cargo');
{
  const guardEnd = buildSh.indexOf('\nfi\n', buildSh.indexOf('VERCEL_GIT_PREVIOUS_SHA'));
  const guard = buildSh.slice(0, guardEnd + 4).replace(/^\s*node scripts\/check-paxos-dashboard\.mjs\s*$/m, '  echo RUN-CHECK');
  const covered = ['lib/paxos', 'api/paxos.js', 'pages/paxos', "'scripts/check-paxos-*.mjs'", 'scripts/fixtures/paxos', 'scripts/dev-paxos.mjs', 'scripts/monitor-paxos.mjs', '.github/workflows/paxos-monitor.yml', 'scripts/build-vercel.sh', 'vercel.json'];
  // Vercel exposes VERCEL_GIT_PREVIOUS_SHA only when an Ignored Build Step is set; "exit 1" always builds.
  ok(vercel.ignoreCommand === 'exit 1', `vercel.json sets ignoreCommand "exit 1" so the build sees VERCEL_GIT_PREVIOUS_SHA (${vercel.ignoreCommand})`);
  ok(guardEnd > 0 && /RUN-CHECK/.test(guard) && covered.every((p) => guard.includes(p)), `the skip guard diffs every path the checks cover (${covered.filter((p) => !guard.includes(p))})`);
  const root = here('..');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.status === 0) {
    const sh = (env) => spawnSync('bash', ['-c', guard], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } }).stdout.trim();
    const sha = head.stdout.trim();
    ok(sh({}) === 'RUN-CHECK', 'no VERCEL_GIT_PREVIOUS_SHA: the check runs');
    ok(sh({ VERCEL_GIT_PREVIOUS_SHA: '0123456789abcdef0123456789abcdef01234567' }) === 'RUN-CHECK', 'a previous SHA missing from the clone: the check runs');
    ok(/^paxos unchanged since [0-9a-f]{40}/.test(sh({ VERCEL_GIT_PREVIOUS_SHA: sha })), 'the same commit: the check is skipped and the log says so');
    const touched = spawnSync('git', ['log', '-1', '--format=%H', '--', 'lib/paxos'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const parent = touched && spawnSync('git', ['rev-parse', '--verify', '--quiet', `${touched}^`], { cwd: root, encoding: 'utf8' }).stdout.trim();
    if (parent) ok(sh({ VERCEL_GIT_PREVIOUS_SHA: parent }) === 'RUN-CHECK', 'a commit before the last lib/paxos change: the check runs');
  } else console.warn('warning: git unavailable; the build guard was not executed');
}
for (const gone of ['../api/llama.js', './fetch-dune.js', '../static/data/dune.json', '../dist/data/dune.json']) ok(!fs.existsSync(here(gone)), `${gone} is deleted`);
const codeFiles = ['../api', '../lib', '../pages', '../static', './'].flatMap((d) => fs.readdirSync(here(d), { recursive: true }).map((f) => here(d) + '/' + f))
  .filter((f) => /\.(js|mjs|html|sh|json|css)$/.test(f) && !f.includes('/fixtures/') && !f.includes('/vendor/') && !f.endsWith('check-paxos-dashboard.mjs') && fs.statSync(f).isFile())
  .concat([here('../vercel.json')]);
for (const f of codeFiles) ok(!/api\/llama|fetch-dune|dune\.json/.test(fs.readFileSync(f, 'utf8')), `${f} references the removed llama proxy or Dune pipeline`);
// The monitor workflow (H8, lead amendment 1): deployment_status, one daily schedule, manual; no secrets.
{
  const wf = read('../.github/workflows/paxos-monitor.yml');
  const crons = [...wf.matchAll(/cron:\s*'([^']+)'/g)].map((m) => m[1]);
  ok(/^on:\s*\n\s+deployment_status:\s*\n\s+schedule:\s*\n\s+- cron: '17 7 \* \* \*'\s*\n\s+workflow_dispatch:\s*$/m.test(wf) && JSON.stringify(crons) === JSON.stringify(['17 7 * * *']), `paxos-monitor.yml triggers on deployment_status, daily 07:17 UTC and manual only (${crons})`);
  ok(/github\.event\.deployment_status\.state == 'success'/.test(wf) && /github\.event\.deployment\.environment == 'Production'/.test(wf) && /node scripts\/monitor-paxos\.mjs https:\/\/www\.rodiger\.io/.test(wf) && !/secrets\./.test(wf), 'the monitor runs on successful Production deployments, against production, without secrets');
  ok(fs.existsSync(here('./monitor-paxos.mjs')) && !/require\(|from ['"](?!node:)/.test(read('./monitor-paxos.mjs')), 'monitor-paxos.mjs exists and uses node builtins only (the workflow checks out that one file)');
}

// ---------- 5. app.js helpers in a vm, on the real payload ----------
const ctx = { window: {}, console, URL, URLSearchParams };
vm.createContext(ctx);
vm.runInContext(app, ctx, { filename: 'app.js' });
const D = ctx.window.PaxosDashboard;
ok(D && ['parseQuery', 'buildQuery', 'canonicalAsset', 'insightMatches'].every((k) => typeof D[k] === 'function'), 'app.js exports its pure helpers on window.PaxosDashboard without a DOM');
const p = JSON.parse(body);
for (const k of keys) ok(JSON.stringify(D.parseQuery(D.buildQuery({ asset: k, range: '1y', lens: 'peg', legacy: true }))) === JSON.stringify({ ...D.parseQuery(''), asset: k, range: '1y', lens: 'peg', legacy: true }), `URL state round trip for ${k}`);
ok(/^\??$/.test(D.buildQuery(D.parseQuery(''))) && D.parseQuery('?lens=defi').lens === 'usage' && D.parseQuery('?lens=revenue').lens === 'income', 'defaults are omitted from the URL; lens aliases defi -> usage, revenue -> income');
ok(D.canonicalAsset(keys[0].toLowerCase(), keys) === keys[0] && D.canonicalAsset('no-such', keys) === null, 'asset keys match case-insensitively; unknown assets fall back');
ok(p.insights.feed.every((c) => D.insightMatches(c.lead, 'all')), 'feed matches the All filter');

// ---------- sub-check results ----------
const subs = await Promise.all(subResults);
const subFailed = subs.filter((r) => r.code !== 0);
for (const r of subFailed) process.stdout.write(`--- ${r.script} (exit ${r.code}${r.signal ? ', ' + r.signal : ''}):\n${r.out || ''}\n`);
if (subFailed.length) throw new Error(`${subFailed.map((r) => r.script).join(', ')} failed`);
checks += subs.length;
const totalMs = performance.now() - T0;
const BUDGET_MS = 30e3; // about 10 s on a laptop; a warning only, unless PAXOS_PERF_STRICT=1
if (totalMs > BUDGET_MS) {
  const msg = `check took ${Math.round(totalMs)} ms (budget ${BUDGET_MS / 1000} s): a slow machine, or a performance regression worth a look`;
  if (process.env.PAXOS_PERF_STRICT === '1') assert.fail(msg);
  console.warn('warning: ' + msg);
}
// (node:test prints "ℹ pass 69" with the spec reporter and "# pass 69" with tap)
for (const r of subs) { const lines = r.out.trim().split('\n').filter((l) => /checks? passed|^[#ℹ] (pass|fail) \d+/.test(l)); console.log(`  ${(lines.length ? (/^[#ℹ]/.test(lines[0]) ? `${r.script.replace(/^\.\//, '')}: ` : '') + lines.join(' | ') : r.script).slice(0, 200)} (${Math.round(r.ms)} ms)`); }
console.log(`check-paxos-dashboard: ${checks} checks passed in ${Math.round(totalMs)} ms (fixture ${new Date(NOW * 1000).toISOString()}; build ${Math.round(buildMs)} ms; payload ${Math.round(raw / 1024)} KB raw / ${Math.round(gz / 1024)} KB gzip; ${ins.testsRun} tests, ${ins.feed.length} feed clusters)`);
