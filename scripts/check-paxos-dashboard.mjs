#!/usr/bin/env node
// Offline, deterministic checks for the Paxos health dashboard (run by scripts/build-vercel.sh):
//   1. the data-layer, engine and page checks (check-paxos-sources.mjs, check-paxos-engine.mjs,
//      check-paxos-page.mjs)
//   2. end to end on the recorded upstream fixture: buildPaxosHealth -> payload validated against the
//      schemaVersion 1 contract (docs/paxos-dashboard.md), units and ranges, one snapshot per number,
//      token-flow changes, freshness rules, memoisation, determinism, size
//   3. api/paxos.js with a fake req/res: 200 + headers, HEAD, query string ignored, OPTIONS/405,
//      memo reuse headers, CoinGecko down still 200, prices down -> incomplete total + short cache,
//      everything down 502 no-store with a generic message
//   4. static checks on pages/paxos and the deploy config (host redirect, CSP derived from the page)
//   5. app.js helpers in a vm against the payload
//   6. the page itself rendered under a small DOM shim against the payload (every asset x range):
//      no section or chart may fail, no NaN/undefined text, chart configs follow the dataviz rules
// No network: every upstream request is answered from scripts/fixtures/paxos/upstream.json.gz.
// Wall-clock time is reported, not asserted (a slow build machine must not fail the deploy); set
// PAXOS_PERF_STRICT=1 to turn the time budget into a failure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createFixtureFetch, loadFixture } from './fixtures/paxos/fixture-fetch.mjs';

const require = createRequire(import.meta.url);
const T0 = performance.now();
const here = (p) => new URL(p, import.meta.url).pathname;
const read = (p) => fs.readFileSync(here(p), 'utf8');
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

// ---------- 1. data layer + engine ----------
// The timeout is a hang guard, not a performance gate.
for (const script of ['./check-paxos-sources.mjs', './check-paxos-engine.mjs', './check-paxos-page.mjs']) {
  const r = spawnSync(process.execPath, [here(script)], { encoding: 'utf8', timeout: 300e3 });
  if (r.status !== 0) {
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    throw new Error(`${script} failed (exit ${r.status}${r.error ? ', ' + r.error.message : ''})`);
  }
  checks++;
}

// ---------- 2. end to end on the fixture ----------
const { buildPaxosHealth, resetMemo, REUSE_MS } = require('../lib/paxos/index.js');
const { createCache } = require('../lib/paxos/cache.js');
const { hostOf } = require('../lib/paxos/http.js');
const { DIMENSIONS } = require('../lib/paxos/engine.js');
const { collectRaw, createClient, SOURCES } = require('../lib/paxos/sources.js');
const { buildModel } = require('../lib/paxos/model.js');
const { buildPayload, tokenFlowView, CACHE, CACHE_DEGRADED } = require('../lib/paxos/payload.js');
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

// --- a small validator for the schemaVersion 1 contract ---
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const errors = [];
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const prim = {
  string: (x) => typeof x === 'string',
  number: isNum,
  integer: (x) => Number.isInteger(x),
  boolean: (x) => typeof x === 'boolean',
  date: (x) => typeof x === 'string' && DATE.test(x),
  iso: (x) => typeof x === 'string' && ISO.test(x),
  any: () => true,
};
// spec: 'type' | 'type?' (nullable) | [spec] | { key: spec, 'key?': spec (optional) } | { $map: spec } |
// { $enum: [...], $null? } | function(x, path) -> error string | null
function v(x, spec, path) {
  if (typeof spec === 'string') {
    const nullable = spec.endsWith('?');
    const t = nullable ? spec.slice(0, -1) : spec;
    if (x === null && nullable) return;
    if (!prim[t](x)) errors.push(`${path}: expected ${spec}, got ${JSON.stringify(x)?.slice(0, 60)}`);
    return;
  }
  if (typeof spec === 'function') { const e = spec(x, path); if (e) errors.push(`${path}: ${e}`); return; }
  if (Array.isArray(spec)) {
    if (!Array.isArray(x)) return void errors.push(`${path}: expected array`);
    x.forEach((y, i) => v(y, spec[0], `${path}[${i}]`));
    return;
  }
  if (spec.$nullable) { if (x === null) return; return v(x, spec.$nullable, path); }
  if (spec.$enum) { if (!spec.$enum.includes(x)) errors.push(`${path}: ${JSON.stringify(x)} not in ${spec.$enum.join('|')}`); return; }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return void errors.push(`${path}: expected object`);
  if (spec.$map) { for (const [k, y] of Object.entries(x)) v(y, spec.$map, `${path}.${k}`); return; }
  const keys = new Set();
  for (const [k0, s] of Object.entries(spec)) {
    const optional = k0.endsWith('?'), k = optional ? k0.slice(0, -1) : k0;
    keys.add(k);
    if (!(k in x)) { if (!optional) errors.push(`${path}.${k}: missing`); continue; }
    v(x[k], s, `${path}.${k}`);
  }
  for (const k of Object.keys(x)) if (!keys.has(k)) errors.push(`${path}.${k}: unexpected key`);
}
const N = (spec) => ({ $nullable: spec });
const compactOf = (max) => (x, path) => {
  if (!x || typeof x !== 'object' || !DATE.test(x.start) || !Array.isArray(x.values)) return 'expected Compact {start, values}';
  if (!x.values.length) return 'empty Compact';
  if (max && x.values.length > max) return `Compact longer than ${max} values (${x.values.length})`;
  if (!x.values.every((y) => y === null || isNum(y))) return 'Compact values must be numbers or null';
  if (Object.keys(x).length !== 2) return 'Compact has extra keys';
  return null;
};
const Compact = compactOf(null);
const change = N({ abs: 'number', pct: 'number?' });
const Changes = { d1: change, d7: change, d30: change, d90: change, d365: change };
const hourlySpec = N((x) => (x && Array.isArray(x.t) && Array.isArray(x.v) && x.t.length === x.v.length && x.t.length > 0 && x.t.every(Number.isInteger) && x.v.every((y) => y === null || isNum(y)) && x.t.every((t, i) => !i || t > x.t[i - 1]) ? null : 'expected hourly {t:[unix asc], v:[]}'));
const insight = {
  id: 'string', detector: 'string', asset: 'string', chain: 'string?', dimension: { $enum: DIMENSIONS },
  polarity: { $enum: ['positive', 'negative', 'neutral'] },
  surprise: { bits: 'number?', adjustedBits: 'number?', p: 'number', E: 'number', m: 'integer', notable: 'boolean', underpowered: 'boolean' },
  materialityUsd: 'number?', materialityShare: 'number?', materialityFloorUsd: 'number?',
  novelty: { ageDays: 'integer?', isNew: 'boolean', front: 'integer?' },
  headline: 'string', detail: 'string?',
  evidence: { metric: 'string?', value: 'any', baseline: 'any', window: 'string?', stat: 'string?', n: 'number?', nEff: 'number?', otherWindows: [{ window: 'string?', p: 'number?' }], 'series?': compactOf(120) },
  drivers: N([{ asset: 'string', chain: 'string?', usd: 'number' }]),
  asOf: 'iso?',
};
const SCHEMA = {
  schemaVersion: (x) => (x === 1 ? null : 'must be 1'),
  generatedAt: 'iso', dataAsOf: 'iso?',
  cache: { sMaxAge: 'integer', staleWhileRevalidate: 'integer' },
  // engine is null when the insights were reused from an identical model (memo hit): no engine run.
  timingsMs: { fetch: 'integer', model: 'integer', engine: 'integer?', total: 'integer' },
  sources: [{
    id: 'string', label: 'string', host: 'string?', kind: { $enum: ['discovery', 'supply', 'price', 'defi', 'usage', 'economics', 'onchain', 'market'] },
    status: { $enum: ['ok', 'partial', 'stale', 'error', 'skipped'] }, requests: 'integer', failed: 'integer', bytes: 'integer', latencyMs: 'integer?',
    fetchedAt: 'iso?', dataAsOf: 'iso?', cadenceHours: 'number?', staleAfterHours: 'number?', ageHours: (x) => (x === null || (isNum(x) && x >= 0) ? null : 'ageHours must be >= 0 or null'), message: 'string?',
  }],
  discovery: {
    tiers: [{ id: 'string', label: 'string', ok: 'boolean', found: ['string'] }],
    assets: [{ key: 'string', symbol: 'string', name: 'string', kind: { $enum: ['usd-stablecoin', 'gold', 'fiat-stablecoin', 'other'] }, status: { $enum: ['active', 'legacy', 'dead'] }, unit: 'string', geckoId: 'string?', llamaId: 'string?', via: ['string'], firstDate: 'date?', colorIndex: 'integer?' }],
    addresses: [{ asset: 'string', chain: 'string', address: 'string', decimals: 'integer?', role: { $enum: ['issuer', 'unverified', 'bridged', 'unlisted'] }, via: ['string'] }],
  },
  totals: {
    // Market denominators and ranks come from DefiLlama's stablecoin endpoints: null while those are down.
    usd: { key: 'string', label: 'string', assets: ['string'], current: 'number', supplyAsOf: 'iso', supplyUsd: Compact, change: Changes, ath: { value: 'number', date: 'date' }, drawdownPct: 'number', marketShare: N(Compact), shareCurrent: 'number?', rankEquivalent: 'integer?' },
    allUsd: { label: 'string', current: 'number?', coveredUsd: 'number?', missing: ['string'], supplyAsOf: 'iso?' },
  },
  market: { definition: 'string', coverageFrom: 'date?', usdTotal: N(Compact), allTotal: N(Compact) },
  assets: { $map: {
    key: 'string', symbol: 'string', name: 'string', kind: 'string', status: 'string', unit: 'string', colorIndex: 'integer?',
    current: {
      supply: 'number?', supplyUsd: 'number?', supplyAsOf: 'iso?', supplySource: 'string?', price: 'number?', priceAsOf: 'iso?', pegDevBp: 'number?', pegAsOf: 'iso?',
      changeBasis: { $enum: ['token-flow', 'market-value'] }, change: Changes, ath: N({ value: 'number', date: 'date' }), drawdownPct: 'number?',
      changeNative: N(Changes), athNative: N({ value: 'number', date: 'date' }), drawdownNativePct: 'number?',
      rank: 'integer?', rankOf: 'integer?', marketShare: 'number?', volume24hUsd: 'number?', turnover24h: 'number?',
    },
    series: { supplyUsd: N(Compact), supply: N(Compact), price: N(Compact), priceHourly: hourlySpec, xau: N(Compact), turnover7d: N(Compact) },
    chains: [{ chain: 'string', currentUsd: 'number?', share: 'number?', first: 'date?', status: { $enum: ['tracked', 'tracking_ended', 'new'] }, change: { d1: change, d7: change, d30: change }, series: N(compactOf(400)), notes: ['string'] }],
    defi: N({ footprintUsd: 'number', footprintShare: 'number?', poolCount: 'integer', effectivePools: 'number?', rewardShare: 'number?', pools: [{ pool: 'string', project: 'string', chain: 'string', symbol: 'string', tvlUsd: 'number?', apy: 'number?', apyBase: 'number?', apyReward: 'number?', utilization: 'number?', supplyUsd: 'number?', borrowUsd: 'number?', url: (x) => (x === null || /^https:\/\/defillama\.com\/yields\/pool\/[A-Za-z0-9-]+$/.test(x) ? null : 'bad pool url') }] }),
    onchain: [{ chain: 'string', address: 'string?', holders: 'integer?', totalSupply: 'number?', source: 'string?', asOf: 'iso?' }],
    activity: N({ source: 'string', key: 'string', chain: 'string?', series: { activeAddresses: N(compactOf(400)), transfers: N(compactOf(400)), holders: N(compactOf(400)) } }),
    notes: ['string'],
  } },
  peers: { pegType: 'string', asOf: 'iso?', count: 'integer', rows: [{ id: 'string', symbol: 'string', name: 'string', supplyUsd: 'number', change: { d1: change, d7: change, d30: change }, isPaxos: 'boolean', assetKey: 'string?' }], excluded: [{ id: 'string', symbol: 'string', pegType: 'string?', jumpUsd: 'number?', prevDay: 'number?', current: 'number?', listSum: 'number?', chartSum: 'number?', tolerance: 'number?' }] },
  pegPeers: [{ symbol: 'string', geckoId: 'string?', priceHourly: hourlySpec, price: N(Compact) }],
  goldRefs: [{ symbol: 'string', geckoId: 'string?', name: 'string?', priceHourly: hourlySpec }],
  economics: N({ label: (x) => (x === 'DefiLlama model estimate' ? null : 'label must be "DefiLlama model estimate"'), note: 'string', fees: N(Compact), revenue: N(Compact), impliedYield: N(Compact), current: { fees24h: 'number?', revenue24h: 'number?', fees1y: 'number?', impliedYield: 'number?', baseUsd: 'number?' } }),
  attribution: N({ windows: { $map: { from: 'date', to: 'date', totalDeltaUsd: 'number', grossUsd: 'number', rotationUsd: 'number', assets: [{ asset: 'string', prevUsd: 'number', currUsd: 'number', deltaUsd: 'number' }], chains: [{ asset: 'string', chain: 'string', prevUsd: 'number', currUsd: 'number', deltaUsd: 'number' }] } } }),
  insights: {
    rule: { text: 'string' }, testsRun: 'integer', groups: 'integer', families: { $map: 'integer' }, family: N({ counted: 'integer', dimensions: 'integer', floor: 'integer', underpowered: 'integer' }), floorsUsd: { $map: 'number' },
    feed: [{ rootKey: 'string', lead: insight, related: [insight] }], standing: [insight], watch: [insight], context: [insight],
    health: { dimensions: ['string'], assets: ['string'], cells: { $map: { $map: { state: { $enum: ['notable_negative', 'notable_positive', 'notable_neutral', 'within_own_history', 'insufficient_history', 'no_data'] }, tests: 'integer', notable: 'integer', negative: 'integer', positive: 'integer', evidence: N({ id: 'string', headline: 'string', polarity: 'string', p: 'number', E: 'number' }) } } }, summary: { $map: 'string' } },
    errors: [{ detector: 'string', error: 'string' }],
  },
};
function validate(p, label) {
  errors.length = 0;
  v(p, SCHEMA, label);
  // No NaN/Infinity anywhere (JSON would silently turn them into null).
  const walk = (x, path) => {
    if (typeof x === 'number' && !Number.isFinite(x)) errors.push(`${path}: non-finite number`);
    else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) walk(y, `${path}.${k}`);
  };
  walk(p, label);
  assert.deepEqual(errors.slice(0, 20), [], `${label} violates the payload contract:\n${errors.slice(0, 20).join('\n')}`);
  checks++;
}
validate(payload, 'payload');

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
// The market share starts where DefiLlama's USD total became comparable with today's (coverageFrom).
const cov = payload.market.coverageFrom;
ok(!cov || (payload.totals.usd.marketShare.start >= cov && cov < cEnd(payload.market.usdTotal)), `the market share starts at the market coverage start (${payload.totals.usd.marketShare.start} vs ${cov})`);

