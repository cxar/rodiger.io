#!/usr/bin/env node
// Offline checks for the briefing (lib/paxos/briefing.js, FINAL-SPEC §4.3, §4.7-§4.10, §6.4): the
// verdict and the 3-5 bullets per period, for All and for every asset, on the recorded fixture.
//   1. shape, enums, caps and copy (scripts/fixtures/paxos/contract-v2.mjs validateBriefing), the
//      payload's own attachment (buildPayload), determinism, no clock
//   2. reconciliation: state and mover values equal totals.usd.change[w] and attribution.windows[w]
//   3. targeting: insight tiers and the verdict's items recomputed independently from the payload (§4.3
//      business floor and peer bar, §4.7 F units, §4.9 levels); nothing from watch, past, data notes or
//      legacy assets reaches the All-scope verdict or bullets
//   4. today's output (§4.8, §4.10) on the fixture
//   5. hardening: the damaged-payload set (insights empty or null, attribution null, market null, no peg
//      peers, no gold, change null, a feed of legacy + data notes only), H3 and H4 fixture variants, a
//      newly discovered asset, malformed input never throws
//   6. replay: the fixture model truncated to earlier days (6 sampled days; PAXOS_REPLAY=31 for all 31),
//      each built into a payload: no briefing.errors, every contract rule, every insight title (H5)
// No network. PAXOS_CHECK_KEEP_GOING=1 lists every failure instead of stopping at the first.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixtureFetch, loadFixture } from './fixtures/paxos/fixture-fetch.mjs';
import * as C from './fixtures/paxos/contract-v2.mjs';

const require = createRequire(import.meta.url);
const T0 = performance.now();
let checks = 0;
const failed = [];
const KEEP_GOING = process.env.PAXOS_CHECK_KEEP_GOING === '1';
const ok = (cond, msg) => { if (KEEP_GOING && !cond) return void failed.push(msg); assert.ok(cond, msg); checks++; };
async function section(name, fn) {
  try { await fn(); } catch (e) { if (!KEEP_GOING) throw e; failed.push(`${name}: ${e.message.split('\n').slice(0, 4).join(' | ')}`); }
}
const none = (errs, label) => ok(!errs.length, `${label} (${errs.length} errors):\n  ${errs.slice(0, 15).join('\n  ')}`);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clone = (x) => JSON.parse(JSON.stringify(x));

const B = require('../lib/paxos/briefing.js');
const E = require('../lib/paxos/engine.js');
const D = require('../lib/paxos/detectors.js');
const { buildPaxosHealth } = require('../lib/paxos/index.js');
const { createCache } = require('../lib/paxos/cache.js');
const { collectRaw } = require('../lib/paxos/sources.js');
const { buildModel } = require('../lib/paxos/model.js');
const { buildPayload, tokenFlowView } = require('../lib/paxos/payload.js');
const { attribution } = require('../lib/paxos/attribution.js');

const fixture = loadFixture();
const NOW = fixture.now;
const { payload: P } = await buildPaxosHealth({ fetch: createFixtureFetch(fixture), now: NOW, cache: createCache(), clock: () => NOW * 1000 + 5000, memoize: false, log: () => {} });
const WINDOWS = Object.keys(C.FRAMES);
const AGG = P.totals.usd.key;
const scopesOf = (b) => [['all', b], ...Object.entries((b && b.byAsset) || {})];
const allInsights = (p) => C.insightsOf(p).map((x) => x.i);
const byId = (p) => new Map(allInsights(p).map((i) => [i.id, i]));

