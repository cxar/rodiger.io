#!/usr/bin/env node
// Synthetic monitor and CDN warmer for /api/paxos (FINAL-SPEC H8; .github/workflows/paxos-monitor.yml runs
// it after each production deployment, once a day and on demand). No dependencies, no secrets.
//   node scripts/monitor-paxos.mjs [baseUrl]          (default https://www.rodiger.io)
// Env:
//   DEPLOYED_AT  ISO time of the deployment being verified: poll every 10 s, for up to 120 s, until the
//                API serves a payload generated after it (this also warms the new deployment's CDN cache).
//   STATE_FILE   JSON file carrying the previous run's status level (the workflow restores and saves it),
//                so a payload degraded on two consecutive runs fails while a single degraded run warns.
//   GITHUB_STEP_SUMMARY  when set (GitHub Actions), a summary table is appended to it.
// Exit 1 (a failed workflow run) when: the response is not 200 or not JSON; schemaVersion !== 1; the
// payload is older than cache.sMaxAge + 1 h (on a second request PAXOS_MONITOR_RETRY_MS, default 45 s, after
// the first: a stale-while-revalidate copy gets its chance to refresh); a supply or market source is in error; totals.allUsd.missing
// is not empty; status.level is 'degraded' on this and the previous run; or, with DEPLOYED_AT, no payload
// newer than the deployment arrives within 120 s. Warnings (annotations): any stale or erroring source,
// insights.errors, briefing.errors, a payload over 650 KB, a Server-Timing total over 30 s, an
// X-Paxos-Status header that disagrees with the body, and a single degraded run.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const BASE = (process.argv[2] || process.env.PAXOS_BASE_URL || 'https://www.rodiger.io').replace(/\/+$/, '');
const API = `${BASE}/api/paxos`;
const DEPLOYED_AT = process.env.DEPLOYED_AT ? Date.parse(process.env.DEPLOYED_AT) : NaN;
const STATE_FILE = process.env.STATE_FILE || '';
const POLL_MS = Number(process.env.PAXOS_MONITOR_POLL_MS || 10e3);
const WAIT_MS = Number(process.env.PAXOS_MONITOR_WAIT_MS || 120e3);
// A copy past its budget may be the CDN's stale-while-revalidate answer whose background rebuild this very
// request started: one more GET after this wait decides.
const RETRY_MS = Number(process.env.PAXOS_MONITOR_RETRY_MS || 45e3);
const TIMEOUT_MS = 60e3;
const GH = !!process.env.GITHUB_ACTIONS;
const failures = [], warnings = [];
// Workflow-command data is escaped as @actions/core does (%, CR, LF), so payload text such as a source
// message can never start a command of its own.
const ghData = (m) => String(m).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const fail = (m) => { failures.push(m); console.log(GH ? `::error title=Paxos monitor::${ghData(m)}` : `FAIL ${m}`); };
const warn = (m) => { warnings.push(m); console.log(GH ? `::warning title=Paxos monitor::${ghData(m)}` : `warn ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One GET with the headers a browser sends (the CDN keys its cache on them), decoded by hand so every
// encoding the CDN may choose (zstd included) is read the same way.
function get(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const t0 = Date.now();
    const req = lib.get(url, { headers: { accept: '*/*', 'accept-encoding': 'gzip, deflate, br, zstd', 'user-agent': 'paxos-monitor (+https://github.com)' }, timeout: TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').trim().toLowerCase();
        try {
          if (enc === 'gzip') body = zlib.gunzipSync(body);
          else if (enc === 'deflate') body = zlib.inflateSync(body);
          else if (enc === 'br') body = zlib.brotliDecompressSync(body);
          else if (enc === 'zstd') {
            if (typeof zlib.zstdDecompressSync !== 'function') return resolve({ error: `zstd response but this Node (${process.version}) has no zstd decoder` });
            body = zlib.zstdDecompressSync(body);
          } else if (enc && enc !== 'identity') return resolve({ error: `unknown content-encoding ${enc}` });
        } catch (e) {
          return resolve({ error: `could not decode ${enc} body: ${e.message}` });
        }
        resolve({ status: res.statusCode, headers: res.headers, text: body.toString('utf8'), ms: Date.now() - t0 });
      });
      res.on('error', (e) => resolve({ error: e.message }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${TIMEOUT_MS / 1000} s`)));
    req.on('error', (e) => resolve({ error: e.message }));
  });
}
const parse = (r) => { try { return JSON.parse(r.text); } catch { return null; } };

