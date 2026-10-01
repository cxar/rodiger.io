'use strict';

const { buildPaxosHealth } = require('../lib/paxos');

// GET|HEAD /api/paxos: the Paxos health payload (schemaVersion 1, docs/paxos-dashboard.md).
// Request input never reaches an upstream request: the handler reads only the method. Query strings are
// ignored; cache-busting URLs cannot force upstream fan-out because the module-scope memo
// (lib/paxos/index.js, REUSE_MS) bounds rebuilds per instance. (No redirect to a canonical URL: if the
// platform ever appended a parameter to req.url, a self-redirect would take the API down.)
// createHandler({ build }) exists for offline checks (fixture-backed build); production uses the default.
const METHODS = 'GET, HEAD, OPTIONS';

function serverTiming(meta) {
  const t = meta.timingsMs || {};
  const stages = ['fetch', 'model', 'engine', 'payload', 'total'].filter((k) => Number.isFinite(t[k])).map((k) => `${k};dur=${t[k]}`);
  return [`memo;desc="${meta.memo}"`, ...stages].join(', ');
}

function createHandler({ build = buildPaxosHealth, log = console } = {}) {
  return async function handler(req, res) {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', METHODS);
      return res.status(204).end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', METHODS);
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    try {
      const { payload, meta } = await build({ log: (msg, e) => (e ? log.warn(msg, e.message || e) : log.log(msg)) });
      const t = meta.timingsMs || {};
      // The CDN may keep the payload only for what is left of its freshness budget: a reused payload
      // generated N s ago gets s-maxage = sMaxAge - N, so no viewer gets it past generatedAt + sMaxAge
      // as fresh (stale-while-revalidate then serves it while the CDN refetches).
      const sMaxAge = Math.max(0, payload.cache.sMaxAge - Math.floor((meta.ageMs || 0) / 1000));
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', `public, s-maxage=${sMaxAge}, stale-while-revalidate=${payload.cache.staleWhileRevalidate}`);
      res.setHeader('Server-Timing', serverTiming(meta));
      res.setHeader('X-Paxos-Memo', meta.memo);
      if (meta.memo === 'miss' || meta.memo === 'off') {
        const st = payload.sources.reduce((acc, s) => ((acc[s.status] = (acc[s.status] || 0) + 1), acc), {});
        log.log(`[paxos] built in ${t.total} ms (fetch ${t.fetch}, model ${t.model}, engine ${t.engine}); sources ${JSON.stringify(st)}; ${payload.insights.testsRun} tests, ${payload.insights.feed.length} feed, ${payload.insights.errors.length} errors`);
      }
      return res.status(200).json(payload);
    } catch (error) {
      // The detail goes to the server log only; the body says what failed, not how.
      log.error('[paxos] build failed', error instanceof Error ? error.message : error);
      res.setHeader('Access-Control-Allow-Origin', '*');
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