// Units and ranges (shares and turnover are fractions, pct and drawdown in percent, peg in bp): each
// field is checked against the figures it is derived from, so a x100 or x1e3 slip cannot pass.
const t = payload.totals.usd;
const pk = Math.max(...t.supplyUsd.values.filter(isNum));
ok(t.drawdownPct <= 0 && t.drawdownPct > -100 && near(t.drawdownPct, 100 * (t.current / pk - 1), 1e-2) && t.ath.value === pk, `totals: drawdown in percent from the series peak (${t.drawdownPct})`);
// (the share uses DefiLlama's per-day USD values, the total today's price: equal within a peg wobble)
ok(near(t.shareCurrent, t.current / cAt(payload.market.usdTotal, cEnd(t.supplyUsd)), 2e-3 * t.shareCurrent), 'totals: shareCurrent = total / USD market on the same day');
for (const [w, d] of [['d1', 1], ['d7', 7], ['d30', 30], ['d90', 90], ['d365', 365]]) {
  const prev = cAt(t.supplyUsd, new Date(Date.parse(cEnd(t.supplyUsd)) - d * 864e5).toISOString().slice(0, 10));
  if (isNum(prev)) ok(near(t.change[w].abs, t.current - prev, 2) && near(t.change[w].pct, (100 * (t.current - prev)) / prev, 1e-3), `totals ${w}: change abs in USD, pct in percent`);
}
for (const a of Object.values(payload.assets)) {
  const c = a.current;
  for (const ch of a.chains) ok(!ch.series || ch.series.values.length <= 400, `${a.key}/${ch.chain}: chain series <= 400 d`);
  if (a.chains.length) ok(Math.abs(a.chains.reduce((s, ch) => s + (ch.share || 0), 0) - 1) < 1e-3 && a.chains.every((ch) => ch.share === null || (ch.share >= 0 && ch.share <= 1)), `${a.key}: chain shares are fractions summing to 1`);
  // A chain whose DefiLlama tracking ended counts as 0 (as in the asset total) and says so.
  for (const ch of a.chains.filter((x) => x.status === 'tracking_ended')) ok(ch.currentUsd === 0 && ch.share === 0 && ch.notes.length > 0, `${a.key}/${ch.chain}: tracking ended -> 0 with a note`);
  if (a.kind === 'usd-stablecoin') ok(a.series.supply === null && a.unit === 'USD' && c.changeBasis === 'token-flow' && c.changeNative === null, `${a.key}: USD asset uses supplyUsd (token flows) only`);
  else ok(c.changeBasis === 'market-value' && c.changeNative && a.series.supply, `${a.key}: non-USD asset reports market-value changes plus changeNative`);
  // The current level is the history's last point, unless it adds chains the history does not cover
  // ('<history>+onchain'): then it is at least that point and a note says why. Peaks, drawdowns and
  // changes are always the history's own.
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
  // CoinGecko turnover = 24h volume / CoinGecko market cap; that cap is the same supply within a factor of 2.
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
// Gold: changeNative is the ounce series' own change; change is the USD market value's.
for (const a of gold) {
  const end = cEnd(a.series.supply), prev = cAt(a.series.supply, new Date(Date.parse(end) - 7 * 864e5).toISOString().slice(0, 10));
  if (isNum(prev)) ok(near(a.current.changeNative.d7.abs, cLast(a.series.supply) - prev, 1), `${a.key}: changeNative.d7 is in ounces`);
  ok(a.current.athNative && a.current.athNative.value === Math.max(...a.series.supply.values.filter(isNum)), `${a.key}: athNative is the ounce peak`);
}

// One snapshot per number: dataAsOf is the hero's supply snapshot time, every current figure says when
// it is from, and nothing claims to be newer than the payload.
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

// Freshness: an hourly series is shipped only while its last point is within a day of now; an older one
// is dropped with a note (the page then uses daily prices).
const hourlyOk = (h) => h === null || NOW - h.t.at(-1) <= DAY;
ok(Object.values(payload.assets).every((a) => hourlyOk(a.series.priceHourly)) && payload.pegPeers.every((x) => hourlyOk(x.priceHourly)) && payload.goldRefs.every((x) => hourlyOk(x.priceHourly)), 'no hourly series older than a day is shipped');
ok(Object.values(payload.assets).filter((a) => a.notes.some((n) => /^Hourly prices/.test(n))).every((a) => a.series.priceHourly === null), 'assets noted as stale-hourly ship no hourly series');
// A source whose message reports lagging series is not 'ok'.
ok(payload.sources.filter((s) => / series lag/.test(s.message || '')).every((s) => s.status !== 'ok'), 'a source with lagging series is not reported ok');

const listed = payload.peers.rows;
ok(listed.length >= Math.min(25, payload.peers.count) && listed.filter((r) => r.isPaxos).every((r) => payload.assets[r.assetKey]), 'peers: top 25 + every Paxos list member, joined to asset keys');
ok(Object.values(payload.assets).filter((a) => a.kind === 'usd-stablecoin' && a.current.rank).every((a) => listed.some((r) => r.assetKey === a.key)), 'every ranked Paxos USD asset appears in the peer rows');
ok(payload.pegPeers.length >= 1 && payload.goldRefs.length >= 1, 'peg peers and gold references discovered');
ok(payload.economics && payload.economics.current.impliedYield > 0 && payload.economics.current.impliedYield < 1, 'economics: implied yield is a fraction');
const ins = payload.insights;
ok(ins.testsRun > 300 && ins.groups > 50 && ins.errors.length === 0, `insights ran clean (${ins.testsRun} tests, errors ${JSON.stringify(ins.errors).slice(0, 200)})`);
ok(ins.watch.length <= 40 && ins.feed.length >= 1, 'feed non-empty, watch <= 40');
ok(JSON.stringify(ins.health.dimensions) === JSON.stringify(DIMENSIONS), 'health grid uses the fixed dimension vocabulary');
ok(ins.health.assets[0] === payload.totals.usd.key && keys.every((k) => ins.health.assets.includes(k)), 'health rows: the aggregate (totals.usd.key) + every asset');
const allIns = [...ins.feed.flatMap((c) => [c.lead, ...c.related]), ...ins.standing, ...ins.watch, ...ins.context];
ok(new Set(allIns.map((i) => i.id)).size === allIns.length, 'insight ids are unique');
ok(allIns.every((i) => !/NaN|undefined|Infinity/.test(i.headline + ' ' + (i.detail || ''))), 'no NaN/undefined in insight text');
ok(allIns.every((i) => !i.evidence.series || i.evidence.series.values.length <= 120), 'evidence sparklines <= 120 points');
ok(ins.feed.every((c) => c.lead.surprise.notable && c.lead.surprise.E < 1), 'feed leads are notable (E < 1)');
ok(/E = m x p < 1/.test(ins.rule.text) && /average/.test(ins.rule.text) && /underpowered/.test(ins.rule.text) && /neutral/.test(ins.rule.text), 'rule text states the family size, underpowered and data-quality rules');
const raw = Buffer.byteLength(body), gz = zlib.gzipSync(body).length;
ok(raw < 650e3, `payload ${Math.round(raw / 1024)} KB raw is above the 650 KB guard (target < 600 KB)`);

// --- payload rules on a model, isolated from the data (mutations of the fixture model) ---
const rawBundle = await collectRaw({ fetch: createFixtureFetch(fixture), now: NOW, cache: createCache(), log: quiet });
const model = buildModel(rawBundle, { now: NOW });
const genAt = new Date(NOW * 1000 + 5000).toISOString();
const payloadOf = (m) => buildPayload(m, null, null, { generatedAt: genAt }).payload;
const base = payloadOf(model);
const withAsset = (m, key, f) => ({ ...m, assets: m.assets.map((a) => (a.key === key ? f(a) : a)) });
const bump = (s, t, factor) => ({ t: s.t, v: s.v.map((x, i) => (s.t[i] === t && Number.isFinite(x) ? x * factor : x)) });
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
// A current level wider than the history (other issuer chains added on-chain) is what the asset and the
// all-assets total show; changes and drawdown stay on the history. Model errors reach insights.errors.
{
  const lp = { t: lastT(goldA.supply), v: goldA.supply.v.at(-1) };
  const extra = lp.v * 0.01, px = goldA.supplyUsd.v.at(-1) / lp.v;
  const cur = { supply: lp.v + extra, price: px, supplyUsd: (lp.v + extra) * px, asOf: lp.t, priceAsOf: NOW - 60, source: `${goldA.supplySource}+onchain`, parts: [{ chain: 'a', supply: lp.v, asOf: lp.t }, { chain: 'b', supply: extra, asOf: NOW - 60 }], note: 'history covers one chain' };
  const p = payloadOf(withAsset({ ...model, errors: ['model.asset X.section: boom'] }, goldA.key, (a) => ({ ...a, current: cur })));
  const g = p.assets[goldA.key].current, g0 = base.assets[goldA.key].current;
  ok(near(g.supply, cur.supply, 1e-3 * cur.supply) && near(g.supplyUsd, cur.supplyUsd, 1) && g.supplySource === cur.source && p.assets[goldA.key].notes.includes(cur.note) && g.priceAsOf === new Date((NOW - 60) * 1000).toISOString(), `${goldA.key}: a wider current level is shipped with its source, quote time and note`);
  ok(JSON.stringify(g.changeNative) === JSON.stringify(g0.changeNative) && g.drawdownNativePct === g0.drawdownNativePct, `${goldA.key}: changes and drawdown stay on the history`);
  ok(near(p.totals.allUsd.current - base.totals.allUsd.current, cur.supplyUsd - base.assets[goldA.key].current.supplyUsd, 2), 'the all-assets total uses the wider current level');
  ok(p.insights.errors.some((e) => e.detector === 'model' && /boom/.test(e.error)), 'model errors are listed in insights.errors');
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
  ok(p.totals.allUsd.current === null && p.totals.allUsd.missing.includes(goldA.key) && near(p.totals.allUsd.coveredUsd, base.totals.allUsd.current - base.assets[goldA.key].current.supplyUsd, 2) && p.cache.sMaxAge === CACHE_DEGRADED.sMaxAge, 'missing USD value: total null, gap listed, degraded cache');
}

// Source freshness rules (sources.createClient): a lagging series makes its source not ok; a source
// whose freshest data is older than two of its own publication intervals is stale.
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

// --- memoisation, single flight, reuse window and determinism ---
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
ok(REUSE_MS >= 15 * 60e3 && REUSE_MS * 1e-3 <= CACHE.sMaxAge, 'reuse window bounds rebuilds to <= 4 an hour and stays within the CDN freshness budget');
const m4 = await buildPaxosHealth(mopts(REUSE_MS + 60e3));
ok(m4.meta.memo === 'hit' && calls > callsAfterFirst && m4.payload.insights === m1.payload.insights && m4.payload.generatedAt === new Date(NOW * 1000 + REUSE_MS + 60e3).toISOString(), 'identical upstream data reuses the insights (no engine run), restamped with the new build time');
ok(m4.payload.timingsMs.engine === null && m4.payload.timingsMs.fetch >= 0 && !('engine' in m4.meta.timingsMs), 'memo hit: timings say the engine did not run');
const ageAt = (s, gen) => Math.max(0, (Date.parse(gen) - Date.parse(s.dataAsOf)) / 3.6e6);
ok(m4.payload.sources.filter((s) => s.dataAsOf).every((s) => near(s.ageHours, ageAt(s, m4.payload.generatedAt), 0.006)) && m4.payload.sources.some((s) => s.ageHours > (m1.payload.sources.find((x) => x.id === s.id) || {}).ageHours), 'memo hit: source ages recomputed against the new generatedAt');
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
  ok(d0.payload.cache.sMaxAge === CACHE_DEGRADED.sMaxAge && d1.meta.memo === 'reuse' && d2.meta.memo !== 'reuse', `degraded payload reused only within its ${d0.payload.cache.sMaxAge} s budget (${d1.meta.memo}, ${d2.meta.memo})`);
}
resetMemo();
const again = await build();
// Measured provenance (latency, wall-clock fetchedAt, stage timings) is the only thing allowed to differ.
const strip = (p) => JSON.stringify({ ...p, timingsMs: null, sources: p.sources.map((s) => ({ ...s, latencyMs: null, fetchedAt: null })) });
ok(strip(again.payload) === strip(payload), 'two builds on the same data are byte-identical (measured timings aside)');

