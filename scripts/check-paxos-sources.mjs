#!/usr/bin/env node
// Offline, deterministic checks of the Paxos data layer (lib/paxos/{http,cache,registry,sources,model}.js):
//   1. discovery from the recorded fixture (properties of the data, no hard-coded ids)
//   2. model invariants (daily series, NaN, chain-name normalisation, dead assets, source records)
//   3. http robustness with stub fetches (timeout, HTML, empty body, 429, bad JSON, throwing fetch, queue deadline)
//   4. client behaviour (429 cooldown, stale-on-error cache fallback)
//   5. degraded discovery with every CoinGecko response removed
//   6. review regressions (snapshot times, same-instant prices, consensus price, malformed and
//      mis-dated upstream data, Coin Metrics coverage and history, materiality rule, docs/fee
//      parser self-checks, contract roles, redirects, recorder)
// Usage: node scripts/check-paxos-sources.mjs [--fixture path]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createFixtureFetch, loadFixture, DEFAULT_FIXTURE } from './fixtures/paxos/fixture-fetch.mjs';

const require = createRequire(import.meta.url);
const { fetchJson, fetchText } = require('../lib/paxos/http.js');
const { createCache } = require('../lib/paxos/cache.js');
const { collectRaw, createClient, SOURCES } = require('../lib/paxos/sources.js');
const M = require('../lib/paxos/model.js');
const { buildModel } = M;
const R = require('../lib/paxos/registry.js');
const D = require('../lib/paxos/detectors.js');
const S = require('../lib/paxos/stats.js');

const T0 = Date.now();
const file = process.argv.includes('--fixture') ? process.argv[process.argv.indexOf('--fixture') + 1] : DEFAULT_FIXTURE;
const fixture = loadFixture(file);
let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}\n  ${e.message.split('\n').slice(0, 6).join('\n  ')}`);
    process.exitCode = 1;
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}\n  ${e.message.split('\n').slice(0, 6).join('\n  ')}`);
    process.exitCode = 1;
  }
};

async function run(override, cache = createCache()) {
  const fetch = createFixtureFetch(fixture, { override });
  const raw = await collectRaw({ fetch, now: fetch.now, cache, budgetMs: 20000 });
  return { raw, model: buildModel(raw, { now: fetch.now }), cache };
}

const full = await run();
const { raw, model } = full;
const namer = R.makeChainNamer({ listChains: model.list.chains, llamaChains: raw.llamaChains, cgPlatforms: raw.cgPlatforms });
const listById = new Map(model.list.peggedAssets.map((x) => [String(x.id), x]));
const tierIds = new Set(R.TIERS.map((t) => t.id));
const activeTiers = new Set(R.TIERS.filter((t) => t.active).map((t) => t.id));

// ---------- 1. discovery ----------
check('collectRaw reports no internal errors', () => assert.deepEqual(raw.errors, []));
check('every discovery tier answered and found something', () => {
  for (const t of model.discovery.tiers) assert.ok(t.ok && t.found.length, `${t.id} ok=${t.ok} found=${t.found}`);
});
check('every asset was found by at least one tier, and only by known tiers', () => {
  assert.ok(model.assets.length > 0);
  for (const a of model.assets) {
    assert.ok(a.via.length > 0, a.key);
    for (const v of a.via) assert.ok(tierIds.has(v), `${a.key} via ${v}`);
  }
});
check('every active asset is confirmed by two independent tiers and has a contract address', () => {
  const act = model.assets.filter((a) => a.status === 'active');
  assert.ok(act.length > 0);
  for (const a of act) {
    assert.ok(a.via.length >= 2, `${a.key} via ${a.via}`);
    assert.ok(a.addresses.length >= 1, `${a.key} has no address`);
  }
});
check('status follows the rule (dead = deadFrom, active = an active-issuance tier, else legacy)', () => {
  for (const a of model.assets) {
    const want = a.list && a.list.deadFrom ? 'dead' : a.via.some((v) => activeTiers.has(v)) ? 'active' : 'legacy';
    assert.equal(a.status, want, a.key);
    assert.equal(a.status === 'dead', a.dead !== null, `${a.key} dead flag`);
  }
});
check('no symbol-only joins: every DefiLlama join is by gecko id, exact name or contract address', () => {
  const joins = new Map(model.discovery.joins.map((j) => [j.key, j]));
  for (const a of model.assets.filter((x) => x.llamaId)) {
    const j = joins.get(a.key);
    assert.ok(['gecko_id', 'name', 'address'].includes(j.llama), `${a.key} joined by ${j.llama}`);
    const e = listById.get(a.llamaId);
    if (j.llama === 'gecko_id') assert.equal(e.gecko_id, a.geckoId, a.key);
    if (j.llama === 'name') assert.ok(e.name.toLowerCase() === String(a.name).toLowerCase() || R.feeLabelNames(raw.fees).some((n) => n.toLowerCase() === e.name.toLowerCase()), a.key);
  }
});
check('ticker twins in the list stay out (distinct ids, no shared contract with a different entry)', () => {
  const ids = model.assets.map((a) => a.llamaId).filter(Boolean);
  const gecko = model.assets.map((a) => a.geckoId).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(gecko).size, gecko.length);
  const symbols = new Set(model.assets.map((a) => R.chainKey(a.symbol)));
  const twins = model.list.peggedAssets.filter((x) => symbols.has(R.chainKey(x.symbol)) && !ids.includes(String(x.id)));
  assert.ok(twins.length > 0, 'fixture should contain ticker twins to make this test meaningful');
  for (const t of twins) for (const a of model.assets) assert.notEqual(a.llamaId, String(t.id), `${a.key} absorbed twin ${t.name}`);
});
check('kinds and references are derived (gold assets get XAU and gold references, USD assets get peg peers)', () => {
  assert.ok(model.assets.every((a) => ['usd-stablecoin', 'gold', 'fiat-stablecoin', 'other'].includes(a.kind)));
  const gold = model.assets.filter((a) => a.kind === 'gold' && a.status === 'active');
  for (const g of gold) assert.ok(g.xauDaily && g.supply, `${g.key} lacks xau or supply`);
  if (gold.length) assert.ok(model.goldRefs.length > 0 && model.goldRefs.every((r) => !model.assets.some((a) => a.geckoId === r.geckoId)), 'gold refs');
  assert.ok(model.pegPeers.length > 0 && model.pegPeers.every((p) => !model.assets.some((a) => a.llamaId === p.llamaId)), 'peg peers exclude Paxos assets');
  assert.ok(Math.abs(model.pegPeers.reduce((s, p) => s + p.share, 0)) >= 0.5 - 1e-9 || model.pegPeers.length === 1, 'peers cover half the segment');
  // #63: the peg reference is a per-day median over the peers; three is the smallest set whose median
  // ignores one bad print, so the half-coverage set is extended by size to at least three.
  assert.ok(model.pegPeers.length >= 3, `at least three peg peers (${model.pegPeers.map((p) => p.symbol).join(', ')})`);
  assert.ok(model.pegPeers.every((p, i) => i === 0 || p.share <= model.pegPeers[i - 1].share), 'peg peers are taken by size');
});
check('Coin Metrics mappings are validated by supply, not by ticker', () => {
  for (const a of model.assets.filter((x) => x.cm)) {
    const m = raw.cm.map[R.assetId(a)];
    assert.ok(m && m.id === a.cm.key && m.d <= m.tau, `${a.key} ${JSON.stringify(m)}`);
    assert.ok(a.cm.rows.length > 0 && a.cm.rows.every((r, i, xs) => !i || xs[i - 1].time < r.time), `${a.key} cm rows sorted`);
  }
});

