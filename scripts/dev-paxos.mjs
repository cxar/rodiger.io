#!/usr/bin/env node
// Local preview of /paxos without the Rust/Google build: serves pages/ and static/ the way dist/ lays
// them out and mounts api/paxos.js (live upstreams) at /api/paxos with Vercel-style res helpers.
// The redirects and headers in vercel.json are applied as Vercel would (host-conditioned redirects,
// the CSP and other security headers), so a routing or CSP problem shows up locally too. Only the
// paxos routes are served: "/" is the Google Doc site root in production, so here it is 404 unless the
// Host header triggers vercel.json's paxos.rodiger.io redirect
// (curl -H 'Host: paxos.rodiger.io' http://127.0.0.1:8790/).
// Listens on 127.0.0.1 (set HOST=0.0.0.0 to expose it on the network; every cold build spends upstream
// requests, including CoinGecko calls on COINGECKO_DEMO_API_KEY when it is set).
// Usage: node scripts/dev-paxos.mjs [port]   then open http://127.0.0.1:<port>/paxos
// Page work without the live build: PAXOS_DEV_PAYLOAD=<file.json> serves that payload at /api/paxos
// (re-read on every request, so a regenerated file shows on reload), PAXOS_DEV_PAYLOAD=error:<status>
// answers with that HTTP status, PAXOS_DEV_DELAY_MS=<ms> delays every API answer (slow cold builds), and
// PAXOS_DEV_RESTAMP=1 sets the served payload's generatedAt to now.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const handler = require(path.join(ROOT, 'api/paxos.js'));
const PORT = Number(process.argv[2] || process.env.PORT || 8790);
const HOST = process.env.HOST || '127.0.0.1';
const DEV_PAYLOAD = process.env.PAXOS_DEV_PAYLOAD || '';
const DEV_DELAY_MS = Number(process.env.PAXOS_DEV_DELAY_MS || 0);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.json': 'application/json' };

// vercel.json sources as used here: literal paths with optional "(.*)" wildcards.
const toRegExp = (source) => new RegExp('^' + source.split('(.*)').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*)') + '$');
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const hostOf = (req) => String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
const hasMatch = (has, req) => (has || []).every((c) => c.type === 'host' && hostOf(req) === String(c.value).toLowerCase());
const redirects = (vercel.redirects || []).map((r) => ({ ...r, re: toRegExp(r.source) }));
const headerRules = (vercel.headers || []).map((r) => ({ ...r, re: toRegExp(r.source) }));

function serveFile(res, base, rel) {
  const p = path.join(base, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!p.startsWith(base)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  for (const r of headerRules) if (r.re.test(pathname)) for (const h of r.headers) res.setHeader(h.key, h.value);
  const redirect = redirects.find((r) => r.re.test(pathname) && hasMatch(r.has, req));
  if (redirect) {
    res.writeHead(redirect.permanent ? 308 : 307, { location: redirect.destination });
    return res.end();
  }
  if (pathname === '/api/paxos' && DEV_DELAY_MS > 0) await new Promise((r) => setTimeout(r, DEV_DELAY_MS));
  if (pathname === '/api/paxos' && DEV_PAYLOAD) {
    const m = /^error:(\d{3})$/.exec(DEV_PAYLOAD);
    if (m) {
      res.writeHead(+m[1], { 'content-type': 'text/plain' });
      return res.end('dev: simulated failure');
    }
    return fs.readFile(path.resolve(DEV_PAYLOAD), (err, buf) => {
      if (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('dev: cannot read PAXOS_DEV_PAYLOAD');
      }
      let body = buf;
      if (process.env.PAXOS_DEV_RESTAMP === '1') { // pretend the file was just built (current-snapshot states)
        const p = JSON.parse(buf);
        p.generatedAt = new Date().toISOString();
        body = JSON.stringify(p);
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(body);
    });
  }
  if (pathname === '/api/paxos') {
    // Like Vercel's CDN: s-maxage, stale-while-revalidate and stale-if-error are for the CDN and are stripped from what
    // the browser gets (otherwise the browser's own cache would serve stale copies under SWR). The
    // CDN policy stays visible in x-dev-cdn-cache-control.
    const setHeader = res.setHeader.bind(res);
    res.setHeader = (k, val) => {
      if (String(k).toLowerCase() !== 'cache-control' || !/s-maxage/.test(val)) return setHeader(k, val);
      setHeader('x-dev-cdn-cache-control', val);
      return setHeader(k, String(val).split(',').map((d) => d.trim()).filter((d) => !/^(s-maxage|stale-while-revalidate|stale-if-error)=/.test(d)).join(', ') || 'public');
    };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(b)); return res; };
    const t0 = Date.now();
    await handler(req, res);
    console.log(`${req.method} ${req.url} -> ${res.statusCode} in ${Date.now() - t0} ms (${res.getHeader('server-timing') || ''})`);
    return;
  }
  if (pathname === '/paxos' || pathname === '/paxos/') return serveFile(res, path.join(ROOT, 'pages'), 'paxos/index.html');
  if (pathname.startsWith('/paxos/')) return serveFile(res, path.join(ROOT, 'pages'), pathname.slice(1));
  if (pathname.startsWith('/static/')) return serveFile(res, path.join(ROOT, 'static'), pathname.slice('/static/'.length));
  res.writeHead(404);
  res.end('not found (this preview serves /paxos, /paxos/*, /static/* and /api/paxos)');
}).listen(PORT, HOST, () => console.log(`Paxos dashboard: http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}/paxos`));
