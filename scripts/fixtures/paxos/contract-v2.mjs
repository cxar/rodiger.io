// The /api/paxos payload contract (schemaVersion 1, v2 additions), shared by every Paxos check and
// the day-1 sample (contract-v2.sample.json). The rules are written from docs/paxos-dashboard.md and
// FINAL-SPEC §4 and §6.2, independently of lib/paxos, so a producer bug cannot pass by agreeing with
// itself:
//   validate(payload)        -> list of contract errors (shapes, enums, nullability, unknown keys)
//   validateV2(payload)      -> list of v2 semantic errors (caps, banned words, stage/role/tier rules,
//                               status and cache rules); validate() calls it
//   validateBriefing(payload)-> the briefing's own rules (frames, bullets, links, verdict copy)
//   tierOf(i, payload, scope), expectedReasons(p), expectedSMaxAge(p), verdictText(v, scope, p):
//                               §4.3 tiers, the H11 status reasons, the H7 CDN budget, §3.3 verdict copy
//   countWords(s), BANNED, BAD_TEXT, ROLE_OF, LENS_OF, AREA_OF: the copy rules (§3.17, §4.1, §4.4)
//   mergeSample(payload, sample), stripV2(payload): build a v2-shaped or a v1 (older) payload
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DIMENSIONS } = require('../../../lib/paxos/engine.js');

// ---------- copy rules ----------
// §4.1 banned vocabulary (titles, why, briefing text and the whole default view).
export const BANNED = /\b(p ?=|E ?=|bits?|materiality|material|rotation|regime|effective|notable|Pareto|CUSUM|robust|percentile|drawdown|dimension|cluster|novelty|underpowered|null|bps?|basis points?|utilised|should|consider|warning|risk)\b/i;
// §3.17: a whitespace token counts when its first letter-or-digit is a letter (tickers, chain names and
// months count; $5.85B, −1.0%, 7d and glyph-only tokens do not).
export const countWords = (s) => String(s || '').split(/\s+/).filter((x) => { const m = /[A-Za-z0-9]/.exec(x); return !!m && /[A-Za-z]/.test(m[0]); }).length;
// Generated text never prints a placeholder or an empty sign.
export const BAD_TEXT = /\bNaN\b|\bundefined\b|\bnull\b|\bInfinity\b|\[object|(^|\s)n\/a(\s|$|[.,;:)])|[+−]\$(?!\d)|[+−]%|(^|[\s(])[+−](?=$|[\s,.;:)])/;
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// §4.4 role of each detector (peg.deviation by variant).
export const ROLE_OF = {
  'supply.move': 'headline', 'supply.drawdown': 'headline', 'supply.regime': 'headline', 'market.share': 'headline', 'market.peer_growth': 'headline',
  'chain.move': 'headline', 'chain.lifecycle': 'headline', 'peg.deviation:abs': 'headline', 'peg.regime': 'headline', 'peg.gold_tracking': 'headline',
  'usage.turnover': 'headline', 'usage.activity': 'headline', 'economics.reserve_income': 'headline',
  'supply.streak': 'evidence', 'peg.deviation:excess': 'evidence',
  'supply.bridged_out': 'lens', 'chain.attribution': 'lens', 'chain.concentration': 'lens', 'chain.dominance': 'lens', 'defi.utilization': 'lens',
  'defi.yield_outlier': 'lens', 'defi.tvl_trend': 'lens', 'defi.divergence': 'lens', 'portfolio.mix': 'lens', 'portfolio.leadership': 'lens', 'economics.rate_regime': 'lens',
  'defi.footprint': 'context',
  'dq.cross_source': 'note', 'dq.history_gap': 'note', 'dq.tracking_change': 'note', 'dq.freshness': 'note', 'dq.price_sanity': 'note', 'dq.list_reconciliation': 'note', 'dq.frozen': 'note',
  'peg.flow_coupling': 'api',
};
export const roleKey = (i) => (i.detector === 'peg.deviation' ? `peg.deviation:${/:excess(:|$)/.test(i.id) ? 'excess' : 'abs'}` : i.detector);
// §3.7 dimension -> lens; §3.3 dimension -> verdict area word.
export const LENS_OF = { supply: 'supply', portfolio: 'supply', chains: 'chains', peg: 'peg', market: 'market', defi: 'usage', usage: 'usage', economics: 'income' };
export const AREA_OF = { supply: 'supply', portfolio: 'supply', market: 'market share', chains: 'chains', peg: 'peg', defi: 'usage', usage: 'usage', economics: 'income' };
export const LENSES = ['supply', 'chains', 'peg', 'market', 'usage', 'income'];
export const FRAMES = { d7: 7, d30: 30, d90: 90, d365: 365 };
export const FRAME_LABEL = { d7: 'Last 7 days to', d30: 'Last 30 days to', d90: 'Last 90 days to', d365: 'Last 12 months to' };
// §4.7 precedence of the member that states a finding bullet.
export const PRECEDENCE = ['peg.deviation:abs', 'peg.gold_tracking', 'peg.deviation:excess', 'peg.regime', 'supply.move', 'supply.drawdown', 'supply.regime', 'market.peer_growth', 'market.share', 'chain.move', 'chain.lifecycle', 'usage.activity', 'usage.turnover', 'economics.reserve_income'];
// §4.1 rule 6: the fallback title (never shipped).
export function fallbackTitle(headline) {
  const h = String(headline || '');
  const cut = h.slice(20).search(/[;:]/);
  const head = cut < 0 ? h : h.slice(0, 20 + cut);
  const words = head.split(/\s+/).filter(Boolean);
  return words.length > 14 ? words.slice(0, 14).join(' ') + '…' : head;
}

