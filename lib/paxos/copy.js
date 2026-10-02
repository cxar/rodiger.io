'use strict';

// Plain copy for every insight, rendered from the detector's structured `facts` (never from the technical
// `headline`, which stays the API's and the Method panel's sentence):
//   title  at most 14 counted words and 100 characters; subject first ("{asset}", "{asset} on {chain}",
//          "{asset}:" for lens and note items, "Est." for the fee model), its number next, its own window;
//   why    at most 20 counted words: one plain comparison (peers, rank, record, driver, share);
//   role   where the page places it (headline | evidence | lens | context | note | api);
//   evidence.{unit, valueLabel, valueText, baselineLabel, baselineText}: the facts row of the evidence panel
//          (unit = unit of evidence.series and evidence.value).
// A detector without a template, a template that throws, or a title over the caps renders no title
// (render(...).fallback = true; the engine check fails on it): engine.toInsight then cuts the technical
// sentence with fallbackTitle. This module never reads that sentence. Formats come from format.js;
// nothing here names an asset, chain or source.

const F = require('./format');

const ROLE = {
  'supply.move': 'headline', 'supply.drawdown': 'headline', 'supply.regime': 'headline', 'supply.streak': 'evidence', 'supply.bridged_out': 'lens',
  'market.share': 'headline', 'market.peer_growth': 'headline',
  'chain.move': 'headline', 'chain.lifecycle': 'headline', 'chain.attribution': 'lens', 'chain.concentration': 'lens', 'chain.dominance': 'lens',
  'peg.deviation': 'headline', 'peg.deviation:excess': 'evidence', 'peg.regime': 'headline', 'peg.gold_tracking': 'headline', 'peg.flow_coupling': 'api',
  'usage.turnover': 'headline', 'usage.activity': 'headline',
  'economics.reserve_income': 'headline', 'economics.rate_regime': 'lens',
  'defi.utilization': 'lens', 'defi.yield_outlier': 'lens', 'defi.tvl_trend': 'lens', 'defi.divergence': 'lens', 'defi.footprint': 'context',
  'portfolio.mix': 'lens', 'portfolio.leadership': 'lens',
  'dq.cross_source': 'note', 'dq.history_gap': 'note', 'dq.tracking_change': 'note', 'dq.freshness': 'note', 'dq.price_sanity': 'note', 'dq.list_reconciliation': 'note', 'dq.frozen': 'note',
};
const MAX_TITLE_WORDS = 14, MAX_TITLE_CHARS = 100, MAX_WHY_WORDS = 20;
// Statistics vocabulary and advice that never appear in titles, why lines, the briefing or the default view.
const BANNED = /\b(p ?=|E ?=|bits?|materiality|material|rotation|regime|effective|notable|Pareto|CUSUM|robust|percentile|drawdown|dimension|cluster|novelty|underpowered|null|bps?|basis points?|utilised|should|consider|warning|risk)\b/i;
const countWords = F.wordsCount;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const variantOf = (t) => (t.variant || (t.facts && t.facts.variant) || (/:excess:/.test(t.id || '') ? 'excess' : null));
const roleOf = (t) => (t.detector === 'peg.deviation' && variantOf(t) === 'excess' ? ROLE['peg.deviation:excess'] : ROLE[t.detector] || 'lens');
const isoOf = (t) => (isNum(t) ? new Date(t * 1000).toISOString().slice(0, 10) : typeof t === 'string' ? t.slice(0, 10) : null);
const s_ = (n) => (n === 1 ? '' : 's');
const daysTxt = (n) => `${n} day${s_(n)}`;
const ago = (h) => (h === 1 ? 'yesterday' : `${h} days ago`);
const winLabel = (h) => (h === 1 ? '1 day' : `${h} days`);
const spanWord = (h) => (h === 1 ? 'daily' : `${h}-day`);
// "Bigger than 95% of ...": share of the sample beaten, floored, never "100%" unless every one.
const beatTxt = (b) => (!isNum(b) ? '' : b >= 1 ? 'all' : `${Math.min(99, Math.floor(100 * b))}%`);
// "95% of past 7-day moves" / "all past 7-day moves" (never "all of past ...").
const ofTxt = (b, rest) => (b >= 1 ? `all ${rest}` : `${beatTxt(b)} of ${rest}`);
const unitWord = (u) => (u === 'oz' ? 'ounces' : u);
const evUnit = (u) => (u === 'USD' ? 'usd' : u === 'oz' ? 'oz' : 'count');
const ppTxt = (x) => (isNum(x) ? `${x < 0 ? F.MINUS : x > 0 ? '+' : ''}${Math.abs(100 * x).toFixed(2)} pp` : '');
// Exactly zero reads 'flat' in a sentence.
const flatOr = (fmt, x) => (x === 0 ? 'flat' : fmt(x));
const pctPt = (x, d = 2) => (isNum(x) ? `${(100 * x).toFixed(d)}%` : '');
const depthTxt = (x) => (isNum(x) ? `${Math.abs(100 * x).toFixed(1)}%` : '');
// A gap from $1 (or a reference) as a percent; under 0.005% it reads as under 0.01% (exactly 0: 0%).
const pegTxt = (x) => (!isNum(x) ? '' : F.pegPct(x) !== '0.00%' ? F.pegPct(x) : x === 0 ? '0%' : '<0.01%');
// Two gaps that would print alike get a third (or fourth) decimal ("0.01%, down from 0.01%" says nothing).
function pegPair(a, b) {
  for (let d = 2; d <= 4; d++) { const x = `${Math.abs(100 * a).toFixed(d)}%`, y = `${Math.abs(100 * b).toFixed(d)}%`; if (x !== y) return d === 2 ? [pegTxt(a), pegTxt(b)] : [x, y]; }
  return [pegTxt(a), pegTxt(b)];
}
const tiny = (x) => isNum(x) && F.pegPct(x) === '0.00%';
// Signed distance from $1 (or a gold reference): "0.17% above" / "0.11% below".
const sidePct = (x) => (isNum(x) ? `${pegTxt(x)} ${x < 0 ? 'below' : 'above'}` : '');
// Two shares that would print alike get more digits ("0.99%, from 0.99%" says nothing).
function sharePair(a, b) {
  for (let k = 0; k < 3; k++) { const x = F.sharePlain(a, k), y = F.sharePlain(b, k); if (x !== y) return [x, y]; }
  return [F.sharePlain(a), F.sharePlain(b)];
}
// Record clause of a change ("; largest drop since Aug 22") or of a level ("; lowest since Sep 8").
const LEVEL_WORDS = new Set(['highest', 'lowest', 'widest', 'narrowest', 'richest', 'cheapest']);
// A record date close to the window says little ("largest 7-day outflow since" the week before): it is
// printed only when it lies at least min(3 windows, 90 days) before the window's first day.
const dayMs = (iso) => Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z');
function recTxt(rec, ref, t, days) {
  if (!rec || !rec.word) return '';
  const end = t && isoOf(t.asOf);
  if (rec.since && end && isNum(days) && (dayMs(end) - days * 864e5 - dayMs(rec.since)) / 864e5 < Math.min(3 * days, 90)) return '';
  const w = LEVEL_WORDS.has(rec.word) ? rec.word : `largest ${rec.word}`;
  return rec.since ? `; ${w} since ${F.monthDay(rec.since, ref)}` : `; ${w} on record`;
}
const peersTxt = (f) => (f && f.peers && f.peers.length && isNum(f.peerGap) ? `${F.list(f.peers)} ${F.pegPct(f.peerGap, { ceil: true })} or less` : '');
const listMax = (xs, k = 2) => (xs.length <= k + 1 ? F.list(xs) : `${xs.slice(0, k).join(', ')} and ${xs.length - k} more`);
// A baseline that prints as zero ("Usual: 0%") adds nothing to the facts row and is left out.
const zeroTxt = (s) => typeof s === 'string' && /^[+\u2212]?\$?0(\.0+)?%?$/.test(s.trim());
const ev = (unit, valueLabel, valueText, baselineLabel = null, baselineText = null) => {
  const base = baselineText && !zeroTxt(baselineText) ? baselineText : null;
  return { unit, valueLabel, valueText: valueText || null, baselineLabel: base ? baselineLabel : null, baselineText: base };
};
function durTxt(sec) {
  if (!isNum(sec)) return '';
  const h = Math.abs(sec) / 3600;
  return h >= 48 ? daysTxt(Math.round(h / 24)) : h >= 1 ? `${Math.round(h)} hour${s_(Math.round(h))}` : `${Math.max(1, Math.round(h * 60))} min`;
}

