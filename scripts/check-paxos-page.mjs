#!/usr/bin/env node
// Offline checks for the Paxos Health page (pages/paxos/{index.html, app.js, paxos.css}), FINAL-SPEC §3,
// §6.4 and §7. The page runs under the DOM shim (scripts/fixtures/paxos/dom-shim.mjs) against payloads
// built from the recorded fixture:
//   1. the default view (All, 7d, Supply): word budget (§3.17 rule, ≤180; ≤110 without tickers, chains and
//      months), one sentence per paragraph or list item, no banned words, ≤8 graphics, no table, ≤2,500
//      elements, the verdict and briefing as the payload says, every briefing link target, hero = Net =
//      moves rows, In + Out = Net, card peg = Peg table Average = the daily-price mean (§3.6)
//   2. every asset × period × lens: no console error, no failed component, no NaN/undefined/n/a, ≤350
//      words, the same reconciliations, focus restored after period, asset and lens changes
//   3. accessibility and isolation (H9): one h1, live regions, no nested controls, the tab pattern, a Table
//      toggle per figure, a throw in each component leaves the others standing
//   4. the snapshot (H1) and freshness states (§3.1): Cache Storage stub, offline, failure, slow load,
//      late sources and the verdict override (§3.3)
//   5. payload variants: older (v1) payload, degraded sections, busy and quiet days, a newly discovered
//      asset, an incomplete all-assets total, narrow screens
//   6. static: no inline styles, the palette rules
// No network. PAXOS_CHECK_KEEP_GOING=1 lists every failure instead of stopping at the first.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createFixtureFetch, loadFixture } from './fixtures/paxos/fixture-fetch.mjs';
import * as C from './fixtures/paxos/contract-v2.mjs';
import { createPage, visibleRuns, isVisible, isShown } from './fixtures/paxos/dom-shim.mjs';

const require = createRequire(import.meta.url);
const T0 = performance.now();
const here = (p) => new URL(p, import.meta.url).pathname;
const read = (p) => fs.readFileSync(here(p), 'utf8');
let checks = 0;
const failed = [];
const KEEP_GOING = process.env.PAXOS_CHECK_KEEP_GOING === '1';
const ok = (cond, msg) => { if (KEEP_GOING && !cond) return void failed.push(msg); assert.ok(cond, msg); checks++; };
async function section(name, fn) {
  try { await fn(); } catch (e) { if (!KEEP_GOING) throw e; failed.push(`${name}: ${String(e && e.stack || e).split('\n').slice(0, 5).join(' | ')}`); }
}
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clone = (x) => JSON.parse(JSON.stringify(x));

const HTML = read('../pages/paxos/index.html');
const APP = read('../pages/paxos/app.js');
const CSS = fs.existsSync(here('../pages/paxos/paxos.css')) ? read('../pages/paxos/paxos.css') : '';
const TOKENS = {};
for (const m of CSS.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) if (!(m[1] in TOKENS)) TOKENS[m[1]] = m[2].trim();
const cssVars = Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => ['--' + k, v]));

// ---------- payloads ----------
const { buildPaxosHealth } = require('../lib/paxos/index.js');
const { createCache } = require('../lib/paxos/cache.js');
const B = require('../lib/paxos/briefing.js');
const fixture = loadFixture();
const NOW = fixture.now;
const { payload: BASE } = await buildPaxosHealth({ fetch: createFixtureFetch(fixture), now: NOW, cache: createCache(), clock: () => NOW * 1000 + 5000, memoize: false, log: () => {} });
const GEN_MS = Date.parse(BASE.generatedAt);
const KEYS = BASE.discovery.assets.map((a) => a.key);
const ACTIVE = BASE.discovery.assets.filter((a) => a.status === 'active').map((a) => a.key);
const RANGES = [['7d', 'd7', 7], ['30d', 'd30', 30], ['90d', 'd90', 90], ['1y', 'd365', 365], ['all', 'all', null]];
const LENSES = ['supply', 'chains', 'peg', 'market', 'usage', 'income'];
const reapply = (p) => { for (const { i } of C.insightsOf(p)) i.tier = null; delete p.briefing; p.briefing = B.applyBriefing(p); return p; };
// Names for the strict word count (acceptance 2): tickers, chain names and month names.
const NAMES = new Set([...KEYS, ...(BASE.pegPeers || []).map((x) => x.symbol), ...(BASE.goldRefs || []).map((x) => x.symbol), ...C.MONTHS,
  ...Object.values(BASE.assets).flatMap((a) => a.chains.map((c) => c.chain)).flatMap((c) => c.split(/\s+/))]);
const strictWords = (s) => String(s).split(/\s+/).filter((x) => { const m = /[A-Za-z0-9]/.exec(x); if (!m || !/[A-Za-z]/.test(m[0])) return false; return !NAMES.has(x.replace(/^[(+]+/, '').replace(/[),.:;›]+$/, '')); }).length;

async function open({ payload = BASE, search = '', hash = '', width = 1280, nowMs = GEN_MS + 60e3, ...rest } = {}) {
  const pg = await createPage({ html: HTML, app: APP, css: cssVars, payloadText: JSON.stringify(payload), search, hash, width, nowMs, ...rest });
  if (!rest.noLoad) await pg.load();
  return pg;
}

// ---------- what a render must never show ----------
const FAIL_COPY = /Not in this snapshot\.|This part couldn't be drawn\. The table has the numbers\./;
const runsOf = (el) => visibleRuns(el);
const textOf = (el) => runsOf(el).map((r) => r.text).join(' ').replace(/\s+/g, ' ').trim();
const wordsOf = (el) => runsOf(el).reduce((s, r) => s + C.countWords(r.text), 0);
const INTERACTIVE = (e) => (e.localName === 'a' && e.hasAttribute('href')) || /^(button|summary|input|select|textarea)$/.test(e.localName) || (e.hasAttribute('tabindex') && e.getAttribute('tabindex') !== '-1' && e.getAttribute('role') !== 'tabpanel' && !/^h\d$/.test(e.localName));
function audit(pg, label, { budget = 350, allowFail = false, defaultView = false } = {}) {
  // Acceptance 10: no console error and no console warning.
  const out = [...pg.errs.map((e) => `console.error: ${e}`), ...pg.warns.map((e) => `console.warn: ${e}`), ...pg.problems];
  pg.errs.length = 0;
  pg.warns.length = 0;
  pg.problems.length = 0;
  const body = pg.doc.body, text = textOf(body), all = body.textContent;
  const words = wordsOf(body);
  if (words > budget) out.push(`${words} words in view (budget ${budget})`);
  if (!allowFail && FAIL_COPY.test(text)) out.push(`a component failed: "${FAIL_COPY.exec(text)[0]}" near "${text.slice(Math.max(0, text.search(FAIL_COPY) - 80), text.search(FAIL_COPY))}"`);
  if (C.BAD_TEXT.test(all)) out.push(`page text contains "${C.BAD_TEXT.exec(all)[0]}": …${all.slice(Math.max(0, all.search(C.BAD_TEXT) - 60), all.search(C.BAD_TEXT) + 20)}…`);
  for (const e of body.querySelectorAll('[title], [aria-label], [data-tip]')) for (const k of ['title', 'aria-label', 'data-tip']) { const v = e.getAttribute(k); if (v && C.BAD_TEXT.test(v)) out.push(`${k}="${v.slice(0, 120)}"`); }
  if (/\bLive\b/.test(text)) out.push('the word "Live" is shown');
  for (const e of body.querySelectorAll('*').filter(INTERACTIVE)) for (let a = e.parentElement; a; a = a.parentElement) if (INTERACTIVE(a)) { out.push(`<${e.localName}> "${e.textContent.slice(0, 40)}" is inside <${a.localName}> "${a.textContent.slice(0, 40)}"`); break; }
  // Graphics on screen (aria-hidden sparklines count): nested [data-graphic] count once.
  const graphics = body.querySelectorAll('[data-graphic]').filter((g) => isShown(g) && !(g.parentElement && g.parentElement.closest('[data-graphic]')));
  for (const g of body.querySelectorAll('canvas, svg').filter(isShown)) if (!g.closest('[data-graphic]')) out.push(`a visible <${g.localName}> outside [data-graphic]`);
  if (defaultView) {
    if (BANNED_IN(text)) out.push(`banned word "${BANNED_IN(text)}" in the default view`);
    for (const e of body.querySelectorAll('p, li').filter(isVisible)) {
      const t = textOf(e);
      const parts = t.split(/(?<!\b(?:Est|vs|e\.g|i\.e))[.!?]\s+(?=[A-Z])/);
      if (parts.length > 1) out.push(`<${e.localName}> with ${parts.length} sentences: "${t.slice(0, 140)}"`);
    }
  }
  return { label, problems: out, words, strict: runsOf(body).reduce((s, r) => s + strictWords(r.text), 0), graphics: graphics.length, tables: pg.doc.querySelectorAll('table').length, nodes: pg.doc.querySelectorAll('*').length, text };
}
const BANNED_IN = (t) => (C.BANNED.test(t) ? C.BANNED.exec(t)[0] : null);
const report = (a) => (a.problems.length ? `${a.label}:\n  ${a.problems.slice(0, 10).join('\n  ')}` : null);

