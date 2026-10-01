#!/usr/bin/env node
// Records the live upstream responses of one Paxos data-layer run into
// scripts/fixtures/paxos/upstream.json.gz = { now, recordedAt, responses: { [url]: { status, headers, body } } }
// for the offline checks. Bodies are trimmed only in ways the code discards
// anyway (sources.slim transforms, non-stablecoin non-Paxos yields pools, unused
// fields). The run uses a long budget so keyless CoinGecko's spaced queue
// drains; it refuses to write a fixture with failed CoinGecko or DefiLlama
// requests. Degraded passes (CoinGecko down, CoinGecko coin details down,
// docs and CoinGecko down) record the extra requests of those paths;
// already-recorded URLs are replayed, so every pass sees the same data.
// Finally the new fixture is written to a temporary file and replayed; it
// replaces the destination only when the replay reproduces the live model
// (otherwise the destination is left untouched and the script exits 1).
// Usage: node scripts/record-paxos-fixtures.mjs [--out path]
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { createFixtureFetch, requestKey, DEFAULT_FIXTURE } from './fixtures/paxos/fixture-fetch.mjs';

const require = createRequire(import.meta.url);
const { collectRaw, slim } = require('../lib/paxos/sources.js');
const { buildModel } = require('../lib/paxos/model.js');
const { createCache } = require('../lib/paxos/cache.js');
const R = require('../lib/paxos/registry.js');

const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : DEFAULT_FIXTURE;
const responses = {};
const realFetch = globalThis.fetch;
const KEEP_HEADERS = ['content-type', 'last-modified', 'expires', 'date', 'retry-after'];

// Keyless CoinGecko throttles per IP after a handful of quick calls; the
// recorder serialises its calls with a wide gap so the fixture is complete.
let cgChain = Promise.resolve();
const CG_GAP_MS = process.env.COINGECKO_DEMO_API_KEY ? 700 : 15000;
const cgTurn = () => {
  const turn = cgChain.then(() => new Promise((r) => setTimeout(r, CG_GAP_MS)));
  cgChain = turn;
  return turn;
};

// A 429 from keyless CoinGecko (an IP shared with other clients) is waited out here, inside the
// request's own timeout, so the recording is not degraded by someone else's burst.
const CG_RETRY_WAIT_MS = [30000, 40000];
async function recordingFetch(url, init = {}) {
  const cg = new URL(url).host === 'api.coingecko.com';
  if (cg) await cgTurn();
  let res = await realFetch(url, init);
  for (let i = 0; cg && res.status === 429 && i < CG_RETRY_WAIT_MS.length; i++) {
    const ra = Number(res.headers.get('retry-after'));
    await res.text();
    await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 50000) : CG_RETRY_WAIT_MS[i]));
    res = await realFetch(url, init);
  }
  const body = await res.text();
  const headers = {};
  for (const k of KEEP_HEADERS) if (res.headers.get(k)) headers[k] = res.headers.get(k);
  responses[requestKey(url, init)] = { status: res.status, headers, body };
  return new Response(body, { status: res.status, headers });
}

const now = Math.floor(Date.now() / 1000);
const t0 = Date.now();
const raw = await collectRaw({ fetch: recordingFetch, now, cache: createCache(), budgetMs: 900000, timeoutMs: 120000, onchainBudgetMs: 20000 });
console.log(`recorded ${Object.keys(responses).length} responses in ${Date.now() - t0} ms`);
const bad = raw.sources.filter((s) => ['coingecko', 'llama-stablecoins', 'llama-market', 'llama-coins', 'llama-yields', 'llama-fees', 'paxos-docs', 'llama-protocol', 'coinmetrics'].includes(s.id) && s.failed);
if (bad.length || raw.errors.length) {
  console.error('refusing to write a degraded fixture:', JSON.stringify({ errors: raw.errors, failed: bad.map((s) => [s.id, s.message]) }, null, 1));
  process.exit(1);
}