// One renderer per detector: (t, f, ref) -> { title, why, evidence }. f = t.facts, ref = the as-of date
// (dates in the same year print as "Sep 11", others as "Mar 2023").
const T = {
  'supply.move': (t, f, ref) => {
    const u = f.unit && f.unit !== 'USD' ? ` in ${unitWord(f.unit)}` : '', d = f.driver;
    const drv = d && d.name !== t.asset && Math.sign(d.usd) === Math.sign(f.usd) ? `; ${d.share > 0.5 ? 'mostly' : 'led by'} ${d.name} ${F.smoney(d.usd)}` : '';
    return {
      title: `${t.asset} ${F.smoney(f.usd)} (${F.spctPlain(f.pct)}${u}) ${F.overDays(f.days)}${recTxt(f.record, ref, t, f.days)}`,
      why: `Bigger than ${ofTxt(f.beat, `past ${spanWord(f.days)} moves`)}${drv}.`,
      evidence: ev(evUnit(f.unit), `Change, ${winLabel(f.days)}`, F.spctPlain(f.pct) + u, 'Usual', F.spctPlain(f.usual)),
    };
  },
  // Depth with one decimal, as the hero prints it ("13.9% below May 13 peak").
  'supply.drawdown': (t, f, ref) => ({
    title: `${t.asset} ${depthTxt(f.depth)} (${F.money(f.lossUsd)}) below its ${F.monthDay(f.peakDate, ref)} peak`,
    why: !f.of ? 'No earlier dip in the record.' : !f.deeper ? `Deeper than all ${f.of} earlier dips.` : `${f.deeper} of ${f.of} earlier dips went deeper.`,
    evidence: ev(evUnit(f.unit), 'Below peak', depthTxt(f.depth), 'Typical dip', depthTxt(f.medianDepth)),
  }),
  'supply.regime': (t, f, ref) => {
    const verb = (g) => (g < 0 ? 'shrinking' : 'growing'), since = F.monthDay(f.since, ref);
    return {
      title: `${t.asset} supply ${verb(f.afterPerMonth)} ${F.pctPlain(f.afterPerMonth)} a month since ${since}, ${f.launch || !isNum(f.beforePerMonth) ? 'after its launch' : `after ${verb(f.beforePerMonth)} ${F.pctPlain(f.beforePerMonth)}`}`,
      why: `${F.smoney(f.usdSince)} since ${since}.`,
      evidence: ev(evUnit(f.unit), `Pace since ${since}`, `${F.spctPlain(f.afterPerMonth)} a month`, 'Before', isNum(f.beforePerMonth) ? `${F.spctPlain(f.beforePerMonth)} a month` : null),
    };
  },
  'supply.streak': (t, f) => ({
    title: f.days > 1 ? `${t.asset} supply ${f.dir} ${f.days} days running (${F.smoney(f.usd)})` : `${t.asset} supply ${f.dir} on the latest day (${F.smoney(f.usd)})`,
    why: f.longestEarlier ? `Longest earlier run ${daysTxt(f.longestEarlier)}.` : 'No earlier run like it in the record.',
    evidence: ev(evUnit(f.unit), 'Days running', String(f.days)),
  }),
  'supply.bridged_out': (t, f) => {
    const [a, b] = sharePair(f.share, f.shareBefore);
    return {
      title: `${t.asset}: ${F.money(f.bridgedUsd)} of ${F.money(f.mintedUsd)} minted on ${f.chain} sits on other chains`,
      why: `${a} now, ${b} ${ago(f.days)}.`,
      evidence: ev('fraction', `Change, ${winLabel(f.days)}`, ppTxt(f.change), 'Usual', ppTxt(f.usual)),
    };
  },
  'market.share': (t, f, ref) => {
    const [s1, s0] = sharePair(f.to, f.from);
    return {
      title: `${t.asset} market share ${s1}, from ${s0} ${F.overDays(f.days)}${recTxt(f.record, ref, t, f.days)}`,
      why: `Share of all ${f.peg || 'USD'} stablecoins; own flow ${F.smoney(f.ownFlowUsd)}.`,
      evidence: ev('fraction', `Change in share, ${winLabel(f.days)}`, F.spctPlain(f.to / f.from - 1), 'Usual', F.spctPlain(f.usual)),
    };
  },
  'market.peer_growth': (t, f) => {
    const out = f.usd < 0, faster = f.pct >= f.medianPct;
    return {
      title: F.money(f.usd) === '$0' ? `${t.asset} flat ${F.overDays(f.days)} among ${f.of} ${f.peg || 'USD'} stablecoins` : `${t.asset} ${F.smoney(f.usd)} ${F.overDays(f.days)}: ${f.rankUsd > 1 ? F.ord(f.rankUsd) + '-' : ''}largest ${out ? 'outflow' : 'inflow'} of ${f.of} ${f.peg || 'USD'} stablecoins`,
      why: `${faster ? 'Faster' : 'Slower'} than ${beatTxt(faster ? f.fasterThan : f.slowerThan)} of them; median coin ${flatOr(F.spctPlain, f.medianPct)}.`,
      evidence: ev('fraction', `Growth, ${winLabel(f.days)}`, F.spctPlain(f.pct)),
    };
  },
  'chain.move': (t, f, ref) => {
    const u = f.unit && f.unit !== 'USD' ? ` in ${unitWord(f.unit)}` : '';
    return {
      title: `${t.asset} on ${f.chain} ${F.smoney(f.usd)} (${F.spctPlain(f.pct)}${u}) ${F.overDays(f.days)}${recTxt(f.record, ref, t, f.days)}`,
      why: `Bigger than ${ofTxt(f.beat, `past ${spanWord(f.days)} moves on ${f.chain}`)}.`,
      evidence: ev(evUnit(f.unit), `Change, ${winLabel(f.days)}`, F.spctPlain(f.pct) + u, 'Usual', F.spctPlain(f.usual)),
    };
  },
  'chain.lifecycle': (t, f, ref) => {
    const cs = f.chains || [], firsts = cs.map((x) => x.first).filter(Boolean).sort();
    return {
      title: `${t.asset} live on ${listMax(cs.map((x) => x.chain))}: ${F.money(cs.reduce((s, x) => s + (x.usd || 0), 0))} there now`,
      why: isNum(f.usualPerMonth) ? `${cs.length} new chain${s_(cs.length)} in ${f.days || 30} days; usual pace ${f.usualPerMonth.toFixed(1)} a month.` : null,
      // (the why states the count and the usual pace, so the facts row shows the first dates instead)
      evidence: ev('count', firsts.length > 1 ? 'First supply' : 'First supply on', firsts.length > 1 && firsts[0] !== firsts[firsts.length - 1] ? `${F.monthDay(firsts[0], ref)} to ${F.monthDay(firsts[firsts.length - 1], ref)}` : firsts.length ? F.monthDay(firsts[0], ref) : String(cs.length)),
    };
  },
  'chain.attribution': (t, f) => ({
    title: F.money(f.shiftedUsd) === '$0' ? `${t.asset}: nothing shifted between chains ${F.overDays(f.days)}` : `${t.asset}: ${F.money(f.shiftedUsd)} shifted between chains ${F.overDays(f.days)}${f.top && f.top.chain ? `; ${f.top.chain} ${F.smoney(f.top.usd)}` : ''}`,
    why: 'Gains on some chains matched losses on others.',
    evidence: ev('fraction', `Shifted, ${winLabel(f.days)}`, `${F.sharePlain(f.share)} of supply`, 'Usual', F.sharePlain(f.usual)),
  }),
  'chain.concentration': (t, f, ref) => {
    const more = f.effective >= f.effectiveBefore, rec = f.record;
    const head = rec && rec.since === null ? `${more ? 'more' : 'less'} spread across chains than ever`
      : rec ? `${rec.word === 'most' ? 'most' : 'least'} spread across chains since ${F.monthDay(rec.since, ref)}` : `${more ? 'more' : 'less'} spread across chains ${F.overDays(f.days)}`;
    return {
      title: `${t.asset} ${head}${f.top && f.top.chain ? `; top chain ${f.top.chain} ${F.sharePlain(f.top.share)}` : ''}`,
      why: `As spread as ${f.effective.toFixed(1)} equal-sized chains, ${f.effectiveBefore.toFixed(1)} ${ago(f.days)}.`,
      evidence: ev('ratio', `Change, ${winLabel(f.days)}`, F.spctPlain(f.effective / f.effectiveBefore - 1), 'Usual', F.spctPlain(f.usual)),
    };
  },
  'chain.dominance': (t, f) => {
    const [s1, s0] = sharePair(f.to, f.from);
    return {
      title: `${t.asset} ${s1} of ${f.chain} stablecoins, from ${s0} ${F.overDays(f.days)}`,
      why: `All stablecoins on ${f.chain} ${F.spctPlain(f.chainTotalPct)} over the same days.`,
      evidence: ev('fraction', `Change in share, ${winLabel(f.days)}`, F.spctPlain(f.to / f.from - 1), 'Usual', F.spctPlain(f.usual)),
    };
  },
  'peg.deviation': (t, f, ref) => {
    if (f.variant === 'excess') {
      const closer = f.gap < 0, peers = f.peers && f.peers.length ? F.list(f.peers) : 'its peers';
      return {
        title: tiny(f.gap) ? `${t.asset} as close to $1 as ${peers} ${F.overDays(f.days)}` : `${t.asset} ${F.pegPct(f.gap)} ${closer ? 'closer to' : 'further from'} $1 than ${peers} ${F.overDays(f.days)}`,
        why: isNum(f.usual) ? `Usually ${pegTxt(f.usual)} ${f.usual < 0 ? 'closer to $1 than' : 'from'} its peers.` : null,
        evidence: ev('fraction', `Gap beyond peers, ${winLabel(f.days)}`, pegTxt(f.gap)),
      };
    }
    const win = f.days === 1 ? 'yesterday' : `on average ${F.overDays(f.days)}`;
    return {
      title: tiny(f.gap) ? `${t.asset} \u2248 $1 ${win}` : `${t.asset} ${F.pegPct(f.gap)} ${f.side} $1 ${win}${recTxt(f.record, ref, t, f.days)}`,
      why: peersTxt(f) ? `${peersTxt(f)} over the same days.` : null,
      evidence: ev('fraction', f.days === 1 ? 'Gap, 1 day' : `Average gap, ${winLabel(f.days)}`, pegTxt(f.gap), 'Usual', pegTxt(f.usual)),
    };
  },
  'peg.regime': (t, f, ref) => {
    const since = F.monthDay(f.since, ref), [a, b] = pegPair(f.after, f.before);
    return {
      title: `${t.asset} typically ${a} from $1 since ${since}, ${f.after > f.before ? 'up' : 'down'} from ${b}`,
      why: peersTxt(f) ? `${peersTxt(f)} over the same days.` : null,
      evidence: ev('fraction', `Typical gap since ${since}`, a, 'Before', b),
    };
  },
  'peg.gold_tracking': (t, f) => {
    const ref = f.variant === 'spot' ? 'spot gold' : f.refs && f.refs.length ? F.list(f.refs) : f.ref;
    return {
      title: `${t.asset} ${sidePct(f.premium)} ${ref}; usually ${sidePct(f.usual)}`,
      why: 'Daily prices; a gap of a day or two is often timing.',
      evidence: ev('fraction', `Premium to ${ref}`, `${f.premium < 0 ? F.MINUS : '+'}${pegTxt(f.premium)}`, 'Usual', isNum(f.usual) ? `${f.usual < 0 ? F.MINUS : '+'}${pegTxt(f.usual)}` : null),
    };
  },
  'peg.flow_coupling': (t, f, ref) => ({
    title: `${t.asset} ${tiny(f.gap) ? '\u2248' : `${F.pegPct(f.gap)} ${f.side}`} $1 with net ${f.flow} ${F.overDays(f.days)}`,
    why: isNum(f.rho) ? `Price gaps and later supply flows: rank correlation ${f.rho.toFixed(2)} since ${F.monthDay(f.from, ref)}.` : null,
    evidence: ev('ratio', 'Rank correlation', isNum(f.rho) ? f.rho.toFixed(2) : null),
  }),
  'usage.turnover': (t, f, ref) => ({
    title: `${t.asset} trades ${F.pctPlain(f.level)} of supply a day, usually ${F.pctPlain(f.usual)}${recTxt(f.record, ref, t, f.days)}`,
    why: 'Seven-day average of daily trading volume over supply.',
    evidence: ev('fraction', 'Traded a day, 7-day average', F.pctPlain(f.level), 'Usual', F.pctPlain(f.usual)),
  }),
  'usage.activity': (t, f, ref) => {
    const label = f.metric === 'activeAddresses' ? 'active addresses' : f.metric;
    return {
      title: `${t.asset} ${label}${f.chain ? ` on ${f.chain}` : ''} ${F.spctPlain(f.pct)} ${F.overDays(f.days)}${recTxt(f.record, ref, t, f.days)}`,
      why: isNum(f.avg) ? `Now ${Math.round(f.avg).toLocaleString('en-US')}${f.metric === 'holders' ? '' : ' a day'}, seven-day average (Coin Metrics).` : null,
      evidence: ev('count', `Change, ${winLabel(f.days)}`, F.spctPlain(f.pct), 'Usual', F.spctPlain(f.usual)),
    };
  },
  'economics.reserve_income': (t, f) => ({
    title: `Est. reserve income ${F.money(f.perDay)} a day, ${F.spctPlain(f.pct)} ${F.overDays(f.days)}`,
    why: `DefiLlama model; rates ${F.smoney(f.rateEffect)}, supply ${F.smoney(f.supplyEffect)} a day.`,
    evidence: ev('usdPerDay', `Change, ${winLabel(f.days)}`, F.spctPlain(f.pct), 'Usual', F.spctPlain(f.usual)),
  }),
  'economics.rate_regime': (t, f, ref) => {
    const since = F.monthDay(f.since, ref);
    return {
      title: `Est. reserve yield ${pctPt(f.after)} since ${since}, was ${pctPt(f.before)}`,
      why: "Implied by DefiLlama's model.",
      evidence: ev('fraction', `Est. yield since ${since}`, pctPt(f.after), 'Before', pctPt(f.before)),
    };
  },
  'defi.utilization': (t, f) => ({
    title: `${t.asset}: ${F.pctPlain(f.utilization)} borrowed in a ${f.project} market on ${f.chain} (${F.money(f.borrowUsd)} of ${F.money(f.supplyUsd)})`,
    why: `Tighter than ${ofTxt(f.beat, `${f.of} stablecoin lending markets`)}.`,
    evidence: ev('fraction', 'Borrowed', F.pctPlain(f.utilization), 'Typical market', F.pctPlain(f.median)),
  }),
  'defi.yield_outlier': (t, f) => {
    const inc = isNum(f.apyReward) && f.apy ? f.apyReward / f.apy : 0, high = f.apy >= f.median;
    return {
      title: `${t.asset}: ${F.pctPlain(f.apy)} a year in ${f.project} ${f.symbol} on ${f.chain}`,
      why: `${high ? 'Higher' : 'Lower'} than ${ofTxt(high ? f.beat : 1 - f.beat, `comparable pool dollars on ${f.chain}`)}; ${inc > 0 ? `${F.sharePlain(inc)} from incentives` : 'no incentives'}.`,
      evidence: ev('ratio', 'Yield', F.pctPlain(f.apy), `Typical pool on ${f.chain}`, F.pctPlain(f.median)),
    };
  },
  'defi.tvl_trend': (t, f) => ({
    title: `${t.asset}: ${f.project} pool on ${f.chain} ${F.spctPlain(f.pct)} (${F.smoney(f.usd)}) ${F.overDays(f.days)}`,
    why: 'Pool deposits; two-coin pools include the other coin.',
    evidence: ev('usd', `Change, ${winLabel(f.days)}`, F.spctPlain(f.pct), 'Usual', F.spctPlain(f.usual)),
  }),
  'defi.divergence': (t, f) => {
    const [a, b] = sharePair(f.shareBefore, f.shareAfter);
    return {
      title: `${t.asset} in top DeFi pools ${F.smoney(f.poolUsd)} while supply ${F.smoney(f.supplyUsd)} ${F.overDays(f.days)}`,
      why: `Share in pools ${a} → ${b}.`,
      evidence: ev('fraction', `Pools minus supply growth, ${winLabel(f.days)}`, F.spctPlain((1 + f.poolPct) / (1 + f.supplyPct) - 1), 'Usual', F.spctPlain(Math.expm1(f.usual))),
    };
  },
  'defi.footprint': (t, f) => ({
    title: isNum(f.share) ? `${t.asset}: up to ${F.sharePlain(f.share)} of supply in ${f.pools} DeFi pools` : `${t.asset}: ${F.money(f.tvlUsd)} in ${f.pools} DeFi pools`,
    why: null,
    evidence: isNum(f.share) ? ev('fraction', 'In DeFi pools, at most', F.sharePlain(f.share)) : ev('fraction', 'In DeFi pools', F.money(f.tvlUsd)),
  }),
  'portfolio.mix': (t, f) => {
    const ms = (f.moves || []).slice().sort((x, y) => Math.abs(y.usd) - Math.abs(x.usd));
    const a = ms[0], b = ms.find((x) => a && Math.sign(x.usd) !== Math.sign(a.usd)) || ms[1];
    return {
      title: a && b && F.money(f.offsetUsd) !== '$0' ? `${a.asset} ${F.smoney(a.usd)} while ${b.asset} ${F.smoney(b.usd)} ${F.overDays(f.days)}` : `${t.asset}: no offsetting moves between coins ${F.overDays(f.days)}`,
      why: `${F.money(f.offsetUsd)} of issuance in one coin matched redemptions in another.`,
      evidence: ev('usd', `Offsetting, ${winLabel(f.days)}`, `${F.pctPlain(f.share)} of supply`, 'Usual', F.pctPlain(f.usual)),
    };
  },
  'portfolio.leadership': (t, f, ref) => ({
    title: `${f.leader} ahead of ${f.other} by ${F.money(f.leadUsd)}${f.record ? recTxt(f.record, ref, t, f.days) : `, from ${F.money(f.leadBefore)} ${F.overDays(f.days)}`}`,
    why: `${f.leader} has been larger since ${F.monthDay(f.largerSince, ref)}.`,
    evidence: ev('usd', `Change in lead, ${winLabel(f.days)}`, F.smoney(f.leadUsd - f.leadBefore), 'Usual', F.smoney(f.usual)),
  }),
  'dq.cross_source': (t, f) => {
    const more = f.gapUsd > 0, zero = F.money(Math.abs(f.gapUsd)) === '$0';
    return {
      title: zero ? `${t.asset}: ${f.source} and ${f.other} show the same supply` : `${t.asset}: ${f.source} shows ${F.money(Math.abs(f.gapUsd))} (${F.spctPlain(f.gapPct)}) ${more ? 'more' : 'less'} supply than ${f.other}`,
      why: f.onchain ? 'Explained per chain where on-chain supply was read.' : null,
      evidence: ev('usd', 'Gap', F.smoney(f.gapUsd), "Typical day's flow", F.money(f.typicalUsd)),
    };
  },
  'dq.history_gap': (t, f, ref) => ({
    title: `${t.asset}: supply history starts ${F.monthDay(f.date, ref)}, ${f.days} days after its first price`,
    why: 'Earlier supply is not counted as issuance.',
    evidence: ev('count', 'Days without supply history', String(f.days)),
  }),
  'dq.tracking_change': (t, f, ref) => (f.variant === 'ended'
    ? {
      title: f.count === 1 ? `${t.asset}: tracking of ${f.chain} ended ${F.monthDay(f.date, ref)}, not a burn` : `${t.asset}: tracking of ${f.count} chains ended, latest ${F.monthDay(f.date, ref)}, not a burn`,
      why: 'Removed from flow figures.',
      evidence: ev('count', 'Chains no longer tracked', String(f.count)),
    }
    : {
      title: `${t.asset}: ${f.count} chains added to tracking at once (${F.monthDay(f.date, ref)}), not launches`,
      why: f.begins ? 'Supply before that day is not in the history.' : 'Removed from flow figures.',
      evidence: ev('count', 'Chains on one day', String(f.count)),
    }),
  'dq.freshness': (t, f) => {
    const feed = f.feed === 'supply' ? `supply from ${f.source || 'its source'}` : f.feed === 'hourly' ? 'hourly prices' : f.feed === 'cm' ? 'activity from Coin Metrics' : f.feed === 'cgDaily' ? 'market data from CoinGecko' : f.feed === 'fees' ? 'fee model from DefiLlama' : 'data';
    const late = f.overdueHours > 0;
    return {
      title: `${t.asset}: ${feed} ${late ? `is ${durTxt(f.overdueHours * 3600)} late` : 'is current'}`,
      why: late ? 'Figures from it show their as-of time.' : null,
      evidence: ev('count', 'Late by', late ? durTxt(f.overdueHours * 3600) : 'on time', 'Usual update', isNum(f.cadenceHours) ? `every ${durTxt(f.cadenceHours * 3600)}` : null),
    };
  },
  'dq.price_sanity': (t, f) => ({
    title: isNum(f.price) ? `${t.asset}: listed price is a placeholder, ignored` : `${t.asset}: no listed price, ignored`,
    why: null,
    evidence: ev('ratio', 'Listed price', isNum(f.price) ? String(f.price) : 'none'),
  }),
  'dq.list_reconciliation': (t, f) => ({
    title: `${f.symbol} left out of peer ranks: list and history disagree`,
    why: null,
    evidence: ev('ratio', 'List total vs history', isNum(f.ratio) ? `${f.ratio.toFixed(2)}×` : null),
  }),
  'dq.frozen': (t, f) => ({
    title: `${t.asset}: marked dead but still listed at ${F.money(f.usd)}`,
    why: null,
    evidence: ev('usd', 'Still listed', F.money(f.usd)),
  }),
};