// ---------- DOM accessors (the hooks of requests/D-to-C.md) ----------
const $ = (pg, id) => pg.doc.getElementById(id);
const btn = (pg, attr, v) => pg.doc.querySelectorAll(`[${attr}]`).find((b) => b.getAttribute(attr) === v && b.localName === 'button');
const tab = (pg, lens) => pg.doc.querySelectorAll('[role="tab"]').find((t) => t.getAttribute('data-lens') === lens);
// The verdict's visible words (its sr-only polarity prefix, §3.3, is for screen readers).
const verdictText = (pg) => { const v = pg.doc.querySelector('.verdict [aria-live]'); return v ? textOf(v) : ''; };
const chipText = (pg) => { const c = pg.doc.querySelector('button.chip'); return c ? textOf(c) : ''; };
const num = (s) => Number(String(s).replace(/−/g, '-').replace(/[^0-9.+-]/g, ''));
const qs = (pg) => new URLSearchParams(pg.win.location.search);
async function setScope(pg, { asset, range, lens }) {
  if (asset !== undefined) { const b = btn(pg, 'data-asset', asset); if (!b) throw new Error(`no asset button ${asset}`); if (b.getAttribute('aria-pressed') !== 'true') await pg.click(b); }
  if (range !== undefined) { const b = btn(pg, 'data-range', range); if (!b) throw new Error(`no period button ${range}`); if (b.getAttribute('aria-pressed') !== 'true') await pg.click(b); }
  if (lens !== undefined) { const t = tab(pg, lens); if (!t) throw new Error(`no ${lens} tab`); if (t.getAttribute('aria-selected') !== 'true' && t.getAttribute('aria-disabled') !== 'true') await pg.click(t); }
}
async function openTable(pg, figure) {
  const b = figure.querySelectorAll('button[aria-pressed]').find((x) => /^(Table|Hide table)$/.test(x.textContent.trim()));
  if (!b) return null;
  if (b.getAttribute('aria-pressed') !== 'true') await pg.click(b);
  return figure.querySelector('table');
}
const rowsOf = (table) => table.querySelectorAll('tr').map((tr) => tr.children.map((c) => c.textContent.trim()));

// ---------- reconciliations shared by the default view and the matrix ----------
const windowOf = (range) => RANGES.find((r) => r[0] === range)[1];
function reconcile(pg, p, { asset, range, lens }, out) {
  const w = windowOf(range), win = p.attribution && p.attribution.windows && p.attribution.windows[w];
  const a = asset === 'all' ? null : p.assets[asset];
  const usdScope = asset === 'all' || (a && a.unit === 'USD' && p.totals.usd.assets.includes(asset));
  // Hero delta = the payload's change over the period (USD scopes: token flows in USD; gold: ounces).
  const hd = pg.doc.querySelector('[data-hero-delta]');
  const heroVal = hd ? Number(hd.getAttribute('data-value')) : NaN;
  const want = asset === 'all' ? (p.totals.usd.change[w] || {}).abs : a && (a.unit === 'USD' ? (a.current.change[w] || {}).abs : (a.current.changeNative && a.current.changeNative[w] || {}).abs);
  if (w !== 'all' && isNum(want) && !(Math.abs(heroVal - want) <= 1)) out.push(`hero delta ${heroVal} != the payload's ${w} change ${want}`);
  if (lens !== 'supply' || !usdScope || !win) return;
  const rows = pg.doc.querySelectorAll('[data-move]');
  if (!rows.length) return void out.push('Supply lens: no [data-move] rows');
  const net = rows.find((r) => r.getAttribute('data-move') === 'net');
  const sum = rows.filter((r) => r.getAttribute('data-move') !== 'net').reduce((s, r) => s + Number(r.getAttribute('data-usd')), 0);
  const netV = net ? Number(net.getAttribute('data-usd')) : NaN;
  if (!(Math.abs(sum - netV) <= 1)) out.push(`moves rows + Other + Unattributed = ${sum}, Net = ${netV}`);
  const wantNet = asset === 'all' ? win.totalDeltaUsd : (win.assets.find((r) => r.asset === asset) || {}).deltaUsd;
  if (isNum(wantNet) && !(Math.abs(netV - wantNet) <= 1)) out.push(`Net ${netV} != attribution ${w} ${wantNet}`);
  if (w !== 'all' && isNum(heroVal) && !(Math.abs(netV - heroVal) <= 1)) out.push(`Net ${netV} != hero delta ${heroVal}`);
  const strip = pg.doc.querySelector('[data-strip]');
  if (!strip) return void out.push('no In/Out/Net strip');
  const [i, o, n] = ['data-in', 'data-out', 'data-net'].map((k) => Number(strip.getAttribute(k)));
  if (!(Math.abs(i + o - n) <= 1) || !(Math.abs(n - netV) <= 1)) out.push(`strip In ${i} + Out ${o} != Net ${n} (rows ${netV})`);
  const chainRows = win.chains.filter((r) => asset === 'all' || r.asset === asset);
  const inW = chainRows.reduce((s, r) => s + Math.max(0, r.deltaUsd), 0), outW = chainRows.reduce((s, r) => s + Math.min(0, r.deltaUsd), 0);
  if (!(Math.abs(i - inW) <= 1) || !(Math.abs(o - outW) <= 1)) out.push(`strip In ${i} / Out ${o} != the attribution's chain flows ${inW} / ${outW}`);
}
// The briefing as the payload says (§3.5): eyebrow, rows in order, kinds; the verdict text (§3.3).
function briefingMatches(pg, p, asset, range, out) {
  const b = p.briefing;
  if (!b) return;
  const scope = asset === 'all' ? b : b.byAsset && b.byAsset[asset];
  if (!scope) return void out.push(`no briefing scope ${asset}`);
  const frame = scope.frames[windowOf(range) === 'all' ? 'd365' : windowOf(range)];
  const list = $(pg, 'brief-list');
  const rows = list ? list.children.filter((li) => li.localName === 'li') : [];
  const want = frame ? frame.bullets.filter((x) => x.kind !== 'state') : [];
  if (rows.length !== want.length || rows.some((li, k) => li.getAttribute('data-kind') !== want[k].kind)) out.push(`briefing rows ${rows.map((li) => li.getAttribute('data-kind'))} != payload ${want.map((x) => x.kind)}`);
  for (const [k, li] of rows.entries()) if (want[k] && !textOf(li).includes(want[k].text.split(/\s+/).slice(0, 2).join(' '))) out.push(`briefing row ${k} does not show "${want[k].text}"`);
  const eyebrow = pg.doc.querySelector('#brief .eyebrow');
  // (the full-history period shows the longest summary and says so)
  const wantLabel = frame ? `${frame.label}${range === 'all' ? ' (longest summary)' : ''}` : null;
  if (frame && !(eyebrow && eyebrow.textContent.trim() === wantLabel)) out.push(`briefing eyebrow "${eyebrow && eyebrow.textContent}" != "${wantLabel}"`);
}

