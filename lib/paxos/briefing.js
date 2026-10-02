'use strict';

// The briefing: one verdict and 3 to 5 one-line bullets per period (d7, d30, d90, d365), for the active
// USD stablecoins together and for every asset (byAsset), built from the payload alone. Pure and without
// a clock, so a memo hit (same model, restamped generatedAt) keeps a correct briefing.
//
// Bullets (each text at most 14 counted words, each detail at most 20):
//   state    the total (or the asset): level, change over the period, the USD stablecoin market
//   finding  an engine finding that matters to the business (tier 'major', see tierOf)
//   event    a record, a new chain, a change of the largest coin, inside the period
//   mover    the period's largest asset moves with the chains behind them (attribution), yesterday's
//            when the day moved the total by more than an ordinary day; filler lines from other periods
//   steady   the peg against the peg peers, gold issuance against the gold price
// Two bars, both from the data: the business floor (insights.floorsUsd of the total: its median daily
// flow) and the peer bar (a peg finding counts when the coin was further from $1 than every peg peer over
// the same days). Every builder is guarded: a failure drops its bullets and is listed in errors.

const F = require('./format');
const C = require('./copy');
const { OTHER } = require('./attribution');

const DAY = 86400;
const FRAMES = [['d7', 7], ['d30', 30], ['d90', 90], ['d365', 365]];
const NEXT = { d7: 'd30', d30: 'd90', d90: 'd365' };
const MAX = 5, MIN = 3, MAX_FINDINGS = 3, MAX_CHAIN_MOVERS = 2;
const TEXT_WORDS = 14, DETAIL_WORDS = 20;
const LENS = { supply: 'supply', portfolio: 'supply', market: 'market', chains: 'chains', peg: 'peg', defi: 'usage', usage: 'usage', economics: 'income', data: 'supply' };
const AREA = { supply: 'supply', portfolio: 'supply', market: 'market share', chains: 'chains', peg: 'peg', defi: 'usage', usage: 'usage', economics: 'income', data: 'data' };
const FLOW_DIMS = new Set(['supply', 'market', 'chains']);
// Which member of a finding states its bullet: what is happening now, in price or dollars (state before
// event, asset before chain, own history before peers).
const PRECEDENCE = ['peg.deviation:abs', 'peg.gold_tracking', 'peg.deviation:excess', 'peg.regime', 'supply.move', 'supply.drawdown', 'supply.regime', 'market.peer_growth', 'market.share', 'chain.move', 'chain.lifecycle', 'usage.activity', 'usage.turnover', 'economics.reserve_income'];
const ORDER = { state: 0, finding: 1, event: 2, mover: 3, steady: 4, filler: 5 };
const BROKEN = /NaN|undefined|Infinity|\bnull\b|\bn\/a\b|\[object|\(\)|[+−]\s|[+−]$|\$\s/;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const words = F.wordsCount;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------- dates (YYYY-MM-DD) and Compact series {start, values} ----------
const tOf = (iso) => Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z') / 1000;
const isoOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const addDays = (iso, n) => isoOf(tOf(iso) + n * DAY);
const dayIdx = (c, iso) => Math.round((tOf(iso) - tOf(c.start)) / DAY);
const validC = (c) => Boolean(c && typeof c.start === 'string' && Array.isArray(c.values));
// Value on a day, or the nearest earlier observation.
function cAt(c, iso) {
  if (!validC(c) || !iso) return null;
  for (let i = Math.min(dayIdx(c, iso), c.values.length - 1); i >= 0; i--) if (isNum(c.values[i])) return c.values[i];
  return null;
}
// [{ iso, v }] for the days in (fromIso, toIso].
function cDays(c, fromIso, toIso) {
  if (!validC(c)) return [];
  const a = Math.max(0, dayIdx(c, fromIso) + 1), b = Math.min(c.values.length - 1, dayIdx(c, toIso)), out = [];
  for (let i = a; i <= b; i++) if (isNum(c.values[i])) out.push({ iso: addDays(c.start, i), v: c.values[i] });
  return out;
}
const lastIso = (c) => (validC(c) && c.values.length ? addDays(c.start, c.values.length - 1) : null);

// ---------- payload accessors (any section may be null) ----------
const assetsOf = (p) => (p && p.assets) || {};
const assetOf = (p, k) => assetsOf(p)[k] || null;
const active = (p, k) => Boolean(assetOf(p, k) && assetOf(p, k).status === 'active');
const usdCoin = (a) => Boolean(a && a.kind === 'usd-stablecoin');
const goldCoin = (a) => Boolean(a && a.kind === 'gold');
const winOf = (p, w) => (p && p.attribution && p.attribution.windows && p.attribution.windows[w]) || null;
const floorsOf = (p) => (p && p.insights && p.insights.floorsUsd) || {};
const keyOf = (p) => (p && p.totals && p.totals.usd && p.totals.usd.key) || null;
const businessFloor = (p) => { const k = keyOf(p), f = floorsOf(p)[k]; return isNum(f) ? f : null; };
const cellsOf = (p) => (p && p.insights && p.insights.health && p.insights.health.cells) || {};
const calm = (p, k, dims) => { const c = cellsOf(p)[k]; return Boolean(c) && dims.every((d) => c[d] && c[d].state === 'within_own_history'); };
const peerSymbols = (p) => ((p && p.pegPeers) || []).map((x) => x && x.symbol).filter(Boolean);
const issuerWord = (key) => String(key || '').replace(/\s*USD$/, '') || String(key || '');
const PERIOD_WORDS = { d1: 'yesterday', d7: '7 days', d30: '30 days', d90: '90 days', d365: '12 months' };
const SPAN_WORDS = { 1: 'one-day', 7: '7-day', 30: '30-day', 90: '90-day', 365: '12-month' };
const STEADY_PHRASE = { 7: 'all week', 30: 'for 30 days', 90: 'for 90 days', 365: 'for a year' };
const LABEL = { 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', 365: 'Last 12 months' };
// Under $1K is noise for a stablecoin's supply: 'flat' (never "Yesterday −$1").
const flatMoney = (x) => (Math.abs(x) < 1000 ? 'flat' : F.smoney(x));
// Signed ounces, or '' when the printed amount is zero (callers say 'flat' or drop the clause).
const flatOz = (x, unit) => (/^0(\s|$)/.test(F.ounces(Math.abs(x), { unit })) ? '' : F.ounces(x, { signed: true, unit }));
const pctOf = (curr, prev) => (isNum(curr) && isNum(prev) && prev ? curr / prev - 1 : null);

// ---------- insights: stage/role/title fallbacks for payloads built before they existed ----------
// (a feed item is notable, material and new by construction; the role follows from the detector).
const FEED = new WeakSet();
const stageOf = (i) => i.stage || (FEED.has(i) ? 'new' : null);
const roleOf = (i) => i.role || C.roleOf(i);
const titleOf = (i) => i.title || C.fallbackTitle(i.headline);
const precKey = (i) => (i.detector === 'peg.deviation' ? `peg.deviation:${(i.facts && i.facts.variant) === 'excess' || /:excess:/.test(i.id || '') ? 'excess' : 'abs'}` : i.detector);
const precIdx = (i) => { const k = PRECEDENCE.indexOf(precKey(i)); return k < 0 ? PRECEDENCE.length : k; };
const nonData = (i) => i.dimension !== 'data';
const live = (i) => ['new', 'ongoing'].includes(stageOf(i));
// Direction of a finding's move: its dollar change, else its percent change, else the id's up/down.
function dirOf(i) {
  const f = i.facts || {};
  for (const k of ['usd', 'pct', 'usdSince']) if (isNum(f[k]) && f[k] !== 0) return sign(f[k]);
  return /:up$/.test(i.id || '') ? 1 : /:down$/.test(i.id || '') ? -1 : 0;
}
const driverAssets = (i) => (i.drivers || []).map((d) => d && d.asset).filter(Boolean);
// An item about another subject (the total) belongs to an asset's scope when its title names the asset,
// or the asset is its largest driver by at least that asset's floor (a -$2.0M part of a $98M offsetting
// move is not the small coin's story). The page applies the same rule (app.js insightMatches).
const namesKey = (i, k) => new RegExp(`(^|[^A-Za-z0-9_])${String(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`).test(String(i.title || ''));
function drivenBy(p, i, k) {
  const ds = (i.drivers || []).filter((d) => d && d.asset && isNum(d.usd));
  if (!ds.some((d) => d.asset === k)) return false;
  if (namesKey(i, k)) return true;
  const top = ds.reduce((m, d) => (Math.abs(d.usd) > Math.abs(m.usd) ? d : m)), fl = floorsOf(p)[k];
  return top.asset === k && (!isNum(fl) || Math.abs(top.usd) >= fl);
}
// A peg peer's daily price without isolated bad prints: a day at least 0.1% from $1 and over four times as
// far as both neighbours, which come straight back, is a print error (one +0.83% day of one peer would otherwise
// set the peers' range for a year and call a real depeg "inside" it). The coins' own prices are already a
// consensus of several sources; the peers have one source, so they get this filter instead.
const PEER_CACHE = new WeakMap();
function peerPrice(q) {
  const c = q && q.price;
  if (!validC(c)) return null;
  if (PEER_CACHE.has(c)) return PEER_CACHE.get(c);
  const g = c.values.map((v) => (isNum(v) ? Math.abs(v - 1) : null));
  const values = c.values.map((v, i) => (i > 0 && i < g.length - 1 && isNum(g[i]) && isNum(g[i - 1]) && isNum(g[i + 1]) && g[i] >= 0.001 && g[i] > 4 * Math.max(g[i - 1], g[i + 1]) ? null : v));
  const out = { start: c.start, values };
  PEER_CACHE.set(c, out);
  return out;
}

// ---------- tiers ----------
// The days a peg finding covers: its evidence.window ('Nd' = the N days ending on its as-of day; 'since D';
// 'A..B'; both ends inclusive), as [fromIso exclusive, toIso].
function windowDays(i, series) {
  const w = String((i.evidence && i.evidence.window) || ''), end = (i.asOf && String(i.asOf).slice(0, 10)) || lastIso(series);
  if (!end) return null;
  let m = /^(\d+)d$/.exec(w);
  if (m) return [addDays(end, -Number(m[1])), end];
  m = /^since (\d{4}-\d{2}-\d{2})$/.exec(w);
  if (m) return [addDays(m[1], -1), end];
  m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(w);
  if (m) return [addDays(m[1], -1), m[2]];
  return null;
}
const meanGap = (xs) => (xs.length ? xs.reduce((s, x) => s + Math.abs(x.v - 1), 0) / xs.length : null);
// tierOf(insight, payload, scope = 'all') -> 'major' | 'minor' | null.
// A USD coin's peg finding is major when the coin's mean distance from $1 over the finding's days is wider
// than every peg peer's over the same days (peer prices without isolated bad prints, peerPrice; no peer
// data: major, the rule fails open; no coin prices: minor). Gold tracking has no peer bar and no dollar size: minor for all coins, major in the asset's own
// scope. Anything else, at the all-coins scope: major when it moves at least the business floor (usage
// activity carries no dollar size: minor); in an asset's scope the asset's own floor already gated it:
// major. Notes, API-only and context items have no tier.
function tierOf(i, p, scope = 'all') {
  if (!i || typeof i !== 'object' || i.dimension === 'data' || ['note', 'api', 'context'].includes(roleOf(i))) return null;
  const all = scope === 'all', a = assetOf(p, i.asset);
  if (i.detector === 'peg.gold_tracking' || (i.dimension === 'peg' && !(a && a.unit === 'USD'))) return all ? 'minor' : 'major';
  if (i.dimension === 'peg') {
    const s = a.series && a.series.price, d = windowDays(i, s);
    const own = d ? cDays(s, d[0], d[1]) : [];
    const peers = d ? ((p && p.pegPeers) || []).map((q) => meanGap(cDays(peerPrice(q), d[0], d[1]))).filter(isNum) : [];
    if (!peers.length) return 'major';
    const coin = meanGap(own);
    return isNum(coin) && coin > Math.max(...peers) ? 'major' : 'minor';
  }
  if (!all) return 'major';
  const bf = businessFloor(p);
  return isNum(i.materialityUsd) && isNum(bf) && i.materialityUsd >= bf ? 'major' : 'minor';
}

// ---------- finding units (frame-independent) ----------
// Units: each feed cluster, and each standing item still holding (stage ongoing): on its own, or joined to
// the feed cluster about the same asset and area (a peg widening older than the feed window and this
// week's peg deviation are one story). Members in scope: not data notes, new or ongoing, about an active
// coin or the total (all), or about the asset or driven by it (asset scope, drivenBy). The stating member
// is the first by precedence of the headline and evidence members; it states the unit's bullet (an
// evidence member states one only when it is alone: an excess-only peg unit is still a peg finding). A
// unit with no headline or evidence member (lens only) states no bullet. The verdict names the major
// stating units and counts every other unit in scope as a smaller finding.
function unitsOf(p, scope) {
  const ins = p && p.insights, out = [];
  if (!ins) return out;
  const feed = (ins.feed || []).map((c) => [c.lead, ...(c.related || [])].filter(Boolean));
  for (const list of feed) for (const i of list) FEED.add(i);
  const raw = feed.map((l) => l.slice());
  for (const x of (ins.standing || []).filter((y) => y && stageOf(y) === 'ongoing')) {
    const same = raw.find((l) => l.some((i) => i.asset === x.asset && i.dimension === x.dimension && i.dimension !== 'data'));
    if (same) same.push(x); else raw.push([x]);
  }
  const inScope = (i) => (scope === 'all' ? i.asset === keyOf(p) || active(p, i.asset) : i.asset === scope || drivenBy(p, i, scope));
  raw.forEach((list, idx) => {
    const live0 = list.filter((i) => nonData(i) && live(i) && inScope(i));
    const kept = live0.filter((i) => ['headline', 'evidence'].includes(roleOf(i))).sort((x, y) => precIdx(x) - precIdx(y));
    const stating = kept[0] || live0.find((i) => roleOf(i) === 'lens') || null;
    if (!stating) return;
    out.push({ idx, lead: list[0], leadInScope: live0.includes(list[0]), members: kept.length ? kept : live0, stating, states: kept.length > 0, tier: tierOf(stating, p, scope) });
  });
  return out;
}
const toneOf = (i) => (i.polarity === 'negative' ? 'negative' : i.polarity === 'positive' ? 'positive' : 'neutral');
function findingOf(u, p) {
  if (!u.states) return null;
  const head = u.stating, key = keyOf(p);
  const sinces = u.members.map((i) => i.novelty && i.novelty.since).filter((x) => typeof x === 'string').sort();
  const s = u.stating, asset = head.asset;
  return {
    unit: u, lead: head, tier: u.tier, idx: u.idx, tone: toneOf(s),
    dir: FLOW_DIMS.has(head.dimension) ? dirOf(head) : 0,
    size: head.dimension === 'peg' ? 0 : head.materialityUsd || 0,
    item: { id: u.lead.id, asset: s.asset, chain: s.dimension === 'chains' ? s.chain || null : null, area: AREA[s.dimension] || s.dimension, lens: LENS[s.dimension] || 'supply', tone: toneOf(s), since: sinces[0] || null },
    bullet: {
      kind: 'finding', tone: toneOf(s), tier: u.tier,
      since: sinces[0] || null, text: titleOf(head), detail: head.why || null,
      subject: { asset, chain: head.chain || null },
      link: { lens: LENS[head.dimension] || 'supply', focus: asset === key ? null : asset, insight: head.id },
      // The stating member first (its evidence panel opens), then the other members, then the cluster's
      // lead when it is not one of them (the verdict item's id).
      refs: [...new Set([head.id, ...u.members.map((i) => i.id), ...(u.leadInScope ? [u.lead.id] : [])])],
    },
  };
}
// Findings of a scope (units with a stating member), in order: negative first, then engine order (feed
// clusters as the engine ranked them, then the ongoing standing items).
function findingsOf(p, scope) {
  return unitsOf(p, scope).map((u) => findingOf(u, p)).filter(Boolean)
    .sort((x, y) => (x.tone === 'negative' ? 0 : 1) - (y.tone === 'negative' ? 0 : 1) || x.idx - y.idx);
}
// The peers' widest mean distance from $1 over (fromIso, toIso] (peer prices without bad prints).
function peerGaps(p, fromIso, toIso) {
  return ((p.pegPeers || []).map((q) => ({ k: q && q.symbol, g: meanGap(cDays(peerPrice(q), fromIso, toIso)) }))).filter((q) => q.k && isNum(q.g));
}
// A USD coin's peg finding restated on the period from the series the cards, the Peg lens and its table
// use (the daily consensus price): the mean distance from $1 over the period, or, when the condition began
// inside the period, since it began. The detector's own window stays in its Method panel. values: gap
// (signed mean, fraction), days (daily points), peerGap (the widest peer's mean on the same days), before
// (the typical gap before the widening, from the unit's split).
function frameFinding(c, f) {
  const b = f.bullet, a = assetOf(c.p, b.subject.asset);
  if (f.lead.dimension !== 'peg' || f.lead.detector === 'peg.gold_tracking' || !usdCoin(a) || !a.series || !validC(a.series.price)) return b;
  const since = b.since && b.since > c.from && b.since <= c.to ? b.since : null;
  const from = since ? addDays(since, -1) : c.from, xs = cDays(a.series.price, from, c.to);
  if (!xs.length) return b;
  const gap = meanGap(xs), signed = xs.reduce((t, x) => t + x.v - 1, 0) < 0 ? -1 : 1;
  // (a widening that began on the period's last day is that one day: "yesterday", as elsewhere)
  const win = since && xs.length === 1 ? 'yesterday' : since ? `since ${md(c, since)}` : `over ${PERIOD_WORDS[c.w]}`;
  const peers = peerGaps(c.p, from, c.to), pMax = peers.length ? Math.max(...peers.map((q) => q.g)) : null;
  const split = f.unit.members.find((i) => i.detector === 'peg.regime' && i.facts && isNum(i.facts.before) && typeof i.facts.since === 'string');
  const before = split ? `typically ${F.pegPct(split.facts.before)} before ${md(c, split.facts.since)}` : '';
  const peerTxt = peers.length ? `${F.list(peers.map((q) => q.k))} ${F.pegPct(pMax, { ceil: true })} or less over the same days` : '';
  return {
    ...b,
    text: `${b.subject.asset} ${F.pegPct(gap) === '0.00%' ? '≈ $1' : `${F.pegPct(gap)} ${signed < 0 ? 'below' : 'above'} $1`}${win === 'yesterday' ? '' : ' on average'} ${win}`,
    detail: [peerTxt, before].filter(Boolean).join('; ').replace(/^./, (x) => x.toUpperCase()).replace(/.$/, '$&.') || null,
    values: { gap: Number((signed * gap).toPrecision(6)), days: xs.length, peerGap: isNum(pMax) ? Number(pMax.toPrecision(6)) : null, before: split ? Number(split.facts.before.toPrecision(6)) : null },
  };
}

// ---------- verdict ----------
function verdictOf(p, scope, findings, checks) {
  const ins = p && p.insights;
  const items = findings.filter((f) => f.tier === 'major').map((f) => f.item);
  // Every other unit in scope is a smaller finding: minor ones, and lens-only units of any size (shown in
  // their lens, never stated in the briefing), so the verdict never says "Nothing unusual" over a list.
  const minor = unitsOf(p, scope).filter((u) => !(u.states && u.tier === 'major')).length;
  const errors = (ins && ins.errors) || [];
  const tone = items.some((x) => x.tone === 'negative') ? 'negative' : items.some((x) => x.tone === 'positive') ? 'positive' : items.length ? 'neutral' : null;
  const level = !ins || !ins.testsRun ? 'unknown' : items.length ? 'unusual' : errors.length ? 'partial' : minor ? 'minor' : 'clear';
  const label = (x) => (x.chain ? `${x.asset} on ${x.chain}` : `${x.asset} ${x.area}`);
  const text = level === 'unknown' ? 'Checks unavailable in this snapshot'
    : level === 'unusual' ? (items.length === 1 ? `Unusual: ${label(items[0])}` : `${items.length} unusual: ${items.slice(0, 2).map(label).join(', ')}${items.length > 2 ? ` +${items.length - 2} more` : ''}`)
      : level === 'partial' ? `Partly checked · ${errors.length} check${errors.length === 1 ? '' : 's'} could not run`
        : level === 'minor' ? `${scope === 'all' ? 'Nothing major' : `${scope}: nothing major`} · ${plural(minor, 'smaller finding')}`
          : `${scope === 'all' ? 'Nothing unusual' : `${scope}: nothing unusual`} · ${(isNum(checks) ? checks : 0).toLocaleString('en-US')} checks`;
  return { level, tone, items, minor, checks: isNum(checks) ? checks : 0, text };
}
const checksOf = (p, scope) => {
  if (scope === 'all') return (p.insights && p.insights.testsRun) || 0;
  const row = cellsOf(p)[scope];
  return row ? Object.entries(row).filter(([d]) => d !== 'data').reduce((s, [, c]) => s + ((c && c.tests) || 0), 0) : 0;
};

// ---------- frame context ----------
function frameCtx(p, w, scope) {
  const N = Number(w.slice(1)), key = keyOf(p), aw = winOf(p, w), a = scope === 'all' ? null : assetOf(p, scope);
  // One period everywhere: the attribution window for all coins and every USD coin; a coin in another unit
  // (gold) ends on its own supply day, over the same number of days.
  const own = scope !== 'all' && !(a && a.unit === 'USD');
  const supplyTo = (scope === 'all' ? p.totals && p.totals.usd && p.totals.usd.supplyAsOf : a && a.current && a.current.supplyAsOf) || p.dataAsOf || null;
  const to = !own && aw && aw.to ? aw.to : supplyTo ? String(supplyTo).slice(0, 10) : aw && aw.to ? aw.to : null;
  if (!to) return null;
  const from = !own && aw && aw.from && aw.to === to ? aw.from : addDays(to, -N);
  return { p, w, N, key, scope, from, to, floors: floorsOf(p), floorB: businessFloor(p), label: `${LABEL[N]} to ${F.monthDay(to, to)}` };
}
const inFrame = (c, iso) => Boolean(iso) && iso > c.from && iso <= c.to;
const md = (c, iso) => F.monthDay(iso, c.to);
// 'on Sep 11' within the period's year, 'in Mar 2023' before it.
const onDay = (c, iso) => `${String(iso).slice(0, 4) === String(c.to).slice(0, 4) ? 'on' : 'in'} ${md(c, iso)}`;
const floorA = (c, k) => (isNum(c.floors[k]) ? c.floors[k] : null);
const marketPct = (c) => { const mk = c.p.market && c.p.market.usdTotal; return pctOf(cAt(mk, c.to), cAt(mk, c.from)); };

// ---------- state ----------
function stateAll(c) {
  const u = c.p.totals && c.p.totals.usd;
  if (!u || !isNum(u.current)) {
    return { kind: 'state', tone: 'neutral', since: null, text: `${c.key ? `${c.key} stablecoins` : 'Stablecoins'}: no total in this snapshot`, detail: null, subject: { asset: c.key, chain: null }, link: { lens: 'supply', focus: null, insight: null }, refs: [], values: { usd: null, deltaUsd: null, pct: null, marketPct: null } };
  }
  const ch = u.change && u.change[c.w], d1 = u.change && u.change.d1, mPct = marketPct(c);
  const recToday = Boolean(u.ath && u.ath.date === c.to), rec = u.ath && inFrame(c, u.ath.date) && !recToday ? `Record ${F.money(u.ath.value)} ${onDay(c, u.ath.date)}.` : '';
  const s1 = cAt(u.marketShare, c.to), s0 = cAt(u.marketShare, c.from);
  const share = isNum(s1) && isNum(s0) ? (F.sharePlain(s1) === F.sharePlain(s0) ? `market share unchanged at ${F.sharePlain(s1)}` : `market share ${F.sharePlain(s1)}, was ${F.sharePlain(s0)}`) : isNum(s1) ? `market share ${F.sharePlain(s1)}` : '';
  const rest = [d1 && isNum(d1.abs) ? `Yesterday ${flatMoney(d1.abs)}` : '', share].filter(Boolean).join('; ');
  return {
    kind: 'state', tone: recToday ? 'positive' : 'neutral', since: null,
    text: `${F.money(u.current)} in ${c.key} stablecoins${recToday ? ' (record)' : ''}${ch && isNum(ch.abs) ? `, ${F.smoney(ch.abs)} (${F.spctPlain(ch.pct / 100)})` : ''}${isNum(mPct) ? `; all USD stablecoins ${F.spctPlain(mPct)}` : ''}`,
    detail: [rec, rest ? rest + '.' : ''].filter(Boolean).join(' ') || null,
    subject: { asset: c.key, chain: null }, link: { lens: 'supply', focus: null, insight: null }, refs: [],
    values: { usd: u.current, deltaUsd: ch && isNum(ch.abs) ? ch.abs : null, pct: ch && isNum(ch.pct) ? ch.pct : null, marketPct: isNum(mPct) ? Number((100 * mPct).toFixed(4)) : null },
  };
}
// Gold price change over a window: value change over ounce change ((1 + value %) / (1 + ounces %) - 1).
const goldPricePct = (cur, w) => { const v = cur.change && cur.change[w], n = cur.changeNative && cur.changeNative[w]; return v && n && isNum(v.pct) && isNum(n.pct) ? (1 + v.pct / 100) / (1 + n.pct / 100) - 1 : null; };
const ozTxt = (pct) => (Math.abs(pct) < 0.00005 ? 'unchanged' : F.spctPlain(pct));
// The asset's level: its USD value, else its supply in its own unit (a snapshot without prices).
function levelOf(a, k) {
  const cur = a.current || {};
  if (isNum(cur.supplyUsd)) return `${F.money(cur.supplyUsd)} ${k}`;
  if (isNum(cur.supply)) return `${k}: ${F.ounces(cur.supply, { unit: a.unit === 'oz' ? 'oz' : 'tokens' })}`;
  return null;
}
function stateAsset(c, k) {
  const a = assetOf(c.p, k), cur = (a && a.current) || {};
  if (!a) return null;
  const level = levelOf(a, k);
  if (!level) return { kind: 'state', tone: 'neutral', since: null, text: `${k}: no supply figure in this snapshot`, detail: null, subject: { asset: k, chain: null }, link: { lens: 'supply', focus: k, insight: null }, refs: [], values: { usd: null, deltaUsd: null, pct: null, marketPct: null } };
  const usd = usdCoin(a), ch = cur.change && cur.change[c.w], n = cur.changeNative && cur.changeNative[c.w], mPct = usd ? marketPct(c) : null, gp = usd ? null : goldPricePct(cur, c.w);
  const unit = a.unit === 'oz' ? 'ounces' : a.unit || 'tokens';
  const move = usd ? (ch && isNum(ch.abs) ? (Math.abs(ch.abs) < 1000 ? ', unchanged' : `, ${F.smoney(ch.abs)} (${F.spctPlain(ch.pct / 100)})`) : '')
    : n && isNum(n.pct) ? `, ${ozTxt(n.pct / 100)} in ${unit}${isNum(gp) ? `; ${goldCoin(a) ? 'gold' : 'token'} price ${F.spctPlain(gp)}` : ''}` : '';
  const d1 = usd ? cur.change && cur.change.d1 : cur.changeNative && cur.changeNative.d1;
  const y = d1 && isNum(d1.abs) ? `Yesterday ${usd ? flatMoney(d1.abs) : flatOz(d1.abs, a.unit === 'oz' ? 'oz' : '') || 'flat'}` : '';
  const tail = usd ? (isNum(cur.marketShare) ? `market share ${F.sharePlain(cur.marketShare)}` : '') : n && isNum(n.abs) && flatOz(n.abs, a.unit === 'oz' ? 'oz' : '') ? `${flatOz(n.abs, a.unit === 'oz' ? 'oz' : '')} over ${PERIOD_WORDS[c.w]}` : '';
  const detail = [y, tail].filter(Boolean).join('; ');
  return {
    kind: 'state', tone: 'neutral', since: null,
    text: `${level}${move}${isNum(mPct) ? `; all USD stablecoins ${F.spctPlain(mPct)}` : ''}`,
    detail: detail ? detail + '.' : null,
    subject: { asset: k, chain: null }, link: { lens: 'supply', focus: k, insight: null }, refs: [],
    values: { usd: isNum(cur.supplyUsd) ? cur.supplyUsd : null, deltaUsd: ch && isNum(ch.abs) ? ch.abs : null, pct: ch && isNum(ch.pct) ? ch.pct : null, ...(usd ? {} : { pctNative: n && isNum(n.pct) ? n.pct : null }), marketPct: isNum(mPct) ? Number((100 * mPct).toFixed(4)) : null },
  };
}

// ---------- movers ----------
// Where an asset's move happened: its chain rows of the window at or above its floor, never the folded
// "other" row. One named chain moving with the asset: "mostly" (more than half), "led by" (less), or, when
// that chain moved more than the asset, "led by X; other chains Y" (the part never reads larger than the
// whole); otherwise the three largest, signed, so offsetting chains show, plus "others" when the named
// chains leave a tenth of the move unexplained (tried only while the line stays within its word cap).
function whereOf(c, w, asset, delta) {
  const fl = floorA(c, asset);
  const named = ((winOf(c.p, w) || {}).chains || []).filter((r) => r.asset === asset && r.chain !== OTHER && r.deltaUsd !== 0 && isNum(fl) && Math.abs(r.deltaUsd) >= fl)
    .sort((x, y) => Math.abs(y.deltaUsd) - Math.abs(x.deltaUsd));
  if (!named.length) return { sep: '', txt: '', alt: [], chains: [] };
  if (named.length === 1 && sign(named[0].deltaUsd) === sign(delta)) {
    const r = named[0], over = Math.abs(r.deltaUsd) > Math.abs(delta), rest = delta - r.deltaUsd;
    const txt = over ? `led by ${r.chain} ${F.smoney(r.deltaUsd)}; other chains ${F.smoney(rest)}` : `${Math.abs(r.deltaUsd) > Math.abs(delta) / 2 ? 'mostly' : 'led by'} ${r.chain} ${F.smoney(r.deltaUsd)}`;
    return { sep: ', ', txt, alt: [], chains: [r.chain] };
  }
  const top = named.slice(0, 3), base = top.map((r) => `${r.chain} ${F.smoney(r.deltaUsd)}`).join(', ');
  const rest = delta - top.reduce((t, r) => t + r.deltaUsd, 0);
  const others = Math.abs(rest) >= 0.1 * Math.abs(delta) && F.money(Math.abs(rest)) !== '$0' ? `${base}, others ${F.smoney(rest)}` : null;
  return { sep: ': ', txt: others || base, alt: others ? [base] : [], chains: top.map((r) => r.chain), rows: top };
}
const pxOf = (a) => { const cur = a.current || {}; return isNum(cur.price) && cur.price > 0 ? cur.price : isNum(cur.supplyUsd) && cur.supply > 0 ? cur.supplyUsd / cur.supply : null; };
// Movers of a window: attribution asset rows (active USD coins) and other active assets (gold) as their
// change in ounces at today's price, each at or above the asset's floor, largest first.
function moverRows(c, w) {
  const rows = ((winOf(c.p, w) || {}).assets || []).filter((r) => active(c.p, r.asset)).map((r) => ({ asset: r.asset, delta: r.deltaUsd, prev: r.prevUsd, curr: r.currUsd, pct: pctOf(r.currUsd, r.prevUsd), w }));
  for (const [k, a] of Object.entries(assetsOf(c.p))) {
    if (a.status !== 'active' || usdCoin(a) || rows.some((r) => r.asset === k)) continue;
    const n = a.current && a.current.changeNative && a.current.changeNative[w], px = pxOf(a);
    if (n && isNum(n.abs) && isNum(px)) rows.push({ asset: k, delta: n.abs * px, native: n.abs, pct: isNum(n.pct) ? n.pct / 100 : null, unit: a.unit, curr: a.current.supplyUsd, w, gold: true });
  }
  return rows.filter((r) => isNum(r.delta) && isNum(floorA(c, r.asset)) && Math.abs(r.delta) >= floorA(c, r.asset)).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}
// Scale of a move from the asset's own daily series: "Largest 7-day outflow since D" (no window
// overlapping this one as large, and D at least min(3 windows, 90 days) before the period: a record set
// the week before says nothing); else "3rd week in a row of outflows" (d7).
function scaleOf(c, r) {
  const a = assetOf(c.p, r.asset), s = a && a.series && (usdCoin(a) ? a.series.supplyUsd : a.series.supply);
  if (!validC(s)) return '';
  const k = dayIdx(s, c.to), v = s.values, h = r.w === 'd1' ? 1 : c.N, sg = sign(r.delta);
  const dAt = (i) => (i - h >= 0 && i < v.length && isNum(v[i]) && isNum(v[i - h]) ? v[i] - v[i - h] : null), now = dAt(k);
  if (!isNum(now) || !sg) return '';
  const noun = `${SPAN_WORDS[h] || h + '-day'} ${sg < 0 ? 'outflow' : 'inflow'}`;
  const atLeast = (i) => { const d = dAt(i); return isNum(d) && sign(d) === sg && Math.abs(d) >= Math.abs(now); };
  let overlap = false;
  for (let i = k - h + 1; i < k; i++) if (atLeast(i)) overlap = true;
  if (!overlap) {
    let i = k - h;
    while (i >= h && !atLeast(i)) i--;
    if (i < h) return `Largest ${noun} on record.`;
    const d = addDays(s.start, i);
    if (d <= addDays(c.from, -Math.min(3 * h, 90))) return `Largest ${noun} since ${md(c, d)}.`;
  }
  if (h === 7) {
    let n = 0;
    for (let i = k; i - h >= 0; i -= h) { const d = dAt(i); if (isNum(d) && sign(d) === sg) n++; else break; }
    if (n >= 2) return `${F.ord(n)} week in a row of ${sg < 0 ? 'outflows' : 'inflows'}.`;
  }
  return '';
}
const singleChain = (a) => !a || (a.chains || []).filter((x) => isNum(x.currentUsd) && x.currentUsd > 0).length <= 1;
// The first candidate text within the word cap (a longer clause gives way to a shorter one).
const fitText = (xs) => xs.find((t) => t && words(t) <= TEXT_WORDS) || xs[xs.length - 1];
function moverBullet(c, r, yesterday = false) {
  const a = assetOf(c.p, r.asset), where = r.gold ? { sep: '', txt: '', alt: [], chains: [] } : whereOf(c, r.w, r.asset, r.delta);
  const pctTxt = r.gold ? (isNum(r.pct) ? `${F.spctPlain(r.pct)} in ${r.unit === 'oz' ? 'ounces' : r.unit || 'tokens'}` : '') : isNum(r.pct) ? F.spctPlain(r.pct) : '';
  const yRow = ((winOf(c.p, 'd1') || {}).assets || []).find((q) => q.asset === r.asset);
  // A yesterday-only bullet in a longer period says so first ("Yesterday, {asset} +$113M …").
  const head = `${yesterday ? 'Yesterday, ' : ''}${r.asset} ${F.smoney(r.delta)}${pctTxt ? ` (${pctTxt})` : ''}`;
  const texts = [where.txt, ...where.alt].map((x) => `${head}${x ? where.sep + x : ''}`).concat(head);
  return {
    kind: 'mover', tone: 'neutral', since: null,
    text: fitText(texts),
    detail: null,
    subject: { asset: r.asset, chain: where.chains[0] || null },
    link: { lens: r.gold || singleChain(a) ? 'supply' : 'chains', focus: r.asset, insight: null }, refs: [],
    values: { deltaUsd: Math.round(r.delta), pct: isNum(r.pct) ? Number((100 * r.pct).toFixed(4)) : null },
    _row: r, _texts: texts,
    // Detail candidates, the first that applies wins (record, new chain, yesterday, ounces, scale, fallback).
    _parts: {
      record: '', chain: '', yday: '',
      native: r.gold && isNum(r.native) && flatOz(r.native, 'oz') ? `${flatOz(r.native, r.unit === 'oz' ? 'oz' : '')}, at today's gold price.` : '',
      scale: yesterday ? '' : scaleOf(c, r),
      fallback: !yesterday && yRow && isNum(yRow.deltaUsd) ? `Yesterday ${flatMoney(yRow.deltaUsd)}; now ${F.money(yRow.currUsd)}.` : '',
    },
  };
}
const finishMover = (m) => { const q = m._parts; m.detail = q.record || q.chain || q.yday || q.native || q.scale || q.fallback || null; return m; };
// Yesterday folded into its asset's mover: "…; +$113M yesterday" on the line when it fits, the chains of
// yesterday (or what the other days did, when yesterday outweighs the period) in the detail.
function foldYesterday(c, m, y) {
  const wy = whereOf(c, 'd1', y.asset, y.delta), d = m._row.delta;
  const tail = `; ${F.smoney(y.delta)} yesterday`, rest = d - y.delta;
  const lines = m._texts.map((t) => t + tail).filter((t) => words(t) <= TEXT_WORDS);
  const restTxt = `${F.money(Math.abs(rest)) === '$0' ? 'Flat' : F.smoney(rest)} over the ${plural(c.N - 1, 'day')} before.`;
  const outweighs = sign(y.delta) !== sign(d) || Math.abs(y.delta) > Math.abs(d);
  if (lines.length) {
    m.text = lines[0];
    m._parts.yday = outweighs ? restTxt : wy.txt ? `Yesterday: ${wy.txt}.` : '';
  } else {
    m._parts.yday = outweighs ? `Yesterday ${F.smoney(y.delta)}; ${restTxt.replace(/^./, (x) => x.toLowerCase())}` : `${F.smoney(y.delta)} of it yesterday${wy.txt ? wy.sep + wy.txt : ''}.`;
  }
}

// ---------- events ----------
// Records inside the period ("Record: … on D", detail: the level at the period start), new chains
// ("New chain: …", or "first tracked … at $X" when the chain's first day already held at least the asset's
// floor: the tracking started there, it did not launch), a change of the largest coin.
function eventsOf(c, onlyAsset = null) {
  const out = [], p = c.p, issuer = issuerWord(c.key);
  for (const [k, a] of Object.entries(assetsOf(p))) {
    if (onlyAsset ? k !== onlyAsset : a.status !== 'active') continue;
    const usd = usdCoin(a), cur = a.current || {}, ath = usd ? cur.ath : cur.athNative;
    const fmtLevel = (x) => (usd ? F.money(x) : F.ounces(x, { unit: a.unit === 'oz' ? 'oz' : a.unit }));
    if (ath && isNum(ath.value) && inFrame(c, ath.date)) {
      const s = a.series && (usd ? a.series.supplyUsd : a.series.supply), start = cAt(s, c.from);
      out.push({
        kind: 'event', tone: 'positive', since: null, text: `Record: ${k} supply ${fmtLevel(ath.value)} on ${md(c, ath.date)}`,
        detail: isNum(start) ? `Up from ${fmtLevel(start)} ${onDay(c, c.from)}.` : null,
        subject: { asset: k, chain: null }, link: { lens: 'supply', focus: k, insight: null }, refs: [], _record: `Record high ${onDay(c, ath.date)}.`, _usd: usd ? ath.value : ath.value * (pxOf(a) || 0),
      });
    }
    const firsts = (a.chains || []).map((x) => x.first).filter(Boolean), fl = floorA(c, k);
    for (const ch of a.chains || []) {
      // Several chains starting on one day are a tracking change, not launches; a chain under the
      // asset's floor is dust.
      if (!inFrame(c, ch.first) || ch.status === 'tracking_ended' || firsts.filter((f) => f === ch.first).length > 1 || !isNum(fl) || !(ch.currentUsd >= fl)) continue;
      const v0 = cAt(ch.series, ch.first), tracked = isNum(v0) && v0 >= fl;
      out.push({
        kind: 'event', tone: 'positive', since: ch.first,
        text: tracked ? `${k} on ${ch.chain}: first tracked ${md(c, ch.first)} at ${F.money(v0)}, ${F.money(ch.currentUsd)} now` : `New chain: ${k} on ${ch.chain} since ${md(c, ch.first)}, ${F.money(ch.currentUsd)} so far`,
        detail: isNum(ch.share) ? `${F.pctPlain(ch.share)} of ${k} is on ${ch.chain}.` : null,
        subject: { asset: k, chain: ch.chain }, link: { lens: 'chains', focus: k, insight: null }, refs: [], _usd: ch.currentUsd,
        _chain: tracked ? `${ch.chain} first tracked ${md(c, ch.first)} at ${F.money(v0)}.` : `${ch.chain} new since ${md(c, ch.first)}.`,
      });
    }
  }
  const rows = ((winOf(p, c.w) || {}).assets || []).filter((r) => active(p, r.asset) && usdCoin(assetOf(p, r.asset)));
  if (rows.length > 1) {
    const before = rows.slice().sort((x, y) => y.prevUsd - x.prevUsd)[0], now = rows.slice().sort((x, y) => y.currUsd - x.currUsd)[0];
    if (before.asset !== now.asset && (!onlyAsset || onlyAsset === before.asset || onlyAsset === now.asset)) {
      out.push({
        kind: 'event', tone: 'neutral', since: null, text: `${now.asset} passed ${before.asset} as the largest ${issuer} stablecoin: ${F.money(now.currUsd)} vs ${F.money(before.currUsd)}`,
        detail: `${before.asset} was larger ${onDay(c, c.from)}.`,
        subject: { asset: now.asset, chain: null }, link: { lens: 'supply', focus: null, insight: null }, refs: [], _usd: now.currUsd,
      });
    }
  }
  return out.sort((x, y) => (y._usd || 0) - (x._usd || 0));
}

// ---------- steady lines ----------
// Widest daily distance from $1 over the period (the consensus daily price the peg checks use).
function widest(c, s) {
  const xs = cDays(s, c.from, c.to);
  if (!xs.length) return null;
  const w = xs.reduce((m, x) => (Math.abs(x.v - 1) > Math.abs(m.v - 1) ? x : m));
  return { g: Math.abs(w.v - 1), side: w.v < 1 ? 'below' : 'above', iso: w.iso };
}
// A coin with a peg item in the engine's lists (new, ongoing or watch), or a peg split inside the period,
// is never called "Steady".
function pegNoted(c, k) {
  const ins = c.p.insights;
  if (!ins) return false;
  const all = [...(ins.feed || []).flatMap((x) => [x.lead, ...(x.related || [])]), ...(ins.standing || []), ...(ins.watch || [])].filter(Boolean);
  return all.some((i) => i.asset === k && i.dimension === 'peg' && (['new', 'ongoing', 'watch'].includes(stageOf(i)) || (i.detector === 'peg.regime' && i.novelty && inFrame(c, i.novelty.since))));
}
// The peg of the given USD coins against the peers' widest day (peer prices without bad prints): coins
// inside the peers' range are grouped ("within X% of $1 all week": every day), each one outside is named
// with its widest day and its date. "Steady:" (tone positive) only when none is outside, every coin's peg
// cell is within its own history and no peg item or split is about it.
function pegLine(c, coins) {
  const p = c.p, phrase = STEADY_PHRASE[c.N];
  const mine = coins.map((k) => { const a = assetOf(p, k), x = a && a.series ? widest(c, a.series.price) : null; return x ? { k, ...x } : null; }).filter(Boolean).sort((x, y) => x.g - y.g || (x.k < y.k ? -1 : 1));
  if (!mine.length) return null;
  const peers = ((p.pegPeers || []).map((q) => ({ k: q && q.symbol, x: q ? widest(c, peerPrice(q)) : null }))).filter((q) => q.k && q.x);
  const pMax = peers.length ? Math.max(...peers.map((q) => q.x.g)) : Infinity;
  const inside = mine.filter((x) => x.g <= pMax), outside = mine.filter((x) => x.g > pMax);
  const steady = !outside.length && mine.every((x) => calm(p, x.k, ['peg']) && !pegNoted(c, x.k));
  const within = (names) => `${names} within ${F.pegPct(Math.max(...inside.map((x) => x.g), 0.0001), { ceil: true })} of $1 ${phrase}`;
  const outs = outside.map((x) => `${x.k}'s widest day ${F.pegPct(x.g)} ${x.side} $1 (${md(c, x.iso)})`);
  const peerTail = !inside.length && peers.length ? `; peers within ${F.pegPct(pMax, { ceil: true })}` : '';
  const build = (insideNames, outsideParts) => `${steady ? 'Steady: ' : ''}${[inside.length ? within(insideNames) : '', ...outsideParts].filter(Boolean).join('; ')}${peerTail}`;
  const cands = [build(F.list(inside.map((x) => x.k)), outs), build(plural(inside.length, 'coin'), outs)];
  if (outside.length > 1) {
    const mx = F.pegPct(Math.max(...outside.map((x) => x.g)));
    cands.push(build(plural(inside.length, 'coin'), [`${F.list(outside.map((x) => x.k))} up to ${mx} from $1 on their widest day`]), build(plural(inside.length, 'coin'), [`${F.list(outside.map((x) => x.k))} up to ${mx} from $1`]));
  }
  return {
    kind: 'steady', tone: steady ? 'positive' : 'neutral', since: null, text: fitText(cands),
    detail: peers.length ? (peerTail ? `Peers: ${F.list(peers.map((q) => q.k))} (daily prices).` : `${F.list(peers.map((q) => q.k))} within ${F.pegPct(pMax, { ceil: true })} (daily prices).`) : 'Daily prices.',
    subject: { asset: coins.length === 1 ? coins[0] : null, chain: null }, link: { lens: 'peg', focus: coins.length === 1 ? coins[0] : null, insight: null }, refs: [],
    _coins: mine.map((x) => x.k),
  };
}
// Gold: issuance in ounces kept apart from the gold price. "{k} supply steady:" (tone positive) when its
// supply and peg cells are within their own history.
function goldLine(c, k) {
  const a = assetOf(c.p, k), cur = (a && a.current) || {}, n = cur.changeNative && cur.changeNative[c.w];
  if (!a || !n || !isNum(n.pct)) return null;
  const gp = goldPricePct(cur, c.w), unit = a.unit === 'oz' ? 'ounces' : a.unit || 'tokens', steady = calm(c.p, k, ['supply', 'peg']);
  return {
    kind: 'steady', tone: steady ? 'positive' : 'neutral', since: null,
    text: `${k}${steady ? ' supply steady:' : ''} ${ozTxt(n.pct / 100)} in ${unit}${isNum(gp) ? `; gold price ${F.spctPlain(gp)}` : ''}`,
    detail: [isNum(n.abs) ? flatOz(n.abs, a.unit === 'oz' ? 'oz' : '') : '', isNum(cur.supplyUsd) ? `${F.money(cur.supplyUsd)} in total` : ''].filter(Boolean).join('; ').replace(/.$/, '$&.') || null,
    subject: { asset: k, chain: null }, link: { lens: 'supply', focus: k, insight: null }, refs: [],
  };
}
// Filler (kind 'filler', the page marks it as context): another period's change, the period first
// ("30 days: −$334M net, {A} −$190M, {B} −$142M"; one asset: "30 days: {asset} +0.9% in ounces; …").
const periodHead = (w) => PERIOD_WORDS[w][0].toUpperCase() + PERIOD_WORDS[w].slice(1);
function fillerAll(c, w) {
  const aw = winOf(c.p, w), u = c.p.totals && c.p.totals.usd;
  let text = null;
  if (aw && isNum(aw.totalDeltaUsd)) {
    const top = (aw.assets || []).filter((r) => isNum(floorA(c, r.asset)) && Math.abs(r.deltaUsd) >= floorA(c, r.asset)).slice(0, 2);
    text = `${periodHead(w)}: ${F.smoney(aw.totalDeltaUsd)} net${top.length ? ', ' + top.map((r) => `${r.asset} ${F.smoney(r.deltaUsd)}`).join(', ') : ''}`;
  } else if (u && u.change && u.change[w] && isNum(u.change[w].abs)) {
    text = `${periodHead(w)}: ${c.key} ${F.smoney(u.change[w].abs)} (${F.spctPlain(u.change[w].pct / 100)})`;
  }
  return text ? { kind: 'filler', tone: 'neutral', since: null, text, detail: aw ? `${md(c, aw.from)} to ${md(c, aw.to)}, by coin.` : null, subject: { asset: c.key, chain: null }, link: { lens: 'supply', focus: null, insight: null }, refs: [] } : null;
}
function fillerAsset(c, k, w) {
  const a = assetOf(c.p, k), cur = (a && a.current) || {}, usd = usdCoin(a), ch = cur.change && cur.change[w], n = cur.changeNative && cur.changeNative[w];
  let text = null;
  if (usd && ch && isNum(ch.abs)) text = Math.abs(ch.abs) < 1000 ? `${periodHead(w)}: ${k} unchanged` : `${periodHead(w)}: ${k} ${F.smoney(ch.abs)} (${F.spctPlain(ch.pct / 100)})`;
  else if (!usd && n && isNum(n.pct)) { const gp = goldPricePct(cur, w); text = `${periodHead(w)}: ${k} ${ozTxt(n.pct / 100)} in ${a.unit === 'oz' ? 'ounces' : a.unit || 'tokens'}${isNum(gp) && goldCoin(a) ? `; gold price ${F.spctPlain(gp)}` : ''}`; }
  return text ? { kind: 'filler', tone: 'neutral', since: null, text, detail: null, subject: { asset: k, chain: null }, link: { lens: 'supply', focus: k, insight: null }, refs: [] } : null;
}
// Other periods for fillers: the next longer one first, then the rest (longer before shorter).
const fillerWindows = (w) => [NEXT[w], ...FRAMES.map(([x]) => x).filter((x) => x !== w && x !== NEXT[w]).sort((x, y) => Number(y.slice(1)) - Number(x.slice(1)))].filter(Boolean);

// ---------- assembly ----------
// A bullet whose text or detail breaks the copy rules is dropped (text) or loses its detail.
function clean(b, c) {
  if (!b) return null;
  if (typeof b.text !== 'string' || !b.text || BROKEN.test(b.text) || words(b.text) > TEXT_WORDS) {
    if (b && b.text) c.errors.push({ builder: 'copy', frame: c.w, asset: c.scope === 'all' ? null : c.scope, error: `dropped bullet: ${b.text}`.slice(0, 200) });
    return null;
  }
  if (b.detail && (BROKEN.test(b.detail) || words(b.detail) > DETAIL_WORDS)) b.detail = null;
  const { _row, _parts, _record, _usd, _coins, _texts, _chain, ...out } = b;
  return out;
}
function order(bullets) {
  return bullets.map((b, i) => ({ b, i })).sort((x, y) => ORDER[x.b.kind] - ORDER[y.b.kind] || x.i - y.i).map((x) => x.b);
}

function frameAll(c, findings) {
  const guard = (name, fn, fallback) => { try { return fn(); } catch (e) { c.errors.push({ builder: name, frame: c.w, asset: null, error: String((e && e.message) || e).slice(0, 200) }); return fallback; } };
  const bf = isNum(c.floorB) ? c.floorB : Infinity;
  const state = guard('state', () => stateAll(c), null);
  const major = findings.filter((f) => f.tier === 'major').slice(0, MAX_FINDINGS);
  // A flow finding about an asset absorbs that asset's mover in the same direction: one story, one bullet.
  const absorbed = (asset, dir, fs) => fs.some((f) => FLOW_DIMS.has(f.lead.dimension) && f.lead.asset === asset && (!f.dir || f.dir === dir));
  const rows = guard('movers', () => moverRows(c, c.w), []);
  const movers = rows.filter((r) => !absorbed(r.asset, sign(r.delta), major)).map((r) => moverBullet(c, r));
  // Yesterday, when the day moved the total by at least an ordinary day: folded into that asset's mover
  // (same asset, foldYesterday), else its own bullet ("Yesterday, …").
  let yBullet = null;
  const d1 = c.p.totals && c.p.totals.usd && c.p.totals.usd.change && c.p.totals.usd.change.d1;
  if (c.N > 1 && d1 && isNum(d1.abs) && Math.abs(d1.abs) >= bf) guard('yesterday', () => {
    const y = moverRows(c, 'd1')[0];
    if (!y) return;
    const same = movers.find((m) => m._row.asset === y.asset);
    if (same) foldYesterday(c, same, y);
    else if (!absorbed(y.asset, sign(y.delta), major) && !rows.some((r) => r.asset === y.asset)) yBullet = moverBullet(c, y, true);
  });
  // Records and new chains of an asset shown as a mover go into that mover's detail (one bullet per asset,
  // and the chain in the mover's clause is explained there); a total record goes to the state.
  const events = guard('events', () => eventsOf(c), []).filter((e) => {
    if (!e._record && !e._chain) return true;
    const m = movers.find((x) => x._row.asset === e.subject.asset);
    if (!m) return true;
    if (e._record) m._parts.record = e._record;
    else if (!m._parts.chain) m._parts.chain = e._chain;
    return false;
  });
  for (const m of [...movers, yBullet].filter(Boolean)) finishMover(m);
  const goldKeys = Object.entries(assetsOf(c.p)).filter(([, a]) => a.status === 'active' && goldCoin(a)).map(([k]) => k);
  const fAssets = new Set(major.map((f) => f.lead.asset));
  const golds = goldKeys.filter((k) => !fAssets.has(k) && !movers.some((m) => m._row.asset === k && Math.abs(m._row.delta) >= bf)).map((k) => guard('gold', () => goldLine(c, k), null)).filter(Boolean);
  const goldLined = new Set(golds.map((g) => g.subject.asset));
  const pegSkip = new Set(major.filter((f) => f.lead.dimension === 'peg').map((f) => f.lead.asset));
  const usdCoins = Object.entries(assetsOf(c.p)).filter(([k, a]) => a.status === 'active' && usdCoin(a) && !pegSkip.has(k)).map(([k]) => k);
  const peg = guard('peg', () => pegLine(c, usdCoins), null);
  const big = [...movers, yBullet].filter((m) => m && Math.abs(m._row.delta) >= bf).sort((x, y) => Math.abs(y._row.delta) - Math.abs(x._row.delta));
  const fb = (f) => guard('finding', () => frameFinding(c, f), f.bullet);
  const core = [state, ...major.map(fb), big[0], ...events, ...big.slice(1), peg, ...golds].filter(Boolean).slice(0, MAX);
  // Quiet periods: asset-level items (rare for a coin, small for the business), then other periods,
  // only up to MIN. A small gold mover gives way to the gold line.
  const small = [
    ...findings.filter((f) => f.tier === 'minor').filter((f) => !(FLOW_DIMS.has(f.lead.dimension) && [...movers, yBullet].some((m) => m && m._row.asset === f.lead.asset && (!f.dir || f.dir === sign(m._row.delta))))).map((f) => ({ b: fb(f), size: f.size })),
    ...[...movers, yBullet].filter((m) => m && !big.includes(m) && !goldLined.has(m._row.asset)).map((m) => ({ b: m, size: Math.abs(m._row.delta) })),
  ].sort((x, y) => y.size - x.size).map((x) => x.b);
  const pick = core.concat(small.slice(0, Math.max(0, MIN - core.length)));
  // The peg line never repeats a coin that has a peg finding in the briefing.
  const pegShown = new Set(pick.filter((b) => b.kind === 'finding' && b.link.lens === 'peg').map((b) => b.subject.asset));
  const li = pick.indexOf(peg);
  if (li >= 0 && peg._coins.some((k) => pegShown.has(k))) {
    const nl = guard('peg', () => pegLine(c, usdCoins.filter((k) => !pegShown.has(k))), null);
    if (nl) pick[li] = nl; else pick.splice(li, 1);
  }
  return withFillers(c, order(pick).map((b) => clean(b, c)).filter(Boolean), (w) => guard('filler', () => fillerAll(c, w), null));
}
// Other periods fill a quiet frame up to MIN (after the copy rules, so a dropped line is replaced too).
function withFillers(c, out, make) {
  for (const w of fillerWindows(c.w)) {
    if (out.length >= MIN) break;
    const t = clean(make(w), c);
    if (t && !out.some((x) => x.text === t.text)) out.push(t);
  }
  return out;
}

function frameAsset(c, k, findings) {
  const guard = (name, fn, fallback) => { try { return fn(); } catch (e) { c.errors.push({ builder: name, frame: c.w, asset: k, error: String((e && e.message) || e).slice(0, 200) }); return fallback; } };
  const a = assetOf(c.p, k);
  const state = guard('state', () => stateAsset(c, k), null);
  const major = findings.filter((f) => f.tier === 'major').slice(0, MAX_FINDINGS);
  const events = guard('events', () => eventsOf(c, k), []);
  const covered = new Set([...major.map((f) => f.lead.chain), ...events.map((e) => e.subject.chain)].filter(Boolean));
  const chainMovers = guard('chains', () => {
    const fl = floorA(c, k);
    return ((winOf(c.p, c.w) || {}).chains || []).filter((r) => r.asset === k && r.chain !== OTHER && r.deltaUsd !== 0 && isNum(fl) && Math.abs(r.deltaUsd) >= fl && !covered.has(r.chain))
      .sort((x, y) => Math.abs(y.deltaUsd) - Math.abs(x.deltaUsd)).slice(0, MAX_CHAIN_MOVERS).map((r) => {
        const ch = ((a && a.chains) || []).find((q) => q.chain === r.chain), pc = pctOf(r.currUsd, r.prevUsd);
        return {
          kind: 'mover', tone: 'neutral', since: null, text: `${r.chain} ${F.smoney(r.deltaUsd)}${isNum(pc) ? ` (${F.spctPlain(pc)})` : ''}, now ${F.money(r.currUsd)}`,
          detail: ch && isNum(ch.share) ? `${F.pctPlain(ch.share)} of ${k} is on ${r.chain}.` : null,
          subject: { asset: k, chain: r.chain }, link: { lens: 'chains', focus: k, insight: null }, refs: [],
          values: { deltaUsd: r.deltaUsd, pct: isNum(pc) ? Number((100 * pc).toFixed(4)) : null },
        };
      });
  }, []);
  const hasPeg = findings.some((f) => f.lead.dimension === 'peg' && f.lead.asset === k && major.includes(f));
  const peg = usdCoin(a) && !hasPeg ? guard('peg', () => pegLine(c, [k]), null) : null;
  const fb = (f) => guard('finding', () => frameFinding(c, f), f.bullet);
  // Gold: the state line already separates ounces from the gold price, so no gold line here.
  const core = [state, ...major.map(fb), ...events, ...chainMovers, peg].filter(Boolean).slice(0, MAX);
  const small = findings.filter((f) => f.tier === 'minor').map(fb);
  const pick = core.concat(small.slice(0, Math.max(0, MIN - core.length)));
  // A smaller peg finding about the coin replaces its peg line (same subject, more specific).
  if (pick.includes(peg) && pick.some((b) => b.kind === 'finding' && b.link.lens === 'peg' && b.subject.asset === k)) pick.splice(pick.indexOf(peg), 1);
  return withFillers(c, order(pick).map((b) => clean(b, c)).filter(Boolean), (w) => guard('filler', () => fillerAsset(c, k, w), null));
}

function frameOut(c, bullets, findings) {
  const shownMinor = bullets.filter((b) => b.kind === 'finding' && b.tier === 'minor').length;
  const minorUnits = findings ? findings.filter((f) => f.tier === 'minor').length : 0;
  return { window: c.w, days: c.N, from: c.from, to: c.to, label: c.label, more: Math.max(0, minorUnits - shownMinor), bullets };
}

// buildFrame(payload, window, scope = 'all') -> Frame | null: one period of one scope (for tests).
function buildFrame(p, w, scope = 'all', errors = []) {
  const c = frameCtx(p, w, scope);
  if (!c) return null;
  c.errors = errors;
  const findings = (() => { try { return findingsOf(p, scope); } catch (e) { errors.push({ builder: 'findings', frame: w, asset: scope === 'all' ? null : scope, error: String((e && e.message) || e).slice(0, 200) }); return []; } })();
  const bullets = scope === 'all' ? frameAll(c, findings) : frameAsset(c, scope, findings);
  return frameOut(c, bullets, findings);
}

function scopeOut(p, scope, errors) {
  let findings = [];
  try { findings = findingsOf(p, scope); } catch (e) { errors.push({ builder: 'findings', frame: null, asset: scope === 'all' ? null : scope, error: String((e && e.message) || e).slice(0, 200) }); }
  let verdict;
  try { verdict = verdictOf(p, scope, findings, checksOf(p, scope)); } catch (e) {
    errors.push({ builder: 'verdict', frame: null, asset: scope === 'all' ? null : scope, error: String((e && e.message) || e).slice(0, 200) });
    verdict = { level: 'unknown', tone: null, items: [], minor: 0, checks: 0, text: 'Checks unavailable in this snapshot' };
  }
  const frames = {};
  for (const [w] of FRAMES) {
    const c = frameCtx(p, w, scope);
    if (!c) continue;
    c.errors = errors;
    let bullets = [];
    try { bullets = scope === 'all' ? frameAll(c, findings) : frameAsset(c, scope, findings); } catch (e) {
      errors.push({ builder: 'frame', frame: w, asset: scope === 'all' ? null : scope, error: String((e && e.message) || e).slice(0, 200) });
    }
    frames[w] = frameOut(c, bullets, findings);
  }
  return { verdict, frames, findings };
}

// applyBriefing(payload) -> briefing. Sets insight.tier in place (tierOf at the all-coins scope) on new and
// ongoing items that are not notes, API-only or context; null otherwise. Never throws.
function applyBriefing(p) {
  const errors = [];
  try {
    const ins = p && p.insights;
    if (ins) {
      const all = [...(ins.feed || []).flatMap((c) => [c.lead, ...(c.related || [])]), ...(ins.standing || []), ...(ins.watch || []), ...(ins.context || [])].filter(Boolean);
      for (const list of (ins.feed || [])) for (const i of [list.lead, ...(list.related || [])]) if (i) FEED.add(i);
      for (const i of all) {
        try { i.tier = live(i) && nonData(i) && !['note', 'api', 'context'].includes(roleOf(i)) ? tierOf(i, p, 'all') : null; } catch (e) { i.tier = null; errors.push({ builder: 'tier', frame: null, asset: i.asset || null, error: String((e && e.message) || e).slice(0, 200) }); }
      }
    }
    const top = scopeOut(p, 'all', errors);
    const byAsset = {};
    for (const k of Object.keys(assetsOf(p))) { const x = scopeOut(p, k, errors); byAsset[k] = { verdict: x.verdict, frames: x.frames }; }
    const bf = businessFloor(p);
    return {
      version: 1,
      asOf: (p.totals && p.totals.usd && p.totals.usd.supplyAsOf) || null,
      key: keyOf(p),
      floorUsd: isNum(bf) ? Math.round(bf) : null,
      peers: peerSymbols(p),
      verdict: top.verdict,
      frames: top.frames,
      byAsset,
      errors,
    };
  } catch (e) {
    errors.push({ builder: 'briefing', frame: null, asset: null, error: String((e && e.message) || e).slice(0, 200) });
    return { version: 1, asOf: null, key: keyOf(p), floorUsd: null, peers: [], verdict: { level: 'unknown', tone: null, items: [], minor: 0, checks: 0, text: 'Checks unavailable in this snapshot' }, frames: {}, byAsset: {}, errors };
  }
}

module.exports = { applyBriefing, tierOf, buildFrame, FRAMES, PRECEDENCE, MAX, MIN, TEXT_WORDS, DETAIL_WORDS };