// ---------- a small structural validator ----------
// spec: 'type' | 'type?' (nullable) | [spec] | { key: spec, 'key?': spec (optional) } | { $map: spec } |
// { $enum: [...] } | { $nullable: spec } | function(x, path) -> error string | null
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const prim = {
  string: (x) => typeof x === 'string', number: isNum, integer: (x) => Number.isInteger(x), boolean: (x) => typeof x === 'boolean',
  date: (x) => typeof x === 'string' && DATE.test(x), iso: (x) => typeof x === 'string' && ISO.test(x), any: () => true, object: (x) => !!x && typeof x === 'object' && !Array.isArray(x),
};
export function check(x, spec, path, errors) {
  if (typeof spec === 'string') {
    const nullable = spec.endsWith('?'), t = nullable ? spec.slice(0, -1) : spec;
    if (x === null && nullable) return;
    if (!prim[t](x)) errors.push(`${path}: expected ${spec}, got ${JSON.stringify(x)?.slice(0, 60)}`);
    return;
  }
  if (typeof spec === 'function') { const e = spec(x, path); if (e) errors.push(`${path}: ${e}`); return; }
  if (Array.isArray(spec)) {
    if (!Array.isArray(x)) return void errors.push(`${path}: expected array`);
    x.forEach((y, i) => check(y, spec[0], `${path}[${i}]`, errors));
    return;
  }
  if (spec.$nullable) { if (x === null) return; return check(x, spec.$nullable, path, errors); }
  if (spec.$enum) { if (!spec.$enum.includes(x)) errors.push(`${path}: ${JSON.stringify(x)} not in ${spec.$enum.join('|')}`); return; }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return void errors.push(`${path}: expected object`);
  if (spec.$map) { for (const [k, y] of Object.entries(x)) check(y, spec.$map, `${path}.${k}`, errors); return; }
  const keys = new Set();
  for (const [k0, s] of Object.entries(spec)) {
    const optional = k0.endsWith('?'), k = optional ? k0.slice(0, -1) : k0;
    keys.add(k);
    if (!(k in x)) { if (!optional) errors.push(`${path}.${k}: missing`); continue; }
    check(x[k], s, `${path}.${k}`, errors);
  }
  for (const k of Object.keys(x)) if (!keys.has(k)) errors.push(`${path}.${k}: unexpected key`);
}
const N = (spec) => ({ $nullable: spec });
const E = (...xs) => ({ $enum: xs });
export const compactOf = (max) => (x) => {
  if (!x || typeof x !== 'object' || !DATE.test(x.start) || !Array.isArray(x.values)) return 'expected Compact {start, values}';
  if (!x.values.length) return 'empty Compact';
  if (max && x.values.length > max) return `Compact longer than ${max} values (${x.values.length})`;
  if (!x.values.every((y) => y === null || isNum(y))) return 'Compact values must be numbers or null';
  if (Object.keys(x).length !== 2) return 'Compact has extra keys';
  return null;
};
const Compact = compactOf(null);
const change = N({ abs: 'number', pct: 'number?' });
const Changes = { d1: change, d7: change, d30: change, d90: change, d365: change };
const hourlySpec = N((x) => (x && Array.isArray(x.t) && Array.isArray(x.v) && x.t.length === x.v.length && x.t.length > 0 && x.t.every(Number.isInteger) && x.v.every((y) => y === null || isNum(y)) && x.t.every((t, i) => !i || t > x.t[i - 1]) ? null : 'expected hourly {t:[unix asc], v:[]}'));
const STAGES = ['new', 'ongoing', 'past', 'watch', 'context'];
const ROLES = ['headline', 'evidence', 'lens', 'context', 'note', 'api'];
const UNITS = ['usd', 'fraction', 'count', 'oz', 'ratio', 'usdPerDay'];
export const insightSpec = ({ facts }) => ({
  id: 'string', detector: 'string', asset: 'string', chain: 'string?', dimension: { $enum: DIMENSIONS },
  polarity: E('positive', 'negative', 'neutral'),
  surprise: { bits: 'number?', adjustedBits: 'number?', p: 'number', E: 'number', m: 'integer', notable: 'boolean', underpowered: 'boolean' },
  materialityUsd: 'number?', materialityShare: 'number?', materialityFloorUsd: 'number?',
  novelty: { ageDays: 'integer?', isNew: 'boolean', front: 'integer?', since: 'date?' },
  headline: 'string', detail: 'string?',
  evidence: {
    metric: 'string?', value: 'any', baseline: 'any', window: 'string?', stat: 'string?', n: 'number?', nEff: 'number?', otherWindows: [{ window: 'string?', p: 'number?' }], 'series?': compactOf(120),
    unit: N(E(...UNITS)), valueLabel: 'string', valueText: 'string', baselineLabel: 'string?', baselineText: 'string?',
  },
  drivers: N([{ asset: 'string', chain: 'string?', usd: 'number' }]),
  asOf: 'iso?',
  title: 'string', why: 'string?', stage: E(...STAGES), role: E(...ROLES), tier: N(E('major', 'minor')),
  ...(facts ? { facts: 'object' } : {}),
});
const TONES = ['negative', 'positive', 'neutral'];
const LEVELS = ['unusual', 'minor', 'clear', 'partial', 'unknown'];
const verdictSpec = {
  level: E(...LEVELS), tone: N(E(...TONES)),
  items: [{ id: 'string', asset: 'string', chain: 'string?', area: E('supply', 'market share', 'chains', 'peg', 'usage', 'income'), lens: E(...LENSES), tone: E(...TONES), since: 'date?' }],
  minor: 'integer', checks: 'integer', text: 'string',
};
const bulletSpec = {
  kind: E('state', 'finding', 'event', 'mover', 'steady', 'filler'), tone: E(...TONES), 'tier?': E('major', 'minor'), since: 'date?',
  text: 'string', detail: 'string?', subject: { asset: 'string?', chain: 'string?' },
  link: { lens: E(...LENSES), focus: 'string?', insight: 'string?' }, refs: ['string'], 'values?': { $map: 'number?' },
};
const frameSpec = { window: E(...Object.keys(FRAMES)), days: 'integer', from: 'date', to: 'date', label: 'string', more: 'integer', bullets: [bulletSpec] };
const framesSpec = Object.fromEntries(Object.keys(FRAMES).map((k) => [k, frameSpec]));
export const briefingSpec = {
  version: (x) => (x === 1 ? null : 'must be 1'), asOf: 'iso', key: 'string', floorUsd: 'number?', peers: ['string'],
  verdict: verdictSpec, frames: framesSpec, byAsset: { $map: { verdict: verdictSpec, frames: framesSpec } },
  errors: [{ builder: 'string', frame: 'string?', asset: 'string?', error: 'string' }],
};
export const statusSpec = { level: E('ok', 'degraded'), reasons: [{ kind: E('source', 'section', 'engine'), id: 'string', status: 'string?', message: 'string?' }] };