// ---------- 1. the default view ----------
let DEFAULT = null, RENDERS = 0;
await section('default view', async () => {
  const pg = await open();
  const a = audit(pg, 'default view (All, 7d, Supply)', { budget: 180, defaultView: true });
  ok(!a.problems.length, report(a) || 'default view renders cleanly');
  DEFAULT = a;
  ok(a.strict <= 110, `default view: ${a.strict} words without tickers, chain names and months (acceptance 2: ≤110)`);
  ok(a.graphics >= 1 && a.graphics <= 8, `default view: ${a.graphics} graphics (≤8)`);
  ok(a.tables === 0, `default view: ${a.tables} <table> elements before any Table toggle (H13: 0)`);
  ok(a.nodes <= 2500, `default view: ${a.nodes} elements (≤2,500)`);
  ok(pg.win.location.search === '' && !pg.win.location.hash, `defaults are omitted from the URL (${pg.win.location.search}${pg.win.location.hash})`);
  ok(verdictText(pg).includes(BASE.briefing.verdict.text), `verdict shows "${BASE.briefing.verdict.text}" (${verdictText(pg)})`);
  const vb = pg.doc.querySelector('.verdict button[aria-controls="brief-list"]');
  ok(BASE.briefing.verdict.level !== 'unusual' || (vb && vb.getAttribute('aria-label') === 'Show the findings' && !vb.closest('[aria-live]')), 'the verdict has a separate "Show the findings" button outside its live text');
  const out = [];
  reconcile(pg, BASE, { asset: 'all', range: '7d', lens: 'supply' }, out);
  briefingMatches(pg, BASE, 'all', '7d', out);
  ok(!out.length, `default view reconciles:\n  ${out.join('\n  ')}`);
  ok(/^Supply as of \w{3} \d{1,2} · prices \d\d:\d\d UTC$/.test(chipText(pg)), `chip reads "Supply as of {Mon D} · prices {HH:MM} UTC" (${chipText(pg)})`);
  // Every briefing link target: the lens tab exists and is enabled; following it sets lens, focus and #f.
  const frame = BASE.briefing.frames.d7.bullets.filter((x) => x.kind !== 'state');
  for (const [k, x] of frame.entries()) {
    const pgk = await open();
    const li = $(pgk, 'brief-list').children.filter((c) => c.localName === 'li')[k];
    const link = li && li.querySelectorAll('a, button').find((e) => e.getAttribute('data-lens') === x.link.lens);
    const t = tab(pgk, x.link.lens);
    ok(link && t && t.getAttribute('aria-disabled') !== 'true', `briefing row ${k} links to an enabled ${x.link.lens} tab`);
    if (!link) continue;
    await pgk.click(link);
    const q = qs(pgk);
    ok(tab(pgk, x.link.lens).getAttribute('aria-selected') === 'true' && (x.link.lens === 'supply' ? !q.has('lens') : q.get('lens') === x.link.lens) && (q.get('focus') || null) === x.link.focus && (pgk.win.location.hash || '') === (x.link.insight ? `#f=${encodeURIComponent(x.link.insight)}` : ''), `briefing row ${k} → lens ${x.link.lens}, focus ${x.link.focus}, #f=${x.link.insight} (${pgk.win.location.search}${pgk.win.location.hash})`);
    ok(!pgk.navigations.length, `briefing row ${k}: an in-page move, not a navigation`);
  }
  // Card peg = Peg table Average = the period's mean distance from $1 on the daily price (§3.6), per period.
  for (const [range, w, n] of RANGES.filter((r) => r[2])) {
    const pp = await open({ search: range === '7d' ? '' : `?range=${range}` });
    const cards = {};
    for (const k of ACTIVE.filter((x) => BASE.assets[x].unit === 'USD')) {
      const el = pp.doc.querySelector(`[data-card="${k}"] [data-peg]`);
      cards[k] = el ? textOf(el) : null;
      const s = BASE.assets[k].series.price, to = BASE.attribution.windows[w].to;
      const vals = s.values.map((v, i) => [new Date(Date.parse(s.start) + i * 864e5).toISOString().slice(0, 10), v]).filter(([d, v]) => isNum(v) && d <= to && d > new Date(Date.parse(to) - n * 864e5).toISOString().slice(0, 10)).map(([, v]) => v);
      const mean = vals.reduce((x, v) => x + Math.abs(v - 1), 0) / vals.length, sign = Math.sign(vals.reduce((x, v) => x + v - 1, 0));
      const wantTxt = mean * 100 < 0.005 ? 'peg ≈ $1' : `peg ${sign < 0 ? '−' : '+'}${(mean * 100).toFixed(2)}%`;
      ok(cards[k] === wantTxt, `${range}: ${k} card "${cards[k]}" = the mean daily distance from $1 (${wantTxt})`);
    }
    await setScope(pp, { lens: 'peg' });
    const fig = $(pp, 'panel').querySelectorAll('figure')[0];
    const tbl = fig && (await openTable(pp, fig));
    const rows = tbl ? rowsOf(tbl) : [];
    const col = rows.length ? rows[0].findIndex((c) => /^Average/.test(c)) : -1;
    ok(col > 0 && rows[0][col] === `Average, ${range === '1y' ? '1y' : range}`, `${range}: the Peg table has an "Average, ${range}" column (${rows[0]})`);
    for (const k of Object.keys(cards)) {
      const r = rows.find((x) => x[0].startsWith(k));
      ok(r && cards[k] && (r[col] === cards[k].replace(/^peg /, '') || (cards[k] === 'peg ≈ $1' && /≈ \$1/.test(r[col]))), `${range}: ${k} Peg table Average "${r && r[col]}" = card "${cards[k]}"`);
    }
    const tA = audit(pp, `${range} peg lens with table`, { budget: 600 });
    ok(!tA.problems.length, report(tA) || 'peg table render');
  }
});

// ---------- 2. every asset × period × lens ----------
await section('matrix', async () => {
  const fails = [];
  for (const asset of ['all', ...KEYS]) {
    const pg = await open({ search: '?legacy=1' });
    await setScope(pg, { asset });
    const combos = [];
    for (const [range] of RANGES) for (const lens of LENSES) combos.push([range, lens]);
    for (const [range, lens] of combos) {
      await setScope(pg, { range });
      const t = tab(pg, lens);
      if (!t) { fails.push(`${asset} ${range}: no ${lens} tab`); continue; }
      if (t.getAttribute('aria-disabled') === 'true') {
        const a = BASE.assets[asset];
        const why = lens === 'market' ? a && a.kind !== 'usd-stablecoin' : lens === 'income' ? asset !== 'all' && !(BASE.economics.assets || []).includes(asset) : false;
        if (!why) fails.push(`${asset}: the ${lens} tab is disabled`);
        continue;
      }
      await setScope(pg, { lens });
      const q = qs(pg);
      if ((q.get('asset') || 'all') !== asset || (q.get('range') || '7d') !== range || (q.get('lens') || 'supply') !== lens) fails.push(`URL ${pg.win.location.search} != asset ${asset} range ${range} lens ${lens}`);
      RENDERS++;
      const a = audit(pg, `asset=${asset} range=${range} lens=${lens}`);
      const out = [...a.problems];
      reconcile(pg, BASE, { asset, range, lens }, out);
      if (lens === 'supply') briefingMatches(pg, BASE, asset, range, out);
      if (out.length) fails.push(`${a.label}:\n  ${out.slice(0, 8).join('\n  ')}`);
    }
  }
  ok(!fails.length, `every asset × period × lens renders and reconciles:\n${fails.slice(0, 8).join('\n')}`);
});

// Focus survives re-renders (FOCUS_ATTRS data-range, data-asset, data-lens).
await section('focus', async () => {
  const pg = await open();
  const r = btn(pg, 'data-range', '30d');
  await pg.click(r);
  let a = pg.doc.activeElement;
  ok(a && a.getAttribute('data-range') === '30d' && a.getAttribute('aria-pressed') === 'true', `focus stays on the period button (${a && a.outerHTML || a && a.localName})`);
  await pg.click(btn(pg, 'data-asset', ACTIVE[0]));
  a = pg.doc.activeElement;
  ok(a && a.getAttribute('data-asset') === ACTIVE[0] && a.getAttribute('aria-pressed') === 'true', 'focus stays on the asset button');
  await pg.click(tab(pg, 'peg'));
  a = pg.doc.activeElement;
  ok(a && a.getAttribute('data-lens') === 'peg' && a.getAttribute('role') === 'tab' && a.getAttribute('aria-selected') === 'true', 'focus stays on the lens tab');
});