// ---------- independent F units, tiers and verdicts (§4.3, §4.7 F, §4.9) ----------
const SUPPLY_DIMS = new Set(['supply', 'market', 'chains']);
// An item about the total belongs to an asset's scope when its title names the asset, or the asset is its
// largest driver by at least the asset's floor (review: a −$2.0M part of a $98M offset is not USDP's story).
function drivenBy(p, m, k) {
  const ds = (m.drivers || []).filter((d) => d && isNum(d.usd));
  if (!ds.some((d) => d.asset === k)) return false;
  if (String(m.title || '').split(/[^A-Za-z0-9_]+/).includes(k)) return true;
  const top = ds.slice().sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd))[0], fl = p.insights.floorsUsd[k];
  return top.asset === k && (!isNum(fl) || Math.abs(top.usd) >= fl);
}
function units(p, scope) {
  const ins = p.insights;
  if (!ins) return [];
  const activeOrAgg = (k) => k === p.totals.usd.key || (p.assets[k] && p.assets[k].status === 'active');
  const inScope = (m) => (scope === 'all' ? activeOrAgg(m.asset) : m.asset === scope || drivenBy(p, m, scope));
  // A standing item still holding joins the feed cluster about the same asset and area (one story).
  const raw = (ins.feed || []).map((c) => ({ lead: c.lead, members: [c.lead, ...c.related] }));
  for (const st of (ins.standing || []).filter((x) => x.stage === 'ongoing')) {
    const same = raw.find((u) => u.members.some((m) => m.asset === st.asset && m.dimension === st.dimension && m.dimension !== 'data'));
    if (same) same.members.push(st); else raw.push({ lead: st, members: [st] });
  }
  const out = [];
  for (const u of raw) {
    const live = u.members.filter((m) => m.dimension !== 'data' && ['new', 'ongoing'].includes(m.stage) && inScope(m));
    const kept = live.filter((m) => ['headline', 'evidence'].includes(m.role));
    const prec = (m) => { const k = C.PRECEDENCE.indexOf(C.roleKey(m)); return k < 0 ? 99 : k; };
    const stating = kept.slice().sort((a, b) => prec(a) - prec(b))[0] || live.filter((m) => m.role === 'lens')[0] || null;
    if (!stating) continue;
    // Any headline or evidence member states the unit (an excess-only peg unit is a peg finding, truth review).
    out.push({ lead: u.lead, members: kept.length ? kept : live, stating, eligible: kept.length > 0, tier: C.tierOf(stating, p, scope) });
  }
  return out;
}
function expectedVerdict(p, scope) {
  const us = units(p, scope);
  const major = us.filter((u) => u.eligible && u.tier === 'major');
  const order = major.map((u, k) => ({ u, k })).sort((a, b) => (a.u.stating.polarity === 'negative' ? 0 : 1) - (b.u.stating.polarity === 'negative' ? 0 : 1) || a.k - b.k).map((x) => x.u);
  const items = order.map((u) => ({ id: u.lead.id, asset: u.stating.asset, chain: u.stating.dimension === 'chains' ? u.stating.chain || null : null, area: C.AREA_OF[u.stating.dimension], lens: C.LENS_OF[u.stating.dimension], tone: u.stating.polarity, since: u.members.map((m) => m.novelty && m.novelty.since).filter(Boolean).sort()[0] || null }));
  // Every unit in scope that is not a verdict item is a smaller finding (lens-only units included).
  const minor = us.filter((u) => !(u.eligible && u.tier === 'major')).length;
  const ins = p.insights;
  const checks = !ins ? 0 : scope === 'all' ? ins.testsRun : Object.entries((ins.health && ins.health.cells && ins.health.cells[scope]) || {}).filter(([d]) => d !== 'data').reduce((s, [, c]) => s + c.tests, 0);
  const level = !ins || !ins.testsRun ? 'unknown' : items.length ? 'unusual' : (ins.errors || []).length ? 'partial' : minor ? 'minor' : 'clear';
  return { level, items, minor, checks };
}
// Everything one All-scope frame or verdict may cite: new/ongoing, not a data note, an active asset or the aggregate.
function citable(p, id) {
  const i = byId(p).get(id);
  if (!i) return `${id} is not in the payload`;
  if (!['new', 'ongoing'].includes(i.stage)) return `${id} has stage ${i.stage}`;
  if (i.role === 'note' || i.dimension === 'data') return `${id} is a data note`;
  if (i.asset !== p.totals.usd.key && !(p.assets[i.asset] && p.assets[i.asset].status === 'active')) return `${id} is about a legacy or dead asset (${i.asset})`;
  return null;
}
// Targeting, reconciliation and citations for one payload with a briefing; returns error strings.
function semantics(p, label) {
  const errs = [], bad = (m) => errs.push(`${label}: ${m}`);
  const b = p.briefing;
  if (!b) return [`${label}: no briefing`];
  for (const e of C.validateBriefing(p)) bad(e);
  // tiers set in place (All-scope rule) on every eligible insight
  for (const i of allInsights(p)) {
    const eligible = ['new', 'ongoing'].includes(i.stage) && !['note', 'api', 'context'].includes(i.role);
    const want = eligible ? C.tierOf(i, p, 'all') : null;
    if (i.tier !== want) bad(`${i.id}: tier ${i.tier}, §4.3 gives ${want}`);
  }
  for (const [scope, s] of scopesOf(b)) {
    const want = expectedVerdict(p, scope), v = s.verdict;
    if (v.level !== want.level) bad(`${scope} verdict level ${v.level}, §4.9 gives ${want.level}`);
    if (JSON.stringify(v.items) !== JSON.stringify(want.items)) bad(`${scope} verdict items ${JSON.stringify(v.items)}, the major F units are ${JSON.stringify(want.items)}`);
    if (v.minor !== want.minor) bad(`${scope} verdict.minor ${v.minor}, ${want.minor} minor units in scope`);
    if (v.checks !== want.checks) bad(`${scope} verdict.checks ${v.checks}, want ${want.checks}`);
    for (const [w, f] of Object.entries(s.frames)) {
      const at = `${scope}/${w}`;
      const fWin = p.attribution && p.attribution.windows && p.attribution.windows[w];
      // One period everywhere: All and USD coins use the attribution window; a non-USD asset (gold) ends
      // on its own supply day (its ounce changes are measured from there) and spans the same N days.
      const own = scope !== 'all' && p.assets[scope] && p.assets[scope].unit !== 'USD';
      if (own) {
        const a = p.assets[scope], s = a.series.supply || a.series.supplyUsd;
        const ends = [a.current.supplyAsOf && a.current.supplyAsOf.slice(0, 10), s && new Date(Date.parse(s.start) + (s.values.length - 1) * 864e5).toISOString().slice(0, 10), fWin && fWin.to].filter(Boolean);
        if (!ends.includes(f.to) || f.from !== new Date(Date.parse(f.to) - C.FRAMES[w] * 864e5).toISOString().slice(0, 10)) bad(`${at}: frame (${f.from}, ${f.to}] is neither the attribution window nor ${C.FRAMES[w]} days to ${scope}'s own supply day (${ends})`);
      } else if (fWin && (f.from !== fWin.from || f.to !== fWin.to)) bad(`${at}: frame (${f.from}, ${f.to}] is not attribution.windows.${w} (${fWin.from}, ${fWin.to}]`);
      const majorFindings = f.bullets.filter((x) => x.kind === 'finding' && x.tier === 'major');
      if (majorFindings.length > 3) bad(`${at}: ${majorFindings.length} findings (at most 3)`);
      const findingIds = f.bullets.filter((x) => x.kind === 'finding').map((x) => x.refs).flat();
      for (const it of v.items.slice(0, 3)) if (!findingIds.includes(it.id)) bad(`${at}: verdict item ${it.id} has no finding bullet`);
      const st = f.bullets[0];
      // values (§4.8): state { usd, deltaUsd, pct, marketPct } (+ pctNative for a non-USD coin), mover { deltaUsd, pct }.
      const stKeys = Object.keys(st.values || {}).sort().join();
      const wantSt = scope !== 'all' && p.assets[scope] && p.assets[scope].unit !== 'USD' ? 'deltaUsd,marketPct,pct,pctNative,usd' : 'deltaUsd,marketPct,pct,usd';
      if (stKeys !== wantSt) bad(`${at}: state values keys ${stKeys} (want ${wantSt})`);
      for (const x of f.bullets.filter((y) => y.kind === 'mover' && y.values)) if (Object.keys(x.values).sort().join() !== 'deltaUsd,pct') bad(`${at}: mover values keys ${Object.keys(x.values)}`);
      if (scope === 'all') {
        const ch = p.totals.usd.change && p.totals.usd.change[w];
        if (ch && isNum(ch.abs) && !(st.values && st.values.deltaUsd === ch.abs)) bad(`${at}: state values.deltaUsd ${st.values && st.values.deltaUsd} != totals.usd.change.${w}.abs ${ch.abs}`);
        if (!(st.values && st.values.usd === p.totals.usd.current)) bad(`${at}: state values.usd != totals.usd.current`);
        for (const x of f.bullets) {
          for (const id of [...x.refs, x.link.insight].filter(Boolean)) { const why = citable(p, id); if (why) bad(`${at}: ${x.kind} cites ${why}`); }
          if (x.subject.asset && x.subject.asset !== AGG && p.assets[x.subject.asset] && p.assets[x.subject.asset].status !== 'active') bad(`${at}: a ${x.kind} bullet about legacy ${x.subject.asset}`);
          // A mover states the frame's move; the yesterday bullet (Y, "Yesterday, …") states windows.d1.
          const yWin = /^Yesterday, /.test(x.text) ? p.attribution && p.attribution.windows && p.attribution.windows.d1 : fWin;
          if (x.kind === 'mover' && x.values && isNum(x.values.deltaUsd) && yWin) {
            const row = yWin.assets.find((r) => r.asset === x.subject.asset);
            if (row && x.values.deltaUsd !== row.deltaUsd) bad(`${at}: mover ${x.subject.asset} deltaUsd ${x.values.deltaUsd} != attribution ${yWin === fWin ? w : 'd1'} ${row.deltaUsd}`);
          }
        }
        const movers = f.bullets.filter((x) => x.kind === 'mover' && x.subject.asset && p.assets[x.subject.asset]);
        if (new Set(movers.map((x) => x.subject.asset)).size !== movers.length) bad(`${at}: two mover bullets for one asset`);
        // A finding absorbs its same-direction mover (supply, market, chains): one story, one bullet.
        for (const fb of f.bullets.filter((x) => x.kind === 'finding')) {
          const i = byId(p).get(fb.link.insight);
          if (i && SUPPLY_DIMS.has(i.dimension)) for (const m of movers.filter((x) => x.subject.asset === i.asset)) if (m.values && Math.sign(m.values.deltaUsd) === (i.polarity === 'negative' ? -1 : 1)) bad(`${at}: mover ${m.text} not absorbed by finding ${fb.text}`);
        }
        // The peg line never names a coin that has a peg finding bullet.
        const pegFinding = f.bullets.filter((x) => x.kind === 'finding' && x.link.lens === 'peg').map((x) => x.subject.asset);
        for (const x of f.bullets.filter((y) => y.kind === 'steady' && y.link.lens === 'peg')) for (const k of pegFinding) if (new RegExp(`\\b${k}\\b`).test(x.text)) bad(`${at}: the peg line names ${k}, which has a peg finding`);
      } else {
        // (USD coins: token-flow change; gold states its change in ounces, its dollar value is not pinned here)
        const a = p.assets[scope], ch = a.unit === 'USD' && a.current.change ? a.current.change[w] : null;
        if (ch && isNum(ch.abs) && !(st.values && st.values.deltaUsd === ch.abs)) bad(`${at}: state values.deltaUsd ${st.values && st.values.deltaUsd} != assets.${scope}.current.change.${w}.abs ${ch.abs}`);
        if (st.subject.asset !== scope) bad(`${at}: state subject ${st.subject.asset}`);
        // The market's move over the frame is one number on the page: the same in every scope.
        const mAll = (/; all USD stablecoins (\S+)$/.exec(b.frames[w].bullets[0].text) || [])[1], mHere = (/; all USD stablecoins (\S+)$/.exec(st.text) || [])[1];
        if (a.unit === 'USD' && mAll && mHere !== mAll) bad(`${at}: "all USD stablecoins ${mHere}" but All says ${mAll} over the same frame`);
        if (a.unit === 'USD' && st.values && isNum(st.values.marketPct) && b.frames[w].bullets[0].values && st.values.marketPct !== b.frames[w].bullets[0].values.marketPct) bad(`${at}: values.marketPct ${st.values.marketPct} != All's ${b.frames[w].bullets[0].values.marketPct}`);
        for (const x of f.bullets.filter((y) => y.kind === 'mover' && y.subject.chain && y.values && isNum(y.values.deltaUsd))) {
          const row = fWin && fWin.chains.find((r) => r.asset === scope && r.chain === x.subject.chain);
          if (row && row.deltaUsd !== x.values.deltaUsd) bad(`${at}: chain mover ${x.subject.chain} deltaUsd ${x.values.deltaUsd} != attribution ${row.deltaUsd}`);
        }
      }
    }
  }
  return errs;
}

