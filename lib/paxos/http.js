'use strict';

// Upstream HTTP for the Paxos data layer. fetchJson/fetchText never throw:
// every failure comes back as { ok: false, error }. Only a non-empty, non-HTML
// 2xx body counts as success, because upstreams fail softly: DefiLlama answers
// unknown ids with an HTML 404 (/stablecoin/{id}) or a 200 with an EMPTY body
// (/stablecoincharts?stablecoin=), paid endpoints answer 402 text, and bot
// walls (Cloudflare "Just a moment...") answer 403 HTML.

const DEFAULT_TIMEOUT_MS = 8000;
const UA = 'rodiger.io paxos-health (+https://rodiger.io/paxos)';
// Redirects are followed by hand so that every hop is re-checked: it must stay on https and on the
// host of the original request (API keys are attached per hop, each only to its own API host).
// No upstream needs a cross-host redirect, so one is an error, never an invitation to fetch
// whatever URL a listed third-party explorer points at.
const MAX_REDIRECTS = 3;

// Per-host concurrency and start spacing. CoinGecko's keyless tier is shared
// per egress IP and 429s after a handful of rapid calls, so it is serialised
// to 2 in flight with spaced starts (the demo key allows ~100 calls/min).
const cgKey = () => process.env.COINGECKO_DEMO_API_KEY || '';
// Blockscout PRO API (api.blockscout.com): the supported route for scripted access, since the public
// per-chain explorer hosts sit behind bot protection. Free tier: 5 requests/s.
const bsKey = () => process.env.BLOCKSCOUT_API_KEY || '';
const BLOCKSCOUT_PRO = 'api.blockscout.com';
const LIMITS = {
  'api.coingecko.com': () => ({ max: 2, spacingMs: cgKey() ? 650 : 2000 }),
  [BLOCKSCOUT_PRO]: () => ({ max: 4, spacingMs: 220 }),
};
const DEFAULT_LIMIT = () => ({ max: 6, spacingMs: 0 });
const hosts = new Map(); // module scope: shared by concurrent invocations in one instance

// After a 429 a host is left alone until its Retry-After (default a minute),
// and requests already queued for it are released at once. Kept per fetch
// implementation: the global fetch shares it across warm invocations, test
// stubs stay isolated.
const COOL_MS = 60e3;
const cooling = new WeakMap(); // fetch -> Map(host -> until, ms epoch)
const coolUntil = (fetch, host) => (cooling.get(fetch) && cooling.get(fetch).get(host)) || 0;
function coolDown(fetch, host, ms) {
  if (!cooling.has(fetch)) cooling.set(fetch, new Map());
  cooling.get(fetch).set(host, Date.now() + ms);
  const h = hosts.get(host);
  if (h) pump(host, h);
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function limitFor(host) {
  return (LIMITS[host] || DEFAULT_LIMIT)();
}

// Resolves to a release() function, or 'deadline' / 'cooling' when the request
// must not be sent. Waiters are served by priority (lower first), then FIFO.
function acquire(host, { priority = 5, deadline = Infinity, throttle = true, fetch }) {
  let h = hosts.get(host);
  if (!h) hosts.set(host, (h = { active: 0, nextAt: 0, waiting: [], timer: null, seq: 0 }));
  return new Promise((resolve) => {
    const w = { priority, seq: h.seq++, resolve, throttle, fetch, timer: null };
    if (deadline !== Infinity) {
      w.timer = setTimeout(() => {
        const i = h.waiting.indexOf(w);
        if (i >= 0) { h.waiting.splice(i, 1); resolve('deadline'); }
      }, Math.max(0, deadline - Date.now()));
    }
    h.waiting.push(w);
    h.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    pump(host, h);
  });
}

function pump(host, h) {
  const { max, spacingMs } = limitFor(host);
  for (let i = h.waiting.length - 1; i >= 0; i--) {
    const w = h.waiting[i];
    if (coolUntil(w.fetch, host) > Date.now()) {
      h.waiting.splice(i, 1);
      if (w.timer) clearTimeout(w.timer);
      w.resolve('cooling');
    }
  }
  while (h.waiting.length && h.active < max) {
    const w = h.waiting[0];
    const wait = w.throttle ? h.nextAt - Date.now() : 0;
    if (wait > 0) {
      if (!h.timer) {
        // Not unref'd: a queued request is pending work, and a process (or a runtime that waits on the
        // event loop) with nothing else scheduled must not exit before it is served.
        h.timer = setTimeout(() => { h.timer = null; pump(host, h); }, wait);
      }
      return;
    }
    h.waiting.shift();
    if (w.timer) clearTimeout(w.timer);
    h.active++;
    const prevNext = h.nextAt;
    if (w.throttle) h.nextAt = Date.now() + spacingMs;
    let released = false;
    // release(true) = the slot was not used for a request: give its spacing back.
    w.resolve((unused) => {
      if (released) return;
      released = true;
      h.active--;
      if (unused && w.throttle) h.nextAt = prevNext;
      pump(host, h);
    });
  }
}

const parseDate = (s) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : null;
};
const snippet = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const looksHtml = (text, type) => /text\/html/i.test(type || '') || /^\s*<(!doctype|html|head|body)\b/i.test(text);