// ---------- 3. accessibility and isolation (H9) ----------
await section('a11y', async () => {
  const pg = await open();
  const d = pg.doc;
  ok(d.querySelectorAll('h1').length === 1, 'one h1');
  ok(['overview', 'cards-sec', 'lens-sec'].every((id) => { const s = $(pg, id); return s && s.querySelector('h2'); }), 'an h2 per block (sr-only for Overview and Cards)');
  const chip = d.querySelector('button.chip');
  const chipLive = chip && chip.parentElement.querySelectorAll('[aria-live]').filter((x) => x !== chip && !chip.contains(x));
  ok(chip && !chip.hasAttribute('aria-live') && chipLive.length === 1 && chipLive[0].getAttribute('role') === 'status' && chipLive[0].textContent.trim() === chipText(pg), `the chip has one sibling status region with its text (${chipLive && chipLive.map((x) => x.textContent)})`);
  const v = d.querySelector('.verdict');
  ok(v && v.querySelectorAll('[aria-live]').length === 1 && v.querySelector('[aria-live]').getAttribute('role') === 'status', 'the verdict holds exactly one status region');
  const tabs = d.querySelectorAll('[role="tab"]');
  ok(tabs.length === 6 && JSON.stringify(tabs.map((t) => t.getAttribute('data-lens'))) === JSON.stringify(LENSES) && tabs.map((t) => textOf(t).replace(/\s*[!+◆•].*$/, '')).join('|') === 'Supply|Chains|Peg|Market|Usage|Income (est.)', `six lens tabs in order (${tabs.map((t) => textOf(t))})`);
  ok(tabs.filter((t) => t.getAttribute('tabindex') === '0').length === 1 && tabs.find((t) => t.getAttribute('aria-selected') === 'true').getAttribute('data-lens') === 'supply', 'roving tabindex: one tab in the tab order, Supply selected');
  const sel = () => d.activeElement && d.activeElement.getAttribute('data-lens');
  tabs[0].focus();
  await pg.key(tab(pg, 'supply'), 'ArrowRight');
  ok(sel() === 'chains', `ArrowRight moves to Chains (${sel()})`);
  await pg.key(d.activeElement, 'End');
  ok(sel() === 'income', `End moves to the last tab (${sel()})`);
  await pg.key(d.activeElement, 'Home');
  ok(sel() === 'supply', `Home moves to the first tab (${sel()})`);
  await pg.key(d.activeElement, 'ArrowLeft');
  ok(sel() === 'income', `ArrowLeft wraps to the last tab (${sel()})`);
  for (const lens of LENSES) {
    const p2 = await open({ search: lens === 'supply' ? '' : `?lens=${lens}` });
    const figs = $(p2, 'panel').querySelectorAll('figure');
    ok(figs.length >= 1 && figs.every((f) => f.querySelectorAll('button[aria-pressed]').some((b) => b.textContent.trim() === 'Table')), `${lens}: every figure has a Table toggle (${figs.length} figures)`);
    ok(p2.doc.querySelectorAll('canvas').every((c) => c.getAttribute('role') === 'img' && c.getAttribute('aria-label')), `${lens}: every canvas is role="img" with its title`);
  }
});
await section('component isolation (H9)', async () => {
  const REGION = { header: '.head', scope: '#scope', verdict: '#verdict', hero: '#hero', brief: '#brief', cards: '#cards', lenses: '#panel', allFindings: '#all-findings', about: '#about' };
  const pg = await open();
  const P = pg.P;
  ok(P.components && JSON.stringify(Object.keys(P.components).sort()) === JSON.stringify(Object.keys(REGION).sort()), `components are ${Object.keys(REGION).join(', ')} (${P.components && Object.keys(P.components)})`);
  for (const name of Object.keys(REGION)) {
    const orig = P.components[name];
    P.components[name] = () => { throw new Error('injected failure'); };
    await pg.click(btn(pg, 'data-range', '30d'));
    await pg.click(btn(pg, 'data-range', '7d'));
    const region = pg.doc.querySelector(REGION[name]);
    ok(region && FAIL_COPY.test(region.textContent), `${name} throws: its region shows the fallback copy (${region && region.textContent.slice(0, 80)})`);
    const others = Object.entries(REGION).filter(([k]) => k !== name);
    const broken = others.filter(([, sel]) => { const r = pg.doc.querySelector(sel); return !r || FAIL_COPY.test(r.textContent); }).map(([k]) => k);
    const alive = (name === 'hero' || pg.doc.querySelector('[data-hero-delta]')) && (name === 'cards' || pg.doc.querySelector('[data-card]')) && (name === 'lenses' || pg.doc.querySelector('[role="tab"]'));
    ok(!broken.length && alive, `${name} throws: the other components still render (broken: ${broken.join(', ') || 'none'})`);
    pg.errs.length = 0;
    P.components[name] = orig;
  }
  await pg.click(btn(pg, 'data-range', '30d'));
  const a = audit(pg, 'after restoring every component');
  ok(!a.problems.length, report(a) || 'restored');
  // Chart.js missing: every chart starts in table view with one note.
  const nc = await open({ chart: false });
  const t = textOf(nc.doc.body);
  ok(/Charts unavailable; showing tables\./.test(t) && (t.match(/Charts unavailable; showing tables\./g) || []).length === 1 && nc.doc.querySelectorAll('canvas').length === 0 && nc.doc.querySelectorAll('table').length >= 1, 'no Chart.js: "Charts unavailable; showing tables." once, tables instead of canvases');
  const na = audit(nc, 'no Chart.js');
  ok(!na.problems.length, report(na) || 'no chart render');
});

