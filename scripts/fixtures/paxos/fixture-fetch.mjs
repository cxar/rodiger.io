// Fetch-compatible replay of recorded upstream responses (scripts/record-paxos-fixtures.mjs).
// Unknown URLs answer 404. The returned function carries noThrottle (http.js then skips
// per-host start spacing), now (the recording's unix time, which the request URLs depend
// on) and fixture (the parsed file).
import fs from 'node:fs';
import zlib from 'node:zlib';

export const DEFAULT_FIXTURE = new URL('./upstream.json.gz', import.meta.url).pathname;

export function loadFixture(path = DEFAULT_FIXTURE) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path)).toString('utf8'));
}

export const requestKey = (url, init = {}) => {
  const method = (init.method || 'GET').toUpperCase();
  return method === 'GET' ? String(url) : `${method} ${url} ${init.body || ''}`;
};

export function createFixtureFetch(pathOrFixture = DEFAULT_FIXTURE, { override } = {}) {
  const fx = typeof pathOrFixture === 'string' ? loadFixture(pathOrFixture) : pathOrFixture;
  const f = async (url, init = {}) => {
    if (override) {
      const r = await override(String(url), init);
      if (r) return r;
    }
    const rec = fx.responses[requestKey(url, init)];
    if (!rec) return new Response('not recorded', { status: 404, headers: { 'content-type': 'text/plain' } });
    const headers = Object.fromEntries(Object.entries(rec.headers || {}).filter(([, v]) => v != null));
    return new Response(rec.body, { status: rec.status, headers });
  };
  f.noThrottle = true;
  f.now = fx.now;
  f.fixture = fx;
  return f;
}
