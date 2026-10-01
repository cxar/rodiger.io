#!/usr/bin/env node
// Offline regression checks for the Paxos dashboard page (pages/paxos/app.js + index.html).
// Builds the payload from the recorded fixture, then:
//   1. runs app.js's pure helpers in a vm (coverage start, net issuance, freshness, chain counts, ...)
//   2. renders the whole page under a small DOM shim (compound selectors only, like the dashboard
//      check's shim) for every asset filter and range, and for payload variants (older payloads
//      without the optional fields, newer ones with them, degraded sources, a stale CDN copy), and
//      checks the rendered text and the keyboard focus after each interaction.
// No network: every upstream request is answered from scripts/fixtures/paxos/upstream.json.gz.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createFixtureFetch, loadFixture } from './fixtures/paxos/fixture-fetch.mjs';

const require = createRequire(import.meta.url);
const T0 = performance.now();
const here = (p) => new URL(p, import.meta.url).pathname;
const read = (p) => fs.readFileSync(here(p), 'utf8');
let checks = 0;
// PAXOS_CHECK_KEEP_GOING=1 lists every failing check instead of stopping at the first (for mutation runs).
const failed = [];
const ok = (cond, msg) => {
  if (process.env.PAXOS_CHECK_KEEP_GOING === '1' && !cond) return void failed.push(msg);
  assert.ok(cond, msg);
  checks++;
};
async function section(name, fn) {
  try {
    await fn();
  } catch (e) {
    if (process.env.PAXOS_CHECK_KEEP_GOING !== '1') throw e;
    failed.push(`${name}: ${e.message}`);
  }
}
const APP = read('../pages/paxos/app.js');
const HTML = read('../pages/paxos/index.html');
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// ---------- payload from the fixture ----------
const { buildPaxosHealth } = require('../lib/paxos/index.js');
const { createCache } = require('../lib/paxos/cache.js');
const fixture = loadFixture();
const NOW = fixture.now;
const { payload: BASE } = await buildPaxosHealth({ fetch: createFixtureFetch(fixture), now: NOW, cache: createCache(), clock: () => NOW * 1000 + 5000, memoize: false, log: () => {} });
const clone = () => JSON.parse(JSON.stringify(BASE));
const GEN_MS = Date.parse(BASE.generatedAt);

// ---------- 1. pure helpers ----------
function helpersCtx(src) {
  const ctx = { window: {}, console, URL, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'app.js' });
  return ctx.window.PaxosDashboard;
}
// Expectations come from the page's own helpers; a mutation run may take them from a reference copy
// (PAXOS_PAGE_REF_APP=<path>) so the rendered page under test is judged by the fixed rules.
const D = helpersCtx(process.env.PAXOS_PAGE_REF_APP ? fs.readFileSync(process.env.PAXOS_PAGE_REF_APP, 'utf8') : APP);
const day = (start, i) => D.addDays(start, i);

// coverageStart (#4): a one-day jump larger than every later weekly move is a coverage step.
await section('coverageStart (#4): a one-day jump larger than every later weekly move is a coverage step.', async () => {
  const n = 1200;
  const grow = (i) => 1e9 * Math.exp(0.0015 * i + 0.004 * Math.sin(i / 3));
  const smooth = { start: '2020-01-01', values: Array.from({ length: n }, (_, i) => grow(i)) };
  ok(D.coverageStart(smooth) === null, 'coverageStart: a total without steps is used in full');
  const stepped = { start: '2020-01-01', values: smooth.values.map((v, i) => (i >= 200 ? v : v / 1.3)) };
  ok(D.coverageStart(stepped) === day('2020-01-01', 200), `coverageStart finds a +30% one-day step (${D.coverageStart(stepped)})`);
  const late = { start: '2020-01-01', values: smooth.values.map((v, i) => (i >= n - 100 ? v * 1.3 : v)) };
  ok(D.coverageStart(late) === null, 'coverageStart never judges a day with less than a year of later history');
  const mk = BASE.market.usdTotal;
  const cov = D.coverageStart(mk);
  ok(typeof cov === 'string' && cov > mk.start, `coverageStart on the fixture's DefiLlama USD total: ${cov}`);
  // The server applies the same rule and clips the published share there (no 2018 artefact for API users).
  ok(BASE.market.coverageFrom === cov, `server market.coverageFrom (${BASE.market.coverageFrom}) equals the page rule (${cov})`);
  const share = BASE.totals.usd.marketShare;
  ok(share.values.every((v, i) => !isNum(v) || day(share.start, i) >= cov), `totals.usd.marketShare has no value before the coverage start (starts ${share.start})`);
  // ...and the clip matters: the unclipped share (supply / market total) peaks far higher before it.
  const sup = BASE.totals.usd.supplyUsd;
  const raw = sup.values.map((v, i) => { const m = D.compactAt(mk, day(sup.start, i)); return isNum(v) && isNum(m) && m > 0 ? { d: day(sup.start, i), s: v / m } : null; }).filter(Boolean);
  const peak = (f) => Math.max(...raw.filter(f).map((x) => x.s));
  ok(peak((x) => x.d >= cov) < peak((x) => x.d < cov) / 2, `unclipped share peaks at ${(peak((x) => x.d < cov) * 100).toFixed(2)}% before the coverage start, ${(peak((x) => x.d >= cov) * 100).toFixed(2)}% after`);
});