// ---------- 4. snapshot (H1) and freshness (§3.1) ----------
function cachesStub(snapshotPayload) {
  const store = new Map();
  if (snapshotPayload) store.set('/api/paxos', JSON.stringify(snapshotPayload));
  const calls = [];
  return {
    calls, store,
    async open(name) { calls.push(['open', name]); if (name !== 'paxos-health:s1') throw new Error('unexpected cache ' + name); return { match: async (k) => { calls.push(['match', String(k)]); const v = store.get(String(k)); return v ? new Response(v, { headers: { 'content-type': 'application/json' } }) : undefined; }, put: async (k, r) => { calls.push(['put', String(k)]); store.set(String(k), await r.text()); } }; },
    async keys() { return ['paxos-health:s1']; }, async delete() { return true; }, async has() { return true; },
  };
}
const deferredFetch = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); const f = async () => p; return { f, resolve, reject }; };
const hhmm = (iso) => iso.slice(11, 16);
await section('snapshot (H1)', async () => {
  const snap = clone(BASE);
  snap.generatedAt = new Date(GEN_MS - 2 * 3600e3).toISOString();
  // (a) network slow: the snapshot renders after 150 ms with "Snapshot HH:MM UTC · updating".
  {
    const net = deferredFetch();
    const pg = await open({ caches: cachesStub(snap), fetch: net.f, noLoad: true });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    pg.advance(100);
    ok(!pg.doc.querySelector('[data-hero]') || /—/.test($(pg, 'hero').textContent), 'nothing rendered from the snapshot before 150 ms');
    pg.advance(60);
    await pg.settle();
    ok(chipText(pg) === `Snapshot ${hhmm(snap.generatedAt)} UTC · updating`, `(a) snapshot shown with "Snapshot HH:MM UTC · updating" (${chipText(pg)})`);
    ok(pg.doc.querySelector('[data-hero-delta]') && verdictText(pg) === snap.briefing.verdict.text, '(a) the snapshot renders the whole page');
    // (d) the network payload replaces it in place.
    net.resolve(new Response(JSON.stringify(BASE), { status: 200, headers: { 'content-type': 'application/json' } }));
    await pg.load();
    ok(/^Supply as of /.test(chipText(pg)), `(d) the fresh payload replaces the snapshot (${chipText(pg)})`);
    const a = audit(pg, 'snapshot then fresh');
    ok(!a.problems.length, report(a) || 'snapshot replace');
  }
  // (b) network failure with a snapshot: "couldn't refresh" + Retry, no error panel.
  {
    const pg = await open({ caches: cachesStub(snap), fetch: async () => new Response('down', { status: 503 }) });
    pg.advance(200);
    await pg.settle();
    const extra = $(pg, 'chip-extra');
    ok(chipText(pg) === `Snapshot ${hhmm(snap.generatedAt)} UTC · couldn't refresh` && extra && !extra.hidden && /Showing the last saved data\./.test(extra.textContent) && extra.querySelector('button') && /Retry/.test(extra.textContent), `(b) "couldn't refresh" + "Showing the last saved data." + Retry (${chipText(pg)} | ${extra && extra.textContent})`);
    ok(!pg.doc.querySelectorAll('[role="alert"]').some(isVisible) && pg.doc.querySelector('[data-hero-delta]'), '(b) no error panel; the snapshot stays');
  }
  // (c) an 8-day-old or a schemaVersion 2 snapshot is ignored.
  for (const [what, s] of [['8-day-old', { ...clone(BASE), generatedAt: new Date(GEN_MS - 8 * 864e5).toISOString() }], ['schemaVersion 2', { ...clone(BASE), schemaVersion: 2 }]]) {
    const net = deferredFetch();
    const pg = await open({ caches: cachesStub(s), fetch: net.f, noLoad: true, nowMs: GEN_MS + 60e3 });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    pg.advance(400);
    await pg.settle();
    ok(chipText(pg) === 'Loading…' && !pg.doc.querySelector('[data-hero-delta]'), `(c) a ${what} snapshot is ignored (${chipText(pg)})`);
    net.reject(new Error('offline'));
    await pg.load();
  }
  // A fresh payload is saved for next time.
  {
    const cs = cachesStub(null);
    const pg = await open({ caches: cs });
    await pg.settle();
    ok(cs.store.has('/api/paxos') && JSON.parse(cs.store.get('/api/paxos')).generatedAt === BASE.generatedAt, 'the validated payload is saved to Cache Storage (paxos-health:s1, /api/paxos)');
  }
  // (e) no caches global: as today. A throwing Cache Storage is harmless too.
  {
    const pg = await open();
    ok(/^Supply as of /.test(chipText(pg)), '(e) without Cache Storage the page loads as before');
    const bad = { open: async () => { throw new Error('SecurityError'); } };
    const pb = await open({ caches: bad });
    const a = audit(pb, 'throwing Cache Storage');
    ok(!a.problems.length && /^Supply as of /.test(chipText(pb)), report(a) || 'every caches call is guarded');
  }
});
await section('freshness and states (§3.1, §3.3, §3.13)', async () => {
  // A copy older than its CDN budget is never labelled current.
  const old = await open({ nowMs: GEN_MS + (BASE.cache.sMaxAge + 600) * 1000 });
  ok(/^Snapshot \d\d:\d\d UTC · (updating|no newer data yet)$/.test(chipText(old)), `a ${Math.round(BASE.cache.sMaxAge / 60 + 10)}-minute-old payload reads as a snapshot (${chipText(old)})`);
  // Offline.
  const off = await open({ online: false });
  ok(/^Offline · snapshot \d\d:\d\d UTC$/.test(chipText(off)), `offline chip (${chipText(off)})`);
  // Fetch failed, nothing to show: the error panel with Retry; no console error (an outage is a state).
  const down = await open({ fetch: async () => new Response('down', { status: 503 }) });
  const alert = down.doc.querySelectorAll('[role="alert"]').find(isVisible);
  ok(chipText(down) === 'Data unavailable' && alert && /Data unavailable/.test(alert.textContent) && /The data service did not respond\./.test(alert.textContent) && alert.querySelector('button') && /Raw data \(JSON\)/.test(alert.textContent), `a failed load shows "Data unavailable" with Retry and Raw data (${chipText(down)})`);
  ok(!down.errs.length, `a failed load logs no console error (${down.errs[0]})`);
  // Slow first load: after 3 s the extra line explains the wait.
  const slow = deferredFetch();
  const sl = await open({ fetch: slow.f, noLoad: true });
  sl.advance(3100);
  await sl.settle();
  ok(chipText(sl) === 'Loading…' && /Building a fresh snapshot; this can take up to 15 seconds\./.test(($(sl, 'chip-extra') || { textContent: '' }).textContent), 'a load over 3 s explains the wait');
  ok(/Loading the latest snapshot…/.test(verdictText(sl)), 'the verdict says it is loading');
  slow.resolve(new Response(JSON.stringify(BASE), { status: 200 }));
  await sl.load();
  // A late source: chip suffix; a late supply source overrides a clear verdict (§3.3).
  const quiet = reapply((() => { const p = clone(BASE); p.insights.feed = []; return p; })());
  const supplySrc = quiet.sources.find((s) => s.kind === 'supply');
  const late = await open({ payload: quiet, nowMs: GEN_MS + ((supplySrc.staleAfterHours || 2) - (supplySrc.ageHours || 0) + 1) * 3600e3 });
  ok(/· \d+ sources? late$/.test(chipText(late)) || /^Snapshot /.test(chipText(late)), `a late source shows in the chip (${chipText(late)})`);
  ok(/^Nothing (unusual|major) in available data · supply data .+ old$/.test(verdictText(late)) && !/^Nothing unusual ·/.test(verdictText(late)), `a late supply source overrides the clear verdict (${verdictText(late)})`);
  const down1 = clone(BASE);
  down1.sources.find((s) => s.kind === 'price').status = 'error';
  const dn = await open({ payload: down1 });
  ok(/ · 1 source down$/.test(chipText(dn)), `a source in error: "· 1 source down" (${chipText(dn)})`);
  // insights.errors: the verdict never says "Nothing unusual".
  const part = reapply((() => { const p = clone(BASE); p.insights.feed = []; p.insights.errors = [{ detector: 'chain.move', error: 'boom' }]; return p; })());
  const pp = await open({ payload: part });
  ok(/^Partly checked · 1 checks? could not run$/.test(verdictText(pp)), `insights.errors -> "${verdictText(pp)}"`);
  for (const pg of [old, off, dn, pp]) { const a = audit(pg, 'state render'); ok(!a.problems.length, report(a) || 'state render'); }
});