// ---------- 1. shape, attachment, determinism ----------
await section('shape', async () => {
  ok(typeof B.applyBriefing === 'function' && typeof B.tierOf === 'function' && typeof B.buildFrame === 'function', 'briefing.js exports applyBriefing, tierOf, buildFrame (§6.3)');
  ok(P.briefing && typeof P.briefing === 'object', 'buildPayload attaches payload.briefing');
  none(C.validate(P, 'payload'), 'the fixture payload meets the contract');
  none(semantics(P, 'fixture'), 'the fixture briefing meets §4.3-§4.9');
  const p2 = clone(P);
  for (const i of allInsights(p2)) i.tier = null;
  delete p2.briefing;
  const b2 = B.applyBriefing(p2);
  ok(JSON.stringify(b2) === JSON.stringify(P.briefing), 'applyBriefing(payload) reproduces the attached briefing (deterministic)');
  ok(JSON.stringify(allInsights(p2).map((i) => i.tier)) === JSON.stringify(allInsights(P).map((i) => i.tier)), 'applyBriefing sets insight.tier in place');
  const p3 = clone(P);
  p3.generatedAt = new Date(Date.parse(P.generatedAt) + 7 * 3600e3).toISOString();
  p3.sources = p3.sources.map((s) => ({ ...s, ageHours: isNum(s.ageHours) ? s.ageHours + 7 : s.ageHours, fetchedAt: null }));
  ok(JSON.stringify(B.applyBriefing(p3)) === JSON.stringify(P.briefing), 'the briefing does not depend on generatedAt or source ages (a memo hit stays correct)');
  for (const [scope] of scopesOf(P.briefing)) for (const w of WINDOWS) {
    const want = scope === 'all' ? P.briefing.frames[w] : P.briefing.byAsset[scope].frames[w];
    ok(JSON.stringify(B.buildFrame(clone(P), w, scope)) === JSON.stringify(want), `buildFrame(payload, ${w}, ${scope}) equals the attached frame`);
  }
  for (const i of allInsights(P)) for (const scope of ['all', ...Object.keys(P.assets)]) {
    if (!['new', 'ongoing'].includes(i.stage)) continue;
    ok(B.tierOf(i, P, scope) === C.tierOf(i, P, scope), `tierOf(${i.id}, ${scope}) = ${B.tierOf(i, P, scope)}, §4.3 gives ${C.tierOf(i, P, scope)}`);
  }
  for (const x of [{}, null, { totals: null }, { schemaVersion: 1, totals: { usd: null }, assets: {} }]) {
    let threw = null;
    try { B.applyBriefing(x); } catch (e) { threw = e; }
    ok(!threw, `applyBriefing never throws (${JSON.stringify(x)}: ${threw && threw.message})`);
  }
});