// ---- degraded passes: recorded URLs replay, new ones are fetched live and recorded ----
// 'cg-down': every CoinGecko call 429s. 'cg-details-down': category rows arrive
// but coin details do not (a cold keyless run), so contracts must be joined to
// CoinGecko ids through coins.llama.fi. 'docs+cg-down': both active tiers fail.
const PASSES = {
  'cg-down': (u) => new URL(u).host === 'api.coingecko.com',
  'docs+cg-down': (u) => ['api.coingecko.com', 'docs.paxos.com'].includes(new URL(u).host),
  'cg-details-down': (u) => /^https:\/\/api\.coingecko\.com\/api\/v3\/(coins\/(?!markets\?)[a-z0-9-]+\?|asset_platforms)/.test(u),
};
const degradedRuns = [];
for (const [name, blocked] of Object.entries(PASSES)) {
  const passFetch = async (url, init = {}) => {
    if (blocked(String(url))) return new Response('{"status":{"error_code":429}}', { status: 429, headers: { 'content-type': 'application/json' } });
    const rec = responses[requestKey(url, init)];
    if (rec) return new Response(rec.body, { status: rec.status, headers: rec.headers });
    if (new URL(url).host === 'api.coingecko.com') return new Response('not recorded', { status: 404 }); // never spend CoinGecko quota on a degraded pass
    return recordingFetch(url, init);
  };
  const before = Object.keys(responses).length;
  const r = await collectRaw({ fetch: passFetch, now, cache: createCache(), budgetMs: 120000, timeoutMs: 30000, onchainBudgetMs: 20000 });
  degradedRuns.push(r);
  console.log(`${name} pass added ${Object.keys(responses).length - before} responses; errors ${JSON.stringify(r.errors)}; assets ${r.registry.assets.map((a) => a.key).join(',')}`);
}