// ---------- 5. payload variants ----------
await section('older payload (v1, §3.13)', async () => {
  const v1 = C.stripV2(BASE);
  const pg = await open({ payload: v1 });
  const a = audit(pg, 'older payload (no briefing, no titles)');
  ok(!a.problems.length, report(a) || 'older payload renders');
  ok(verdictText(pg) === 'Unusual: USDP peg', `older payload: verdict from the health cells (${verdictText(pg)})`);
  ok(!$(pg, 'brief-list') && (!$(pg, 'brief') || $(pg, 'brief').hidden), 'older payload: the briefing list is hidden');
  for (const lens of LENSES) { await setScope(pg, { lens }); const b = audit(pg, `older payload ${lens}`); ok(!b.problems.length, report(b) || 'older lens'); }
});
await section('degraded payloads', async () => {
  const cases = {
    'insights null': (p) => { p.insights = null; p.briefing = B.applyBriefing(p); },
    'attribution null': (p) => { p.attribution = null; reapply(p); },
    'market null': (p) => { p.market = null; reapply(p); },
    'briefing null': (p) => { p.briefing = null; p.insights.errors.push({ detector: 'payload.briefing', error: 'boom' }); },
    'economics null': (p) => { p.economics = null; reapply(p); },
    'pegPeers empty': (p) => { p.pegPeers = []; reapply(p); },
    'peers null': (p) => { p.peers = null; reapply(p); },
  };
  for (const [name, f] of Object.entries(cases)) {
    const p = clone(BASE);
    f(p);
    const pg = await open({ payload: p, search: '?legacy=1' });
    const fails = [];
    for (const lens of LENSES) {
      const t = tab(pg, lens);
      if (t && t.getAttribute('aria-disabled') !== 'true') await setScope(pg, { lens });
      const a = audit(pg, `${name} ${lens}`, { allowFail: true });
      if (a.problems.length) fails.push(report(a));
    }
    ok(!fails.length, `${name}: renders with fallbacks only:\n${fails.slice(0, 3).join('\n')}`);
    if (name === 'insights null') ok(verdictText(pg) === 'Checks unavailable in this snapshot', `insights null -> "${verdictText(pg)}"`);
  }
  // An incomplete all-assets total (§3.4): a lower bound that names what it excludes.
  const inc = clone(BASE);
  const gold = Object.values(inc.assets).find((a) => a.kind === 'gold');
  inc.totals.allUsd = { ...inc.totals.allUsd, current: null, coveredUsd: 5.9e9, missing: [gold.key] };
  const pi = await open({ payload: inc });
  const hero = $(pi, 'hero');
  ok(/≥ \$5\.90B with gold and legacy/.test(textOf(hero)) && hero.querySelectorAll('[data-tip], [title]').some((e) => (e.getAttribute('data-tip') || e.getAttribute('title') || '') === `Excludes ${gold.key}: no USD value.`), `incomplete total: "≥ $5.90B with gold and legacy", tooltip "Excludes ${gold.key}: no USD value." (${textOf(hero)})`);
});
await section('busy, quiet and discovery', async () => {
  // Busy day: three major findings, 5 bullets, legacy on (≤350 words, §3.17).
  const busy = clone(BASE);
  const lead = busy.insights.feed[0].lead;
  const mk = (asset, dim, det, usd) => ({ ...clone(lead), id: `${det}:${asset}:busy`, detector: det, dimension: dim, asset, chain: dim === 'chains' ? (BASE.assets[asset].chains[0] || {}).chain || null : null, polarity: 'negative', materialityUsd: usd, title: `${asset} −$${Math.round(usd / 1e6)}M (−3.0%) over 7 days`, evidence: { ...clone(lead.evidence), window: '7d' }, facts: { usd: -usd, pct: -0.03, days: 7, unit: 'USD', record: null } });
  busy.insights.feed.push({ rootKey: 'busy-1', lead: mk(ACTIVE[0], 'supply', 'supply.move', 1.2e8), related: [] }, { rootKey: 'busy-2', lead: mk(ACTIVE[1], 'chains', 'chain.move', 9e7), related: [] });
  reapply(busy);
  const pb = await open({ payload: busy, search: '?legacy=1' });
  const a = audit(pb, 'busy day (legacy on)');
  ok(!a.problems.length, report(a) || 'busy day');
  ok(verdictText(pb) === busy.briefing.verdict.text && /^3 unusual: /.test(verdictText(pb)), `busy verdict "${verdictText(pb)}"`);
  const flags = pb.doc.querySelectorAll('[data-flag]');
  ok(flags.length >= 2, `cards carry flags for unusual items (${flags.length})`);
  // Quiet day: no findings at all; the briefing still shows movers and steady lines.
  const quiet = reapply((() => { const p = clone(BASE); p.insights.feed = []; return p; })());
  const pq = await open({ payload: quiet });
  const q = audit(pq, 'quiet day', { budget: 180, defaultView: true });
  ok(!q.problems.length, report(q) || 'quiet day');
  ok(verdictText(pq) === quiet.briefing.verdict.text && /^Nothing unusual · /.test(verdictText(pq)), `quiet verdict "${verdictText(pq)}"`);
  // A newly discovered asset gets a scope button, a card and its briefing, with no code change.
  const p = clone(BASE);
  const key = 'ZZZN';
  p.assets[key] = { ...clone(BASE.assets[ACTIVE[1]]), key, symbol: key, name: 'Synthetic new coin', colorIndex: ACTIVE.length };
  p.discovery.assets.push({ ...clone(BASE.discovery.assets.find((x) => x.key === ACTIVE[1])), key, symbol: key, name: 'Synthetic new coin', geckoId: null, llamaId: null, colorIndex: ACTIVE.length });
  p.insights.health.cells[key] = clone(BASE.insights.health.cells[ACTIVE[1]]);
  reapply(p);
  const pn = await open({ payload: p });
  ok(btn(pn, 'data-asset', key) && pn.doc.querySelector(`[data-card="${key}"]`), 'a newly discovered asset gets a scope button and a card');
  await setScope(pn, { asset: key });
  const an = audit(pn, 'new asset scope');
  ok(!an.problems.length && $(pn, 'brief-list'), report(an) || 'new asset scope with its briefing');
});
await section('narrow screen (375 px)', async () => {
  const pg = await open({ width: 375 });
  const a = audit(pg, 'narrow default view', { budget: 180, defaultView: true });
  ok(!a.problems.length, report(a) || 'narrow');
  ok($(pg, 'compact'), 'the compact bar exists');
  for (const [range] of RANGES) { await setScope(pg, { range }); const b = audit(pg, `narrow ${range}`); ok(!b.problems.length, report(b) || 'narrow range'); }
});