// ---------- 4. today's output (§4.8, §4.10) ----------
await section('today', async () => {
  const b = P.briefing, d7 = b.frames.d7.bullets;
  ok(b.verdict.text === 'Unusual: USDP peg' && b.verdict.level === 'unusual' && b.verdict.tone === 'negative' && b.verdict.checks === P.insights.testsRun, `All verdict "${b.verdict.text}"`);
  ok(b.floorUsd === 21809393 && JSON.stringify(b.peers) === JSON.stringify(['USDT', 'USDC', 'USD1']) && b.key === 'Paxos USD', 'floor $21.8M, peers USDT, USDC, USD1');
  // The market's move is the payload's own market.usdTotal ratio over the frame (4 significant digits since
  // H12: +1.14% here, where §4.8's unrounded +1.2% came from); "{g}% or less" is a bound, so the peers'
  // largest mean gap (USD1 0.0646%) rounds up to 0.07%.
  const mk = P.market.usdTotal, at = (d) => mk.values[Math.round((Date.parse(d) - Date.parse(mk.start)) / 864e5)];
  const mPct = (at(b.frames.d7.to) / at(b.frames.d7.from) - 1) * 100, mTxt = (mPct < 0 ? '−' : '+') + Math.abs(mPct).toFixed(1) + '%';
  ok(Math.abs(d7[0].values.marketPct - mPct) < 1e-3, `state values.marketPct ${d7[0].values.marketPct} = market.usdTotal over the frame (${mPct.toFixed(4)})`);
  const want7 = [
    ['state', `$5.85B in Paxos USD stablecoins, −$60M (−1.0%); all USD stablecoins ${mTxt}`, 'Yesterday +$14M; market share 1.88%, was 1.93%.'],
    // The peg finding is restated on the period from the cards' series (review: one number per frame):
    // the mean distance from $1 over the 7 days, peers over the same days, the typical gap before Sep 11.
    ['finding', 'USDP 0.44% below $1 on average over 7 days', 'USDT, USDC and USD1 0.07% or less over the same days; typically 0.05% before Sep 11.'],
    ['mover', 'USDG −$99M (−3.1%): X Layer −$85M, Ethereum −$25M, Solana +$21M', '3rd week in a row of outflows.'],
    // (Sep 7 is 17 days before the period: a record set so recently is not printed, truth review.)
    ['mover', 'PYUSD +$42M (+1.5%), mostly Arbitrum +$41M', 'Yesterday +$19M; now $2.74B.'],
    // "within X%" is a bound, so X is the widest daily gap rounded up to 0.01% (§4.7 P): peers' widest is
    // USD1 0.102%, so 0.11% (§4.8's 0.10% understates it).
    ['steady', 'Steady: USDG and PYUSD within 0.03% of $1 all week', 'USDT, USDC and USD1 within 0.11% (daily prices).'],
  ];
  ok(JSON.stringify(d7.map((x) => [x.kind, x.text, x.detail])) === JSON.stringify(want7), `All · d7 is §4.8's:\n${d7.map((x) => `${x.kind}: ${x.text} | ${x.detail}`).join('\n')}`);
  ok(d7[4].tone === 'positive' && d7[1].values && Math.abs(d7[1].values.gap - -0.0044) < 0.00005 && d7[1].values.days === 7, `the steady line is positive; the peg finding carries its period figures (${JSON.stringify(d7[1].values)})`);
  ok(d7[1].tier === 'major' && d7[1].since === '2026-09-11' && d7[1].link.lens === 'peg' && d7[1].link.focus === 'USDP' && d7[1].link.insight === 'peg.deviation:USDP:abs:up' && JSON.stringify(d7[1].refs.slice().sort()) === JSON.stringify(['peg.deviation:USDP:abs:up', 'peg.deviation:USDP:excess:up', 'peg.regime:USDP:week-2026-09-13']), 'the USDP finding: major, since Sep 11, Peg lens, focus USDP, stated by peg.deviation:abs, all three members as refs');
  ok(d7[2].link.lens === 'chains' && d7[2].link.focus === 'USDG' && d7[2].values.deltaUsd === -99209549 && d7[3].values.deltaUsd === 41679202 && d7[4].link.lens === 'peg', 'mover links and values (§4.8)');
  ok(b.frames.d7.label === 'Last 7 days to Oct 1' && b.frames.d7.from === '2026-09-24' && b.frames.d7.to === '2026-10-01' && b.frames.d365.label === 'Last 12 months to Oct 1', 'frame labels and dates');
  const d30 = b.frames.d30.bullets.map((x) => x.text);
  // 30 days: the peg widening began inside the period, so the finding states it since then; the USDG line
  // names what its three chains leave out (others +$41M).
  ok(d30[1] === 'USDP 0.33% below $1 on average since Sep 11' && d30.includes('USDG −$190M (−5.8%): X Layer −$370M, Robinhood Chain +$224M, Ethereum −$85M, others +$41M') && d30.includes('PYUSD −$142M (−4.9%): Ethereum −$137M, Arbitrum +$17M, Solana −$17M') && d30.includes('Steady: USDG and PYUSD within 0.06% of $1 for 30 days'), `All · d30 (§4.10; Solana −$16.5M rounds to −$17M by §3.0):\n${d30.join('\n')}`);
  // Every frame's peg figure is the daily-price mean the cards and the Peg table use over the stated days.
  for (const w of WINDOWS) {
    const fb = b.frames[w].bullets.find((x) => x.kind === 'finding' && x.subject.asset === 'USDP');
    const fr = b.frames[w], since = fb && fb.since > fr.from ? fb.since : null;
    const s = P.assets.USDP.series.price, t0 = Date.parse(s.start);
    const xs = s.values.map((v, k) => [new Date(t0 + k * 864e5).toISOString().slice(0, 10), v]).filter(([d, v]) => isNum(v) && d <= fr.to && (since ? d >= since : d > fr.from)).map(([, v]) => v - 1);
    const mean = xs.reduce((t, v) => t + Math.abs(v), 0) / xs.length;
    ok(fb && fb.text.startsWith(`USDP ${(100 * mean).toFixed(2)}% below $1 on average ${since ? 'since' : 'over'}`) && fb.values.days === xs.length, `${w}: the USDP finding states the daily-price mean over its days (${fb && fb.text}; ${(100 * mean).toFixed(3)}%)`);
  }
  const g = b.byAsset.USDG;
  ok(g.verdict.text === 'USDG: nothing unusual · 214 checks' && g.verdict.level === 'clear', `USDG verdict "${g.verdict.text}"`);
  // (USDG's widest day is 0.0145%, so "within 0.02%" by the rounded-up rule; §4.10 printed 0.01%.)
  ok(JSON.stringify(g.frames.d7.bullets.map((x) => x.text)) === JSON.stringify([`$3.09B USDG, −$99M (−3.1%); all USD stablecoins ${mTxt}`, 'X Layer −$85M (−5.6%), now $1.42B', 'Ethereum −$25M (−9.0%), now $257M', 'Steady: USDG within 0.02% of $1 all week']), `USDG · d7 is §4.10's: ${g.frames.d7.bullets.map((x) => x.text).join(' | ')}`);
  ok(b.byAsset.USDP.verdict.text === 'Unusual: USDP peg' && b.byAsset.PAXG.verdict.level === 'clear' && /^PAXG: nothing unusual · \d+ checks$/.test(b.byAsset.PAXG.verdict.text), 'USDP and PAXG asset verdicts');
  ok(b.byAsset.PAXG.frames.d7.bullets[0].text === '$1.82B PAXG, +0.03% in ounces; gold price −2.9%', `PAXG state (§4.10): ${b.byAsset.PAXG.frames.d7.bullets[0].text}`);
  ok(b.errors.length === 0, `no briefing errors (${JSON.stringify(b.errors)})`);
});

