(function (root) {
  'use strict';

  // ===== Pure helpers (exported on window.PaxosDashboard for vm tests) =====
  const DAY = 86400;
  const MINUS = '−';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // One Period control drives every number; `frame` is the briefing frame, `win` the attribution window.
  const RANGES = [
    { id: '7d', label: '7d', days: 7, win: 'd7', frame: 'd7', text: '7 days', words: '7 days' },
    { id: '30d', label: '30d', days: 30, win: 'd30', frame: 'd30', text: '30 days', words: '30 days' },
    { id: '90d', label: '90d', days: 90, win: 'd90', frame: 'd90', text: '90 days', words: '90 days' },
    { id: '1y', label: '1y', days: 365, win: 'd365', frame: 'd365', text: '1 year', words: '12 months' },
    { id: 'all', label: 'All', days: null, win: 'all', frame: 'd365', text: 'full history', words: 'the full history' },
  ];
  const DEFAULT_RANGE = '7d';
  const LENSES = [
    { id: 'supply', label: 'Supply' },
    { id: 'chains', label: 'Chains' },
    { id: 'peg', label: 'Peg' },
    { id: 'market', label: 'Market' },
    { id: 'usage', label: 'Usage' },
    { id: 'income', label: 'Income (est.)', short: 'Income' },
  ];
  const LENS_ALIAS = { defi: 'usage', revenue: 'income' };
  // Engine dimension -> lens and verdict area word ('data' goes to About > Data notes only).
  const DIM_LENS = { supply: 'supply', portfolio: 'supply', chains: 'chains', peg: 'peg', market: 'market', defi: 'usage', usage: 'usage', economics: 'income' };
  const AREA = { supply: 'supply', portfolio: 'supply', market: 'market share', chains: 'chains', peg: 'peg', defi: 'usage', usage: 'usage', economics: 'income' };
  // Page placement for payloads without insight.role (FINAL-SPEC §4.4); detector ids are engine names.
  const ROLE_FALLBACK = {
    'supply.streak': 'evidence', 'supply.bridged_out': 'lens', 'chain.attribution': 'lens', 'chain.concentration': 'lens', 'chain.dominance': 'lens',
    'defi.utilization': 'lens', 'defi.yield_outlier': 'lens', 'defi.tvl_trend': 'lens', 'defi.divergence': 'lens', 'portfolio.mix': 'lens',
    'portfolio.leadership': 'lens', 'economics.rate_regime': 'lens', 'defi.footprint': 'context', 'peg.flow_coupling': 'api',
  };
  const OTHER = 'Other chains'; // the attribution's fold-in row label (lib/paxos/attribution.js)
  const API = '/api/paxos';
  const SNAP_CACHE = 'paxos-health:s1';
  const SNAP_MAX_AGE_MS = 7 * 864e5;
  const SNAP_WAIT_MS = 150;
  const TIMEOUT_MS = 25000;
  const REVALIDATE_RETRY_MS = 4000;
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const rangeById = (id) => RANGES.find((r) => r.id === id) || RANGES.find((r) => r.id === DEFAULT_RANGE);
  const spanOf = (r) => (isNum(r.days) ? Math.max(90, r.days) : null); // span ladder: time graphics show >= 90 days

  const tOf = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 1000;
  const isoOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const addDays = (iso, n) => isoOf(tOf(iso) + n * DAY);
  const daysBetween = (a, b) => Math.round((tOf(b) - tOf(a)) / DAY);

  // Compact = { start:'YYYY-MM-DD', values:[...] } contiguous daily, null = missing.
  const compactEnd = (c) => (c && c.values && c.values.length ? addDays(c.start, c.values.length - 1) : null);
  function compactAt(c, iso) {
    if (!c || !c.values || !c.values.length || !iso || iso < c.start) return null;
    for (let i = Math.min(daysBetween(c.start, iso), c.values.length - 1); i >= 0; i--) if (isNum(c.values[i])) return c.values[i];
    return null;
  }
  function compactLast(c) {
    if (!c || !c.values) return null;
    for (let i = c.values.length - 1; i >= 0; i--) if (isNum(c.values[i])) return { date: addDays(c.start, i), value: c.values[i] };
    return null;
  }
  function compactFirst(c) {
    if (!c || !c.values) return null;
    for (let i = 0; i < c.values.length; i++) if (isNum(c.values[i])) return { date: addDays(c.start, i), value: c.values[i] };
    return null;
  }
  // The `days` days before endIso plus endIso itself; days=null: everything.
  function sliceCompact(c, days, endIso) {
    if (!c || !c.values) return null;
    const end = endIso || compactEnd(c);
    const from = isNum(days) ? addDays(end, -days) : c.start;
    const i0 = Math.max(0, daysBetween(c.start, from));
    const i1 = Math.min(c.values.length - 1, daysBetween(c.start, end));
    if (i1 < i0) return { start: from > c.start ? from : c.start, values: [] };
    return { start: addDays(c.start, i0), values: c.values.slice(i0, i1 + 1) };
  }
  function changeFromCompact(c, days, endIso) {
    const last = compactLast(c);
    if (!last) return null;
    const end = endIso && endIso < last.date ? endIso : last.date;
    const curr = compactAt(c, end);
    if (!isNum(days)) {
      const first = compactFirst(c);
      return first && isNum(curr) ? { abs: curr - first.value, pct: first.value > 0 ? (100 * (curr - first.value)) / first.value : null, from: first.date } : null;
    }
    const from = addDays(end, -days);
    if (from < c.start) return null;
    const prev = compactAt(c, from);
    if (!isNum(prev) || !isNum(curr)) return null;
    return { abs: curr - prev, pct: prev ? (100 * (curr - prev)) / prev : null, from };
  }
  // Percent re-derived from {abs} and the level it ends at (pct is in percent units).
  function pctFrom(ch, curr) {
    if (!ch || !isNum(ch.abs) || !isNum(curr) || !(curr - ch.abs > 0)) return ch;
    return { ...ch, pct: (100 * ch.abs) / (curr - ch.abs) };
  }
  function normalizeChanges(changes, curr) {
    if (!changes || typeof changes !== 'object') return changes;
    const out = {};
    for (const k of Object.keys(changes)) out[k] = pctFrom(changes[k], curr);
    return out;
  }
  function peakOf(c) {
    let best = null;
    if (c && c.values) c.values.forEach((v, i) => isNum(v) && (!best || v > best.value) && (best = { value: v, date: addDays(c.start, i) }));
    return best;
  }
  // The payload's canonical window wins; 'all' (and missing windows) are derived from the series.
  function changeFor(changes, c, range, endIso) {
    const r = typeof range === 'string' ? rangeById(range) : range;
    if (r.win !== 'all' && changes && changes[r.win]) return changes[r.win];
    return changeFromCompact(c, r.days, endIso);
  }
  function datesBetween(startIso, endIso) {
    const out = [];
    for (let t = tOf(startIso), e = tOf(endIso); t <= e; t += DAY) out.push(isoOf(t));
    return out;
  }
  // Align compacts on [startIso, endIso]; `before` fills days before a series starts (0 for stacks).
  function alignCompacts(list, startIso, endIso, before = null) {
    const dates = datesBetween(startIso, endIso);
    const rows = list.map((c) => dates.map((d) => {
      if (!c || !c.values || d < c.start) return before;
      const i = daysBetween(c.start, d);
      return i < c.values.length && isNum(c.values[i]) ? c.values[i] : null;
    }));
    return { dates, rows };
  }
  function sumCompacts(list, startIso, endIso) {
    const { dates, rows } = alignCompacts(list, startIso, endIso, 0);
    return { start: startIso, values: dates.map((_, i) => rows.reduce((s, r) => (isNum(r[i]) ? s + r[i] : s), 0)) };
  }
  // Net change per bucket ('day' | 'week' ending at endIso) from levels at bucket boundaries.
  function bucketChanges(c, startIso, endIso, mode) {
    const out = [];
    if (!c) return out;
    const step = mode === 'week' ? 7 : 1;
    const n = Math.max(1, Math.ceil(daysBetween(startIso, endIso) / step));
    for (let k = n - 1; k >= 0; k--) {
      const to = addDays(endIso, -k * step);
      const prev = addDays(to, -step);
      const a = compactAt(c, prev);
      const b = compactAt(c, to);
      out.push({ label: to, from: addDays(prev, 1), to, value: isNum(a) && isNum(b) && prev >= c.start ? b - a : null });
    }
    return out;
  }
  function quantile(xs, q) {
    const s = xs.filter(isNum).sort((a, b) => a - b);
    if (!s.length) return null;
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
  }
  // First day of a market total comparable with today's: the last one-day rise larger than every later
  // `week`-day move (judged only with `horizon` days of later history) marks coins added to the history.
  function coverageStart(c, { week = 7, horizon = 365 } = {}) {
    if (!c || !Array.isArray(c.values) || c.values.length < week + horizon + 2) return null;
    const n = c.values.length;
    const L = c.values.map((v) => (isNum(v) && v > 0 ? Math.log(v) : null));
    const suffix = new Array(n + 1).fill(-Infinity);
    for (let j = n - 1; j >= 0; j--) {
      const w = j + week < n && L[j] !== null && L[j + week] !== null ? Math.abs(L[j + week] - L[j]) : -Infinity;
      suffix[j] = Math.max(suffix[j + 1], w);
    }
    let last = null;
    for (let k = 1; k < n - horizon; k++) {
      if (L[k] === null || L[k - 1] === null) continue;
      const rise = L[k] - L[k - 1];
      if (rise > 0 && rise > suffix[k]) last = k;
    }
    return last === null ? null : addDays(c.start, last);
  }
  // At most `max` indices of a long series, keeping each bucket's min and max (peaks survive).
  function downsampleIdx(vals, max) {
    const n = vals.length;
    if (n <= max || max < 4) return null;
    const buckets = Math.floor(max / 2);
    const size = n / buckets;
    const keep = new Set([0, n - 1]);
    for (let b = 0; b < buckets; b++) {
      let lo = -1;
      let hi = -1;
      for (let i = Math.floor(b * size), e = Math.min(n, Math.floor((b + 1) * size)); i < e; i++) {
        if (!isNum(vals[i])) continue;
        if (lo < 0 || vals[i] < vals[lo]) lo = i;
        if (hi < 0 || vals[i] > vals[hi]) hi = i;
      }
      if (lo >= 0) keep.add(lo);
      if (hi >= 0) keep.add(hi);
    }
    return [...keep].sort((a, b) => a - b);
  }
  // Snapshot freshness: "current" only while within the CDN's s-maxage.
  function snapshotAge(p, nowMs) {
    const gen = Date.parse(p && p.generatedAt);
    const ageSec = isNum(gen) ? Math.max(0, (nowMs - gen) / 1000) : null;
    const max = p && p.cache && isNum(p.cache.sMaxAge) ? p.cache.sMaxAge : null;
    return { ageSec, current: isNum(ageSec) && isNum(max) && ageSec <= max };
  }
  // A source's data age now, not when the snapshot was generated (a cached copy keeps its ageHours).
  function sourceAgeNow(s, p, nowMs) {
    const gen = Date.parse(p && p.generatedAt);
    return s && isNum(s.ageHours) && isNum(gen) ? s.ageHours + Math.max(0, nowMs - gen) / 3.6e6 : s && isNum(s.ageHours) ? s.ageHours : null;
  }
  // An old copy is judged at view time: a source that was ok or partial when built is late once its data
  // passes its own limit (partial alone never counts as late or down while the copy is current).
  function sourceStatusNow(s, ageNow) {
    if (!s) return 'skipped';
    const limit = isNum(s.staleAfterHours) ? s.staleAfterHours : isNum(s.cadenceHours) ? 2 * s.cadenceHours : null;
    return (s.status === 'ok' || s.status === 'partial') && isNum(ageNow) && isNum(limit) && ageNow > limit ? 'stale' : s.status;
  }

  // ----- formatting (FINAL-SPEC §3.0; lib/paxos/format.js uses the same tiers) -----
  function money(a) {
    if (a >= 999.5e9) return (a / 1e12).toFixed(2) + 'T';
    if (a >= 99.95e9) return (a / 1e9).toFixed(1) + 'B'; // $311.5B (two decimals only below $100B)
    if (a >= 999.5e6) return (a / 1e9).toFixed(2) + 'B';
    if (a >= 9.95e6) return (a / 1e6).toFixed(0) + 'M';
    if (a >= 999.5e3) return (a / 1e6).toFixed(1) + 'M';
    if (a >= 9.995e3) return (a / 1e3).toFixed(0) + 'K';
    if (a >= 999.5) return (a / 1e3).toFixed(1) + 'K';
    return a.toFixed(0);
  }
  const signOf = (x, signed) => (x < 0 ? MINUS : signed && x > 0 ? '+' : '');
  function fmtUsd(x, o = {}) {
    if (!isNum(x)) return '—';
    const m = money(Math.abs(x));
    return (Number(m.replace(/[^0-9.]/g, '')) === 0 ? '' : signOf(x, o.signed)) + '$' + m;
  }
  // Percent change, pct in percent units: 2 decimals below 0.1%, 1 below 10%, else 0.
  function fmtPct(p, o = {}) {
    if (!isNum(p)) return '—';
    const a = Math.abs(p);
    let s = a.toFixed(isNum(o.digits) ? o.digits : a < 0.1 ? 2 : a < 9.95 ? 1 : 0);
    if (!isNum(o.digits) && Number(s) >= 10 && s.includes('.')) s = a.toFixed(0);
    return (Number(s) === 0 ? '' : signOf(p, o.signed !== false)) + s + '%';
  }
  // Market share (a fraction): 2 significant digits below 1%, 2 decimals below 10%, else 1.
  function fmtShare(f) {
    if (!isNum(f)) return '—';
    const p = Math.abs(f) * 100;
    if (p === 0) return '0%';
    return (p < 1 ? String(Number(p.toPrecision(2))) : p.toFixed(p < 10 ? 2 : 1)) + '%';
  }
  // Part of a whole (a fraction): 0 decimals from 10%, 1 below, 2 significant digits below 1%.
  function fmtPortion(f) {
    if (!isNum(f)) return '—';
    const p = Math.abs(f) * 100;
    if (p === 0) return '0%';
    return (p < 1 ? String(Number(p.toPrecision(2))) : p.toFixed(p < 9.95 ? 1 : 0)) + '%';
  }
  const fmtPP = (x) => (isNum(x) ? Math.abs(x).toFixed(2) + ' pp' : '—');
  // Peg: percent of $1 (a fraction in), 2 decimals; under 0.005% it reads "≈ $1".
  function fmtPeg(frac, o = {}) {
    if (!isNum(frac)) return '—';
    const p = frac * 100;
    if (Math.abs(p) < 0.005) return '≈ $1';
    return (o.unsigned ? '' : signOf(p, true)) + Math.abs(p).toFixed(2) + '%';
  }
  const pegWords = (frac) => (!isNum(frac) ? '—' : Math.abs(frac) * 100 < 0.005 ? '≈ $1' : `${Math.abs(frac * 100).toFixed(2)}% ${frac < 0 ? 'below' : 'above'} $1`);
  function fmtOz(x, o = {}) {
    if (!isNum(x)) return '—';
    const a = Math.abs(x);
    const s = a >= 100 ? Math.round(a).toLocaleString('en-US') : a.toFixed(a >= 10 ? 0 : 1);
    return (Number(s.replace(/,/g, '')) === 0 ? '' : signOf(x, o.signed)) + s + ' oz';
  }
  const fmtCount = (n) => (isNum(n) ? Math.round(n).toLocaleString('en-US') : '—');
  // "Sep 11" within the reference year, else "Mar 2023"; tables: "Jul 12, 2025".
  function fmtMD(iso, refYear) {
    if (typeof iso !== 'string' || iso.length < 10) return '—';
    const m = MONTHS[+iso.slice(5, 7) - 1];
    return refYear && iso.slice(0, 4) !== String(refYear) ? `${m} ${iso.slice(0, 4)}` : `${m} ${+iso.slice(8, 10)}`;
  }
  const fmtDate = (iso) => (typeof iso === 'string' && iso.length >= 10 ? `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}, ${iso.slice(0, 4)}` : '—');
  const fmtMonthYear = (iso) => (typeof iso === 'string' && iso.length >= 7 ? `${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}` : '—');
  function fmtHM(iso) {
    const t = Date.parse(iso);
    return isNum(t) ? new Date(t).toISOString().slice(11, 16) : '—';
  }
  function fmtAge(hours) {
    if (!isNum(hours)) return '—';
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
    if (hours < 48) return `${Math.round(hours)} h`;
    return `${Math.round(hours / 24)} days`;
  }
  function fmtTick(label, spanDays) {
    const s = String(label || '');
    if (!s) return '';
    const mon = MONTHS[+s.slice(5, 7) - 1];
    if (spanDays <= 45) return `${mon} ${+s.slice(8, 10)}`;
    if (spanDays <= 400) return mon;
    if (spanDays <= 900) return `${mon} ’${s.slice(2, 4)}`;
    return s.slice(0, 4);
  }
  // Long date axes: label month (or year) boundaries, every k-th so at most maxTicks show.
  function tickPlan(labels, spanDays, maxTicks) {
    if (!Array.isArray(labels) || spanDays <= 45) return null;
    const years = spanDays > 900;
    const key = (s) => String(s).slice(0, years ? 4 : 7);
    const marks = [];
    for (let i = 1; i < labels.length; i++) if (key(labels[i]) !== key(labels[i - 1])) marks.push(i);
    const steps = years ? [1, 2, 3, 4, 5, 10] : [1, 2, 3, 4, 6, 12];
    const ord = (s) => (years ? +String(s).slice(0, 4) : +String(s).slice(0, 4) * 12 + +String(s).slice(5, 7) - 1);
    for (const k of steps) {
      const keep = marks.filter((i) => ord(labels[i]) % k === 0);
      if (keep.length <= maxTicks || k === steps[steps.length - 1]) return new Set(keep);
    }
    return new Set(marks);
  }
  const plural = (n, w, ws) => `${fmtCount(n)} ${n === 1 ? w : ws || w + 's'}`;
  const joinAnd = (xs) => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);

  // ----- URL state: ?asset=&range=&lens=&legacy=1&focus=  #f=<insight id>; defaults omitted -----
  function parseQuery(search, hash) {
    const q = new URLSearchParams(search || '');
    const asset = (q.get('asset') || 'all').slice(0, 64) || 'all';
    const l = String(q.get('lens') || '').toLowerCase();
    const lens = LENSES.some((x) => x.id === l) ? l : LENS_ALIAS[l] || 'supply';
    const focus = (q.get('focus') || '').slice(0, 64) || null;
    const m = /(?:^#|&)f=([^&]+)/.exec(hash || '');
    let fid = null;
    try {
      fid = m ? decodeURIComponent(m[1]).slice(0, 200) : null;
    } catch {
      fid = null;
    }
    return { asset, range: rangeById(q.get('range')).id, lens, legacy: q.get('legacy') === '1', focus, fid };
  }
  function canonicalAsset(asset, keys) {
    if (!asset || asset.toLowerCase() === 'all') return 'all';
    const hit = (keys || []).find((k) => k === asset) || (keys || []).find((k) => String(k).toLowerCase() === asset.toLowerCase());
    return hit || null;
  }
  function buildQuery(s) {
    const q = new URLSearchParams();
    if (s.asset && s.asset !== 'all') q.set('asset', s.asset);
    if (rangeById(s.range).id !== DEFAULT_RANGE) q.set('range', rangeById(s.range).id);
    if (s.lens && s.lens !== 'supply') q.set('lens', s.lens);
    if (s.legacy) q.set('legacy', '1');
    if (s.focus) q.set('focus', s.focus);
    const str = q.toString();
    return str ? '?' + str : '';
  }

  // ----- insights -----
  // An item about another subject (the total) belongs to an asset's scope when its title names the asset,
  // or the asset is its largest driver by at least that asset's floor (lib/paxos/briefing.js drivenBy).
  function drivenBy(ins, key, floors) {
    const ds = (Array.isArray(ins.drivers) ? ins.drivers : []).filter((d) => d && isNum(d.usd));
    if (!ds.some((d) => d.asset === key)) return false;
    if (String(ins.title || '').split(/[^A-Za-z0-9_]+/).includes(key)) return true;
    const top = ds.slice().sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd))[0];
    const fl = floors && isNum(floors[key]) ? floors[key] : null;
    return top.asset === key && (fl === null || Math.abs(top.usd) >= fl);
  }
  const insightMatches = (ins, key, floors) => !key || key === 'all' || ins.asset === key || drivenBy(ins, key, floors);
  const isDataQuality = (ins) => !!ins && (ins.dimension === 'data' || /^dq\./.test(String(ins.detector || '')));
  const roleOf = (i) => i.role || (isDataQuality(i) ? 'note' : i.detector === 'peg.deviation' && /:excess/.test(i.id) ? 'evidence' : ROLE_FALLBACK[i.detector] || 'headline');
  // Older payloads have no title: the headline cut at the first ";" or ":" after 20 characters, 14 words.
  function fallbackTitle(h) {
    let s = String(h || '').trim();
    const m = /[;:]/.exec(s.slice(20));
    if (m) s = s.slice(0, 20 + m.index);
    const w = s.split(/\s+/).filter(Boolean);
    return w.length > 14 ? w.slice(0, 14).join(' ') + '…' : s;
  }
  const titleOf = (i) => (i && typeof i.title === 'string' && i.title ? i.title : fallbackTitle(i && i.headline));
  // Evidence windows: 'since YYYY-MM-DD', 'A..B' or 'Nd' (ending at endIso).
  function parseWindow(w, endIso) {
    const s = String(w || '');
    let m = /since (\d{4}-\d{2}-\d{2})/.exec(s);
    if (m) return { from: m[1], to: endIso };
    m = /(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(s);
    if (m) return { from: m[1], to: m[2] };
    m = /^(\d+)d$/.exec(s.trim());
    if (m && endIso) return { from: addDays(endIso, -(+m[1] - 1)), to: endIso };
    return null;
  }

  // ----- models (pure: payload in, numbers out; the page and the checks share them) -----
  // Where supply moved: top rows by |delta|, the rest (and every "Other chains" row) as Other, and an
  // Unattributed row when the chain rows do not add up to the net (> 0.1% of gross).
  function movesModel(w, asset, max = 6) {
    if (!w || !Array.isArray(w.chains)) return null;
    const assetRows = asset ? (w.assets || []).filter((x) => x.asset === asset) : w.assets || [];
    if (asset && !assetRows.length) return null;
    const all = w.chains.filter((x) => !asset || x.asset === asset);
    const cand = all.filter((x) => x.chain !== OTHER && isNum(x.deltaUsd) && x.deltaUsd !== 0).sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));
    const rows = cand.slice(0, max);
    const other = all.filter((x) => !rows.includes(x)).reduce((s, x) => s + (x.deltaUsd || 0), 0);
    const net = asset ? assetRows.reduce((s, x) => s + (x.deltaUsd || 0), 0) : isNum(w.totalDeltaUsd) ? w.totalDeltaUsd : assetRows.reduce((s, x) => s + (x.deltaUsd || 0), 0);
    const sumAll = all.reduce((s, x) => s + (x.deltaUsd || 0), 0);
    const gross = asset ? all.reduce((s, x) => s + Math.abs(x.deltaUsd || 0), 0) : w.grossUsd || 0;
    const resid = net - sumAll;
    const unattributed = Math.abs(resid) > 0.001 * (gross || Math.abs(net) || 1) ? resid : 0;
    let inSum = all.reduce((s, x) => s + Math.max(0, x.deltaUsd || 0), 0);
    let outSum = all.reduce((s, x) => s + Math.min(0, x.deltaUsd || 0), 0);
    // The strip reconciles exactly: rounding and any unattributed residual land on their own sign.
    const gap = net - (inSum + outSum);
    if (gap > 0) inSum += gap;
    else outSum += gap;
    return { rows, other, unattributed, net, inSum, outSum, empty: !cand.length };
  }
  // Card / Peg-table peg: mean |price - 1| over the period's daily points (from, to], signed by the
  // mean signed deviation; plus the widest day. from=null: every point.
  function pegStats(c, from, to) {
    if (!c || !Array.isArray(c.values)) return null;
    let n = 0, sAbs = 0, sSig = 0, wide = null;
    c.values.forEach((v, i) => {
      if (!isNum(v)) return;
      const d = addDays(c.start, i);
      if ((from && d <= from) || (to && d > to)) return;
      const g = v - 1;
      n++;
      sAbs += Math.abs(g);
      sSig += g;
      if (!wide || Math.abs(g) > Math.abs(wide.gap)) wide = { gap: g, date: d };
    });
    if (!n) return null;
    return { avg: (sSig < 0 ? -1 : 1) * (sAbs / n), absAvg: sAbs / n, wide, n };
  }
  // Point change of a share series over (from, end]: last minus value at the period start, x100.
  function shareChange(c, from, end) {
    const last = end ? compactAt(c, end) : compactLast(c) && compactLast(c).value;
    const first = from ? compactAt(c, from) : compactFirst(c) && compactFirst(c).value;
    return isNum(last) && isNum(first) ? { s1: last, s0: first, pp: (last - first) * 100 } : null;
  }
  function ratioChange(c, from, end) {
    const a = from ? compactAt(c, from) : compactFirst(c) && compactFirst(c).value;
    const b = end ? compactAt(c, end) : compactLast(c) && compactLast(c).value;
    return isNum(a) && isNum(b) && a > 0 ? (b / a - 1) * 100 : null;
  }
  // Gold price change over a window from the USD and ounce changes of the same asset.
  const goldPriceChange = (chUsd, chOz) => (chUsd && chOz && isNum(chUsd.pct) && isNum(chOz.pct) ? ((1 + chUsd.pct / 100) / (1 + chOz.pct / 100) - 1) * 100 : null);
  const POL_RANK = { negative: 0, positive: 1, neutral: 2 };
  // Verdict for payloads without a briefing: notable health cells (data excluded) in scope.
  function fallbackVerdict(p, rows, aggKey) {
    const ins = p && p.insights;
    if (!ins || !(ins.testsRun > 0)) return { level: 'unknown', items: [], text: 'Checks unavailable in this snapshot' };
    const cells = (ins.health && ins.health.cells) || {};
    const items = [];
    for (const a of rows) for (const [dim, cell] of Object.entries(cells[a] || {})) {
      if (dim === 'data' || !cell || !/^notable_/.test(String(cell.state))) continue;
      items.push({ id: cell.evidence && cell.evidence.id, asset: a, chain: null, area: AREA[dim] || dim, lens: DIM_LENS[dim] || 'supply', tone: cell.state.replace('notable_', ''), since: null });
    }
    items.sort((x, y) => POL_RANK[x.tone] - POL_RANK[y.tone]);
    if (items.length) return { level: 'unusual', tone: items[0].tone, items, text: verdictText(items) };
    if ((ins.errors || []).length) return { level: 'partial', items, text: `Partly checked · ${plural(ins.errors.length, 'check')} could not run` };
    const one = rows.length === 1 && rows[0] !== aggKey ? rows[0] : null;
    const checks = one ? Object.entries(cells[one] || {}).filter(([d]) => d !== 'data').reduce((s, [, c]) => s + ((c && c.tests) || 0), 0) : ins.testsRun;
    return { level: 'clear', items, text: one ? `${one}: nothing unusual · ${fmtCount(checks)} checks` : `Nothing unusual · ${fmtCount(checks)} checks` };
  }
  const itemLabel = (it) => (it.chain ? `${it.asset} on ${it.chain}` : `${it.asset} ${it.area}`);
  const verdictText = (items) => (items.length === 1 ? `Unusual: ${itemLabel(items[0])}` : `${items.length} unusual: ${items.slice(0, 2).map(itemLabel).join(', ')}${items.length > 2 ? ` +${items.length - 2} more` : ''}`);

  const helpers = {
    RANGES, DEFAULT_RANGE, LENSES, rangeById, spanOf, tOf, isoOf, addDays, daysBetween,
    compactEnd, compactAt, compactLast, compactFirst, sliceCompact, changeFromCompact, changeFor, pctFrom, normalizeChanges, peakOf, alignCompacts, sumCompacts, bucketChanges, quantile,
    coverageStart, downsampleIdx, snapshotAge, sourceAgeNow, sourceStatusNow, canonicalAsset, isDataQuality, insightMatches, roleOf, titleOf, fallbackTitle, parseWindow,
    fmtUsd, fmtPct, fmtShare, fmtPortion, fmtPP, fmtPeg, pegWords, fmtOz, fmtCount, fmtMD, fmtDate, fmtHM, fmtAge, fmtTick, tickPlan,
    parseQuery, buildQuery, movesModel, pegStats, shareChange, ratioChange, goldPriceChange, fallbackVerdict, verdictText,
  };
  root.PaxosDashboard = helpers;
  if (typeof document === 'undefined' || !root.document) return;

  // ===== Browser =====
  const $ = (id) => document.getElementById(id);
  const hasChart = () => typeof root.Chart === 'function';
  const reduced = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const narrow = () => (root.innerWidth || 1280) < 760;
  const TOK = {};
  const TOKEN_NAMES = ['page', 'surface', 'surface-2', 'raised', 'ink', 'ink-2', 'ink-muted', 'hair', 'axis', 'focus', 'neutral', 'div-pos', 'div-neg', 'good', 'warn', 'crit', 'c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
  function readTokens() {
    const cs = getComputedStyle(document.documentElement);
    for (const n of TOKEN_NAMES) TOK[n] = cs.getPropertyValue('--' + n).trim() || '#888888';
    TOK.palette = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => TOK['c' + i]);
  }

  const state = {
    payload: null, error: null, loading: false, receivedAt: 0, loadStart: 0, fromSnapshot: false, sameSnapshot: false, retryFor: null, retryPending: false,
    asset: 'all', range: DEFAULT_RANGE, lens: 'supply', legacy: false, focus: null, fid: null,
    open: new Set(), more: new Set(), tables: new Set(), expanded: new Set(), autoOpened: new Set(), ftab: 'unusual', seenBefore: null, notice: null, fidMissing: false,
  };
  helpers.state = state;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'color') el.style.background = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const svgEl = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
    return el;
  };
  // replaceChildren() would print null/false as text; this drops them.
  const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
  const swatch = (color) => h('span', { class: 'swatch', color, 'aria-hidden': 'true' });
  const sr = (t) => h('span', { class: 'sr-only' }, t);
  // Signed numbers never break after their sign.
  const nw = (t) => h('span', { class: 'nowrap' }, t);

  // ----- payload accessors -----
  const P = () => state.payload;
  const assetData = (k) => (P() && P().assets && Object.prototype.hasOwnProperty.call(P().assets, k) ? P().assets[k] : null);
  let discCache = { p: null, list: null };
  function discovered() {
    const p = P();
    if (discCache.p === p) return discCache.list;
    const list = ((p.discovery && p.discovery.assets) || []).map((d) => ({ ...d, data: assetData(d.key) }));
    for (const k of Object.keys(p.assets || {})) if (!list.some((d) => d.key === k)) list.push({ ...p.assets[k], data: p.assets[k] });
    const tier = (d) => (d.status === 'active' ? 0 : d.status === 'legacy' ? 1 : 2);
    list.sort((a, b) => tier(a) - tier(b) || (isNum(a.colorIndex) ? a.colorIndex : 99) - (isNum(b.colorIndex) ? b.colorIndex : 99) || String(a.firstDate || '').localeCompare(String(b.firstDate || '')));
    discCache = { p, list };
    return list;
  }
  const meta = (k) => discovered().find((d) => d.key === k) || null;
  const legacyList = () => discovered().filter((d) => d.status === 'legacy' && d.data);
  const visibleAssets = () => discovered().filter((d) => d.data && (d.status === 'active' || (state.legacy && d.status === 'legacy') || d.key === state.asset));
  const supplyUsdOf = (d) => (d && d.data && d.data.current && isNum(d.data.current.supplyUsd) ? d.data.current.supplyUsd : 0);
  const bySupply = (list) => list.slice().sort((a, b) => (a.status === 'active') !== (b.status === 'active') ? (a.status === 'active' ? -1 : 1) : supplyUsdOf(b) - supplyUsdOf(a));
  const scopeAssets = () => (state.asset === 'all' ? bySupply(visibleAssets()) : discovered().filter((d) => d.key === state.asset && d.data));
  const isUsd = (d) => !!d && (d.unit === 'USD' || d.kind === 'usd-stablecoin');
  const isGold = (d) => !!d && d.kind === 'gold';
  const inScopeKey = (k) => state.asset === 'all' || k === state.asset;
  function colorOf(k) {
    const d = meta(k);
    return d && d.status === 'active' && isNum(d.colorIndex) && d.colorIndex >= 0 && d.colorIndex < TOK.palette.length ? TOK.palette[d.colorIndex] : TOK.neutral;
  }
  // Focus emphasis: every series other than the focused asset goes to --neutral.
  const lensColor = (k) => (state.focus && k !== state.focus ? TOK.neutral : colorOf(k));
  const rng = () => rangeById(state.range);
  const aggKey = () => (P().totals && P().totals.usd && typeof P().totals.usd.key === 'string' ? P().totals.usd.key : null);
  // The issuer's name from the aggregate key ("{issuer} USD"); "the issuer" without one.
  const issuer = () => String(aggKey() || '').replace(/\s*USD$/, '') || 'the issuer';
  function endIso() {
    const p = P();
    return compactEnd(p.totals && p.totals.usd && p.totals.usd.supplyUsd) || String((p.totals && p.totals.usd && p.totals.usd.supplyAsOf) || p.dataAsOf || p.generatedAt || '').slice(0, 10);
  }
  const refYear = () => endIso().slice(0, 4);
  const md = (iso) => fmtMD(iso, refYear());
  const attrWin = (w) => (P().attribution && P().attribution.windows && P().attribution.windows[w]) || null;
  // The selected period as dates: (from, to]. From the attribution window when present.
  function period() {
    const r = rng();
    const w = attrWin(r.win);
    const to = (w && w.to) || endIso();
    if (!isNum(r.days)) return { from: null, to, r };
    return { from: (w && w.from) || addDays(to, -r.days), to, r };
  }
  // Span ladder start for time graphics (null = from the series start).
  const spanStart = (end) => (spanOf(rng()) ? addDays(end || endIso(), -spanOf(rng())) : null);
  const floorOf = (k) => {
    const f = P().insights && P().insights.floorsUsd;
    return f && isNum(f[k]) ? f[k] : null;
  };
  const floorsAll = () => (P().insights && P().insights.floorsUsd) || null;
  const periodWords = () => rng().words;
  const isActiveOrShown = (k) => {
    if (k === aggKey()) return true;
    const d = meta(k);
    return !!d && (d.status === 'active' || (state.legacy && d.status === 'legacy'));
  };
  function sourcesNow() {
    const p = P();
    const now = Date.now();
    return ((p && p.sources) || []).map((s) => {
      const ageNow = sourceAgeNow(s, p, now);
      return { s, ageNow, status: sourceStatusNow(s, ageNow) };
    });
  }
  // Components that depend on a late or down source get a "◷" with the source and its age.
  function lateMark(kinds) {
    const bad = sourcesNow().filter((x) => kinds.includes(x.s.kind) && (x.status === 'stale' || x.status === 'error'));
    if (!bad.length) return null;
    const tip = bad.map((x) => `${x.s.label} is ${isNum(x.ageNow) ? fmtAge(x.ageNow) : 'not'} ${isNum(x.ageNow) ? 'old' : 'responding'}.`).join('\n');
    return h('span', { class: 's-warn', 'data-tip': tip, 'aria-label': tip }, '◷');
  }

  // ----- insight index: every list, with list membership as the stage fallback -----
  let IX = { byId: new Map(), units: [], watch: [], context: [] };
  // Older payloads: standing items began over 30 days ago, which is what "Earlier" means.
  const STAGE_FALLBACK = { feed: 'new', standing: 'past', watch: 'watch', context: 'context' };
  const stageOf = (i) => i.stage || (IX.byId.get(i.id) || {}).list && STAGE_FALLBACK[IX.byId.get(i.id).list] || 'watch';
  function indexInsights() {
    const ins = P().insights || {};
    const byId = new Map();
    const units = [];
    const add = (i, list, unit) => i && i.id && !byId.has(i.id) && byId.set(i.id, { i, list, unit });
    for (const c of ins.feed || []) {
      if (!c || !c.lead) continue;
      const u = { lead: c.lead, related: (c.related || []).filter(Boolean), list: 'feed' };
      units.push(u);
      add(c.lead, 'feed', u);
      u.related.forEach((r) => add(r, 'feed', u));
    }
    for (const i of ins.standing || []) {
      // A standing item still holding joins the feed cluster about the same asset and area (one story,
      // as the briefing's units: lib/paxos/briefing.js unitsOf).
      const same = i && i.stage === 'ongoing' && i.dimension !== 'data' ? units.find((u) => u.list === 'feed' && [u.lead, ...u.related].some((m) => m.asset === i.asset && m.dimension === i.dimension)) : null;
      if (same) {
        same.related.push(i);
        add(i, 'standing', same);
        continue;
      }
      const u = { lead: i, related: [], list: 'standing' };
      units.push(u);
      add(i, 'standing', u);
    }
    const watch = (ins.watch || []).filter(Boolean);
    watch.forEach((i) => add(i, 'watch', { lead: i, related: [], list: 'watch' }));
    (ins.context || []).forEach((i) => add(i, 'context', null));
    IX = { byId, units, watch, context: ins.context || [] };
  }
  const ins = (id) => (IX.byId.get(id) || {}).i || null;
  const unitOf = (id) => (IX.byId.get(id) || {}).unit || null;
  const lensOfIns = (i) => DIM_LENS[i.dimension] || null;
  // The briefing bullet (current scope and period) that states a unit: finding lines elsewhere show its
  // words and lead with its stating member, so the briefing, "Unusual here" and All findings agree.
  function bulletFor(unit) {
    const b = P() && briefingFor();
    const fr = b && b.frames && b.frames[rng().frame];
    if (!unit || !fr || !Array.isArray(fr.bullets)) return null;
    const ids = new Set([unit.lead, ...(unit.related || [])].filter(Boolean).map((i) => i.id));
    return fr.bullets.find((x) => x && x.kind === 'finding' && (x.refs || []).some((r) => ids.has(r))) || null;
  }
  function relead(u) {
    const bl = bulletFor(u);
    const id = bl && bl.link && bl.link.insight;
    const m = id && u.related.find((i) => i.id === id);
    return m ? { ...u, lead: m, related: [u.lead, ...u.related.filter((i) => i !== m)] } : u;
  }
  // The days a finding covers on charts: a restated peg finding's period (or since its start), else its
  // evidence window.
  function findingWindow(i) {
    if (!i) return null;
    const bl = bulletFor(unitOf(i.id) || { lead: i, related: [] });
    if (bl && bl.values && isNum(bl.values.gap)) {
      const fr = (briefingFor().frames || {})[rng().frame];
      const since = / since /.test(bl.text) && bl.since ? bl.since : null;
      return { from: since || addDays(fr.to, -((bl.values.days === 1 ? 1 : fr.days) - 1)), to: fr.to };
    }
    return i.evidence ? parseWindow(i.evidence.window, endIso()) : null;
  }
  const unitSince = (i) => {
    const u = i && unitOf(i.id);
    return [i, ...(u ? [u.lead, ...u.related] : [])].map((m) => m && m.novelty && m.novelty.since).filter(Boolean).sort()[0] || null;
  };

  // ----- verdict model (server briefing, or the health-cell fallback), with the view-time override -----
  function briefingFor() {
    const b = P().briefing;
    if (!b || typeof b !== 'object') return null;
    return state.asset === 'all' ? b : (b.byAsset && b.byAsset[state.asset]) || null;
  }
  function verdictModel() {
    const p = P();
    const b = briefingFor();
    let v;
    if (b && b.verdict && b.verdict.level) v = { ...b.verdict, items: (b.verdict.items || []).filter(Boolean) };
    else {
      const k = aggKey();
      const rows = state.asset === 'all' ? [k, ...visibleAssets().filter((d) => d.status === 'active').map((d) => d.key)].filter(Boolean) : [state.asset];
      v = fallbackVerdict(p, rows, k);
    }
    if (p.insights && (p.insights.errors || []).length && v.level === 'clear') v = { ...v, level: 'partial', text: `Partly checked · ${plural(p.insights.errors.length, 'check')} could not run` };
    // Never "Nothing unusual" while a core source (supply or market) is late or down at view time.
    if (v.level === 'clear' || v.level === 'minor') {
      const late = sourcesNow().filter((x) => (x.s.kind === 'supply' || x.s.kind === 'market') && (x.status === 'stale' || x.status === 'error')).sort((a, b) => (a.s.kind === 'supply' ? 0 : 1) - (b.s.kind === 'supply' ? 0 : 1))[0];
      if (late) v = { ...v, level: 'override', text: `Nothing ${v.level === 'minor' ? 'major' : 'unusual'} in available data · ${late.s.kind} data ${isNum(late.ageNow) ? fmtAge(late.ageNow) + ' old' : 'missing'}` };
    }
    return v;
  }
  const VERDICT_ICON = { minor: ['✓', 's-good'], clear: ['✓', 's-good'], partial: ['◆', 's-ink2'], override: ['◆', 's-ink2'], unknown: ['·', 's-muted'] };
  const TONE_ICON = { negative: ['!', 't-negative', 'Unusual, negative'], positive: ['+', 't-positive', 'Unusual, positive'], neutral: ['◆', 't-neutral', 'Unusual'] };
  const toneOf = (t) => (TONE_ICON[t] ? t : 'neutral');

  // ===== Tooltip (one element; [data-tip] on hover/focus, tap on touch) =====
  let tipEl = null;
  function tip() {
    if (!tipEl) {
      tipEl = h('div', { class: 'tip', 'aria-hidden': 'true' });
      tipEl.hidden = true;
      document.body.append(tipEl);
    }
    return tipEl;
  }
  function showTip(content, x, y) {
    const t = tip();
    t.replaceChildren(...[content].flat());
    t.hidden = false;
    const w = t.offsetWidth || 240;
    const vw = document.documentElement.clientWidth || root.innerWidth;
    t.style.left = Math.max(8, Math.min(x + 12, vw - w - 8)) + 'px';
    t.style.top = Math.max(8, y + 14) + 'px';
  }
  const hideTip = () => tipEl && (tipEl.hidden = true);

  // ===== SVG mini charts (sparklines, small multiples, evidence) =====
  // o: { n, series:[{ values, color, from? (index where the period starts; earlier drawn in --neutral), fill? }],
  //      stacked, lo, hi, band:[i0,i1], focusBand:[i0,i1], peer:{ lo:[], hi:[] }, zero, dot, h, label }
  function mini(o) {
    const W = 300;
    const H = o.h || 28;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'spark', focusable: 'false', 'data-graphic': o.graphic ? 'spark' : null });
    if (o.label) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', o.label);
    } else svg.setAttribute('aria-hidden', 'true');
    const n = o.n;
    if (!(n > 1)) return svg;
    const x = (i) => 1 + (i / (n - 1)) * (W - 2);
    const tops = o.stacked ? o.series.reduce((acc, s) => acc.map((v, i) => v + (isNum(s.values[i]) ? s.values[i] : 0)), new Array(n).fill(0)) : null;
    const all = [...(tops || o.series.flatMap((s) => s.values)), ...(o.peer ? [...o.peer.lo, ...o.peer.hi] : []), ...(o.zero ? [0] : [])].filter(isNum);
    if (!all.length) return svg;
    let lo = isNum(o.lo) ? o.lo : Math.min(...all);
    let hi = isNum(o.hi) ? o.hi : Math.max(...all);
    if (o.stacked) lo = Math.min(0, lo);
    if (hi === lo) {
      hi += Math.abs(hi) * 0.01 || 1;
      lo -= Math.abs(lo) * 0.01 || 1;
    }
    const y = (v) => H - 2 - ((v - lo) / (hi - lo)) * (H - 4);
    const rect = (b, fill, op) => b && b[1] >= b[0] && svg.append(svgEl('rect', { x: x(Math.max(0, b[0])), y: 0, width: Math.max(1, x(Math.min(n - 1, b[1])) - x(Math.max(0, b[0]))), height: H, fill, 'fill-opacity': op }));
    rect(o.band, TOK.raised, 1);
    rect(o.focusBand, TOK.focus, 0.12);
    if (o.peer) {
      const up = [];
      const dn = [];
      for (let i = 0; i < n; i++) if (isNum(o.peer.lo[i]) && isNum(o.peer.hi[i])) {
        up.push(`${x(i).toFixed(1)},${y(o.peer.hi[i]).toFixed(2)}`);
        dn.unshift(`${x(i).toFixed(1)},${y(o.peer.lo[i]).toFixed(2)}`);
      }
      if (up.length > 1) svg.append(svgEl('polygon', { points: [...up, ...dn].join(' '), fill: TOK.neutral, 'fill-opacity': 0.15 }));
    }
    if (o.zero && lo < 0 && hi > 0) svg.append(svgEl('line', { x1: 0, x2: W, y1: y(0), y2: y(0), stroke: TOK.axis, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
    const path = (vals, i0, i1) => {
      let d = '';
      let pen = false;
      for (let i = i0; i <= i1; i++) {
        if (!isNum(vals[i])) {
          pen = false;
          continue;
        }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(vals[i]).toFixed(2)}`;
        pen = true;
      }
      return d;
    };
    const stroke = (d, color) => d && svg.append(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
    if (o.stacked) {
      let base = new Array(n).fill(0);
      for (const s of o.series) {
        const top = base.map((b, i) => b + (isNum(s.values[i]) ? s.values[i] : 0));
        const pts = top.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(2)}`).concat(base.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(2)}`).reverse());
        svg.append(svgEl('polygon', { points: pts.join(' '), fill: s.color, 'fill-opacity': 0.18 }));
        stroke(path(top, 0, n - 1), s.color);
        base = top;
      }
    } else {
      for (const s of o.series) {
        const f = isNum(s.from) ? Math.max(0, Math.min(n - 1, s.from)) : 0;
        if (s.fill) {
          const pts = s.values.map((v, i) => (isNum(v) ? `${x(i).toFixed(1)},${y(v).toFixed(2)}` : null)).filter(Boolean);
          if (pts.length > 1) svg.append(svgEl('polygon', { points: [...pts, `${x(n - 1).toFixed(1)},${H}`, `${x(0).toFixed(1)},${H}`].join(' '), fill: s.color, 'fill-opacity': 0.1 }));
        }
        if (f > 0) stroke(path(s.values, 0, f), TOK.neutral);
        stroke(path(s.values, f, n - 1), s.color);
      }
    }
    if (o.dot) {
      const s = o.series[o.series.length - 1];
      for (let i = n - 1; i >= 0; i--) if (isNum(s.values[i])) {
        svg.append(svgEl('circle', { cx: x(i), cy: y(s.values[i]), r: 2.5, fill: s.color }));
        break;
      }
    }
    const hair = svgEl('line', { x1: 0, x2: 0, y1: 0, y2: H, stroke: TOK['ink-2'], 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', visibility: 'hidden' });
    svg.append(hair);
    svg._hair = (i) => {
      if (i === null || i === undefined) return hair.setAttribute('visibility', 'hidden');
      hair.setAttribute('x1', x(i));
      hair.setAttribute('x2', x(i));
      hair.setAttribute('visibility', 'visible');
    };
    return svg;
  }
  // A synced crosshair over several minis sharing one date axis (n points). Touch: press and hold.
  function hoverGroup(n, onMove, onLeave) {
    const svgs = [];
    let holdTimer = null;
    let holding = false;
    const at = (svg, e) => {
      const r = svg.getBoundingClientRect();
      if (!r.width) return null;
      return Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
    };
    const move = (svg, e) => {
      const i = at(svg, e);
      if (i === null) return;
      svgs.forEach((s) => s._hair(i));
      onMove(i, e);
    };
    const leave = () => {
      svgs.forEach((s) => s._hair(null));
      onLeave();
    };
    return {
      attach(svg) {
        svgs.push(svg);
        svg.addEventListener('pointermove', (e) => (e.pointerType !== 'touch' || holding) && move(svg, e));
        svg.addEventListener('pointerleave', (e) => e.pointerType !== 'touch' && leave());
        svg.addEventListener('pointerdown', (e) => {
          if (e.pointerType !== 'touch') return;
          holdTimer = setTimeout(() => {
            holding = true;
            move(svg, e);
          }, 350);
        });
        const end = () => {
          clearTimeout(holdTimer);
          if (holding) {
            holding = false;
            svg._suppressClick = true;
            setTimeout(() => (svg._suppressClick = false), 400);
            leave();
          }
        };
        svg.addEventListener('pointerup', end);
        svg.addEventListener('pointercancel', end);
        return svg;
      },
    };
  }
  // Dates of a span for one or more compacts: span ladder start (or earliest start) to end.
  function spanDates(compacts, end) {
    const first = compacts.map((c) => compactFirst(c)).filter(Boolean).map((x) => x.date).sort()[0];
    return datesBetween(spanStart(end) || first || end, end);
  }
  function thin(dates, rows, max) {
    const tot = dates.map((_, i) => rows.reduce((s, r) => s + (isNum(r[i]) ? r[i] : 0), 0));
    const idx = downsampleIdx(tot, max);
    if (!idx) return { dates, rows };
    return { dates: idx.map((i) => dates[i]), rows: rows.map((r) => idx.map((i) => r[i])) };
  }
  // Several series on one date axis (cards, chain cards): the union of each series' kept indices.
  function thinShared(dates, rows, max) {
    if (dates.length <= max) return { dates, rows };
    const keep = new Set([0, dates.length - 1]);
    for (const r of rows) (downsampleIdx(r, Math.max(8, Math.floor(max / Math.max(1, rows.length)))) || []).forEach((i) => keep.add(i));
    const idx = [...keep].sort((a, b) => a - b);
    return { dates: idx.map((i) => dates[i]), rows: rows.map((r) => idx.map((i) => r[i])) };
  }
  // Card sparklines on one shared axis, so the synced crosshair points at the same date on every card.
  function cardSparks(series, end) {
    const dates = spanDates(series.filter(Boolean), end);
    const al = alignCompacts(series, dates[0], end);
    const t = thinShared(al.dates, al.rows, 400);
    const pr = period();
    return { dates: t.dates, rows: t.rows, from: pr.from ? indexIn(t.dates, pr.from) : 0 };
  }
  const indexIn = (dates, iso) => {
    if (!iso || !dates.length) return null;
    if (iso <= dates[0]) return 0;
    if (iso >= dates[dates.length - 1]) return dates.length - 1;
    let i = dates.findIndex((d) => d >= iso);
    if (i < 0) i = dates.length - 1;
    return i;
  };
  // The finding window (from #f=) as a band on a date axis.
  function focusBandOf(dates) {
    const w = state.fid ? findingWindow(ins(state.fid)) : null;
    return w ? [indexIn(dates, w.from), indexIn(dates, w.to)] : null;
  }

  // ===== Chart.js =====
  let io = null;
  const factories = new WeakMap();
  function createChart(canvas) {
    const f = factories.get(canvas);
    if (!f || canvas._chart || !canvas.isConnected) return;
    try {
      canvas._chart = new root.Chart(canvas, f());
    } catch (e) {
      console.error('chart failed', e);
      const fig = canvas.closest('figure');
      if (fig && fig._failed) fig._failed();
    }
  }
  function nearView(el) {
    if (!el.isConnected || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect(), vh = root.innerHeight || 800;
    return r.bottom > -300 && r.top < vh + 300 && (r.width > 0 || r.height > 0);
  }
  function destroyCharts(el) {
    for (const c of el.querySelectorAll('canvas')) {
      if (io) io.unobserve(c);
      if (c._chart) {
        c._chart.destroy();
        c._chart = null;
      }
    }
  }
  function setupCharts() {
    if (!hasChart()) return;
    const C = root.Chart;
    C.defaults.font.family = getComputedStyle(document.body).fontFamily;
    C.defaults.font.size = 11;
    C.defaults.color = TOK['ink-muted'];
    C.defaults.borderColor = TOK.hair;
    C.defaults.animation = false;
    C.defaults.responsive = true;
    C.defaults.maintainAspectRatio = false;
    C.defaults.plugins.legend.display = false;
    Object.assign(C.defaults.plugins.tooltip, { backgroundColor: TOK['surface-2'], borderColor: TOK.axis, borderWidth: 1, titleColor: TOK.ink, bodyColor: TOK.ink, footerColor: TOK['ink-muted'], padding: 8, usePointStyle: true, boxWidth: 10, boxHeight: 10, boxPadding: 4 });
    if ('IntersectionObserver' in root) {
      io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) {
          io.unobserve(e.target);
          createChart(e.target);
        }
      }, { rootMargin: '300px 0px' });
    }
  }
  // Period band (and the finding window) behind the data; vertical crosshair on hover.
  const bandPlugin = {
    id: 'band',
    beforeDatasetsDraw(chart, _a, o) {
      if (!o || !o.bands) return;
      const { top, bottom } = chart.chartArea;
      const xs = chart.scales.x;
      const ctx = chart.ctx;
      for (const b of o.bands) {
        if (!b || !isNum(b.i0) || !isNum(b.i1)) continue;
        const x0 = xs.getPixelForValue(b.i0);
        const x1 = Math.max(x0 + 2, xs.getPixelForValue(b.i1));
        ctx.save();
        ctx.fillStyle = b.color;
        ctx.globalAlpha = b.alpha || 1;
        ctx.fillRect(x0, top, x1 - x0, bottom - top);
        ctx.globalAlpha = 1;
        if (b.label) {
          ctx.fillStyle = TOK['ink-muted'];
          ctx.font = `10px ${root.Chart.defaults.font.family}`;
          ctx.textBaseline = 'top';
          ctx.fillText(b.label, x0 + 3, top + 2);
        }
        ctx.restore();
      }
    },
    afterDatasetsDraw(chart) {
      const act = chart.tooltip && chart.tooltip.getActiveElements();
      if (!act || !act.length || chart.config.type !== 'line') return;
      const x = Math.round(act[0].element.x) + 0.5;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = TOK.axis;
      ctx.beginPath();
      ctx.moveTo(x, chart.chartArea.top);
      ctx.lineTo(x, chart.chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };
  // Direct end labels for small line charts; colliding labels are dropped (the legend stays).
  // A stacked chart labels each band at its vertical middle with its own value ("{coin} $3.10B"), not at the
  // stack top (where the top label would sit beside the total).
  const endLabels = {
    id: 'endLabels',
    afterDatasetsDraw(chart, _a, o) {
      if (!o || !o.enabled) return;
      const ctx = chart.ctx;
      const items = [];
      const stacked = !!(chart.options.scales && chart.options.scales.y && chart.options.scales.y.stacked);
      let below = null;
      chart.data.datasets.forEach((ds, i) => {
        const m = chart.getDatasetMeta(i);
        for (let j = m.data.length - 1; j >= 0; j--) if (isNum(ds.data[j])) {
          const top = m.data[j].y;
          const base = stacked ? (below === null ? chart.scales.y.getPixelForValue(0) : below) : top;
          items.push({ y: stacked ? (top + base) / 2 : top, label: o.fmt ? `${ds.label} ${o.fmt(ds.data[j])}` : ds.label, color: ds.borderColor });
          if (stacked) below = top;
          break;
        }
      });
      items.sort((a, b) => a.y - b.y);
      ctx.save();
      ctx.font = `11px ${root.Chart.defaults.font.family}`;
      ctx.textBaseline = 'middle';
      let last = -Infinity;
      const x = chart.chartArea.right + 6;
      for (const it of items) {
        if (it.y - last < 13) continue;
        ctx.fillStyle = it.color;
        ctx.fillRect(x, it.y - 1, 8, 2);
        ctx.fillStyle = TOK['ink-2'];
        ctx.fillText(it.label, x + 11, it.y);
        last = it.y;
      }
      ctx.restore();
    },
  };
  function lineConfig({ labels, datasets, yFmt, tipFmt, spanDays, stacked, endLabel, yExtra, band }) {
    const fmt = tipFmt || yFmt;
    const max = narrow() ? 4 : 7;
    const plan = tickPlan(labels, spanDays, max);
    return {
      type: 'line',
      data: { labels, datasets },
      plugins: [bandPlugin, endLabels],
      options: {
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { right: endLabel && !narrow() ? (endLabel.fmt ? 116 : 56) : 4, top: 4 } },
        scales: {
          x: { type: 'category', grid: { display: false }, border: { color: TOK.axis }, ticks: { autoSkip: !plan, maxRotation: 0, maxTicksLimit: plan ? undefined : max, color: TOK['ink-muted'], callback(v, i) {
            if (plan && !plan.has(i)) return null;
            return fmtTick(this.getLabelForValue(v), spanDays);
          } } },
          y: { stacked: !!stacked, grid: { color: (c) => (c.tick && c.tick.value === 0 ? TOK.axis : TOK.hair), drawTicks: false }, border: { display: false }, ticks: { color: TOK['ink-muted'], maxTicksLimit: 5, padding: 6, callback: (v) => yFmt(v) }, ...(yExtra || {}) },
        },
        plugins: {
          band: { bands: band || [] },
          endLabels: { enabled: !!endLabel && !narrow(), fmt: endLabel && endLabel.fmt },
          tooltip: { itemSort: (a, b) => b.datasetIndex - a.datasetIndex, callbacks: {
            title: (it) => (it && it[0] ? (String(it[0].label).length > 10 ? `${fmtDate(String(it[0].label))} ${String(it[0].label).slice(11, 16)} UTC` : fmtDate(String(it[0].label))) : ''),
            label: (c) => ` ${isNum(c.parsed.y) ? fmt(c.parsed.y) : '—'}  ${c.dataset.label}`,
            footer: stacked ? (items) => `Total ${fmt(items.reduce((s, i) => s + (isNum(i.parsed.y) ? i.parsed.y : 0), 0))}` : undefined,
          } },
        },
      },
    };
  }
  const lineDs = (label, data, color, extra = {}) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 3, pointStyle: 'line', tension: 0, spanGaps: true, ...extra });
  const alpha = (hex, a) => (/^#[0-9a-f]{6}$/i.test(hex || '') ? `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})` : hex);
  function periodBands(dates) {
    const pr = period();
    const out = [];
    if (pr.from && dates.length) {
      const i0 = indexIn(dates, addDays(pr.from, 1));
      if (i0 > 1) out.push({ i0, i1: dates.length - 1, color: TOK.raised, label: pr.r.label });
    }
    const fb = focusBandOf(dates);
    if (fb) out.push({ i0: fb[0], i1: fb[1], color: TOK.focus, alpha: 0.1 });
    return out;
  }

  // ----- figure: title, chart (lazy canvas or HTML/SVG body), legend, Table toggle (table built on open) -----
  // Source kinds each lens depends on (a late or down source puts a ◷ after the figure titles).
  const LENS_SOURCES = { supply: ['supply'], chains: ['supply'], peg: ['price'], market: ['market'], usage: ['defi', 'usage', 'onchain'], income: ['economics'] };
  function figure({ key, title, sub, label, config, body, legend, table, size }) {
    const late = lateMark(LENS_SOURCES[state.lens] || []);
    const fig = h('figure', { class: 'viz' }, h('figcaption', null, title, late ? [' ', late] : null, sub ? h('span', { class: 'cap-sub' }, sub) : null));
    const tkey = 'tv:' + key;
    const holder = h('div', { class: 'tw-holder' });
    let btn = null;
    let built = false;
    const setOpen = (open) => {
      if (open && !built && table) {
        built = true;
        try {
          holder.replaceChildren(table());
        } catch (e) {
          console.error('table failed', e);
          holder.replaceChildren(h('p', { class: 'fail' }, 'Not in this snapshot.'));
        }
      }
      holder.hidden = !open;
      if (btn) {
        btn.setAttribute('aria-pressed', String(open));
        btn.textContent = open ? 'Hide table' : 'Table';
      }
      if (open) state.tables.add(tkey);
      else state.tables.delete(tkey);
    };
    let chartEl = null;
    if (config && hasChart()) {
      const canvas = h('canvas', { role: 'img', 'aria-label': label || title });
      factories.set(canvas, config);
      chartEl = h('div', { class: 'chart-box ' + (size || ''), 'data-graphic': 'chart' }, canvas);
      // A chart already in (or next to) view is drawn now (a tab switch never shows an empty frame); the
      // lazy observer handles those further down the page.
      queueMicrotask(() => (!io || nearView(canvas) ? createChart(canvas) : io.observe(canvas)));
    } else if (body) {
      try {
        chartEl = body();
      } catch (e) {
        console.error('figure body failed', e);
        chartEl = null;
        fig._bodyFailed = true;
      }
    }
    if (chartEl) fig.append(chartEl);
    else if (config || fig._bodyFailed) {
      if (fig._bodyFailed) fig.append(h('p', { class: 'fail' }, 'This part couldn\'t be drawn. The table has the numbers.'));
      state.tables.add(tkey);
    }
    if (legend && (legend.length > 1 || legend.force)) fig.append(h('div', { class: 'legend', 'aria-hidden': 'true' }, legend.map((l) => h('span', { 'data-tip': l.tip || null }, l.band ? h('span', { class: 'swatch band', color: l.color }) : swatch(l.color), l.label))));
    fig._failed = () => {
      if (chartEl) chartEl.replaceWith(h('p', { class: 'fail' }, 'This part couldn\'t be drawn. The table has the numbers.'));
      setOpen(true);
    };
    if (table) {
      btn = h('button', { type: 'button', class: 'linkbtn tv-btn', 'aria-pressed': 'false', 'data-tv': tkey, 'aria-label': null, onclick: () => setOpen(holder.hidden) }, 'Table');
      fig.append(btn, holder);
      holder.hidden = true;
      if (state.tables.has(tkey)) setOpen(true);
    }
    return fig;
  }
  function table({ caption, head, rows, wrap }) {
    return h('div', { class: 'tw ' + (wrap || '') }, h('table', null,
      caption ? h('caption', null, caption) : null,
      h('thead', null, h('tr', null, head.map((c) => h('th', { scope: 'col', class: c && c.l ? 'l' : null }, typeof c === 'string' ? c : c.t)))),
      h('tbody', null, rows.map((r) => h('tr', { class: r.cls || null }, r.cells.map((c, i) => (i === 0 ? h('th', { scope: 'row', class: 'l' }, c) : h('td', { class: head[i] && head[i].l ? 'l' : null, 'data-tip': c && c.tip ? c.tip : null }, c && c.v !== undefined ? c.v : c))))))));
  }
  const dash = (why) => ({ v: '—', tip: why });

  // ===== Components =====
  // 1. Freshness chip (§3.1)
  function chipModel() {
    const p = P();
    const now = Date.now();
    if (!p) {
      if (state.error) return { dot: 'crit', text: 'Data unavailable' }; // the error panel carries the line and Retry
      return { dot: null, text: 'Loading…', extra: state.loading && now - state.loadStart >= 3000 ? 'Building a fresh snapshot; this can take up to 15 seconds.' : null };
    }
    const today = new Date(now).toISOString().slice(0, 10);
    const gen = String(p.generatedAt || '');
    const snap = `${gen.slice(0, 10) !== today ? md(gen.slice(0, 10)) + ' ' : ''}${fmtHM(gen)} UTC`;
    if (root.navigator && root.navigator.onLine === false) return { dot: 'muted', text: `Offline · snapshot ${snap}` };
    if (state.error) return { dot: 'warn', text: `Snapshot ${snap} · couldn't refresh`, extra: 'Showing the last saved data.', retry: true };
    const fr = snapshotAge(p, now);
    if (!fr.current || state.fromSnapshot) {
      if (state.sameSnapshot && !state.loading && !state.retryPending) return { dot: 'warn', text: `Snapshot ${snap} · no newer data yet` };
      return { dot: 'muted', text: `Snapshot ${snap} · updating` };
    }
    const prices = discovered().filter((d) => d.status === 'active' && d.data && d.data.current && d.data.current.priceAsOf).map((d) => d.data.current.priceAsOf).sort().pop();
    const supplyTo = (p.totals.usd.supplyAsOf || p.dataAsOf || '').slice(0, 10);
    let text = `Supply as of ${md(supplyTo)}${prices ? ` · prices ${fmtHM(prices)} UTC` : ''}`;
    const now2 = sourcesNow();
    const down = now2.filter((x) => x.status === 'error').length;
    const late = now2.filter((x) => x.status === 'stale').length;
    // A figure the build could not produce (a null section, an asset without a USD value) is missing even
    // when its sources only answered in part (payload.status reasons of kind "section").
    const missing = ((p.status && Array.isArray(p.status.reasons) && p.status.reasons) || []).filter((r) => r && r.kind === 'section').length;
    if (down) text += ` · ${down} source${down === 1 ? '' : 's'} down`;
    if (late) text += ` · ${late} source${late === 1 ? '' : 's'} late`;
    if (missing) text += ` · ${missing} figure${missing === 1 ? '' : 's'} missing`;
    return { dot: down || late || missing ? 'warn' : 'good', text };
  }
  function renderChip() {
    const m = chipModel();
    const chip = $('chip');
    const p = P();
    const sig = `${m.dot}|${m.text}`;
    if (chip.dataset.sig !== sig) {
      chip.dataset.sig = sig;
      chip.replaceChildren(...[m.dot ? h('span', { class: 'dot dot-' + m.dot, 'aria-hidden': 'true' }) : null, h('span', null, m.text)].filter(Boolean));
    }
    const supplyTo = p ? (p.totals.usd.supplyAsOf || p.dataAsOf || '').slice(0, 10) : null;
    chip.dataset.tip = p ? `Supply is a daily snapshot (${md(supplyTo)} 00:00 UTC). Prices are hourly. Built ${fmtHM(p.generatedAt)} UTC.` : '';
    chip.disabled = !p;
    const live = $('chip-live');
    if (live.textContent !== m.text) live.textContent = m.text;
    const ex = $('chip-extra');
    const exSig = `${m.extra || ''}|${!!m.retry}|${state.loading}`;
    if (ex.dataset.sig !== exSig) {
      ex.dataset.sig = exSig;
      ex.replaceChildren(...[m.extra ? h('span', null, m.extra) : null, m.retry ? h('button', { type: 'button', class: 'btn', 'data-action': 'reload', 'aria-busy': String(!!state.loading) }, 'Retry') : null].filter(Boolean));
      ex.hidden = !m.extra && !m.retry;
    }
  }

  // 2. Scope bar (§3.2) and the mobile compact bar
  function renderScope() {
    const p = P();
    const scope = $('scope');
    scope.setAttribute('aria-disabled', String(!p));
    if (!p) {
      if (!$('f-range').childNodes.length) $('f-range').replaceChildren(...RANGES.map((r) => h('button', { type: 'button', 'data-range': r.id, 'aria-pressed': String(state.range === r.id), disabled: true }, r.label, sr(` (${r.text})`))));
      return;
    }
    const btns = [h('button', { type: 'button', 'data-asset': 'all', 'aria-pressed': String(state.asset === 'all') }, 'All')];
    const active = bySupply(discovered().filter((d) => d.status === 'active' && d.data));
    for (const d of active) btns.push(h('button', { type: 'button', 'data-asset': d.key, 'aria-pressed': String(state.asset === d.key), 'data-tip': d.name || null }, swatch(colorOf(d.key)), d.key));
    const leg = legacyList();
    if (state.legacy) for (const d of leg) btns.push(h('button', { type: 'button', 'data-asset': d.key, 'aria-pressed': String(state.asset === d.key), 'data-tip': d.name || null }, swatch(TOK.neutral), d.key, sr(' (legacy)')));
    if (leg.length) btns.push(h('button', { type: 'button', class: 'legacy-toggle', 'data-action': 'legacy', 'data-legacy': '', 'aria-pressed': String(state.legacy), 'data-tip': `${joinAnd(leg.map((d) => d.key))}: no longer listed as issued by ${issuer()}; shown for the supply still out.` }, state.legacy ? 'Hide legacy' : `+${leg.length} legacy`));
    const row = $('f-asset');
    row.replaceChildren(...btns);
    $('f-range').replaceChildren(...RANGES.map((r) => h('button', { type: 'button', 'data-range': r.id, 'aria-pressed': String(state.range === r.id) }, r.label, sr(` (${r.text})`))));
    // Narrow screens scroll the asset row sideways: the pressed asset is scrolled into it (never under the
    // edge fade), and the fade shows only while more buttons lie to the right.
    const pressed = btns.find((b) => b.getAttribute('aria-pressed') === 'true' && b.dataset.asset !== 'all');
    if (pressed && row.scrollWidth > row.clientWidth) {
      const r0 = row.getBoundingClientRect(), r1 = pressed.getBoundingClientRect(), clear = r0.left + 0.8 * r0.width; // (the fade covers the last 15%)
      if (r1.right > clear) row.scrollLeft += r1.right - clear + 8;
      else if (r1.left < r0.left) row.scrollLeft -= r0.left - r1.left + 8;
    }
    fadeEnd(row);
  }
  const fadeEnd = (row) => row.classList.toggle('at-end', row.scrollLeft + row.clientWidth >= row.scrollWidth - 2);
  let compactShown = false;
  function renderCompact(v) {
    const el = $('compact');
    const show = compactShown && narrow() && !!P();
    el.hidden = !show;
    if (!show) return;
    put(el,
      h('button', { type: 'button', 'data-action': 'to-scope' }, `${state.asset === 'all' ? 'All' : state.asset} · ${rng().label} ▾`),
      h('button', { type: 'button', class: 'cv', 'data-action': 'to-brief' }, v && v.icon ? h('span', { class: 'ico ' + v.icon[1], 'aria-hidden': 'true' }, v.icon[0]) : null, ' ', v ? v.text : ''),
    );
  }

  // 3. Verdict (§3.3)
  let lastVerdict = null;
  function renderVerdict() {
    const el = $('verdict');
    const p = P();
    let v;
    if (!p) v = { level: 'loading', text: state.error ? 'Data unavailable' : 'Loading the latest snapshot…', items: [] };
    else v = verdictModel();
    const icon = v.level === 'unusual' ? TONE_ICON[toneOf(v.tone || (v.items[0] && v.items[0].tone))] : VERDICT_ICON[v.level] || null;
    v.icon = icon;
    lastVerdict = v;
    const srPrefix = v.level === 'unusual' ? `${icon[2]}: ` : '';
    const sig = `${v.level}|${v.text}`;
    if (el.dataset.sig === sig) return v;
    el.dataset.sig = sig;
    if (!el.querySelector('.vtext')) el.replaceChildren(h('span', { class: 'ico', 'aria-hidden': 'true' }), h('span', { class: 'vtext', role: 'status', 'aria-live': 'polite' }));
    const ico = el.querySelector('.ico');
    ico.className = 'ico ' + (icon ? icon[1] : '');
    ico.textContent = icon ? icon[0] : '';
    el.querySelector('.vtext').replaceChildren(...[srPrefix ? sr(srPrefix.replace(/^Unusual(: )?$/, '')) : null, v.text].filter(Boolean));
    const old = el.querySelector('.vmore');
    if (old) old.remove();
    if (v.level === 'unusual' || v.level === 'minor') el.append(h('button', { type: 'button', class: 'vmore', 'aria-controls': 'brief-list', 'aria-label': 'Show the findings', 'data-action': 'verdict-more' }, h('span', { class: 'vmore-l', 'aria-hidden': 'true' }, 'Details '), '›'));
    return v;
  }

  // 4. Hero (§3.4)
  function deltaLine(ch, unit, r, extraFrom) {
    if (!ch || !isNum(ch.abs)) return { node: null, sr: '', value: null };
    const fmtAbs = (x) => (unit === 'oz' ? fmtOz(x) : fmtUsd(x));
    const zero = Math.abs(ch.abs) < (unit === 'oz' ? 0.05 : 0.5);
    const arrow = zero ? '' : ch.abs > 0 ? '▲ ' : '▼ ';
    const when = r.win === 'all' ? `since ${fmtMonthYear(ch.from || extraFrom)}` : r.label;
    const parts = zero ? ['flat'] : [`${arrow}${fmtAbs(Math.abs(ch.abs))}`, isNum(ch.pct) && r.win !== 'all' ? fmtPct(ch.pct) : null];
    const node = h('span', null, ...parts.filter(Boolean).map((t, i) => [i ? ' · ' : '', nw(t)]), h('span', { class: 'per' }, ` · ${when}`));
    const srText = zero ? `flat over ${periodWords()}` : `${ch.abs > 0 ? 'up' : 'down'} ${fmtAbs(Math.abs(ch.abs))}${isNum(ch.pct) ? `, ${fmtPct(ch.pct)}` : ''}, over ${r.win === 'all' ? 'the full history' : periodWords()}`;
    return { node, sr: srText, value: ch.abs };
  }
  // Hero / card sparkline: span ladder dates, period in colour, earlier days in --neutral.
  function sparkFor(c, color, end, h2, shade) {
    const dates = spanDates([c], end);
    const al = alignCompacts([c], dates[0], end);
    let vals = al.rows[0];
    let ds = al.dates;
    const t = thin(ds, [vals], 600);
    ds = t.dates;
    vals = t.rows[0];
    const pr = period();
    const from = pr.from ? indexIn(ds, pr.from) : 0;
    return { dates: ds, vals, svg: mini({ n: ds.length, series: [{ values: vals, color, from }], band: shade && pr.from ? [from, ds.length - 1] : null, h: h2 || 28 }) };
  }
  function renderHero() {
    const p = P();
    const r = rng();
    const pr = period();
    const end = endIso();
    const el = $('hero');
    const subs = [];
    let label;
    let value;
    let delta;
    let series;
    const sparkColor = TOK.ink;
    const supplyLate = lateMark(['supply']);
    if (state.asset === 'all') {
      const t = p.totals.usd;
      label = [`${t.key || 'Total'} stablecoins · ${md((t.supplyAsOf || end).slice(0, 10))}`];
      value = fmtUsd(t.current);
      delta = deltaLine(changeFor(t.change, t.supplyUsd, r, end), 'usd', r);
      series = t.supplyUsd;
      // Over the full history the share and market comparisons span different eras: shown per window only.
      const sc = t.marketShare && pr.from ? shareChange(t.marketShare, pr.from, end) : null;
      const mk = p.market && p.market.usdTotal && pr.from ? ratioChange(p.market.usdTotal, pr.from, end) : null;
      // The share's move is always stated ("(flat)" rather than dropped) and the market is named in full,
      // so "+1.0%" beside the hero's own +1.0% cannot read as Paxos's.
      if (isNum(t.shareCurrent)) subs.push([[`${fmtShare(t.shareCurrent)} of USD stablecoins`, sc ? (Math.abs(sc.pp) < 0.005 ? ' (flat)' : [' ', nw(`${sc.pp > 0 ? '▲' : '▼'} ${fmtPP(sc.pp)}`)]) : null], isNum(mk) ? nw(`all USD stablecoins ${fmtPct(mk)}`) : null]);
      const all = p.totals.allUsd;
      const miss = all && (all.missing || []).length ? ` (${joinAnd(all.missing)} missing)` : '';
      const allTxt = all ? (isNum(all.current) ? `${fmtUsd(all.current)} with gold and legacy` : isNum(all.coveredUsd) ? h('span', { 'data-tip': `Excludes ${(all.missing || []).join(', ')}: no USD value.` }, `≥ ${fmtUsd(all.coveredUsd)} with gold and legacy${miss}`) : null) : null;
      subs.push([peakText(t.ath, t.drawdownPct, fmtUsd, end), allTxt]);
    } else {
      const d = meta(state.asset);
      const c = d.data.current || {};
      label = [`${d.key} · ${d.name || d.key} · ${md((c.supplyAsOf || end).slice(0, 10))}`, d.status !== 'active' ? h('span', { class: 'badge' }, d.status) : null];
      if (isGold(d)) {
        value = isNum(c.supply) ? fmtOz(c.supply) : null;
        series = d.data.series && d.data.series.supply;
        const chOz = changeFor(c.nativeChange, series, r, end);
        delta = deltaLine(chOz, 'oz', r);
        const gp = r.win !== 'all' ? goldPriceChange(c.change && c.change[r.win], c.nativeChange && c.nativeChange[r.win]) : null;
        subs.push([isNum(c.supplyUsd) ? `worth ${fmtUsd(c.supplyUsd)}` : null, isNum(gp) ? nw(`gold price ${fmtPct(gp)}`) : null]);
        subs.push([peakText(c.nativeAth, c.nativeDrawdownPct, (x) => fmtOz(x), end, true)]);
      } else {
        value = isNum(c.supplyUsd) ? fmtUsd(c.supplyUsd) : null;
        series = d.data.series && d.data.series.supplyUsd;
        delta = deltaLine(changeFor(c.change, series, r, end), 'usd', r);
        const mk = p.market && p.market.usdTotal;
        const share = mk && series ? { start: series.start, values: series.values.map((v, i) => { const m = compactAt(mk, addDays(series.start, i)); return isNum(v) && m ? v / m : null; }) } : null;
        const sc = share && pr.from ? shareChange(share, pr.from, end) : null;
        if (isNum(c.marketShare)) subs.push([[`${fmtShare(c.marketShare)} of USD stablecoins`, sc ? (Math.abs(sc.pp) < 0.005 ? ' (flat)' : [' ', nw(`${sc.pp > 0 ? '▲' : '▼'} ${fmtPP(sc.pp)}`)]) : null], isNum(c.rank) ? nw(`#${c.rank}${isNum(c.rankOf) ? ` of ${fmtCount(c.rankOf)}` : ''}`) : null]);
        subs.push([peakText(c.ath, c.drawdownPct, fmtUsd, end)]);
      }
    }
    const sp = series ? sparkFor(series, sparkColor, end, 40, true) : null;
    el.setAttribute('data-hero', '');
    // The sparkline's span and the shaded period, named under it (decorative: the numbers are above).
    const cap = sp && pr.from ? h('div', { class: 'spark-cap', 'aria-hidden': 'true' }, h('span', null, spanText()), h('span', null, r.label)) : null;
    const missing = value === null ? h('p', { class: 'h-sub muted', 'data-tip': missingWhy(state.asset) }, 'No supply figure in this snapshot') : null;
    put(el,
      h('div', { class: 'h-label' }, label, supplyLate),
      h('div', { class: 'h-fig' + (value === null ? ' empty' : '') }, value === null ? '—' : value),
      missing,
      h('div', { class: 'h-delta', 'data-hero-delta': '', 'data-value': delta.value }, delta.node || ''),
      sp ? h('div', { class: 'spark-wrap', 'data-graphic': 'spark' }, sp.svg, cap) : null,
      ...subs.map((parts) => parts.filter(Boolean)).filter((parts) => parts.length).map((parts) => h('p', { class: 'h-sub' }, parts.map((x, i) => [i ? ' · ' : '', x]))),
      sr(`${(typeof label[0] === 'string' ? label[0] : '')}: ${value === null ? 'no supply figure' : value}${delta.sr ? `, ${delta.sr}` : ''}.`),
    );
  }
  // Why an asset has no supply figure: the price and supply sources that did not fully answer.
  function missingWhy(k) {
    const bad = sourcesNow().filter((x) => (x.s.kind === 'price' || x.s.kind === 'supply') && x.status !== 'ok' && x.status !== 'skipped');
    return bad.length ? bad.map((x) => `${x.s.label}: ${humanMsg(x.s.message) || SRC_STATUS[x.status][2]}`).join('\n') : `No supply or price for ${k} in this snapshot.`;
  }
  function peakText(ath, ddPct, fmt, end, oz) {
    if (!ath || !ath.date) return null;
    if (ath.date >= end) return 'Record high today';
    if (!isNum(ddPct)) return null;
    return `${Math.abs(ddPct).toFixed(1)}% below ${md(ath.date)} peak${oz ? ` (${fmtOz(ath.value)})` : ''}`;
  }

  // 5. Briefing (§3.5) and the finding line + evidence panel (§3.9)
  // Generated text: the first figure in <b> (a day of the month after a month name is a date, not a
  // figure: "since Jul 7, $690M" bolds $690M); every signed figure kept on one line with its sign.
  const MONTH_BEFORE = new RegExp(`\\b(?:${MONTHS.join('|')})\\s$`);
  function boldFirstNumber(text, bold = true) {
    const out = [];
    const re = /[−+-]?\$?\d[\d.,]*(?:[%KMBT]|\s?(?:oz|pp)\b)?/g;
    let last = 0;
    let m;
    let first = bold;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const date = MONTH_BEFORE.test(text.slice(Math.max(0, m.index - 4), m.index));
      out.push(first && !date ? h('b', { class: 'nowrap' }, m[0]) : nw(m[0]));
      if (!date) first = false;
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  const seenDot = (id) => (id && state.seenBefore && !state.seenBefore.has(id) ? h('span', { class: 'seen-dot', title: null }, sr('new since your last visit')) : null);
  const lensLabel = (id) => (LENSES.find((l) => l.id === id) || {}).short || (LENSES.find((l) => l.id === id) || {}).label || 'Supply';
  const lensLink = (lens, focus, fid) => h('a', { class: 'lens-link', href: hrefFor({ lens, focus, fid }), 'data-lens': lens, 'data-focus': focus || '', 'data-f': fid || '' }, `${lensLabel(lens)} ›`);
  // Link targets always carry lens= (the URL bar omits the default; a link states where it goes).
  function hrefFor({ lens, focus, fid }) {
    const q = buildQuery({ ...state, lens: lens || state.lens, focus: focus || null });
    const l = lens || state.lens;
    const withLens = /[?&]lens=/.test(q) ? q : `${q ? q + '&' : '?'}lens=${l}`;
    return root.location.pathname + withLens + (fid ? '#f=' + encodeURIComponent(fid) : '');
  }
  // Steady lines: ✓ only when the line says steady (tone positive); a peg line naming a coin outside the
  // peers' range is a plain line. Fillers (another period, for context) are muted.
  const BULLET_ICON = { event: ['★', 's-ink2', 'Event'], mover: ['→', 's-ink2', 'Move'], filler: ['·', 's-muted', 'For context'] };
  function bulletIcon(b) {
    if (b.kind === 'finding') return b.tier === 'minor' ? ['·', 's-muted', 'Smaller finding'] : TONE_ICON[toneOf(b.tone)];
    if (b.kind === 'steady') return b.tone === 'positive' ? ['✓', 's-good', 'Steady'] : ['·', 's-muted', b.link && b.link.lens === 'peg' ? 'Peg' : 'Supply'];
    return BULLET_ICON[b.kind] || ['→', 's-ink2', 'Move'];
  }
  // A "since" badge that the text already states ("… since Sep 11", "first tracked Jul 7") is left out.
  const sinceBadge = (since, text) => (since && !String(text || '').includes(md(since)) ? h('span', { class: 'since' }, `since ${md(since)}`) : null);
  function renderBrief() {
    const el = $('brief');
    const b = briefingFor();
    if (!b || !b.frames) {
      el.hidden = true;
      el.replaceChildren();
      return;
    }
    el.hidden = false;
    const fr = b.frames[rng().frame];
    if (!fr || !Array.isArray(fr.bullets)) {
      el.replaceChildren(h('p', { class: 'note-line' }, 'No summary for this period.'));
      return;
    }
    const bullets = fr.bullets.filter((x) => x && x.kind !== 'state' && x.text);
    if (!bullets.length) {
      el.replaceChildren();
      return;
    }
    // The full-history period has no summary of its own: the longest one is shown and says so.
    el.replaceChildren(
      h('p', { class: 'eyebrow' }, `${fr.label || ''}${rng().win === 'all' ? ' (longest summary)' : ''}`),
      h('ul', { class: 'blist', id: 'brief-list' }, bullets.map((x, i) => briefRow(x, i))),
    );
  }
  function briefRow(b, i) {
    const key = `b:${rng().frame}:${state.asset}:${i}`;
    const open = state.expanded.has(key);
    const [ic, cls, srw] = bulletIcon(b);
    const link = b.link || {};
    const id = link.insight || (b.refs || [])[0] || null;
    const detailId = 'bd-' + i;
    const li = h('li', { 'data-kind': b.kind });
    const badge = sinceBadge(b.since, b.text);
    const dot = b.kind === 'finding' ? seenDot(id) : null;
    const meta = h('span', { class: 'bmeta' }, badge, dot, link.lens ? lensLink(link.lens, link.focus, link.insight) : null);
    // (narrow screens: the meta sits at the end of the text's last line; --mw reserves its width there)
    const mw = (badge ? badge.textContent.length + 2 : 0) + (link.lens ? lensLabel(link.lens).length + 3 : 0) + (dot ? 2 : 0);
    const btn = h('button', { type: 'button', class: 'btext', 'aria-expanded': String(open), 'aria-controls': detailId, 'data-exp': key }, srw === 'Steady' && /^Steady:/.test(b.text) ? null : sr(srw + ': '), boldFirstNumber(b.text));
    btn.style.setProperty('--mw', mw + 'ch');
    li.append(h('span', { class: 'ico ' + cls, 'aria-hidden': 'true' }, ic), h('div', { class: 'bmain' }, btn, meta));
    const det = h('div', { class: 'bdetail', id: detailId });
    det.hidden = !open;
    if (open) {
      const ref0 = (b.refs || [])[0] || id;
      const i0 = b.kind === 'finding' && ref0 ? ins(ref0) : null;
      const restated = !!(b.values && isNum(b.values.gap));
      // (a restated peg finding's figures are its evidence facts row; the line is not repeated above it)
      if (b.detail && !(i0 && restated)) det.append(h('p', null, b.detail));
      if (i0) det.append(evidencePanel(i0, unitOf(ref0), { skipWhy: b.detail, bullet: b }));
    }
    li.append(det);
    return li;
  }
  // Finding line (briefing excluded): icon, swatch, title button, since badge, seen dot, lens link.
  // Status colour means "the verdict of this scope names it" (§1 principle 2, §3.7 badges): a line is major
  // when its unit is a verdict item, so the verdict, tab badges and lens lists agree in every scope (an
  // all-coins tier alone would colour lens-only units the verdict never names, and miss asset-scope items).
  function namedIds() {
    const out = new Set();
    for (const it of (lastVerdict && lastVerdict.items) || []) {
      if (!it || !it.id) continue;
      out.add(it.id);
      const u = unitOf(it.id);
      if (u) for (const m of [u.lead, ...u.related]) out.add(m.id);
    }
    return out;
  }
  const isMajor = (i, named) => !!i && (named || namedIds()).has(i.id);
  function findingIcon(i) {
    if (roleOf(i) === 'note') return ['i', 'note', 'Data note'];
    const st = stageOf(i);
    if (st === 'watch') return ['○', 's-muted', 'Watching'];
    if (st === 'past') return ['·', 's-muted', 'Earlier'];
    if (isMajor(i)) return TONE_ICON[toneOf(i.polarity)];
    return ['·', 's-muted', 'Smaller finding'];
  }
  function findingLine(unit, ctx = {}) {
    const i = unit.lead;
    const key = `f:${ctx.where || ''}:${i.id}`;
    if (state.fid === i.id && ctx.autoOpen && !state.autoOpened.has(key)) {
      state.autoOpened.add(key);
      state.expanded.add(key);
    }
    const open = state.expanded.has(key);
    const [ic, cls, srw] = findingIcon(i);
    const st = stageOf(i);
    // A unit the briefing states (this scope and period) reads as its bullet: same words, same "since".
    const bl = ctx.where !== 'about' && (st === 'new' || st === 'ongoing') ? bulletFor(unit) : null;
    const title = bl ? bl.text : titleOf(i);
    const since = bl ? bl.since : (i.novelty && i.novelty.since) || null;
    let badge = st === 'past' ? (since ? fmtMonthYear(since) : null) : st === 'watch' || st === 'context' ? null : since ? `since ${md(since)}` : null;
    if (badge && title.includes(badge.replace(/^since /, ''))) badge = null; // the title already states its window
    const lens = lensOfIns(i);
    const li = h('li', { 'data-f': i.id });
    const evId = 'ev-' + (ctx.where || '') + '-' + Math.abs(hashStr(i.id));
    li.append(h('div', { class: 'fline' },
      h('span', { class: 'ico ' + cls, 'aria-hidden': 'true' }, ic),
      h('span', { class: 'ftitle' }, meta(i.asset) ? swatch(colorOf(i.asset)) : null, h('button', { type: 'button', class: 'btext', 'aria-expanded': String(open), 'aria-controls': evId, 'data-exp': key, 'data-f': i.id }, sr(srw + ': '), boldFirstNumber(title, false))),
      h('span', { class: 'fmeta' }, badge ? h('span', { class: 'since' }, badge) : null, seenDot(i.id), lens && lens !== ctx.lens && roleOf(i) !== 'note' ? lensLink(lens, meta(i.asset) ? i.asset : null, i.id) : null),
      (() => {
        const ev = h('div', { class: 'ev', id: evId });
        ev.hidden = !open;
        if (open) ev.append(evidencePanel(i, unit, { bullet: bl, noOpen: !!lens && lens === ctx.lens }));
        return ev;
      })(),
    ));
    return li;
  }
  function hashStr(s) {
    let x = 0;
    for (let k = 0; k < s.length; k++) x = (x * 31 + s.charCodeAt(k)) | 0;
    return x;
  }
  function fmtUnitValue(v, unit) {
    if (!isNum(v)) return '—';
    if (unit === 'usd') return fmtUsd(v, { signed: v < 0 });
    if (unit === 'usdPerDay') return fmtUsd(v) + ' a day';
    if (unit === 'fraction') return `${(v * 100).toFixed(Math.abs(v) < 0.01 ? 2 : 1)}%`;
    if (unit === 'oz') return fmtOz(v);
    if (unit === 'count') return fmtCount(v);
    return String(Number(v.toPrecision(3)));
  }
  function evidencePanel(i, unit, o = {}) {
    const e = i.evidence || {};
    const out = [];
    const ser = e.series && Array.isArray(e.series.values) ? e.series : null;
    const evUnit = e.unit || null;
    // A peg finding the briefing restates on the period: its figures replace the detector's own window
    // (which stays in Method), so one number per period appears (review: 0.40 / 0.37 / 0.25 … for one story).
    const bl = o.bullet && o.bullet.values && isNum(o.bullet.values.gap) ? o.bullet : null;
    const fw = bl ? findingWindow(i) : null;
    const members = unit ? [unit.lead, ...(unit.related || [])].filter(Boolean) : [i];
    const split = bl ? members.find((m) => m.detector === 'peg.regime' && m.facts && m.facts.since) : null;
    if (ser && ser.values.filter(isNum).length > 1) {
      const vals = ser.values.slice(-120);
      const start = addDays(ser.start, ser.values.length - vals.length);
      const dates = datesBetween(start, addDays(start, vals.length - 1));
      const w = fw || parseWindow(e.window, dates[dates.length - 1]);
      const band = w ? [indexIn(dates, w.from), indexIn(dates, w.to)] : null;
      out.push(mini({ n: vals.length, series: [{ values: vals, color: colorOf(i.asset) }], band, dot: true, h: 48, label: bl ? bl.text : titleOf(i), graphic: true }));
      out.push(figTable('ev:' + i.id, () => table({ wrap: 'tall', head: ['Date', 'Value'], rows: dates.map((d, k) => ({ cells: [fmtDate(d), fmtUnitValue(vals[k], evUnit)] })).reverse() })));
    }
    if (bl) {
      const v = bl.values;
      const fr = (briefingFor().frames || {})[rng().frame] || {};
      const label = v.days === 1 ? 'Yesterday' : / since /.test(bl.text) && bl.since ? `Since ${md(bl.since)}` : fr.days === 365 ? 'Last 12 months' : `Last ${fr.days} days`;
      out.push(h('p', null, [`${label}: ${fmtPeg(Math.abs(v.gap), { unsigned: true })}`, isNum(v.before) && split ? `Before ${md(split.facts.since)}: ${fmtPeg(v.before, { unsigned: true })}` : null, isNum(v.peerGap) ? `Peers: ≤${fmtPeg(Math.ceil(v.peerGap * 1e4 - 0.1) / 1e4, { unsigned: true })}` : null].filter(Boolean).join(' · ')));
    } else {
      if (e.valueLabel && e.valueText) out.push(h('p', null, `${e.valueLabel}: ${e.valueText}${e.baselineLabel && e.baselineText ? ` · ${e.baselineLabel}: ${e.baselineText}` : ''}`));
      if (i.why && i.why !== o.skipWhy) out.push(h('p', null, i.why));
    }
    const s = i.surprise || {};
    if (isNum(s.p) && s.p > 0) {
      const tail = s.underpowered ? 'Too little history to be sure.' : s.notable ? `It still stands out after ${fmtCount(s.m || 1)} similar checks.` : `Not rare enough to flag after ${fmtCount(s.m || 1)} similar checks.`;
      out.push(h('p', null, `A result this clear happens by chance about 1 in ${fmtCount(Math.max(1, Math.round(1 / s.p)))} times. ${tail}`));
    }
    // A USD coin's peg finding concerns every coin in circulation: "Covers all $26M of {coin}" (its share of
    // the total would print a second 0.4x% figure beside the peg gap).
    const pegUsd = i.dimension === 'peg' && isUsd(meta(i.asset)) && isNum(i.materialityUsd);
    if (pegUsd) out.push(h('p', null, `Covers all ${fmtUsd(i.materialityUsd)} of ${i.asset}.`));
    else if (isNum(i.materialityUsd)) out.push(h('p', null, `Involves ${fmtUsd(i.materialityUsd)}${isNum(i.materialityShare) ? ` (${fmtPortion(i.materialityShare)} of ${aggKey() || 'the total'})` : ''}.`));
    let rel = unit && unit.related ? unit.related.filter((r) => r.id !== i.id) : [];
    if (unit && unit.lead && unit.lead.id !== i.id) rel.unshift(unit.lead);
    if (bl) rel = rel.filter((r) => r.dimension !== 'peg'); // (their gaps are the facts row)
    for (const r of rel.slice(0, 3)) out.push(h('p', null, `Also: ${titleOf(r)}`));
    const lens = lensOfIns(i);
    out.push(h('div', { class: 'acts' },
      lens && !o.noOpen ? h('a', { class: 'btn', href: hrefFor({ lens, focus: meta(i.asset) ? i.asset : null, fid: i.id }), 'data-lens': lens, 'data-focus': meta(i.asset) ? i.asset : '', 'data-f': i.id }, `Open ${lensLabel(lens)} ›`) : null,
      h('button', { type: 'button', class: 'btn', 'data-action': 'copy', 'data-f': i.id }, 'Copy link'),
    ));
    out.push(methodBlock(i));
    return h('div', null, out);
  }
  function figTable(key, build) {
    const holder = h('div');
    holder.hidden = true;
    let built = false;
    const btn = h('button', { type: 'button', class: 'linkbtn', 'aria-pressed': 'false', onclick: () => {
      if (!built) {
        built = true;
        holder.append(build());
      }
      holder.hidden = !holder.hidden;
      btn.setAttribute('aria-pressed', String(!holder.hidden));
      btn.textContent = holder.hidden ? 'Table' : 'Hide table';
    } }, 'Table');
    return h('div', null, btn, holder);
  }
  function methodBlock(i) {
    const e = i.evidence || {};
    const s = i.surprise || {};
    const rows = [
      ['Full finding', i.headline],
      ['How it was tested', [i.detail, e.stat].filter(Boolean).join(' ')],
      ['Chance in its own history', isNum(s.p) ? `${Number((s.p * 100).toPrecision(2))}%` : null],
      [`Expected by chance across ${fmtCount(s.m || 1)} checks`, isNum(s.E) ? `${Number(s.E.toPrecision(2))} (flagged when under 1)` : null],
      ['Compared with', isNum(e.n) ? `${fmtCount(e.n)} periods${isNum(e.nEff) ? `, ${fmtCount(e.nEff)} independent` : ''}` : null],
      ['Other windows tested', (e.otherWindows || []).length ? e.otherWindows.map((w) => `${w.window}: ${isNum(w.p) ? Number((w.p * 100).toPrecision(2)) + '%' : '—'}`).join(', ') : null],
      ['Counts if over', isNum(i.materialityFloorUsd) ? fmtUsd(i.materialityFloorUsd) : null],
      ['As of', i.asOf ? fmtDate(String(i.asOf).slice(0, 10)) : null],
    ].filter((r) => r[1]);
    return h('details', null, h('summary', null, 'Method'), h('dl', null, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
  }

  // 6. Cards (§3.6)
  const dataNoteFor = (k) => {
    const floor = floorOf(k);
    for (const [, x] of IX.byId) {
      const i = x.i;
      if (i.asset !== k || roleOf(i) !== 'note') continue;
      const st = stageOf(i);
      if (i.detector === 'dq.cross_source' && isNum(i.materialityUsd) && isNum(floor) && i.materialityUsd >= floor) return i;
      if (/^dq\.(freshness|price_sanity|frozen)$/.test(i.detector) && (st === 'new' || st === 'ongoing')) return i;
    }
    return null;
  };
  function mainDriver(k, w) {
    const rows = ((attrWin(w) || {}).chains || []).filter((x) => x.asset === k && x.chain !== OTHER && isNum(x.deltaUsd) && x.deltaUsd !== 0);
    rows.sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));
    return rows[0] || null;
  }
  function pegFor(d) {
    const pr = period();
    return pegStats(d.data.series && d.data.series.price, pr.from, pr.to);
  }
  function renderCards() {
    const el = $('cards');
    const end = endIso();
    const v = lastVerdict || { items: [] };
    const cards = [];
    let group = null;
    const sparks = [];
    if (state.asset === 'all') {
      const list = bySupply(visibleAssets()).filter((d) => d.status !== 'dead' && d.data);
      const cs = cardSparks(list.map((d) => (isGold(d) ? d.data.series.supply : d.data.series.supplyUsd) || null), end);
      list.forEach((d, k) => cards.push(assetCard(d, v, cs, k, sparks)));
      const dates = cs.dates;
      const leg = legacyList();
      if (!state.legacy && leg.length) cards.push(h('div', { class: 'acard ghost legacy-ghost' }, h('button', { type: 'button', class: 'acard-body', 'data-action': 'legacy' }, h('span', { class: 'c-head' }, `+${leg.length} legacy`), leg.map((d) => h('span', { class: 'c-f' }, `${d.key} ${fmtUsd(supplyUsdOf(d))}`)))));
      group = { dates, sparks };
    } else {
      const d = meta(state.asset);
      const cc = chainCards(d, sparks);
      cards.push(...cc.cards);
      group = cc.dates ? { dates: cc.dates, sparks } : null;
    }
    el.replaceChildren(...cards);
    // Synced crosshair: each card's value at the hovered day, the day in place of the (period) delta line.
    if (group && group.sparks.length) {
      const n = group.dates.length;
      const hg = hoverGroup(n, (i) => {
        for (const s of group.sparks) {
          if (s.valEl) s.valEl.textContent = s.fmt(s.vals[i]);
          if (s.deltaEl) {
            s.deltaEl.classList.add('hovering');
            s.deltaEl.replaceChildren(md(group.dates[i]));
          }
        }
      }, () => {
        for (const s of group.sparks) {
          if (s.valEl) s.valEl.textContent = s.text;
          if (s.deltaEl) {
            s.deltaEl.classList.remove('hovering');
            s.deltaEl.replaceChildren(...s.deltaKids);
          }
        }
      });
      group.sparks.forEach((s) => hg.attach(s.svg));
    }
  }
  function assetCard(d, v, cs, k, sparks) {
    const r = rng();
    const c = d.data.current || {};
    const gold = isGold(d);
    const series = gold ? d.data.series.supply : d.data.series.supplyUsd;
    const ch = gold ? changeFor(c.nativeChange, series, r, endIso()) : changeFor(c.change, series, r, endIso());
    const dl = deltaLine(ch, gold ? 'oz' : 'usd', r);
    const has = gold ? isNum(c.supply) : isNum(c.supplyUsd);
    const valueText = gold ? fmtOz(c.supply) : fmtUsd(c.supplyUsd);
    if (!has) {
      // No figure in this snapshot: one muted line that says so (and why, in its tooltip), not "— / — / —".
      return h('div', { class: 'acard', role: 'group', 'aria-label': d.key, 'data-card': d.key },
        h('button', { type: 'button', class: 'acard-body', 'data-asset': d.key, 'data-tip': missingWhy(d.key), 'aria-label': `${d.key}: no supply figure in this snapshot. Show only ${d.key}.` },
          h('span', { class: 'c-head' }, swatch(colorOf(d.key)), d.key, d.status !== 'active' ? h('span', { class: 'badge' }, 'legacy') : null),
          h('span', { class: 'c-f muted c-none' }, 'No supply figure in this snapshot')));
    }
    const svg = series ? mini({ n: cs.dates.length, series: [{ values: cs.rows[k], color: colorOf(d.key), from: cs.from }], graphic: true }) : null;
    const valEl = h('span', { class: 'c-val' }, valueText);
    const deltaEl = h('span', { class: 'c-delta' }, dl.node || '—');
    if (svg) sparks.push({ svg, vals: cs.rows[k], valEl, deltaEl, deltaKids: [...deltaEl.childNodes], text: valueText, fmt: gold ? (x) => fmtOz(x) : (x) => fmtUsd(x) });
    let f1 = null;
    let f2 = null;
    let srExtra = '';
    if (gold) {
      f1 = isNum(c.supplyUsd) ? `worth ${fmtUsd(c.supplyUsd)}` : null;
      const gp = r.win !== 'all' ? goldPriceChange(c.change && c.change[r.win], c.nativeChange && c.nativeChange[r.win]) : null;
      f2 = isNum(gp) ? (narrow() ? `gold ${fmtPct(gp)}` : `gold price ${fmtPct(gp)}`) : null;
    } else {
      const md0 = mainDriver(d.key, r.win);
      if (md0) {
        f1 = `${md0.chain} ${fmtUsd(md0.deltaUsd, { signed: true })}`;
        srExtra += `; most moved on ${md0.chain}`;
      }
      const pg = pegFor(d);
      if (pg) {
        f2 = h('span', { 'data-peg': '', 'data-value': pg.avg, 'data-tip': `Average distance from $1 over ${periodWords()}, daily prices. Latest quote ${isNum(c.price) ? c.price.toFixed(5) : '—'} at ${fmtHM(c.pegAsOf)} UTC.` }, `peg ${fmtPeg(pg.avg)}`);
        srExtra += `; peg ${pegWords(pg.avg)}`;
      }
    }
    const items = (v.items || []).filter((it) => it.asset === d.key);
    const note = dataNoteFor(d.key);
    const tools = [];
    if (items.length) {
      const top = items[0];
      const [ic] = TONE_ICON[toneOf(top.tone)];
      tools.push(h('button', { type: 'button', class: 'flag t-' + toneOf(top.tone), 'data-flag': '', 'data-lens': top.lens, 'data-focus': d.key, 'data-f': top.id || '', 'aria-label': `${TONE_ICON[toneOf(top.tone)][2]}: ${d.key} ${top.area}` }, `${ic} ${top.area}${items.length > 1 ? ` +${items.length - 1}` : ''}`));
    }
    if (note) tools.push(h('button', { type: 'button', class: 'note-btn', 'data-action': 'notes', 'data-tip': titleOf(note), 'aria-label': `Data note: ${titleOf(note)}` }, h('span', { 'aria-hidden': 'true' }, 'i')));
    const lateM = lateMark(['supply']);
    return h('div', { class: 'acard', role: 'group', 'aria-label': d.key, 'data-card': d.key },
      h('button', { type: 'button', class: 'acard-body', 'data-asset': d.key, 'data-tip': d.name || null, 'aria-label': `${d.key}: ${valueText}${dl.sr ? `, ${dl.sr}` : ''}${srExtra}. Show only ${d.key}.` },
        h('span', { class: 'c-head' }, swatch(colorOf(d.key)), d.key, d.status !== 'active' ? h('span', { class: 'badge' }, 'legacy') : null, lateM),
        valEl,
        deltaEl,
        svg,
        f1 ? h('span', { class: 'c-f' }, f1) : null,
        f2 ? h('span', { class: 'c-f' }, f2) : null),
      tools.length ? h('div', { class: 'acard-tools' }, tools) : null);
  }
  // Holders compactly on cards ("21.5K holders"; the tables keep the exact count).
  const fmtCountShort = (n) => (!isNum(n) ? '—' : n >= 9995 ? `${(n / 1e3).toFixed(n >= 99950 ? 0 : 1)}K` : fmtCount(n));
  function chainChange(c, r, end) {
    if (r.win !== 'all' && c.change && c.change[r.win]) return c.change[r.win];
    return changeFromCompact(c.series, r.days, end);
  }
  function chainCards(d, sparks) {
    const r = rng();
    const end = endIso();
    const a = d.data;
    const pr = period();
    const holders = new Map((a.onchain || []).filter((x) => x && isNum(x.holders)).map((x) => [x.chain, x.holders]));
    const chains = (a.chains || []).filter((c) => isNum(c.currentUsd) && c.currentUsd > 0).sort((x, y) => y.currentUsd - x.currentUsd);
    if (chains.length && !isGold(d)) {
      // Chains under the coin's floor (a typical day's flow; $1K without one) fold into "Other n chains".
      const fl = isNum(floorOf(d.key)) ? floorOf(d.key) : 1000;
      const big = chains.filter((c) => c.currentUsd >= fl);
      const top = (big.length ? big : chains).slice(0, 4);
      const rest = chains.filter((c) => !top.includes(c));
      const cs = cardSparks(top.map((c) => c.series || null), end);
      const out = top.map((c, k) => {
        const ch = chainChange(c, r, end);
        const dl = deltaLine(ch, 'usd', r);
        const svg = c.series ? mini({ n: cs.dates.length, series: [{ values: cs.rows[k], color: colorOf(d.key), from: cs.from }], graphic: true }) : null;
        const valEl = h('span', { class: 'c-val' }, fmtUsd(c.currentUsd));
        const deltaEl = h('span', { class: 'c-delta' }, dl.node || '—');
        if (svg) sparks.push({ svg, vals: cs.rows[k], valEl, deltaEl, deltaKids: [...deltaEl.childNodes], text: fmtUsd(c.currentUsd), fmt: (x) => fmtUsd(x) });
        const isNew = c.first && pr.from && c.first > pr.from;
        const tag = c.status === 'tracking_ended' ? 'tracking ended' : isNew ? 'new' : null;
        const foot = `${fmtPortion(c.share)} of ${d.key}${holders.has(c.chain) ? ` · ${fmtCountShort(holders.get(c.chain))} holders` : ''}`;
        return h('div', { class: 'acard', role: 'group', 'aria-label': c.chain, 'data-card': c.chain },
          h('button', { type: 'button', class: 'acard-body', 'data-lens': 'chains', 'data-focus': d.key, 'aria-label': `${c.chain}: ${fmtUsd(c.currentUsd)}${dl.sr ? `, ${dl.sr}` : ''}. Open Chains.` },
            h('span', { class: 'c-head' }, c.chain, tag ? h('span', { class: 'badge' }, tag) : null),
            valEl, deltaEl, svg,
            h('span', { class: 'c-f wrap', 'data-tip': `${fmtPortion(c.share)} of ${d.key}${holders.has(c.chain) ? ` · ${fmtCount(holders.get(c.chain))} holders` : ''}` }, foot)));
      });
      if (rest.length) out.push(h('div', { class: 'acard ghost', role: 'group', 'aria-label': `Other ${rest.length} chains` }, h('button', { type: 'button', class: 'acard-body', 'data-lens': 'chains', 'data-focus': d.key }, h('span', { class: 'c-head' }, `Other ${rest.length} chains`), h('span', { class: 'c-val' }, fmtUsd(rest.reduce((s, c) => s + c.currentUsd, 0))))));
      return { cards: out, dates: cs.dates };
    }
    const oc = (a.onchain || []).filter((x) => x && isNum(x.totalSupply));
    if (oc.length) {
      return { cards: oc.sort((x, y) => y.totalSupply - x.totalSupply).map((x) => h('div', { class: 'acard', role: 'group', 'aria-label': x.chain, 'data-card': x.chain },
        h('button', { type: 'button', class: 'acard-body', 'data-lens': 'chains', 'data-focus': d.key },
          h('span', { class: 'c-head' }, x.chain),
          h('span', { class: 'c-val' }, isGold(d) ? fmtOz(x.totalSupply) : fmtUsd(x.totalSupply)),
          isNum(x.holders) ? h('span', { class: 'c-f' }, `${fmtCountShort(x.holders)} holders`) : null,
          h('span', { class: 'c-f muted', 'data-tip': 'Current on-chain read; no daily history for this chain.' }, 'no history yet')))) };
    }
    return { cards: [h('p', { class: 'note-line wide' }, `No per-chain data for ${d.key}.`)] };
  }

  // 7. Lens tabs (§3.7) and the "Unusual here" list
  function lensDisabled(id) {
    if (state.asset === 'all') return null;
    const d = meta(state.asset);
    if (id === 'market' && !isUsd(d)) return `No USD stablecoin market for ${state.asset}`;
    if (id === 'income' && !econAssets().includes(state.asset)) return `Not modelled for ${state.asset}`;
    return null;
  }
  function econAssets() {
    const e = P().economics;
    if (e && Array.isArray(e.assets)) return e.assets;
    const tier = ((P().discovery && P().discovery.tiers) || []).find((t) => /fee/i.test(String(t.id || '')));
    return (tier && tier.found) || [];
  }
  // Eligible units for a lens: new/ongoing, placed in lenses, in scope, about a shown asset.
  function lensUnits(lens) {
    const out = [];
    for (const u of IX.units) {
      const members = [u.lead, ...u.related].filter((i) => {
        const st = stageOf(i);
        return (st === 'new' || st === 'ongoing') && ['headline', 'evidence', 'lens'].includes(roleOf(i)) && lensOfIns(i) === lens && insightMatches(i, state.asset, floorsAll()) && isActiveOrShown(i.asset);
      });
      if (!members.length) continue;
      const ru = relead({ lead: members[0], related: [u.lead, ...u.related].filter((i) => i !== members[0]), list: u.list });
      out.push(ru.lead === members[0] || members.includes(ru.lead) ? ru : { lead: members[0], related: [u.lead, ...u.related].filter((i) => i !== members[0]), list: u.list });
    }
    const named = namedIds();
    const major = (u) => (isMajor(u.lead, named) ? 0 : 1);
    return out.map((u, k) => ({ u, k })).sort((a, b) => major(a.u) - major(b.u) || a.k - b.k).map((x) => x.u);
  }
  function renderTabs() {
    const v = lastVerdict || { items: [] };
    if (lensDisabled(state.lens)) {
      state.lens = 'supply';
      syncUrl();
    }
    const tabs = LENSES.map((l) => {
      const dis = lensDisabled(l.id);
      const its = (v.items || []).filter((it) => it.lens === l.id);
      const worst = its.slice().sort((a, b) => POL_RANK[toneOf(a.tone)] - POL_RANK[toneOf(b.tone)])[0];
      const minor = !worst ? lensUnits(l.id).filter((u) => !isMajor(u.lead)).length : 0;
      const sel = state.lens === l.id;
      return h('button', { type: 'button', role: 'tab', class: 'tab', id: 'tab-' + l.id, 'aria-selected': String(sel), 'aria-controls': 'panel', tabindex: sel ? '0' : '-1', 'data-lens': l.id, 'data-tab': '1', 'aria-disabled': dis ? 'true' : null, 'data-tip': dis },
        l.label,
        worst ? h('span', { class: 'tb t-' + toneOf(worst.tone), 'aria-hidden': 'true' }, TONE_ICON[toneOf(worst.tone)][0]) : minor ? h('span', { class: 'tb s-muted', 'aria-hidden': 'true' }, '•') : null,
        worst ? sr(`, ${its.length} unusual`) : minor ? sr(`, ${plural(minor, 'smaller finding')}`) : null);
    });
    $('tabs').replaceChildren(...tabs);
    $('panel').setAttribute('aria-labelledby', 'tab-' + state.lens);
  }
  function unusualHere(lens) {
    const units = lensUnits(lens);
    if (!units.length) return null;
    const key = 'uh:' + lens;
    const more = state.more.has(key);
    const shown = more ? units : units.slice(0, 3);
    // "Unusual here" only over a finding the verdict names; otherwise the list is of smaller findings.
    const named = namedIds();
    return h('div', { class: 'unusual-here' }, h('h3', null, shown.some((u) => isMajor(u.lead, named)) ? 'Unusual here' : 'Smaller findings'),
      h('ul', { class: 'flist' }, shown.map((u) => findingLine(u, { where: 'lens', lens, autoOpen: true }))),
      units.length > 3 ? h('button', { type: 'button', class: 'linkbtn more-btn', 'data-more': key, 'aria-expanded': String(more) }, more ? 'Show fewer' : `Show ${units.length - 3} more`) : null);
  }
  function renderPanel() {
    const panel = $('panel');
    destroyCharts(panel);
    const lens = state.lens;
    const kids = [];
    if (state.focus && meta(state.focus)) {
      const i = state.fid ? ins(state.fid) : null;
      const since = i ? unitSince(i) : null;
      kids.push(h('div', { class: 'focus-chip' }, swatch(colorOf(state.focus)), `Showing ${state.focus}${since ? ` since ${md(since)}` : ''}`, h('button', { type: 'button', 'data-action': 'clear-focus', 'aria-label': 'Clear highlight' }, '✕')));
    }
    kids.push(h('h2', { class: 'sr-only lens-h', id: 'lens-h', tabindex: '-1' }, lensLabel(lens)));
    if (!hasChart()) kids.push(h('p', { class: 'note-line' }, 'Charts unavailable; showing tables.'));
    let body;
    try {
      body = LENS_RENDER[lens]();
    } catch (e) {
      console.error(`lens ${lens} failed`, e);
      body = h('p', { class: 'fail' }, 'Not in this snapshot.');
    }
    kids.push(body);
    try {
      kids.push(unusualHere(lens));
    } catch (e) {
      console.error('unusual here failed', e);
    }
    panel.replaceChildren(...[kids].flat(Infinity).filter(Boolean));
  }
  const grid2 = (...figs) => { const f = figs.filter(Boolean); return h('div', { class: 'lens-grid' + (f.length === 1 ? ' one' : '') }, f); };
  const notIn = () => h('p', { class: 'fail' }, 'Not in this snapshot.');

  // ----- Supply lens -----
  function movesBars(m, asset, keyLabel) {
    const vals = [...m.rows.map((x) => x.deltaUsd), m.other, m.unattributed, m.net].filter(isNum);
    const max = Math.max(1, ...vals.map(Math.abs));
    const bar = (v, cls) => {
      const tr = h('span', { class: 'track' }, h('span', { class: 'axis0' }));
      tr.firstChild.style.left = '50%';
      const f = h('span', { class: 'fill ' + (cls || (v >= 0 ? 'pos' : 'neg')) });
      const w = (Math.abs(v) / max) * 50;
      f.style.width = w + '%';
      f.style.left = v >= 0 ? '50%' : 50 - w + '%';
      if (cls === 'net') f.style.borderRadius = v >= 0 ? '0 4px 4px 0' : '4px 0 0 4px';
      tr.append(f);
      return tr;
    };
    const rows = m.rows.map((x) => {
      const pct = x.prevUsd > 0 ? fmtPct((100 * x.deltaUsd) / x.prevUsd) : null;
      const tipText = `${x.asset} on ${x.chain}: ${fmtUsd(x.prevUsd)} → ${fmtUsd(x.currUsd)} (${fmtUsd(x.deltaUsd, { signed: true })}${pct ? `, ${pct}` : ''})`;
      return h('button', { type: 'button', class: 'brow', 'data-move': 'row', 'data-usd': x.deltaUsd, 'data-lens': 'chains', 'data-focus': x.asset, 'data-tip': tipText, 'aria-label': tipText },
        h('span', { class: 'bl' }, asset ? null : swatch(lensColor(x.asset)), h('span', null, asset ? x.chain : `${x.asset} · ${x.chain}`)), bar(x.deltaUsd), h('span', { class: 'bv' }, fmtUsd(x.deltaUsd, { signed: true })));
    });
    if (Math.round(m.other) !== 0) rows.push(h('div', { class: 'brow', 'data-move': 'other', 'data-usd': m.other }, h('span', { class: 'bl' }, h('span', null, 'Other')), bar(m.other), h('span', { class: 'bv' }, fmtUsd(m.other, { signed: true }))));
    if (m.unattributed) rows.push(h('div', { class: 'brow', 'data-move': 'unattributed', 'data-usd': m.unattributed }, h('span', { class: 'bl' }, h('span', null, 'Unattributed')), bar(m.unattributed), h('span', { class: 'bv' }, fmtUsd(m.unattributed, { signed: true }))));
    rows.push(h('div', { class: 'brow net', 'data-move': 'net', 'data-usd': m.net }, h('span', { class: 'bl' }, h('span', null, 'Net')), bar(m.net, 'net'), h('span', { class: 'bv' }, fmtUsd(m.net, { signed: true }))));
    void keyLabel;
    return h('div', { class: 'bars', 'data-graphic': 'moves' }, rows);
  }
  function movesTitle(m, subject, asset) {
    const pw = periodWords();
    if (Math.round(m.net) === 0) return `${subject} unchanged over ${pw}`;
    const top = m.rows[0];
    const where = top ? (asset ? top.chain : `${top.asset} on ${top.chain}`) : null;
    if (!top) return `${subject} ${fmtUsd(m.net, { signed: true })} over ${pw}`;
    return Math.sign(top.deltaUsd) === Math.sign(m.net) ? `${subject} ${fmtUsd(m.net, { signed: true })} over ${pw}, led by ${where} (${fmtUsd(top.deltaUsd, { signed: true })})` : `${subject} ${fmtUsd(m.net, { signed: true })} over ${pw}; largest move ${where} (${fmtUsd(top.deltaUsd, { signed: true })})`;
  }
  function movesFigure(asset) {
    const r = rng();
    const w = attrWin(r.win);
    const subject = asset || aggKey() || 'Total';
    if (!P().attribution) return figure({ key: 'moves', title: 'Where supply moved', body: () => notIn() });
    if (!w) return figure({ key: 'moves', title: 'Where supply moved', body: () => h('p', { class: 'note-line' }, 'No chain breakdown for this period.') });
    const m = movesModel(w, asset);
    if (!m) return figure({ key: 'moves', title: 'Where supply moved', body: () => h('p', { class: 'note-line' }, 'No chain breakdown for this period.') });
    // A leg under $1K prints as "<$1K" (never "In +$1" beside "Out −$2.0M").
    const leg = (x) => (x !== 0 && Math.abs(x) < 1000 ? '<$1K' : fmtUsd(x, { signed: true }));
    const strip = h('p', { class: 'strip', 'data-strip': '', 'data-in': m.inSum, 'data-out': m.outSum, 'data-net': m.net }, 'In ', h('b', null, nw(leg(m.inSum))), ' · Out ', h('b', null, nw(leg(m.outSum))), ' · Net ', h('b', null, nw(leg(m.net))));
    const tableA = () => {
      const rows = [];
      const assets = (w.assets || []).filter((x) => !asset || x.asset === asset);
      for (const a of assets) {
        for (const x of w.chains.filter((c) => c.asset === a.asset)) rows.push({ cells: [x.asset, x.chain, fmtUsd(x.prevUsd), fmtUsd(x.currUsd), fmtUsd(x.deltaUsd, { signed: true }), x.prevUsd > 0 ? fmtPct((100 * x.deltaUsd) / x.prevUsd) : '—'] });
        rows.push({ cls: 'sub', cells: [a.asset, 'All chains', fmtUsd(a.prevUsd), fmtUsd(a.currUsd), fmtUsd(a.deltaUsd, { signed: true }), a.prevUsd > 0 ? fmtPct((100 * a.deltaUsd) / a.prevUsd) : '—'] });
      }
      rows.push({ cls: 'tot', cells: ['Net', '', '', '', fmtUsd(m.net, { signed: true }), ''] });
      return h('div', null, table({ wrap: 'tall', caption: `${fmtDate(w.from)} to ${fmtDate(w.to)}`, head: ['Asset', { t: 'Chain', l: true }, 'Start', 'End', 'Change', '%'], rows }), !asset ? h('p', { class: 'note-line' }, `Chain moves cover ${aggKey() || 'USD'} stablecoins.`) : null);
    };
    return figure({
      key: 'moves',
      title: movesTitle(m, subject, asset),
      table: tableA,
      body: () => (m.empty && Math.round(m.net) === 0 ? h('p', { class: 'note-line' }, `Nothing moved between chains over ${periodWords()}.`) : h('div', null, strip, movesBars(m, asset))),
    });
  }
  function supplyAreaFigure(keys, title, single) {
    const end = endIso();
    const sers = keys.map((k) => assetData(k).series.supplyUsd);
    const first = sers.map((c) => compactFirst(c)).filter(Boolean).map((x) => x.date).sort()[0];
    const start = spanStart(end) || first || end;
    let al = alignCompacts(sers, start, end, single ? null : 0);
    const full = al;
    if (!spanOf(rng())) al = thin(al.dates, al.rows, Math.max(400, Math.min(1100, root.innerWidth || 1100)));
    const labels = al.dates;
    const spanDays = daysBetween(labels[0], end);
    const datasets = keys.map((k, i) => lineDs(k, al.rows[i], lensColor(k), { fill: single ? 'origin' : i ? '-1' : 'origin', backgroundColor: alpha(lensColor(k), single ? 0.12 : 0.1), pointStyle: 'rect' }));
    const ath = single ? (assetData(keys[0]).current || {}).ath : null;
    const sub = ath && ath.date >= labels[0] ? `Peak ${fmtUsd(ath.value)} · ${md(ath.date)}` : null;
    const tableB = () => {
      const weekly = full.dates.length > 92;
      const idx = full.dates.map((_, i) => full.dates.length - 1 - i).filter((i, j) => !weekly || j % 7 === 0);
      const tot = (i) => full.rows.reduce((s, r) => s + (isNum(r[i]) ? r[i] : 0), 0);
      const step = weekly ? 7 : 1;
      return table({ wrap: 'tall', caption: weekly ? 'Weekly, newest first.' : 'Newest first.', head: ['Date', ...(single ? ['Supply'] : keys), ...(single ? [] : ['Total']), weekly ? 'Weekly change' : 'Daily change'],
        rows: idx.map((i) => ({ cells: [fmtDate(full.dates[i]), ...(single ? [fmtUsd(full.rows[0][i])] : full.rows.map((r) => fmtUsd(r[i]))), ...(single ? [] : [fmtUsd(tot(i))]), i - step >= 0 ? fmtUsd(tot(i) - tot(i - step), { signed: true }) : '—'] })) });
    };
    return figure({
      key: 'supply-area',
      title,
      sub,
      label: `${title}: ${keys.join(', ')}`,
      legend: keys.length > 1 ? keys.map((k) => ({ label: k, color: lensColor(k) })) : null,
      config: () => lineConfig({ labels, datasets, yFmt: (v) => fmtUsd(v), spanDays, stacked: !single, endLabel: keys.length > 1 ? { fmt: (v) => fmtUsd(v) } : false, yExtra: { beginAtZero: true }, band: periodBands(labels) }),
      table: tableB,
    });
  }
  function goldLineFigure(d, key, title, c, fmt, sub) {
    const end = endIso();
    const first = compactFirst(c);
    const start = spanStart(end) || (first && first.date) || end;
    let al = alignCompacts([c], start, end);
    const full = al;
    if (!spanOf(rng())) al = thin(al.dates, al.rows, 900);
    return figure({
      key, title, sub,
      config: () => lineConfig({ labels: al.dates, datasets: [lineDs(d.key, al.rows[0], colorOf(d.key), { fill: 'origin', backgroundColor: alpha(colorOf(d.key), 0.1) })], yFmt: fmt, spanDays: daysBetween(al.dates[0], end), band: periodBands(al.dates) }),
      table: () => table({ wrap: 'tall', head: ['Date', title.split(' · ')[0]], rows: full.dates.map((dt, i) => ({ cells: [fmtDate(dt), fmt(full.rows[0][i])] })).reverse().filter((_, j) => full.dates.length <= 92 || j % 7 === 0) }),
    });
  }
  const spanText = () => (spanOf(rng()) ? `${spanOf(rng()) === 365 ? '12 months' : spanOf(rng()) + ' days'}` : 'all time');
  function lensSupply() {
    const p = P();
    if (state.asset === 'all') {
      // Card order (largest first): the largest coin is the bottom band, and the legend reads as the cards.
      const order = bySupply(discovered().filter((d) => d.data)).map((d) => d.key);
      const keys = (p.totals.usd.assets || []).filter((k) => assetData(k) && assetData(k).series && assetData(k).series.supplyUsd);
      keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      return grid2(movesFigure(null), keys.length ? supplyAreaFigure(keys, `Supply by coin · ${spanText()}`, false) : null);
    }
    const d = meta(state.asset);
    if (isGold(d)) {
      const s = d.data.series || {};
      return grid2(
        s.supply ? goldLineFigure(d, 'gold-oz', `${d.key} supply in ounces · ${spanText()}`, s.supply, (v) => fmtOz(v)) : notIn(),
        s.supplyUsd ? goldLineFigure(d, 'gold-usd', `Value in USD · ${spanText()}`, s.supplyUsd, (v) => fmtUsd(v), 'moves with gold price') : null,
      );
    }
    return grid2(movesFigure(d.key), d.data.series && d.data.series.supplyUsd ? supplyAreaFigure([d.key], `${d.key} supply · ${spanText()}`, true) : notIn());
  }

  // ----- Chains lens -----
  function chainTotals(keys) {
    const by = new Map();
    for (const k of keys) for (const c of assetData(k).chains || []) {
      if (!isNum(c.currentUsd) || c.currentUsd <= 0) continue;
      const g = by.get(c.chain) || { chain: c.chain, total: 0, parts: {}, series: [] };
      g.total += c.currentUsd;
      g.parts[k] = (g.parts[k] || 0) + c.currentUsd;
      if (c.series) g.series.push({ k, c: c.series });
      by.set(c.chain, g);
    }
    return [...by.values()].sort((a, b) => b.total - a.total);
  }
  function stackBars(rows, keys, fmt) {
    const max = Math.max(1, ...rows.map((r) => r.total));
    return h('div', { class: 'bars', 'data-graphic': 'bars' }, rows.map((r) => {
      const tr = h('span', { class: 'track stack' });
      for (const k of keys) {
        if (!r.parts[k]) continue;
        const s = h('span', { class: 'seg-fill', color: lensColor(k) });
        s.style.width = (r.parts[k] / max) * 100 + '%';
        tr.append(s);
      }
      return h('div', { class: 'brow', 'data-tip': keys.filter((k) => r.parts[k]).map((k) => `${k} ${fmt(r.parts[k])}`).join('\n') }, h('span', { class: 'bl' }, h('span', null, r.chain)), tr, h('span', { class: 'bv' }, fmt(r.total)));
    }));
  }
  function chainMultiples(groups, keys) {
    const end = endIso();
    const all = groups.flatMap((g) => g.series.map((s) => s.c));
    const first = all.map((c) => compactFirst(c)).filter(Boolean).map((x) => x.date).sort()[0];
    const start = spanStart(end) && first && spanStart(end) < first ? first : spanStart(end) || first;
    if (!start) return null;
    const dates = datesBetween(start, end);
    const panels = groups.map((g) => ({ g, rows: keys.map((k) => { const ss = g.series.filter((s) => s.k === k).map((s) => s.c); return ss.length ? alignCompacts([sumCompacts(ss, start, end)], start, end).rows[0] : new Array(dates.length).fill(null); }) }));
    const hi = Math.max(1, ...panels.map((pn) => Math.max(...dates.map((_, i) => pn.rows.reduce((s, r) => s + (isNum(r[i]) ? r[i] : 0), 0)))));
    const pr = period();
    const band = pr.from ? [indexIn(dates, addDays(pr.from, 1)), dates.length - 1] : null;
    const tipLines = (i) => [h('b', null, md(dates[i])), ...panels.map((pn) => `${pn.g.chain}: ${fmtUsd(pn.rows.reduce((s, r) => s + (isNum(r[i]) ? r[i] : 0), 0))}`)];
    const hg = hoverGroup(dates.length, (i, e) => showTip(tipLines(i).map((x, k) => (k ? ['\n', x] : x)), e.clientX, e.clientY), hideTip);
    return h('div', { class: 'multiples', 'data-graphic': 'multiples' }, panels.map((pn) => {
      const svg = mini({ n: dates.length, stacked: true, series: keys.map((k, j) => ({ values: pn.rows[j], color: lensColor(k) })), lo: 0, hi, band, focusBand: focusBandOf(dates), h: 80 });
      hg.attach(svg);
      return h('div', { class: 'mp' }, h('div', { class: 'ml' }, h('span', null, pn.g.chain), h('span', null, fmtUsd(pn.g.total))), svg);
    }));
  }
  function lensChains() {
    const p = P();
    const all = state.asset === 'all';
    const d = all ? null : meta(state.asset);
    if (d && (isGold(d) || !(d.data.chains || []).some((c) => c.currentUsd > 0))) {
      const oc = (d.data.onchain || []).filter((x) => isNum(x.totalSupply)).sort((a, b) => b.totalSupply - a.totalSupply);
      if (!oc.length) return h('p', { class: 'note-line' }, `No per-chain data for ${d.key}.`);
      const tot = oc.reduce((s, x) => s + x.totalSupply, 0);
      const fmt = isGold(d) ? (x) => fmtOz(x) : (x) => fmtUsd(x);
      const rows = oc.map((x) => ({ chain: x.chain, total: x.totalSupply, parts: { [d.key]: x.totalSupply } }));
      return [grid2(figure({ key: 'chain-bal', title: `${oc[0].chain} holds ${fmtPortion(oc[0].totalSupply / tot)} of ${d.key} (on-chain read)`, body: () => stackBars(rows, [d.key], fmt),
        table: () => table({ head: ['Chain', isGold(d) ? 'oz' : 'Supply', 'Holders'], rows: oc.map((x) => ({ cells: [x.chain, fmt(x.totalSupply), isNum(x.holders) ? fmtCount(x.holders) : dash('No holder count for this chain')] })) }) }),
      h('p', { class: 'note-line' }, `No chain history for ${d.key}; current split from on-chain reads.`)), contractsBlock()];
    }
    const keys = all ? (p.totals.usd.assets || []).filter((k) => assetData(k)) : [d.key];
    const groups = chainTotals(keys);
    if (!groups.length) return h('p', { class: 'note-line' }, 'No per-chain data in this snapshot.');
    const total = groups.reduce((s, g) => s + g.total, 0);
    const top = groups.slice(0, 7);
    const rest = groups.slice(7);
    const rows = top.slice();
    if (rest.length) rows.push({ chain: `Other ${rest.length} chains`, total: rest.reduce((s, g) => s + g.total, 0), parts: rest.reduce((acc, g) => { for (const [k, v] of Object.entries(g.parts)) acc[k] = (acc[k] || 0) + v; return acc; }, {}) });
    let title = `${groups[0].chain} holds ${fmtPortion(groups[0].total / total)} of ${all ? aggKey() || 'the' : d.key}${all ? ' supply' : ''}`;
    if (!all) {
      const pr = period();
      const c0 = (d.data.chains || []).find((c) => c.chain === groups[0].chain);
      const start = pr.from;
      const totStart = start ? (d.data.chains || []).reduce((s, c) => s + (compactAt(c.series, start) || 0), 0) : null;
      const s0 = c0 && start && totStart ? compactAt(c0.series, start) / totStart : null;
      if (isNum(s0)) title += `, ${groups[0].total / total >= s0 ? 'up' : 'down'} from ${fmtPortion(s0)}`;
    }
    const figA = figure({ key: 'chain-bal', title, legend: keys.length > 1 ? keys.map((k) => ({ label: k, color: lensColor(k) })) : null, body: () => stackBars(rows, keys, (x) => fmtUsd(x)), table: () => chainsTable(keys) });
    const figB = figure({ key: 'chain-mult', title: `Top chains · ${spanText()}`, body: () => chainMultiples(groups.slice(0, 6), keys), table: () => chainsTable(keys) });
    return [grid2(figA, figB), contractsBlock()];
  }
  function chainsTable(keys) {
    const r = rng();
    const end = endIso();
    const multi = keys.length > 1;
    const rows = [];
    const small = [];
    for (const k of keys) {
      const a = assetData(k);
      const fl = floorOf(k);
      const oc = new Map((a.onchain || []).map((x) => [x.chain, x]));
      for (const c of (a.chains || []).slice().sort((x, y) => (y.currentUsd || 0) - (x.currentUsd || 0))) {
        const ch = chainChange(c, r, end);
        const o = oc.get(c.chain);
        const row = { cells: [c.chain, ...(multi ? [h('span', { class: 'asset-cell' }, swatch(colorOf(k)), k)] : []), fmtUsd(c.currentUsd), ch ? fmtUsd(ch.abs, { signed: true }) : dash('No history for this window'), fmtPortion(c.share),
          o && isNum(o.totalSupply) ? { v: fmtUsd(o.totalSupply), tip: `${o.source || ''}${o.asOf ? `, ${fmtDate(String(o.asOf).slice(0, 10))} ${fmtHM(o.asOf)} UTC` : ''}` } : dash('No on-chain reading'),
          o && isNum(o.holders) ? fmtCount(o.holders) : dash('No holder count for this chain'),
          c.status === 'tracking_ended' ? 'tracking ended' : c.first && period().from && c.first > period().from ? 'new' : ''] };
        if (isNum(fl) && (c.currentUsd || 0) < fl) small.push({ k, c });
        else rows.push(row);
      }
    }
    if (small.length) rows.push({ cls: 'sub', cells: [`${small.length} small chains · ${fmtUsd(small.reduce((s, x) => s + (x.c.currentUsd || 0), 0))}`, ...(multi ? [''] : []), '', '', '', '', '', ''] });
    return table({ wrap: 'tall', head: ['Chain', ...(multi ? ['Coin'] : []), 'Supply', `Change ${r.label}`, 'Share', 'On-chain', 'Holders', { t: 'Status', l: true }], rows });
  }
  function contractsBlock() {
    const addrs = ((P().discovery && P().discovery.addresses) || []).filter((x) => x && inScopeKey(x.asset) && (state.asset !== 'all' || isActiveOrShown(x.asset)));
    if (!addrs.length) return null;
    const mid = (a) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
    const ROLE = { bridged: 'third-party', unlisted: 'third-party' };
    const det = h('details', { class: 'fold', 'data-k': 'contracts', open: state.open.has('contracts') }, h('summary', null, `Contracts (${addrs.length})`));
    const fill = () => {
      if (det._built) return;
      det._built = true;
      det.append(table({ wrap: 'tall', head: ['Chain', 'Coin', { t: 'Contract', l: true }, { t: 'Role', l: true }], rows: addrs.map((x) => ({ cells: [x.chain, x.asset, h('span', { class: 'mono' }, h('span', { 'data-tip': x.address }, mid(String(x.address))), ' ', h('button', { type: 'button', class: 'linkbtn', 'data-action': 'copy-addr', 'data-addr': x.address, 'aria-label': `Copy address ${x.address}` }, 'Copy address')), ROLE[x.role] || 'issuer'] })) }));
    };
    det.addEventListener('toggle', () => det.open && fill());
    if (det.open) fill();
    return det;
  }

  // ----- Peg lens -----
  function lensPeg() {
    const p = P();
    const scope = scopeAssets().filter((d) => d.data && d.data.series);
    const usd = scope.filter((d) => isUsd(d) && d.data.series.price);
    const gold = scope.filter((d) => isGold(d));
    const peers = (p.pegPeers || []).filter((x) => x && x.price);
    const pr = period();
    const figs = [];
    if (usd.length) {
      const stats = usd.map((d) => ({ d, s: pegStats(d.data.series.price, pr.from, pr.to) }));
      const peerStats = peers.map((x) => ({ x, s: pegStats(x.price, pr.from, pr.to) })).filter((x) => x.s);
      const peerMax = peerStats.length ? Math.max(...peerStats.map((x) => x.s.absAvg)) : null;
      const active = stats.filter((x) => x.d.status === 'active');
      const outside = isNum(peerMax) ? active.filter((x) => x.s && x.s.absAvg > peerMax) : [];
      const over = pr.from ? ` over ${periodWords()}` : '';
      const title = !isNum(peerMax) ? `Distance from $1 · ${spanText()}` : outside.length === 1 ? `${outside[0].d.key} averaged ${pegWords(outside[0].s.avg)}${over}; others inside the peers' range` : outside.length ? `${outside.length} coins outside the peers' range${over}` : `All ${active.length} coins inside the peers' range${over}`;
      const flagged = new Set(((lastVerdict || {}).items || []).filter((it) => it.lens === 'peg').map((it) => it.asset));
      figs.push(figure({ key: 'peg-mult', title, sub: `Distance from $1 · ${spanText()}`,
        legend: peers.length ? Object.assign([{ label: `${joinAnd(peers.map((x) => x.symbol))} range`, color: TOK.neutral, band: true }], { force: true }) : null,
        body: () => pegMultiples(usd, peers, flagged), table: () => pegTable(stats, peerStats) }));
    }
    // Gold without a hourly reference in this snapshot: one line, not an empty chart frame.
    const notes = [];
    for (const g of gold) {
      const f = goldPremiumFigure(g, p);
      if (f) figs.push(f);
      else notes.push(h('p', { class: 'note-line' }, `${g.key} vs reference gold: gold reference prices not in this snapshot.`));
    }
    if (!figs.length) return notes.length ? notes : notIn();
    return [grid2(...figs), ...notes];
  }
  function pegMultiples(list, peers, flagged) {
    const end = endIso();
    const all = list.map((d) => d.data.series.price);
    const first = all.map((c) => compactFirst(c)).filter(Boolean).map((x) => x.date).sort()[0];
    const start = spanStart(end) || first;
    const priceEnd = all.map((c) => compactEnd(c)).filter(Boolean).sort().pop() || end;
    const stop = priceEnd > end ? end : priceEnd;
    let dates = datesBetween(start, stop);
    let rows = list.map((d) => alignCompacts([d.data.series.price], start, stop).rows[0].map((v) => (isNum(v) ? v - 1 : null)));
    const pr0 = peers.map((x) => alignCompacts([x.price], start, stop).rows[0].map((v) => (isNum(v) ? v - 1 : null)));
    let plo = dates.map((_, i) => { const xs = pr0.map((r) => r[i]).filter(isNum); return xs.length ? Math.min(...xs) : null; });
    let phi = dates.map((_, i) => { const xs = pr0.map((r) => r[i]).filter(isNum); return xs.length ? Math.max(...xs) : null; });
    if (!spanOf(rng())) {
      const idx = downsampleIdx(rows[0].map((v) => (isNum(v) ? Math.abs(v) : null)), 700);
      if (idx) {
        dates = idx.map((i) => dates[i]);
        rows = rows.map((r) => idx.map((i) => r[i]));
        plo = idx.map((i) => plo[i]);
        phi = idx.map((i) => phi[i]);
      }
    }
    const active = list.map((d, k) => ({ d, k })).filter((x) => x.d.status === 'active');
    const legacy = list.map((d, k) => ({ d, k })).filter((x) => x.d.status !== 'active');
    const range = (xs) => {
      const v = xs.flatMap((x) => rows[x.k]).concat(plo, phi).filter(isNum);
      return v.length ? [Math.min(0, ...v), Math.max(0, ...v)] : [-0.001, 0.001];
    };
    const pr = period();
    const band = pr.from ? [indexIn(dates, addDays(pr.from, 1)), dates.length - 1] : null;
    const fb = focusBandOf(dates);
    const tipLines = (i) => [h('b', null, md(dates[i])), ...list.map((d, k) => `${d.key}: ${fmtPeg(rows[k][i])}`), isNum(plo[i]) ? `${peers.map((x) => x.symbol).join(', ')}: ${fmtPeg(plo[i])} to ${fmtPeg(phi[i])}` : null].filter(Boolean);
    const hg = hoverGroup(dates.length, (i, e) => showTip(tipLines(i).map((x, k) => (k ? ['\n', x] : x)), e.clientX, e.clientY), hideTip);
    // The shared scale is printed once, on the first panel's right edge: its top, 0% and its bottom.
    const ticks = (lohi) => {
      const [lo, hi] = lohi;
      const at = (v) => ((2 + ((hi - v) / (hi - lo)) * 68) / 72) * 100;
      const kept = [];
      for (const v of [0, lo, hi]) if (v >= lo && v <= hi && kept.every((u) => Math.abs(at(u) - at(v)) >= 22)) kept.push(v);
      return h('div', { class: 'mp-ticks', 'aria-hidden': 'true' }, kept.map((v) => {
        const t = h('span', null, v === 0 ? '0%' : fmtPeg(v));
        t.style.top = at(v) + '%';
        return t;
      }));
    };
    const panel = (x, lohi, first) => {
      const svg = mini({ n: dates.length, series: [{ values: rows[x.k], color: lensColor(x.d.key) }], peer: peers.length ? { lo: plo, hi: phi } : null, lo: lohi[0], hi: lohi[1], zero: true, band, focusBand: fb, h: 72 });
      hg.attach(svg);
      const st = pegStats(x.d.data.series.price, pr.from, pr.to);
      return h('div', { class: 'mp' }, h('div', { class: 'ml' }, h('span', null, flagged.has(x.d.key) ? h('span', { class: 't-negative', 'aria-hidden': 'true' }, '! ') : null, x.d.key), h('span', null, st ? `avg ${fmtPeg(st.avg)}` : '')), h('div', { class: 'mp-plot' }, svg, first ? ticks(lohi) : null));
    };
    const ra = range(active);
    const out = [h('div', { class: 'multiples rows' }, active.map((x, k) => panel(x, ra, k === 0)))];
    if (legacy.length) {
      const rl = range(legacy);
      out.push(h('div', { class: 'mp-sep' }, 'Legacy · own scale'), h('div', { class: 'multiples rows' }, legacy.map((x, k) => panel(x, rl, k === 0))));
    }
    return h('div', { 'data-graphic': 'multiples' }, out);
  }
  function pegTable(stats, peerStats) {
    const r = rng();
    const rows = stats.map(({ d, s }) => {
      const c = d.data.current || {};
      return { cells: [d.key, isNum(c.pegDevBp) ? `${fmtPeg(c.pegDevBp / 1e4)}${c.pegAsOf ? ` (${fmtHM(c.pegAsOf)})` : ''}` : dash('No price in this snapshot'), s ? fmtPeg(s.avg) : '—', s && s.wide ? `${fmtPeg(s.wide.gap)} (${md(s.wide.date)})` : '—'] };
    });
    if (peerStats.length) {
      const avgs = peerStats.map((x) => x.s.absAvg);
      const wide = peerStats.map((x) => x.s.wide).filter(Boolean).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0];
      rows.push({ cls: 'sub', cells: [`Peers (${peerStats.map((x) => x.x.symbol).join(', ')})`, '', `${fmtPeg(Math.min(...avgs), { unsigned: true })}–${fmtPeg(Math.max(...avgs), { unsigned: true })}`, wide ? `${fmtPeg(wide.gap)} (${md(wide.date)})` : '—'] });
    }
    return table({ head: ['Coin', 'Now', `Average, ${r.label}`, 'Widest day'], rows });
  }
  function hourKey(t) {
    return new Date(Math.round(t / 3600) * 3600 * 1000).toISOString().slice(0, 13);
  }
  function goldPremiumFigure(d, p) {
    const ref = (p.goldRefs || []).find((g) => g && g.priceHourly && g.priceHourly.t && g.priceHourly.t.length);
    const own = d.data.series.priceHourly;
    if (!ref || !own || !own.t || own.t.length < 2) return null;
    const m = new Map(ref.priceHourly.t.map((t, i) => [hourKey(t), ref.priceHourly.v[i]]));
    const pts = own.t.map((t, i) => ({ k: hourKey(t), v: own.v[i], r: m.get(hourKey(t)) })).filter((x) => isNum(x.v) && isNum(x.r) && x.r > 0).map((x) => ({ k: x.k, prem: x.v / x.r - 1, v: x.v, r: x.r }));
    if (pts.length < 2) return null;
    const vals = pts.map((x) => x.prem);
    const p10 = quantile(vals, 0.1);
    const p90 = quantile(vals, 0.9);
    const last = vals[vals.length - 1];
    const inside = last >= p10 && last <= p90;
    const title = `${d.key} ${fmtPeg(Math.abs(last), { unsigned: true })} ${last >= 0 ? 'above' : 'below'} ${ref.symbol}, ${inside ? 'inside' : 'outside'} its usual range`;
    const body = () => {
      const svg = mini({ n: pts.length, series: [{ values: vals, color: lensColor(d.key) }], peer: { lo: vals.map(() => p10), hi: vals.map(() => p90) }, zero: true, h: 160, dot: true });
      svg.classList.add('tall');
      const hg = hoverGroup(pts.length, (i, e) => showTip([h('b', null, `${md(pts[i].k.slice(0, 10))} ${pts[i].k.slice(11, 13)}:00 UTC`), '\n', `${d.key} vs ${ref.symbol}: ${fmtPeg(pts[i].prem)}`], e.clientX, e.clientY), hideTip);
      hg.attach(svg);
      return h('div', { class: 'mp', 'data-graphic': 'premium' }, svg);
    };
    return figure({ key: 'gold-prem', title, sub: `${d.key} vs ${ref.symbol} · hourly`, legend: [{ label: d.key, color: lensColor(d.key) }, { label: 'usual range (p10–p90)', color: TOK.neutral, band: true }], body,
      table: () => table({ wrap: 'tall', head: ['Hour', d.key, ref.symbol, 'Premium'], rows: pts.slice().reverse().map((x) => ({ cells: [`${fmtDate(x.k.slice(0, 10))} ${x.k.slice(11, 13)}:00`, `$${x.v.toFixed(2)}`, `$${x.r.toFixed(2)}`, fmtPeg(x.prem)] })) }) });
  }

  // ----- Market lens -----
  function lensMarket() {
    const p = P();
    const r = rng();
    const end = endIso();
    const all = state.asset === 'all';
    const d = all ? null : meta(state.asset);
    const mk = p.market && p.market.usdTotal;
    const facts = [];
    if (all && isNum(p.totals.usd.rankEquivalent)) facts.push(['', `Would rank #${p.totals.usd.rankEquivalent} if combined`]);
    if (!all && isNum(d.data.current.rank)) facts.push(['', `#${d.data.current.rank} of ${fmtCount(d.data.current.rankOf)}`]);
    const mkLast = compactLast(mk);
    if (mkLast) facts.push(['All USD stablecoins', fmtUsd(mkLast.value)]);
    const series = all ? p.totals.usd.marketShare : (() => { const s = d.data.series.supplyUsd; return s && mk ? { start: s.start, values: s.values.map((v, i) => { const m = compactAt(mk, addDays(s.start, i)); return isNum(v) && m ? v / m : null; }) } : null; })();
    const figs = [];
    if (series) {
      const cov = (p.market && p.market.coverageFrom) || coverageStart(mk);
      // The span starts where the supply history does (range All), so a share line that begins later says why.
      const first = compactFirst(all ? p.totals.usd.supplyUsd : d.data.series.supplyUsd) || compactFirst(series);
      let start = spanStart(end) || (first && first.date) || end;
      const clipped = cov && cov > start;
      if (clipped) start = cov;
      let al = alignCompacts([series], start, end);
      const full = al;
      if (!spanOf(r)) al = thin(al.dates, al.rows, 900);
      const pr = period();
      const sc = shareChange(series, pr.from || start, end);
      const mkc = mk && pr.from ? ratioChange(mk, pr.from, end) : null;
      const s1 = sc ? sc.s1 : null;
      const over = pr.from ? `over ${periodWords()}` : `since ${fmtMonthYear(start)}`;
      const title = sc ? `Share ${fmtShare(s1)}, ${Math.abs(sc.pp) < 0.005 ? 'flat' : `${sc.pp > 0 ? '▲' : '▼'} ${fmtPP(sc.pp)}`} ${over}${isNum(mkc) ? `; all USD stablecoins ${fmtPct(mkc)}` : ''}` : `Share of USD stablecoins · ${spanText()}`;
      const color = all ? TOK['ink-2'] : colorOf(d.key);
      figs.push(figure({ key: 'share', title, sub: [`Share of USD stablecoins · ${spanText()}`, clipped ? h('span', { 'data-tip': `Market total comparable from ${fmtDate(cov)}.` }, ' ⓘ') : null],
        config: () => lineConfig({ labels: al.dates, datasets: [lineDs('Share', al.rows[0].map((v) => (isNum(v) ? v * 100 : null)), color)], yFmt: (v) => `${Number(v.toPrecision(3))}%`, tipFmt: (v) => `${v.toFixed(3)}%`, spanDays: daysBetween(al.dates[0], end), band: periodBands(al.dates) }),
        table: () => table({ wrap: 'tall', head: ['Date', 'Share'], rows: full.dates.map((dt, i) => ({ cells: [fmtDate(dt), isNum(full.rows[0][i]) ? fmtShare(full.rows[0][i]) : '—'] })).reverse().filter((_, j) => full.dates.length <= 92 || j % 7 === 0) }) }));
    } else figs.push(figure({ key: 'share', title: `Share of USD stablecoins · ${spanText()}`, body: () => notIn() }));
    figs.push(peerFigure());
    return [facts.length ? h('dl', { class: 'facts' }, facts.map(([k, v]) => h('div', null, k ? h('dt', null, k) : null, h('dd', null, v)))) : null, grid2(...figs)];
  }
  function peerFigure() {
    const p = P();
    const pe = p.peers;
    if (!pe || !Array.isArray(pe.rows) || !pe.rows.length) return figure({ key: 'peers', title: 'Growth vs the largest stablecoins', body: () => notIn() });
    const r = rng();
    const win = r.win === 'd7' ? 'd7' : 'd30';
    const rows = pe.rows.filter((x) => x.change && x.change[win] && isNum(x.change[win].pct));
    const n = pe.rows.filter((x) => !x.isPaxos).length;
    const title = `${win === 'd7' ? '7-day' : '30-day'} growth vs the ${n} largest stablecoins${r.win !== 'd7' && r.win !== 'd30' ? ' (30 days, longest available)' : ''}`;
    const body = () => {
      const vals = rows.map((x) => x.change[win].pct);
      const lo = quantile(vals, 0.05);
      const hi = quantile(vals, 0.95);
      const med = quantile(rows.filter((x) => !x.isPaxos).map((x) => x.change[win].pct), 0.5);
      const a = Math.min(lo, 0);
      const b = Math.max(hi, 0);
      const pos = (v) => (b === a ? 50 : ((Math.max(a, Math.min(b, v)) - a) / (b - a)) * 100);
      const el = h('div', { class: 'dotstrip', 'data-graphic': 'dots', role: 'img', 'aria-label': `${title}: ${rows.filter((x) => x.isPaxos).map((x) => `${x.symbol} ${fmtPct(x.change[win].pct)}`).join(', ')}; median ${fmtPct(med)}` }, h('span', { class: 'dl' }));
      const mline = h('span', { class: 'med' });
      mline.style.left = pos(med) + '%';
      const mlab = h('span', { class: 'medl' }, `median ${fmtPct(med)}`);
      mlab.style.left = pos(med) + '%';
      el.append(mline, mlab);
      // Paxos labels sit above the line in two alternating lanes (ordered by x); a clamped Paxos coin
      // states its value; other clamped coins share one edge label per side (the most extreme).
      for (const x of rows.filter((u) => !u.isPaxos)) {
        const pt = h('span', { class: 'pt', color: TOK.neutral, 'data-tip': `${x.symbol}: ${fmtPct(x.change[win].pct)} (${fmtUsd(x.change[win].abs, { signed: true })})` });
        pt.style.left = pos(x.change[win].pct) + '%';
        el.append(pt);
      }
      // Scale ticks under the line (its two ends and 0); peers beyond them sit on the edge and are named in
      // a note under the strip, so an edge never reads as two values.
      const tick = (v, cls) => {
        const t = h('span', { class: 'tick ' + (cls || '') }, v === 0 ? '0' : fmtPct(v));
        t.style.left = pos(v) + '%';
        return t;
      };
      el.append(tick(a, 'at-l'), ...(a < 0 && b > 0 ? [tick(0)] : []), tick(b, 'at-r'));
      const clamps = [-1, 1].map((side) => {
        const out = rows.filter((x) => !x.isPaxos && (side > 0 ? x.change[win].pct > b : x.change[win].pct < a));
        if (!out.length) return null;
        const ext = out.map((x) => x.change[win].pct).sort((u, v) => side * (v - u))[0];
        return `${out.length} ${out.length === 1 ? 'coin' : 'coins'} ${side < 0 ? 'below' : 'above'} ${fmtPct(side < 0 ? a : b)} (to ${fmtPct(ext)})`;
      }).filter(Boolean);
      el._note = clamps.length ? h('p', { class: 'note-line' }, `Off the scale: ${clamps.join('; ')}.`) : null;
      const pax = rows.filter((x) => x.isPaxos && x.assetKey && isActiveOrShown(x.assetKey)).sort((u, v) => u.change[win].pct - v.change[win].pct);
      pax.forEach((x, k) => {
        const v = x.change[win].pct;
        const pt = h('span', { class: 'pt pax', color: lensColor(x.assetKey), 'data-tip': `${x.symbol}: ${fmtPct(v)} (${fmtUsd(x.change[win].abs, { signed: true })})` });
        pt.style.left = pos(v) + '%';
        const l = h('span', { class: 'pl' + (pos(v) < 8 ? ' at-l' : pos(v) > 92 ? ' at-r' : '') }, v < a || v > b ? `${x.symbol} ${fmtPct(v)}` : x.symbol);
        l.style.left = pos(v) + '%';
        l.style.top = (k % 2 ? 2 : 18) + 'px';
        el.append(pt, l);
      });
      return h('div', null, el, el._note);
    };
    return figure({ key: 'peers', title, body,
      table: () => table({ wrap: 'tall', caption: pe.asOf ? `List as of ${fmtHM(pe.asOf)} UTC` : null, head: ['#', 'Coin', 'Supply', '7d', '30d'], rows: pe.rows.slice().sort((x, y) => (y.supplyUsd || 0) - (x.supplyUsd || 0)).map((x, i) => ({ cls: x.isPaxos ? 'sub' : null, cells: [String(i + 1), x.isPaxos ? { v: h('span', { class: 'asset-cell' }, swatch(x.assetKey ? colorOf(x.assetKey) : TOK.neutral), x.symbol), tip: 'Hourly list; cards use the daily snapshot.' } : x.symbol, fmtUsd(x.supplyUsd), x.change && x.change.d7 ? fmtPct(x.change.d7.pct) : '—', x.change && x.change.d30 ? fmtPct(x.change.d30.pct) : '—'] })) }) });
  }

  // ----- Usage lens -----
  function holderCoverage(d) {
    const a = d.data;
    const have = new Map((a.onchain || []).filter((x) => isNum(x.holders)).map((x) => [x.chain, x.holders]));
    const total = [...have.values()].reduce((s, v) => s + v, 0);
    const bal = (a.chains || []).filter((c) => isNum(c.currentUsd) && c.currentUsd > 0);
    const missing = bal.filter((c) => !have.has(c.chain));
    const tot = bal.reduce((s, c) => s + c.currentUsd, 0);
    const partial = bal.length ? missing.length > 0 : (a.onchain || []).some((x) => !isNum(x.holders));
    return { total: have.size ? total : null, partial, missing: missing.map((c) => c.chain), missingShare: tot ? missing.reduce((s, c) => s + c.currentUsd, 0) / tot : null, coveredShare: tot ? 1 - missing.reduce((s, c) => s + c.currentUsd, 0) / tot : null };
  }
  const turnoverLast = (d) => compactLast(d.data.series && d.data.series.turnover7d);
  function holdersNode(d) {
    const hc = holderCoverage(d);
    if (!isNum(hc.total)) return '—';
    const tipText = hc.partial ? `Holder counts from block explorers. Missing: ${hc.missing.length ? joinAnd(hc.missing) : 'some chains'}${isNum(hc.missingShare) ? ` (${fmtPortion(hc.missingShare)} of ${d.key})` : ''}.` : 'Holder counts from block explorers.';
    return h('span', { 'data-tip': tipText }, `${fmtCount(hc.total)}${hc.partial ? '+' : ''}`, hc.partial ? sr(' (some chains missing)') : null);
  }
  // DefiLlama project slugs and pool symbols, readable: "morpho-blue" -> "Morpho Blue", "usd-ai" -> "USD AI",
  // "{coin} (Earn (Ethena Market))" -> "{coin} (Earn, Ethena Market)".
  const projectName = (slug) => String(slug || '').split('-').filter(Boolean).map((w) => (w.length <= 3 && /^[a-z]+\d*$|^v\d+$/i.test(w) && !/^\d/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');
  const poolSymbol = (s) => { let t = String(s || ''); while (/\(([^()]*)\(([^()]*)\)\)/.test(t)) t = t.replace(/\(([^()]*?)\s*\(([^()]*)\)\)/, '($1, $2)'); return t; };
  const poolName = (x) => `${projectName(x.project)} · ${poolSymbol(x.symbol)}`;
  function lensUsage() {
    const scope = scopeAssets().filter((d) => d.data && d.status !== 'dead');
    const pools = scope.flatMap((d) => ((d.data.defi && d.data.defi.pools) || []).map((x) => ({ ...x, asset: d.key }))).sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0));
    const poolsTable = () => {
      const key = 'pools';
      const more = state.more.has(key);
      const list = more ? pools : pools.slice(0, 10);
      const wrap = h('div', null, table({ wrap: 'tall', head: ['Pool', { t: 'Chain', l: true }, ...(scope.length > 1 ? ['Coin'] : []), 'Size', 'APY', 'Lent out'], rows: list.map((x) => {
        const url = safeUrl(x.url);
        const name = poolName(x);
        return { cells: [url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, name) : name, x.chain, ...(scope.length > 1 ? [x.asset] : []), fmtUsd(x.tvlUsd), isNum(x.apy) ? { v: `${x.apy.toFixed(2)}%`, tip: `base ${isNum(x.apyBase) ? x.apyBase.toFixed(2) : '—'}% + incentives ${isNum(x.apyReward) ? x.apyReward.toFixed(2) : '—'}%` } : '—', isNum(x.utilization) ? fmtPortion(x.utilization) : dash('Not a lending market')] };
      }) }));
      if (pools.length > 10) wrap.append(h('button', { type: 'button', class: 'linkbtn more-btn', 'data-more': key, 'data-rerender': 'panel', 'aria-expanded': String(more) }, more ? 'Show fewer' : `Show all ${pools.length}`));
      return wrap;
    };
    const poolBars = () => {
      const top = pools.slice(0, 10);
      if (!top.length) return h('p', { class: 'note-line' }, 'No DeFi pools found.');
      const max = Math.max(1, ...top.map((x) => x.tvlUsd || 0));
      return h('div', { class: 'bars', 'data-graphic': 'bars' }, top.map((x) => {
        const tr = h('span', { class: 'track' });
        const f = h('span', { class: 'solid', color: lensColor(x.asset) });
        f.style.width = ((x.tvlUsd || 0) / max) * 100 + '%';
        tr.append(f);
        return h('div', { class: 'brow', 'data-tip': `${poolName(x)} · ${x.chain}\nTotal pool deposits; may include other coins.` }, h('span', { class: 'bl' }, swatch(lensColor(x.asset)), h('span', null, `${poolName(x)} · ${x.chain}`)), tr, h('span', { class: 'bv' }, fmtUsd(x.tvlUsd)));
      }));
    };
    // tvlUsd is the pool's total deposits (vaults, two-coin pools), not the coin's own balance in it.
    const top = pools[0];
    const figB = figure({ key: 'pools', title: top ? `Largest pool: ${projectName(top.project)} on ${top.chain}, ${fmtUsd(top.tvlUsd)} in total deposits` : 'Largest DeFi pools', sub: top ? 'Pool size, all assets' : null, body: poolBars, table: poolsTable });
    if (scope.length === 1) {
      const d = scope[0];
      const f = d.data.defi || {};
      const tl = turnoverLast(d);
      const t7 = d.data.series && d.data.series.turnover7d;
      const usual = t7 ? quantile(sliceCompact(t7, 365, endIso()).values, 0.5) : null;
      const hc = holderCoverage(d);
      const c = d.data.current || {};
      const tiles = h('div', { class: 'tiles' },
        h('div', { class: 'tile' }, h('span', { class: 'tl' }, 'In DeFi'), h('span', { class: 'tv', 'data-tip': 'Upper bound: two-coin pools count in full.' }, isNum(f.footprintShare) ? `≤${fmtPortion(f.footprintShare)}` : '—'), h('span', { class: 'tm' }, isNum(f.footprintUsd) ? `${fmtUsd(f.footprintUsd)} in ${fmtCount(f.poolCount)} pools` : '')),
        h('div', { class: 'tile' }, h('span', { class: 'tl' }, 'Traded daily'), h('span', { class: 'tv', 'data-tip': `24h: ${isNum(c.turnover24h) ? fmtPortion(c.turnover24h) : '—'}, ${fmtUsd(c.volume24hUsd)} volume` }, tl ? fmtPortion(tl.value) : '—'), h('span', { class: 'tm' }, isNum(usual) ? `usually ${fmtPortion(usual)}` : '')),
        h('div', { class: 'tile' }, h('span', { class: 'tl' }, 'Holders'), h('span', { class: 'tv' }, holdersNode(d)), h('span', { class: 'tm' }, isNum(hc.coveredShare) && hc.partial ? `on chains with ${fmtPortion(hc.coveredShare)} of supply` : '')));
      let figT = null;
      if (t7) {
        const end = endIso();
        const first = compactFirst(t7);
        const start = spanStart(end) || (first && first.date) || end;
        let al = alignCompacts([t7], start, end);
        const full = al;
        if (!spanOf(rng())) al = thin(al.dates, al.rows, 900);
        figT = figure({ key: 'turnover', title: `Traded daily, 7-day average · ${spanText()}`, config: () => lineConfig({ labels: al.dates, datasets: [lineDs('Traded daily', al.rows[0].map((v) => (isNum(v) ? v * 100 : null)), lensColor(d.key))], yFmt: (v) => `${Number(v.toPrecision(2))}%`, tipFmt: (v) => `${v.toFixed(1)}%`, spanDays: daysBetween(al.dates[0], end), band: periodBands(al.dates) }),
          table: () => table({ wrap: 'tall', head: ['Date', 'Traded daily'], rows: full.dates.map((dt, i) => ({ cells: [fmtDate(dt), isNum(full.rows[0][i]) ? fmtPortion(full.rows[0][i]) : '—'] })).reverse().filter((_, j) => full.dates.length <= 92 || j % 7 === 0) }) });
      }
      const holdersTbl = (d.data.onchain || []).length ? figure({ key: 'holders', title: `Holders by chain`, body: () => h('p', { class: 'note-line' }, `${fmtCount(hc.total)}${hc.partial ? '+' : ''} holders on ${(d.data.onchain || []).filter((x) => isNum(x.holders)).length} chains.`),
        table: () => table({ head: ['Chain', 'Holders', 'Supply on chain'], rows: (d.data.onchain || []).map((x) => ({ cells: [x.chain, isNum(x.holders) ? fmtCount(x.holders) : dash('No holder count for this chain'), isGold(d) ? fmtOz(x.totalSupply) : fmtUsd(x.totalSupply)] })) }) }) : null;
      return [h('p', { class: 'cap' }, h('b', null, `${d.key} usage`)), tiles, h('div', { class: 'lens-grid' }, figT, figB), holdersTbl];
    }
    const rows = scope.filter((d) => d.status === 'active');
    const usage = rows.map((d) => ({ d, defi: d.data.defi && d.data.defi.footprintShare, t: turnoverLast(d), hc: holderCoverage(d) }));
    const maxBy = (f) => usage.filter((u) => isNum(f(u))).sort((a, b) => f(b) - f(a))[0];
    const md1 = maxBy((u) => u.defi);
    const mt = maxBy((u) => u.t && u.t.value);
    const traded = usage.some((u) => u.t && isNum(u.t.value)); // no coin with a trading volume: no column
    const titleA = md1 && mt ? `Up to ${fmtPortion(md1.defi)} of ${md1.d.key} sits in DeFi; ${mt.d.key} trades ${fmtPortion(mt.t.value)} of supply a day` : md1 ? `Up to ${fmtPortion(md1.defi)} of ${md1.d.key} sits in DeFi` : 'How each coin is used';
    const body = () => {
      const col = (vals) => Math.max(1e-12, ...vals.filter(isNum));
      const metrics = [
        { l: 'In DeFi', v: (u) => u.defi, text: (u) => h('span', { 'data-tip': 'Upper bound: two-coin pools count in full.' }, isNum(u.defi) ? `≤${fmtPortion(u.defi)}` : '—') },
        ...(traded ? [{ l: 'Traded daily', v: (u) => u.t && u.t.value, text: (u) => (u.t ? fmtPortion(u.t.value) : '—') }] : []),
        { l: 'Holders', v: (u) => u.hc.total, text: (u) => holdersNode(u.d) },
      ];
      // Rows are coins and columns metrics; on a narrow screen each metric becomes its own list of coins
      // (CSS order from --om), so coins compare within a metric.
      const cell = (m, mi, u, ui, max) => {
        const tr = h('span', { class: 'track' });
        const f = h('span', { class: 'solid', color: lensColor(u.d.key) });
        const v = m.v(u);
        f.style.width = (isNum(v) ? (v / max) * 100 : 0) + '%';
        tr.append(f);
        const c = h('div', { class: 'ucell', 'data-c': u.d.key }, tr, h('span', { class: 'bv' }, m.text(u)));
        c.style.setProperty('--om', String((mi + 1) * 100 + ui));
        return c;
      };
      const tbl = h('div', { class: 'usage-table' + (traded ? '' : ' cols2'), 'data-graphic': 'usage' }, h('span', { class: 'uh corner' }, ''),
        metrics.map((m, mi) => { const x = h('span', { class: 'uh' }, m.l); x.style.setProperty('--om', String((mi + 1) * 100)); return x; }),
        usage.map((u, ui) => [h('span', { class: 'asset-cell' }, swatch(lensColor(u.d.key)), u.d.key), metrics.map((m, mi) => cell(m, mi, u, ui + 1, col(usage.map(m.v))))]));
      return traded ? tbl : h('div', null, tbl, h('p', { class: 'note-line' }, 'Trading volume not in this snapshot.'));
    };
    const figA = figure({ key: 'usage', title: titleA, body, table: () => table({ head: ['Coin', 'In DeFi (up to)', 'Traded daily', 'Holders', 'Pools'], rows: usage.map((u) => ({ cells: [u.d.key, isNum(u.defi) ? fmtPortion(u.defi) : '—', u.t ? fmtPortion(u.t.value) : dash('No trading volume in this snapshot'), isNum(u.hc.total) ? `${fmtCount(u.hc.total)}${u.hc.partial ? '+' : ''}` : '—', fmtCount(u.d.data.defi && u.d.data.defi.poolCount)] })) }) });
    return grid2(figA, figB);
  }
  const safeUrl = (u) => {
    try {
      const x = new URL(String(u));
      return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
    } catch {
      return null;
    }
  };

  // ----- Income lens -----
  function lensIncome() {
    const e = P().economics;
    if (!e) return notIn();
    const c = e.current || {};
    const end = endIso();
    const covers = econAssets();
    const facts = h('div', { class: 'facts' }, h('span', { class: 'badge', 'data-tip': e.note || null }, 'DefiLlama model'), isNum(c.fees1y) ? h('span', null, `${fmtUsd(c.fees1y)} earned in the last 12 months`) : null, covers.length ? h('span', null, `covers ${joinAnd(covers)}`) : null);
    const mean7 = (cmp) => (cmp ? { start: cmp.start, values: cmp.values.map((_, i) => { const xs = cmp.values.slice(Math.max(0, i - 6), i + 1).filter(isNum); return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null; }) } : null);
    const fees = mean7(e.fees);
    const rev = mean7(e.revenue);
    const fe = compactEnd(e.fees || e.revenue) || end;
    const first = compactFirst(e.fees || e.revenue);
    const start = spanStart(fe) || (first && first.date) || fe;
    let al = alignCompacts([fees, rev], start, fe);
    const full = al;
    if (!spanOf(rng())) al = thin(al.dates, al.rows, 900);
    const figs = [];
    if (fees || rev) {
      // Fees are the reserve income; revenue is the part DefiLlama's model leaves with Paxos after partner
      // payouts. The title's year is today's daily rate times 365 (the facts line has the last 12 months).
      const sets = [fees ? { label: 'Reserve income (fees)', v: al.rows[0], color: TOK['ink-2'] } : null, rev ? { label: `Kept by ${issuer()} (revenue)`, tip: "After partner payouts, per DefiLlama's model.", v: al.rows[1], color: TOK.neutral } : null].filter(Boolean);
      figs.push(figure({ key: 'income', title: isNum(c.fees24h) ? `Est. reserve income ${fmtUsd(c.fees24h)} a day (≈${fmtUsd(c.fees24h * 365)} a year at today's rate)` : 'Est. reserve income', legend: sets.map((s) => ({ label: s.label, color: s.color, tip: s.tip })),
        config: () => lineConfig({ labels: al.dates, datasets: sets.map((s) => lineDs(s.label, s.v, s.color)), yFmt: (v) => fmtUsd(v), spanDays: daysBetween(al.dates[0], fe), band: periodBands(al.dates) }),
        table: () => incomeTable(e, full) }));
    }
    if (e.impliedYield) {
      const ay = alignCompacts([e.impliedYield], start, fe);
      const aly = spanOf(rng()) ? ay : thin(ay.dates, ay.rows, 900);
      figs.push(figure({ key: 'yield', title: `Implied yield on reserves ${isNum(c.impliedYield) ? (c.impliedYield * 100).toFixed(2) + '%' : ''}`.trim(),
        config: () => lineConfig({ labels: aly.dates, datasets: [lineDs('Implied yield', aly.rows[0].map((v) => (isNum(v) ? v * 100 : null)), TOK['ink-2'])], yFmt: (v) => `${v.toFixed(1)}%`, tipFmt: (v) => `${v.toFixed(2)}%`, spanDays: daysBetween(aly.dates[0], fe), band: periodBands(aly.dates) }),
        table: () => incomeTable(e, full) }));
    }
    return [facts, state.asset !== 'all' ? h('p', { class: 'note-line' }, 'Issuer-wide; not split by coin.') : null, grid2(...figs)];
  }
  function incomeTable(e, full) {
    const rows = [];
    for (let i = full.dates.length - 1; i >= 0; i -= 7) {
      const d = full.dates[i];
      const y = compactAt(e.impliedYield, d);
      rows.push({ cells: [fmtDate(d), fmtUsd(full.rows[0][i]), fmtUsd(full.rows[1][i]), isNum(y) ? `${(y * 100).toFixed(2)}%` : '—'] });
    }
    return table({ wrap: 'tall', caption: '7-day averages, weekly.', head: ['Week', 'Fees', 'Revenue', 'Yield'], rows });
  }
  const LENS_RENDER = { supply: lensSupply, chains: lensChains, peg: lensPeg, market: lensMarket, usage: lensUsage, income: lensIncome };

  // 8. All findings (§3.10): built when opened
  function findingsModel() {
    const end = endIso();
    const inScope = (i) => insightMatches(i, state.asset, floorsAll());
    const shown = (i) => i.asset === aggKey() || !meta(i.asset) || isActiveOrShown(i.asset);
    let hiddenLegacy = 0;
    const keep = (i) => {
      if (!inScope(i)) return false;
      if (!shown(i)) {
        hiddenLegacy++;
        return false;
      }
      return true;
    };
    const unusual = [];
    const earlier = [];
    const notes = [];
    for (const u of IX.units) {
      const members = [u.lead, ...u.related];
      const lead = members.find((i) => roleOf(i) !== 'note' && roleOf(i) !== 'api' && ['new', 'ongoing'].includes(stageOf(i)));
      if (lead && keep(lead)) unusual.push(relead({ lead, related: members.filter((i) => i !== lead && roleOf(i) !== 'note'), list: u.list }));
      for (const i of members) {
        if (roleOf(i) === 'note') {
          if (keep(i)) notes.push({ lead: i, related: [] });
        } else if (stageOf(i) === 'past' && i !== lead && keep(i)) earlier.push({ lead: i, related: [] });
      }
    }
    const watching = [];
    for (const i of IX.watch) {
      if (roleOf(i) === 'note') {
        if (keep(i)) notes.push({ lead: i, related: [] });
      } else if (roleOf(i) !== 'api' && stageOf(i) === 'watch' && keep(i)) watching.push({ lead: i, related: [] });
      else if (stageOf(i) === 'past' && keep(i)) earlier.push({ lead: i, related: [] });
    }
    const named = namedIds();
    unusual.sort((a, b) => (isMajor(a.lead, named) ? 0 : 1) - (isMajor(b.lead, named) ? 0 : 1));
    earlier.sort((a, b) => String((b.lead.novelty || {}).since || '').localeCompare(String((a.lead.novelty || {}).since || '')));
    const cut = addDays(end, -365);
    const recent = earlier.filter((u) => !(u.lead.novelty && u.lead.novelty.since) || u.lead.novelty.since >= cut);
    return { unusual, earlier: recent, older: earlier.filter((u) => !recent.includes(u)), watching, notes, hiddenLegacy };
  }
  function renderFindingsSummary() {
    const det = $('all-findings');
    const m = findingsModel();
    const n = m.unusual.length + m.earlier.length + m.older.length + m.watching.length + m.notes.length;
    det.querySelector('summary').textContent = `All findings (${n})`;
    det._model = m;
    if (det.open) renderFindingsBody();
  }
  function renderFindingsBody(force) {
    const det = $('all-findings');
    const body = det.querySelector('[data-body]');
    const sig = bodySig(`${state.ftab}|${state.more.has('older')}|${state.fidMissing}`);
    if (!force && body.dataset.sig === sig && body.childNodes.length) return;
    body.dataset.sig = sig;
    const m = det._model || findingsModel();
    const tabs = [['unusual', 'Unusual', m.unusual], ['earlier', 'Earlier', m.earlier.concat(m.older)], ['watching', 'Watching', m.watching], ['notes', 'Data notes', m.notes]];
    const cur = tabs.find((t) => t[0] === state.ftab) || tabs[0];
    let list = cur[2];
    const extra = [];
    if (cur[0] === 'earlier' && m.older.length && !state.more.has('older')) {
      list = m.earlier;
      extra.push(h('button', { type: 'button', class: 'linkbtn more-btn', 'data-more': 'older', 'data-rerender': 'findings' }, `Show ${m.older.length} older`));
    }
    if (cur[0] === 'watching') {
      // watchTotal counts data notes too, and the cap keeps every one of them (they list under Data notes).
      const wt = P().insights && P().insights.watchTotal;
      const notesHeld = IX.watch.filter((i) => roleOf(i) === 'note').length;
      const shown = IX.watch.filter((i) => roleOf(i) !== 'note' && roleOf(i) !== 'api').length;
      // (counted after the scope and legacy filters, so the footer and the tab agree)
      if (isNum(wt) && wt - notesHeld > shown) extra.push(h('p', { class: 'note-line' }, state.asset === 'all' ? `Showing ${m.watching.length} of ${fmtCount(wt - notesHeld)} (the most unusual).` : 'Showing the most unusual only.'));
    }
    if (m.hiddenLegacy) extra.push(h('p', { class: 'note-line' }, `${plural(m.hiddenLegacy, 'finding')} on legacy coins hidden · `, h('button', { type: 'button', class: 'linkbtn', 'data-action': 'legacy' }, 'Show')));
    const groups = [];
    if (state.asset === 'all' && list.length) {
      const by = new Map();
      for (const u of list) {
        const k = u.lead.asset || '';
        if (!by.has(k)) by.set(k, []);
        by.get(k).push(u);
      }
      for (const [k, us] of by) groups.push(h('p', { class: 'fgroup-h' }, meta(k) ? swatch(colorOf(k)) : null, k || 'Other'), h('ul', { class: 'flist' }, us.map((u) => findingLine(u, { where: 'all', autoOpen: true }))));
    } else if (list.length) groups.push(h('ul', { class: 'flist' }, list.map((u) => findingLine(u, { where: 'all', autoOpen: true }))));
    else groups.push(h('p', { class: 'note-line' }, 'None right now.'));
    put(body,
      state.fidMissing ? h('p', { class: 'note-line' }, 'That finding isn\'t in this snapshot.') : null,
      h('div', { class: 'ftabs', role: 'group', 'aria-label': 'Findings' }, tabs.map(([id, label, xs]) => h('button', { type: 'button', class: 'btn', 'aria-pressed': String(id === cur[0]), 'data-ftab': id }, `${label} (${xs.length})`))),
      ...groups, ...extra);
  }

  // 9. About this data (§3.11): built when opened
  const KIND_USE = { supply: 'Supply', market: 'Market totals', price: 'Prices', defi: 'DeFi', economics: 'Income model', usage: 'Activity', onchain: 'On-chain reads', discovery: 'Discovery' };
  const SRC_STATUS = { ok: ['✓', 's-good', 'OK'], partial: ['~', 's-warn', 'Partial'], stale: ['!', 's-warn', 'Late'], error: ['✕', 's-crit', 'Down'], skipped: ['–', 's-muted', 'Not used'] };
  const srcAgeText = (x) => `${isNum(x.ageNow) ? fmtAge(x.ageNow) : '—'}${isNum(x.s.cadenceHours) ? ` / every ${fmtAge(x.s.cadenceHours)}` : ''}`;
  // Source messages in plain words: "Rate-limited: 8 of 13 requests failed (HTTP 429)." (no response bodies).
  function humanMsg(msg) {
    const m = String(msg || '').trim();
    if (!m) return '';
    const f = /^(\d+)\/(\d+) requests failed:\s*(.*)$/.exec(m);
    const rest = f ? f[3] : m;
    const code = /HTTP (\d{3})/.exec(rest);
    const why = code ? (code[1] === '429' ? `rate-limited (HTTP 429)` : `HTTP ${code[1]}`) : /time budget/.test(rest) ? 'build time ran out' : /timeout/.test(rest) ? 'timed out' : /failed over/.test(rest) ? 'served by a fallback' : '';
    if (f) return `${f[1]} of ${f[2]} requests failed${why ? `: ${why}` : ''}.`;
    return why ? `${why[0].toUpperCase()}${why.slice(1)}.` : m.replace(/\s*\{.*$/, '').slice(0, 90);
  }
  // The data notes' lateness and the Sources status agree: a source a live freshness note is about reads
  // "Late (data note)" (the note judges a daily feed against its daily schedule, the table against a limit).
  // (feed of the note -> the source that serves it; source ids are lib/paxos/sources.js identifiers)
  const FEED_SOURCE = {
    fees: (s) => s.kind === 'economics', cm: (s) => s.kind === 'usage', hourly: (s) => s.kind === 'price' && /coins/.test(s.id), cgDaily: (s) => /coingecko/.test(s.id),
    supply: (s, f) => s.kind === 'supply' && (!f.source || String(s.label).includes(f.source)),
  };
  function lateByNote(src) {
    for (const [, x] of IX.byId) {
      const i = x.i, f = i.facts;
      if (i.detector !== 'dq.freshness' || !(stageOf(i) === 'new' || stageOf(i) === 'ongoing') || !f || !(f.overdueHours > 0)) continue;
      if (FEED_SOURCE[f.feed] && FEED_SOURCE[f.feed](src, f)) return true;
    }
    return false;
  }
  // Disclosure bodies are rebuilt only when what they show changed (a rebuild would drop focus and scroll).
  const bodySig = (extra) => `${(P() && P().generatedAt) || ''}|${state.asset}|${state.legacy}|${extra || ''}`;
  function renderAbout() {
    const det = $('about');
    if (!det.open) return;
    const body = det.querySelector('[data-body]');
    if (body.dataset.sig === bodySig() && body.childNodes.length) return;
    body.dataset.sig = bodySig();
    const p = P();
    const insx = p.insights || {};
    const out = [];
    const part = (name, fn) => {
      try {
        out.push(...[fn()].flat().filter(Boolean));
      } catch (e) {
        console.error(`about ${name} failed`, e);
        out.push(h('p', { class: 'fail' }, 'Not in this snapshot.'));
      }
    };
    part('sources', () => [h('h3', { id: 'about-sources', tabindex: '-1' }, 'Sources'), table({ head: ['Source', { t: 'Used for', l: true }, 'Age / updates', { t: 'Status', l: true }], rows: sourcesNow().map((x) => {
      const noted = x.status === 'ok' && lateByNote(x.s);
      const st = noted ? ['!', 's-warn', 'Late (data note)'] : SRC_STATUS[x.status] || SRC_STATUS.skipped;
      const msg = humanMsg(x.s.message);
      return { cells: [h('span', null, x.s.label, msg ? h('span', { class: 'src-msg', 'data-tip': String(x.s.message).slice(0, 300) }, msg) : null), KIND_USE[x.s.kind] || x.s.kind || '—', h('span', { 'data-src-age': x.s.id }, srcAgeText(x)), h('span', { 'data-src-status': x.s.id }, h('span', { class: 'ico ' + st[1], 'aria-hidden': 'true' }, st[0]), ' ', st[2])] };
    }) }), h('p', { class: 'note-line' }, 'Ages are judged against each source\'s own update rhythm.')]);
    part('how', () => {
      const b = p.briefing;
      return [h('h3', null, 'How findings work'), h('ul', { class: 'bul' },
        h('li', null, `Each build runs ${fmtCount(insx.testsRun)} checks comparing every coin with its own history and with other stablecoins.`),
        h('li', null, 'A result is flagged only if chance is an unlikely explanation, after allowing for how many checks ran.'),
        h('li', null, 'It must also move at least a typical day\'s flow for that coin.'),
        h('li', null, `The verdict and the briefing also need ${fmtUsd(b && isNum(b.floorUsd) ? b.floorUsd : floorOf(aggKey()))}, a typical day's flow for ${aggKey() || 'the total'} overall, or a peg gap wider than every peer.`),
        h('li', null, 'Where supply moved is exact arithmetic on daily supply, not statistics.')),
      h('details', null, h('summary', { class: 'small' }, 'Exact rule'), h('p', { class: 'small' }, (insx.rule && insx.rule.text) || '—'), insx.family ? h('p', { class: 'small muted' }, `${fmtCount(insx.family.counted)} checks counted; ${fmtCount(insx.family.underpowered)} could not reach a flag.`) : null)];
    });
    part('grid', () => {
      const hg = insx.health;
      if (!hg || !hg.cells) return null;
      const DIMS = [['supply', 'Supply'], ['market', 'Market'], ['chains', 'Chains'], ['peg', 'Peg'], ['defi', 'DeFi'], ['usage', 'Usage'], ['portfolio', 'Coin mix'], ['economics', 'Income'], ['data', 'Data']];
      const G = { notable_negative: '!', notable_positive: '+', notable_neutral: '◆', within_own_history: '✓', insufficient_history: '?', no_data: '–' };
      // A flagged cell wears the verdict's mark only when the verdict names its finding; otherwise it is a
      // smaller finding (·), as in the lists.
      const named = namedIds();
      const rows = (hg.assets || Object.keys(hg.cells)).filter((a) => hg.cells[a] && (state.asset === 'all' ? a === aggKey() || !meta(a) || isActiveOrShown(a) : a === state.asset));
      return [h('h3', null, 'Checks by area'), table({ head: ['', ...DIMS.map((x) => x[1])], rows: rows.map((a) => ({ cells: [a, ...DIMS.map(([dim]) => {
        const c = hg.cells[a][dim];
        if (!c) return '–';
        const g = dim === 'data' && /^notable_/.test(c.state) ? 'i' : /^notable_/.test(c.state) && !(c.evidence && named.has(c.evidence.id)) ? '·' : G[c.state] || '–';
        return c.tests ? `${g} ${fmtCount(c.tests)}` : g;
      })] })) }), h('p', { class: 'note-line' }, '! unusual, negative · + unusual, positive · ◆ unusual · · smaller finding · i data note · ✓ normal · ? too new to judge · – not checked')];
    });
    part('notes', () => {
      const m = findingsModel();
      return [h('h3', null, `Data notes (${m.notes.length})`), m.notes.length ? h('ul', { class: 'flist' }, m.notes.map((u) => findingLine(u, { where: 'about' }))) : h('p', { class: 'note-line' }, 'None right now.')];
    });
    part('terms', () => {
      const peers = (p.pegPeers || []).map((x) => x.symbol);
      const T = [['Peg', 'Distance of the daily price from $1, as a percent of $1; 0.44% below $1 is $0.9956.'], ['pp', 'Percentage points.'], ['Peers', `${joinAnd(peers)}: the large dollar stablecoins used as the peg reference.`], ['Typical day\'s flow', 'Median daily net issuance or redemption over the past year.'], ['Smaller finding', `Rare for that coin, but under a typical day's flow for ${aggKey() || 'the total'} overall, a peg gap inside the peers' range, or a detail shown only in its tab.`], ['Earlier', 'Flagged changes that began more than 30 days ago.'], ['Watching', 'Unusual, but not rare enough to flag.'], ['≤', 'Upper bound: two-coin pools count in full.'], ['+', 'Some chains did not report holders.'], ['Est.', 'Modelled by DefiLlama; not reported by Paxos.'], ['Supply change', 'Tokens issued or redeemed, valued at today\'s price, so a price move is not a supply change.']];
      return [h('h3', null, 'Terms'), h('dl', { class: 'small' }, T.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))];
    });
    part('found', () => {
      const tiers = (p.discovery && p.discovery.tiers) || [];
      const notes = discovered().filter((d) => d.data && (d.data.notes || []).length);
      return [h('h3', null, 'What was found'), h('p', { class: 'small' }, 'Coins, chains and contracts are found on every build from these sources:'), h('ul', { class: 'bul' }, tiers.map((t) => h('li', null, h('span', { class: t.ok === false ? 's-crit' : 's-good', 'aria-hidden': 'true' }, t.ok === false ? '✕ ' : '✓ '), `${t.label || t.id}: ${(t.found || []).join(', ') || '—'}`))),
        notes.length ? h('ul', { class: 'bul' }, notes.flatMap((d) => d.data.notes.map((n) => h('li', null, `${d.key}: ${n}`)))) : null];
    });
    part('build', () => {
      const errs = [...(insx.errors || []).map((e) => `${e.detector || 'engine'}: ${e.error}`), ...((p.briefing && p.briefing.errors) || []).map((e) => `${e.builder || 'briefing'}${e.frame ? ' ' + e.frame : ''}${e.asset ? ' ' + e.asset : ''}: ${e.error}`)];
      return errs.length ? [h('h3', null, 'Build notes'), h('ul', { class: 'bul' }, errs.map((e) => h('li', null, e)))] : null;
    });
    out.push(h('p', { class: 'small' }, h('a', { href: API }, 'Raw data (JSON)')));
    body.replaceChildren(...out);
  }
  function updateLiveAges() {
    const by = new Map(sourcesNow().map((x) => [x.s.id, x]));
    for (const el of document.querySelectorAll('[data-src-age]')) {
      const x = by.get(el.dataset.srcAge);
      if (x) el.textContent = srcAgeText(x);
    }
  }

  // ===== Render loop =====
  function renderChrome() {
    try {
      renderChip();
    } catch (e) {
      console.error('chip failed', e);
      slotState('header', true);
    }
    document.body.classList.toggle('is-refreshing', state.loading && !!state.payload && !state.fromSnapshot);
    $('content').setAttribute('aria-busy', String(state.loading));
  }
  const FOCUS_ATTRS = ['data-asset', 'data-range', 'data-action', 'data-more', 'data-lens', 'data-f', 'data-ftab', 'data-exp', 'data-tv', 'id'];
  const FOCUS_SCOPE = 'section, #scope, header, .chip-extra, details, .verdict, #compact';
  const scopeIdOf = (el) => {
    const sec = el.closest(FOCUS_SCOPE);
    return sec ? sec.id || sec.className || sec.tagName : null;
  };
  function focusKey(el) {
    if (!el || !el.tagName || el === document.body || el === document.documentElement || !el.closest) return null;
    const tag = el.tagName.toLowerCase();
    const k = tag === 'summary' && el.parentElement && el.parentElement.dataset ? el.parentElement.dataset.k || null : null;
    const attrs = {};
    for (const a of FOCUS_ATTRS) {
      const v = el.getAttribute(a);
      if (v !== null && v !== undefined) attrs[a] = v;
    }
    if (!k && !Object.keys(attrs).length) return null;
    return { tag, k, attrs, scope: scopeIdOf(el) };
  }
  function findFocusTarget(key) {
    if (!key) return null;
    if (key.k) {
      for (const d of document.querySelectorAll('details')) if (d.dataset.k === key.k) return d.querySelector('summary');
      return null;
    }
    const cands = [...document.querySelectorAll(key.tag)].filter((el) => Object.entries(key.attrs).every(([a, v]) => el.getAttribute(a) === v));
    return cands.find((el) => scopeIdOf(el) === key.scope) || (key.attrs['data-asset'] !== undefined ? cands.find((el) => el.closest('#scope')) : null) || (key.attrs['data-lens'] ? cands[0] : null) || null;
  }
  function restoreFocus(key) {
    if (!key) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected !== false) return;
    const el = findFocusTarget(key);
    if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
  }
  function render() {
    const fk = focusKey(document.activeElement);
    try {
      renderAll();
    } finally {
      restoreFocus(fk);
    }
  }
  // Looked up at call time, so a test can swap one for a throwing function (H9 isolation).
  const components = {
    header: renderChip,
    scope: renderScope,
    verdict: renderVerdict,
    hero: renderHero,
    brief: renderBrief,
    cards: renderCards,
    lenses: () => {
      renderTabs();
      renderPanel();
    },
    allFindings: renderFindingsSummary,
    about: renderAbout,
  };
  helpers.components = components;
  const COMPONENT_EL = { verdict: 'verdict', hero: 'hero', brief: 'brief', cards: 'cards', lenses: 'panel' };
  // Regions that keep their frame when their component throws: the fallback line is added (header, scope keep
  // their last good controls) or fills the disclosure body, and is removed by the next good render.
  const COMPONENT_SLOT = { header: ['.head', false], scope: ['#scope', false], allFindings: ['#all-findings [data-body]', true], about: ['#about [data-body]', true] };
  function slotState(name, failed) {
    const spec = COMPONENT_SLOT[name];
    const el = spec && document.querySelector(spec[0]);
    if (!el) return;
    const old = el.querySelectorAll('[data-fail]');
    if (!failed && !old.length) return;
    for (const x of old) x.remove();
    if (spec[1]) el.dataset.sig = '';
    if (!failed) return;
    const line = h('p', { class: 'fail', 'data-fail': '' }, 'Not in this snapshot.');
    if (spec[1]) el.replaceChildren(line);
    else el.append(line);
  }
  let errorPanel = null;
  function renderAll() {
    renderChrome();
    const p = state.payload;
    if (!p) {
      renderScope();
      renderVerdict();
      const failed = !!state.error;
      for (const id of ['overview', 'cards-sec', 'lens-sec', 'all-findings', 'about', 'verdict']) $(id).hidden = failed;
      if (failed) {
        if (!errorPanel) {
          errorPanel = h('div', { class: 'error-panel', role: 'alert' });
          $('content').prepend(errorPanel);
        }
        errorPanel.hidden = false;
        errorPanel.replaceChildren(h('h2', null, 'Data unavailable'), h('p', null, state.error && state.error.invalid ? 'The data service sent a snapshot this page cannot read.' : 'The data service did not respond.'), h('p', null, h('button', { type: 'button', class: 'btn', 'data-action': 'reload' }, 'Retry'), ' · ', h('a', { href: API }, 'Raw data (JSON)')));
      }
      return;
    }
    if (errorPanel) errorPanel.hidden = true;
    for (const id of ['overview', 'cards-sec', 'lens-sec', 'all-findings', 'about', 'verdict']) $(id).hidden = false;
    const notice = $('notice');
    notice.hidden = !state.notice;
    notice.textContent = state.notice || '';
    for (const name of Object.keys(components)) {
      try {
        components[name]();
        slotState(name, false);
      } catch (e) {
        console.error(`component ${name} failed`, e);
        slotState(name, true);
        const el = COMPONENT_EL[name] && $(COMPONENT_EL[name]);
        if (el) {
          if (name === 'lenses') destroyCharts(el);
          el.hidden = false;
          el.replaceChildren(h('p', { class: 'fail' }, 'Not in this snapshot.'));
          if (name === 'verdict') {
            el.dataset.sig = '';
            lastVerdict = { level: 'unknown', items: [], text: '' };
          }
        }
      }
    }
    renderCompact(lastVerdict);
    rememberSeen();
  }

  // "New since your last visit": insight ids this browser has not shown before (localStorage optional).
  const SEEN_KEY = 'paxos-health:seen:v1';
  function loadSeen() {
    try {
      const raw = root.localStorage.getItem(SEEN_KEY);
      const obj = raw ? JSON.parse(raw) : null;
      const keys = obj && typeof obj === 'object' ? Object.keys(obj) : [];
      return keys.length ? new Set(keys) : null; // first visit: no dots
    } catch {
      return null;
    }
  }
  function rememberSeen() {
    try {
      const raw = root.localStorage.getItem(SEEN_KEY);
      const obj = raw ? JSON.parse(raw) || {} : {};
      const now = Date.now();
      for (const id of IX.byId.keys()) if (!obj[id]) obj[id] = now;
      const keep = Object.entries(obj).filter(([, t]) => now - t < 90 * 864e5).sort((a, b) => b[1] - a[1]).slice(0, 2000);
      root.localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(keep)));
    } catch {
      /* storage unavailable: no dots */
    }
  }

  // A response the page cannot read is not "no response": its error says so (state.error.invalid).
  const invalid = (msg) => Object.assign(new Error(msg), { invalid: true });
  function validate(p) {
    if (!p || typeof p !== 'object') throw invalid('Empty response');
    if (p.schemaVersion !== 1) throw invalid(`Unsupported payload schema ${p.schemaVersion}`);
    if (!p.totals || !p.totals.usd || typeof p.totals.usd !== 'object' || !p.assets || typeof p.assets !== 'object') throw invalid('Payload is missing required sections');
  }
  // Percentages and drawdowns from levels (pctFrom); gold gets its supply figures in ounces.
  function normalizePayload(p) {
    if (p._normalized) return;
    p._normalized = true;
    if (!Array.isArray(p.sources)) p.sources = [];
    const dd = (curr, ath) => (isNum(curr) && ath && ath.value > 0 ? 100 * (curr / ath.value - 1) : null);
    const t = p.totals.usd;
    t.change = normalizeChanges(t.change, t.current);
    if (t.ath) t.drawdownPct = dd(t.current, t.ath);
    for (const a of Object.values(p.assets || {})) {
      if (!a || !a.current) continue;
      const c = a.current;
      a.series = a.series || {};
      c.change = normalizeChanges(c.change, c.supplyUsd);
      if (a.unit === 'USD' || a.kind === 'usd-stablecoin') {
        if (c.ath) c.drawdownPct = dd(c.supplyUsd, c.ath);
      } else {
        const s = a.series.supply || a.series.supplyUsd;
        c.nativeChange = c.changeNative ? normalizeChanges(c.changeNative, c.supply) : null;
        c.nativeAth = c.athNative || peakOf(s);
        const last = c.athNative && isNum(c.supply) ? { value: c.supply } : compactLast(s);
        c.nativeDrawdownPct = isNum(c.drawdownNativePct) ? c.drawdownNativePct : last ? dd(last.value, c.nativeAth) : null;
      }
      for (const ch of a.chains || []) if (ch) ch.change = normalizeChanges(ch.change, ch.currentUsd);
    }
  }
  function onPayload() {
    normalizePayload(state.payload);
    indexInsights();
    if (state.seenBefore === null) state.seenBefore = loadSeen();
    const known = discovered().map((d) => d.key);
    const canon = canonicalAsset(state.asset, known);
    if (!canon) {
      state.notice = `${state.asset} isn't in this snapshot.`;
      state.asset = 'all';
    } else {
      state.asset = canon;
      if (canon !== 'all' && meta(canon).status === 'legacy') state.legacy = true;
    }
    if (state.focus && !meta(state.focus)) state.focus = null;
    state.fidMissing = !!state.fid && !ins(state.fid);
    if (state.fidMissing) {
      state.open.add('findings');
      $('all-findings').open = true;
    }
    syncUrl();
  }

  // ----- loading: network first, the last good snapshot (Cache Storage) if the network is slow or down -----
  async function readSnapshot() {
    try {
      if (!root.caches) return null;
      const c = await root.caches.open(SNAP_CACHE);
      const res = await c.match(API);
      if (!res) return null;
      const p = JSON.parse(await res.text());
      validate(p);
      const gen = Date.parse(p.generatedAt);
      if (!isNum(gen) || Date.now() - gen > SNAP_MAX_AGE_MS) return null;
      return p;
    } catch {
      return null;
    }
  }
  async function saveSnapshot(text) {
    try {
      if (!root.caches) return;
      const c = await root.caches.open(SNAP_CACHE);
      await c.put(API, new Response(text, { headers: { 'content-type': 'application/json' } }));
    } catch {
      /* Cache Storage unavailable: no snapshot */
    }
  }
  function showSnapshot(p) {
    if (!p || (state.payload && !state.fromSnapshot)) return;
    state.payload = p;
    state.fromSnapshot = true;
    onPayload();
    render();
  }
  let inflight = null;
  let netAnswered = false;
  let snapshot = null;
  let snapshotP = null;
  function load() {
    if (inflight) return inflight;
    state.loading = true;
    state.loadStart = Date.now();
    if (state.payload) renderChrome();
    else render();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let fresh = false;
    const timer = setTimeout(() => ctrl && ctrl.abort(), TIMEOUT_MS);
    const slow = state.payload ? null : setTimeout(() => state.loading && !state.payload && renderChip(), 3000);
    inflight = (async () => {
      try {
        const res = await fetch(API, ctrl ? { signal: ctrl.signal } : undefined);
        if (!res.ok) throw new Error(`The data service answered HTTP ${res.status}`);
        const text = await res.text();
        const p = JSON.parse(text);
        validate(p);
        netAnswered = true;
        // An older copy (another CDN region, a stale-while-revalidate answer) never replaces a newer one.
        const tNew = Date.parse(p.generatedAt), tOld = state.payload ? Date.parse(state.payload.generatedAt) : NaN;
        fresh = !state.payload || (p.generatedAt !== state.payload.generatedAt && !(isNum(tOld) && isNum(tNew) && tNew < tOld));
        state.error = null;
        state.receivedAt = Date.now();
        state.sameSnapshot = !fresh;
        if (fresh) {
          state.payload = p;
          state.fromSnapshot = false;
          onPayload();
          saveSnapshot(text);
        } else state.fromSnapshot = !!state.payload && state.payload.generatedAt !== p.generatedAt ? state.fromSnapshot : false;
        if (!snapshotAge(p, Date.now()).current && state.retryFor !== p.generatedAt) {
          state.retryFor = p.generatedAt;
          state.retryPending = true;
          setTimeout(() => {
            state.retryPending = false;
            load();
          }, REVALIDATE_RETRY_MS);
        }
      } catch (e) {
        netAnswered = true;
        // Shown by the chip and the error panel; not a console error (an outage is a state, not a page bug).
        state.error = e && e.name === 'AbortError' ? new Error(`No response within ${TIMEOUT_MS / 1000} s`) : e instanceof Error ? e : new Error(String(e));
        // The saved snapshot may still be on its way from Cache Storage: wait for it before choosing the
        // error panel (which would otherwise flash, and be announced, before the snapshot replaces it).
        if (!state.payload && snapshotP) snapshot = await snapshotP;
        if (!state.payload && snapshot) {
          state.payload = snapshot;
          state.fromSnapshot = true;
          onPayload();
          fresh = true;
        }
      } finally {
        clearTimeout(timer);
        if (slow) clearTimeout(slow);
        state.loading = false;
        inflight = null;
        if (fresh || !state.payload) render();
        else renderChrome();
      }
    })();
    return inflight;
  }
  function expired() {
    const p = state.payload;
    if (!p) return true;
    const max = ((p.cache && p.cache.sMaxAge) || 300) * 1000;
    return Date.now() - Date.parse(p.generatedAt) > max && Date.now() - state.receivedAt > 60000;
  }
  function syncUrl() {
    try {
      const q = buildQuery(state);
      const hash = state.fid ? '#f=' + encodeURIComponent(state.fid) : '';
      if (q !== root.location.search || hash !== (root.location.hash || '')) root.history.replaceState(null, '', root.location.pathname + q + hash);
    } catch {
      /* non-fatal */
    }
  }
  function setState(patch) {
    Object.assign(state, patch);
    state.notice = null;
    if (patch.fid !== undefined) state.fidMissing = !!state.fid && !ins(state.fid);
    syncUrl();
    render();
  }
  function scrollToEl(el, block) {
    if (el && el.scrollIntoView) el.scrollIntoView({ block: block || 'start', behavior: reduced() ? 'auto' : 'smooth' });
  }
  function goLens(lens, focus, fid) {
    const patch = { lens: lensDisabled(lens) ? 'supply' : lens, focus: focus && meta(focus) ? focus : null };
    if (fid !== undefined) patch.fid = fid || null;
    if (fid) state.expanded.add(`f:lens:${fid}`);
    setState(patch);
    scrollToEl($('lens-sec'));
    const lh = $('lens-h');
    if (lh) lh.focus({ preventScroll: true });
  }
  function openDetails(id, then) {
    const d = $(id);
    d.open = true;
    state.open.add(d.dataset.k);
    if (id === 'all-findings') renderFindingsBody();
    if (id === 'about') renderAbout();
    if (then) then();
  }

  function boot() {
    readTokens();
    setupCharts();
    Object.assign(state, parseQuery(root.location.search, root.location.hash));
    snapshotP = readSnapshot();
    load();
    snapshotP.then((snap) => {
      snapshot = snap;
      const wait = Math.max(0, SNAP_WAIT_MS - (Date.now() - state.loadStart));
      setTimeout(() => {
        if (!netAnswered && snap && !state.payload) showSnapshot(snap);
        else if (state.error && snap && !state.payload) showSnapshot(snap);
      }, wait);
    });
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    document.addEventListener('toggle', (e) => {
      const d = e.target;
      if (!d || d.tagName !== 'DETAILS' || !d.dataset.k) return;
      if (d.open) state.open.add(d.dataset.k);
      else state.open.delete(d.dataset.k);
      if (d.open && d.id === 'all-findings') renderFindingsBody();
      if (d.open && d.id === 'about') renderAbout();
    }, true);
    const tipOn = (e) => {
      const t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!t || !t.dataset.tip) return;
      const r = t.getBoundingClientRect();
      showTip(t.dataset.tip, e.clientX || r.left, e.clientY || r.bottom);
    };
    document.addEventListener('pointerover', (e) => e.pointerType !== 'touch' && tipOn(e));
    document.addEventListener('pointerout', (e) => e.target && e.target.closest && e.target.closest('[data-tip]') && hideTip());
    document.addEventListener('focusin', (e) => (e.target && e.target.matches && e.target.matches('[data-tip]') ? tipOn(e) : hideTip()));
    document.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      const t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      if (t) tipOn(e);
      else hideTip();
    });
    root.addEventListener('scroll', hideTip, { passive: true });
    $('f-asset').addEventListener('scroll', () => fadeEnd($('f-asset')), { passive: true });
    root.addEventListener('popstate', () => {
      Object.assign(state, parseQuery(root.location.search, root.location.hash));
      if (state.payload) onPayload();
      render();
    });
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && expired() && load());
    root.addEventListener('online', () => (expired() || state.error ? load() : renderChip()));
    root.addEventListener('offline', () => renderChip());
    setInterval(() => {
      if (document.visibilityState !== 'visible' || !state.payload) return;
      if (expired()) load();
      else {
        renderChrome();
        updateLiveAges();
      }
    }, 60000);
    if ('IntersectionObserver' in root) {
      new IntersectionObserver((entries) => {
        for (const e of entries) compactShown = !e.isIntersecting && e.boundingClientRect.top < 0;
        renderCompact(lastVerdict);
      }).observe($('scope'));
    }
    let rt = null;
    let lastW = root.innerWidth;
    root.addEventListener('resize', () => {
      if ((lastW < 760) === (root.innerWidth < 760) && Math.abs(root.innerWidth - lastW) < 160) return;
      clearTimeout(rt);
      rt = setTimeout(() => {
        lastW = root.innerWidth;
        if (state.payload) render();
      }, 250);
    });
  }
  function onClick(e) {
    const t = e.target.closest ? e.target.closest('button, a[data-lens]') : null;
    if (!t || t.disabled) return;
    const svg = e.target.closest && e.target.closest('svg');
    if (svg && svg._suppressClick) return void e.preventDefault();
    const ds = t.dataset;
    if (t.tagName === 'A' && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button)) return;
    if (ds.action === 'reload') return void load();
    if (!state.payload) return;
    if (ds.action === 'chip') return void openDetails('about', () => {
      scrollToEl($('about-sources') || $('about'));
      const h3 = $('about-sources');
      if (h3) h3.focus({ preventScroll: true });
    });
    if (ds.action === 'legacy') {
      const legacy = !state.legacy;
      const keep = legacy || state.asset === 'all' || (meta(state.asset) || {}).status === 'active';
      return void setState({ legacy, asset: keep ? state.asset : 'all' });
    }
    if (ds.action === 'clear-focus') return void setState({ focus: null, fid: null });
    if (ds.action === 'notes') return void openDetails('about', () => scrollToEl($('about')));
    if (ds.action === 'to-scope') {
      scrollToEl(document.body);
      const b = [...$('f-asset').querySelectorAll('button')].find((x) => x.dataset.asset === state.asset);
      if (b) b.focus({ preventScroll: true });
      return;
    }
    if (ds.action === 'to-brief') return void scrollToEl($('overview'));
    if (ds.action === 'verdict-more') {
      // Unusual: the first finding opens (its evidence panel) and comes into view with focus.
      const first = document.querySelector('#brief-list li[data-kind="finding"] button[data-exp]');
      if (lastVerdict && lastVerdict.level === 'unusual' && first) {
        const k = first.dataset.exp;
        if (!state.expanded.has(k)) {
          state.expanded.add(k);
          const li = first.closest('li');
          if (li) li.replaceWith(briefRowFor(li));
        }
        const again = [...document.querySelectorAll('#brief-list button[data-exp]')].find((b) => b.dataset.exp === k);
        if (again) {
          again.focus({ preventScroll: true });
          scrollToEl(again.closest('li') || again, 'nearest');
        }
        return;
      }
      state.ftab = 'unusual';
      return void openDetails('all-findings', () => {
        scrollToEl($('all-findings'));
        $('all-findings').querySelector('summary').focus({ preventScroll: true });
      });
    }
    if (ds.action === 'copy') {
      const i = ins(ds.f);
      const url = root.location.origin + hrefFor({ lens: i ? lensOfIns(i) : state.lens, focus: i && meta(i.asset) ? i.asset : null, fid: ds.f });
      const bl = i ? bulletFor(unitOf(i.id) || { lead: i, related: [] }) : null;
      const text = i ? `${i.asset} · ${lensLabel(lensOfIns(i) || 'supply')} · ${bl ? bl.text : titleOf(i)} — ${url}` : url;
      copyText(text, t, 'Link copied');
      return;
    }
    if (ds.action === 'copy-addr') return void copyText(ds.addr, t, 'Copied');
    if (ds.tab) {
      e.preventDefault();
      if (t.getAttribute('aria-disabled') === 'true' || ds.lens === state.lens) return;
      return void setState({ lens: ds.lens, fid: null });
    }
    if (ds.lens && !ds.tab) {
      e.preventDefault();
      return void goLens(ds.lens, ds.focus || null, ds.f !== undefined ? ds.f || null : undefined);
    }
    if (ds.asset !== undefined) {
      const fromCard = !!t.closest('#cards');
      if (ds.asset !== state.asset) setState({ asset: ds.asset, focus: null, fid: null });
      if (fromCard) {
        scrollToEl(document.body);
        const b = [...$('f-asset').querySelectorAll('button')].find((x) => x.dataset.asset === state.asset);
        if (b) b.focus({ preventScroll: true });
      }
      return;
    }
    if (ds.range) return void (ds.range !== state.range && setState({ range: ds.range }));
    if (ds.exp) {
      if (state.expanded.has(ds.exp)) state.expanded.delete(ds.exp);
      else state.expanded.add(ds.exp);
      const li = t.closest('li');
      if (li && li.parentNode && li.closest('#brief')) li.replaceWith(briefRowFor(li));
      else if (li && li.parentNode) {
        const unit = unitFor(ds.f, li);
        const where = ds.exp.split(':')[1];
        if (unit) li.replaceWith(findingLine(unit, { where, lens: where === 'lens' ? state.lens : undefined }));
      }
      const again = [...document.querySelectorAll('button')].find((b) => b.dataset.exp === ds.exp);
      if (again) again.focus({ preventScroll: true });
      return;
    }
    if (ds.ftab) {
      state.ftab = ds.ftab;
      renderFindingsBody();
      const b = [...document.querySelectorAll('button')].find((x) => x.dataset.ftab === ds.ftab);
      if (b) b.focus({ preventScroll: true });
      return;
    }
    if (ds.more) {
      if (state.more.has(ds.more)) state.more.delete(ds.more);
      else state.more.add(ds.more);
      if (ds.rerender === 'findings') renderFindingsBody();
      else render();
    }
  }
  // Re-render one briefing row (its index is in the data-exp key) or one finding line in place.
  function briefRowFor(li) {
    const key = li.querySelector('[data-exp]').dataset.exp;
    const idx = +key.split(':').pop();
    const b = briefingFor();
    const fr = b && b.frames && b.frames[rng().frame];
    const bullets = fr ? fr.bullets.filter((x) => x && x.kind !== 'state' && x.text) : [];
    return bullets[idx] ? briefRow(bullets[idx], idx) : li;
  }
  function unitFor(id, li) {
    const i = ins(id);
    if (!i) return null;
    const where = li.closest('#all-findings') ? 'all' : li.closest('#panel') ? 'lens' : 'about';
    if (where === 'lens') return lensUnits(state.lens).find((u) => u.lead.id === id) || { lead: i, related: [] };
    if (where === 'all') {
      const m = $('all-findings')._model || findingsModel();
      return [...m.unusual, ...m.earlier, ...m.older, ...m.watching, ...m.notes].find((u) => u.lead.id === id) || { lead: i, related: [] };
    }
    return { lead: i, related: [] };
  }
  // Clipboard refused or missing: the button says so and the text appears selected in a read-only field
  // beside it, ready to copy by hand.
  function copyText(text, btn, done) {
    const was = btn.textContent;
    const flash = (label) => {
      btn.textContent = label;
      setTimeout(() => (btn.textContent = was), 2000);
    };
    const fail = () => {
      flash('Copy failed');
      let f = btn.nextElementSibling && btn.nextElementSibling.classList && btn.nextElementSibling.classList.contains('copy-fallback') ? btn.nextElementSibling : null;
      if (!f) {
        f = h('input', { type: 'text', class: 'copy-fallback', readonly: true, 'aria-label': 'Link to copy' });
        btn.after(f);
      }
      f.value = text;
      f.focus();
      if (typeof f.select === 'function') f.select();
    };
    try {
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) root.navigator.clipboard.writeText(text).then(() => flash(done), fail);
      else fail();
    } catch {
      fail();
    }
  }
  // Tabs: roving tabindex with Arrow / Home / End; disabled tabs stay focusable but never activate.
  function onKey(e) {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.tab) return;
    const tabs = [...$('tabs').querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(t);
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j === null) return;
    e.preventDefault();
    const next = tabs[j];
    tabs.forEach((x) => x.setAttribute('tabindex', x === next ? '0' : '-1'));
    next.focus();
    if (next.getAttribute('aria-disabled') !== 'true') setState({ lens: next.dataset.lens, fid: null });
  }
  helpers.render = render;
  helpers.load = load;
  helpers.renderHeader = renderChrome;
  helpers.flushCharts = () => document.querySelectorAll('canvas').forEach(createChart);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