let r = await get(API), p = r.error ? null : parse(r);
if (Number.isFinite(DEPLOYED_AT)) {
  const until = Date.now() + WAIT_MS;
  while (!(p && Date.parse(p.generatedAt) > DEPLOYED_AT) && Date.now() < until) {
    await sleep(POLL_MS);
    r = await get(API);
    p = r.error ? null : parse(r);
  }
  if (p && !(Date.parse(p.generatedAt) > DEPLOYED_AT)) fail(`still serving a payload generated ${p.generatedAt}, before the deployment (${process.env.DEPLOYED_AT}), after ${WAIT_MS / 1000} s`);
}

// Too old on the first look: ask once more after the CDN has had time to revalidate.
const ageOf = (x) => (x && Number.isFinite(Date.parse(x.generatedAt)) ? (Date.now() - Date.parse(x.generatedAt)) / 1000 : NaN);
const budgetOf = (x) => (x && x.cache && Number.isFinite(x.cache.sMaxAge) ? x.cache.sMaxAge : 1800) + 3600;
if (p && r.status === 200 && ageOf(p) > budgetOf(p)) {
  console.log(`payload ${Math.round(ageOf(p) / 60)} min old (x-vercel-cache ${(r.headers && r.headers['x-vercel-cache']) || 'n/a'}); asking again in ${RETRY_MS / 1000} s`);
  await sleep(RETRY_MS);
  const r2 = await get(API), p2 = r2.error ? null : parse(r2);
  if (r2.status === 200 && p2 && typeof p2 === 'object') { r = r2; p = p2; }
}