// ---------- 5. hardening ----------
const reapply = (p) => { for (const i of allInsights(p)) i.tier = null; delete p.briefing; const b = B.applyBriefing(p); p.briefing = b; return p; };
const cleanText = (b) => scopesOf(b).flatMap(([, s]) => Object.values(s.frames).flatMap((f) => f.bullets.flatMap((x) => [x.text, x.detail]))).concat(scopesOf(b).map(([, s]) => s.verdict.text)).filter((t) => typeof t === 'string' && C.BAD_TEXT.test(t));
await section('damaged payloads (prototype robust.mjs set)', async () => {
  const legacyKey = Object.keys(P.assets).find((k) => P.assets[k].status !== 'active');
  const goldKey = Object.keys(P.assets).find((k) => P.assets[k].kind === 'gold');
  const cases = {
    'insights null': (p) => { p.insights = null; },
    'insights empty (engine failed)': (p) => { p.insights = { ...p.insights, feed: [], standing: [], watch: [], context: [], testsRun: 0, family: null, health: null, errors: [{ detector: 'engine', error: 'boom' }] }; },
    'attribution null': (p) => { p.attribution = null; },
    'market null': (p) => { p.market = null; },
    'pegPeers empty': (p) => { p.pegPeers = []; },
    'no gold asset': (p) => { delete p.assets[goldKey]; p.discovery.assets = p.discovery.assets.filter((a) => a.key !== goldKey); },
    'totals.usd change null': (p) => { p.totals.usd.change = { d1: null, d7: null, d30: null, d90: null, d365: null }; },
    'feed of legacy + data notes only': (p) => { const w = p.insights.watch; p.insights.feed = [...w.filter((i) => i.asset === legacyKey).slice(0, 1), ...w.filter((i) => i.dimension === 'data').slice(0, 2)].map((i) => ({ rootKey: i.id, lead: { ...i, stage: 'new', facts: {} }, related: [] })); p.insights.standing = []; },
    'every section null': (p) => { for (const k of ['market', 'peers', 'economics', 'attribution']) p[k] = null; p.pegPeers = []; p.goldRefs = []; },
    'no total': (p) => { p.totals.usd.current = null; },
    'gold without a USD value': (p) => { const g = p.assets[goldKey]; g.current.supplyUsd = null; g.current.price = null; g.series.supplyUsd = null; },
  };
  for (const [name, f] of Object.entries(cases)) {
    const p = clone(P);
    f(p);
    let b = null, threw = null;
    try { for (const i of allInsights(p)) i.tier = null; delete p.briefing; b = B.applyBriefing(p); } catch (e) { threw = e; }
    ok(!threw && b, `${name}: applyBriefing does not throw (${threw && threw.message})`);
    if (!b) continue;
    p.briefing = b;
    ok(WINDOWS.every((w) => b.frames[w] && b.frames[w].bullets.length >= 3 && b.frames[w].bullets.length <= 5), `${name}: 3 to 5 bullets in every All frame (${WINDOWS.map((w) => b.frames[w] && b.frames[w].bullets.length)})`);
    none(C.validateBriefing(p), `${name}: the briefing meets the contract`);
    ok(!cleanText(b).length, `${name}: no NaN, undefined, null, n/a or empty sign (${cleanText(b).slice(0, 3)})`);
    if (name === 'insights null') ok(b.verdict.level === 'unknown' && b.verdict.text === 'Checks unavailable in this snapshot' && !b.frames.d7.bullets.some((x) => x.kind === 'finding'), `insights null -> "Checks unavailable in this snapshot" (${b.verdict.text})`);
    if (name === 'insights empty (engine failed)') ok(b.verdict.level === 'unknown', `testsRun 0 -> unknown (${b.verdict.level})`);
    if (name === 'feed of legacy + data notes only') ok(b.verdict.level !== 'unusual' && !b.verdict.items.length && WINDOWS.every((w) => !b.frames[w].bullets.some((x) => x.kind === 'finding')), 'legacy and data-note findings never reach the All-scope verdict or briefing');
    ok(WINDOWS.every((w) => b.frames[w].bullets[0].kind === 'state') && Object.values(b.byAsset).every((s) => WINDOWS.every((w) => s.frames[w] && s.frames[w].bullets[0].kind === 'state')), `${name}: every frame opens with its state bullet`);
    if (name === 'pegPeers empty') ok(b.verdict.items.some((it) => it.asset === 'USDP' && it.area === 'peg'), 'no peg peers: the peer bar fails open (USDP peg stays major)');
  }
});
await section('H3 and H4 variants', async () => {
  // H3: insights.errors with no major finding -> partial; the verdict never says "Nothing unusual" then.
  const pa = clone(P);
  pa.insights.feed = [];
  pa.insights.errors = [{ detector: 'chain.move', error: 'boom' }, { detector: 'peg.regime', error: 'boom' }];
  reapply(pa);
  ok(pa.briefing.verdict.level === 'partial' && pa.briefing.verdict.text === 'Partly checked · 2 checks could not run' && scopesOf(pa.briefing).every(([, s]) => !/Nothing unusual|nothing unusual/.test(s.verdict.text)), `insights.errors -> "${pa.briefing.verdict.text}"`);
  // H4: a USDG peg regime of 0.7 -> 1.9 bp, inside the peers' range, is a smaller finding.
  const pm = clone(P);
  const lead = pm.insights.feed[0].lead;
  const usdgReg = { ...clone(lead), id: 'peg.regime:USDG:week-2026-09-13', asset: 'USDG', polarity: 'negative', materialityUsd: P.assets.USDG.current.supplyUsd, title: 'USDG typically 0.02% from $1 since Sep 11, up from 0.01%', evidence: { ...clone(lead.evidence), value: 0.00019, baseline: 0.00007 }, facts: { ...clone(lead.facts), before: 0.00007, after: 0.00019 } };
  pm.insights.feed = [{ rootKey: usdgReg.id, lead: usdgReg, related: [] }];
  reapply(pm);
  ok(C.tierOf(usdgReg, pm, 'all') === 'minor' && pm.briefing.verdict.level === 'minor' && pm.briefing.verdict.text === 'Nothing major · 1 smaller finding', `H4: a USDG peg regime inside the peers' range -> "${pm.briefing.verdict.text}"`);
  ok(WINDOWS.every((w) => !pm.briefing.frames[w].bullets.some((x) => x.kind === 'finding' && x.tier === 'major')), 'H4: a smaller finding never shows as major');
  // H4: a $2M USDP market-share finding is minor at All scope (under the $21.8M business floor), major for USDP.
  const ps = clone(P);
  const share = { ...clone(lead), id: 'market.share:USDP:down', detector: 'market.share', dimension: 'market', asset: 'USDP', polarity: 'negative', materialityUsd: 2053179, title: 'USDP market share 0.0084%, from 0.0091% over 4 days', evidence: { ...clone(lead.evidence), window: '4d' }, facts: { from: 0.0000905, to: 0.0000838, days: 4, ownFlowUsd: -1997519, record: null } };
  ps.insights.feed = [{ rootKey: share.id, lead: share, related: [] }];
  reapply(ps);
  ok(C.tierOf(share, ps, 'all') === 'minor' && ps.briefing.verdict.text === 'Nothing major · 1 smaller finding' && ps.briefing.byAsset.USDP.verdict.text === 'Unusual: USDP market share', `H4: a $2M USDP market-share finding -> All "${ps.briefing.verdict.text}", USDP "${ps.briefing.byAsset.USDP.verdict.text}"`);
  for (const [name, p] of [['partial', pa], ['minor peg', pm], ['minor share', ps]]) none(semantics(p, name), `${name}: targeting rules`);
  // Busy day: three major findings -> "3 unusual: …, … +1 more"; at most 3 finding bullets, 5 in all.
  const pb = clone(P);
  const mk = (asset, dim, det, usd) => ({ ...clone(lead), id: `${det}:${asset}:busy`, detector: det, dimension: dim, asset, chain: dim === 'chains' ? (P.assets[asset].chains[0] || {}).chain || null : null, polarity: 'negative', materialityUsd: usd, title: `${asset} −$${Math.round(usd / 1e6)}M (−3.0%) over 7 days`, evidence: { ...clone(lead.evidence), window: '7d' }, facts: { usd: -usd, pct: -0.03, days: 7, unit: 'USD', record: null } });
  pb.insights.feed.push({ rootKey: 'busy-1', lead: mk('USDG', 'supply', 'supply.move', 1.2e8), related: [] }, { rootKey: 'busy-2', lead: mk('PYUSD', 'chains', 'chain.move', 9e7), related: [] });
  reapply(pb);
  const v = pb.briefing.verdict;
  ok(v.level === 'unusual' && v.items.length === 3 && /^3 unusual: [^,]+, [^,]+ \+1 more$/.test(v.text), `busy day verdict "${v.text}"`);
  ok(WINDOWS.every((w) => pb.briefing.frames[w].bullets.filter((x) => x.kind === 'finding').length <= 3 && pb.briefing.frames[w].bullets.length <= 5), 'busy day: at most 3 findings and 5 bullets');
  none(semantics(pb, 'busy day'), 'busy day: targeting rules');
});
await section('older payload and speed', async () => {
  // A v1 payload (no stage, role or title): the briefing still states the USDP finding.
  const old = C.stripV2(P);
  delete old.briefing;
  const b = B.applyBriefing(old);
  ok(b && b.verdict.text === 'Unusual: USDP peg' && b.frames.d7.bullets.some((x) => x.kind === 'finding' && x.subject.asset === 'USDP'), `older payload: "${b && b.verdict.text}" with the USDP finding`);
  const t0 = performance.now();
  for (let k = 0; k < 5; k++) B.applyBriefing(clone(P));
  const ms = (performance.now() - t0) / 5;
  if (ms > 50) { if (process.env.PAXOS_PERF_STRICT === '1') ok(false, `applyBriefing ${ms.toFixed(0)} ms (≤50)`); else console.warn(`perf (advisory): applyBriefing ${ms.toFixed(0)} ms (budget 50 ms, clone included)`); }
});
await section('a newly discovered asset', async () => {
  const p = clone(P);
  const src = P.assets.PYUSD;
  const key = 'ZZZN';
  p.assets[key] = { ...clone(src), key, symbol: key, name: 'Synthetic new coin', colorIndex: Object.keys(P.assets).length };
  p.discovery.assets.push({ ...clone(P.discovery.assets.find((a) => a.key === 'PYUSD')), key, symbol: key, name: 'Synthetic new coin', geckoId: null, llamaId: null, colorIndex: Object.keys(P.assets).length });
  p.insights.health.cells[key] = clone(P.insights.health.cells.PYUSD);
  reapply(p);
  ok(p.briefing.byAsset[key] && WINDOWS.every((w) => p.briefing.byAsset[key].frames[w].bullets.length >= 3), 'an extra discovered asset gets its own byAsset briefing, no code change');
  none(C.validateBriefing(p), 'with an extra asset the briefing meets the contract');
});