// A technical sentence cut at its first ';' or ':' after 20 characters, capped at 14 words (with an ellipsis).
function fallbackTitle(sentence) {
  const h = String(sentence || '').trim();
  const m = /^(.{20,}?)[;:](\s|$)/.exec(h);
  let s = m ? m[1] : h;
  const words = s.split(/\s+/);
  if (countWords(s) > MAX_TITLE_WORDS || s.length > MAX_TITLE_CHARS) {
    const out = [];
    for (const w of words) { if (countWords(out.concat(w).join(' ')) > MAX_TITLE_WORDS - 1 || out.concat(w).join(' ').length > MAX_TITLE_CHARS - 1) break; out.push(w); }
    s = out.join(' ') + '…';
  }
  return s;
}
const BROKEN = /NaN|undefined|Infinity|\bnull\b|\bn\/a\b|\[object|\(\)|\s[,;:.]|\$\s|^\s|\s$/;
const okText = (s, maxWords) => typeof s === 'string' && s.length > 0 && !BROKEN.test(s) && countWords(s) <= maxWords;

// render(test, { ref }) -> { title, why, role, evidence: { unit, valueLabel, valueText, baselineLabel, baselineText }, fallback }
// test: an engine test (or a payload insight) carrying detector, asset, chain, variant, facts and asOf.
// ref (unix seconds or an ISO date) sets the copy's current year; default: test.refT (set by engine.run to
// the build's time), else test.asOf. To re-render a payload insight, pass the payload's generatedAt.
function render(t, { ref = null } = {}) {
  const role = roleOf(t), f = t.facts, tpl = T[t.detector];
  let out = null;
  if (tpl && f && typeof f === 'object') {
    try { out = tpl(t, f, isoOf(ref) || isoOf(t.refT) || isoOf(t.asOf) || null); } catch (e) { out = null; }
  }
  const titleOk = Boolean(out) && okText(out.title, MAX_TITLE_WORDS) && out.title.length <= MAX_TITLE_CHARS;
  const why = out && out.why && okText(out.why, MAX_WHY_WORDS) ? out.why : null;
  const e = out && out.evidence ? out.evidence : ev(null, null, null);
  const clean = (s) => (typeof s === 'string' && s && !BROKEN.test(s) ? s : null);
  return {
    title: titleOk ? out.title : null, // no template: the caller falls back to fallbackTitle(its headline)
    why,
    role,
    // valueLabel and valueText are always strings ('—' when the value could not be formatted).
    evidence: { unit: e.unit || null, valueLabel: clean(e.valueLabel) || 'Value', valueText: clean(e.valueText) || '\u2014', baselineLabel: clean(e.baselineText) ? clean(e.baselineLabel) : null, baselineText: clean(e.baselineLabel) ? clean(e.baselineText) : null },
    fallback: !titleOk,
  };
}

module.exports = { render, ROLE, BANNED, countWords, fallbackTitle, roleOf, TEMPLATES: Object.keys(T), MAX_TITLE_WORDS, MAX_TITLE_CHARS, MAX_WHY_WORDS };