// ---------- 2. model invariants ----------
const isSeries = (o) => o && Array.isArray(o.t) && Array.isArray(o.v) && Object.keys(o).every((k) => ['t', 'v', 'notes', 'first', 'minted'].includes(k));
function walk(o, path, fn) {
  if (o === null || typeof o !== 'object') return fn(o, path);
  if (path.endsWith('.list') || path.endsWith('.cg')) return; // raw upstream objects
  fn(o, path);
  for (const [k, v] of Object.entries(o)) walk(v, path + '.' + k, fn);
}
check('model is JSON-serialisable and has no non-finite numbers', () => {
  const rest = model;
  assert.ok(!('util' in model), 'no helper bag on the model (pure helpers are exported by model.js)');
  walk(rest, 'model', (v, p) => {
    assert.notEqual(typeof v, 'function', p);
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${p} = ${v}`);
  });
  JSON.stringify(rest);
});
check('every Series has ascending unique UTC-midnight days and parallel values', () => {
  let n = 0;
  walk(model, 'model', (o, p) => {
    if (!isSeries(o)) return;
    n++;
    assert.equal(o.t.length, o.v.length, p);
    for (let i = 0; i < o.t.length; i++) {
      assert.ok(o.t[i] % 86400 === 0, `${p} t[${i}] not midnight`);
      if (i) assert.ok(o.t[i] > o.t[i - 1], `${p} not ascending at ${i}`);
    }
  });
  assert.ok(n > 20, `only ${n} series found`);
});
check('hourly arrays ascend and implied daily prices never equal exactly 1.0', () => {
  for (const h of [...model.assets.map((a) => a.hourly), ...model.pegPeers.map((p) => p.hourly), ...model.goldRefs.map((g) => g.hourly)].filter(Boolean)) {
    for (let i = 1; i < h.length; i++) assert.ok(h[i].t > h[i - 1].t && Number.isFinite(h[i].p));
  }
  for (const a of model.assets) if (a.priceDaily) assert.ok(a.priceDaily.v.every((v) => v !== 1), a.key);
});
check('coins.llama.fi hourly charts ask for every print in the hour (searchWidth = half the period)', () => {
  // With the default search width (10% of the period) a print more than 6 min off the hour is dropped,
  // so a live hourly feed whose prints drift away from the hour looked stopped for days (integration
  // finding: "USDP/BUSD hourly price is 13 days overdue" was this artefact).
  const hourlyUrls = Object.keys(fixture.responses).filter((u) => /^https:\/\/coins\.llama\.fi\/chart\//.test(u) && /[?&]period=1h\b/.test(u));
  assert.ok(hourlyUrls.length > 0, 'fixture should hold coins.llama.fi hourly charts');
  for (const u of hourlyUrls) assert.equal(new URL(u).searchParams.get('searchWidth'), String(3600 / 2), u);
  // ...and on the recording every live hourly series is current: its last print is within two periods
  // of the recording time and its prints are about one period apart.
  for (const [k, h] of [...model.assets.map((a) => [a.key, a.hourly]), ...model.pegPeers.map((p) => [p.symbol, p.hourly])].filter(([, h]) => h && h.length > 2)) {
    const gaps = h.slice(1).map((q, i) => q.t - h[i].t).sort((x, y) => x - y);
    assert.ok(model.now - h.at(-1).t <= 2 * 3600, `${k}: hourly series ends ${new Date(h.at(-1).t * 1000).toISOString()} (recorded ${new Date(model.now * 1000).toISOString()})`);
    assert.ok(Math.abs(gaps[gaps.length >> 1] - 3600) <= 600, `${k}: median gap between hourly prints ${gaps[gaps.length >> 1]} s`);
  }
});
check('chain names are normalised onto one spelling across sources', () => {
  const names = [
    ...model.assets.flatMap((a) => [...Object.keys(a.chains), ...a.addresses.map((x) => x.chain), ...a.onchain.map((o) => o.chain)]),
    ...Object.keys(model.chainTotals),
    ...(model.pools || []).map((p) => p.chain),
  ];
  for (const n of new Set(names)) assert.equal(namer.name(n), n, `${n} is not the canonical spelling`);
  const yields = new Set((raw.pools || []).map((p) => p.chain));
  const relabelled = [...yields].filter((c) => namer.name(c) !== c);
  assert.ok(relabelled.length > 0, 'expected yields chain spellings that differ from DefiLlama display names');
});
check('market totals and USD market are aligned daily series; dead assets keep their history', () => {
  assert.ok(model.market.t.length > 365 && model.marketUsd.t.length > 365);
  assert.ok(model.marketUsd.v.at(-1) <= model.market.v.at(-1));
  for (const a of model.assets.filter((x) => x.status === 'dead' && x.llamaId)) assert.ok(a.supply && a.supply.t.length, a.key);
});
check('per-asset series exist where the sources have them', () => {
  for (const a of model.assets.filter((x) => x.status === 'active')) {
    assert.ok(a.supply && a.supplyUsd, `${a.key} supply`);
    assert.ok(a.hourly && a.hourly.length > 0, `${a.key} hourly`);
    if (a.llamaId) assert.ok(Object.keys(a.chains).length > 0, `${a.key} chains`);
    if (a.geckoId) assert.ok(a.cgDaily && a.cgDaily.vol.t.length > 0, `${a.key} cgDaily`);
  }
  const material = Object.values(model.chainTotals).filter((c) => c.hist);
  assert.ok(material.length > 0, 'chain total histories');
  assert.ok(model.pools.length > 0 && model.lendBorrow.length > 0 && Object.keys(model.poolCharts).length > 0, 'defi');
  assert.ok(model.fees && model.fees.labels.length > 0 && model.fees.series.t.at(-1) < (model.now - (model.now % 86400)), 'fees end before today');
});
check('source records match the payload shape', () => {
  const kinds = new Set(['discovery', 'supply', 'price', 'defi', 'usage', 'economics', 'onchain', 'market']);
  const statuses = new Set(['ok', 'partial', 'stale', 'error', 'skipped']);
  assert.deepEqual(model.sources.map((s) => s.id), SOURCES.map((s) => s.id));
  for (const s of model.sources) {
    assert.deepEqual(Object.keys(s).sort(), ['ageHours', 'bytes', 'cadenceHours', 'dataAsOf', 'failed', 'fetchedAt', 'host', 'id', 'kind', 'label', 'latencyMs', 'message', 'requests', 'staleAfterHours', 'status'].sort(), s.id);
    // #22: the page re-judges a cached snapshot's source ages with the data layer's own stale rule.
    assert.equal(s.staleAfterHours, 2 * s.cadenceHours, `${s.id}: staleAfterHours is two publication intervals`);
    if (s.status === 'ok') assert.ok(s.ageHours === null || s.ageHours <= s.staleAfterHours, `${s.id}: ok source within staleAfterHours`);
    assert.ok(kinds.has(s.kind) && statuses.has(s.status), `${s.id} ${s.kind} ${s.status}`);
    assert.ok(s.status !== 'error' && !/not recorded/.test(s.message || ''), `${s.id} on the fixture: ${s.status} ${s.message}`);
  }
});

// ---------- 3. http robustness ----------
const stub = (fn) => {
  const f = async (url, init) => fn(url, init);
  f.noThrottle = true;
  return f;
};
const U = 'https://stub.invalid/x';
await checkAsync('timeout: a fetch that never settles (and ignores abort) returns a timeout error', async () => {
  const t = Date.now();
  const r = await fetchJson({ url: U, fetch: stub(() => new Promise(() => {})), timeoutMs: 60 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timeout/);
  assert.ok(Date.now() - t < 1000);
});
await checkAsync('HTML bodies are errors (404 page and 200 bot wall)', async () => {
  const html = '<!DOCTYPE html><html><body>Not Found</body></html>';
  const a = await fetchJson({ url: U, fetch: stub(() => new Response(html, { status: 404, headers: { 'content-type': 'text/html' } })) });
  assert.equal(a.ok, false);
  assert.equal(a.status, 404);
  assert.equal(a.error, 'HTTP 404');
  const b = await fetchJson({ url: U, fetch: stub(() => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) });
  assert.equal(b.error, 'html body');
  const c = await fetchText({ url: U, fetch: stub(() => new Response('<html><title>Just a moment...</title></html>', { status: 200 })) });
  assert.equal(c.error, 'html body');
});
await checkAsync('empty 200 bodies, invalid JSON, 429 and throwing fetches are errors, never exceptions', async () => {
  const e = await fetchJson({ url: U, fetch: stub(() => new Response('', { status: 200 })) });
  assert.equal(e.error, 'empty body');
  const j = await fetchJson({ url: U, fetch: stub(() => new Response('{"a":', { status: 200, headers: { 'content-type': 'application/json' } })) });
  assert.equal(j.error, 'invalid json');
  const r = await fetchJson({ url: U, fetch: stub(() => new Response('{"status":{"error_code":429}}', { status: 429, headers: { 'retry-after': '30' } })) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(r.retryAfterMs, 30000);
  const t = await fetchJson({ url: U, fetch: stub(() => { throw new Error('ECONNRESET'); }) });
  assert.match(t.error, /^network: ECONNRESET/);
  const bad = await fetchJson({ url: 'http://insecure.invalid/', fetch: stub(() => new Response('{}')) });
  assert.equal(bad.error, 'invalid url');
  const ok = await fetchJson({ url: U, fetch: stub(() => new Response('{"a":1}', { status: 200, headers: { 'last-modified': 'Thu, 01 Oct 2026 13:22:59 GMT' } })) });
  assert.ok(ok.ok && ok.data.a === 1 && ok.lastModified === Date.parse('2026-10-01T13:22:59Z') && ok.bytes === 7);
  const md = await fetchText({ url: U, fetch: stub(() => new Response('# USDG on Main Networks\n| a | b |', { status: 200, headers: { 'content-type': 'text/markdown' } })) });
  assert.ok(md.ok && md.data.startsWith('# USDG'));
});
await checkAsync('a request still queued at the deadline is skipped, not sent', async () => {
  let calls = 0;
  const slow = stub(() => new Promise((r) => setTimeout(() => (calls++, r(new Response('{}', { status: 200 }))), 80)));
  const deadline = Date.now() + 40;
  const host = 'https://queue.invalid/';
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => fetchJson({ url: host + i, fetch: slow, deadline })));
  assert.ok(rs.every((r) => !r.ok));
  assert.ok(rs.filter((r) => /^skipped/.test(r.error)).length >= 2, 'queued requests should be skipped');
  assert.ok(calls <= 6);
});

// ---------- 4. client: cooldown and stale-on-error ----------
await checkAsync('after a 429 the client stops calling that host for the rest of the run', async () => {
  let calls = 0;
  const f = stub(() => (calls++, new Response('{}', { status: 429 })));
  const c = createClient({ fetch: f, cache: null, deadline: Date.now() + 5000 });
  const a = await c.get('coingecko', 'https://cool.invalid/a');
  const b = await c.get('coingecko', 'https://cool.invalid/b');
  assert.equal(calls, 1);
  assert.equal(a.ok, false);
  assert.match(b.error, /^skipped: rate limited/);
  const s = c.summary(Math.floor(Date.now() / 1000)).find((x) => x.id === 'coingecko');
  assert.equal(s.status, 'error');
  assert.equal(s.failed, 2);
});
await checkAsync('an expired cache entry is served as stale when the refresh fails', async () => {
  let clock = 0;
  const cache = createCache({ now: () => clock });
  let up = true;
  const f = stub(() => (up ? new Response('[1,2]', { status: 200 }) : new Response('', { status: 503 })));
  const c1 = createClient({ fetch: f, cache, deadline: Date.now() + 5000 });
  assert.deepEqual((await c1.get('llama-yields', 'https://stale.invalid/p', { ttlMs: 1000 })).data, [1, 2]);
  clock = 500;
  const hit = await createClient({ fetch: stub(() => { throw new Error('must not be called'); }), cache, deadline: Date.now() + 5000 }).get('llama-yields', 'https://stale.invalid/p', { ttlMs: 1000 });
  assert.deepEqual(hit.data, [1, 2]);
  clock = 5000;
  up = false;
  const c2 = createClient({ fetch: f, cache, deadline: Date.now() + 5000 });
  const r = await c2.get('llama-yields', 'https://stale.invalid/p', { ttlMs: 1000 });
  assert.ok(r.ok && r.stale && /HTTP 503/.test(r.error));
  assert.equal(c2.summary(Math.floor(Date.now() / 1000)).find((x) => x.id === 'llama-yields').status, 'stale');
  const lru = createCache({ maxEntries: 2 });
  for (const k of ['a', 'b', 'c']) lru.set(k, k, { ttlMs: 1000 });
  assert.equal(lru.size, 2);
  assert.equal(lru.peek('a'), null);
});

// ---------- 5. degraded discovery: CoinGecko down ----------
const cgDown = (url) => (new URL(url).host === 'api.coingecko.com' ? new Response('{"status":{"error_code":429}}', { status: 429, headers: { 'content-type': 'application/json' } }) : null);
const down = await run(cgDown);
check('without CoinGecko, discovery still finds every active asset and classifies it the same way', () => {
  const tier = down.model.discovery.tiers.find((t) => t.id === 'coingecko:category');
  assert.equal(tier.ok, false);
  const ident = (a) => a.llamaId || a.addresses.map((x) => R.chainKey(x.chain) + '|' + R.normAddr(x.address)).sort()[0];
  const want = model.assets.filter((a) => a.status === 'active');
  const got = down.model.assets.filter((a) => a.status === 'active');
  assert.equal(got.length, want.length, `active ${got.map((a) => a.key)} vs ${want.map((a) => a.key)}`);
  for (const w of want) {
    const g = got.find((x) => (w.llamaId && x.llamaId === w.llamaId) || x.addresses.some((ad) => w.addresses.some((wd) => R.normAddr(wd.address) === R.normAddr(ad.address) && R.chainKey(wd.chain) === R.chainKey(ad.chain))));
    assert.ok(g, `${w.key} (${ident(w)}) not found without CoinGecko`);
    assert.equal(g.kind, w.kind, `${w.key} kind`);
    assert.ok(g.addresses.length > 0 && g.via.includes('paxos-docs'), `${w.key} addresses/tier`);
  }
  assert.equal(down.model.sources.find((s) => s.id === 'coingecko').status, 'error');
  assert.deepEqual(down.raw.errors, []);
  for (const s of down.model.sources.filter((x) => x.id !== 'coingecko')) {
    assert.ok(s.status !== 'error' && !/not recorded/.test(s.message || ''), `${s.id}: ${s.status} ${s.message}`);
  }
});
check('without CoinGecko, gold supply falls back to a validated Coin Metrics series and prices to coins.llama.fi', () => {
  for (const a of down.model.assets.filter((x) => x.kind === 'gold' && x.status === 'active')) {
    assert.ok(a.hourly && a.hourly.length, `${a.key} hourly`);
    if (model.assets.some((m) => m.kind === 'gold' && m.cm)) assert.ok(a.cm && a.supply && a.supplySource.startsWith('coinmetrics'), `${a.key} supply ${a.supplySource}`);
  }
});

const detailsDown = await run((url) => (/^https:\/\/api\.coingecko\.com\/api\/v3\/(coins\/(?!markets\?)[a-z0-9-]+\?|asset_platforms)/.test(url) ? new Response('{}', { status: 429 }) : null));
check('without CoinGecko coin details, contracts are joined to CoinGecko rows via coins.llama.fi (no duplicates)', () => {
  const m = detailsDown.model;
  assert.equal(m.assets.length, model.assets.length, m.assets.map((a) => a.key).join(','));
  assert.deepEqual(m.assets.map((a) => a.key).sort(), model.assets.map((a) => a.key).sort());
  for (const a of m.assets.filter((x) => x.status === 'active')) assert.ok(a.addresses.length > 0 && (a.geckoId || !model.assets.find((b) => b.key === a.key).geckoId), `${a.key} lost its join`);
});
const blind = await run((url) => (['api.coingecko.com', 'docs.paxos.com'].includes(new URL(url).host) ? new Response('<html></html>', { status: 503, headers: { 'content-type': 'text/html' } }) : null));
check('with both active-issuance tiers down, found assets are not hidden as legacy and keep a contract', () => {
  const m = blind.model;
  assert.ok(m.discovery.tiers.filter((t) => ['coingecko:category', 'paxos-docs'].includes(t.id)).every((t) => !t.ok));
  assert.ok(m.assets.length > 0);
  for (const a of m.assets) {
    const full = model.assets.find((b) => (a.llamaId && b.llamaId === a.llamaId) || b.addresses.some((x) => a.addresses.some((y) => R.normAddr(x.address) === R.normAddr(y.address))));
    assert.ok(full, `${a.key} not in the full run`);
    if (full.status === 'active') assert.equal(a.status, 'active', `${a.key} hidden as ${a.status}`);
    if (a.status === 'active') assert.ok(a.addresses.length > 0, `${a.key} has no contract`);
  }
});

// ---------- 6. review regressions ----------
const DAY = 86400;
const URLS = Object.keys(fixture.responses);
const body = (u) => JSON.parse(fixture.responses[u].body);
const respond = (j, url) => new Response(JSON.stringify(j), { status: 200, headers: { ...((url && fixture.responses[url] && fixture.responses[url].headers) || {}), 'content-type': 'application/json' } });
const LIST_URL = URLS.find((u) => /^https:\/\/stablecoins\.llama\.fi\/stablecoins$/.test(u));
const chartUrl = (a) => URLS.find((u) => u === `https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=${a.llamaId}`);
const stripModel = (m) => { const { sources, ...rest } = m; return JSON.stringify(rest); };
const usdActive = model.assets.filter((a) => a.status === 'active' && a.kind === 'usd-stablecoin' && a.llamaId && chartUrl(a));
const gold = model.assets.filter((a) => a.kind === 'gold' && a.status === 'active');

check('#1 snapshot times: the hourly list carries its Last-Modified, daily series the instant of their last point', () => {
  assert.equal(model.listAsOf, Date.parse(fixture.responses[LIST_URL].headers['last-modified']) / 1000);
  const mkt = model.sources.find((x) => x.id === 'llama-market');
  const lastAll = Math.max(...body(URLS.find((u) => /stablecoincharts\/all$/.test(u))).map((r) => Number(r.date)));
  assert.equal(Date.parse(mkt.dataAsOf) / 1000, lastAll, 'market as-of = its last daily point, not the CDN Last-Modified');
  assert.equal(SOURCES.find((x) => x.id === 'llama-market').cadenceHours, 24);
  for (const a of model.assets) {
    if (a.supply) assert.equal(a.supplyAsOf, a.supply.t.at(-1), a.key);
    assert.ok(a.supplyAsOf === null || a.supplyAsOf <= model.now, `${a.key} supplyAsOf in the future`);
    if (a.llamaId && raw.charts[a.llamaId]) assert.equal(a.supplyAsOf, Math.max(...raw.charts[a.llamaId].map((r) => r.date)), `${a.key} supplyAsOf = its chart's last day`);
  }
  const st = model.sources.find((x) => x.id === 'llama-stablecoins');
  assert.equal(Date.parse(st.dataAsOf) / 1000, model.listAsOf, 'supply source as-of = the hourly list, the freshest series it has');
  assert.equal(st.status, 'ok', 'daily charts 17 h old are within their own cadence: not a lag');
});
check('#1 current snapshot: one stated time per figure; list members from the hourly list', () => {
  for (const a of model.assets.filter((x) => x.status !== 'dead')) {
    const c = a.current;
    assert.ok(c && Number.isFinite(c.supply) && Number.isFinite(c.asOf) && c.asOf <= model.now && c.parts.length > 0, a.key);
    assert.ok(Math.abs(c.parts.reduce((x, p) => x + p.supply, 0) / c.supply - 1) < 1e-9, `${a.key} parts add up`);
    assert.ok(c.parts.every((p) => Number.isFinite(p.asOf) && p.asOf >= c.asOf), `${a.key} asOf = oldest part`);
    if (a.list) {
      assert.equal(c.source, 'defillama:list', a.key);
      assert.equal(c.asOf, model.listAsOf, a.key);
      assert.equal(c.supplyUsd, a.list.circulating[a.pegType], a.key);
    }
  }
});
check('#3 CoinGecko daily series hold only 00:00 UTC points (an intraday print never stands in for the day)', () => {
  let n = 0;
  for (const a of model.assets.filter((x) => x.geckoId && raw.cgCharts[x.geckoId])) {
    const mid = raw.cgCharts[a.geckoId].prices.filter((p) => p[0] % (DAY * 1000) === 0);
    assert.equal(a.cgDaily.price.v.at(-1), mid.at(-1)[1], a.key);
  }
  for (const a of model.assets.filter((x) => x.xauDaily)) {
    const pts = raw.cgXau[a.geckoId].prices, mid = pts.filter((p) => p[0] % (DAY * 1000) === 0);
    assert.ok(pts.length > mid.length, 'fixture should carry an intraday XAU point to make this test meaningful');
    assert.deepEqual([a.xauDaily.t.at(-1), a.xauDaily.v.at(-1)], [mid.at(-1)[0] / 1000, mid.at(-1)[1]], a.key);
    n++;
  }
  assert.ok(n > 0 || !gold.length);
});
check('daily prices of different sources are dated to the same instant (near-midnight prints round to the nearest midnight)', () => {
  let n = 0;
  for (const a of model.assets.filter((x) => x.priceLlamaDaily && x.cgDaily)) {
    const cg = new Map(a.cgDaily.price.t.map((t, i) => [t, a.cgDaily.price.v[i]]));
    const same = [], shifted = [];
    a.priceLlamaDaily.t.forEach((t, i) => {
      if (cg.has(t)) same.push(Math.abs(Math.log(a.priceLlamaDaily.v[i] / cg.get(t))));
      if (cg.has(t + DAY)) shifted.push(Math.abs(Math.log(a.priceLlamaDaily.v[i] / cg.get(t + DAY))));
    });
    assert.ok(S.median(same) < S.median(shifted), `${a.key}: coins.llama.fi and CoinGecko agree better one day apart (${S.median(same)} vs ${S.median(shifted)})`);
    n++;
  }
  for (const a of model.assets.filter((x) => x.priceLlamaDaily)) {
    const prints = raw.daily[raw.coinKeys[R.assetId(a)]].filter((p) => Math.round(p.t / DAY) * DAY <= model.now);
    assert.equal(a.priceLlamaDaily.t.length, new Set(prints.map((p) => Math.round(p.t / DAY))).size, `${a.key}: no daily print lost to a neighbour's day`);
  }
  assert.ok(n > 0);
});
check('decision 5: consensus daily price = median of the daily sources; a lone bad print loses to its neighbours', () => {
  const t0 = Math.floor(model.now / DAY) * DAY - 59 * DAY;
  const days = Array.from({ length: 60 }, (_, i) => t0 + i * DAY);
  const base = days.map((_, i) => 1 + 0.0002 * Math.sin(i));
  const spike = base.slice();
  spike[40] = base[40] * 1.08;
  const two = M.priceConsensus([{ t: days, v: base }, { t: days, v: spike }]);
  assert.equal(two.consensus.v[40], base[40]);
  assert.equal(two.count.v[40], 2);
  const third = base.map((v) => v * 1.0001);
  assert.equal(M.priceConsensus([{ t: days, v: base }, { t: days, v: spike }, { t: days, v: third }]).consensus.v[40], third[40]);
  let spikes = 0;
  for (const a of model.assets.filter((x) => x.priceConsensus)) {
    assert.deepEqual(a.priceSources.t, a.priceConsensus.t, a.key);
    const srcs = [a.priceDaily, a.priceLlamaDaily, a.cgDaily && a.cgDaily.price].filter(Boolean).map((x) => new Map(x.t.map((t, i) => [t, x.v[i]])));
    a.priceConsensus.t.forEach((t, i) => assert.equal(a.priceSources.v[i], srcs.filter((m) => m.get(t) > 0).length, `${a.key} ${t}`));
    // Fixture case: an isolated coins.llama.fi print far off both neighbours while another source agrees with them.
    const ld = a.priceLlamaDaily, pc = new Map(a.priceConsensus.t.map((t, i) => [t, a.priceConsensus.v[i]]));
    if (!ld) continue;
    for (let i = 1; i < ld.t.length - 1; i++) {
      const nb = S.median([ld.v[i - 1], ld.v[i + 1]]);
      if (a.priceSources.v[a.priceConsensus.t.indexOf(ld.t[i])] === 2 && Math.abs(Math.log(ld.v[i] / nb)) > 0.05) {
        spikes++;
        assert.notEqual(pc.get(ld.t[i]), ld.v[i], `${a.key} ${new Date(ld.t[i] * 1000).toISOString().slice(0, 10)}: the lone print set the consensus`);
      }
    }
  }
  assert.ok(spikes > 0, 'fixture should contain an isolated bad daily print');
});
check('#10 a one-chain Coin Metrics supply is completed with the other issuer chains and valued at the same instant', () => {
  const cmAssets = model.assets.filter((a) => a.supplySource === 'coinmetrics:SplyCur');
  assert.ok(cmAssets.length > 0);
  for (const a of cmAssets) {
    const m = raw.cm.map[R.assetId(a)];
    const rows = raw.cm.supply[m.id] && raw.cm.supply[m.id].length ? raw.cm.supply[m.id] : raw.cm.rows[m.id];
    assert.equal(a.supply.t.at(-1), Date.parse(rows.at(-1).time) / 1000 + DAY, 'a daily row is the level at the next 00:00');
    const pc = new Map(a.priceConsensus.t.map((t, i) => [t, a.priceConsensus.v[i]]));
    const t = a.supply.t.at(-1);
    assert.ok(Math.abs(a.supplyUsd.v.at(-1) / (a.supply.v.at(-1) * pc.get(t)) - 1) < 1e-12, 'USD = supply x consensus price of the same instant');
    assert.ok(m.scope, `${a.key}: the fixture's Coin Metrics id covers one chain`);
    const others = a.onchain.filter((o) => R.chainKey(o.chain) !== R.chainKey(m.scope) && o.totalSupply > 0);
    assert.ok(others.length > 0, 'fixture should hold another issuer chain');
    assert.ok(Math.abs(a.current.supply - (a.supply.v.at(-1) + others.reduce((x, o) => x + o.totalSupply, 0))) < 1e-6);
    assert.equal(a.current.parts.length, 1 + others.length);
    if (a.cg && a.cg.circulating_supply > 0) assert.ok(Math.abs(Math.log(a.current.supply / a.cg.circulating_supply)) < Math.abs(Math.log(a.supply.v.at(-1) / a.cg.circulating_supply)), 'the completed level is closer to CoinGecko circulating');
    assert.ok(a.current.priceAsOf > t && Math.abs(a.current.supplyUsd - a.current.supply * a.current.price) < 1e-6, 'current level valued at the current quote');
  }
});
check('#17 a Coin Metrics series that covers one chain names it (asset.cm.chain, a display name)', () => {
  const withCm = model.assets.filter((a) => a.cm);
  assert.ok(withCm.length > 0);
  let named = 0;
  for (const a of withCm) {
    const m = raw.cm.map[R.assetId(a)];
    const suffix = m.id.includes('_') ? m.id.slice(m.id.indexOf('_') + 1) : null;
    if (suffix) assert.ok(a.cm.chain && R.chainKey(a.cm.chain).startsWith(suffix), `${a.key}: ${m.id} covers ${a.cm.chain}`);
    else if (m.scope) assert.ok(a.cm.chain && R.chainKey(a.cm.chain) === R.chainKey(m.scope), `${a.key}: unsuffixed ${m.id} names the one chain it matched (${a.cm.chain})`);
    else assert.equal(a.cm.chain, null, `${a.key}: ${m.id} covers the whole asset`);
    if (a.cm.chain) {
      named++;
      assert.ok(Object.keys(a.chains).includes(a.cm.chain) || a.onchain.some((o) => o.chain === a.cm.chain) || a.addresses.some((x) => x.chain === a.cm.chain), `${a.key}: ${a.cm.chain} is one of the asset's own chain names`);
    }
  }
  assert.ok(named > 0, 'fixture should hold a one-chain Coin Metrics series');
});
check('#11/#26 Coin Metrics supply history starts where the source starts, not at our request window', () => {
  for (const a of model.assets.filter((x) => x.supplySource === 'coinmetrics:SplyCur')) {
    assert.ok(a.supply.t[0] < model.now - 1095 * DAY, `${a.key} supply starts ${new Date(a.supply.t[0] * 1000).toISOString().slice(0, 10)}`);
    if (a.firstPriceT) assert.ok(a.supply.t[0] <= a.firstPriceT + 31 * DAY, `${a.key} supply history covers the price history`);
    const valued = a.supplyUsd.v.filter(Number.isFinite).length;
    assert.ok(valued >= 0.95 * a.supply.t.length, `${a.key}: only ${valued}/${a.supply.t.length} supply days valued in USD`);
  }
});
check('#51 every chain the engine treats as material has a chain total history (one floor rule)', () => {
  const fl = D.helpers.floors(model);
  const known = new Set(model.list.chains.map((c) => c.name));
  let n = 0;
  for (const a of model.assets.filter((x) => x.status !== 'dead' && x.supply)) {
    const mf = M.materialityFloor(a.supply, a.supplyUsd, a.cg && a.cg.current_price);
    if (Number.isFinite(fl[a.key])) assert.ok(Math.abs(mf.floorUsd / fl[a.key] - 1) < 1e-9, `${a.key} floor: data layer ${mf.floorUsd} vs engine ${fl[a.key]}`);
    const px = D.helpers.priceOf(a);
    for (const [chain, c] of Object.entries(a.chains)) {
      const g = D.helpers.grid(c);
      if (!g || !known.has(chain) || !(Math.max(0, ...g.v.slice(-D.NATIVE.month).filter(Number.isFinite)) * px >= (fl[a.key] || 0))) continue;
      n++;
      assert.ok(model.chainTotals[chain] && model.chainTotals[chain].hist, `${a.key} on ${chain} is material for the engine but has no chain total`);
    }
  }
  assert.ok(n > 0);
});
check('#33 third-party bridged and issuer-unlisted contracts are labelled and kept out of issuer matching', () => {
  let third = 0;
  for (const a of model.assets) {
    for (const x of a.addresses) assert.ok(['issuer', 'unverified'].includes(x.role), `${a.key} ${x.chain} ${x.role}`);
    for (const x of a.addresses.filter((y) => y.via.includes('paxos-docs'))) assert.equal(x.role, 'issuer');
    for (const x of a.thirdPartyAddresses) {
      third++;
      assert.ok(['bridged', 'unlisted'].includes(x.role) && !x.via.includes('paxos-docs'), `${a.key} ${x.chain}`);
    }
    const det = a.llamaId && raw.details[a.llamaId];
    for (const kinds of Object.values((det && det.chainConfig && det.chainConfig.chains) || {})) {
      for (const [kind, arr] of Object.entries(kinds)) {
        if (!/^bridged/i.test(kind)) continue;
        for (const ad of arr) if (!a.addresses.some((x) => R.normAddr(x.address) === R.normAddr(ad) && x.via.includes('paxos-docs'))) assert.ok(a.thirdPartyAddresses.some((x) => R.normAddr(x.address) === R.normAddr(ad) && x.role === 'bridged'), `${a.key} ${ad} is DefiLlama-bridged but not labelled`);
      }
    }
    const issuer = new Set(a.addresses.map((x) => R.chainKey(x.chain) + '|' + R.normAddr(x.address)));
    for (const o of a.onchain) assert.ok(issuer.has(R.chainKey(o.chain) + '|' + R.normAddr(o.address)), `${a.key}: on-chain read of a non-issuer contract ${o.chain}`);
  }
  assert.ok(third > 0, 'fixture should contain third-party contracts');
});
check('#49 docs address tables are found by their header row (headings, column order, backticks do not matter)', () => {
  const pages = URLS.filter((u) => /^https:\/\/docs\.paxos\.com\/.*\/mainnet\.md$/.test(u));
  assert.ok(pages.length > 0);
  for (const u of pages) {
    const md = fixture.responses[u].body;
    const base = R.parseDocsMainnet(md, 'x');
    assert.ok(base.rows.length > 0, u);
    const variants = [
      md.replace(/^(\| *Network *\|)/m, '## Contract Addresses\n\n$1'),
      md.replace(/^(\| *Network *\|)/m, '## Mainnet\n\n$1'),
      md.replace(/^\|([^|\n]*)\|([^|\n]*)\|[ \t]*$/gm, '|$2|$1|'),
      md.replace(/\[(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\]/g, '[`$1`]'),
    ];
    for (const v of variants) assert.deepEqual(R.parseDocsMainnet(v, 'x').rows.map((r) => r.address), base.rows.map((r) => r.address), u);
  }
});

// Malformed and mis-dated upstream data (#23, #24). Run A: faults that cost single rows (dropped,
// reported, the cleaned body may be cached). Run B: faults that make a body unusable (rejected, not
// cached); the same cache with a clean upstream must then give the baseline model at once.
const cgDetailUrls = URLS.filter((u) => /^https:\/\/api\.coingecko\.com\/api\/v3\/coins\/(?!markets\?)[a-z0-9-]+\?/.test(u));
const cgCharts = usdActive.filter((a) => a.geckoId).map((a) => URLS.find((u) => u.startsWith(`https://api.coingecko.com/api/v3/coins/${a.geckoId}/market_chart?vs_currency=usd`))).filter(Boolean);
const [slipOne, slipAll] = [chartUrl(usdActive[0]), chartUrl(usdActive[1])];
const faultsA = new Map([
  [cgCharts[0], (j) => { j.prices[5] = null; return j; }],
  [LIST_URL, (j) => { j.peggedAssets.push(null); j.chains.push(null); j.peggedAssets[3] = { ...j.peggedAssets[3], circulating: 'x' }; return j; }],
  [slipOne, (j) => { const l = j.at(-1); j.push({ ...l, date: String(Number(l.date) * 3) }, { ...l, date: String(Number(l.date) * 1000) }); return j; }],
]);
const faultsB = new Map([
  ...cgDetailUrls.map((u) => [u, (j) => ({ ...j, categories: 'Tokenized Gold' })]),
  [cgCharts[1], (j) => ({ ...j, total_volumes: 'x' })],
  [slipAll, (j) => j.map((r) => ({ ...r, date: String(Number(r.date) * 1000) }))],
]);
const corrupt = (faults) => (url) => (faults.has(url) ? respond(faults.get(url)(body(url)), url) : null);
// A mutation run that throws is reported as a failed check (the original defect), not a crashed script.
const tryRun = (override, cache) => run(override, cache).catch((e) => ({ crash: e }));
const crashed = (x) => assert.ok(!x.crash, `build threw: ${x.crash && x.crash.message}`);
const badA = await tryRun(corrupt(faultsA));
const badB = await tryRun(corrupt(faultsB));
const activeKeys = (m) => m.assets.filter((a) => a.status === 'active').map((a) => a.key).sort();
check('#23/#24 wrong-typed or mis-dated rows are dropped and reported; nothing throws', () => {
  assert.ok(cgCharts.length >= 2 && slipOne && slipAll && cgDetailUrls.length, 'fixture lacks the responses this test corrupts');
  crashed(badA);
  assert.deepEqual(badA.raw.errors, []);
  assert.deepEqual(badA.model.errors, []);
  assert.deepEqual(activeKeys(badA.model), activeKeys(model));
  const src = (id) => badA.model.sources.find((x) => x.id === id);
  assert.equal(src('coingecko').status, 'partial');
  assert.match(src('coingecko').message, /dropped 1 malformed/);
  assert.equal(src('llama-stablecoins').status, 'partial');
  assert.match(src('llama-stablecoins').message, /dropped/);
  const k0 = usdActive[0].key;
  assert.deepEqual(badA.model.assets.find((a) => a.key === k0).supply, model.assets.find((a) => a.key === k0).supply, 'far-future and millisecond rows dropped, the rest kept');
  const late = [];
  walk(badA.model, 'model', (o, p) => { if (isSeries(o) && o.t.length && o.t.at(-1) > badA.model.now + DAY) late.push(p); });
  assert.deepEqual(late, [], 'no series reaches past now + 1 day');
});
check('#23/#24 an unusable body (wrong-typed field, every date a unit slip) degrades its source and is never cached', () => {
  crashed(badB);
  assert.deepEqual(badB.raw.errors, []);
  assert.deepEqual(badB.model.errors, []);
  assert.deepEqual(activeKeys(badB.model), activeKeys(model));
  for (const id of ['coingecko', 'llama-stablecoins']) {
    const x = badB.model.sources.find((y) => y.id === id);
    assert.ok(x.status === 'partial' && /unexpected response shape/.test(x.message), `${id}: ${x.status} ${x.message}`);
  }
  for (const u of [...cgDetailUrls, cgCharts[1], slipAll]) assert.equal(badB.cache.peek(u), null, `rejected body cached: ${u}`);
});
const healed = badB.crash ? badB : await tryRun(null, badB.cache);
check('#23 a clean upstream heals at once: nothing malformed was cached', () => {
  crashed(healed);
  assert.equal(stripModel(healed.model), stripModel(model));
});
check('#23 buildModel survives wrong-typed records: the section is dropped and listed in model.errors', () => {
  const r2 = structuredClone(raw);
  r2.registry.assets[0].addresses = 'x';
  r2.details[Object.keys(r2.details)[0]].chainBalances = { Ethereum: { tokens: 'x' } };
  r2.cgCharts[Object.keys(r2.cgCharts)[0]] = { prices: 'x', market_caps: 7, total_volumes: [null] };
  r2.chartsAll.push(null, { date: 'x' });
  const m2 = buildModel(r2, { now: model.now });
  assert.equal(m2.assets.length, model.assets.length);
  assert.ok(m2.errors.some((e) => e.includes(model.assets[0].key) && e.includes('addresses')), JSON.stringify(m2.errors));
});

const fmt = await tryRun((url) => {
  const docsPage = URLS.find((u) => /^https:\/\/docs\.paxos\.com\/.*\/mainnet\.md$/.test(u));
  if (url === docsPage) return new Response(fixture.responses[url].body.replace(/^\| *Network *\|/m, '| Where |'), { status: 200, headers: { 'content-type': 'text/markdown' } });
  if (/^https:\/\/api\.llama\.fi\/summary\/fees\//.test(url)) return respond(JSON.parse(fixture.responses[url].body.replace(/Yields from ([^"]+?) backing/g, '$1 reserve yield')), url);
  return null;
});
check('#49/#50 a docs page or fee label that no longer parses marks its source partial with a message', () => {
  crashed(fmt);
  const st = (id) => fmt.model.sources.find((x) => x.id === id);
  assert.equal(st('paxos-docs').status, 'partial');
  assert.match(st('paxos-docs').message, /no token address table recognised/);
  assert.equal(fmt.model.discovery.tiers.find((t) => t.id === 'defillama:fees-label').ok, false);
  assert.equal(st('llama-fees').status, 'partial');
  assert.match(st('llama-fees').message, /fee label/);
});

await checkAsync('#60 redirects: only same-host https hops are followed; the CoinGecko key stays on its host', async () => {
  const seen = [];
  const f = stub((url, init) => {
    seen.push({ url, key: init.headers['x-cg-demo-api-key'] || null, redirect: init.redirect });
    const go = (status, location) => new Response('', { status, headers: { location } });
    if (url.endsWith('/a')) return go(302, '/b');
    if (url.endsWith('/b')) return new Response('{"ok":1}', { status: 200 });
    if (url.endsWith('/http')) return go(302, 'http://127.0.0.1:1/internal');
    if (url.endsWith('/other')) return go(301, 'https://elsewhere.invalid/x');
    if (url.endsWith('/loop')) return go(307, '/loop');
    return new Response('{}', { status: 200 });
  });
  const ok = await fetchJson({ url: 'https://hop.invalid/a', fetch: f });
  assert.ok(ok.ok && ok.data.ok === 1, JSON.stringify(ok));
  for (const p of ['http', 'other']) assert.match((await fetchJson({ url: 'https://hop.invalid/' + p, fetch: f })).error, /refused/);
  assert.match((await fetchJson({ url: 'https://hop.invalid/loop', fetch: f })).error, /redirects/);
  const had = process.env.COINGECKO_DEMO_API_KEY;
  process.env.COINGECKO_DEMO_API_KEY = 'check-only-dummy';
  try {
    const g = stub((url, init) => (seen.push({ url, key: init.headers['x-cg-demo-api-key'] || null, redirect: init.redirect }), new Response('', { status: 302, headers: { location: 'https://elsewhere.invalid/k' } })));
    assert.match((await fetchJson({ url: 'https://api.coingecko.com/api/v3/ping', fetch: g })).error, /refused/);
  } finally {
    if (had === undefined) delete process.env.COINGECKO_DEMO_API_KEY;
    else process.env.COINGECKO_DEMO_API_KEY = had;
  }
  assert.ok(seen.every((x) => x.redirect === 'manual'));
  assert.ok(seen.every((x) => /^https:\/\/(hop\.invalid|api\.coingecko\.com)\//.test(x.url)), 'never left the original host');
  assert.ok(seen.every((x) => !x.key || x.url.startsWith('https://api.coingecko.com/')), 'key only on api.coingecko.com');
});
check('#57 the fixture recorder replaces the fixture only after its replay reproduces the live model', () => {
  const src = fs.readFileSync(new URL('./record-paxos-fixtures.mjs', import.meta.url), 'utf8');
  const write = src.indexOf('fs.writeFileSync(tmp'), cmp = src.indexOf('const same ='), mv = src.indexOf('fs.renameSync(tmp, out)');
  assert.ok(write > 0 && cmp > write && mv > cmp, 'write temp -> replay and compare -> rename');
  assert.ok(!/writeFileSync\(out\b/.test(src), 'never writes the destination directly');
});

// ---------- on-chain: Blockscout PRO API route, RPC supply, chain registry ----------
const { slim } = require('../lib/paxos/sources.js');
const onchainRows = (m) => m.assets.flatMap((a) => (a.onchain || []).map((o) => ({ asset: a.key, ...o })));
const onchainSrc = (r) => r.sources.find((s) => s.id === 'onchain');
const isRpc = (url, init) => (init && init.method === 'POST' && /"eth_call"/.test(String(init.body || '')));
check('chain registry: only plain https RPCs on public names are kept (no templated keys, ports, IPs, http, wss)', () => {
  const out = slim.chainlist([
    { chainId: 1, name: 'Ethereum Mainnet', rpc: ['https://mainnet.infura.io/v3/${INFURA_API_KEY}', 'wss://eth.example.org', 'http://eth.example.org', 'https://127.0.0.1:8545', 'https://user:pw@eth.example.org', 'https://eth.example.org:8443', 'https://eth.example.org/rpc?key=1', 'https://ethereum-rpc.example.org', 'https://eth.example.org/v1/rpc'] },
    { chainId: 2, name: 'No RPC', rpc: [] },
    { chainId: 'x', name: 'Bad id', rpc: ['https://ok.example.org'] },
  ]);
  assert.deepEqual(out, { 1: { name: 'Ethereum Mainnet', rpc: ['https://ethereum-rpc.example.org', 'https://eth.example.org/v1/rpc'] } });
});
check('chain ids: the chain registry fills an EVM id only for an unambiguous name, never one already taken', () => {
  const n = R.makeChainNamer({
    listChains: [{ name: 'Alpha' }, { name: 'Beta Layer' }, { name: 'Gamma' }, { name: 'Delta' }],
    llamaChains: [{ name: 'Alpha', chainId: 10 }],
    evmChains: { 10: { name: 'Alpha Mainnet' }, 20: { name: 'Beta Layer Mainnet' }, 30: { name: 'Gamma' }, 31: { name: 'Gamma Mainnet' }, 40: { name: 'Alpha One' } },
  });
  assert.equal(n.chainId('Alpha'), 10, 'DefiLlama id wins');
  assert.equal(n.chainId('Beta Layer'), 20, 'registry name "Beta Layer Mainnet" normalises to the display name');
  assert.equal(n.chainId('Gamma'), null, 'two registry chains normalise to "gamma": ambiguous, not guessed');
  assert.equal(n.chainId('Delta'), null);
});
check('every active EVM issuer contract has a chain id and an on-chain supply (RPC), even on chains without an explorer', () => {
  const evm = model.assets.filter((a) => a.status === 'active').flatMap((a) => a.addresses.filter((x) => R.isEvm(x.address)).map((x) => ({ a, x })));
  assert.ok(evm.length > 0);
  for (const { a, x } of evm) {
    assert.ok(x.chainId, `${a.key} ${x.chain} has no chain id`);
    const row = (a.onchain || []).find((o) => o.chain === x.chain && R.normAddr(o.address) === R.normAddr(x.address));
    assert.ok(row && Number.isFinite(row.totalSupply), `${a.key} ${x.chain}: no on-chain supply`);
  }
});
await checkAsync('a failing RPC that another endpoint covers is not a data gap; all endpoints failing is', async () => {
  // The first RPC of every chain fails and the next one answers: no data gap, no failed request.
  const reg = raw.chainlist || {};
  const first = new Set(Object.values(reg).map((c) => c.rpc[0]));
  const multi = new Set(Object.entries(reg).filter(([, c]) => c.rpc.length > 1).map(([id]) => id));
  const answer = (init) => {
    const sig = JSON.parse(init.body).params[0].data;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: sig === '0x313ce567' ? '0x6' : '0x' + (123456789n * 10n ** 6n).toString(16) }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const flaky = await run((url, init) => (isRpc(url, init) ? (first.has(String(url)) ? new Response('bad gateway', { status: 502 }) : answer(init)) : null));
  const s = onchainSrc(flaky.raw);
  const failedChains = [...String(s.message || '').matchAll(/no RPC answered eth_call on chain (\d+)/g)].map((m) => m[1]);
  assert.deepEqual(failedChains.filter((id) => multi.has(id)), [], s.message);
  assert.match(String(s.message), /failed over to an alternative/);
  const usedChains = new Set(model.assets.flatMap((a) => a.addresses).filter((x) => R.isEvm(x.address) && multi.has(String(x.chainId))).map((x) => x.chain));
  for (const ch of usedChains) assert.ok(onchainRows(flaky.model).some((o) => o.chain === ch && o.totalSupply === 123456789), `${ch} keeps an RPC supply`);
  // Every RPC fails: reported as a failure naming the chain.
  const dead = await run((url, init) => (isRpc(url, init) ? new Response('down', { status: 503 }) : null));
  const d = onchainSrc(dead.raw);
  assert.ok(d.status !== 'ok' && /no RPC answered eth_call on chain/.test(d.message), d.message);
});
await checkAsync('BLOCKSCOUT_API_KEY routes explorer reads through api.blockscout.com with the key in a header, only there', async () => {
  const had = process.env.BLOCKSCOUT_API_KEY;
  process.env.BLOCKSCOUT_API_KEY = 'proapi_check_only_dummy';
  const seen = [];
  try {
    const r = await run((url, init) => {
      const auth = init && init.headers ? init.headers.authorization || init.headers.Authorization || null : null;
      seen.push({ url: String(url), auth });
      const m = /^https:\/\/api\.blockscout\.com\/(\d+)\/api\/v2\/tokens\/(0x[0-9a-fA-F]{40})$/.exec(String(url));
      if (!m) return null;
      return new Response(JSON.stringify({ holders_count: '4242', total_supply: '1000000000', decimals: '6' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const pro = seen.filter((x) => x.url.startsWith('https://api.blockscout.com/'));
    assert.ok(pro.length > 0, 'PRO API used');
    assert.ok(pro.every((x) => x.auth === 'Bearer proapi_check_only_dummy'), 'key sent as a bearer header');
    assert.ok(seen.filter((x) => !x.url.startsWith('https://api.blockscout.com/')).every((x) => !x.auth), 'key never sent elsewhere');
    assert.ok(seen.every((x) => !x.url.includes('proapi_check_only_dummy')), 'key never in a URL');
    const s = onchainSrc(r.raw);
    assert.ok(!/blocks scripted requests/.test(s.message || ''), s.message);
    const rows = onchainRows(r.model).filter((o) => o.holders === 4242);
    assert.ok(rows.length > 0 && rows.every((o) => o.source.startsWith('api.blockscout.com')), 'holders from the PRO API');
    assert.ok(!JSON.stringify(r.raw.sources).includes('proapi_check_only_dummy'), 'key never in source records');
  } finally {
    if (had === undefined) delete process.env.BLOCKSCOUT_API_KEY;
    else process.env.BLOCKSCOUT_API_KEY = had;
  }
});
await checkAsync('without a key, a bot-protected explorer is reported with the fix, and the chain keeps its RPC supply', async () => {
  const blocked = await run((url) => (/^https:\/\/[^/]*blockscout\.com\/api\/v2\/tokens\//.test(String(url)) && !String(url).startsWith('https://api.blockscout.com/') && /eth\./.test(String(url)) ? new Response('<!DOCTYPE html><title>Just a moment...</title>', { status: 403, headers: { 'content-type': 'text/html' } }) : null));
  const s = onchainSrc(blocked.raw);
  assert.ok(/blocks scripted requests; set BLOCKSCOUT_API_KEY/.test(s.message || ''), s.message);
  const eth = onchainRows(blocked.model).filter((o) => /eth\.blockscout/.test(o.source || ''));
  assert.equal(eth.length, 0, 'no explorer rows from the blocked host');
  assert.ok(onchainRows(blocked.model).some((o) => o.holders === null && Number.isFinite(o.totalSupply)), 'supply still from RPC');
});

const ms = Date.now() - T0;
// Timing is advisory (a slow CI machine must not fail the deploy); PAXOS_PERF_STRICT=1 enforces it.
if (ms >= 8000) {
  if (process.env.PAXOS_PERF_STRICT === '1') check('runs in under 8 s', () => assert.ok(ms < 8000, `${ms} ms`));
  else console.warn(`check-paxos-sources: slow run (${ms} ms >= 8000 ms); set PAXOS_PERF_STRICT=1 to enforce`);
}
console.log(`check-paxos-sources: ${passed} checks passed${process.exitCode ? ', some FAILED' : ''} in ${Date.now() - T0} ms (fixture ${fixture.recordedAt}, ${Object.keys(fixture.responses).length} responses; ${model.assets.map((a) => `${a.key}:${a.status}`).join(', ')})`);