// ---------- 3. API handler ----------
function fakeRes() {
  const r = { statusCode: 0, headers: {}, body: undefined, ended: false };
  r.setHeader = (k, val) => { r.headers[k.toLowerCase()] = val; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = JSON.parse(JSON.stringify(b)); r.ended = true; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}
const silent = { log: quiet, warn: quiet, error: quiet };
let builds = 0;
const handlerWith = (override) => createHandler({ build: (o) => { builds++; return build({ ...o, log: quiet, override }); }, log: silent });
const call = async (h, method, url = '/api/paxos') => { const res = fakeRes(); await h({ method, url, query: {}, headers: {} }, res); return res; };

const okRes = await call(handlerWith(null), 'GET');
ok(okRes.statusCode === 200 && okRes.ended, 'GET /api/paxos -> 200');
ok(okRes.headers['access-control-allow-origin'] === '*', 'ACAO *');
ok(okRes.headers['cache-control'] === 'public, s-maxage=1800, stale-while-revalidate=86400', `Cache-Control on success (${okRes.headers['cache-control']})`);
ok(/total;dur=\d+/.test(okRes.headers['server-timing'] || '') && /memo;desc="off"/.test(okRes.headers['server-timing']), 'Server-Timing header with the memo path');
ok(okRes.body.schemaVersion === 1 && okRes.body.cache.sMaxAge === 1800, 'payload carries its cache policy');
validate(okRes.body, 'api body');
// Handler-only behaviour uses a stub build that returns the fixture payload.
const stubHandler = () => createHandler({ build: async () => { builds++; return { payload, meta: { memo: 'off', ageMs: 0, timingsMs: { total: 0 } } }; }, log: silent });
const head = await call(stubHandler(), 'HEAD');
ok(head.statusCode === 200 && head.headers['cache-control'] === okRes.headers['cache-control'], 'HEAD /api/paxos -> 200 with the GET cache policy');
// A query string is ignored: same payload and cache policy as the canonical URL, never a redirect
// (a self-redirect would loop if the platform appended a parameter); the memo bounds rebuilds.
const qs = await call(stubHandler(), 'GET', '/api/paxos?asset=https://evil.example/&api=http://127.0.0.1/');
ok(qs.statusCode === 200 && !qs.headers.location && qs.headers['cache-control'] === okRes.headers['cache-control'] && qs.body.schemaVersion === 1, `query string is ignored (${qs.statusCode})`);
// The handler reads only req.method and req.url: query, headers, body and cookies never reach a build.
const sealed = new Proxy({}, { get: (_, k) => { if (k === 'method') return 'GET'; if (k === 'url') return '/api/paxos?x=1'; if (typeof k === 'string' && /^(query|headers|body|cookies|params|rawHeaders)$/.test(k)) throw new Error('handler read req.' + k); return undefined; } });
const sealedRes = fakeRes();
await stubHandler()(sealed, sealedRes);
ok(sealedRes.statusCode === 200, `handler ignores request input (${sealedRes.statusCode} ${sealedRes.body && sealedRes.body.message})`);
const opt = await call(stubHandler(), 'OPTIONS');
ok(opt.statusCode === 204 && opt.headers['access-control-allow-methods'] === 'GET, HEAD, OPTIONS', 'OPTIONS -> 204');
const post = await call(stubHandler(), 'POST');
ok(post.statusCode === 405 && post.headers.allow === 'GET, HEAD, OPTIONS', 'POST -> 405');
// Memo reuse through the handler: only what ran is timed; the CDN gets the remaining freshness only.
{
  resetMemo();
  const cache = createCache();
  const memoHandler = (ms) => createHandler({ build: () => buildPaxosHealth(mopts(ms, cache)), log: silent });
  await call(memoHandler(0), 'GET');
  const r = await call(memoHandler(600e3), 'GET');
  ok(r.headers['x-paxos-memo'] === 'reuse' && r.headers['server-timing'] === 'memo;desc="reuse", total;dur=0', `reuse: Server-Timing lists no stage that did not run (${r.headers['server-timing']})`);
  ok(r.headers['cache-control'] === `public, s-maxage=${1800 - 600}, stale-while-revalidate=86400`, `reuse: s-maxage is the remaining freshness (${r.headers['cache-control']})`);
  resetMemo();
}

// CoinGecko down: still 200 with USD assets, CoinGecko reported as error, nothing invented.
const cgDown = (url) => (hostOf(url) === 'api.coingecko.com' ? new Response('{"status":{"error_code":429}}', { status: 429, headers: { 'content-type': 'application/json' } }) : null);
const deg = await call(handlerWith(cgDown), 'GET');
ok(deg.statusCode === 200, 'CoinGecko down -> still 200');
validate(deg.body, 'degraded body');
ok(deg.body.sources.find((s) => s.id === 'coingecko').status === 'error', 'CoinGecko source status error');
const usdLive = deg.body.totals.usd.assets.filter((k) => deg.body.assets[k].status === 'active');
ok(usdLive.length >= 2 && usdLive.every((k) => deg.body.assets[k].current.supplyUsd > 0 && deg.body.assets[k].current.volume24hUsd === null), 'USD assets keep DefiLlama supply; CoinGecko-only fields are null');
ok(deg.body.insights.testsRun > 100, 'engine still runs without CoinGecko');
// Both price providers down: the gold value is unknown, so the all-assets total is not a number and the
// CDN rechecks after 5 minutes (finding #14).
const pricesDown = (url) => (hostOf(url) === 'api.coingecko.com' || hostOf(url) === 'coins.llama.fi' ? new Response('{"status":{"error_code":429}}', { status: 429, headers: { 'content-type': 'application/json' } }) : null);
const noPx = await call(handlerWith(pricesDown), 'GET');
validate(noPx.body, 'prices-down body');
const noPxMissing = Object.values(noPx.body.assets).filter((a) => a.status !== 'dead' && a.current.supplyUsd === null).map((a) => a.key);
ok(noPxMissing.length >= 1 && noPx.body.totals.allUsd.current === null && JSON.stringify(noPx.body.totals.allUsd.missing) === JSON.stringify(noPxMissing) && noPx.body.totals.allUsd.coveredUsd > 0, `prices down: allUsd is null and lists ${noPxMissing} instead of counting them as $0`);
ok(noPx.headers['cache-control'] === 'public, s-maxage=300, stale-while-revalidate=86400', `prices down: degraded CDN cache (${noPx.headers['cache-control']})`);

// Every upstream down: 502, not cached, no internal error text in the body.
const allDown = () => new Response('down', { status: 503, headers: { 'content-type': 'text/plain' } });
const dead = await call(handlerWith(allDown), 'GET');
ok(dead.statusCode === 502 && dead.headers['cache-control'] === 'no-store' && dead.body.error === 'paxos_health_unavailable', 'no data at all -> 502 no-store');
const crash = await call(createHandler({ build: async () => { throw new TypeError('(arr || []).map is not a function'); }, log: silent }), 'GET');
ok(crash.statusCode === 502 && !/is not a function|arr \|\|/.test(crash.body.message), `502 body carries a generic message (${crash.body.message})`);
// Supply source down: shorter CDN cache so the page recovers sooner.
const listDown = (url) => (hostOf(url) === 'stablecoins.llama.fi' ? new Response('down', { status: 503 }) : null);
const part = await call(handlerWith(listDown), 'GET');
ok(part.statusCode === 200 && part.headers['cache-control'] === 'public, s-maxage=300, stale-while-revalidate=86400' && part.body.cache.sMaxAge === 300, `DefiLlama stablecoins down -> 200 from CoinGecko supply with a 5-minute CDN cache (${part.statusCode} ${part.headers['cache-control']})`);
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
ok(/<script defer src="\/paxos\/app\.js"><\/script>/.test(html), 'index.html loads /paxos/app.js with defer');
ok(/<script defer src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js@4\.[\d.]+\/dist\/chart\.umd\.min\.js" integrity="sha256-[A-Za-z0-9+/=]+" crossorigin="anonymous"><\/script>/.test(html), 'Chart.js 4 pinned with SRI');
ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline scripts in index.html');
assert.doesNotThrow(() => new vm.Script(app, { filename: 'app.js' }), 'app.js parses');
checks++;
ok(!/\.innerHTML\b|outerHTML\s*=|insertAdjacentHTML|document\.write/.test(app + html), 'external text never goes through innerHTML (textContent via h())');
ok(!/\beval\s*\(|new Function\s*\(|setTimeout\(\s*['"`]/.test(app), 'no eval-like code (the CSP forbids it)');
// A second value axis would be a y1/y2 scale object, a yAxisID or a right-hand axis (SVG line y1/y2 attributes are fine).
ok(!/\by[12]\s*:\s*\{|yAxisID|position:\s*['"]right['"]/.test(app), 'no dual-axis chart config');
ok(!/doughnut|['"]pie['"]/.test(app), 'no donut/pie charts');
ok(/fetch\(API,/.test(app) && /const API = '\/api\/paxos'/.test(app) && !/[?&]api=/.test(app), 'one same-origin fetch, no user-controlled API URL');
// Nothing about the discovered assets is hard-coded in the page.
const lits = new Set();
for (const a of payload.discovery.assets) for (const s of [a.key, a.symbol, a.name, a.geckoId]) if (s) lits.add(s);
for (const s of [...payload.pegPeers, ...payload.goldRefs]) for (const x of [s.symbol, s.geckoId, s.name]) if (x) lits.add(x);
const chainNames = new Set(Object.values(payload.assets).flatMap((a) => a.chains.map((c) => c.chain)).concat(payload.discovery.addresses.map((x) => x.chain)));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const s of lits) ok(!new RegExp(`\\b${esc(s)}\\b`).test(app) && !new RegExp(`\\b${esc(s)}\\b`).test(html.replace(/<meta[^>]*>/g, '')), `page hard-codes "${s}"`);
for (const c of chainNames) ok(!new RegExp(`['"\`]${esc(c)}['"\`]`).test(app), `app.js hard-codes chain "${c}"`);
for (const x of payload.discovery.addresses) ok(!app.toLowerCase().includes(x.address.toLowerCase()), `app.js hard-codes address ${x.address}`);
ok(!/0x[0-9a-fA-F]{40}/.test(app + html), 'no contract addresses in the page');

const vercel = JSON.parse(read('../vercel.json'));
const buildSh = read('./build-vercel.sh');
ok(vercel.functions && vercel.functions['api/paxos.js'] && vercel.functions['api/paxos.js'].maxDuration === 60, 'vercel.json: api/paxos.js maxDuration 60');
// Vercel applies rewrites after the filesystem, and dist/index.html matches "/", so the host alias must
// be a redirect (redirects run before the filesystem).
ok(!(vercel.rewrites || []).some((r) => r.source === '/'), 'vercel.json: no rewrite of "/" (the filesystem index would win)');
ok((vercel.redirects || []).some((r) => r.source === '/' && r.destination === '/paxos' && r.permanent === false && (r.has || []).some((h) => h.type === 'host' && h.value === 'paxos.rodiger.io')), 'vercel.json: paxos.rodiger.io/ redirects to /paxos (temporary)');
ok((vercel.redirects || []).some((r) => r.source === '/usdg' && r.destination === '/paxos') && (vercel.crons || []).some((c) => c.path === '/api/redeploy'), 'vercel.json keeps the /usdg redirect and the cron');
// Security headers. The page's CSP must allow exactly what index.html and app.js load.
const headersFor = (path) => Object.fromEntries((vercel.headers || []).filter((r) => new RegExp('^' + r.source.split('(.*)').map(esc).join('.*') + '$').test(path)).flatMap((r) => r.headers.map((x) => [x.key.toLowerCase(), x.value])));
const parseCsp = (s) => Object.fromEntries(String(s || '').split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...vals]) => [k.toLowerCase(), vals]));
for (const path of ['/paxos', '/paxos/app.js']) {
  const hs = headersFor(path), csp = parseCsp(hs['content-security-policy']);
  ok(hs['x-content-type-options'] === 'nosniff' && hs['x-frame-options'] === 'DENY' && /^(strict-origin-when-cross-origin|no-referrer|same-origin)$/.test(hs['referrer-policy'] || ''), `${path}: nosniff, X-Frame-Options and Referrer-Policy`);
  ok(JSON.stringify(csp['default-src']) === `["'none'"]` && JSON.stringify(csp['frame-ancestors']) === `["'none'"]` && JSON.stringify(csp['base-uri']) === `["'none'"]` && JSON.stringify(csp['form-action']) === `["'none'"]`, `${path}: CSP defaults to none, no framing, no base/form targets`);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const allowsScript = (src) => (/^\//.test(src) ? csp['script-src'].includes("'self'") : csp['script-src'].includes(src));
  ok(scripts.length >= 2 && scripts.every(allowsScript), `${path}: CSP script-src lists every script index.html loads, external ones by exact URL (missing: ${scripts.filter((s) => !allowsScript(s))})`);
  ok(csp['script-src'].every((x) => x === "'self'" || scripts.includes(x)), `${path}: CSP script-src allows nothing beyond those exact scripts (${csp['script-src']})`);
  const inlineStyle = /<style\b/.test(html), sheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  ok((!inlineStyle || csp['style-src'].includes("'unsafe-inline'")) && sheets.every((s) => /^\/[^/]/.test(s)) && csp['style-src'].includes("'self'") && !csp['style-src'].some((x) => /\*|^https?:$/.test(x)), `${path}: CSP style-src covers the inline <style> and same-origin stylesheets only`);
  const icons = [...html.matchAll(/<link\b[^>]*rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  ok(icons.every((s) => /^\/[^/]/.test(s)) && JSON.stringify(csp['img-src']) === `["'self'"]`, `${path}: CSP img-src is same-origin (favicons)`);
  ok(JSON.stringify(csp['connect-src']) === `["'self'"]` && /const API = '\/[^/]/.test(app), `${path}: CSP connect-src is same-origin (the API)`);
}
const apiH = headersFor('/api/paxos');
ok(apiH['x-content-type-options'] === 'nosniff' && /frame-ancestors 'none'/.test(apiH['content-security-policy'] || ''), '/api/paxos: nosniff and a deny-all CSP');
const dev = read('./dev-paxos.mjs');
ok(/process\.env\.HOST \|\| '127\.0\.0\.1'/.test(dev) && /\.listen\(PORT, HOST/.test(dev) && !/pathname === '\/' \|\|/.test(dev), 'dev server listens on loopback and serves "/" only via vercel.json redirects');
ok(buildSh.indexOf('node scripts/check-paxos-dashboard.mjs') >= 0 && buildSh.indexOf('node scripts/check-paxos-dashboard.mjs') < buildSh.indexOf('cargo'), 'build runs this check before cargo');
for (const gone of ['../api/llama.js', './fetch-dune.js', '../static/data/dune.json', '../dist/data/dune.json']) ok(!fs.existsSync(here(gone)), `${gone} is deleted`);
const codeFiles = ['../api', '../lib', '../pages', '../static', './'].flatMap((d) => fs.readdirSync(here(d), { recursive: true }).map((f) => here(d) + '/' + f))
  .filter((f) => /\.(js|mjs|html|sh|json|css)$/.test(f) && !f.includes('/fixtures/') && !f.endsWith('check-paxos-dashboard.mjs') && fs.statSync(f).isFile())
  .concat([here('../vercel.json')]);
for (const f of codeFiles) ok(!/api\/llama|fetch-dune|dune\.json/.test(fs.readFileSync(f, 'utf8')), `${f} references the removed llama proxy or Dune pipeline`);

// ---------- 5. app.js helpers in a vm, on the real payload ----------
const ctx = { window: {}, console, URL, URLSearchParams };
vm.createContext(ctx);
vm.runInContext(app, ctx, { filename: 'app.js' });
const D = ctx.window.PaxosDashboard;
ok(D && typeof D.changeFor === 'function' && D.DEFAULT_RANGE, 'app.js exports its pure helpers without a DOM');
const p = JSON.parse(body);
const end = D.compactEnd(p.totals.usd.supplyUsd);
ok(DATE.test(end) && end <= p.generatedAt.slice(0, 10), 'aggregate ends on or before generatedAt');
for (const r of D.RANGES) {
  const ch = D.changeFor(p.totals.usd.change, p.totals.usd.supplyUsd, r.id);
  ok(ch && Number.isFinite(ch.abs), `totals change for ${r.id}`);
  if (r.days) {
    const derived = D.changeFromCompact(p.totals.usd.supplyUsd, r.days);
    ok(derived && Math.abs(derived.abs - p.totals.usd.change[r.win].abs) <= 2, `server and page agree on the ${r.id} window (${derived && derived.abs} vs ${p.totals.usd.change[r.win].abs})`);
  }
  for (const a of Object.values(p.assets)) {
    const s = a.unit === 'USD' ? a.series.supplyUsd : a.series.supply || a.series.supplyUsd;
    const sl = D.sliceCompact(s, r.days, end);
    ok(sl && sl.values.length >= 1 && sl.values.every((x) => x === null || Number.isFinite(x)), `${a.key} ${r.id} slice`);
    if (a.chains.length) {
      const series = a.chains.map((c) => c.series).filter(Boolean);
      const start = D.addDays(end, -Math.min(r.days || 364, 364));
      const weeks = D.bucketChanges(D.sumCompacts(series, start, end), start, end, 'week');
      ok(weeks.length >= 4 && weeks.every((w) => w.value === null || Number.isFinite(w.value)), `${a.key} ${r.id} chain heatmap buckets`);
      ok(weeks.every((w, i) => !i || D.daysBetween(weeks[i - 1].to, w.to) === 7), `${a.key} ${r.id}: heatmap weeks are 7 days`);
    }
    if (a.series.price) {
      const al = D.alignCompacts([a.series.price, ...p.pegPeers.map((x) => x.price)], D.addDays(end, -(r.days || 365)), end);
      ok(al.rows.every((row) => row.length === al.dates.length), `${a.key} ${r.id} peg alignment`);
    }
  }
}
for (const k of keys) ok(JSON.stringify(D.parseQuery(D.buildQuery({ asset: k, range: '1y', legacy: true }))) === JSON.stringify({ asset: k, range: '1y', legacy: true }), `URL state round trip for ${k}`);
for (const i of allIns) {
  const w = D.whyText(i);
  ok(/p = /.test(w) && /E = /.test(w) && !/NaN|undefined|n\/a/.test(w), `why-flagged text for ${i.id}: ${w}`);
}
ok(p.insights.feed.every((c) => D.insightMatches(c.lead, 'all')), 'feed matches the All Paxos filter');
const pct = D.pctFrom(p.totals.usd.change.d30, p.totals.usd.current);
ok(Math.abs(pct.pct - p.totals.usd.change.d30.pct) < 1e-3, 'page and server agree on percent changes (pct is in percent)');
// Formatter units and signs: one sign character, the value in the unit the name says.
const signs = (s) => (String(s).match(/[-−+]/g) || []).length;
const numIn = (s) => Number(String(s).replace(/[−]/g, '-').replace(/[^0-9.-]/g, ''));
ok(/%/.test(D.fmtShare(0.0188)) && near(numIn(D.fmtShare(0.0188)), 1.88, 0.05), `fmtShare renders a fraction as percent (${D.fmtShare(0.0188)})`);
ok(signs(D.fmtBp(-11.52)) === 1 && near(numIn(D.fmtBp(-11.52)), -11.52, 0.5) && /bp/.test(D.fmtBp(-11.52)), `fmtBp: one minus sign, basis points (${D.fmtBp(-11.52)})`);
ok(signs(D.fmtPct(-3.5)) === 1 && near(numIn(D.fmtPct(-3.5)), -3.5, 0.05) && /%/.test(D.fmtPct(-3.5)), `fmtPct: one sign, percent (${D.fmtPct(-3.5)})`);
ok(signs(D.fmtUsd(-4.9e6)) === 1 && near(numIn(D.fmtUsd(-4.9e6)), -4.9, 0.05) && /\$.*M/.test(D.fmtUsd(-4.9e6)), `fmtUsd: one sign, dollars in millions (${D.fmtUsd(-4.9e6)})`);

// ---------- 6. the page renders the payload (DOM shim) ----------
// A small DOM (enough for app.js: elements, text, attributes, simple selectors, events) built from
// index.html, a recording Chart stub that also checks each chart config, and app.js booted against the
// payload. Unsupported DOM use fails loudly with its name rather than passing silently.
const HTML_NS = 'http://www.w3.org/1999/xhtml';
class ShimNode {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; this._listeners = {}; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; return s[s.indexOf(this) + 1] || null; }
  get previousSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; return s[s.indexOf(this) - 1] || null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n.nodeType === 9; }
  get textContent() { return this.childNodes.map((c) => (c.nodeType === 8 ? '' : c.textContent)).join(''); }
  set textContent(s) { this.replaceChildren(); if (s !== null && s !== undefined && s !== '') this.appendChild(this.ownerDocument.createTextNode(String(s))); }
  _take(n) {
    if (!(n instanceof ShimNode)) throw new TypeError(`DOM shim: not a Node (${typeof n})`);
    if (n.nodeType === 11) { const kids = n.childNodes; n.childNodes = []; return kids; }
    for (let x = this; x; x = x.parentNode) if (x === n) throw new Error('DOM shim: HierarchyRequestError');
    if (n.parentNode) n.parentNode.removeChild(n);
    return [n];
  }
  appendChild(n) { for (const c of this._take(n)) { c.parentNode = this; this.childNodes.push(c); } return n; }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    const kids = this._take(n);
    let i = this.childNodes.indexOf(ref);
    if (i < 0) throw new Error('DOM shim: insertBefore reference is not a child');
    for (const c of kids) { c.parentNode = this; this.childNodes.splice(i++, 0, c); }
    return n;
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i < 0) throw new Error('DOM shim: removeChild of a non-child'); this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  replaceChild(n, old) { this.insertBefore(n, old); return this.removeChild(old); }
  _node(x) { return x instanceof ShimNode ? x : this.ownerDocument.createTextNode(String(x)); }
  append(...xs) { for (const x of xs) this.appendChild(this._node(x)); }
  prepend(...xs) { const ref = this.firstChild; for (const x of xs) this.insertBefore(this._node(x), ref); }
  replaceChildren(...xs) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...xs); }
  before(...xs) { for (const x of xs) this.parentNode.insertBefore(this._node(x), this); }
  after(...xs) { const ref = this.nextSibling; for (const x of xs) this.parentNode.insertBefore(this._node(x), ref); }
  replaceWith(...xs) { const p = this.parentNode; if (!p) return; const ref = this.nextSibling; p.removeChild(this); for (const x of xs) p.insertBefore(this._node(x), ref); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  hasChildNodes() { return this.childNodes.length > 0; }
  addEventListener(type, fn) { if (typeof fn === 'function' || (fn && fn.handleEvent)) (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter((f) => f !== fn); }
  dispatchEvent(ev) { return dispatchShimEvent(this, ev); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get childElementCount() { return this.children.length; }
  querySelectorAll(sel) { const m = compileSelector(sel), out = []; const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (m(c)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getElementsByTagName(tag) { return this.querySelectorAll(tag); }
  getElementsByClassName(c) { return this.querySelectorAll('.' + c); }
}
class ShimText extends ShimNode {
  constructor(doc, s, type = 3) { super(doc); this.nodeType = type; this.data = String(s); }
  get textContent() { return this.data; }
  set textContent(s) { this.data = String(s); }
  get nodeValue() { return this.data; }
}
const REFLECT = ['id', 'title', 'type', 'href', 'src', 'name', 'role', 'lang', 'dir', 'rel', 'scope', 'value'];
const BOOL = ['hidden', 'open', 'disabled', 'checked', 'selected'];
class ShimElement extends ShimNode {
  constructor(doc, tag, ns = HTML_NS) {
    super(doc);
    this.nodeType = 1;
    this.namespaceURI = ns;
    this.localName = ns === HTML_NS ? String(tag).toLowerCase() : String(tag);
    this._attrs = new Map();
    const style = {};
    Object.defineProperties(style, {
      setProperty: { value: (k, v) => { style[k] = String(v); } },
      removeProperty: { value: (k) => { delete style[k]; } },
      getPropertyValue: { value: (k) => style[k] || '' },
    });
    this.style = style;
  }
  get tagName() { return this.namespaceURI === HTML_NS ? this.localName.toUpperCase() : this.localName; }
  get nodeName() { return this.tagName; }
  _k(k) { return this.namespaceURI === HTML_NS ? String(k).toLowerCase() : String(k); }
  setAttribute(k, v) { this._attrs.set(this._k(k), String(v)); }
  getAttribute(k) { const x = this._attrs.get(this._k(k)); return x === undefined ? null : x; }
  removeAttribute(k) { this._attrs.delete(this._k(k)); }
  hasAttribute(k) { return this._attrs.has(this._k(k)); }
  toggleAttribute(k, force) { const on = force === undefined ? !this.hasAttribute(k) : !!force; if (on) this.setAttribute(k, ''); else this.removeAttribute(k); return on; }
  get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get classList() {
    const get = () => this.className.split(/\s+/).filter(Boolean), put = (xs) => this.setAttribute('class', [...new Set(xs)].join(' '));
    return {
      add: (...c) => put([...get(), ...c]), remove: (...c) => put(get().filter((x) => !c.includes(x))), contains: (c) => get().includes(c),
      toggle: (c, force) => { const on = force === undefined ? !get().includes(c) : !!force; put(on ? [...get(), c] : get().filter((x) => x !== c)); return on; },
      replace: (a, b) => put(get().map((x) => (x === a ? b : x))), get length() { return get().length; }, item: (i) => get()[i] || null, [Symbol.iterator]: () => get()[Symbol.iterator](),
    };
  }
  get dataset() {
    const attr = (k) => 'data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    return new Proxy({}, {
      get: (_, k) => (typeof k === 'string' ? (this.hasAttribute(attr(k)) ? this.getAttribute(attr(k)) : undefined) : undefined),
      set: (_, k, val) => { this.setAttribute(attr(k), val); return true; },
      has: (_, k) => this.hasAttribute(attr(k)),
      deleteProperty: (_, k) => { this.removeAttribute(attr(k)); return true; },
    });
  }
  get tabIndex() { const x = this.getAttribute('tabindex'); return x === null ? -1 : Number(x); }
  set tabIndex(v) { this.setAttribute('tabindex', v); }
  get innerText() { return this.textContent; }
  set innerText(s) { this.textContent = s; }
  matches(sel) { return compileSelector(sel)(this); }
  closest(sel) { const m = compileSelector(sel); for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (m(n)) return n; return null; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { dispatchShimEvent(this, shimEvent('click')); }
  scrollIntoView() {}
  scrollTo() {}
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, width: 800, height: 300, right: 800, bottom: 300 }; }
  getClientRects() { return [this.getBoundingClientRect()]; }
  get offsetWidth() { return 800; } get offsetHeight() { return 300; } get clientWidth() { return 800; } get clientHeight() { return 300; }
  get scrollWidth() { return 800; } get scrollHeight() { return 300; } get offsetParent() { return this.parentElement; }
  getContext() { return new Proxy({ measureText: (s) => ({ width: String(s).length * 6 }) }, { get: (o, k) => (k in o ? o[k] : () => {}) }); }
}
for (const k of REFLECT) Object.defineProperty(ShimElement.prototype, k, { get() { return this.getAttribute(k) || ''; }, set(v) { this.setAttribute(k, v); } });
for (const k of BOOL) Object.defineProperty(ShimElement.prototype, k, { get() { return this.hasAttribute(k); }, set(v) { this.toggleAttribute(k, !!v); } });
class ShimDocument extends ShimNode {
  constructor() { super(null); this.ownerDocument = this; this.nodeType = 9; this.readyState = 'complete'; this.visibilityState = 'visible'; this.hidden = false; this.activeElement = null; this.title = ''; }
  createElement(tag) { return new ShimElement(this, tag); }
  createElementNS(ns, tag) { return new ShimElement(this, tag, ns); }
  createTextNode(s) { return new ShimText(this, s); }
  createComment(s) { return new ShimText(this, s, 8); }
  createDocumentFragment() { const f = new ShimNode(this); f.nodeType = 11; return f; }
  get documentElement() { return this.children[0] || null; }
  get head() { return this.documentElement.querySelector('head'); }
  get body() { return this.documentElement.querySelector('body'); }
  getElementById(id) { return this.querySelectorAll(`#${id}`)[0] || null; }
  querySelectorAll(sel) { const m = compileSelector(sel), out = []; const walk = (n) => { if (n.nodeType === 1 && m(n)) out.push(n); for (const c of n.childNodes) if (c.nodeType === 1) walk(c); }; if (this.documentElement) walk(this.documentElement); return out; }
}
const selectorCache = new Map();
function compileSelector(sel) {
  if (selectorCache.has(sel)) return selectorCache.get(sel);
  const parts = [];
  let cur = '', depth = 0, quote = null;
  for (const ch of String(sel)) {
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (ch === ',' && !depth) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  parts.push(cur.trim());
  const tests = parts.map((p) => {
    const unsupported = () => new Error(`DOM shim: unsupported selector "${sel}" (simple compound selectors only)`);
    const m = /^([a-zA-Z][\w-]*|\*)?(.*)$/.exec(p);
    const tag = m[1] && m[1] !== '*' ? m[1] : null, conds = [];
    const re = /#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/g;
    let pos = 0;
    for (const x of m[2].matchAll(re)) {
      if (x.index !== pos) throw unsupported();
      pos = x.index + x[0].length;
      if (x[1]) conds.push((e) => e.getAttribute('id') === x[1]);
      else if (x[2]) conds.push((e) => e.className.split(/\s+/).includes(x[2]));
      else {
        const name = x[3], op = x[4], want = x[5] ?? x[6] ?? x[7];
        conds.push((e) => {
          const val = e.getAttribute(name);
          if (val === null) return false;
          if (!op) return true;
          return op === '=' ? val === want : op === '~=' ? val.split(/\s+/).includes(want) : op === '^=' ? val.startsWith(want) : op === '$=' ? val.endsWith(want) : op === '*=' ? val.includes(want) : val === want || val.startsWith(want + '-');
        });
      }
    }
    if (pos !== m[2].length || !p) throw unsupported();
    return (e) => e.nodeType === 1 && (!tag || e.localName.toLowerCase() === tag.toLowerCase()) && conds.every((c) => c(e));
  });
  const f = (e) => tests.some((tt) => tt(e));
  selectorCache.set(sel, f);
  return f;
}
const shimEvent = (type, extra = {}) => ({ type, bubbles: true, cancelable: true, defaultPrevented: false, isTrusted: false, timeStamp: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this._stop = true; }, stopImmediatePropagation() { this._stop = true; }, composedPath() { return this._path || []; }, ...extra });
let shimWindow = null;
function dispatchShimEvent(target, ev) {
  ev.target = target;
  const path = [];
  for (let n = target; n; n = n.parentNode) path.push(n);
  if (shimWindow) path.push(shimWindow);
  ev._path = path;
  for (const n of path) {
    ev.currentTarget = n;
    for (const fn of [...((n._listeners || {})[ev.type] || [])]) (typeof fn === 'function' ? fn : fn.handleEvent.bind(fn)).call(n, ev);
    if (ev._stop || !ev.bubbles) break;
  }
  return !ev.defaultPrevented;
}
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…', times: '×' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? all));
function parseHtml(src) {
  const doc = new ShimDocument();
  let cur = doc;
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|[^<]+|</g;
  let m;
  while ((m = re.exec(src))) {
    const tok = m[0];
    if (tok.startsWith('<!')) continue;
    if (m[1]) { for (let n = cur; n && n !== doc; n = n.parentNode) if (n.localName === m[1].toLowerCase()) { cur = n.parentNode; break; } continue; }
    if (m[2]) {
      const el = doc.createElement(m[2]);
      for (const a of (m[3] || '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ''));
      cur.appendChild(el);
      const tag = el.localName;
      if (tag === 'script' || tag === 'style') {
        const close = src.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
        el.appendChild(doc.createTextNode(src.slice(re.lastIndex, close)));
        re.lastIndex = src.indexOf('>', close) + 1;
      } else if (!VOID.has(tag)) cur = el;
      continue;
    }
    if (cur !== doc) cur.appendChild(doc.createTextNode(decode(tok)));
  }
  return doc;
}
// CSS custom properties of the page (the first definition of each), for getComputedStyle().
const cssVars = {};
for (const mm of html.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)[;}]/g)) if (!(mm[1] in cssVars)) cssVars[mm[1]] = mm[2].trim();

// Chart stub: records configs and checks them against the dataviz rules; callbacks are exercised with
// Chart.js-shaped arguments so a formatter that throws is caught here, not on a viewer's screen.
function makeChart(problems) {
  const autoviv = () => new Proxy({}, { get: (o, k) => (typeof k === 'symbol' || k === 'then' || k === 'toJSON' ? o[k] : k in o ? o[k] : (o[k] = autoviv())) });
  class Chart {
    constructor(canvas, cfg) {
      this.canvas = canvas; this.config = cfg; this.data = cfg && cfg.data; this.options = (cfg && cfg.options) || {};
      this.tooltip = { getActiveElements: () => [] }; this.chartArea = { top: 0, bottom: 300, left: 0, right: 800 };
      checkChart(this, problems);
      Chart.instances.push(this);
    }
    destroy() { this.destroyed = true; }
    update() {} resize() {} stop() {} reset() {} render() {} draw() {} clear() {}
    getDatasetMeta() { return { data: [], hidden: false }; }
    getElementsAtEventForMode() { return []; }
    isDatasetVisible() { return true; }
    toBase64Image() { return ''; }
    static register() {} static unregister() {} static getChart() { return undefined; }
  }
  Chart.defaults = autoviv();
  Chart.instances = [];
  return Chart;
}
function checkChart(chart, problems) {
  const cfg = chart.config || {}, where = (chart.canvas.getAttribute('aria-label') || (chart.canvas.closest('section') || { id: '?' }).id).slice(0, 80);
  const bad = (msg) => problems.push(`chart "${where}": ${msg}`);
  if (/^(pie|doughnut|polarArea)$/.test(cfg.type)) bad(`${cfg.type} chart`);
  const scales = (cfg.options && cfg.options.scales) || {};
  const yAxes = Object.entries(scales).filter(([k, s]) => (s && s.axis ? s.axis === 'y' : /^y/.test(k)));
  if (yAxes.length > 1) bad(`${yAxes.length} value axes (${yAxes.map(([k]) => k)})`);
  if (Object.values(scales).some((s) => s && s.position === 'right')) bad('right-hand axis');
  const data = cfg.data || {}, labels = Array.isArray(data.labels) ? data.labels : null, sets = data.datasets || [];
  if (!sets.length) bad('no datasets');
  for (const ds of sets) {
    if (ds.yAxisID && yAxes.length && ds.yAxisID !== yAxes[0][0]) bad(`dataset "${ds.label}" on a second axis`);
    if (!Array.isArray(ds.data)) { bad(`dataset "${ds.label}" data is not an array`); continue; }
    // A point is a number, null, {x, y} or a floating bar [start, end].
    const badPt = ds.data.find((x) => !(x === null || isNum(x) || (Array.isArray(x) && x.length === 2 && x.every((y) => y === null || isNum(y))) || (x && !Array.isArray(x) && typeof x === 'object' && (x.y === null || isNum(x.y)))));
    if (badPt !== undefined) bad(`dataset "${ds.label}" has a non-numeric point ${JSON.stringify(badPt)}`);
    if (labels && ds.data.every((x) => x === null || typeof x === 'number') && ds.data.length !== labels.length) bad(`dataset "${ds.label}" has ${ds.data.length} points for ${labels.length} labels`);
  }
  const run = (name, f, thisArg, ...args) => { if (typeof f !== 'function') return; try { f.apply(thisArg, args); } catch (e) { bad(`${name} threw ${e && e.message}`); } };
  const ds0 = sets[0] || { data: [] };
  const n = Math.max(labels ? labels.length : 0, ds0.data.length);
  const idxs = n ? [...new Set([0, Math.floor(n / 2), n - 1])] : [];
  const yOf = (x) => (Array.isArray(x) ? x[1] : x && typeof x === 'object' ? x.y : x);
  const nums = ds0.data.map(yOf).filter(isNum);
  const scaleCtx = { chart, getLabelForValue: (val) => (labels && Number.isInteger(val) && val >= 0 && val < labels.length ? labels[val] : String(val)) };
  for (const [k, s] of Object.entries(scales)) {
    const ticks = (s && s.ticks) || {};
    const vals = s && s.type === 'category' ? idxs : labels && !nums.length ? idxs : [...new Set([0, ...(nums.length ? [Math.min(...nums), Math.max(...nums)] : []), ...idxs])];
    const tickObjs = vals.map((value) => ({ value }));
    for (const [i, val] of vals.entries()) run(`scales.${k}.ticks.callback`, ticks.callback, scaleCtx, val, i, tickObjs);
    for (const opt of ['color', 'font']) if (typeof ticks[opt] === 'function') run(`scales.${k}.ticks.${opt}`, ticks[opt], null, { chart, index: 0, tick: tickObjs[0] || { value: 0 }, type: 'tick' });
  }
  const tcb = (((cfg.options || {}).plugins || {}).tooltip || {}).callbacks || {};
  const item = (i) => {
    const raw = ds0.data[i], y = yOf(raw);
    const parsed = { x: raw && !Array.isArray(raw) && typeof raw === 'object' && 'x' in raw ? raw.x : i, y };
    if (Array.isArray(raw)) parsed._custom = { barStart: raw[0], barEnd: raw[1], start: raw[0], end: raw[1], min: Math.min(...raw), max: Math.max(...raw) };
    return { chart, dataset: ds0, datasetIndex: 0, dataIndex: i, label: labels ? String(labels[i]) : '', raw, parsed, formattedValue: String(y) };
  };
  const listCbs = new Set(['beforeTitle', 'title', 'afterTitle', 'beforeBody', 'afterBody', 'beforeFooter', 'footer', 'afterFooter']);
  for (const [name, f] of Object.entries(tcb)) for (const i of idxs) run(`tooltip.callbacks.${name}`, f, { chart }, listCbs.has(name) ? [item(i)] : item(i));
}

async function renderPage({ search = '', width = 1200, payloadText, fetchStatus = 200 }) {
  const doc = parseHtml(html);
  doc.activeElement = doc.body;
  const errs = [], problems = [], timers = new Map();
  let tid = 0;
  const location = { pathname: '/paxos', search, hash: '', origin: 'https://rodiger.io', protocol: 'https:', host: 'rodiger.io', hostname: 'rodiger.io', get href() { return this.origin + this.pathname + this.search + this.hash; } };
  const store = new Map();
  const win = {
    document: doc, location, Node: ShimNode, Element: ShimElement, Text: ShimText, HTMLElement: ShimElement,
    console: { log() {}, info() {}, debug() {}, warn() {}, error: (...a) => errs.push(a.map((x) => (x && x.stack ? String(x.stack).split('\n').slice(0, 3).join(' | ') : String(x))).join(' ')) },
    history: { replaceState(_s, _t, url) { const u = new URL(url, location.href); location.pathname = u.pathname; location.search = u.search; location.hash = u.hash; }, pushState(...a) { this.replaceState(...a); } },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, val) => store.set(k, String(val)), removeItem: (k) => store.delete(k), clear: () => store.clear() },
    navigator: { onLine: true, userAgent: 'paxos-dom-shim', language: 'en-US' },
    innerWidth: width, innerHeight: 900, devicePixelRatio: 1,
    getComputedStyle: () => ({ getPropertyValue: (k) => cssVars[k] || '', fontFamily: 'system-ui, sans-serif' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    setTimeout: (f, ms = 0, ...a) => { timers.set(++tid, { f, ms, a }); return tid; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => ++tid, clearInterval: () => {},
    requestAnimationFrame: (f) => { timers.set(++tid, { f, ms: 0, a: [0] }); return tid; }, cancelAnimationFrame: (id) => timers.delete(id),
    queueMicrotask, structuredClone, URL, URLSearchParams, AbortController, AbortSignal, TextEncoder, TextDecoder, performance,
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }, removeEventListener() {}, dispatchEvent() { return true; },
    scrollTo() {}, scrollBy() {},
  };
  win.window = win; win.self = win; win.top = win; win.parent = win;
  win.Chart = makeChart(problems);
  vm.createContext(win);
  win.fetch = async () => ({ ok: fetchStatus === 200, status: fetchStatus, headers: { get: () => 'application/json' }, json: async () => vm.runInContext('JSON', win).parse(payloadText), text: async () => payloadText });
  shimWindow = win;
  // Short timers (deferred rendering, focus restoration) run; long ones (request timeouts, scheduled
  // refetches) never fire, so every scenario is deterministic.
  const flushTimers = () => { for (let round = 0; round < 20; round++) { const due = [...timers].filter(([, x]) => x.ms <= 1000); if (!due.length) return; for (const [id, x] of due) { timers.delete(id); x.f(...x.a); } } };
  vm.runInContext(app, win, { filename: 'app.js' });
  const P = win.PaxosDashboard;
  await P.load();
  flushTimers();
  const settle = () => { flushTimers(); if (typeof P.flushCharts === 'function') P.flushCharts(); flushTimers(); };
  settle();
  return { doc, win, P, errs, problems, settle, click: (el) => { dispatchShimEvent(el, shimEvent('click')); settle(); } };
}
const SECTION_IDS = [...html.matchAll(/<section\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
const BAD_TEXT = /\bNaN\b|\bundefined\b|\[object Object\]|\bInfinity\b/;
function pageProblems(pg, label) {
  const out = [...pg.errs.map((e) => `console.error: ${e}`), ...pg.problems];
  for (const id of SECTION_IDS) {
    const sec = pg.doc.getElementById(id), b = sec && sec.querySelector('[data-body]');
    if (!sec || sec.hidden) out.push(`#${id} is hidden`);
    else if (!b || !b.childNodes.length) out.push(`#${id} rendered nothing`);
  }
  for (const e of pg.doc.querySelectorAll('.sec-error')) out.push(`${(e.closest('section') || { id: '?' }).id}: ${e.textContent}`);
  const text = pg.doc.body.textContent;
  if (BAD_TEXT.test(text)) out.push(`page text contains ${BAD_TEXT.exec(text)[0]}: ...${text.slice(Math.max(0, BAD_TEXT.exec(text).index - 80), BAD_TEXT.exec(text).index + 20)}...`);
  for (const e of pg.doc.querySelectorAll('[title], [aria-label]')) for (const k of ['title', 'aria-label']) { const val = e.getAttribute(k); if (val && BAD_TEXT.test(val)) out.push(`${k}="${val.slice(0, 120)}"`); }
  pg.errs.length = 0;
  pg.problems.length = 0;
  return out.length ? `${label}:\n  ${out.slice(0, 12).join('\n  ')}` : null;
}
// The page judges freshness against the real clock, so each scenario restamps generatedAt.
const pagePayload = (ageSec) => JSON.stringify({ ...payload, generatedAt: new Date(Date.now() - ageSec * 1000).toISOString() });
{
  const pg = await renderPage({ payloadText: pagePayload(60) });
  ok(pg.P && typeof pg.P.load === 'function' && typeof pg.P.flushCharts === 'function', 'app.js boots in the DOM shim and exposes load/flushCharts');
  const fails = [];
  const note = (label) => { const f = pageProblems(pg, label); if (f) fails.push(f); };
  note('initial render (All Paxos, default range)');
  ok(pg.win.Chart.instances.length >= 5, `charts were created (${pg.win.Chart.instances.length})`);
  const legacy = pg.doc.getElementById('f-legacy');
  if (legacy) { pg.click(legacy); note('legacy shown'); }
  const assetsShown = pg.doc.getElementById('f-asset').querySelectorAll('[data-asset]').map((b) => b.getAttribute('data-asset'));
  ok(assetsShown.includes('all') && keys.every((k) => assetsShown.includes(k)), `filters offer All Paxos and every discovered asset with legacy shown (${assetsShown})`);
  for (const a of assetsShown) {
    const ab = pg.doc.getElementById('f-asset').querySelectorAll('[data-asset]').find((b) => b.getAttribute('data-asset') === a);
    pg.click(ab);
    for (const r of pg.doc.getElementById('f-range').querySelectorAll('[data-range]').map((b) => b.getAttribute('data-range'))) {
      pg.click(pg.doc.getElementById('f-range').querySelectorAll('[data-range]').find((b) => b.getAttribute('data-range') === r));
      ok(pg.win.location.search.includes(`asset=${encodeURIComponent(a)}`) && pg.win.location.search.includes(`range=${r}`), `URL reflects ${a} ${r} (${pg.win.location.search})`);
      note(`asset=${a} range=${r}`);
    }
  }
  ok(!fails.length, `the page renders the fixture payload without errors:\n${fails.slice(0, 6).join('\n')}`);
}
{
  const pg = await renderPage({ payloadText: pagePayload(60), width: 375, search: '?asset=all&range=all' });
  const f = pageProblems(pg, 'narrow (375 px), range all');
  ok(!f, f || 'narrow render');
}
// Decision 6: a snapshot older than its CDN freshness budget is never labelled current.
{
  const pg = await renderPage({ payloadText: pagePayload(payload.cache.sMaxAge + 600) });
  const status = pg.doc.getElementById('status').textContent;
  ok(!/current snapshot/i.test(status), `a ${Math.round((payload.cache.sMaxAge + 600) / 60)}-minute-old snapshot is not called current: "${status.slice(0, 160)}"`);
  const f = pageProblems(pg, 'stale snapshot');
  ok(!f, f || 'stale render');
}
// The data service failing shows an error with a retry instead of throwing.
{
  const pg = await renderPage({ payloadText: '{}', fetchStatus: 503 });
  const alert = pg.doc.querySelector('[role="alert"]');
  ok(alert && pg.doc.querySelector('[data-action="reload"]') && pg.errs.every((e) => /load failed/.test(e)) && !pg.doc.querySelectorAll('.sec-error').length, 'a failed load shows an error with retry and renders no section');
}

const totalMs = performance.now() - T0;
const BUDGET_MS = 60e3; // about 15 s on a laptop core; a warning only, unless PAXOS_PERF_STRICT=1
if (totalMs > BUDGET_MS) {
  const msg = `check took ${Math.round(totalMs)} ms (budget ${BUDGET_MS / 1000} s): a slow machine, or a performance regression worth a look`;
  if (process.env.PAXOS_PERF_STRICT === '1') assert.fail(msg);
  console.warn('warning: ' + msg);
}
console.log(`check-paxos-dashboard: ${checks} checks passed in ${Math.round(totalMs)} ms (fixture ${new Date(NOW * 1000).toISOString()}; build ${Math.round(buildMs)} ms; payload ${Math.round(raw / 1024)} KB raw / ${Math.round(gz / 1024)} KB gzip; ${ins.testsRun} tests, ${ins.feed.length} feed clusters)`);
