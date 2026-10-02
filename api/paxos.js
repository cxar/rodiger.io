'use strict';

const { buildPaxosHealth } = require('../lib/paxos');

// GET|HEAD /api/paxos: the Paxos health payload (schemaVersion 1, docs/paxos-dashboard.md).
// Request input never reaches an upstream request: the handler reads only the method. Query strings are
// ignored; cache-busting URLs cannot force upstream fan-out because the module-scope memo
// (lib/paxos/index.js, REUSE_MS) bounds rebuilds per instance. (No redirect to a canonical URL: if the
// platform ever appended a parameter to req.url, a self-redirect would take the API down.)
// createHandler({ build }) exists for offline checks (fixture-backed build); production uses the default.
// Headers: Cache-Control from payload.cache (the CDN's remaining freshness, stale-while-revalidate,
// stale-if-error), X-Paxos-Status (payload.status.level) and X-Paxos-Generated-At, so `curl -I` answers
// "is it healthy and how old?" without the body. Every response is public data for any origin (ACAO *,
// Cross-Origin-Resource-Policy: cross-origin; no credentials).
// Each build (memo miss, off or hit) logs one JSON line, {"evt":"paxos.build", ...} (buildLog); a failed
// one logs {"evt":"paxos.build_failed", "error"}.
const METHODS = 'GET, HEAD, OPTIONS';

function serverTiming(meta) {
  const t = meta.timingsMs || {};
  const stages = ['fetch', 'model', 'engine', 'payload', 'total'].filter((k) => Number.isFinite(t[k])).map((k) => `${k};dur=${t[k]}`);
  return [`memo;desc="${meta.memo}"`, ...stages].join(', ');
}

function cacheControl(cache, ageMs) {
  // The CDN may keep the payload only for what is left of its freshness budget: a reused payload
  // generated N s ago gets s-maxage = sMaxAge - N, so no viewer gets it past generatedAt + sMaxAge
  // as fresh (stale-while-revalidate then serves it while the CDN refetches; stale-if-error keeps
  // serving it while rebuilds fail).
  const sMaxAge = Math.max(0, cache.sMaxAge - Math.floor((ageMs || 0) / 1000));
  const parts = [`public, s-maxage=${sMaxAge}`, `stale-while-revalidate=${cache.staleWhileRevalidate}`];
  if (Number.isInteger(cache.staleIfError)) parts.push(`stale-if-error=${cache.staleIfError}`);
  return parts.join(', ');
}

const num = (x) => (Number.isFinite(x) ? x : null);
function buildLog(payload, meta) {
  const t = meta.timingsMs || {};
  const sources = { ok: 0, partial: 0, stale: 0, error: 0 };
  for (const s of payload.sources || []) sources[s.status] = (sources[s.status] || 0) + 1;
  const ins = payload.insights || {};
  return {
    evt: 'paxos.build',
    memo: meta.memo,
    status: payload.status ? payload.status.level : null,
    generatedAt: payload.generatedAt,
    totalMs: num(t.total),
    fetchMs: num(t.fetch),
    engineMs: num(t.engine),
    sources,
    cgCalls: num(meta.cgCalls),
    tests: num(ins.testsRun),
    feed: (ins.feed || []).length,
    errors: (ins.errors || []).length,
    briefingErrors: payload.briefing && Array.isArray(payload.briefing.errors) ? payload.briefing.errors.length : null,
    bytes: Buffer.byteLength(JSON.stringify(payload)),
  };
}

function createHandler({ build = buildPaxosHealth, log = console } = {}) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', METHODS);
      return res.status(204).end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', METHODS);
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    try {
      const { payload, meta } = await build({ log: (msg, e) => (e ? log.warn(msg, e.message || e) : log.log(msg)) });
      res.setHeader('Cache-Control', cacheControl(payload.cache, meta.ageMs));
      res.setHeader('Server-Timing', serverTiming(meta));
      res.setHeader('X-Paxos-Memo', meta.memo);
      if (payload.status) res.setHeader('X-Paxos-Status', payload.status.level);
      res.setHeader('X-Paxos-Generated-At', payload.generatedAt);
      if (meta.memo === 'miss' || meta.memo === 'off' || meta.memo === 'hit') log.log(JSON.stringify(buildLog(payload, meta)));
      return res.status(200).json(payload);
    } catch (error) {
      // The detail goes to the server log only (one JSON line, like the build log); the body says what
      // failed, not how.
      log.error(JSON.stringify({ evt: 'paxos.build_failed', error: String(error instanceof Error ? error.message : error).slice(0, 300) }));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        error: 'paxos_health_unavailable',
        message: 'The Paxos health payload could not be built from the upstream data right now.',
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.buildLog = buildLog;