// bucketChanges / netIssuance (#5): an opening balance is issuance only at launch.
await section('bucketChanges / netIssuance (#5): an opening balance is issuance only at launch.', async () => {
  const c = { start: '2025-07-12', values: Array.from({ length: 60 }, (_, i) => 352 - i) };
  const m = D.bucketChanges(c, '2025-07-01', '2025-09-09', 'month');
  ok(m[0].value === null && m[0].opening === true, 'a series that starts late books no issuance in its first bucket');
  ok(m[1].value === c.values[c.values.length - 1 - 9] - c.values[19] || isNum(m[1].value), 'later buckets are flows');
  const l = D.bucketChanges(c, '2025-07-01', '2025-09-09', 'month', { launch: true });
  ok(l[0].value === c.values[19] && l[0].launch, 'a series that starts at launch books its opening balance as issuance');
  ok(D.startsAtLaunch(c, '2025-07-12') && !D.startsAtLaunch(c, '2024-11-05') && D.startsAtLaunch({ start: '2025-07-12', values: [0, 5] }, '2024-01-01'), 'startsAtLaunch compares the series start with the asset first date');
  const other = { start: '2025-01-01', values: Array.from({ length: 251 }, (_, i) => 1000 + i) };
  const net = D.netIssuance([{ key: 'A', c: other, launch: true }, { key: 'B', c, launch: false }], '2025-07-01', '2025-09-08', 'month');
  ok(net[0].excluded.join() === 'B' && net[0].value === D.compactAt(other, '2025-07-31') - D.compactAt(other, '2025-06-30'), 'net issuance across members leaves out a member\'s opening balance and names it');
});

// Freshness (#16, #22, decision 6)
await section('Freshness (#16, #22, decision 6)', async () => {
  const p = { generatedAt: BASE.generatedAt, cache: { sMaxAge: 1800, staleWhileRevalidate: 86400 } };
  ok(D.snapshotAge(p, GEN_MS + 1799e3).current && !D.snapshotAge(p, GEN_MS + 1801e3).current && !D.snapshotAge(p, GEN_MS + 20 * 3600e3).current, 'current only within s-maxage');
  const s = { status: 'ok', ageHours: 0.5, cadenceHours: 1 };
  ok(Math.abs(D.sourceAgeNow(s, p, GEN_MS + 20 * 3600e3) - 20.5) < 1e-9, 'source age is measured now, not at generation');
  ok(D.sourceStatusNow(s, 20.5) === 'stale' && D.sourceStatusNow(s, 1.5) === 'ok' && D.sourceStatusNow({ status: 'partial', cadenceHours: 1 }, 30) === 'partial', 'an ok source older than two cadences reads stale');
});

// Chain counts (#18)
await section('Chain counts (#18)', async () => {
  for (const a of Object.values(BASE.assets)) {
    const addrs = BASE.discovery.addresses.filter((x) => x.asset === a.key);
    const cc = D.chainCount(a, BASE.insights.floorsUsd[a.key], addrs);
    if (a.chains.length) ok(cc.basis === 'balances' && cc.n <= cc.of && cc.n === a.chains.filter((c) => c.currentUsd > 0 && (!isNum(BASE.insights.floorsUsd[a.key]) || c.currentUsd >= BASE.insights.floorsUsd[a.key])).length, `${a.key}: chain count uses balances at or above the floor (${cc.n} of ${cc.of})`);
    else if (addrs.length || a.onchain.length) ok(cc.basis === 'contracts' && cc.n > 0, `${a.key}: no DefiLlama chains, chain count from contracts / on-chain readings (${cc.n})`);
  }
});

// Small helpers (#47)
await section('Small helpers (#47)', async () => {
  const keys = BASE.discovery.assets.map((d) => d.key);
  ok(D.canonicalAsset(keys[0].toLowerCase(), keys) === keys[0] && D.canonicalAsset('all', keys) === 'all' && D.canonicalAsset('no-such', keys) === null, 'asset keys match case-insensitively');
  ok(D.fmtTick('2025-10-02', 365) === 'Oct ’25' && D.fmtTick('2025-10-02', 60) === '2 Oct', 'month ticks read "Oct ’25", not "Oct 25"');
  const labels = D.alignCompacts([BASE.totals.usd.supplyUsd], BASE.totals.usd.supplyUsd.start, D.compactEnd(BASE.totals.usd.supplyUsd)).dates;
  const plan = D.tickPlan(labels, labels.length, 7);
  const years = [...plan].map((i) => labels[i].slice(0, 4));
  ok(plan.size >= 2 && plan.size <= 7 && new Set(years).size === years.length, `year ticks are unique (${years.join(' ')})`);
  ok(D.ageText({ ageDays: 5 }) === 'for 5 days' && D.ageText({ ageDays: 1 }) === 'for 1 day', 'age badge reads "for N days"');
  ok(D.fmtEvidence(1137000, D.evidenceUnit({ metric: 'expected latest label - actual latest label (s)' })) === '13 d' && D.fmtEvidence(-130900000, 'USD') === '−$130.9M' && D.fmtEvidence(1137000, null) === '1.1M', 'evidence values are formatted with their unit');
});