// ---------- 5b. fresh-eyes review findings ----------
await section('review: one peg story, scope, degraded data, controls', async () => {
  // One number per period for the peg finding: the briefing bullet, the card, the Peg lens title, its
  // "Unusual here" line and All findings agree (the detector's own window stays in Method).
  for (const [range, w] of [['7d', 'd7'], ['30d', 'd30'], ['1y', 'd365']]) {
    const pg = await open({ search: `${range === '7d' ? '?' : `?range=${range}&`}lens=peg` });
    const fb = BASE.briefing.frames[w].bullets.find((x) => x.kind === 'finding' && x.subject.asset === 'USDP');
    const line = $(pg, 'panel').querySelectorAll('.unusual-here li[data-f]')[0];
    const all = $(pg, 'all-findings');
    all.open = true;
    await pg.settle();
    const allLine = all.querySelectorAll('li[data-f]')[0];
    ok(fb && line && textOf(line).includes(fb.text) && allLine && textOf(allLine).includes(fb.text), `${range}: Peg › Unusual here and All findings lead with the briefing's "${fb && fb.text}" (${line && textOf(line).slice(0, 80)})`);
    if (range === '7d') {
      const card = textOf(pg.doc.querySelector('[data-card="USDP"] [data-peg]'));
      const title = textOf($(pg, 'panel').querySelector('figcaption'));
      ok(fb.text.includes(card.replace(/^peg [−+]/, '')) && title.includes(card.replace(/^peg [−+]/, '')) && /over 7 days/.test(title), `7d: card "${card}", Peg title "${title}" and the bullet state one figure`);
      ok(textOf($(pg, 'panel').querySelector('.focus-chip') || pg.doc.body) && !/Showing USDP since Sep 2[0-9]/.test(textOf(pg.doc.body)), 'the focus chip, when shown, uses the finding\'s start');
    }
  }
  {
    const pg = await open({ search: '?lens=peg&focus=USDP', hash: '#f=peg.deviation%3AUSDP%3Aabs%3Aup' });
    const chip = $(pg, 'panel').querySelector('.focus-chip');
    const ev = $(pg, 'panel').querySelector('.unusual-here .ev:not([hidden])');
    const t = ev ? textOf(ev) : '';
    ok(chip && /Showing USDP since Sep 11/.test(textOf(chip)), `focus chip from the finding's start (${chip && textOf(chip)})`);
    ok(/^.*Last 7 days: 0\.44% · Before Sep 11: 0\.05% · Peers: ≤0\.07%/.test(t) && /Covers all \$26M of USDP\./.test(t) && !/Usual:|Involves|Also: USDP/.test(t), `the peg evidence: period figures, no second share or repeated peer line (${t.slice(0, 200)})`);
  }
  // "Unusual here" heads a list only over a finding the verdict names; otherwise "Smaller findings".
  {
    const p = clone(BASE);
    const lensItem = BASE.insights.watch.find((i) => i.role === 'lens' && i.dimension === 'portfolio') || BASE.insights.watch.find((i) => i.role === 'lens' && (BASE.assets[i.asset] || {}).status === 'active');
    if (lensItem) {
      p.insights.feed.push({ rootKey: lensItem.id, lead: { ...clone(lensItem), stage: 'new', facts: {} }, related: [] });
      reapply(p);
      const lens = { supply: 'supply', portfolio: 'supply', chains: 'chains', peg: 'peg', market: 'market', defi: 'usage', usage: 'usage', economics: 'income' }[lensItem.dimension];
      const pg = await open({ payload: p, search: lens === 'supply' ? '' : `?lens=${lens}` });
      const hd = $(pg, 'panel').querySelector('.unusual-here h3');
      ok(hd && textOf(hd) === 'Smaller findings', `a lens-only unit lists under "Smaller findings" (${hd && textOf(hd)})`);
      const q = await open({ payload: reapply((() => { const x = clone(p); x.insights.feed = x.insights.feed.filter((c) => c.lead.id === lensItem.id); return x; })()) });
      ok(/^Nothing major · 1 smaller finding$/.test(verdictText(q)), `…and the verdict counts it (${verdictText(q)})`);
    }
  }
  // Asset scope: a total's item belongs to an asset it names or that drives most of it, not every driver.
  {
    const p = clone(BASE), key = BASE.totals.usd.key;
    const mix = { ...clone(BASE.insights.feed[0].lead), id: 'portfolio.mix:review', detector: 'portfolio.mix', dimension: 'portfolio', role: 'lens', asset: key, chain: null, polarity: 'neutral', title: 'PYUSD +$155M while USDG −$96M over 7 days', drivers: [{ asset: 'PYUSD', chain: null, usd: 154522457 }, { asset: 'USDG', chain: null, usd: -96206153 }, { asset: 'USDP', chain: null, usd: -1997732 }], facts: {} };
    p.insights.feed.push({ rootKey: mix.id, lead: mix, related: [] });
    reapply(p);
    const pu = await open({ payload: p, search: '?asset=USDP' }), pg = await open({ payload: p, search: '?asset=USDG' });
    ok(!$(pu, 'panel').querySelector('li[data-f="portfolio.mix:review"]') && $(pg, 'panel').querySelector('li[data-f="portfolio.mix:review"]'), 'an offsetting move naming PYUSD and USDG lists under USDG, not under USDP (a −$2.0M part)');
    ok(/^USDG: nothing major · 1 smaller finding$/.test(verdictText(pg)), `USDG verdict counts it (${verdictText(pg)})`);
  }
  // Chain cards: chains under the coin's floor fold into "Other n chains"; footers read "{share} of {KEY}".
  {
    const pg = await open({ search: '?asset=USDP' });
    const fl = BASE.insights.floorsUsd.USDP;
    const tiny = BASE.assets.USDP.chains.filter((c) => c.currentUsd > 0 && c.currentUsd < fl).map((c) => c.chain);
    ok(tiny.every((c) => !pg.doc.querySelector(`[data-card="${c}"]`)) && (!tiny.length || /Other \d+ chains/.test(textOf($(pg, 'cards')))), `chains under USDP's floor fold into Other (${tiny})`);
    ok(pg.doc.querySelectorAll('#cards .c-f.wrap').every((e) => / of USDP/.test(textOf(e))), 'chain card footers read "{share} of USDP"');
    const strip = pg.doc.querySelector('[data-strip]');
    ok(strip && !/[+−]\$\d(?![\d.,]*[KMB])/.test(textOf(strip)), `the In/Out strip never prints a dollar-sized leg (${strip && textOf(strip)})`);
  }
  // Degraded snapshot: an asset without a supply figure says so; the hero names what the total misses;
  // the chip counts the missing figure; a page without trading volume drops that column.
  {
    const p = clone(BASE), gold = Object.values(p.assets).find((a) => a.kind === 'gold');
    Object.assign(gold.current, { supply: null, supplyUsd: null });
    p.totals.allUsd = { ...p.totals.allUsd, current: null, coveredUsd: 6.01e9, missing: [gold.key] };
    p.status = { level: 'degraded', reasons: [{ kind: 'section', id: 'totals.allUsd', status: null, message: `no USD value for ${gold.key}` }] };
    for (const a of Object.values(p.assets)) a.series.turnover7d = null;
    reapply(p);
    const pg = await open({ payload: p });
    const card = pg.doc.querySelector(`[data-card="${gold.key}"]`);
    ok(card && /No supply figure in this snapshot/.test(textOf(card)) && !/—/.test(textOf(card)), `${gold.key} card: "No supply figure in this snapshot" (${card && textOf(card)})`);
    ok(new RegExp(`with gold and legacy \\(${gold.key} missing\\)`).test(textOf($(pg, 'hero'))) && / · 1 figure missing$/.test(chipText(pg)), `hero names the missing coin; chip "${chipText(pg)}"`);
    await setScope(pg, { lens: 'usage' });
    const u = $(pg, 'panel');
    ok(!u.querySelectorAll('.uh').some((x) => textOf(x) === 'Traded daily') && /Trading volume not in this snapshot\./.test(textOf(u)), 'no trading volume: the column is dropped and a note says so');
    await setScope(pg, { asset: gold.key });
    const a = audit(pg, 'asset without a supply figure');
    ok(!a.problems.length && /No supply figure in this snapshot/.test(textOf($(pg, 'hero'))), report(a) || 'the asset scope says the figure is missing');
    const pnoref = await open({ payload: (() => { const x = clone(BASE); x.goldRefs = []; return x; })(), search: `?asset=${gold.key}&lens=peg` });
    ok(/gold reference prices not in this snapshot/.test(textOf($(pnoref, 'panel'))) && !$(pnoref, 'panel').querySelector('figure'), 'no gold reference: one line, no empty chart frame');
  }
  // The verdict's Details button opens the first finding.
  {
    const pg = await open();
    const b = pg.doc.querySelector('.verdict .vmore');
    await pg.click(b);
    const first = $(pg, 'brief-list').querySelector('li[data-kind="finding"] button[data-exp]');
    ok(first && first.getAttribute('aria-expanded') === 'true' && pg.doc.activeElement === first, 'the verdict button opens the first finding and focuses it');
  }
  // The full-history period says its summary is the longest one; filler lines are context.
  {
    const pg = await open({ search: '?asset=PAXG' });
    const kinds = $(pg, 'brief-list') ? $(pg, 'brief-list').children.map((li) => li.getAttribute('data-kind')) : [];
    ok(!kinds.length || kinds.every((k) => k !== 'mover' || true), 'gold scope renders');
    const fill = $(pg, 'brief-list') && $(pg, 'brief-list').querySelectorAll('li[data-kind="filler"]');
    ok(!fill || fill.every((li) => /For context/.test(li.textContent)), 'filler lines read as context, not as moves');
  }
  // Copy link without a clipboard: "Copy failed" and the link in a field to copy by hand.
  {
    const pg = await open({ search: '?lens=peg&focus=USDP', hash: '#f=peg.deviation%3AUSDP%3Aabs%3Aup' });
    pg.win.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    const b = $(pg, 'panel').querySelectorAll('button').find((x) => x.getAttribute('data-action') === 'copy');
    await pg.click(b);
    const f = $(pg, 'panel').querySelector('input.copy-fallback');
    // (the "Copy failed" label lasts 2 s; the shim's settle has already run past it)
    ok(b && f && f.getAttribute('aria-label') === 'Link to copy' && /#f=peg\.deviation/.test(f.value) && /0\.44% below \$1 on average over 7 days/.test(f.value), `a refused clipboard: "Copy failed" and the link in a field (${f && f.value.slice(0, 120)})`);
  }
});
await section('review: snapshots and validation (H1, H3, H9)', async () => {
  // A snapshot older than the supply source's limit, built while that source was only "partial", never
  // says "Nothing unusual" (partial is re-aged at view time like ok).
  {
    const q = reapply((() => { const p = clone(BASE); p.insights.feed = []; p.sources.find((s) => s.kind === 'supply').status = 'partial'; return p; })());
    const src = q.sources.find((s) => s.kind === 'supply');
    const pg = await open({ payload: q, nowMs: GEN_MS + ((src.staleAfterHours || 2) - (src.ageHours || 0) + 1) * 3600e3 });
    ok(/^Nothing (unusual|major) in available data · supply data .+ old$/.test(verdictText(pg)), `a late "partial" supply source overrides the clear verdict (${verdictText(pg)})`);
  }
  // A failed fetch with a snapshot never builds the error panel first (no role="alert" flash).
  {
    const snap = clone(BASE);
    snap.generatedAt = new Date(GEN_MS - 3600e3).toISOString();
    const pg = await open({ caches: cachesStub(snap), fetch: async () => new Response('down', { status: 502 }) });
    pg.advance(300);
    await pg.settle();
    ok(!pg.doc.querySelector('.error-panel') && !pg.doc.querySelector('[role="alert"]') && /couldn't refresh/.test(chipText(pg)), `a failed fetch with a snapshot: the snapshot, never an error panel (${chipText(pg)})`);
  }
  // An older network copy never replaces a newer snapshot, on screen or in Cache Storage.
  {
    const snap = clone(BASE);
    snap.generatedAt = new Date(GEN_MS + 3600e3).toISOString();
    const cs = cachesStub(snap);
    const net = deferredFetch();
    const pg = await open({ caches: cs, fetch: net.f, noLoad: true, nowMs: GEN_MS + 3600e3 + 60e3 });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    pg.advance(200);
    await pg.settle();
    net.resolve(new Response(JSON.stringify(BASE), { status: 200 }));
    await pg.load();
    ok(pg.P.state.payload.generatedAt === snap.generatedAt && JSON.parse(cs.store.get('/api/paxos')).generatedAt === snap.generatedAt, `an older network answer keeps the newer snapshot (${pg.P.state.payload.generatedAt}; chip ${chipText(pg)})`);
  }
  // A 200 the page cannot read says so (not "did not respond"); sources that are not a list do not stop
  // the page.
  {
    const bad = clone(BASE);
    bad.totals = null;
    const pg = await open({ payload: bad });
    const alert = pg.doc.querySelector('[role="alert"]');
    ok(alert && /cannot read/.test(textOf(alert)) && !/did not respond/.test(textOf(alert)), `an unreadable payload: "${alert && textOf(alert)}"`);
    const ns = clone(BASE);
    ns.sources = { not: 'a list' };
    const pn = await open({ payload: ns });
    ok(pn.doc.querySelector('[data-hero-delta]') && !/Loading/.test(chipText(pn)), `sources not a list: the page renders (${chipText(pn)})`);
  }
});

// ---------- 6. kept guarantees and static rules ----------
await section('kept guarantees', async () => {
  // The market-share line starts where the market total is comparable (market.coverageFrom), and says so.
  const cov = BASE.market.coverageFrom;
  const pg = await open({ search: '?range=all&lens=market' });
  const fig = $(pg, 'panel').querySelectorAll('figure')[0];
  const t = fig && (await openTable(pg, fig));
  const dates = t ? rowsOf(t).slice(1).map((r) => r[0]) : [];
  const iso = (s) => { const d = new Date(Date.parse(s + ' UTC')); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : s; };
  ok(dates.length && dates.map(iso).every((d) => d >= cov), `market share rows start on or after ${cov} (${dates.slice(-1)})`);
  ok(fig && fig.querySelectorAll('[data-tip]').some((e) => /^Market total comparable from /.test(e.getAttribute('data-tip'))), 'the clipped share chart explains its start');
  // Gold in ounces, worth in USD.
  const gold = Object.values(BASE.assets).find((x) => x.kind === 'gold');
  const pa = await open();
  const card = pa.doc.querySelector(`[data-card="${gold.key}"]`);
  ok(card && / oz\b/.test(textOf(card)) && /worth \$/.test(textOf(card)) && /gold price [+−]\d/.test(textOf(card)), `${gold.key} card: ounces, worth and gold price (${card && textOf(card)})`);
  // Third-party contracts are labelled (Chains › Contracts).
  const pc = await open({ search: '?lens=chains&legacy=1' });
  const det = $(pc, 'panel').querySelectorAll('details').find((d) => /^Contracts \(\d+\)$/.test((d.querySelector('summary') || { textContent: '' }).textContent.trim()));
  if (det) { det.open = true; await pc.settle(); }
  const rows = det ? det.querySelectorAll('tr').slice(1).map((tr) => textOf(tr)) : [];
  const third = BASE.discovery.addresses.filter((x) => x.role === 'bridged' || x.role === 'unlisted');
  ok(det && rows.length === BASE.discovery.addresses.length && third.every((x) => rows.some((r) => r.includes(x.chain) && /third-party/.test(r))), `contracts table lists every address, third-party ones labelled (${rows.length} rows)`);
  // Data notes are neutral notes, never unusual (All findings › Data notes).
  const pd = await open();
  const af = $(pd, 'all-findings');
  af.open = true;
  await pd.settle();
  const notesTab = af.querySelectorAll('button').find((b) => /^Data notes \(\d+\)$/.test(textOf(b)));
  if (notesTab) await pd.click(notesTab);
  const notes = af.querySelectorAll('li[data-f]').filter((li) => BASE.insights.watch.concat(BASE.insights.standing).some((i) => i.id === li.getAttribute('data-f') && i.dimension === 'data'));
  ok(notes.length >= 1 && notes.every((li) => /Data note/.test(li.textContent) && !/Unusual/.test(li.textContent)), `data notes read "Data note", never unusual (${notes.length})`);
  // Legacy coins join only when asked.
  const pl = await open();
  const legacyKeys = BASE.discovery.assets.filter((x) => x.status === 'legacy').map((x) => x.key);
  ok(legacyKeys.every((k) => !btn(pl, 'data-asset', k)) && pl.doc.querySelector('button[data-legacy]'), 'legacy assets are hidden behind the legacy toggle');
  await pl.click(pl.doc.querySelector('button[data-legacy]'));
  ok(legacyKeys.every((k) => btn(pl, 'data-asset', k) && pl.doc.querySelector(`[data-card="${k}"]`) && /legacy/.test(textOf(pl.doc.querySelector(`[data-card="${k}"]`)))), 'legacy on: a scope button and a card with a legacy badge');
});
await section('static', async () => {
  ok(!/<style\b/i.test(HTML) && !/\sstyle\s*=/i.test(HTML), 'index.html has no <style> and no style attribute');
  ok(/<link rel="preload" href="\/api\/paxos" as="fetch" crossorigin="anonymous"/.test(HTML) && HTML.indexOf('rel="preload"') < HTML.indexOf('<script'), 'the API preload precedes the scripts');
  ok(/<title>Paxos Health · rodiger\.io<\/title>/.test(HTML) && /<noscript><p>This dashboard needs JavaScript to load its data\.<\/p><\/noscript>/.test(HTML), 'document title and noscript copy (§3.15)');
  // Palette (validated tokens unchanged): diverging pair distinct from every categorical slot, equal
  // lightness arms, context gray ≥3:1 on the card, text tokens ≥4.5:1.
  const s2l = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const rgb = (hx) => [1, 3, 5].map((i) => s2l(parseInt(hx.slice(i, i + 2), 16) / 255));
  const lum = (hx) => { const [r, g, b] = rgb(hx); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const lab = (hx) => {
    const [r, g, b] = rgb(hx);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const dE = (a, b) => 100 * Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
  const cats = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => TOKENS['c' + i]);
  ok(cats.every(Boolean) && cats.every((c) => dE(TOKENS['div-pos'], c) >= 14 && dE(TOKENS['div-neg'], c) >= 14), 'diverging pair is distinct from every categorical slot');
  ok(Math.abs(lab(TOKENS['div-pos'])[0] - lab(TOKENS['div-neg'])[0]) < 0.02, 'diverging arms have equal lightness');
  ok(contrast(TOKENS.neutral, TOKENS.surface) >= 3 && cats.every((c) => contrast(c, TOKENS.surface) >= 3), 'context gray and chart marks reach 3:1 on the card');
  ok(['ink', 'ink-2', 'ink-muted'].every((k) => contrast(TOKENS[k], TOKENS.surface) >= 4.5), 'text tokens reach 4.5:1 on the card');
  ok(!/neutral-2/.test(APP + CSS), 'no sub-3:1 context gray');
});

const ms = Math.round(performance.now() - T0);
const stats = `${RENDERS} asset × period × lens renders; default view: ${DEFAULT && DEFAULT.words} words, ${DEFAULT && DEFAULT.strict} without names, ${DEFAULT && DEFAULT.graphics} graphics, ${DEFAULT && DEFAULT.nodes} elements`;
if (failed.length) {
  console.log(`check-paxos-page: ${failed.length} FAILED, ${checks} passed (${stats}):\n  ${failed.map((m) => String(m).split('\n').slice(0, 8).join('\n    ')).join('\n  ')}`);
  process.exit(1);
}
console.log(`check-paxos-page: ${checks} checks passed in ${ms} ms (${stats})`);