// The whole payload (v1 fields as documented in docs/paxos-dashboard.md, plus the v2 additions).
export const SCHEMA = {
  schemaVersion: (x) => (x === 1 ? null : 'must be 1'),
  generatedAt: 'iso', dataAsOf: 'iso?',
  cache: { sMaxAge: 'integer', staleWhileRevalidate: 'integer', staleIfError: 'integer' },
  status: statusSpec,
  // engine is null when the insights were reused from an identical model (memo hit): no engine run.
  timingsMs: { fetch: 'integer', model: 'integer', engine: 'integer?', total: 'integer' },
  sources: [{
    id: 'string', label: 'string', host: 'string?', kind: E('discovery', 'supply', 'price', 'defi', 'usage', 'economics', 'onchain', 'market'),
    status: E('ok', 'partial', 'stale', 'error', 'skipped'), requests: 'integer', failed: 'integer', bytes: 'integer', latencyMs: 'integer?',
    fetchedAt: 'iso?', dataAsOf: 'iso?', cadenceHours: 'number?', staleAfterHours: 'number?', ageHours: (x) => (x === null || (isNum(x) && x >= 0) ? null : 'ageHours must be >= 0 or null'), message: 'string?',
  }],
  discovery: {
    tiers: [{ id: 'string', label: 'string', ok: 'boolean', found: ['string'] }],
    assets: [{ key: 'string', symbol: 'string', name: 'string', kind: E('usd-stablecoin', 'gold', 'fiat-stablecoin', 'other'), status: E('active', 'legacy', 'dead'), unit: 'string', geckoId: 'string?', llamaId: 'string?', via: ['string'], firstDate: 'date?', colorIndex: 'integer?' }],
    addresses: [{ asset: 'string', chain: 'string', address: 'string', decimals: 'integer?', role: E('issuer', 'unverified', 'bridged', 'unlisted'), via: ['string'] }],
  },
  totals: {
    usd: { key: 'string', label: 'string', assets: ['string'], current: 'number', supplyAsOf: 'iso', supplyUsd: Compact, change: Changes, ath: { value: 'number', date: 'date' }, drawdownPct: 'number', marketShare: N(Compact), shareCurrent: 'number?', rankEquivalent: 'integer?' },
    allUsd: { label: 'string', current: 'number?', coveredUsd: 'number?', missing: ['string'], supplyAsOf: 'iso?' },
  },
  market: N({ definition: 'string', coverageFrom: 'date?', usdTotal: N(Compact), allTotal: N(Compact) }),
  assets: { $map: {
    key: 'string', symbol: 'string', name: 'string', kind: 'string', status: 'string', unit: 'string', colorIndex: 'integer?',
    current: {
      supply: 'number?', supplyUsd: 'number?', supplyAsOf: 'iso?', supplySource: 'string?', price: 'number?', priceAsOf: 'iso?', pegDevBp: 'number?', pegAsOf: 'iso?',
      changeBasis: E('token-flow', 'market-value'), change: Changes, ath: N({ value: 'number', date: 'date' }), drawdownPct: 'number?',
      changeNative: N(Changes), athNative: N({ value: 'number', date: 'date' }), drawdownNativePct: 'number?',
      rank: 'integer?', rankOf: 'integer?', marketShare: 'number?', volume24hUsd: 'number?', turnover24h: 'number?',
    },
    series: { supplyUsd: N(Compact), supply: N(Compact), price: N(Compact), priceHourly: hourlySpec, xau: N(Compact), turnover7d: N(Compact) },
    chains: [{ chain: 'string', currentUsd: 'number?', share: 'number?', first: 'date?', status: E('tracked', 'tracking_ended', 'new'), change: { d1: change, d7: change, d30: change }, series: N(compactOf(400)), notes: ['string'] }],
    defi: N({ footprintUsd: 'number', footprintShare: 'number?', poolCount: 'integer', effectivePools: 'number?', rewardShare: 'number?', pools: [{ pool: 'string', project: 'string', chain: 'string', symbol: 'string', tvlUsd: 'number?', apy: 'number?', apyBase: 'number?', apyReward: 'number?', utilization: 'number?', supplyUsd: 'number?', borrowUsd: 'number?', url: (x) => (x === null || /^https:\/\/defillama\.com\/yields\/pool\/[A-Za-z0-9-]+$/.test(x) ? null : 'bad pool url') }] }),
    onchain: [{ chain: 'string', address: 'string?', holders: 'integer?', totalSupply: 'number?', source: 'string?', asOf: 'iso?' }],
    activity: N({ source: 'string', key: 'string', chain: 'string?', series: { activeAddresses: N(compactOf(400)), transfers: N(compactOf(400)), holders: N(compactOf(400)) } }),
    notes: ['string'],
  } },
  peers: N({ pegType: 'string', asOf: 'iso?', count: 'integer', rows: [{ id: 'string', symbol: 'string', name: 'string', supplyUsd: 'number', change: { d1: change, d7: change, d30: change }, isPaxos: 'boolean', assetKey: 'string?' }], excluded: [{ id: 'string', symbol: 'string', pegType: 'string?', jumpUsd: 'number?', prevDay: 'number?', current: 'number?', listSum: 'number?', chartSum: 'number?', tolerance: 'number?' }] }),
  pegPeers: N([{ symbol: 'string', geckoId: 'string?', priceHourly: hourlySpec, price: N(Compact) }]),
  goldRefs: N([{ symbol: 'string', geckoId: 'string?', name: 'string?', priceHourly: hourlySpec }]),
  economics: N({ label: (x) => (x === 'DefiLlama model estimate' ? null : 'label must be "DefiLlama model estimate"'), note: 'string', assets: ['string'], fees: N(Compact), revenue: N(Compact), impliedYield: N(Compact), current: { fees24h: 'number?', revenue24h: 'number?', fees1y: 'number?', impliedYield: 'number?', baseUsd: 'number?' } }),
  attribution: N({ windows: { $map: { from: 'date', to: 'date', totalDeltaUsd: 'number', grossUsd: 'number', rotationUsd: 'number', assets: [{ asset: 'string', prevUsd: 'number', currUsd: 'number', deltaUsd: 'number' }], chains: [{ asset: 'string', chain: 'string', prevUsd: 'number', currUsd: 'number', deltaUsd: 'number' }] } } }),
  insights: N({
    rule: { text: 'string' }, testsRun: 'integer', groups: 'integer', families: { $map: 'integer' }, family: N({ counted: 'integer', dimensions: 'integer', floor: 'integer', underpowered: 'integer' }), floorsUsd: { $map: 'number' },
    feed: [{ rootKey: 'string', lead: insightSpec({ facts: true }), related: [insightSpec({ facts: true })] }], standing: [insightSpec({ facts: true })], watch: [insightSpec({ facts: false })], watchTotal: 'integer', context: [insightSpec({ facts: false })],
    health: { dimensions: ['string'], assets: ['string'], cells: { $map: { $map: { state: E('notable_negative', 'notable_positive', 'notable_neutral', 'within_own_history', 'insufficient_history', 'no_data'), tests: 'integer', notable: 'integer', negative: 'integer', positive: 'integer', evidence: N({ id: 'string', headline: 'string', polarity: 'string', p: 'number', E: 'number' }) } } }, summary: { $map: 'string' } },
    errors: [{ detector: 'string', error: 'string' }],
  }),
  briefing: N(briefingSpec),
};