async function request({ url, fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', body, priority, deadline = Infinity, throttle, json }) {
  const host = hostOf(url);
  const out = { ok: false, status: 0, data: null, bytes: 0, latencyMs: 0, fetchedAt: Date.now(), lastModified: null, expires: null, date: null, error: null };
  if (!host || !/^https:\/\//.test(url)) return { ...out, error: 'invalid url' };
  if (typeof fetch !== 'function') return { ...out, error: 'no fetch' };
  const cooled = { ...out, error: 'skipped: rate limited (429) earlier' };
  if (coolUntil(fetch, host) > Date.now()) return cooled;
  const release = await acquire(host, { priority, deadline, fetch, throttle: throttle !== undefined ? throttle : !fetch.noThrottle });
  if (release === 'cooling') return { ...cooled, fetchedAt: Date.now() };
  if (release === 'deadline') return { ...out, fetchedAt: Date.now(), error: 'skipped: time budget exhausted while queued' };
  const budget = Math.min(timeoutMs, deadline - Date.now());
  if (!(budget > 0)) { release(true); return { ...out, fetchedAt: Date.now(), error: 'skipped: time budget exhausted' }; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budget);
  // Race against the abort too, so a fetch implementation that ignores the
  // signal still cannot hang the caller past its timeout.
  const aborted = new Promise((_, reject) => ctrl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  aborted.catch(() => {});
  const t0 = Date.now();
  out.fetchedAt = t0;
  try {
    let res = null;
    let hop = url;
    for (let n = 0; ; n++) {
      const h = { 'user-agent': UA, accept: json ? 'application/json' : '*/*', ...headers };
      if (hostOf(hop) === 'api.coingecko.com' && cgKey()) h['x-cg-demo-api-key'] = cgKey();
      if (hostOf(hop) === BLOCKSCOUT_PRO && bsKey()) h.authorization = 'Bearer ' + bsKey();
      if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
      res = await Promise.race([fetch(hop, { method, headers: h, body, signal: ctrl.signal, redirect: 'manual' }), aborted]);
      if (!(res.status >= 300 && res.status < 400)) break;
      const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
      let next = null;
      try { next = loc ? new URL(loc, hop) : null; } catch { next = null; }
      out.status = res.status;
      if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
      const refuse = (why) => ({ ...out, latencyMs: Date.now() - t0, error: `HTTP ${res.status} ${why}` });
      if (!next) return refuse('redirect without a usable location');
      if (next.protocol !== 'https:' || next.host !== host) return refuse(`redirect to ${next.protocol}//${next.host} refused (only same-host https redirects are followed)`);
      if (n + 1 >= MAX_REDIRECTS) return refuse(`more than ${MAX_REDIRECTS} redirects`);
      hop = next.href;
    }
    out.status = res.status;
    const hdr = (k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null);
    out.lastModified = parseDate(hdr('last-modified'));
    out.expires = parseDate(hdr('expires'));
    out.date = parseDate(hdr('date')); // server clock: when the response was produced
    const retryAfter = hdr('retry-after');
    const type = hdr('content-type') || '';
    const text = String(await Promise.race([res.text(), aborted]));
    out.bytes = Buffer.byteLength(text);
    out.latencyMs = Date.now() - t0;
    if (res.status < 200 || res.status > 299) {
      out.error = `HTTP ${res.status}${looksHtml(text, type) || !text ? '' : ': ' + snippet(text)}`;
      if (res.status === 429) {
        out.retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : null;
        coolDown(fetch, host, out.retryAfterMs || COOL_MS);
      }
      return out;
    }
    if (!text.trim()) return { ...out, error: 'empty body' };
    if (looksHtml(text, type) || (json && /^\s*</.test(text))) return { ...out, error: 'html body' };
    if (!json) return { ...out, ok: true, data: text };
    try {
      out.data = JSON.parse(text);
    } catch {
      return { ...out, error: 'invalid json' };
    }
    out.ok = true;
    return out;
  } catch (e) {
    out.latencyMs = Date.now() - t0;
    out.error = ctrl.signal.aborted ? `timeout after ${budget} ms` : `network: ${snippet(e && e.message) || 'error'}`;
    return out;
  } finally {
    clearTimeout(timer);
    release();
  }
}

const fetchJson = (opts) => request({ ...opts, json: true });
const fetchText = (opts) => request({ ...opts, json: false });

// Which optional keys are configured (never their values), so callers can pick a keyed route.
const keys = { blockscout: () => Boolean(bsKey()), coingecko: () => Boolean(cgKey()) };

module.exports = { fetchJson, fetchText, hostOf, keys, BLOCKSCOUT_PRO, DEFAULT_TIMEOUT_MS };
