'use strict';

// Paxos health pipeline: collectRaw (sources.js) -> buildModel (model.js) -> engine.run + attribution
// -> payload (payload.js), with per-stage timings.
//
// Warm serverless instances keep two things in module scope: the TTL cache of upstream responses
// (cache.js, used by collectRaw) and the last payload (the memo). Paths, reported as meta.memo:
// - reuse:  the memo is younger than REUSE_MS and than its own cache.sMaxAge, so it is returned as is
//           (same generatedAt, no upstream call). This bounds how often one instance can be made to
//           rebuild, whatever URL variations reach it: at most 3600 s / REUSE_MS times an hour (4).
// - shared: a concurrent caller joins the build already in flight.
// - hit:    a rebuild whose model is identical to the memo's (sha1 of its JSON plus the source
//           statuses) within the same UTC hour reuses the memo's insights without re-running the
//           engine, restamped with this run's time and source records (the hour is part of the key
//           because some findings, "N days overdue", depend on the clock).
// - miss:   a full build. (off: memoisation disabled, for checks.)
// meta.ageMs is the payload's age when served (0 unless reused or shared), so the API can give the
// CDN only the payload's remaining freshness; meta.timingsMs holds only the stages that ran for this
// request; meta.calls / meta.cgCalls count the upstream requests a build sent (miss, off and hit; cache
// hits excluded), so the build log can audit the CoinGecko quota.

const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { collectRaw } = require('./sources');
const { buildModel } = require('./model');
const engine = require('./engine');
const { attribution } = require('./attribution');
const { buildPayload, sourcesOut, statusOf, tokenFlowView, CACHE } = require('./payload');

const REUSE_MS = 15 * 60e3;
let memo = null; // { key, payload, at, meta }
let inflight = null;

function fingerprint(model) {
  const { now, sources, ...data } = model;
  return crypto.createHash('sha1')
    .update(JSON.stringify(data))
    .update(JSON.stringify((sources || []).map((s) => [s.id, s.status, s.dataAsOf, s.failed])))
    .update(String(Math.floor(now / 3600)))
    .digest('hex');
}

const ms = (a, b) => Math.round(b - a);
const errText = (e) => String((e && e.message) || e).slice(0, 300);
const ageOf = (payload, clock) => Math.max(0, clock() - Date.parse(payload.generatedAt));
// How long a memoised payload may be served without rebuilding: REUSE_MS, but never past its own
// cache.sMaxAge (a degraded payload, re-checked after 5 min, is rebuilt after 5 min).
const reuseLimitMs = (payload) => Math.min(REUSE_MS, ((payload.cache && payload.cache.sMaxAge) || 0) * 1000);

async function build({ fetch = globalThis.fetch, now, clock = Date.now, log = () => {}, cache, budgetMs, timeoutMs, onchain, memoize = true } = {}) {
  const t0 = performance.now();
  now = Number.isFinite(now) ? now : Math.floor(clock() / 1000);
  const raw = await collectRaw({ fetch, now, log, ...(cache ? { cache } : {}), ...(budgetMs ? { budgetMs } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(onchain === false ? { onchain } : {}) });
  const t1 = performance.now();
  const model = buildModel(raw, { now });
  const t2 = performance.now();
  const key = fingerprint(model);
  const t3 = performance.now();
  const timings = { fetch: ms(t0, t1), model: ms(t1, t2), fingerprint: ms(t2, t3) };
  const calls = raw.calls || {};
  const cgCalls = calls.coingecko || 0;
  if (memoize && memo && memo.key === key) {
    // Same data, re-verified now: reuse the insights but stamp this run's time, source records (ages
    // recomputed against the new generatedAt) and timings. The engine did not run: timingsMs.engine null.
    // The status is re-judged on the new source records (their statuses, and so the cache policy, are
    // part of the key; their messages are not).
    const generatedAt = new Date(clock()).toISOString();
    const total = ms(t0, performance.now());
    memo.payload = { ...memo.payload, generatedAt, sources: sourcesOut(model, Date.parse(generatedAt) / 1000), timingsMs: { fetch: timings.fetch, model: timings.model, engine: null, total } };
    memo.payload.status = statusOf(memo.payload);
    memo.at = clock();
    return { payload: memo.payload, meta: { ...memo.meta, memo: 'hit', ageMs: 0, calls, cgCalls, timingsMs: { ...timings, total } } };
  }
  // Requests the data layer could not use (buildPayload adds the model's own dropped records).
  const errors = (raw.errors || []).map((e) => ({ detector: 'sources', error: String(e) }));
  let res = null;
  try {
    res = engine.run(model, { now });
  } catch (e) {
    log('[paxos] engine failed', e);
    errors.push({ detector: 'engine', error: errText(e) });
  }
  const t4 = performance.now();
  let att = null;
  try {
    // Token-flow view: USD stablecoins valued at today's price, the same basis as the payload's totals.
    att = attribution(tokenFlowView(model));
  } catch (e) {
    log('[paxos] attribution failed', e);
    errors.push({ detector: 'attribution', error: errText(e) });
  }
  const t5 = performance.now();
  const { payload, nonFinite } = buildPayload(model, res, att, {
    generatedAt: new Date(clock()).toISOString(),
    timingsMs: { fetch: timings.fetch, model: timings.model, engine: ms(t3, t4), total: ms(t0, t5) },
    errors,
  });
  const t6 = performance.now();
  payload.timingsMs.total = ms(t0, t6);
  if (nonFinite) log(`[paxos] payload had ${nonFinite} non-finite numbers (replaced by null)`);
  const t = payload.totals;
  const usable = (t && t.usd && Number.isFinite(t.usd.current)) || Object.values(payload.assets).some((a) => Number.isFinite(a.current.supplyUsd));
  if (!usable) throw new Error('no supply data from any upstream source');
  const meta = {
    memo: memoize ? 'miss' : 'off',
    key,
    nonFinite,
    ageMs: 0,
    calls,
    cgCalls,
    engine: res ? { testsRun: res.testsRun, groups: res.groups, errors: res.errors.length, timingsMs: res.timingsMs, novelty: res.novelty } : null,
    timingsMs: { ...timings, engine: ms(t3, t4), attribution: ms(t4, t5), payload: ms(t5, t6), total: ms(t0, t6) },
  };
  if (memoize) memo = { key, payload, at: clock(), meta };
  return { payload, meta };
}

// Returns { payload, meta }. Never throws for upstream failures (they degrade the payload); throws
// only when no asset has any supply data at all, which the API reports as a 502.
async function buildPaxosHealth(opts = {}) {
  const { clock = Date.now, memoize = true } = opts;
  if (memoize && memo && clock() - memo.at < reuseLimitMs(memo.payload)) {
    // Nothing ran for this request: no stage timings, only the (zero) total.
    return { payload: memo.payload, meta: { memo: 'reuse', key: memo.key, nonFinite: memo.meta.nonFinite, ageMs: ageOf(memo.payload, clock), engine: null, timingsMs: { total: 0 } } };
  }
  if (memoize && inflight) return inflight.then((out) => ({ payload: out.payload, meta: { ...out.meta, memo: 'shared', ageMs: ageOf(out.payload, clock) } }));
  const p = build(opts);
  if (!memoize) return p;
  inflight = p;
  try {
    return await p;
  } finally {
    if (inflight === p) inflight = null;
  }
}

// Tests: forget the memoised payload.
const resetMemo = () => {
  memo = null;
  inflight = null;
};

module.exports = { buildPaxosHealth, fingerprint, resetMemo, CACHE, REUSE_MS };