// Every insight with the list it sits in.
export function insightsOf(p) {
  const ins = p && p.insights;
  if (!ins) return [];
  return [
    ...(ins.feed || []).flatMap((c) => [{ list: 'feed', i: c.lead, cluster: c }, ...(c.related || []).map((i) => ({ list: 'feed', i, cluster: c }))]),
    ...(ins.standing || []).map((i) => ({ list: 'standing', i })),
    ...(ins.watch || []).map((i) => ({ list: 'watch', i })),
    ...(ins.context || []).map((i) => ({ list: 'context', i })),
  ];
}
const addDays = (iso, n) => new Date(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export const monthDay = (iso) => `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;

// v2 semantics that a shape check cannot see: copy caps and words, stage/role/tier rules, status and cache
// rules, novelty.since; then the briefing's own rules (validateBriefing).
export function validateV2(p) {
  const errs = [];
  const bad = (path, msg) => errs.push(`${path}: ${msg}`);
  if (!p || typeof p !== 'object') return ['payload: not an object'];
  if (p.cache && p.cache.staleIfError !== 86400) bad('cache.staleIfError', `must be 86400 (${p.cache.staleIfError})`);
  if (p.cache && ![300, 600, 1800].includes(p.cache.sMaxAge)) bad('cache.sMaxAge', `must be 300, 600 or 1800 (${p.cache.sMaxAge})`);
  if (p.status && (p.status.level === 'ok') === ((p.status.reasons || []).length > 0)) bad('status', `level ${p.status.level} with ${(p.status.reasons || []).length} reasons (ok iff none)`);
  if (p.status && Array.isArray(p.sources)) {
    const want = expectedReasons(p), got = new Set((p.status.reasons || []).map((x) => `${x.kind}:${x.id}`));
    for (const k of want) if (!got.has(k)) bad('status.reasons', `missing ${k} (H11 rule)`);
    for (const k of got) if (!want.has(k)) bad('status.reasons', `unexpected ${k} (H11 rule)`);
  }
  if (p.cache && Array.isArray(p.sources) && p.assets) {
    const want = expectedSMaxAge(p);
    if (p.cache.sMaxAge !== want) bad('cache.sMaxAge', `${p.cache.sMaxAge}, the H7 rule gives ${want}`);
  }
  const keys = new Set(Object.keys(p.assets || {}));
  for (const { list, i } of insightsOf(p)) {
    const at = `insights.${list}[${i.id}]`;
    const rk = roleKey(i);
    if (ROLE_OF[rk] && i.role !== ROLE_OF[rk]) bad(at, `role ${i.role}, §4.4 says ${ROLE_OF[rk]}`);
    if (!ROLE_OF[rk]) bad(at, `detector ${rk} has no §4.4 role`);
    const wantStage = { feed: ['new'], standing: ['ongoing', 'past'], watch: ['watch'], context: ['context'] }[list];
    if (!wantStage.includes(i.stage)) bad(at, `stage ${i.stage} in ${list} (want ${wantStage.join('|')})`);
    const eligible = ['new', 'ongoing'].includes(i.stage) && !['note', 'api', 'context'].includes(i.role);
    if (eligible ? !['major', 'minor'].includes(i.tier) : i.tier !== null) bad(at, `tier ${i.tier} (stage ${i.stage}, role ${i.role})`);
    if (typeof i.title === 'string') {
      if (countWords(i.title) > 14) bad(at, `title has ${countWords(i.title)} words: ${i.title}`);
      if (i.title.length > 100) bad(at, `title has ${i.title.length} chars`);
      if (BANNED.test(i.title)) bad(at, `banned word "${BANNED.exec(i.title)[0]}" in title: ${i.title}`);
      if (BAD_TEXT.test(i.title)) bad(at, `bad text in title: ${i.title}`);
      if (i.title.endsWith('…') || i.title === fallbackTitle(i.headline)) bad(at, `fallback title: ${i.title}`);
      const subject = i.dimension === 'economics' ? 'Est.' : i.asset;
      const free = /^(portfolio\.|dq\.freshness$|dq\.list_reconciliation$)/.test(i.detector);
      if (!free && !(i.title === subject || i.title.startsWith(subject + ' ') || i.title.startsWith(subject + ':'))) bad(at, `title does not start with its subject "${subject}": ${i.title}`);
      if (free && i.detector.startsWith('portfolio.') && ![...keys].some((k) => i.title.startsWith(k + ' '))) bad(at, `portfolio title does not start with an asset: ${i.title}`);
    }
    if (typeof i.why === 'string') {
      if (countWords(i.why) > 20) bad(at, `why has ${countWords(i.why)} words: ${i.why}`);
      if (BANNED.test(i.why)) bad(at, `banned word "${BANNED.exec(i.why)[0]}" in why: ${i.why}`);
      if (BAD_TEXT.test(i.why)) bad(at, `bad text in why: ${i.why}`);
    }
    const ev = i.evidence || {};
    for (const k of ['valueLabel', 'valueText', 'baselineLabel', 'baselineText']) if (typeof ev[k] === 'string' && (BAD_TEXT.test(ev[k]) || !ev[k].trim())) bad(at, `evidence.${k} "${ev[k]}"`);
    if ((ev.baselineLabel === null) !== (ev.baselineText === null)) bad(at, 'evidence.baselineLabel and baselineText must both be set or both null');
    if (ev.unit === null && ev.series) bad(at, 'evidence.unit null with a series');
    // §4.2 novelty.since: a regime's split date (facts.since; also a dead asset's date, dq.frozen);
    // otherwise a dated event's own day (facts.date) or the as-of day minus the firing episode's age; never
    // after the as-of day. (A non-event "since", e.g. portfolio.leadership's "larger since", is not one.)
    if (i.novelty && 'since' in i.novelty && i.facts) {
      const s = i.novelty.since, asOfDay = i.asOf ? i.asOf.slice(0, 10) : null;
      const byAge = Number.isInteger(i.novelty.ageDays) && asOfDay ? addDays(asOfDay, -i.novelty.ageDays) : null;
      const split = /regime$/.test(i.detector) || i.detector === 'dq.frozen';
      const allowed = split && typeof i.facts.since === 'string' ? [i.facts.since] : [typeof i.facts.date === 'string' ? i.facts.date : null, byAge].filter(Boolean);
      if (!(allowed.length ? allowed.includes(s) : s === null)) bad(at, `novelty.since ${s}, §4.2 gives ${allowed.join(' or ') || 'null'}`);
      if (s && asOfDay && s > asOfDay) bad(at, `novelty.since ${s} after the as-of day ${asOfDay}`);
    }
    if (list === 'watch' || list === 'context') { if ('facts' in i) bad(at, 'facts must be dropped from watch and context'); }
  }
  return errs.concat(validateBriefing(p));
}

// The briefing's own rules (§4.7-§4.9, §6.2): frames, bullet counts and caps, links, verdict copy.
export function validateBriefing(p) {
  const errs = [];
  const bad = (path, msg) => errs.push(`${path}: ${msg}`);
  const keys = new Set(Object.keys((p && p.assets) || {}));
  const b = p && p.briefing;
  if (b) {
    const insKeys = p.insights ? new Set(insightsOf(p).map((x) => x.i.id)) : new Set();
    if (p.totals && p.totals.usd) {
      if (b.asOf !== p.totals.usd.supplyAsOf) bad('briefing.asOf', `${b.asOf} != totals.usd.supplyAsOf ${p.totals.usd.supplyAsOf}`);
      if (b.key !== p.totals.usd.key) bad('briefing.key', `${b.key} != totals.usd.key`);
    }
    const floorWant = p.insights && p.insights.floorsUsd && isNum(p.insights.floorsUsd[b.key]) ? p.insights.floorsUsd[b.key] : null;
    if (b.floorUsd !== floorWant) bad('briefing.floorUsd', `${b.floorUsd} != insights.floorsUsd[key] ${floorWant}`);
    const peerSyms = (p.pegPeers || []).map((x) => x.symbol);
    if (JSON.stringify(b.peers) !== JSON.stringify(peerSyms)) bad('briefing.peers', `${b.peers} != pegPeers symbols ${peerSyms}`);
    if (JSON.stringify(Object.keys(b.frames || {})) !== JSON.stringify(Object.keys(FRAMES))) bad('briefing.frames', `keys ${Object.keys(b.frames || {})} must be exactly d7,d30,d90,d365`);
    if (JSON.stringify(Object.keys(b.byAsset || {}).sort()) !== JSON.stringify([...keys].sort())) bad('briefing.byAsset', `keys ${Object.keys(b.byAsset || {})} != assets ${[...keys]}`);
    const scopes = [['all', b], ...Object.entries(b.byAsset || {})];
    for (const [scope, s] of scopes) {
      const at = scope === 'all' ? 'briefing' : `briefing.byAsset.${scope}`;
      verdictErrors(s.verdict, scope, p, (m) => bad(`${at}.verdict`, m));
      for (const [w, f] of Object.entries(s.frames || {})) {
        const fa = `${at}.frames.${w}`;
        if (!f) { bad(fa, 'missing'); continue; }
        if (f.window !== w || f.days !== FRAMES[w]) bad(fa, `window/days ${f.window}/${f.days}`);
        if (!(typeof f.label === 'string' && f.label.startsWith(FRAME_LABEL[w] + ' ') && f.label === `${FRAME_LABEL[w]} ${monthDay(f.to)}`)) bad(fa, `label "${f.label}" (want "${FRAME_LABEL[w]} ${f.to && monthDay(f.to)}")`);
        const bl = f.bullets || [];
        // 3 to 5; an asset with no supply figure in the snapshot has its state bullet only ("…: no supply
        // figure in this snapshot"): nothing else about it can be said honestly.
        const noData = bl.length === 1 && bl[0].kind === 'state' && bl[0].values && bl[0].values.usd === null && bl[0].values.deltaUsd === null && scope !== 'all';
        if ((bl.length < 3 && !noData) || bl.length > 5) bad(fa, `${bl.length} bullets (3 to 5)`);
        if (!bl.length || bl[0].kind !== 'state' || bl.filter((x) => x.kind === 'state').length !== 1) bad(fa, 'exactly one state bullet, first');
        const firstNonFinding = bl.findIndex((x, k) => k > 0 && x.kind !== 'finding');
        if (firstNonFinding > 0 && bl.slice(firstNonFinding).some((x) => x.kind === 'finding')) bad(fa, 'findings must follow the state bullet, before events, movers and steady lines');
        for (const [k, x] of bl.entries()) {
          const ba = `${fa}.bullets[${k}]`;
          if (x.kind === 'finding' ? !['major', 'minor'].includes(x.tier) : 'tier' in x) bad(ba, `tier ${x.tier} on a ${x.kind} bullet`);
          if (countWords(x.text) > 14) bad(ba, `text has ${countWords(x.text)} words: ${x.text}`);
          if (x.detail !== null && countWords(x.detail) > 20) bad(ba, `detail has ${countWords(x.detail)} words: ${x.detail}`);
          for (const t of [x.text, x.detail]) if (typeof t === 'string') {
            if (BANNED.test(t)) bad(ba, `banned word "${BANNED.exec(t)[0]}": ${t}`);
            if (BAD_TEXT.test(t)) bad(ba, `bad text: ${t}`);
            if (!t.trim()) bad(ba, 'empty text');
          }
          if (x.link && x.link.insight !== null && !insKeys.has(x.link.insight)) bad(ba, `link.insight ${x.link.insight} is not in insights`);
          for (const r of x.refs || []) if (!insKeys.has(r)) bad(ba, `ref ${r} is not in insights`);
          if (x.link && x.link.focus !== null && !keys.has(x.link.focus)) bad(ba, `link.focus ${x.link.focus} is not an asset`);
          if (x.kind === 'finding' && !(x.refs || []).length) bad(ba, 'finding without refs');
          if (x.kind === 'finding' && x.link && x.link.insight !== null && !(x.refs || []).includes(x.link.insight)) bad(ba, 'finding link.insight must be one of its refs');
        }
      }
    }
  }
  return errs;
}

// H11: degraded iff a source is stale or down, a section is null, an asset has no USD value, or the build
// reported errors; one reason each.
export const STATUS_SECTIONS = ['discovery', 'totals', 'market', 'peers', 'economics', 'attribution', 'insights', 'briefing'];
export function expectedReasons(p) {
  const out = new Set();
  for (const s of p.sources || []) if (s.status === 'stale' || s.status === 'error') out.add(`source:${s.id}`);
  for (const k of STATUS_SECTIONS) if (p[k] === null) out.add(`section:${k}`);
  if (p.totals && p.totals.allUsd && (p.totals.allUsd.missing || []).length) out.add('section:totals.allUsd');
  for (const e of (p.insights && p.insights.errors) || []) out.add(`engine:${e.detector}`);
  return out;
}
// H7: 300 s when a core (supply/market) source is down or an active asset has no USD value; 600 s when any
// other source is down; else 1800 s. partial and stale never shorten it.
export function expectedSMaxAge(p) {
  const down = (p.sources || []).filter((s) => s.status === 'error');
  const missingActive = Object.values(p.assets || {}).some((a) => a.status === 'active' && !isNum(a.current && a.current.supplyUsd));
  return missingActive || down.some((s) => s.kind === 'supply' || s.kind === 'market') ? 300 : down.length ? 600 : 1800;
}

// §3.3 verdict copy, rebuilt from the verdict's own fields.
export function verdictText(v, scope, p) {
  const label = (it) => (it.chain ? `${it.asset} on ${it.chain}` : `${it.asset} ${it.area}`);
  const n = v.items.length;
  if (v.level === 'unusual') return n === 1 ? `Unusual: ${label(v.items[0])}` : `${n} unusual: ${v.items.slice(0, 2).map(label).join(', ')}${n > 2 ? ` +${n - 2} more` : ''}`;
  if (v.level === 'minor') return `${scope === 'all' ? 'Nothing major' : `${scope}: nothing major`} · ${v.minor} smaller finding${v.minor === 1 ? '' : 's'}`; // asset scope named like 'clear'
  if (v.level === 'clear') return `${scope === 'all' ? 'Nothing unusual' : `${scope}: nothing unusual`} · ${v.checks.toLocaleString('en-US')} checks`;
  if (v.level === 'partial') { const k = ((p.insights && p.insights.errors) || []).length; return `Partly checked · ${k} check${k === 1 ? '' : 's'} could not run`; }
  return 'Checks unavailable in this snapshot';
}
function verdictErrors(v, scope, p, bad) {
  if (!v) return bad('missing');
  const n = (v.items || []).length;
  if ((v.level === 'unusual') !== (n > 0)) bad(`level ${v.level} with ${n} items`);
  const rank = { negative: 2, positive: 1, neutral: 0 };
  const worst = n ? v.items.map((x) => x.tone).sort((a, b) => rank[b] - rank[a])[0] : null;
  if (v.tone !== worst) bad(`tone ${v.tone}, worst item tone ${worst}`);
  for (const it of v.items || []) {
    if (!(it.asset in (p.assets || {})) && it.asset !== (p.totals && p.totals.usd && p.totals.usd.key)) bad(`item asset ${it.asset} unknown`);
    // (an asset scope also names units driven by the asset, e.g. a Paxos USD finding driven by it, §4.7)
  }
  const want = verdictText(v, scope, p);
  if (v.text !== want) bad(`text "${v.text}", §3.3 gives "${want}"`);
  if (BANNED.test(v.text) || /\b(needs a look|watch|should)\b/i.test(v.text)) bad(`banned wording in "${v.text}"`);
}

// ---------- §4.3 tiers, recomputed from the payload ----------
// "i's days": evidence.window 'Nd' = the N days ending on the insight's as-of day; 'since D' and 'A..B' =
// those dates (inclusive). Gap = mean |price - 1| over the daily points of those days.
export function windowDays(i, p) {
  const end = ((i.asOf || (p.totals && p.totals.usd && p.totals.usd.supplyAsOf) || '') + '').slice(0, 10);
  const w = String((i.evidence && i.evidence.window) || '');
  let m;
  if ((m = /^(\d+)d$/.exec(w))) return { from: addDays(end, -(+m[1] - 1)), to: end };
  if ((m = /^since (\d{4}-\d{2}-\d{2})$/.exec(w))) return { from: m[1], to: end };
  if ((m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(w))) return { from: m[1], to: m[2] };
  return null;
}
export function meanGap(c, from, to) {
  if (!c || !c.values) return null;
  const t0 = Date.parse(c.start + 'T00:00:00Z');
  const xs = [];
  c.values.forEach((v, k) => { const d = new Date(t0 + k * 864e5).toISOString().slice(0, 10); if (isNum(v) && d >= from && d <= to) xs.push(Math.abs(v - 1)); });
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}
// A peg peer's isolated bad print (a day ≥0.1% from $1 and over 4x as far as both neighbours) is not
// part of the peer bar (truth review: one +0.83% USDC day set the peers' range for a year).
export function cleanPeer(c) {
  if (!c || !Array.isArray(c.values)) return c;
  const g = c.values.map((v) => (isNum(v) ? Math.abs(v - 1) : null));
  return { start: c.start, values: c.values.map((v, k) => (k > 0 && k < g.length - 1 && [g[k], g[k - 1], g[k + 1]].every(isNum) && g[k] >= 0.001 && g[k] > 4 * Math.max(g[k - 1], g[k + 1]) ? null : v)) };
}
export function tierOf(i, p, scope = 'all') {
  if (i.detector === 'peg.gold_tracking' || (i.dimension === 'peg' && !(p.assets[i.asset] && p.assets[i.asset].unit === 'USD'))) return scope === 'all' ? 'minor' : 'major';
  if (i.dimension === 'peg') {
    const days = windowDays(i, p);
    const peers = (p.pegPeers || []).map((x) => (days ? meanGap(cleanPeer(x.price), days.from, days.to) : null)).filter(isNum);
    if (!peers.length) return 'major'; // fails open
    const coin = days ? meanGap(p.assets[i.asset].series.price, days.from, days.to) : null;
    return isNum(coin) && coin > Math.max(...peers) ? 'major' : 'minor';
  }
  if (scope !== 'all') return 'major';
  const floor = p.insights && p.insights.floorsUsd ? p.insights.floorsUsd[p.totals.usd.key] : null;
  return isNum(i.materialityUsd) && isNum(floor) && i.materialityUsd >= floor ? 'major' : 'minor';
}

// ---------- building test payloads ----------
// Deep merge: objects merge, arrays and scalars replace; the sample's "$comment" is skipped.
export function mergeSample(payload, sample) {
  const merge = (a, b) => {
    if (!b || typeof b !== 'object' || Array.isArray(b) || !a || typeof a !== 'object' || Array.isArray(a)) return structuredClone(b);
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) if (k !== '$comment') out[k] = k in a ? merge(a[k], v) : structuredClone(v);
    return out;
  };
  return merge(structuredClone(payload), sample);
}
// Today's production payload shape (no v2 field), for the older-payload checks (§3.13, acceptance 24).
export function stripV2(payload) {
  const p = structuredClone(payload);
  delete p.briefing;
  delete p.status;
  if (p.cache) delete p.cache.staleIfError;
  if (p.economics) delete p.economics.assets;
  if (p.insights) {
    delete p.insights.watchTotal;
    for (const { i } of insightsOf(p)) {
      for (const k of ['title', 'why', 'facts', 'stage', 'role', 'tier']) delete i[k];
      if (i.novelty) delete i.novelty.since;
      if (i.evidence) for (const k of ['unit', 'valueLabel', 'valueText', 'baselineLabel', 'baselineText']) delete i.evidence[k];
    }
  }
  return p;
}

// All contract errors of a payload: shape (unknown keys too), non-finite numbers, v2 semantics.
export function validate(p, label = 'payload') {
  const errors = [];
  check(p, SCHEMA, label, errors);
  const walk = (x, path) => {
    if (typeof x === 'number' && !Number.isFinite(x)) errors.push(`${path}: non-finite number`);
    else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) walk(y, `${path}.${k}`);
  };
  walk(p, label);
  return errors.concat(validateV2(p).map((e) => `${label} ${e}`));
}