// The fixture model (the review section and the replay use it).
const SNAPSHOT_ONLY = new Set(['market.peer_growth', 'defi.utilization', 'defi.yield_outlier', 'defi.footprint', 'dq.freshness', 'dq.price_sanity', 'dq.list_reconciliation', 'dq.frozen']);
const DAY = 86400;
const rawBundle = await collectRaw({ fetch: createFixtureFetch(fixture), now: NOW, cache: createCache(), log: () => {} });
const baseModel = buildModel(rawBundle, { now: NOW });
// ---------- 5b. fresh-eyes review findings (truth lens) ----------
await section('review: verdict, peer bar, regimes, market precision', async () => {
  const usdpCluster = P.insights.feed.find((c) => [c.lead, ...c.related].some((i) => i.asset === 'USDP' && i.dimension === 'peg'));
  const members = [usdpCluster.lead, ...usdpCluster.related];
  const excess = members.find((i) => /:excess:/.test(i.id)), regime = members.find((i) => i.detector === 'peg.regime');
  // T1: a feed whose only USDP peg member is the excess variant (evidence) still names USDP peg (it states
  // the bullet when alone), and nothing in the feed can leave the verdict at "Nothing unusual".
  const p1 = clone(P);
  p1.insights.feed = [{ rootKey: excess.id, lead: clone(excess), related: [] }];
  reapply(p1);
  ok(p1.briefing.verdict.text === 'Unusual: USDP peg' && WINDOWS.every((w) => p1.briefing.frames[w].bullets.some((x) => x.kind === 'finding' && x.subject.asset === 'USDP')), `T1: an excess-only USDP peg unit -> "${p1.briefing.verdict.text}" with a finding bullet`);
  none(semantics(p1, 'excess-only'), 'T1 variant: targeting rules');
  // T5: a lens-only unit (any size) is a smaller finding: counted, never "Nothing unusual".
  const lensItem = P.insights.watch.find((i) => i.role === 'lens' && i.dimension !== 'data' && (P.assets[i.asset] || {}).status === 'active');
  if (lensItem) {
    const p5 = clone(P);
    p5.insights.feed = [{ rootKey: lensItem.id, lead: { ...clone(lensItem), stage: 'new', facts: {} }, related: [] }];
    reapply(p5);
    ok(p5.briefing.verdict.level === 'minor' && p5.briefing.verdict.text === 'Nothing major · 1 smaller finding' && WINDOWS.every((w) => !p5.briefing.frames[w].bullets.some((x) => x.kind === 'finding')), `T5: a lens-only unit counts as a smaller finding ("${p5.briefing.verdict.text}") and states no bullet`);
    none(semantics(p5, 'lens-only'), 'T5 variant: targeting rules');
  }
  // T7: the USDP widening still holds after the feed window (standing, stage ongoing) and this week's
  // deviation did not fire: the verdict still names USDP peg, as one unit.
  const p7 = clone(P);
  p7.insights.feed = [];
  p7.insights.standing.push({ ...clone(regime), stage: 'ongoing', novelty: { ...regime.novelty, isNew: false, ageDays: 40 } });
  reapply(p7);
  ok(p7.briefing.verdict.text === 'Unusual: USDP peg' && p7.briefing.frames.d7.bullets.some((x) => x.kind === 'finding' && x.subject.asset === 'USDP' && /below \$1 on average/.test(x.text)), `T7: a holding peg widening older than 30 days -> "${p7.briefing.verdict.text}"`);
  const p7b = clone(P);
  p7b.insights.standing.push({ ...clone(regime), id: regime.id + ':old', stage: 'ongoing' });
  reapply(p7b);
  ok(p7b.briefing.verdict.items.length === 1, `T7: an ongoing standing split joins this week's USDP peg cluster (one verdict item, ${p7b.briefing.verdict.items.length})`);
  const fn = D.DETECTORS.find((d) => d.id === 'peg.regime').fn;
  const usdpReg = fn(baseModel, { now: NOW }).filter((t) => t.asset === 'USDP').pop();
  ok(usdpReg && usdpReg.holding === true, `T7: the latest USDP peg split still describes the last week (holding: ${usdpReg && usdpReg.holding})`);
  if (usdpReg) {
    const t = { ...usdpReg, id: 'peg.regime:USDP:x', refT: NOW, notable: true, material: true, isNew: false, otherWindows: [], surprise: 3, adjustedBits: 1, p: 0.01, E: 0.1, m: 10 };
    ok(E.toInsight(t).stage === 'ongoing' && E.toInsight({ ...t, holding: false }).stage === 'past', 'T7: a holding split older than 30 days is ongoing; a superseded one is past');
  }
  // T2: one bad peer print (+0.83%, a single day) neither sets the peers' range nor changes a peg line.
  const p2 = clone(P), usdc = p2.pegPeers.find((q) => q.symbol === 'USDC') || p2.pegPeers[1];
  const k2 = usdc.price.values.length - 60;
  usdc.price.values[k2] = 1.00828;
  reapply(p2);
  const pegTexts = (b) => scopesOf(b).flatMap(([, sc]) => WINDOWS.map((w) => (sc.frames[w].bullets.find((x) => x.kind === 'steady' && x.link.lens === 'peg') || {}).text || null));
  ok(JSON.stringify(pegTexts(p2.briefing)) === JSON.stringify(pegTexts(P.briefing)) && JSON.stringify(p2.briefing.verdict) === JSON.stringify(P.briefing.verdict), 'T2: a one-day +0.83% peer print leaves every peg line and the verdict as they were');
  // A coin with a peg item on the engine's lists (watch included) is never called "Steady".
  const p3 = clone(P), pegWatch = { ...clone(regime), id: 'peg.deviation:USDG:abs:up', detector: 'peg.deviation', asset: 'USDG', stage: 'watch', tier: null };
  delete pegWatch.facts;
  p3.insights.watch.push(pegWatch);
  reapply(p3);
  const st3 = p3.briefing.frames.d7.bullets.find((x) => x.kind === 'steady' && x.link.lens === 'peg');
  ok(st3 && !/^Steady:/.test(st3.text) && st3.tone === 'neutral', `a USDG peg item on watch: no "Steady:" (${st3 && st3.text})`);
  // T6: the market's move is exact at its printed precision (market.usdTotal at 6 significant digits).
  const mk = baseModel.marketUsd, at = (iso) => { const t = Date.parse(iso + 'T00:00:00Z') / 1000; let v = null; mk.t.forEach((x, k) => { if (x <= t) v = mk.v[k]; }); return v; };
  for (const w of WINDOWS) {
    const f = P.briefing.frames[w], exact = (at(f.to) / at(f.from) - 1) * 100;
    ok(Math.abs(f.bullets[0].values.marketPct - exact) < 0.005, `T6: ${w} market ${f.bullets[0].values.marketPct}% = the unrounded ratio ${exact.toFixed(4)}% at 0.01%`);
  }
  // An asset with no supply figure in the snapshot: its state bullet only, within the contract.
  const p4 = clone(P), gk = Object.keys(P.assets).find((k) => P.assets[k].kind === 'gold');
  Object.assign(p4.assets[gk].current, { supply: null, supplyUsd: null });
  reapply(p4);
  ok(WINDOWS.every((w) => p4.briefing.byAsset[gk].frames[w].bullets.length >= 1 && /no supply figure/.test(p4.briefing.byAsset[gk].frames[w].bullets[0].text)), `${gk} without a supply figure: "no supply figure in this snapshot"`);
  none(C.validateBriefing(p4), 'an asset without a supply figure: the briefing meets the contract');
});