const rows = [['API', API]];
if (r.error) fail(`GET ${API}: ${r.error}`);
else if (r.status !== 200) fail(`GET ${API}: HTTP ${r.status}`);
else if (!p || typeof p !== 'object') fail(`GET ${API}: the body is not JSON (${(r.text || '').slice(0, 80).replace(/\s+/g, ' ')})`);
else if (p.schemaVersion !== 1) fail(`schemaVersion ${JSON.stringify(p.schemaVersion)}, expected 1`);
let level = null;
if (!failures.length) {
  const now = Date.now(), gen = Date.parse(p.generatedAt), sMaxAge = p.cache && Number.isFinite(p.cache.sMaxAge) ? p.cache.sMaxAge : 1800;
  const age = (now - gen) / 1000;
  if (!Number.isFinite(gen)) fail(`generatedAt is not a time (${p.generatedAt})`);
  else if (age > sMaxAge + 3600) fail(`payload is ${Math.round(age / 60)} min old (budget ${Math.round(sMaxAge / 60)} min + 60 min), also after a second request ${RETRY_MS / 1000} s later: revalidation keeps failing`);
  const sources = Array.isArray(p.sources) ? p.sources : [];
  for (const s of sources) {
    const where = `${s.label || s.id} (${s.id}, ${s.kind})`;
    if ((s.kind === 'supply' || s.kind === 'market') && s.status === 'error') fail(`core source ${where} is in error${s.message ? `: ${s.message}` : ''}`);
    else if (s.status === 'stale' || s.status === 'error') warn(`source ${where} is ${s.status}${s.message ? `: ${s.message}` : ''}`);
  }
  const missing = (p.totals && p.totals.allUsd && p.totals.allUsd.missing) || [];
  if (missing.length) fail(`assets without a USD value: ${missing.join(', ')}`);
  const ins = p.insights || {};
  if (!p.insights) warn('insights section is null');
  else if ((ins.errors || []).length) warn(`insights.errors: ${ins.errors.map((e) => `${e.detector}: ${e.error}`).join('; ').slice(0, 300)}`);
  if (p.briefing && (p.briefing.errors || []).length) warn(`briefing.errors: ${p.briefing.errors.map((e) => `${e.builder}${e.frame ? '/' + e.frame : ''}${e.asset ? '/' + e.asset : ''}: ${e.error}`).join('; ').slice(0, 300)}`);
  const bytes = Buffer.byteLength(r.text);
  if (bytes > 650 * 1024) warn(`payload is ${Math.round(bytes / 1024)} KB (warn above 650 KB, the check fails at 700 KB)`);
  const st = /(?:^|,)\s*total;dur=([\d.]+)/.exec(String(r.headers['server-timing'] || ''));
  if (st && Number(st[1]) > 30e3) warn(`build took ${(Number(st[1]) / 1000).toFixed(1)} s (Server-Timing; maxDuration is 60 s)`);
  level = p.status && p.status.level ? p.status.level : null;
  const hdr = r.headers['x-paxos-status'];
  if (level && hdr && hdr !== level) warn(`X-Paxos-Status header "${hdr}" disagrees with status.level "${level}"`);
  let prev = null;
  if (STATE_FILE) try { prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).level || null; } catch { prev = null; }
  if (level === 'degraded') {
    const why = (p.status.reasons || []).map((x) => `${x.kind} ${x.id}${x.status ? ' ' + x.status : ''}`).join(', ');
    if (prev === 'degraded') fail(`status degraded on two consecutive runs (${why})`);
    else warn(`status degraded (${why}); fails if the next run is degraded too`);
  }
  const counts = sources.reduce((acc, s) => ((acc[s.status] = (acc[s.status] || 0) + 1), acc), {});
  rows.push(
    ['generatedAt', `${p.generatedAt} (${Math.round(age / 60)} min old)`],
    ['status', `${level || 'n/a'}${hdr ? ` (header ${hdr})` : ''}`],
    ['cache', `sMaxAge ${sMaxAge} s; ${r.headers['cache-control'] || 'no Cache-Control'}`],
    ['x-vercel-cache', r.headers['x-vercel-cache'] || 'n/a'],
    ['X-Paxos-Memo', r.headers['x-paxos-memo'] || 'n/a'],
    ['sources', Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')],
    ['feed', `${(ins.feed || []).length} clusters, ${ins.testsRun || 0} checks`],
    ['verdict', (p.briefing && p.briefing.verdict && p.briefing.verdict.text) || 'n/a'],
    ['build', st ? `${(Number(st[1]) / 1000).toFixed(1)} s` : 'n/a'],
    ['payload', `${Math.round(bytes / 1024)} KB, ${r.headers['content-encoding'] || 'identity'}; fetched in ${r.ms} ms`],
  );
}
if (STATE_FILE) {
  try {
    fs.mkdirSync(STATE_FILE.replace(/\/[^/]*$/, '') || '.', { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ level, at: new Date().toISOString(), failures: failures.length }));
  } catch (e) {
    warn(`could not write ${STATE_FILE}: ${e.message}`);
  }
}
const verdict = failures.length ? `FAIL (${failures.length})` : warnings.length ? `OK with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : 'OK';
if (process.env.GITHUB_STEP_SUMMARY) {
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const md = [`### Paxos monitor: ${verdict}`, '', '| | |', '|---|---|', ...rows.map(([k, v]) => `| ${esc(k)} | ${esc(v)} |`), '',
    ...failures.map((m) => `- **Fail:** ${esc(m)}`), ...warnings.map((m) => `- Warning: ${esc(m)}`), ''].join('\n');
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md); } catch {}
}
console.log(`paxos monitor ${API}: ${verdict}`);
for (const [k, v] of rows.slice(1)) console.log(`  ${k}: ${v}`);
process.exit(failures.length ? 1 : 0);