// ---------- 2. DOM shim ----------
const VOID = new Set(['meta', 'link', 'br', 'img', 'input', 'hr', 'source']);
class Ev {
  constructor(type, o = {}) {
    this.type = type;
    this.bubbles = !!o.bubbles;
    this.defaultPrevented = false;
    this.target = null;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}
class N {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this.listeners = {};
  }
  get parentElement() { return this.parentNode instanceof El ? this.parentNode : null; }
  get isConnected() {
    for (let n = this; n; n = n.parentNode) if (n === this.ownerDocument) return true;
    return false;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get children() { return this.childNodes.filter((x) => x instanceof El); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    this.clear();
    if (v !== '' && v !== null && v !== undefined) this.appendChild(new T(this.ownerDocument, String(v)));
  }
  clear() {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
  }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    this.childNodes.push(n);
    n.parentNode = this;
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
    n.parentNode = this;
    return n;
  }
  node(x) { return x instanceof N ? x : new T(this.ownerDocument, String(x)); }
  append(...xs) { for (const x of xs) this.appendChild(this.node(x)); }
  prepend(...xs) { for (const x of xs.reverse()) this.insertBefore(this.node(x), this.firstChild); }
  replaceChildren(...xs) {
    this.clear();
    this.append(...xs);
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) {
    for (; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    for (let n = this; n; n = n.parentNode) {
      for (const f of [...(n.listeners[ev.type] || [])]) f.call(n, ev);
      if (!ev.bubbles || ev.stopped) break;
    }
    return !ev.defaultPrevented;
  }
  querySelectorAll(sel) {
    const m = compile(sel);
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) if (c instanceof El) {
        if (m(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
class T extends N {
  constructor(doc, data) {
    super(doc);
    this.data = data;
  }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}
const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
class El extends N {
  constructor(doc, tag) {
    super(doc);
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    const style = {};
    style.setProperty = (k, v) => (style[camel(k)] = v);
    this.style = style;
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  hasAttribute(k) { return this.attrs.has(k); }
  toggleAttribute(k, f) {
    const on = f === undefined ? !this.hasAttribute(k) : !!f;
    if (on) this.setAttribute(k, '');
    else this.removeAttribute(k);
    return on;
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c) => list().includes(c),
      add: (...cs) => (el.className = [...new Set([...list(), ...cs])].join(' ')),
      remove: (...cs) => (el.className = list().filter((x) => !cs.includes(x)).join(' ')),
      toggle: (c, f) => {
        const on = f === undefined ? !list().includes(c) : !!f;
        el.className = (on ? [...new Set([...list(), c])] : list().filter((x) => x !== c)).join(' ');
        return on;
      },
    };
  }
  get dataset() {
    const el = this;
    return new Proxy({}, {
      get: (_, k) => (typeof k === 'string' && el.hasAttribute('data-' + kebab(k)) ? el.getAttribute('data-' + kebab(k)) : undefined),
      set: (_, k, v) => (el.setAttribute('data-' + kebab(k), v), true),
      has: (_, k) => el.hasAttribute('data-' + kebab(k)),
    });
  }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { this.toggleAttribute('hidden', !!v); }
  get open() { return this.hasAttribute('open'); }
  set open(v) { this.toggleAttribute('open', !!v); }
  matches(sel) { return compile(sel)(this); }
  closest(sel) {
    const m = compile(sel);
    for (let n = this; n instanceof El; n = n.parentNode) if (m(n)) return n;
    return null;
  }
  focus() {
    this.ownerDocument._active = this;
    this.dispatchEvent(new Ev('focusin', { bubbles: true }));
  }
  blur() { if (this.ownerDocument._active === this) this.ownerDocument._active = null; }
  click() { this.dispatchEvent(new Ev('click', { bubbles: true })); }
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; }
}
class Doc extends N {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.readyState = 'complete';
    this.visibilityState = 'visible';
    this._active = null;
  }
  get documentElement() { return this.children[0]; }
  get body() { return this.documentElement.children.find((c) => c.tagName === 'BODY'); }
  get activeElement() { return this._active && this._active.isConnected ? this._active : this.body; }
  createElement(tag) { return new El(this, tag); }
  createElementNS(_ns, tag) { return new El(this, tag); }
  createTextNode(s) { return new T(this, s); }
  getElementById(id) { return this.querySelectorAll(`#${id}`)[0] || null; }
}
// Compound selectors and comma lists only (tag, #id, .class, [attr], [attr="v"]); anything else throws,
// so the page stays within what the dashboard check's shim supports.
const cache = new Map();
function compile(sel) {
  if (cache.has(sel)) return cache.get(sel);
  const parts = sel.split(',').map((x) => x.trim()).map((one) => {
    const re = /^([a-zA-Z][\w-]*|\*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:=(?:"[^"]*"|'[^']*'|[\w-]+))?\])*)$/;
    const m = re.exec(one);
    if (!m) throw new Error(`shim: unsupported selector "${one}"`);
    const tag = m[1] && m[1] !== '*' ? m[1].toUpperCase() : null;
    const tests = [...m[2].matchAll(/#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([\w-]+)))?\]/g)].map((t) => {
      if (t[1]) return (el) => el.id === t[1];
      if (t[2]) return (el) => el.classList.contains(t[2]);
      const v = t[4] ?? t[5] ?? t[6];
      return v === undefined ? (el) => el.hasAttribute(t[3]) : (el) => el.getAttribute(t[3]) === v;
    });
    return (el) => (!tag || el.tagName === tag) && tests.every((f) => f(el));
  });
  const fn = (el) => parts.some((f) => f(el));
  cache.set(sel, fn);
  return fn;
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', larr: '←', rarr: '→', middot: '·', nbsp: ' ' };
const decode = (s) => s.replace(/&(#\d+|[a-z]+);/g, (x, e) => (e[0] === '#' ? String.fromCharCode(+e.slice(1)) : ENT[e] ?? x));
function parseHtml(doc, html) {
  const body = /<body([^>]*)>([\s\S]*)<\/body>/.exec(html);
  const root = doc.createElement('html');
  doc.appendChild(root);
  root.appendChild(doc.createElement('head'));
  const b = doc.createElement('body');
  for (const [, k, v] of body[1].matchAll(/([\w-]+)="([^"]*)"/g)) b.setAttribute(k, v);
  root.appendChild(b);
  let cur = b;
  for (const t of body[2].matchAll(/<!--[\s\S]*?-->|<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g)) {
    if (t[1]) cur = cur.parentNode;
    else if (t[2]) {
      const el = doc.createElement(t[2].toLowerCase());
      for (const a of t[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], decode(a[2] ?? ''));
      cur.appendChild(el);
      if (!VOID.has(t[2].toLowerCase())) cur = el;
    } else if (t[4] && t[4].trim()) cur.appendChild(doc.createTextNode(decode(t[4])));
  }
  return doc;
}
const TOKENS = Object.fromEntries([.../:root\s*\{([^}]*)\}/.exec(HTML)[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

const sectionIds = ['s-hero', 's-unusual', 's-changed', 's-health', 's-assets', 's-supply', 's-peers', 's-chains', 's-peg', 's-defi', 's-econ', 's-usage', 's-standing', 's-quality'];
// One page instance: a fresh document + window, app.js executed, first load awaited.
async function page({ payload = clone(), search = '', width = 1200, nowMs = GEN_MS + 60e3, fetchImpl } = {}) {
  const doc = parseHtml(new Doc(), HTML);
  const timers = [];
  const errors = [];
  const store = new Map();
  const win = {
    document: doc,
    Node: N,
    innerWidth: width,
    location: { search, pathname: '/paxos', hash: '' },
    history: { replaceState: (_s, _t, url) => (win.location.search = url.slice(url.indexOf('?'))) },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    getComputedStyle: () => ({ getPropertyValue: (n) => TOKENS[n.replace(/^--/, '')] || '', fontFamily: 'sans-serif' }),
    setTimeout: (f, ms) => (timers.push({ f, ms }), timers.length),
    clearTimeout: () => {},
    setInterval: (f, ms) => (timers.push({ f, ms, every: true }), timers.length),
    requestAnimationFrame: (f) => f(),
    queueMicrotask,
    AbortController,
    URL,
    URLSearchParams,
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(payload)) })),
    console: { ...console, error: (...a) => errors.push(a.map(String).join(' ')), log: () => {} },
  };
  win.window = win;
  win.addEventListener = () => {};
  doc.documentElement.ownerDocument = doc;
  const ctx = vm.createContext(win);
  vm.runInContext(`Date.now = () => ${nowMs};`, ctx);
  vm.runInContext(APP, ctx, { filename: 'app.js' });
  const P = win.PaxosDashboard;
  await P.load();
  const $ = (id) => doc.getElementById(id);
  const text = (id) => ($(id) ? $(id).textContent : '');
  const pg = { win, doc, P, $, text, timers, errors };
  const t = sectionIds.map((id) => text(id)).join('\n');
  ok(!/could not be rendered|could not be drawn/.test(t) && !errors.length, `${search || '(default)'}: every section renders (${errors[0] || ''})`);
  return pg;
}
const allText = (pg) => sectionIds.map((id) => pg.text(id)).join('\n');
// Table-view rows of a figure: the table inside the details[data-k="tv:<key>"].
function tableRows(pg, key) {
  const d = pg.doc.querySelectorAll('details').find((x) => x.dataset.k === 'tv:' + key);
  if (!d) return null;
  return d.querySelectorAll('tr').slice(1).map((tr) => tr.children.map((c) => c.textContent));
}
const figureSub = (pg, key) => {
  const d = pg.doc.querySelectorAll('details').find((x) => x.dataset.k === 'tv:' + key);
  const fig = d && d.closest('figure');
  return fig ? fig.querySelector('figcaption').textContent : '';
};

// Every asset filter x range renders without a section failure.
const keys = BASE.discovery.assets.map((d) => d.key);
for (const asset of ['all', ...keys]) {
  for (const range of D.RANGES.map((r) => r.id)) {
    const pg = await page({ search: `?asset=${encodeURIComponent(asset)}&range=${range}&legacy=1` });
    const t = allText(pg);
    ok(!/could not be rendered|could not be drawn/.test(t) && !pg.errors.length, `${asset} ${range}: every section renders (${pg.errors[0] || ''})`);
    ok(!/NaN|undefined|\[object Object\]/.test(t), `${asset} ${range}: no NaN/undefined in the page text`);
  }
}

// #4: the share line starts at the coverage start, and says why.
await section('#4: the share line starts at the coverage start, and says why.', async () => {
  const cov = D.coverageStart(BASE.market.usdTotal);
  for (const asset of ['all', ...keys.filter((k) => BASE.assets[k].unit === 'USD' && BASE.assets[k].series.supplyUsd && BASE.assets[k].series.supplyUsd.start < cov)]) {
    const pg = await page({ search: `?asset=${asset}&range=all` });
    const rows = tableRows(pg, 'share');
    const oldest = rows[rows.length - 1][0];
    ok(oldest >= cov, `${asset}: market share starts at the coverage start ${cov} (oldest row ${oldest})`);
    ok(/Shown from/.test(figureSub(pg, 'share')), `${asset}: the share chart explains its start`);
  }
  const withServer = clone();
  withServer.market.coverageFrom = D.addDays(cov, 30);
  const pg = await page({ payload: withServer, search: '?asset=all&range=all' });
  const rows = tableRows(pg, 'share');
  ok(rows[rows.length - 1][0] >= withServer.market.coverageFrom, 'a server-sent market.coverageFrom wins over the client rule');
  const pg90 = await page({ search: '?asset=all&range=90d' });
  ok(!/Shown from/.test(figureSub(pg90, 'share')), 'a range that starts after the coverage start is not annotated');
});

// #5: no bucket books a late-starting series' opening balance as issuance.
await section('#5: no bucket books a late-starting series\' opening balance as issuance.', async () => {
  const late = BASE.discovery.assets.filter((d) => {
    const a = BASE.assets[d.key];
    const s = a.unit === 'USD' ? a.series.supplyUsd : a.series.supply || a.series.supplyUsd;
    return s && !D.startsAtLaunch(s, d.firstDate);
  });
  ok(late.length > 0, `the fixture has late-starting supply series (${late.map((d) => d.key).join(', ')})`);
  for (const d of late) {
    const a = BASE.assets[d.key];
    const s = a.unit === 'USD' ? a.series.supplyUsd : a.series.supply || a.series.supplyUsd;
    const first = D.compactFirst(s);
    const pg = await page({ search: `?asset=${d.key}&range=all&legacy=1` });
    const rows = tableRows(pg, 'net-issuance');
    const oldest = rows[rows.length - 1];
    const lastDayOfOldest = D.compactAt(s, oldest[0]);
    ok(oldest[0] > first.date && isNum(lastDayOfOldest), `${d.key}: the first net-issuance bucket ends after the series opens (${oldest[0]} > ${first.date})`);
    ok(!rows.some((r) => r[1] === D.fmtUnit(D.compactAt(s, r[0]), a.unit === 'USD' ? 'USD' : a.unit, { signed: true })), `${d.key}: no bucket equals the level it ends at (an opening balance booked as issuance)`);
  }
  const lateActive = late.filter((d) => BASE.totals.usd.assets.includes(d.key));
  if (lateActive.length) {
    const pg = await page({ search: '?asset=all&range=all' });
    const rows = tableRows(pg, 'net-issuance');
    for (const d of lateActive) {
      const opens = D.compactFirst(BASE.assets[d.key].series.supplyUsd).date;
      const row = rows.slice().reverse().find((r) => r[0] >= opens); // rows are newest first
      ok(row && row[2].includes(d.key), `All Paxos: the bucket where ${d.key} opens (${row && row[0]}) excludes its opening balance and says so`);
    }
  }
});

// #15: focus survives re-renders.
await section('#15: focus survives re-renders.', async () => {
  const pg = await page({ search: '?asset=all&range=90d' });
  const filterBtn = (attr, v) => pg.$('filters').querySelectorAll('button').find((b) => b.getAttribute(attr) === v);
  const target = filterBtn('data-asset', keys[0]);
  target.focus();
  target.click();
  let a = pg.doc.activeElement;
  ok(a !== target && a.getAttribute('data-asset') === keys[0] && a.closest('#filters') && a.getAttribute('aria-pressed') === 'true', 'focus stays on the asset filter button after it re-renders');
  const r = filterBtn('data-range', '1y');
  r.focus();
  r.click();
  a = pg.doc.activeElement;
  ok(a.getAttribute('data-range') === '1y' && a.getAttribute('aria-pressed') === 'true', 'focus stays on the range button after it re-renders');
  const refresh = pg.$('refresh');
  refresh.focus();
  refresh.click();
  await pg.P.load();
  ok(pg.doc.activeElement === refresh && refresh.isConnected, 'the Refresh button is never rebuilt, so it keeps focus');
  const pill = pg.doc.querySelectorAll('.pill')[0];
  pill.focus();
  pg.P.renderHeader();
  ok(pg.doc.activeElement === pill, 'the minute tick does not rebuild focusable source pills');
  const tile = (await page({ search: '?asset=all' })).doc;
  const tbtn = tile.querySelectorAll('button').find((b) => b.classList.contains('tile'));
  tbtn.focus();
  tbtn.click();
  ok(tile.activeElement.closest('#filters') && tile.activeElement.getAttribute('data-asset') === tbtn.getAttribute('data-asset'), 'choosing an asset from a tile moves focus to its filter button');
  const pg2 = await page({ payload: (() => { const x = clone(); const lead = x.insights.feed[0]; for (let i = 0; i < 8; i++) x.insights.feed.push({ ...x.insights.feed[0], rootKey: 'dup' + i, lead: { ...lead, id: lead.id + ':dup' + i, dimension: lead.dimension === 'data' ? 'supply' : lead.dimension, detector: 'supply.move' }, related: [] }); return x; })() });
  const more = pg2.doc.querySelectorAll('button').find((b) => b.getAttribute('data-more') === 'feed');
  ok(more, 'feed has a "show all" button');
  more.focus();
  more.click();
  ok(pg2.doc.activeElement.getAttribute('data-more') === 'feed' && pg2.doc.activeElement.getAttribute('aria-expanded') === 'true', 'focus stays on "show all" after expanding');
});

// #16 / #22: freshness and live source ages.
await section('#16 / #22: freshness and live source ages.', async () => {
  const fresh = await page({ nowMs: GEN_MS + 5 * 60e3 });
  ok(/Current snapshot/.test(fresh.text('status')), 'a 5-minute-old snapshot is current');
  const stalePg = await page({ nowMs: GEN_MS + 20 * 3600e3 });
  const st = stalePg.text('status');
  ok(/Snapshot from/.test(st) && !/Current snapshot/.test(st), `a 20-hour-old snapshot is not labelled current (${st.slice(0, 90)})`);
  ok(stalePg.timers.some((t) => !t.every && t.ms <= 10e3), 'a stale snapshot schedules a prompt refetch');
  const src = BASE.sources.find((s) => isNum(s.ageHours) && isNum(s.cadenceHours));
  const ageEl = stalePg.doc.querySelectorAll('[data-src-age]').find((x) => x.getAttribute('data-src-age') === src.id);
  ok(ageEl && ageEl.textContent.startsWith(D.fmtHours(src.ageHours + 20)), `source ages count the snapshot's age (${ageEl && ageEl.textContent})`);
  const ok1 = BASE.sources.find((s) => s.status === 'ok' && isNum(s.cadenceHours) && s.cadenceHours * 2 < 20);
  if (ok1) {
    const stEl = stalePg.doc.querySelectorAll('[data-src-status]').find((x) => x.getAttribute('data-src-status') === ok1.id);
    ok(/stale/.test(stEl.textContent) && /was ok/.test(stEl.textContent), `${ok1.id} reads stale 20 h later (was ok when generated)`);
  }
});

// #17: Coin Metrics charts name the chain they cover.
await section('#17: Coin Metrics charts name the chain they cover.', async () => {
  for (const k of keys.filter((k) => BASE.assets[k].activity)) {
    const pg = await page({ search: `?asset=${k}&legacy=1` });
    const act = BASE.assets[k].activity;
    const suffix = /_([a-z0-9]+)$/i.exec(act.key);
    const titles = pg.doc.querySelectorAll('figcaption').map((f) => f.textContent).filter((t) => t.startsWith(k) && /per day/.test(t));
    if (act.chain || suffix) ok(titles.length && titles.every((t) => / on [^:]+:/.test(t)), `${k}: activity charts name their chain (${titles[0]})`);
    else ok(titles.length && pg.text('s-usage').includes('chains it covers are not stated'), `${k}: activity charts say their chain coverage is not stated`);
  }
});

// #64: the feed says how many findings per load can be chance (one per counted dimension at most).
await section('#64: the feed says how many findings per load can be chance.', async () => {
  const fam = BASE.insights.family;
  ok(fam && isNum(fam.dimensions) && fam.dimensions > 0 && fam.dimensions <= BASE.insights.health.dimensions.length && fam.counted <= BASE.insights.testsRun, `insights.family is sent (${JSON.stringify(fam)})`);
  const pg = await page({ search: '?asset=all' });
  const sub = pg.text('sub-unusual');
  ok(new RegExp(`about ${fam.dimensions} findings? per load can be chance`).test(sub) && !/statistically rare/.test(sub), `feed subtitle states the chance count (${sub.slice(-90)})`);
  const old = clone();
  delete old.insights.family;
  const pg2 = await page({ payload: old, search: '?asset=all' });
  ok(!/can be chance/.test(pg2.text('sub-unusual')), 'an older payload without insights.family renders without the count');
});

// #33: third-party contracts are labelled in the registry and never stand for an asset's own chains.
await section('#33: third-party contracts are labelled and not counted as the asset\'s chains.', async () => {
  const third = BASE.discovery.addresses.filter((x) => x.role === 'bridged' || x.role === 'unlisted');
  ok(third.length > 0 && BASE.discovery.addresses.every((x) => ['issuer', 'unverified', 'bridged', 'unlisted'].includes(x.role)), `every registry address has a role (${third.length} third-party on the fixture)`);
  const pg = await page({ search: '?asset=all&legacy=1' });
  const reg = pg.doc.querySelectorAll('details').find((d) => d.dataset.k === 'addresses');
  const rows = reg.querySelectorAll('tr').slice(1).map((tr) => tr.children.map((c) => c.textContent));
  for (const x of third) ok(rows.some((r) => r[2] === x.address && /third-party|not in issuer docs/.test(r[3])), `${x.asset} ${x.chain} ${x.role} contract is labelled in the registry`);
  const holders = pg.doc.querySelectorAll('table').find((t) => /Holders/.test(t.querySelector('tr').textContent) && /Token supply/.test(t.querySelector('tr').textContent));
  const na = holders ? holders.querySelectorAll('tr').slice(1).map((tr) => tr.children.map((c) => c.textContent)).filter((r) => /not available/.test(r[4])) : [];
  for (const r of na) {
    const a = BASE.assets[r[1]] || Object.values(BASE.assets).find((x) => r[1].startsWith(x.key));
    const issuerChains = BASE.discovery.addresses.filter((x) => x.asset === a.key && !(x.role === 'bridged' || x.role === 'unlisted')).map((x) => x.chain);
    const floor = BASE.insights.floorsUsd[a.key];
    const material = a.chains.filter((c) => c.currentUsd > 0 && (!isNum(floor) || c.currentUsd >= floor)).map((c) => c.chain);
    ok(issuerChains.includes(r[0]) || material.includes(r[0]), `${a.key} ${r[0]}: a "not available" holders row is an issuer or material chain, not a third-party contract's`);
  }
});

// #46: the hero verdict counts the health grid exactly: notable cells, cells within their own history and
// cells with too little history are reported apart (data quality is never counted as asset health).
await section('#46: the hero verdict matches the health grid.', async () => {
  const pg = await page({ search: '?asset=all' });
  const verdict = (/Health checks:[^\n]*?\.(?: Data quality:[^\n]*?\))?/.exec(pg.text('s-hero')) || [''])[0];
  const hg = BASE.insights.health;
  const rows = hg.assets.filter((a) => a === BASE.totals.usd.key || BASE.discovery.assets.some((d) => d.key === a && d.status === 'active'));
  const cells = rows.flatMap((a) => hg.dimensions.filter((d) => d !== 'data').map((d) => hg.cells[a][d]).filter((c) => c && c.tests > 0));
  const thin = cells.filter((c) => c.state === 'insufficient_history').length, normal = cells.filter((c) => c.state === 'within_own_history').length;
  ok(new RegExp(`\\b${normal} asset-dimension pairs? (is|are) within their own history`).test(verdict), `verdict counts ${normal} normal cells (${verdict})`);
  ok(!thin || new RegExp(`${thin} ha(s|ve) too little history`).test(verdict), `verdict counts ${thin} thin cells apart`);
});

// #18: the asset table never states 0 chains for an asset that has contracts.
await section('#18: the asset table never states 0 chains for an asset that has contracts.', async () => {
  const pg = await page({ search: '?legacy=1' });
  for (const tr of pg.$('s-assets').querySelectorAll('tr').slice(1)) {
    const key = tr.children[0].textContent.split(':')[0].replace(/\s.*$/, '');
    const a = BASE.assets[key.replace(/(legacy|dead)$/, '')];
    const cell = tr.children[11].textContent;
    if (a && !a.chains.length && (a.onchain.length || BASE.discovery.addresses.some((x) => x.asset === a.key))) ok(/^[1-9]/.test(cell) && /contracts/.test(cell), `${a.key}: chains column counts contract chains (${cell})`);
  }
});

// #41: the supply subtitle mentions a gray legacy group only when one is drawn.
await section('#41: the supply subtitle mentions a gray legacy group only when one is drawn.', async () => {
  const off = await page({ search: '?asset=all' });
  ok(!/gray/.test(off.text('sub-supply')), 'no gray legacy group is claimed when legacy assets are hidden');
  const legacyUsd = BASE.discovery.assets.filter((d) => d.kind === 'usd-stablecoin' && d.status !== 'active' && BASE.assets[d.key].series.supplyUsd);
  if (legacyUsd.length) {
    const on = await page({ search: '?asset=all&legacy=1' });
    ok(/gray/.test(on.text('sub-supply')) && legacyUsd.every((d) => tableRows(on, 'supply-stack') && on.doc.querySelectorAll('details').find((x) => x.dataset.k === 'tv:supply-stack').querySelector('tr').textContent.includes(d.key)), 'with legacy on, legacy USD assets are stacked in gray and the subtitle says so');
  }
});

// #43 / #44 / #47 / decision 2: visible amounts, accessible names, wording, data-quality items.
await section('#43 / #44 / #47 / decision 2: visible amounts, accessible names, wording, data-quality items.', async () => {
  const pg = await page({ search: '?asset=all&legacy=1' });
  const rows = pg.$('s-assets').querySelectorAll('tr').slice(1);
  ok(rows.every((tr) => /\$|oz|n\/a/.test(tr.children[4].textContent)), 'asset table shows the 30d amount, not only a title tooltip');
  ok(!pg.$('s-assets').querySelectorAll('span').some((x) => x.hasAttribute('title') && /^[−+]?\$/.test(x.getAttribute('title'))), 'no USD change lives only in a title attribute');
  const rb = pg.$('f-range').querySelectorAll('button');
  ok(rb.length && rb.every((b) => !b.hasAttribute('aria-label') && b.textContent.startsWith(b.childNodes[0].textContent)), 'range buttons are named by their visible label (plus hidden expansion)');
  ok(pg.doc.querySelectorAll('button').filter((b) => b.classList.contains('tile')).every((b) => !b.hasAttribute('aria-label') && /Show only/.test(b.textContent)), 'hero tiles keep their visible content in their accessible name');
  const t = allText(pg);
  ok(!/since \d+ days?/.test(t), 'no "since N days" badges');
  ok(/\(\d+ rows\)/.test(pg.text('s-health')) && /\(1 row\)/.test((await page({ search: `?asset=${keys[0]}` })).text('s-health')), 'health caption is pluralised');
  ok(!pg.$('s-health').querySelectorAll('button').some((b) => /Unusual$/.test(b.textContent)), 'one label ("Neutral") for the neutral notable state');
  ok(!pg.doc.querySelector('header').querySelectorAll('span').some((x) => x.classList.contains('pill')) && pg.$('s-quality').querySelectorAll('span').some((x) => x.classList.contains('pill')), 'source pills sit in Data quality, below the story');
  const dqCards = pg.$('s-unusual').querySelectorAll('article').filter((x) => x.classList.contains('dq'));
  const allIns = [...BASE.insights.feed.map((c) => c.lead)];
  if (allIns.some((i) => i.dimension === 'data')) ok(dqCards.length && dqCards.every((c) => /Data quality/.test(c.querySelector('div').textContent) && !/Negative|Positive/.test(c.querySelector('div').textContent)), 'data-quality findings are labelled as such, never Negative/Positive');
  const hcData = pg.$('s-health').querySelectorAll('button').filter((b) => b.getAttribute('data-d') === 'data');
  ok(hcData.every((b) => !/Negative|Positive/.test(b.textContent)), 'the data-quality column never shows asset-health polarity');
  const synthetic = clone();
  const dqIns = { ...synthetic.insights.feed[0].lead, id: 'dq-test', detector: 'dq.freshness', dimension: 'data', polarity: 'negative', headline: 'Synthetic data-quality note' };
  synthetic.insights.feed.push({ rootKey: 'dq-test', lead: dqIns, related: [] });
  const k0 = synthetic.insights.health.assets[0];
  synthetic.insights.health.cells[k0].data = { state: 'notable_negative', tests: 1, notable: 1, negative: 1, positive: 0, evidence: 'dq-test' };
  const sp = await page({ payload: synthetic });
  const card = sp.$('s-unusual').querySelectorAll('article').find((x) => x.textContent.includes('Synthetic data-quality note'));
  ok(card && card.classList.contains('dq') && /Data quality/.test(card.textContent) && !/Negative/.test(card.querySelector('div').textContent), 'an older payload\'s negative dq item is still shown as a neutral data-quality note');
  ok(/Data-quality notes/.test(sp.text('s-unusual')) && sp.text('s-unusual').indexOf('Data-quality notes') > sp.text('s-unusual').indexOf(BASE.insights.feed.find((c) => c.lead.dimension !== 'data').lead.headline), 'data-quality notes follow the asset-health findings');
  const cell = sp.$('s-health').querySelectorAll('button').find((b) => b.getAttribute('data-a') === k0 && b.getAttribute('data-d') === 'data');
  ok(/Source note/.test(cell.textContent) && !/Negative/.test(cell.textContent), 'a notable data cell reads "Source note", not Negative');
  ok(/data quality: 1 source note/.test(sp.text('s-health')), 'per-asset summaries count data-quality notes apart from health');
  const agg = BASE.insights.health.assets.filter((x) => !keys.includes(x));
  if (agg.length === 1 && BASE.totals.usd.label) {
    const rowsH = pg.$('s-health').querySelectorAll('tr').slice(1).map((tr) => tr.children[0].textContent);
    ok(rowsH.some((t) => t.startsWith(BASE.totals.usd.label)) && !rowsH.some((t) => t.startsWith(agg[0] + 'aggregate')), `the aggregate row reads "${BASE.totals.usd.label}", not its key (decision 7)`);
  }
  const axis = pg.$('s-chains').querySelectorAll('div').find((x) => x.classList.contains('axis'));
  ok(axis && !axis.querySelectorAll('span').some((x) => x.classList.contains('first')) && axis.querySelectorAll('span').some((x) => x.classList.contains('last') && x.style.left === '100%'), 'heatmap week labels sit at their week\'s end');
  const low = await page({ search: `?asset=${keys[0].toLowerCase()}` });
  ok(low.win.location.search.includes(`asset=${keys[0]}`) && !/not in the current discovery/.test(low.text('status')), '?asset= in lower case selects the asset');
});

// Decision 3 / 4 and #14: optional payload fields, present and absent.
await section('Decision 3 / 4 and #14: optional payload fields, present and absent.', async () => {
  const newer = clone();
  newer.totals.usd.supplyAsOf = `${D.compactEnd(newer.totals.usd.supplyUsd)}T00:00:00.000Z`;
  newer.peers.asOf = BASE.generatedAt;
  const gold = Object.values(newer.assets).find((a) => a.unit !== 'USD' && a.series.supply);
  if (gold) {
    const d = gold.current.supply;
    gold.current.changeNative = { d1: { abs: 1, pct: null }, d7: { abs: 2, pct: null }, d30: { abs: 12345, pct: null }, d90: { abs: 4, pct: null }, d365: null };
    gold.current.athNative = { value: d * 2, date: '2020-01-01' };
    gold.current.drawdownNativePct = -50;
    gold.current.supplyAsOf = newer.totals.usd.supplyAsOf;
  }
  const missingKey = gold ? gold.key : keys[0];
  newer.totals.allUsd = { label: 'All Paxos-issued assets not marked dead (USD)', current: null, coveredUsd: 123e6, missing: [missingKey] };
  const pg = await page({ payload: newer, search: '?asset=all&range=30d' });
  ok(/as of/.test(pg.text('s-hero')) && /as of/.test(pg.text('sub-peers')), 'hero and peers state their snapshot times');
  ok(/≥ \$123\.0M/.test(pg.text('s-hero')) && pg.text('s-hero').includes(`excludes ${missingKey}`), 'an incomplete all-asset total is shown as a lower bound with what it excludes');
  if (gold) {
    const tile = pg.doc.querySelectorAll('button').find((b) => b.classList.contains('tile') && b.getAttribute('data-asset') === gold.key);
    ok(tile.textContent.includes(`+12.3K ${gold.unit}`), `${gold.key} tile uses current.changeNative (${tile.textContent})`);
    const one = await page({ payload: newer, search: `?asset=${gold.key}` });
    ok(/−50\.0%/.test(one.text('s-hero')) && /Value change, 30d \(USD, incl\. price\)/.test(one.text('s-hero')), `${gold.key} hero uses drawdownNativePct and labels the USD change as a value change`);
  }
  const older = clone();
  delete older.totals.usd.supplyAsOf;
  delete older.peers.asOf;
  const op = await page({ payload: older });
  ok(/as of .*\(daily data\)/.test(op.text('s-hero')), 'older payloads fall back to the daily series date');
});

// #38 / #53: missing inputs are named; non-gold non-USD assets are not charted against gold.
await section('#38 / #53: missing inputs are named; non-gold non-USD assets are not charted against gold.', async () => {
  const deg = clone();
  const gold = Object.values(deg.assets).find((a) => a.kind === 'gold');
  for (const a of Object.values(deg.assets)) a.series.turnover7d = null;
  deg.goldRefs = [];
  if (gold) gold.series.xau = null;
  const priceSrc = deg.sources.find((s) => s.kind === 'price');
  priceSrc.status = 'partial';
  if (gold) {
    const pg = await page({ payload: deg, search: `?asset=${gold.key}` });
    ok(/XAU reference price unavailable/.test(pg.text('s-peg')) && pg.text('s-peg').includes(priceSrc.label) && !/No price history for this selection/.test(pg.text('s-peg')), 'gold without an XAU series names the missing reference and the degraded source');
    ok(!/Gray lines/.test(pg.text('sub-peg')), 'the peg-peer sentence only appears with USD panels');
    ok(/Turnover history is not in this snapshot/.test(pg.text('s-usage')), 'a missing turnover chart is replaced by a placeholder');
  }
  const fiat = clone();
  const usd = Object.values(fiat.assets).find((a) => a.unit === 'USD' && a.status === 'active');
  usd.kind = 'fiat-stablecoin';
  usd.unit = 'EUR';
  fiat.discovery.assets.find((d) => d.key === usd.key).kind = 'fiat-stablecoin';
  fiat.discovery.assets.find((d) => d.key === usd.key).unit = 'EUR';
  const fp = await page({ payload: fiat, search: `?asset=${usd.key}` });
  ok(/No peg reference is charted for EUR assets/.test(fp.text('s-peg')) && !/gold/i.test(fp.text('s-peg')), 'a non-USD fiat stablecoin is not charted against gold tokens');
});

// #40: gaps in filled level series are bridged and counted.
await section('#40: gaps in filled level series are bridged and counted.', async () => {
  const gapped = clone();
  const a = Object.values(gapped.assets).find((x) => x.unit !== 'USD' && x.series.supplyUsd) || Object.values(gapped.assets).find((x) => x.series.supplyUsd);
  const v = a.series.supplyUsd.values;
  for (const k of [10, 20, 21]) v[v.length - k] = null;
  const pg = await page({ payload: gapped, search: `?asset=${a.key}&range=90d&legacy=1` });
  ok(/3 missing days bridged/.test(pg.text('s-supply')), `${a.key}: bridged missing days are stated (${pg.text('s-supply').match(/\d+ missing days? bridged/)})`);
});

// Static: CSS and palette (#37, #39, #42, #45).
await section('Static: CSS and palette (#37, #39, #42, #45).', async () => {
  ok(!/\.paxos th \{[^}]*sticky/.test(HTML) && /\.paxos thead th \{[^}]*position: sticky/.test(HTML), 'only column headers are sticky');
  ok(/\.pill \.tip \{[^}]*overflow-wrap: anywhere/.test(HTML) && /\.pill \.tip \{[^}]*calc\(100vw - 32px\)/.test(HTML), 'source tooltips wrap and fit the viewport');
  ok(!/neutral-2/.test(APP + HTML), 'no sub-3:1 context gray');
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
  ok(cats.every((c) => dE(TOKENS['div-pos'], c) >= 14 && dE(TOKENS['div-neg'], c) >= 14), `diverging pair is distinct from every categorical slot (min dE ${Math.min(...cats.flatMap((c) => [dE(TOKENS['div-pos'], c), dE(TOKENS['div-neg'], c)])).toFixed(1)})`);
  ok(Math.abs(lab(TOKENS['div-pos'])[0] - lab(TOKENS['div-neg'])[0]) < 0.02, 'diverging arms have equal lightness');
  ok(contrast(TOKENS.neutral, TOKENS.surface) >= 3, 'context gray reaches 3:1 on the card');
  const pg = await page({ search: '?asset=all&range=1y' });
  ok(/increase.*decrease/s.test(pg.text('s-supply')) && /increase.*decrease/s.test(pg.text('s-changed')), 'sign-coloured charts carry an increase / decrease key');
  ok(/no data/.test(pg.text('s-chains')) && /\.nd \{[^}]*repeating-linear-gradient/.test(HTML), 'no-data heatmap cells are hatched and keyed');
});

const ms = Math.round(performance.now() - T0);
if (failed.length) {
  console.log(`check-paxos-page: ${failed.length} FAILED:\n  ${failed.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-paxos-page: ${checks} checks passed in ${ms} ms`);