// ---- trimming (only what the code would discard) ----
const finalAddrs = new Set([raw, ...degradedRuns].flatMap((r) => r.registry.assets).flatMap((a) => a.addresses.map((x) => R.normAddr(x.address))));
const holds = (toks) => (toks || []).some((t) => typeof t === 'string' && finalAddrs.has(R.normAddr(t)));
const keptPools = new Set();
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const trims = [
  [/^https:\/\/stablecoins\.llama\.fi\/stablecoins$/, slim.list],
  [/^https:\/\/stablecoins\.llama\.fi\/stablecoincharts\/[^?]+$/, slim.totals],
  [/^https:\/\/stablecoins\.llama\.fi\/stablecoincharts\/all\?stablecoin=\d+$/, slim.charts],
  [/^https:\/\/stablecoins\.llama\.fi\/stablecoin\/\d+$/, slim.detail],
  [/^https:\/\/api\.llama\.fi\/summary\/fees\//, slim.fees],
  [/^https:\/\/api\.llama\.fi\/protocol\//, slim.protocol],
  [/^https:\/\/api\.llama\.fi\/v2\/chains$/, slim.llamaChains],
  [/^https:\/\/api\.coingecko\.com\/api\/v3\/coins\/(?!markets\?)[a-z0-9-]+\?/, slim.cgDetail],
  [/^https:\/\/api\.coingecko\.com\/api\/v3\/coins\/[a-z0-9-]+\/market_chart/, slim.cgChart],
  [/^https:\/\/api\.coingecko\.com\/api\/v3\/asset_platforms$/, slim.platforms],
  [/^https:\/\/api\.coingecko\.com\/api\/v3\/coins\/markets\?/, slim.cgMarkets],
  [/^https:\/\/chains\.blockscout\.com\//, slim.chainscout],
  [/^https:\/\/community-api\.coinmetrics\.io\/v4\/catalog/, (j) => ({ data: j.data.map((x) => ({ asset: x.asset })) })],
  [
    /^https:\/\/yields\.llama\.fi\/pools$/,
    (j) => {
      const data = slim.poolRows(j.data).filter((p) => p.stablecoin === true || holds(p.underlyingTokens));
      for (const p of data) keptPools.add(p.pool);
      return { status: j.status, data };
    },
  ],
  [/^https:\/\/yields\.llama\.fi\/chart\//, (j) => ({ status: j.status, data: slim.poolChart(j) })],
  [/^https:\/\/lite-api\.jup\.ag\//, (j) => j.map((t) => pick(t, ['id', 'symbol', 'holderCount', 'totalSupply', 'decimals', 'updatedAt']))],
  [/\/api\/v2\/tokens\/0x[0-9a-fA-F]{40}$/, (j) => pick(j, ['decimals', 'total_supply', 'holders_count', 'holders', 'symbol'])],
];
// pools first: lendBorrow keeps rows of kept pools
const keys = Object.keys(responses).sort((a, b) => /\/pools$/.test(b) - /\/pools$/.test(a));
for (const key of keys) {
  const rec = responses[key];
  if (/^https:\/\/docs\.paxos\.com\/llms\.txt$/.test(key)) rec.body = rec.body.split('\n').filter((l) => l.includes('/guides/stablecoin/')).join('\n');
  if (rec.status < 200 || rec.status > 299) continue;
  const trim = /^https:\/\/yields\.llama\.fi\/lendBorrow$/.test(key) ? (j) => slim.lendRows(j).filter((r) => keptPools.has(r.pool) || holds(r.underlyingTokens)) : (trims.find(([re]) => re.test(key)) || [])[1];
  if (!trim) continue;
  rec.body = JSON.stringify(trim(JSON.parse(rec.body)));
}

const fixture = { now, recordedAt: new Date(now * 1000).toISOString(), responses };
const json = JSON.stringify(fixture);
const gz = zlib.gzipSync(json, { level: 9 });
// Written next to the destination first; it replaces the destination only after the replay check.
const tmp = `${out}.tmp-${process.pid}`;
fs.writeFileSync(tmp, gz);
console.log(`recorded ${tmp}: ${(json.length / 1e6).toFixed(2)} MB raw, ${(gz.length / 1e6).toFixed(2)} MB gzip`);
const bySize = Object.entries(responses).map(([k, r]) => [k, r.body.length]).sort((a, b) => b[1] - a[1]).slice(0, 8);
for (const [k, n] of bySize) console.log(`  ${String(Math.round(n / 1024)).padStart(6)} KB  ${k.slice(0, 110)}`);

// ---- replay: the fixture must reproduce the live model before it may replace the destination ----
const strip = (m) => {
  const { sources, util, ...rest } = m;
  return JSON.stringify(rest);
};
const live = buildModel(raw, { now });
const fx = createFixtureFetch(tmp);
const replayRaw = await collectRaw({ fetch: fx, now: fx.now, cache: createCache() });
const replay = buildModel(replayRaw, { now: fx.now });
const same = strip(live) === strip(replay) && replayRaw.errors.length === 0;
console.log(`replay ${same ? 'reproduces' : 'DIFFERS FROM'} the live model (${live.assets.length} assets, sources ${replay.sources.map((s) => s.id + ':' + s.status).join(' ')})`);
if (!same) {
  if (replayRaw.errors.length) console.error('  replay errors:', JSON.stringify(replayRaw.errors));
  for (const k of Object.keys(live)) if (k !== 'util' && k !== 'sources' && JSON.stringify(live[k]) !== JSON.stringify(replay[k])) console.error('  differs:', k);
  for (let i = 0; i < live.assets.length; i++) {
    for (const k of Object.keys(live.assets[i])) if (JSON.stringify(live.assets[i][k]) !== JSON.stringify((replay.assets[i] || {})[k])) console.error(`  asset ${live.assets[i].key}.${k} differs`);
  }
  fs.unlinkSync(tmp);
  console.error(`not written: ${out} is unchanged`);
  process.exit(1);
}
fs.renameSync(tmp, out);
console.log(`wrote ${out}`);