// ---------- 6. replay ----------
// The model as of k days ago: every dated series cut at now - k days, snapshot-only inputs removed (a past
// day sees only what it could have seen), snapshot-only detectors skipped.
function replay(k) {
  const nowCut = NOW - k * DAY;
  const cut = D.helpers.bounded(baseModel, nowCut - DAY);
  const m = { ...cut, now: nowCut, list: null, listSanity: null, lendBorrow: null, pools: [], assets: cut.assets.map((a) => ({ ...a, current: null })) };
  const all = D.DETECTORS;
  D.DETECTORS = all.filter((d) => !SNAPSHOT_ONLY.has(d.id));
  let res;
  try { res = E.run(m, { now: nowCut }); } finally { D.DETECTORS = all; }
  return buildPayload(m, res, attribution(tokenFlowView(m)), { generatedAt: new Date(nowCut * 1000).toISOString(), timingsMs: { fetch: 0, model: 0, engine: 0, total: 0 }, errors: [] }).payload;
}
await section('replay', async () => {
  const days = process.env.PAXOS_REPLAY === '31' ? Array.from({ length: 31 }, (_, i) => i + 1) : [1, 4, 9, 15, 21, 30];
  for (const k of days) {
    const p = replay(k);
    const label = `replay k=${k} (${p.generatedAt.slice(0, 10)})`;
    ok(p.briefing && p.briefing.errors.length === 0, `${label}: briefing built without errors (${JSON.stringify(p.briefing && p.briefing.errors).slice(0, 300)})`);
    if (!p.briefing) continue;
    none(C.validateV2(p), `${label}: insights and briefing meet the contract (H5 copy rules included)`);
    none(semantics(p, label), `${label}: targeting and reconciliation`);
    if (k === 21) {
      // §4.10 quiet day (Sep 10): no major finding; the week's offsetting move (portfolio.mix, a lens-only
      // unit shown in Supply) counts as a smaller finding, so the verdict never says "Nothing unusual" over
      // a listed item (review).
      const t = p.briefing.frames.d7.bullets.map((x) => x.text);
      ok(p.briefing.verdict.level === 'minor' && p.briefing.verdict.text === 'Nothing major · 1 smaller finding', `${label}: quiet day verdict "${p.briefing.verdict.text}"`);
      // (USDG's widest day that week is 0.0230%: "within 0.03%" by the rounded-up rule; §4.10 printed 0.02%.)
      ok(t.includes('USDG +$78M (+2.5%): Robinhood Chain +$140M, X Layer −$60M') && t.includes('PYUSD −$77M (−2.7%): Ethereum −$90M, Arbitrum +$57M, Solana −$43M') && t.includes("PYUSD and USDG within 0.03% of $1 all week; USDP's widest day 0.08% above $1 (Sep 6)") && t.includes('PAXG supply steady: +0.2% in ounces; gold price +0.02%'), `${label}: §4.10's quiet-day bullets:\n${t.join('\n')}`);
    }
  }
});

const ms = Math.round(performance.now() - T0);
if (failed.length) {
  console.log(`check-paxos-briefing: ${failed.length} FAILED:\n  ${failed.map((m) => String(m).split('\n').slice(0, 6).join('\n    ')).join('\n  ')}`);
  process.exit(1);
}
console.log(`check-paxos-briefing: ${checks} checks passed in ${ms} ms`);
