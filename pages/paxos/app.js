(function (root) {
  'use strict';

  // ===== Pure helpers (exported on window.PaxosDashboard for vm tests) =====
  const DAY = 86400;
  const MINUS = '−';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const RANGES = [
    { id: '30d', label: '30d', days: 30, win: 'd30', text: '30 days' },
    { id: '90d', label: '90d', days: 90, win: 'd90', text: '90 days' },
    { id: '1y', label: '1y', days: 365, win: 'd365', text: '1 year' },
    { id: 'all', label: 'All', days: null, win: 'all', text: 'full history' },
  ];
  const DEFAULT_RANGE = '90d';
  const API = '/api/paxos';
  const TIMEOUT_MS = 25000;
  const REVALIDATE_RETRY_MS = 4000;
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const rangeById = (id) => RANGES.find((r) => r.id === id) || RANGES.find((r) => r.id === DEFAULT_RANGE);

  const tOf = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 1000;
  const isoOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const addDays = (iso, n) => isoOf(tOf(iso) + n * DAY);
  const daysBetween = (a, b) => Math.round((tOf(b) - tOf(a)) / DAY);

  // Compact = { start:'YYYY-MM-DD', values:[...] } contiguous daily, null = missing.
  const compactEnd = (c) => (c && c.values && c.values.length ? addDays(c.start, c.values.length - 1) : null);
  function compactAt(c, iso) {
    if (!c || !c.values || !c.values.length || iso < c.start) return null;
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
  // The `days` days before endIso plus endIso itself (days+1 points), so the first
  // point is the base a `days`-day change is measured against. days=null: everything.
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
      return first && isNum(curr) ? { abs: curr - first.value, pct: null, from: first.date } : null;
    }
    const from = addDays(end, -days);
    if (from < c.start) return null; // not enough history for this window
    const prev = compactAt(c, from);
    if (!isNum(prev) || !isNum(curr)) return null;
    return { abs: curr - prev, pct: prev ? (100 * (curr - prev)) / prev : null, from };
  }
  // Percent change re-derived from {abs} and the level it ends at, so the page does not depend on
  // whether a server encodes `pct` as a fraction or in percent. Falls back to `pct` when no level is known.
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
    const rows = list.map((c) =>
      dates.map((d) => {
        if (!c || !c.values || d < c.start) return before;
        const i = daysBetween(c.start, d);
        return i < c.values.length && isNum(c.values[i]) ? c.values[i] : null;
      }),
    );
    return { dates, rows };
  }
  // A series "starts at launch" when its first observation is the asset's first known date (or a zero
  // balance): only then is the opening balance issuance. A series that starts later than the asset
  // existed (a data source began tracking it late) opens with a balance nobody issued in that bucket.
  function startsAtLaunch(c, firstDate) {
    const f = compactFirst(c);
    if (!f) return false;
    return f.value === 0 || (typeof firstDate === 'string' && firstDate.length >= 10 && f.date <= firstDate.slice(0, 10));
  }
  // Net change per bucket from levels at bucket boundaries (robust to single missing days).
  // mode: 'day' | 'week' (7-day buckets ending at endIso) | 'month' (calendar months).
  // A bucket whose base precedes the series start has no measurable change (value null, opening: true)
  // unless opts.launch says the series starts at the asset's launch, when the base level is zero.
  function bucketChanges(c, startIso, endIso, mode, opts = {}) {
    const out = [];
    if (!c) return out;
    const delta = (prevIso, to) => {
      const a = compactAt(c, prevIso);
      const b = compactAt(c, to);
      if (isNum(a) && isNum(b)) return { value: b - a };
      if (isNum(b) && prevIso < c.start) return opts.launch ? { value: b, opening: true, launch: true } : { value: null, opening: true };
      return { value: null };
    };
    if (mode === 'month') {
      let m = startIso.slice(0, 7);
      const last = endIso.slice(0, 7);
      while (m <= last) {
        const y = +m.slice(0, 4);
        const mo = +m.slice(5, 7);
        const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
        const to = next + '-01' > endIso ? endIso : addDays(next + '-01', -1);
        out.push({ label: m, from: m + '-01', to, ...delta(addDays(m + '-01', -1), to) });
        m = next;
      }
      return out;
    }
    const step = mode === 'week' ? 7 : 1;
    const n = Math.max(1, Math.ceil(daysBetween(startIso, endIso) / step));
    for (let k = n - 1; k >= 0; k--) {
      const to = addDays(endIso, -k * step);
      const prev = addDays(to, -step);
      out.push({ label: to, from: addDays(prev, 1), to, ...delta(prev, to) });
    }
    return out;
  }
  // Net issuance of several members (each { key, c, launch }) per bucket: the sum of each member's own
  // bucket change, so a member whose data starts late adds its flows from then on and never books its
  // opening balance. `excluded` names members whose opening bucket this is (their change is unknown).
  function netIssuance(members, startIso, endIso, mode) {
    const per = members.map((m) => ({ key: m.key, b: bucketChanges(m.c, startIso, endIso, mode, { launch: !!m.launch }) }));
    if (!per.length) return [];
    return per[0].b.map((x, i) => {
      let value = null;
      const excluded = [];
      for (const m of per) {
        const y = m.b[i];
        if (isNum(y.value)) value = (value || 0) + y.value;
        else if (y.opening) excluded.push(m.key);
      }
      return { label: x.label, from: x.from, to: x.to, value, excluded };
    });
  }
  // First day of a market total that is comparable with today's: a day whose one-day rise is larger
  // than every later `week`-day move of the total (up or down), judged only where at least `horizon`
  // days of later history exist, marks coins being added to the source's history at once (genuine
  // growth or decline accumulates over days). Returns the last such day (the first day that includes
  // the added coins), or null when the total has no such step.
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
  // Evidence numbers carry their unit in the payload (`evidence.unit`) or, failing that, in a trailing
  // "(unit)" of the metric text; format them for reading instead of printing raw floats.
  function evidenceUnit(e) {
    if (!e) return null;
    if (typeof e.unit === 'string' && e.unit) return e.unit;
    const m = /\(([^()]{1,12})\)\s*$/.exec(String(e.metric || ''));
    return m ? m[1].trim() : null;
  }
  function fmtEvidence(v, unit) {
    if (v === null || v === undefined) return 'n/a';
    if (!isNum(v)) return typeof v === 'object' ? JSON.stringify(v) : String(v);
    const u = String(unit || '').toLowerCase();
    if (u === 'usd' || u === '$') return fmtUsd(v, { signed: v < 0 });
    if (u === 'bp') return fmtBp(v);
    if (u === '%' || u === 'pct' || u === 'percent') return fmtPct(v);
    if (u === 'fraction' || u === 'share') return fmtShare(v);
    if (u === 's' || u === 'sec' || u === 'seconds') return fmtHours(v / 3600);
    if (u === 'h' || u === 'hours') return fmtHours(v);
    if (u === 'd' || u === 'days') return `${fmtCount(v)} day${Math.round(v) === 1 ? '' : 's'}`;
    const a = Math.abs(v);
    const n = a >= 1e4 ? fmtNum(v) : (v < 0 ? MINUS : '') + String(Number(a.toPrecision(4)));
    return unit ? `${n} ${unit}` : n;
  }
  // Snapshot freshness (decision 6): "current" only while the snapshot is within the CDN's s-maxage;
  // stale-while-revalidate is a delivery mechanism, not a freshness promise.
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
  // The documented source rule: stale once the data is older than two publication intervals.
  function sourceStatusNow(s, ageNow) {
    if (!s) return 'skipped';
    const limit = isNum(s.staleAfterHours) ? s.staleAfterHours : isNum(s.cadenceHours) ? 2 * s.cadenceHours : null;
    return s.status === 'ok' && isNum(ageNow) && isNum(limit) && ageNow > limit ? 'stale' : s.status;
  }
  // Chains an asset is on: per-chain balances at or above its materiality floor when DefiLlama has
  // them; otherwise the chains of its discovered contracts and on-chain readings (no balances).
  function chainCount(a, floor, addresses) {
    const rows = (a && a.chains) || [];
    if (rows.length) {
      const live = rows.filter((c) => isNum(c.currentUsd) && c.currentUsd > 0);
      const material = isNum(floor) ? live.filter((c) => c.currentUsd >= floor) : live;
      return { n: material.length, of: rows.length, basis: 'balances' };
    }
    const set = new Set([...((a && a.onchain) || []).map((x) => x && x.chain), ...(addresses || []).map((x) => x && x.chain)].filter(Boolean));
    return set.size ? { n: set.size, of: set.size, basis: 'contracts' } : { n: null, of: 0, basis: null };
  }
  function sumCompacts(list, startIso, endIso) {
    const { dates, rows } = alignCompacts(list, startIso, endIso, 0);
    return { start: startIso, values: dates.map((_, i) => rows.reduce((s, r) => (isNum(r[i]) ? s + r[i] : s), 0)) };
  }
  function quantile(xs, q) {
    const s = xs.filter(isNum).sort((a, b) => a - b);
    if (!s.length) return null;
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
  }

  // ----- formatting -----
  function compactNum(x) {
    const a = Math.abs(x);
    if (a >= 1e12) return (a / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e4) return (a / 1e3).toFixed(1) + 'K';
    if (a >= 1e3) return Math.round(a).toLocaleString('en-US');
    if (a >= 10 || a === 0) return a.toFixed(0);
    return a.toFixed(2);
  }
  const signOf = (x, signed) => (x < 0 ? MINUS : signed && x > 0 ? '+' : '');
  const fmtUsd = (x, o = {}) => (isNum(x) ? signOf(x, o.signed) + '$' + compactNum(x) : 'n/a');
  const fmtNum = (x, o = {}) => (isNum(x) ? signOf(x, o.signed) + compactNum(x) : 'n/a');
  const fmtUnit = (x, unit, o = {}) => (unit === 'USD' || !unit ? fmtUsd(x, o) : isNum(x) ? `${fmtNum(x, o)} ${unit}` : 'n/a');
  // pct is in percent units (-3.1 = -3.1%).
  function fmtPct(p, o = {}) {
    if (!isNum(p)) return 'n/a';
    const d = isNum(o.digits) ? o.digits : Math.abs(p) < 1 ? 2 : 1;
    const s = Math.abs(p).toFixed(d);
    return (Number(s) === 0 ? '' : signOf(p, o.signed)) + s + '%';
  }
  // share is a fraction (0.019 = 1.9%).
  function fmtShare(f) {
    if (!isNum(f)) return 'n/a';
    const p = f * 100;
    return Math.abs(p).toFixed(Math.abs(p) < 0.1 ? 3 : Math.abs(p) < 10 ? 2 : 1) + '%';
  }
  function fmtBp(b, o = {}) {
    if (!isNum(b)) return 'n/a';
    const s = Math.abs(b).toFixed(Math.abs(b) < 10 ? 1 : 0);
    return (Number(s) === 0 ? '' : signOf(b, o.signed !== false)) + s + ' bp';
  }
  const fmtCount = (n) => (isNum(n) ? Math.round(n).toLocaleString('en-US') : 'n/a');
  function fmtP(p) {
    if (!isNum(p)) return 'n/a';
    if (p > 0 && p < 0.001) return p.toExponential(1).replace('e-', 'e' + MINUS);
    return String(Number(p.toPrecision(2)));
  }
  const fmtE = (e) => (isNum(e) ? String(Number(e.toPrecision(2))) : 'n/a');
  function oneInN(p) {
    if (!isNum(p) || p <= 0) return null;
    return p >= 1 ? '1 in 1' : '1 in ' + Math.round(1 / p).toLocaleString('en-US');
  }
  function fmtDate(iso) {
    if (!iso || typeof iso !== 'string' || iso.length < 10) return 'n/a';
    return `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
  }
  function fmtDateTime(iso) {
    const t = Date.parse(iso);
    if (!isNum(t)) return 'n/a';
    const d = new Date(t).toISOString();
    return `${fmtDate(d)} ${d.slice(11, 16)} UTC`;
  }
  function fmtAgo(ms) {
    if (!isNum(ms)) return 'n/a';
    const m = Math.max(0, ms) / 60000;
    if (m < 1) return 'just now';
    if (m < 90) return `${Math.round(m)} min ago`;
    if (m < 48 * 60) return `${(m / 60).toFixed(m < 600 ? 1 : 0)} h ago`;
    return `${Math.round(m / 1440)} days ago`;
  }
  function fmtHours(h) {
    if (!isNum(h)) return 'n/a';
    if (h < 1) return `${Math.round(h * 60)} min`;
    if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
    return `${(h / 24).toFixed(h < 240 ? 1 : 0)} d`;
  }
  function fmtBytes(b) {
    if (!isNum(b)) return 'n/a';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
    return b + ' B';
  }
  function fmtTick(label, spanDays) {
    if (!label) return '';
    const s = String(label);
    const mon = MONTHS[+s.slice(5, 7) - 1];
    if (spanDays <= 120) return `${+s.slice(8, 10)} ${mon}`;
    if (spanDays <= 900) return `${mon} ’${s.slice(2, 4)}`;
    return s.slice(0, 4);
  }
  // Long date axes: label the first date of each calendar month (or year), every k-th one so at most
  // maxTicks labels show. Returns the label indices; null for short spans (let the chart auto-skip).
  function tickPlan(labels, spanDays, maxTicks) {
    if (!Array.isArray(labels) || spanDays <= 120) return null;
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
  const plural = (n, w) => `${fmtCount(n)} ${w}${n === 1 ? '' : 's'}`;

  function parseQuery(search) {
    const q = new URLSearchParams(search || '');
    const asset = (q.get('asset') || 'all').slice(0, 64);
    return { asset: asset || 'all', range: rangeById(q.get('range')).id, legacy: q.get('legacy') === '1' };
  }
  // ?asset= is matched to a discovered key case-insensitively ('abc' -> 'ABC').
  function canonicalAsset(asset, keys) {
    if (!asset || asset.toLowerCase() === 'all') return 'all';
    const hit = (keys || []).find((k) => k === asset) || (keys || []).find((k) => String(k).toLowerCase() === asset.toLowerCase());
    return hit || null;
  }
  function buildQuery(s) {
    const q = new URLSearchParams();
    q.set('asset', s.asset || 'all');
    q.set('range', rangeById(s.range).id);
    if (s.legacy) q.set('legacy', '1');
    return '?' + q.toString();
  }

  // ----- insights -----
  const insightMatches = (ins, key) => !key || key === 'all' || ins.asset === key || (Array.isArray(ins.drivers) && ins.drivers.some((d) => d && d.asset === key));
  function ageText(n) {
    if (!n || !isNum(n.ageDays)) return null;
    if (n.ageDays === 0) return 'new today';
    return `for ${n.ageDays} day${n.ageDays === 1 ? '' : 's'}`;
  }
  // Data-quality findings describe the sources, not the asset (decision 2): shown neutral and apart.
  const isDataQuality = (ins) => !!ins && (ins.dimension === 'data' || /^dq\./.test(String(ins.detector || '')));
  function whyText(ins) {
    const s = ins.surprise || {};
    const parts = [`p = ${fmtP(s.p)}`];
    const n = oneInN(s.p);
    if (n) parts.push(n);
    parts.push(`E = ${fmtE(s.E)} across ${plural(s.m || 1, 'check')}`);
    if (s.underpowered) parts.push('underpowered');
    return parts.join(' · ');
  }

  // ----- colour (OKLab interpolation for the diverging heatmap scale) -----
  const s2l = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const l2s = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  function hexToLab(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => s2l(parseInt(hex.slice(i, i + 2), 16) / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  }
  function labToHex([L, A, B]) {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    return '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(1, l2s(c))) * 255).toString(16).padStart(2, '0')).join('');
  }
  function mixHex(a, b, t) {
    const A = hexToLab(a);
    const B = hexToLab(b);
    return labToHex(A.map((v, i) => v + (B[i] - v) * t));
  }
  function alpha(hex, a) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return hex;
    return `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})`;
  }
  const safeUrl = (u) => {
    try {
      const x = new URL(String(u));
      return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
    } catch {
      return null;
    }
  };

  const helpers = {
    RANGES, DEFAULT_RANGE, rangeById, tOf, isoOf, addDays, daysBetween,
    compactEnd, compactAt, compactLast, compactFirst, sliceCompact, changeFromCompact, changeFor, pctFrom, normalizeChanges, peakOf, alignCompacts, bucketChanges, sumCompacts, quantile,
    startsAtLaunch, netIssuance, coverageStart, evidenceUnit, fmtEvidence, snapshotAge, sourceAgeNow, sourceStatusNow, chainCount, tickPlan, canonicalAsset, isDataQuality,
    fmtUsd, fmtNum, fmtUnit, fmtPct, fmtShare, fmtBp, fmtCount, fmtP, fmtE, oneInN, fmtDate, fmtDateTime, fmtAgo, fmtHours, fmtBytes, fmtTick,
    parseQuery, buildQuery, insightMatches, ageText, whyText, mixHex, alpha, safeUrl,
  };
  root.PaxosDashboard = helpers;
  if (typeof document === 'undefined' || !root.document) return;

  // ===== Browser =====
  const $ = (id) => document.getElementById(id);
  const hasChart = () => typeof root.Chart === 'function';
  const TOK = {};
  const TOKEN_NAMES = ['page', 'surface', 'surface-2', 'raised', 'ink', 'ink-2', 'ink-muted', 'hair', 'axis', 'neutral', 'div-pos', 'div-neg', 'div-mid', 'good', 'warn', 'crit', 'c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
  function readTokens() {
    const cs = getComputedStyle(document.documentElement);
    for (const n of TOKEN_NAMES) TOK[n] = cs.getPropertyValue('--' + n).trim() || '#888888';
    TOK.palette = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => TOK['c' + i]);
  }

  const state = {
    payload: null,
    error: null,
    loading: false,
    receivedAt: 0,
    asset: 'all',
    range: DEFAULT_RANGE,
    legacy: false,
    open: new Set(),
    more: new Set(),
    seenBefore: null,
    notice: null,
    retryFor: null,
    retryPending: false,
    sameSnapshot: false,
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
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    return el;
  };
  function spark(values, color, { w = 120, h: ht = 28, zero = false } = {}) {
    const svg = svgEl('svg', { viewBox: `0 0 ${w} ${ht}`, preserveAspectRatio: 'none', class: 'spark', 'aria-hidden': 'true', focusable: 'false' });
    const vals = (values || []).map((v) => (isNum(v) ? v : null));
    const fin = vals.filter(isNum);
    if (fin.length < 2) return svg;
    let lo = Math.min(...fin);
    let hi = Math.max(...fin);
    if (zero) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    if (hi === lo) {
      hi += 1;
      lo -= 1;
    }
    const x = (i) => 1 + (i / (vals.length - 1)) * (w - 2);
    const y = (v) => ht - 2 - ((v - lo) / (hi - lo)) * (ht - 4);
    if (zero) svg.append(svgEl('line', { x1: 0, x2: w, y1: y(0), y2: y(0), stroke: TOK.axis, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (!isNum(v)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`;
      pen = true;
    });
    svg.append(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
    return svg;
  }
  const swatch = (color, line, dash) => {
    const el = h('span', { class: 'swatch' + (line ? ' line' : '') + (dash ? ' dash' : ''), 'aria-hidden': 'true' });
    // A dashed line swatch draws its dashes in the series colour over a transparent background.
    if (dash) el.style.color = color;
    else el.style.background = color;
    return el;
  };
  // Increase / decrease key for charts coloured by sign (the diverging pair is not an entity colour).
  const signKey = () => h('div', { class: 'legend' }, h('span', null, swatch(TOK['div-pos']), 'increase'), h('span', null, swatch(TOK['div-neg']), 'decrease'));
  const fold = (key, summary, body, cls = 'fold') => h('details', { class: cls, 'data-k': key, open: state.open.has(key) }, h('summary', null, summary), body);
  // A long explanatory note sits above the scroll wrapper (a <caption> would be as wide as the table
  // and run off-screen when the table scrolls sideways).
  function table({ caption, note, head, rows, cls = '', wrap = '' }) {
    const tw = tableCore({ caption, head, rows, cls, wrap });
    return note ? h('div', null, h('p', { class: 'small muted tnote' }, note), tw) : tw;
  }
  function tableCore({ caption, head, rows, cls, wrap }) {
    return h(
      'div',
      { class: 'tw ' + wrap },
      h(
        'table',
        { class: cls },
        caption ? h('caption', null, caption) : null,
        h('thead', null, h('tr', null, head.map((c, i) => h('th', { scope: 'col', class: i && c.l ? 'l' : null }, typeof c === 'string' ? c : c.t)))),
        h('tbody', null, rows.map((r) => h('tr', { class: r.sel ? 'sel' : null }, r.cells.map((c, i) => (i === 0 && !r.noTh ? h('th', { scope: 'row', class: 'l' }, c) : h('td', { class: head[i] && head[i].l ? 'l' : null }, c)))))),
      ),
    );
  }

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
    discCache = { p, list };
    return list.sort((a, b) => tier(a) - tier(b) || (isNum(a.colorIndex) ? a.colorIndex : 99) - (isNum(b.colorIndex) ? b.colorIndex : 99) || String(a.firstDate || '').localeCompare(String(b.firstDate || '')));
  }
  const meta = (k) => discovered().find((d) => d.key === k) || null;
  const legacyCount = () => discovered().filter((d) => d.status !== 'active').length;
  const visibleAssets = () => discovered().filter((d) => d.status === 'active' || state.legacy || d.key === state.asset);
  const bySupply = (list) => list.slice().sort((a, b) => (a.status === 'active') !== (b.status === 'active') ? (a.status === 'active' ? -1 : 1) : ((b.data && b.data.current && b.data.current.supplyUsd) || 0) - ((a.data && a.data.current && a.data.current.supplyUsd) || 0));
  const scopeAssets = () => (state.asset === 'all' ? bySupply(visibleAssets()) : discovered().filter((d) => d.key === state.asset));
  function colorOf(k) {
    const d = meta(k);
    return d && isNum(d.colorIndex) && d.colorIndex >= 0 && d.colorIndex < TOK.palette.length ? TOK.palette[d.colorIndex] : TOK.neutral;
  }
  const rng = () => rangeById(state.range);
  function endIso() {
    const p = P();
    return compactEnd(p.totals && p.totals.usd && p.totals.usd.supplyUsd) || (p.dataAsOf || p.generatedAt || '').slice(0, 10);
  }
  function rangeStart(maxStart) {
    const r = rng();
    const s = isNum(r.days) ? addDays(endIso(), -r.days) : maxStart || endIso();
    return maxStart && s < maxStart ? maxStart : s;
  }
  const isUsdKind = (d) => d && (d.unit === 'USD' || d.kind === 'usd-stablecoin');
  const supplySeries = (d) => (d && d.data && d.data.series ? (isUsdKind(d) ? d.data.series.supplyUsd : d.data.series.supply || d.data.series.supplyUsd) : null);
  const scopeLabel = () => (state.asset === 'all' ? 'all Paxos assets' : state.asset);
  // The aggregate pseudo-asset (sum of active USD stablecoins) is shown under the payload's own label
  // (totals.usd.label); its key is totals.usd.key when sent, else the one health row not discovered.
  function aggKey() {
    const p = P();
    if (p.totals && p.totals.usd && typeof p.totals.usd.key === 'string') return p.totals.usd.key;
    const hg = p.insights && p.insights.health;
    const known = new Set(discovered().map((d) => d.key));
    const extra = ((hg && hg.assets) || []).filter((a) => !known.has(a));
    return extra.length === 1 ? extra[0] : null;
  }
  const labelOf = (k) => (k && k === aggKey() && P().totals.usd.label ? P().totals.usd.label : k);
  const floorOf = (k) => {
    const f = P().insights && P().insights.floorsUsd;
    return f && isNum(f[k]) ? f[k] : null;
  };
  // Third-party contracts carrying an asset's name (role 'bridged' / 'unlisted') are listed in the
  // registry for labelling only; the asset's own chains come from its issuer contracts.
  const THIRD_PARTY = { bridged: 'bridged (third-party)', unlisted: 'not in issuer docs' };
  const isIssuerAddress = (x) => x && !THIRD_PARTY[x.role];
  const addressesOf = (k) => ((P().discovery && P().discovery.addresses) || []).filter((x) => x && x.asset === k && isIssuerAddress(x));
  const roleText = (r) => THIRD_PARTY[r] || (r === 'unverified' ? 'issuer (no docs table to check)' : r === 'issuer' ? 'issuer' : 'n/a');
  // Health-grid rows in scope: aggregate pseudo-assets (not discovered) plus the visible assets.
  function healthRows() {
    const hg = (P().insights || {}).health;
    if (!hg || !hg.cells) return [];
    const known = new Set(discovered().map((d) => d.key));
    const vis = new Set(visibleAssets().map((d) => d.key));
    return (hg.assets || Object.keys(hg.cells)).filter((a) => hg.cells[a] && (state.asset === 'all' ? !known.has(a) || vis.has(a) : a === state.asset));
  }
  const assetLabel = (k) => {
    const d = meta(k);
    return h('span', { class: 'asset-cell' }, swatch(colorOf(k)), k, d && d.status !== 'active' ? h('span', { class: 'badge' }, d.status) : null);
  };
  let insightIndex = new Map();
  function indexInsights() {
    insightIndex = new Map();
    const ins = P().insights || {};
    const add = (i) => i && i.id && !insightIndex.has(i.id) && insightIndex.set(i.id, i);
    for (const c of ins.feed || []) {
      add(c.lead);
      (c.related || []).forEach(add);
    }
    for (const k of ['standing', 'watch', 'context']) (ins[k] || []).forEach(add);
  }

  // ----- charts -----
  let io = null;
  const factories = new WeakMap();
  function createChart(canvas) {
    const f = factories.get(canvas);
    if (!f || canvas._chart || !canvas.isConnected) return;
    try {
      canvas._chart = new root.Chart(canvas, f());
    } catch (e) {
      console.error('chart failed', e);
      const box = canvas.parentElement;
      if (box) box.replaceChildren(h('p', { class: 'sec-error' }, 'Chart could not be drawn; the table below has the values.'));
    }
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
    Object.assign(C.defaults.plugins.tooltip, {
      backgroundColor: TOK['surface-2'],
      borderColor: TOK.axis,
      borderWidth: 1,
      titleColor: TOK.ink,
      bodyColor: TOK.ink,
      footerColor: TOK['ink-muted'],
      padding: 8,
      usePointStyle: true,
      boxWidth: 10,
      boxHeight: 10,
      boxPadding: 4,
    });
    if ('IntersectionObserver' in root) {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) if (e.isIntersecting) {
            io.unobserve(e.target);
            createChart(e.target);
          }
        },
        { rootMargin: '400px 0px' },
      );
    }
  }
  // Vertical hairline at the hovered x (crosshair); tooltips run in index mode.
  const crosshair = {
    id: 'crosshair',
    afterDatasetsDraw(chart) {
      const act = chart.tooltip && chart.tooltip.getActiveElements();
      if (!act || !act.length) return;
      const x = act[0].element.x;
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = TOK.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, top);
      ctx.lineTo(Math.round(x) + 0.5, bottom);
      ctx.stroke();
      ctx.restore();
    },
  };
  // Direct end labels for small line charts (<= 4 series); colliding labels are dropped, the legend stays.
  const endLabels = {
    id: 'endLabels',
    afterDatasetsDraw(chart, _args, opts) {
      if (!opts || !opts.enabled) return;
      const ctx = chart.ctx;
      const items = [];
      chart.data.datasets.forEach((ds, i) => {
        const metaDs = chart.getDatasetMeta(i);
        if (metaDs.hidden || !ds.label) return;
        for (let j = metaDs.data.length - 1; j >= 0; j--) {
          const v = ds.data[j];
          if (isNum(typeof v === 'object' && v ? v.y : v)) {
            items.push({ y: metaDs.data[j].y, label: ds.endLabel || ds.label, color: ds.borderColor });
            break;
          }
        }
      });
      items.sort((a, b) => a.y - b.y);
      ctx.save();
      ctx.font = `11px ${root.Chart.defaults.font.family}`;
      ctx.textBaseline = 'middle';
      let lastY = -Infinity;
      const x = chart.chartArea.right + 6;
      for (const it of items) {
        if (it.y - lastY < 13) continue;
        ctx.strokeStyle = it.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, it.y);
        ctx.lineTo(x + 8, it.y);
        ctx.stroke();
        ctx.fillStyle = TOK['ink-2'];
        ctx.fillText(it.label, x + 11, it.y);
        lastY = it.y;
      }
      ctx.restore();
    },
  };
  function axisX(labels, spanDays, extra = {}) {
    const max = root.innerWidth < 600 ? 4 : 7;
    // Long spans: one label per calendar month or year boundary (never two "2024" ticks).
    const plan = tickPlan(labels, spanDays, max);
    return {
      type: 'category',
      labels,
      grid: { display: false },
      border: { color: TOK.axis },
      ticks: {
        autoSkip: !plan,
        maxRotation: 0,
        maxTicksLimit: plan ? undefined : max,
        color: TOK['ink-muted'],
        callback(v, i) {
          if (plan && !plan.has(i)) return null;
          return fmtTick(this.getLabelForValue(v), spanDays);
        },
      },
      ...extra,
    };
  }
  function axisY(fmt, extra = {}) {
    return {
      grid: { color: (c) => (c.tick && c.tick.value === 0 ? TOK.axis : TOK.hair), drawTicks: false },
      border: { display: false },
      ticks: { color: TOK['ink-muted'], maxTicksLimit: 5, padding: 6, callback: (v) => fmt(v) },
      ...extra,
    };
  }
  function tooltipDate(spanHours) {
    return (items) => {
      const l = items && items[0] ? String(items[0].label) : '';
      return spanHours ? `${fmtDate(l)} ${l.slice(11, 16)} UTC` : fmtDate(l);
    };
  }
  function lineDataset(label, data, color, extra = {}) {
    return {
      label,
      data,
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: TOK.surface,
      pointStyle: 'line',
      tension: 0,
      borderJoinStyle: 'round',
      borderCapStyle: 'round',
      spanGaps: false,
      ...extra,
    };
  }
  // Filled level series: missing days are bridged with a dashed segment so a gap does not read as a
  // drop to zero; the figure says how many days were bridged.
  function bridged(extra = {}) {
    return { spanGaps: true, segment: { borderDash: (ctx) => (ctx.p1DataIndex - ctx.p0DataIndex > 1 ? [4, 3] : undefined) }, ...extra };
  }
  function gapNote(values) {
    let first = -1;
    let last = -1;
    values.forEach((v, i) => {
      if (isNum(v)) {
        if (first < 0) first = i;
        last = i;
      }
    });
    if (first < 0) return null;
    const n = values.slice(first, last + 1).filter((v) => !isNum(v)).length;
    return n ? `${plural(n, 'missing day')} bridged (dashed)` : null;
  }
  function lineConfig({ labels, datasets, yFmt, spanDays, hourly, stacked, endLabel, yExtra, tipFmt }) {
    const fmt = tipFmt || yFmt;
    return {
      type: 'line',
      data: { labels, datasets },
      plugins: [crosshair, endLabels],
      options: {
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { right: endLabel ? 64 : 4, top: 4 } },
        scales: { x: axisX(labels, spanDays), y: axisY(yFmt, { stacked: !!stacked, ...(yExtra || {}) }) },
        plugins: {
          endLabels: { enabled: !!endLabel },
          tooltip: {
            itemSort: (a, b) => b.datasetIndex - a.datasetIndex,
            callbacks: {
              title: tooltipDate(hourly),
              label: (c) => ` ${fmt(c.parsed.y)}  ${c.dataset.label}`,
              footer: stacked ? (items) => `Total ${fmt(items.reduce((s, i) => s + (isNum(i.parsed.y) ? i.parsed.y : 0), 0))}` : undefined,
            },
          },
        },
      },
    };
  }
  // A figure owns its title, the chart box (fixed height including the x-axis band) and a table-view twin.
  function figure({ key, title, sub, size = '', label, config, tableView, legend, signed }) {
    const fig = h('figure', { class: 'viz' });
    fig.append(h('figcaption', null, title, sub ? h('span', { class: 'cap-sub' }, sub) : null));
    if (legend && legend.length > 1) fig.append(h('div', { class: 'legend', 'aria-hidden': 'true' }, legend.map((l) => h('span', null, swatch(l.color, l.line, l.dash), l.label))));
    if (signed) fig.append(signKey());
    const tkey = 'tv:' + key;
    if (hasChart() && config) {
      const canvas = h('canvas', { role: 'img', 'aria-label': label || title });
      factories.set(canvas, config);
      fig.append(h('div', { class: 'chart-box ' + size }, canvas));
      queueMicrotask(() => {
        if (io) io.observe(canvas);
        else createChart(canvas);
      });
    } else if (config) {
      fig.append(h('p', { class: 'small muted' }, 'Charts are unavailable (the chart library did not load); the values are in the table.'));
      state.open.add(tkey);
    }
    if (tableView) fig.append(fold(tkey, ['Table view', h('span', { class: 'sr-only' }, `: ${title}`)], tableView(), 'tv'));
    return fig;
  }

  // ===== Sections =====

  // Sources with their status re-judged at the current time (a cached snapshot keeps its ageHours).
  function sourcesNow() {
    const p = P();
    const now = Date.now();
    return ((p && p.sources) || []).map((s) => {
      const ageNow = sourceAgeNow(s, p, now);
      return { s, ageNow, status: sourceStatusNow(s, ageNow) };
    });
  }
  function statusParts() {
    const p = P();
    if (!p) return { ico: null, text: state.loading ? 'Loading the latest snapshot…' : state.error ? `The dashboard data could not be loaded (${state.error.message}).` : 'Loading the latest snapshot…' };
    const fr = snapshotAge(p, Date.now());
    const when = fmtDateTime(p.generatedAt);
    const c = p.cache || {};
    const pending = state.loading || state.retryPending;
    let ico = '✓';
    let cls = 's-good';
    let text;
    if (state.error) {
      ico = '!';
      cls = 's-warn';
      text = `Refresh failed (${state.error.message}). Showing the snapshot from ${when}${fr.current ? '' : ', which is no longer current'}.`;
    } else if (fr.current) {
      text = pending ? 'Current snapshot; checking for a newer one…' : 'Current snapshot.';
    } else {
      ico = '!';
      cls = 's-warn';
      const beyond = isNum(c.sMaxAge) && isNum(c.staleWhileRevalidate) && fr.ageSec > c.sMaxAge + c.staleWhileRevalidate;
      text = `Snapshot from ${when}${beyond ? ', older than its cache window' : ''}; ${pending ? 'refreshing…' : state.sameSnapshot ? 'no newer snapshot has been published yet (checking every minute).' : 'refreshing.'}`;
    }
    const bad = sourcesNow().filter((x) => x.status !== 'ok' && x.status !== 'skipped');
    return { ico, cls, text, bad };
  }
  function renderHeader() {
    const p = P();
    if (p) {
      const age = Date.now() - Date.parse(p.generatedAt);
      const asOf = (p.totals && p.totals.usd && p.totals.usd.supplyAsOf) || null;
      $('head-meta').replaceChildren(
        h('span', null, 'Generated ', h('time', { datetime: p.generatedAt }, fmtDateTime(p.generatedAt)), ` (${fmtAgo(age)})`),
        asOf ? h('span', null, 'Supply snapshot ', h('time', { datetime: asOf }, fmtDateTime(asOf))) : p.dataAsOf ? h('span', null, 'Data as of ', h('time', { datetime: p.dataAsOf }, fmtDateTime(p.dataAsOf))) : null,
      );
      $('foot-src').textContent = 'Sources: ' + [...new Set((p.sources || []).map((s) => s.host))].join(', ');
    }
    // The live region only changes when its message does (no minute-by-minute announcements); the
    // Refresh button lives outside it and is never rebuilt, so it keeps focus across refreshes.
    const sp = statusParts();
    const kids = [sp.ico ? h('span', { class: `ico ${sp.cls}`, 'aria-hidden': 'true' }, sp.ico) : null, h('span', null, sp.text)];
    if (sp.bad && sp.bad.length) {
      kids.push(h('span', null, `${plural(sp.bad.length, 'source')} degraded (${sp.bad.map((x) => `${x.s.label}: ${(SOURCE_STATUS[x.status] || {}).label || x.status}`).join('; ')}); sections that depend on ${sp.bad.length === 1 ? 'it' : 'them'} may be incomplete.`), h('a', { href: '#s-quality' }, 'Source details'));
    }
    if (state.notice) kids.push(h('span', null, state.notice));
    const st = $('status');
    const sig = kids.filter(Boolean).map((k) => k.textContent).join('|');
    if (st.dataset.sig !== sig) {
      st.dataset.sig = sig;
      st.replaceChildren(...kids.filter(Boolean));
    }
    const btn = $('refresh');
    if (btn) {
      btn.hidden = !p && !state.error;
      btn.textContent = state.loading ? (p ? 'Refreshing…' : 'Retrying…') : state.error ? 'Retry' : 'Refresh';
      btn.setAttribute('aria-busy', String(!!state.loading));
    }
    updateLiveAges();
  }
  // Source ages and statuses in the Data quality section, updated in place on the minute tick.
  function updateLiveAges() {
    const byId = new Map(sourcesNow().map((x) => [x.s.id, x]));
    for (const el of document.querySelectorAll('[data-src-age]')) {
      const x = byId.get(el.dataset.srcAge);
      if (x) el.textContent = sourceAgeText(x);
    }
    for (const el of document.querySelectorAll('[data-src-status]')) {
      const x = byId.get(el.dataset.srcStatus);
      if (x && el.dataset.st !== x.status) {
        el.dataset.st = x.status;
        el.className = `nowrap st-${x.status}`;
        el.replaceChildren(...statusLabel(x));
      }
    }
  }
  const sourceAgeText = (x) => (isNum(x.ageNow) ? `${fmtHours(x.ageNow)}${isNum(x.s.cadenceHours) ? ` / ${fmtHours(x.s.cadenceHours)}` : ''}` : isNum(x.s.cadenceHours) ? `n/a / ${fmtHours(x.s.cadenceHours)}` : 'n/a');
  function statusLabel(x) {
    const st = SOURCE_STATUS[x.status] || SOURCE_STATUS.skipped;
    return [h('span', { class: 'ico', 'aria-hidden': 'true' }, st.ico), ' ', st.label, x.status !== x.s.status ? h('span', { class: 'small muted' }, ` (was ${x.s.status} when generated)`) : null];
  }
  const SOURCE_STATUS = {
    ok: { ico: '✓', label: 'ok' },
    partial: { ico: '~', label: 'partial' },
    stale: { ico: '!', label: 'stale' },
    error: { ico: '✕', label: 'error' },
    skipped: { ico: '–', label: 'skipped' },
  };

  function renderFilters() {
    const btns = [h('button', { type: 'button', 'data-asset': 'all', 'aria-pressed': String(state.asset === 'all') }, 'All Paxos')];
    for (const d of visibleAssets()) {
      btns.push(h('button', { type: 'button', 'data-asset': d.key, 'aria-pressed': String(state.asset === d.key), title: `${d.name || d.key}${d.status !== 'active' ? ' (' + d.status + ')' : ''}` }, swatch(colorOf(d.key)), d.key, d.status !== 'active' ? h('span', { class: 'sr-only' }, ` (${d.status})`) : null));
    }
    $('f-asset').replaceChildren(...btns);
    // The accessible name starts with the visible label (WCAG 2.5.3); the expansion is extra text.
    $('f-range').replaceChildren(...RANGES.map((r) => h('button', { type: 'button', 'data-range': r.id, 'aria-pressed': String(state.range === r.id) }, r.label, h('span', { class: 'sr-only' }, ` (${r.text})`))));
    const lg = $('f-legacy');
    const n = legacyCount();
    lg.hidden = !n;
    lg.setAttribute('aria-pressed', String(state.legacy));
    lg.textContent = `Show legacy (${n})`;
  }

  // Supply change of an asset in its own unit: USD stablecoins use the payload's token-flow changes;
  // other assets use current.changeNative when the payload has it, else their native-unit series.
  const unitOfAsset = (d) => (isUsdKind(d) ? 'USD' : (d && d.unit) || 'token');
  function assetChange(d, r, end) {
    const a = d.data;
    const c = (a && a.current) || {};
    const s = supplySeries(d);
    if (isUsdKind(d)) return changeFor(c.change, s, r, end);
    return changeFor(c.nativeChange, s, r, end);
  }
  function assetChangeDays(d, n, w, end) {
    const c = (d.data && d.data.current) || {};
    const s = supplySeries(d);
    const ch = isUsdKind(d) ? c.change : c.nativeChange;
    return (ch && ch[w]) || changeFromCompact(s, n, end);
  }
  // Signed figures never break after their sign.
  function deltaNode(ch, unit, withPct = true) {
    if (!ch) return 'n/a';
    const abs = fmtUnit(ch.abs, unit, { signed: true });
    return withPct && isNum(ch.pct) ? h('span', null, h('span', { class: 'nowrap' }, fmtPct(ch.pct, { signed: true })), ' ', h('span', { class: 'nowrap' }, `(${abs})`)) : h('span', { class: 'nowrap' }, abs);
  }
  const asOfText = (iso, fallbackDate) => (iso ? `as of ${fmtDateTime(iso)}` : fallbackDate ? `as of ${fmtDate(fallbackDate)} (daily data)` : null);
  // One-line verdict from the health grid: notable asset-health states (data quality counted apart).
  function healthVerdict(rowKeys) {
    const ins = P().insights || {};
    const hg = ins.health;
    if (!hg || !hg.cells) return null;
    const groups = { notable_negative: [], notable_positive: [], notable_neutral: [] };
    let pairs = 0, thin = 0;
    for (const a of rowKeys) {
      const row = hg.cells[a];
      if (!row) continue;
      for (const dim of hg.dimensions || Object.keys(row)) {
        if (dim === 'data' || !row[dim] || !(row[dim].tests > 0)) continue;
        pairs++;
        if (groups[row[dim].state]) groups[row[dim].state].push(`${labelOf(a)}: ${dim}`);
        else if (row[dim].state === 'insufficient_history') thin++;
      }
    }
    if (!pairs) return null;
    const dq = [...(ins.feed || []).flatMap((c) => [c.lead, ...(c.related || [])]), ...(ins.standing || [])].filter((i) => isDataQuality(i) && rowKeys.includes(i.asset)).length;
    const part = (k, label) => (groups[k].length ? `${groups[k].length} ${label} (${groups[k].join(', ')})` : null);
    const flagged = [part('notable_negative', 'unusual and negative'), part('notable_positive', 'unusual and positive'), part('notable_neutral', 'unusual, neutral')].filter(Boolean);
    const n = flagged.length ? groups.notable_negative.length + groups.notable_positive.length + groups.notable_neutral.length : 0;
    // The rest are within their own history, except cells with too little history to judge.
    const normal = pairs - n - thin;
    const rest = `${fmtCount(normal)} asset-dimension pair${normal === 1 ? ' is' : 's are'} within their own history${thin ? ` and ${fmtCount(thin)} ha${thin === 1 ? 's' : 've'} too little history to judge` : ''}`;
    return `Health checks: ${flagged.length ? `${flagged.join('; ')}; of the others, ${rest}` : rest}.${dq ? ` Data quality: ${plural(dq, 'source note')} (shown apart from asset health).` : ''}`;
  }
  // The all-asset USD value: say what it includes and what it cannot value.
  function allUsdRow(p) {
    const x = p.totals && p.totals.allUsd;
    if (!x) return null;
    const missing = Array.isArray(x.missing) ? x.missing : [];
    const included = discovered().filter((d) => d.status !== 'dead' && d.data && isNum(d.data.current && d.data.current.supplyUsd) && !missing.includes(d.key));
    const value = isNum(x.current) ? fmtUsd(x.current) : isNum(x.coveredUsd) ? `≥ ${fmtUsd(x.coveredUsd)}` : 'n/a';
    const sub = [included.length ? `incl. ${included.map((d) => d.key + (d.status !== 'active' ? ` (${d.status})` : '')).join(', ')}` : null, missing.length ? `excludes ${missing.join(', ')} (no USD value in this snapshot)` : null].filter(Boolean).join('; ');
    return h('div', { class: 'row' }, h('span', null, x.label || 'All Paxos-issued value (USD)', sub ? h('span', { class: 'small muted' }, h('br'), sub) : null), h('span', { class: 'nowrap' }, value));
  }
  function chainsTile(d, tile) {
    const a = d.data;
    const cc = chainCount(a, floorOf(d.key), addressesOf(d.key));
    const largest = (a.chains || []).find((c) => isNum(c.currentUsd) && c.currentUsd > 0);
    const metaTxt = cc.basis === 'balances' ? `${cc.n === cc.of ? '' : `of ${cc.of} tracked; `}largest: ${largest ? `${largest.chain} ${fmtShare(largest.share)}` : 'n/a'}` : cc.basis === 'contracts' ? 'from discovered contracts; no per-chain balances' : 'no per-chain data';
    return tile('Chains', isNum(cc.n) ? fmtCount(cc.n) : 'n/a', metaTxt);
  }

  // 2. Hero + KPI row
  function renderHero() {
    const p = P();
    const r = rng();
    const end = endIso();
    const wrap = [];
    if (state.asset === 'all') {
      const t = p.totals.usd;
      const golds = visibleAssets().filter((d) => !isUsdKind(d) && d.status !== 'dead' && d.data);
      const notIn = (p.discovery.assets || []).filter((d) => d.kind === 'usd-stablecoin' && d.status !== 'active' && !(t.assets || []).includes(d.key) && p.assets[d.key] && isNum(p.assets[d.key].current.supplyUsd));
      const verdict = healthVerdict(healthRows());
      wrap.push(
        h(
          'div',
          { class: 'hero' },
          h(
            'div',
            null,
            h('div', { class: 'k' }, `${t.label || 'Active Paxos USD stablecoins'}, total supply`),
            h('div', { class: 'fig' }, fmtUsd(t.current)),
            h('div', { class: 'deltas' }, ['d1', 'd7', 'd30'].map((w) => h('span', null, `${w.slice(1)}d `, h('b', null, deltaNode(t.change && t.change[w], 'USD'))))),
            h('div', { class: 'k' }, [`Sum of ${(t.assets || []).join(', ')}`, asOfText(t.supplyAsOf, compactEnd(t.supplyUsd))].filter(Boolean).join(', ')),
            notIn.length ? h('div', { class: 'k' }, `Not included: ${notIn.map((d) => `${d.key} (${d.status}, ${fmtUsd(p.assets[d.key].current.supplyUsd)})`).join(', ')}`) : null,
          ),
          h(
            'div',
            { class: 'side' },
            h('div', { class: 'row' }, h('span', null, 'Share of USD stablecoin market'), h('span', null, fmtShare(t.shareCurrent))),
            isNum(t.rankEquivalent) ? h('div', { class: 'row' }, h('span', null, 'Rank if it were one stablecoin'), h('span', null, `#${t.rankEquivalent}`)) : null,
            t.ath ? h('div', { class: 'row' }, h('span', null, 'Below peak'), h('span', null, `${fmtPct(t.drawdownPct)} (peak ${fmtUsd(t.ath.value)}, ${fmtDate(t.ath.date)})`)) : null,
            golds.map((g) => h('div', { class: 'row' }, h('span', null, `${g.key} (${g.name || g.kind})`), h('span', null, `${fmtUsd(g.data.current.supplyUsd)} · ${fmtUnit(g.data.current.supply, g.unit)}`))),
            allUsdRow(p),
          ),
        ),
      );
      if (verdict) wrap.push(h('p', { class: 'verdict' }, verdict));
      const tiles = bySupply(visibleAssets())
        .filter((d) => d.data)
        .map((d) => {
          const a = d.data;
          const s = supplySeries(d);
          const ch = assetChange(d, r, end);
          return h(
            'button',
            { type: 'button', class: 'tile', 'data-asset': d.key },
            h('span', { class: 'label' }, swatch(colorOf(d.key)), d.key, d.status !== 'active' ? h('span', { class: 'badge' }, d.status) : null),
            h('span', { class: 'value' }, fmtUsd(a.current.supplyUsd)),
            h('span', { class: 'meta' }, `${ch && ch.from && r.win === 'all' ? 'since ' + fmtDate(ch.from) : r.label} `, deltaNode(ch, unitOfAsset(d))),
            h('span', { class: 'meta' }, d.kind === 'gold' ? `XAU premium ${fmtBp(a.current.pegDevBp)}` : `Peg ${fmtBp(a.current.pegDevBp)}`),
            spark((sliceCompact(s, r.days, end) || { values: [] }).values, colorOf(d.key)),
            h('span', { class: 'sr-only' }, `. Show only ${d.key}`),
          );
        });
      wrap.push(h('div', { class: 'tiles', role: 'group', 'aria-label': 'Per-asset supply; select one to filter the page' }, tiles));
      return wrap;
    }
    const d = meta(state.asset);
    const a = d && d.data;
    if (!a) return h('p', { class: 'placeholder' }, `No data for ${state.asset} in this snapshot.`);
    const usd = isUsdKind(d);
    const s = supplySeries(d);
    const c = a.current;
    const verdict = healthVerdict([d.key]);
    wrap.push(
      h(
        'div',
        { class: 'hero' },
        h(
          'div',
          null,
          h('div', { class: 'k' }, swatch(colorOf(d.key)), ` ${d.key} · ${d.name || ''}${d.status !== 'active' ? ' (' + d.status + ')' : ''}`),
          h('div', { class: 'fig' }, fmtUsd(c.supplyUsd)),
          !usd ? h('div', { class: 'k' }, `${fmtUnit(c.supply, d.unit)} in circulation`) : null,
          h('div', { class: 'deltas' }, [['d1', 1], ['d7', 7], ['d30', 30]].map(([w, n]) => h('span', null, `${n}d `, h('b', null, deltaNode(assetChangeDays(d, n, w, end), unitOfAsset(d)))))),
          h('div', { class: 'k' }, [usd ? 'Supply' : `Supply in ${d.unit}`, asOfText(c.supplyAsOf, compactEnd(s))].join(', ')),
        ),
        h(
          'div',
          { class: 'side' },
          isNum(c.marketShare) ? h('div', { class: 'row' }, h('span', null, 'Share of USD stablecoin market'), h('span', null, fmtShare(c.marketShare))) : null,
          isNum(c.rank) ? h('div', { class: 'row' }, h('span', null, 'Rank by supply'), h('span', null, `#${c.rank}${isNum(c.rankOf) ? ' of ' + fmtCount(c.rankOf) : ''}`)) : null,
          h('div', { class: 'row' }, h('span', null, 'Price'), h('span', null, `${isNum(c.price) ? '$' + c.price.toLocaleString('en-US', { maximumSignificantDigits: 6 }) : 'n/a'} (${d.kind === 'gold' ? 'XAU premium' : 'peg'} ${fmtBp(c.pegDevBp)})`)),
          usd && c.ath ? h('div', { class: 'row' }, h('span', null, 'Below peak'), h('span', null, `${fmtPct(c.drawdownPct)} (peak ${fmtUsd(c.ath.value)}, ${fmtDate(c.ath.date)})`)) : null,
          !usd && c.nativeAth ? h('div', { class: 'row' }, h('span', null, 'Supply below peak'), h('span', null, `${fmtPct(c.nativeDrawdownPct)} (peak ${fmtUnit(c.nativeAth.value, c.nativeAthUnit || d.unit)}, ${fmtDate(c.nativeAth.date)})`)) : null,
          // USD market value of a non-USD asset moves with its reference price: a value change, not issuance.
          !usd && c.change && c.change.d30 ? h('div', { class: 'row' }, h('span', null, 'Value change, 30d (USD, incl. price)'), h('span', null, deltaNode(c.change.d30, 'USD'))) : null,
        ),
      ),
    );
    if (verdict) wrap.push(h('p', { class: 'verdict' }, verdict));
    const ch = assetChange(d, r, end);
    const tile = (label, value, metaTxt, sp) => h('div', { class: 'tile' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, value), metaTxt ? h('span', { class: 'meta' }, metaTxt) : null, sp || null);
    wrap.push(
      h(
        'div',
        { class: 'tiles' },
        tile(`Supply change, ${r.text}`, ch ? h('span', { class: 'nowrap' }, fmtUnit(ch.abs, unitOfAsset(d), { signed: true })) : 'n/a', ch && isNum(ch.pct) ? fmtPct(ch.pct, { signed: true }) : ch && ch.from ? `since ${fmtDate(ch.from)}` : null, spark((sliceCompact(s, r.days, end) || { values: [] }).values, colorOf(d.key))),
        tile(d.kind === 'gold' ? 'Premium vs XAU' : 'Peg deviation', fmtBp(c.pegDevBp), c.pegAsOf ? `price as of ${fmtDateTime(c.pegAsOf)}` : 'latest price'),
        tile('24h turnover', isNum(c.turnover24h) ? fmtShare(c.turnover24h) : 'n/a', isNum(c.volume24hUsd) ? `${fmtUsd(c.volume24hUsd)} volume` : null),
        chainsTile(d, tile),
        a.defi ? tile('DeFi footprint', fmtUsd(a.defi.footprintUsd), `${fmtShare(a.defi.footprintShare)} of supply (upper bound)`) : null,
      ),
    );
    return wrap;
  }

  // 3. What's unusual
  const POLARITY = { positive: { ico: '+', label: 'Positive' }, negative: { ico: '!', label: 'Negative' }, neutral: { ico: '◆', label: 'Neutral' } };
  const DQ_CHIP = { ico: 'i', label: 'Data quality' };
  function chips(ins, { age = true } = {}) {
    const dq = isDataQuality(ins);
    const pol = dq ? DQ_CHIP : POLARITY[ins.polarity] || POLARITY.neutral;
    const isNewToYou = state.seenBefore && !state.seenBefore.has(ins.id);
    const at = age ? ageText(ins.novelty) : null;
    return h(
      'div',
      { class: 'chips' },
      h('span', { class: `chip ${dq ? 'pol-dq' : 'pol-' + (POLARITY[ins.polarity] ? ins.polarity : 'neutral')}` }, h('span', { class: 'ico', 'aria-hidden': 'true' }, pol.ico), pol.label),
      dq ? null : h('span', { class: 'badge' }, ins.dimension),
      h('span', { class: 'badge' }, meta(ins.asset) ? swatch(colorOf(ins.asset)) : null, meta(ins.asset) ? ' ' : null, labelOf(ins.asset) + (ins.chain ? ` · ${ins.chain}` : '')),
      at ? h('span', { class: 'badge' }, at) : null,
      isNewToYou ? h('span', { class: 'badge new-you' }, 'new to you') : null,
    );
  }
  function evidenceBlock(ins) {
    const e = ins.evidence || {};
    const unit = evidenceUnit(e);
    const rows = [
      ['Metric', e.metric],
      ['Value', fmtEvidence(e.value, unit)],
      ['Baseline', fmtEvidence(e.baseline, unit)],
      ['Window', e.window],
      ['Statistic', e.stat],
      ['Sample', isNum(e.n) || isNum(e.nEff) ? `n = ${fmtCount(e.n)}${isNum(e.nEff) ? `, effective ${fmtCount(e.nEff)}` : ''}` : null],
      ['Other windows', (e.otherWindows || []).length ? e.otherWindows.map((o) => `${o.window} p=${fmtP(o.p)}`).join(', ') : null],
      ['Materiality', isNum(ins.materialityUsd) ? `${fmtUsd(ins.materialityUsd)}${isNum(ins.materialityFloorUsd) ? ` (floor ${fmtUsd(ins.materialityFloorUsd)})` : ''}${isNum(ins.materialityShare) ? `, ${fmtShare(ins.materialityShare)} of Paxos supply` : ''}` : null],
      ['As of', ins.asOf ? fmtDateTime(ins.asOf) : null],
    ].filter((r) => r[1] !== null && r[1] !== undefined && r[1] !== '');
    const ser = e.series && Array.isArray(e.series.values) ? e.series : null;
    return fold(
      'ev:' + ins.id,
      'Evidence',
      h(
        'div',
        null,
        ins.detail ? h('p', { class: 'small' }, ins.detail) : null,
        h('dl', null, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
        ser && ser.values.filter(isNum).length > 1 ? h('div', null, h('span', { class: 'small muted' }, `Tested series from ${fmtDate(ser.start)} (${plural(ser.values.length, 'day')})`), spark(ser.values, colorOf(ins.asset), { w: 240, h: 40 })) : null,
      ),
      '',
    );
  }
  const cardLabel = (ins) => (isDataQuality(ins) ? `Data-quality note for ${labelOf(ins.asset)} (about the data sources, not the asset's health)` : `${(POLARITY[ins.polarity] || POLARITY.neutral).label} ${ins.dimension} finding for ${labelOf(ins.asset)}`);
  function insightCard(ins, related, level = 3) {
    const H = level === 3 ? 'h3' : 'h4';
    const card = h('article', { class: 'card ins' + (isDataQuality(ins) ? ' dq' : ''), 'aria-label': cardLabel(ins) }, chips(ins), h(H, null, ins.headline), h('p', { class: 'why' }, 'Why flagged: ', whyText(ins)), evidenceBlock(ins));
    if (related && related.length) {
      card.append(fold('rel:' + ins.id, `${plural(related.length, 'related finding')}`, h('ul', { class: 'related' }, related.map((r) => h('li', { class: isDataQuality(r) ? 'dq' : null }, chips(r), h('h4', null, r.headline), h('p', { class: 'why' }, 'Why flagged: ', whyText(r)), evidenceBlock(r)))), ''));
    }
    return card;
  }
  function renderUnusual() {
    const ins = P().insights || {};
    const feed = ins.feed || [];
    const key = state.asset;
    const shown = feed.filter((c) => [c.lead, ...(c.related || [])].some((i) => i && insightMatches(i, key)));
    // Asset health first; data-quality notes (sources, coverage) follow in their own group.
    const health = shown.filter((c) => !isDataQuality(c.lead));
    const dq = shown.filter((c) => isDataQuality(c.lead));
    const checks = `${fmtCount(ins.testsRun)} checks run${isNum(ins.groups) ? ` in ${fmtCount(ins.groups)} groups` : ''}`;
    // The rule allows fewer than one chance finding per health dimension per load (#64): say how many.
    const fam = ins.family && isNum(ins.family.dimensions) && ins.family.dimensions > 0 ? ins.family : null;
    const chance = fam ? ` Up to about ${plural(fam.dimensions, 'finding')} per load can be chance (fewer than one per health dimension).` : '';
    $('sub-unusual').textContent = `Findings that are rare for the asset's own history or its peers, after allowing for the number of checks run, ranked by surprise, materiality and recency without weights. They describe the latest data; the range filter does not apply. ${checks}.${chance}`;
    const out = [];
    if (!health.length) {
      out.push(h('div', { class: 'card empty' }, h('p', null, h('strong', null, key === 'all' ? 'Nothing statistically unusual today' : `Nothing statistically unusual for ${key} today`)), h('p', { class: 'small muted' }, `${checks}${key !== 'all' && feed.length > shown.length ? `; ${plural(feed.length - shown.length, 'finding')} concern${feed.length - shown.length === 1 ? 's' : ''} other assets` : ''}.`)));
    } else {
      const limit = 6;
      const more = state.more.has('feed');
      out.push(h('div', { class: 'feed' }, (more ? health : health.slice(0, limit)).map((c) => insightCard(c.lead, c.related || []))));
      if (health.length > limit) out.push(h('button', { type: 'button', class: 'btn', 'data-more': 'feed', 'aria-expanded': String(more) }, more ? `Show the top ${limit}` : `Show all ${health.length} findings`));
    }
    if (dq.length) {
      out.push(
        h('h3', { class: 'dq-head' }, `Data-quality notes (${dq.length})`),
        h('p', { class: 'small muted' }, 'About the data sources (coverage, freshness, disagreement between sources), not about the assets themselves.'),
        h('div', { class: 'feed' }, dq.map((c) => insightCard(c.lead, c.related || []))),
      );
    }
    return out;
  }

  // 4. What changed
  function waterfallFigure(key, title, sub, rows, net, unitNote) {
    let cum = 0;
    const bars = rows.map((r) => {
      const s = cum;
      cum += r.delta;
      return [s, cum];
    });
    const labels = [...rows.map((r) => r.label), 'Net change'];
    const data = [...bars, [0, net]];
    const colors = [...rows.map((r) => (r.delta >= 0 ? TOK['div-pos'] : TOK['div-neg'])), TOK['ink-2']];
    const truncate = (s) => (s.length > 22 ? s.slice(0, 21) + '…' : s);
    const height = Math.max(140, labels.length * 28 + 50);
    const fig = figure({
      key,
      title,
      sub,
      signed: true,
      label: `${title}: ${labels.map((l, i) => `${l} ${fmtUsd(i < rows.length ? rows[i].delta : net, { signed: true })}`).join(', ')}`,
      config: () => ({
        type: 'bar',
        data: { labels, datasets: [{ label: 'Change', data, backgroundColor: colors, borderRadius: 4, borderSkipped: false, maxBarThickness: 20, categoryPercentage: 0.82, barPercentage: 0.9 }] },
        options: {
          indexAxis: 'y',
          interaction: { mode: 'nearest', axis: 'y', intersect: false },
          scales: {
            x: axisY((v) => fmtUsd(v, { signed: true }), { grid: { color: (c) => (c.tick && c.tick.value === 0 ? TOK.axis : TOK.hair), drawTicks: false } }),
            y: { grid: { display: false }, border: { color: TOK.axis }, ticks: { color: TOK['ink-2'], autoSkip: false, callback(v) {
              return truncate(String(this.getLabelForValue(v)));
            } } },
          },
          plugins: {
            tooltip: {
              usePointStyle: false,
              callbacks: {
                title: (it) => it[0].label,
                label: (c) => {
                  const r = rows[c.dataIndex];
                  if (!r) return ` ${fmtUsd(net, { signed: true })} net`;
                  return [` ${fmtUsd(r.delta, { signed: true })}`, ...(r.prev !== undefined ? [` ${fmtUsd(r.prev)} → ${fmtUsd(r.curr)}`] : [])];
                },
              },
            },
          },
        },
      }),
      tableView: () => table({ head: ['Contributor', 'Before', 'After', 'Change'], rows: [...rows.map((r) => ({ cells: [r.label, r.prev !== undefined ? fmtUsd(r.prev) : '', r.curr !== undefined ? fmtUsd(r.curr) : '', fmtUsd(r.delta, { signed: true })] })), { cells: ['Net change', '', '', fmtUsd(net, { signed: true })] }] }),
    });
    const box = fig.querySelector('.chart-box');
    if (box) box.style.height = height + 'px';
    if (unitNote) fig.append(h('p', { class: 'small muted' }, unitNote));
    return fig;
  }
  // Top contributors by |delta| until the display budget, the rest folded into "Other".
  function topRows(rows, max) {
    const s = rows.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    if (s.length <= max) return s;
    const keep = s.slice(0, max - 1);
    const rest = s.slice(max - 1);
    keep.push({ label: `Other (${rest.length})`, delta: rest.reduce((t, r) => t + r.delta, 0), prev: rest.reduce((t, r) => t + (r.prev || 0), 0), curr: rest.reduce((t, r) => t + (r.curr || 0), 0) });
    return keep;
  }
  function renderChanged() {
    const p = P();
    const r = rng();
    const w = p.attribution && p.attribution.windows ? p.attribution.windows[r.win] : null;
    const flows = Object.values(p.assets || {}).some((a) => a && a.current && a.current.changeBasis === 'token-flow');
    $('sub-changed').textContent = `Change in the supply of active Paxos USD stablecoins over ${r.text}, split by asset and by chain${flows ? ' (token flows at today\'s price, so a peg wobble is not a supply change)' : ''}. Bars run from the previous running total; the last bar is the net change.`;
    const max = root.innerWidth < 600 ? 6 : 9;
    const out = [];
    if (!w) {
      out.push(h('p', { class: 'placeholder' }, `Attribution for ${r.text} is not in this snapshot.`));
      return out;
    }
    const period = `${fmtDate(w.from)} to ${fmtDate(w.to)}`;
    if (state.asset === 'all') {
      const stat = (label, v, m) => h('div', { class: 'tile' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, v), m ? h('span', { class: 'meta' }, m) : null);
      out.push(
        h(
          'div',
          { class: 'tiles' },
          stat('Net change', fmtUsd(w.totalDeltaUsd, { signed: true }), period),
          stat('Gross movement', fmtUsd(w.grossUsd), 'sum of absolute changes by asset and chain'),
          stat('Rotation', fmtUsd(w.rotationUsd), 'moved between chains or assets without changing the total'),
        ),
      );
      const aRows = (w.assets || []).map((x) => ({ label: x.asset, delta: x.deltaUsd, prev: x.prevUsd, curr: x.currUsd }));
      const cRows = (w.chains || []).map((x) => ({ label: `${x.asset} · ${x.chain}`, delta: x.deltaUsd, prev: x.prevUsd, curr: x.currUsd }));
      const net = isNum(w.totalDeltaUsd) ? w.totalDeltaUsd : aRows.reduce((s, x) => s + x.delta, 0);
      const chainTop = topRows(cRows, max);
      const resid = net - cRows.reduce((s, x) => s + x.delta, 0);
      if (cRows.length && Math.abs(resid) > 0.001 * (w.grossUsd || Math.abs(net) || 1)) chainTop.push({ label: 'Unattributed', delta: resid });
      out.push(h('div', { class: 'grid g2' }, h('div', { class: 'card' }, waterfallFigure('wf-assets', 'By asset', period, topRows(aRows, max), net)), h('div', { class: 'card' }, cRows.length ? waterfallFigure('wf-chains', 'By chain', period, chainTop, net) : h('p', { class: 'placeholder' }, 'No per-chain balances in this window.'))));
      return out;
    }
    const d = meta(state.asset);
    const ar = (w.assets || []).find((x) => x.asset === state.asset);
    if (!ar) {
      const ch = d && d.data ? assetChange(d, r, endIso()) : null;
      out.push(h('div', { class: 'card' }, h('p', null, `${state.asset} is not part of the USD attribution. Supply change over ${r.text}: `, h('strong', null, ch ? deltaNode(ch, unitOfAsset(d)) : 'n/a'), '.'), h('p', { class: 'small muted' }, (d && d.data && (d.data.chains || []).length) ? '' : 'No per-chain balances are available for this asset.')));
      return out;
    }
    const cRows = (w.chains || []).filter((x) => x.asset === state.asset).map((x) => ({ label: x.chain, delta: x.deltaUsd, prev: x.prevUsd, curr: x.currUsd }));
    const gross = cRows.reduce((s, x) => s + Math.abs(x.delta), 0);
    const net = ar.deltaUsd;
    const stat = (label, v, m) => h('div', { class: 'tile' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, v), m ? h('span', { class: 'meta' }, m) : null);
    out.push(
      h(
        'div',
        { class: 'tiles' },
        stat('Net change', fmtUsd(net, { signed: true }), `${fmtUsd(ar.prevUsd)} → ${fmtUsd(ar.currUsd)}`),
        cRows.length ? stat('Gross chain movement', fmtUsd(gross), period) : null,
        cRows.length ? stat('Chain rotation', fmtUsd(Math.max(0, (gross - Math.abs(cRows.reduce((s, x) => s + x.delta, 0))) / 2)), 'moved between chains without changing the total') : null,
      ),
    );
    if (!cRows.length) {
      out.push(h('p', { class: 'placeholder' }, `No per-chain balances for ${state.asset}; only the asset total is attributed.`));
      return out;
    }
    const top = topRows(cRows, max);
    const resid = net - cRows.reduce((s, x) => s + x.delta, 0);
    if (Math.abs(resid) > 0.001 * (gross || Math.abs(net) || 1)) top.push({ label: 'Unattributed', delta: resid });
    out.push(h('div', { class: 'card' }, waterfallFigure('wf-chain-one', `${state.asset} by chain`, period, top, net, Math.abs(resid) > 0.001 * (gross || 1) ? 'Chain balances and the asset total come from different DefiLlama endpoints; the difference is shown as "Unattributed".' : null)));
    return out;
  }

  // 5. Health grid
  const STATES = {
    notable_negative: { ico: '!', label: 'Negative', long: 'unusual and negative' },
    notable_positive: { ico: '+', label: 'Positive', long: 'unusual and positive' },
    notable_neutral: { ico: '◆', label: 'Neutral', long: 'unusual, neither good nor bad' },
    within_own_history: { ico: '○', label: 'Normal', long: 'within its own history' },
    insufficient_history: { ico: '?', label: 'Thin data', long: 'too little history to judge' },
    no_data: { ico: '–', label: 'No data', long: 'no checks ran' },
  };
  // The data dimension judges the sources, not the asset: its notable cells are data-quality notes.
  const DQ_STATE = { ico: 'i', label: 'Source note', long: 'data-quality note about the sources, not the asset' };
  const isNotable = (st) => /^notable_/.test(String(st || ''));
  const cellState = (dim, cell) => (dim === 'data' && isNotable(cell.state) ? { ...DQ_STATE, cls: 'st-dq' } : { ...(STATES[cell.state] || STATES.no_data), cls: `st-${cell.state}` });
  // The server sends a cell's evidence as { id, headline, polarity, p, E } or null.
  function cellEvidence(cell) {
    return cell && cell.evidence && typeof cell.evidence === 'object' ? cell.evidence : null;
  }
  function healthDetail(a, dim, cell) {
    const st = cellState(dim, cell);
    const ev = cellEvidence(cell);
    const evText = ev && ev.headline ? ev.headline : null;
    return [h('strong', null, `${labelOf(a)} · ${dim === 'data' ? 'data quality' : dim}: `), `${st.long[0].toUpperCase()}${st.long.slice(1)}. ${plural(cell.tests || 0, 'check')}, ${fmtCount(cell.notable || 0)} notable.`, evText ? [h('br'), 'Evidence: ', evText] : null];
  }
  function renderHealth() {
    const hg = (P().insights || {}).health;
    if (!hg || !Array.isArray(hg.dimensions) || !hg.cells) return h('p', { class: 'placeholder' }, 'The health grid is not in this snapshot.');
    const known = new Set(discovered().map((d) => d.key));
    const rows = healthRows();
    if (!rows.length) return h('p', { class: 'placeholder' }, `No health checks for ${state.asset} in this snapshot.`);
    const detail = h('div', { class: 'hc-detail', 'aria-live': 'polite' }, 'Select a cell to see its strongest evidence.');
    const show = (btn) => {
      const [a, dim] = [btn.dataset.a, btn.dataset.d];
      for (const b of tbl.querySelectorAll('.hc[aria-pressed="true"]')) b.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-pressed', 'true');
      detail.replaceChildren(...healthDetail(a, dim, hg.cells[a][dim]).flat().filter(Boolean));
    };
    const key = h('p', { class: 'hg-key' }, 'States: ! unusual and negative · + unusual and positive · ◆ unusual, neutral · ○ within own history · ? too little history · – no checks ran. The data-quality column judges the sources (i = source note), not the asset.');
    const tbl = table({
      cls: 'hg',
      caption: `Health by asset and dimension (${plural(rows.length, 'row')})`,
      head: ['Asset', ...hg.dimensions.map((dim) => (dim === 'data' ? 'data quality' : dim))],
      rows: rows.map((a) => ({
        cells: [
          known.has(a) ? assetLabel(a) : h('span', { class: 'asset-cell' }, labelOf(a), h('span', { class: 'badge' }, 'aggregate')),
          ...hg.dimensions.map((dim) => {
            const cell = hg.cells[a][dim] || { state: 'no_data', tests: 0 };
            const st = cellState(dim, cell);
            return h('button', { type: 'button', class: `hc ${st.cls}`, 'data-a': a, 'data-d': dim, 'aria-pressed': 'false', 'aria-label': `${labelOf(a)} ${dim === 'data' ? 'data quality' : dim}: ${st.label}, ${st.long}. ${plural(cell.tests || 0, 'check')}.` }, h('span', { class: 'ico', 'aria-hidden': 'true' }, st.ico), h('span', null, st.label));
          }),
        ],
      })),
    });
    tbl.addEventListener('click', (e) => {
      const b = e.target.closest('.hc');
      if (b) show(b);
    });
    tbl.addEventListener('focusin', (e) => {
      const b = e.target.closest('.hc');
      if (b) show(b);
    });
    const summaries = h(
      'ul',
      { class: 'summaries' },
      rows.map((a) => {
        const entries = Object.entries(hg.cells[a] || {});
        const cells = entries.filter(([dim]) => dim !== 'data').map(([, c]) => c);
        const dataCell = (hg.cells[a] || {}).data;
        const n = cells.reduce((s, c) => s + (c.tests || 0), 0);
        const k = cells.filter((c) => (c.tests || 0) > 0).length;
        const count = (s) => cells.filter((c) => c.state === s).length;
        const dq = dataCell && isNotable(dataCell.state) ? `; data quality: ${plural(dataCell.notable || 1, 'source note')}` : '';
        return h('li', null, h('strong', null, labelOf(a)), `: ${plural(n, 'check')} in ${plural(k, 'dimension')} → ${count('notable_negative')} notable negative, ${count('notable_positive')} positive, ${count('notable_neutral')} neutral, ${count('within_own_history')} within own history${count('insufficient_history') ? `, ${count('insufficient_history')} with too little history` : ''}${dq}.`);
      }),
    );
    return [key, tbl, detail, summaries];
  }

  // 6. Asset table
  function chainCell(d) {
    const cc = chainCount(d.data, floorOf(d.key), addressesOf(d.key));
    if (!isNum(cc.n)) return h('span', { title: 'No per-chain data or contracts in this snapshot' }, 'n/a');
    const note = cc.basis === 'contracts' ? 'contracts' : cc.n !== cc.of ? `of ${fmtCount(cc.of)} tracked` : null;
    const title = cc.basis === 'contracts' ? 'Chains with a discovered contract or an on-chain reading; DefiLlama has no per-chain balances for this asset' : `Chains holding at least the asset's materiality floor${isNum(floorOf(d.key)) ? ` (${fmtUsd(floorOf(d.key))})` : ''}; ${fmtCount(cc.of)} chains are tracked in all`;
    return h('span', { title }, fmtCount(cc.n), note ? h('div', { class: 'small muted nowrap' }, note) : null);
  }
  function renderAssets() {
    const r = rng();
    const end = endIso();
    const list = bySupply(visibleAssets()).filter((d) => d.data);
    const head = ['Asset', 'Supply', '1d', '7d', '30d', '90d', 'From peak', { t: 'Peg (bp)' }, 'Rank', 'Mkt share', '24h turnover', 'Chains', `Trend (${r.label})`];
    // Percent change with the amount underneath (visible, not a hover-only title).
    const pct = (ch, unit) => (ch && (isNum(ch.pct) || isNum(ch.abs)) ? h('span', null, h('span', { class: 'nowrap' }, isNum(ch.pct) ? fmtPct(ch.pct, { signed: true }) : 'n/a'), h('div', { class: 'small muted nowrap' }, fmtUnit(ch.abs, unit, { signed: true }))) : 'n/a');
    const rows = list.map((d) => {
      const a = d.data;
      const c = a.current || {};
      const s = supplySeries(d);
      const usd = isUsdKind(d);
      const dd = usd ? c.drawdownPct : c.nativeDrawdownPct;
      return {
        sel: state.asset === d.key,
        cells: [
          h('span', { class: 'asset-cell' }, swatch(colorOf(d.key)), h('button', { type: 'button', class: 'btn-link', 'data-asset': d.key }, d.key, h('span', { class: 'sr-only' }, ': show only this asset')), d.status !== 'active' ? h('span', { class: 'badge' }, d.status) : null),
          h('span', { class: 'nowrap' }, fmtUsd(c.supplyUsd), !usd ? h('div', { class: 'small muted' }, fmtUnit(c.supply, d.unit)) : null),
          ...[[1, 'd1'], [7, 'd7'], [30, 'd30'], [90, 'd90']].map(([n, w]) => pct(assetChangeDays(d, n, w, end), unitOfAsset(d))),
          isNum(dd) ? fmtPct(dd) : 'n/a',
          h('span', { title: d.kind === 'gold' ? 'Premium of the price in XAU over 1 oz' : 'Deviation of the price from $1' }, fmtBp(c.pegDevBp)),
          isNum(c.rank) ? `#${c.rank}` : 'n/a',
          isNum(c.marketShare) ? fmtShare(c.marketShare) : 'n/a',
          isNum(c.turnover24h) ? fmtShare(c.turnover24h) : 'n/a',
          chainCell(d),
          spark((sliceCompact(s, r.days, end) || { values: [] }).values, colorOf(d.key), { w: 90, h: 22 }),
        ],
      };
    });
    const leg = legacyCount();
    const units = list.filter((d) => !isUsdKind(d)).map((d) => `${d.key} in ${d.unit}`);
    const asOfs = [...new Set(list.map((d) => d.data.current && d.data.current.supplyAsOf).filter(Boolean))];
    const asOf = asOfs.length === 1 ? `Supply as of ${fmtDateTime(asOfs[0])}. ` : asOfs.length > 1 ? `Supply as of ${asOfs.map(fmtDateTime).join(' / ')} (per asset). ` : `Supply as of ${fmtDate(endIso())} (daily data). `;
    return [
      table({ note: `${asOf}Changes are percentage changes of supply with the amount below (USD stablecoins in USD${units.length ? `; ${units.join(', ')}, not their USD value` : ''}). From peak: supply below its highest level. Chains: chains holding at least the asset's typical daily flow. Rank and share are among live USD stablecoins.`, head, rows }),
      leg && !state.legacy ? h('p', { class: 'small muted' }, `${plural(leg, 'legacy or dead asset')} hidden. Use "Show legacy" above to include them.`) : null,
    ];
  }

  // 7. Supply over time
  // Where a series starts later than its asset existed, say so (its opening balance is not issuance).
  function lateStarts(keys, pick) {
    return keys
      .map((k) => {
        const d = meta(k);
        const f = compactFirst(pick(k));
        return d && f && !startsAtLaunch(pick(k), d.firstDate) && d.firstDate ? `${k} from ${fmtDate(f.date)} (first seen ${fmtDate(d.firstDate)})` : null;
      })
      .filter(Boolean);
  }
  // Start of the market-share line: the server's coverage date when it sends one, else the same rule
  // computed here from the market total (see coverageStart).
  function marketCoverage() {
    const p = P();
    const mk = p.market && p.market.usdTotal;
    const from = (p.market && typeof p.market.coverageFrom === 'string' && p.market.coverageFrom) || coverageStart(mk, { week: 7, horizon: rangeById('1y').days });
    if (!from || !mk) return null;
    const prev = compactAt(mk, addDays(from, -1));
    const at = compactAt(mk, from);
    return { from, rise: isNum(prev) && prev > 0 && isNum(at) ? (100 * (at - prev)) / prev : null };
  }
  function renderSupply() {
    const p = P();
    const r = rng();
    const end = endIso();
    const span = (start) => daysBetween(start, end);
    const out = [];
    const isAll = state.asset === 'all';
    const d1 = isAll ? null : meta(state.asset);
    const usdSer = (k) => (assetData(k) && assetData(k).series && assetData(k).series.supplyUsd) || null;
    const grid = h('div', { class: 'grid' });
    const goldGrid = h('div', { class: 'grid g2' });
    const notes = [];
    let net = null; // { members:[{key,c,launch}], unit, label }
    let shareSeries = null;
    const nonUsd = (isAll ? visibleAssets() : [d1]).filter((d) => d && d.data && !isUsdKind(d) && d.status !== 'dead');
    if (isAll || isUsdKind(d1)) {
      if (isAll) {
        const keys = (p.totals.usd.assets || []).filter(usdSer);
        // Legacy / dead USD assets join the stack (in gray, on top) only when "Show legacy" is on.
        const extra = state.legacy ? visibleAssets().filter((d) => isUsdKind(d) && d.status !== 'active' && !keys.includes(d.key) && usdSer(d.key)).map((d) => d.key) : [];
        if (!keys.length) grid.append(h('p', { class: 'placeholder' }, 'No supply history in this snapshot.'));
        const active = keys.slice().sort((a, b) => (isNum((meta(a) || {}).colorIndex) ? meta(a).colorIndex : 99) - (isNum((meta(b) || {}).colorIndex) ? meta(b).colorIndex : 99));
        const first = [...keys, ...extra].map((k) => compactFirst(usdSer(k))).filter(Boolean).map((x) => x.date).sort()[0];
        const start = rangeStart(first);
        const groups = [...active.map((k) => ({ label: k, color: colorOf(k), list: [usdSer(k)] })), extra.length ? { label: extra.length === 1 ? `${extra[0]} (${meta(extra[0]).status})` : `Legacy (${extra.join(', ')})`, color: TOK.neutral, list: extra.map(usdSer) } : null].filter(Boolean);
        const al = alignCompacts(groups.map((g) => sumCompacts(g.list, start, end)), start, end, 0);
        const labels = al.dates;
        const datasets = groups.map((g, i) => lineDataset(g.label, al.rows[i], g.color, { fill: i ? '-1' : 'origin', backgroundColor: alpha(g.color, 0.22), pointStyle: 'rect', spanGaps: true }));
        const table0 = () => table({ wrap: 'tall', head: ['Date', ...groups.map((g) => g.label), extra.length ? 'Total incl. legacy' : 'Total'], rows: labels.map((_, i) => labels.length - 1 - i).filter((i, j) => j % Math.max(1, Math.round(labels.length / 120)) === 0).map((i) => ({ cells: [labels[i], ...al.rows.map((row) => fmtUsd(row[i])), fmtUsd(al.rows.reduce((s, row) => s + (row[i] || 0), 0))] })) });
        const late = lateStarts([...keys, ...extra], usdSer).filter((x, i, xs) => xs.indexOf(x) === i);
        if (late.length) notes.push(`DefiLlama supply history starts late for ${late.join('; ')}; totals before then leave it out.`);
        $('sub-supply').textContent = `Active Paxos USD stablecoins stacked by asset over ${r.text}${extra.length ? `; legacy and dead assets (${extra.join(', ')}) are stacked on top in gray` : ''}.${nonUsd.length ? ` ${nonUsd.map((d) => d.key).join(', ')} ${nonUsd.length === 1 ? 'is' : 'are'} shown separately in ${[...new Set(nonUsd.map((d) => d.unit))].join(', ')} and USD.` : ''}`;
        net = { members: keys.map((k) => ({ key: k, c: usdSer(k), launch: startsAtLaunch(usdSer(k), (meta(k) || {}).firstDate) })), unit: 'USD', label: 'All active Paxos USD stablecoins' };
        shareSeries = p.totals.usd.marketShare;
        if (keys.length) grid.append(
          h('div', { class: 'card' }, figure({ key: 'supply-stack', title: 'USD stablecoin supply by asset', sub: `${fmtDate(start)} to ${fmtDate(end)}`, label: `Stacked supply of ${groups.map((g) => g.label).join(', ')}`, legend: groups.map((g) => ({ label: g.label, color: g.color })), config: () => lineConfig({ labels, datasets, yFmt: (v) => fmtUsd(v), spanDays: span(start), stacked: true }), tableView: table0 })),
        );
      } else if (!usdSer(d1.key)) {
        $('sub-supply').textContent = `${d1.key} supply over ${r.text}.`;
        grid.append(h('p', { class: 'placeholder' }, `No supply history for ${d1.key} in this snapshot.`));
      } else {
        $('sub-supply').textContent = `${d1.key} supply over ${r.text}.`;
        const s = usdSer(d1.key);
        const first = compactFirst(s);
        const start = rangeStart(first && first.date);
        const sl = alignCompacts([s], start, end);
        const labels = sl.dates;
        const gaps = gapNote(sl.rows[0]);
        const datasets = [lineDataset(d1.key, sl.rows[0], colorOf(d1.key), bridged({ fill: 'origin', backgroundColor: alpha(colorOf(d1.key), 0.1) }))];
        const late = lateStarts([d1.key], usdSer);
        if (late.length) notes.push(`DefiLlama supply history starts late: ${late[0]}.`);
        net = { members: [{ key: d1.key, c: s, launch: startsAtLaunch(s, d1.firstDate) }], unit: 'USD', label: d1.key };
        const mk = p.market && p.market.usdTotal;
        shareSeries = mk ? { start: s.start, values: s.values.map((v, i) => {
          const m = compactAt(mk, addDays(s.start, i));
          return isNum(v) && m ? v / m : null;
        }) } : null;
        grid.append(h('div', { class: 'card' }, figure({ key: 'supply-one', title: `${d1.key} supply (USD)`, sub: [`${fmtDate(start)} to ${fmtDate(end)}`, gaps].filter(Boolean).join('; '), config: () => lineConfig({ labels, datasets, yFmt: (v) => fmtUsd(v), spanDays: span(start), yExtra: { beginAtZero: true } }), tableView: () => seriesTable(labels, [{ label: d1.key, values: sl.rows[0], fmt: (v) => fmtUsd(v) }]) })));
      }
    } else if (d1) {
      $('sub-supply').textContent = `${d1.key} supply over ${r.text}, in ${d1.unit} and in USD.`;
    }
    for (const g of nonUsd) {
      const sN = (g.data.series || {}).supply;
      const sU = (g.data.series || {}).supplyUsd;
      if (!sN && !sU) continue;
      const first = compactFirst(sN || sU);
      const start = rangeStart(first && first.date);
      const al = alignCompacts([sN, sU], start, end);
      const mk = (key, title, vals, fmt) => {
        const gaps = gapNote(vals);
        return h('div', { class: 'card' }, figure({ key, title, sub: [`${fmtDate(start)} to ${fmtDate(end)}`, gaps].filter(Boolean).join('; '), size: isAll ? 'sm' : '', config: () => lineConfig({ labels: al.dates, datasets: [lineDataset(g.key, vals, colorOf(g.key), bridged({ fill: 'origin', backgroundColor: alpha(colorOf(g.key), 0.1) }))], yFmt: fmt, spanDays: span(start), yExtra: { beginAtZero: true } }), tableView: () => seriesTable(al.dates, [{ label: title, values: vals, fmt }]) }));
      };
      if (sN) goldGrid.append(mk('gold-n-' + g.key, `${g.key} supply (${g.unit})`, al.rows[0], (v) => fmtUnit(v, g.unit)));
      if (sU) goldGrid.append(mk('gold-u-' + g.key, `${g.key} value (USD)`, al.rows[1], (v) => fmtUsd(v)));
      if (!isAll) {
        const c = sN || sU;
        net = { members: [{ key: g.key, c, launch: startsAtLaunch(c, g.firstDate) }], unit: sN ? g.unit : 'USD', label: g.key };
        const late = lateStarts([g.key], () => c);
        if (late.length) notes.push(`Supply history starts late: ${late[0]}.`);
      }
    }
    out.push(grid);
    if (goldGrid.childNodes.length) out.push(goldGrid);
    if (notes.length) out.push(h('p', { class: 'small muted' }, notes.join(' ')));
    // Net issuance (diverging bars) and share of the USD stablecoin market.
    const grid2 = h('div', { class: 'grid g2' });
    if (net && net.members.length) {
      const first = net.members.map((m) => compactFirst(m.c)).filter(Boolean).map((x) => x.date).sort()[0];
      const start = rangeStart(first);
      const days = daysBetween(start, end);
      const mode = days <= 120 ? 'day' : days <= 400 ? 'week' : 'month';
      const all = netIssuance(net.members, start, end, mode).filter((x) => x.to > start);
      // Leading buckets with nothing measurable (before or at a series' opening) are dropped.
      const i0 = all.findIndex((x) => isNum(x.value));
      const b = i0 < 0 ? [] : all.slice(i0);
      const fmt = (v) => fmtUnit(v, net.unit, { signed: true });
      const per = { day: 'day', week: '7 days', month: 'calendar month' }[mode];
      const partial = b.filter((x) => x.excluded.length && isNum(x.value));
      const openNote = all.some((x) => x.excluded.length) ? `opening balances of late-starting series are not counted as issuance${partial.length ? ` (${partial.map((x) => `${x.excluded.join(', ')} in ${mode === 'day' ? fmtDate(x.to) : `the period to ${fmtDate(x.to)}`}`).join('; ')})` : ''}` : null;
      if (b.length) {
        grid2.append(
          h(
            'div',
            { class: 'card' },
            figure({
              key: 'net-issuance',
              title: `Net issuance per ${per} (${net.unit})`,
              sub: [`${net.label}; change in supply, not gross mint and burn`, openNote].filter(Boolean).join('; '),
              label: `Net issuance per ${per}`,
              signed: true,
              config: () => ({
                type: 'bar',
                data: { labels: b.map((x) => x.to), datasets: [{ label: 'Net issuance', data: b.map((x) => x.value), backgroundColor: b.map((x) => (x.value >= 0 ? TOK['div-pos'] : TOK['div-neg'])), borderRadius: 4, maxBarThickness: 24, categoryPercentage: 0.9, barPercentage: 0.9 }] },
                options: {
                  interaction: { mode: 'index', intersect: false },
                  scales: { x: axisX(b.map((x) => x.to), days), y: axisY((v) => fmt(v)) },
                  plugins: { tooltip: { usePointStyle: false, callbacks: { title: (it) => (mode === 'day' ? fmtDate(it[0].label) : mode === 'month' ? `${MONTHS[+String(it[0].label).slice(5, 7) - 1]} ${String(it[0].label).slice(0, 4)}` : `${fmtDate(b[it[0].dataIndex].from)} to ${fmtDate(b[it[0].dataIndex].to)}`), label: (c) => ` ${fmt(c.parsed.y)}`, footer: (it) => (b[it[0].dataIndex].excluded.length ? `excludes ${b[it[0].dataIndex].excluded.join(', ')} (series opens)` : '') } } },
                },
              }),
              tableView: () => table({ wrap: 'tall', head: ['Period end', 'Net issuance', { t: 'Note', l: true }], rows: b.slice().reverse().map((x) => ({ cells: [x.to, fmt(x.value), x.excluded.length ? `excludes ${x.excluded.join(', ')} (series opens)` : ''] })) }),
            }),
          ),
        );
      }
    }
    if (shareSeries) {
      const cov = marketCoverage();
      // Judge the clip against where the scope's supply data begins: the server may already start the
      // share series at the coverage date, and the note must still say why earlier years are missing.
      const first = compactFirst(isAll ? p.totals.usd.supplyUsd : usdSer(state.asset)) || compactFirst(shareSeries);
      let start = rangeStart(first && first.date);
      const clipped = cov && cov.from > start;
      if (clipped) start = cov.from;
      const al = alignCompacts([shareSeries], start, end);
      const vals = al.rows[0].map((v) => (isNum(v) ? v * 100 : null));
      const covText = clipped ? `Shown from ${fmtDate(cov.from)}: that day DefiLlama's USD total rose ${isNum(cov.rise) ? fmtPct(cov.rise) + ' ' : ''}at once, more than it moves in any later week, so coins were still being added to its history and earlier shares would be overstated` : null;
      grid2.append(h('div', { class: 'card' }, figure({ key: 'share', title: 'Share of the USD stablecoin market', sub: [`${isAll ? 'Active Paxos USD stablecoins' : state.asset} / all USD-pegged stablecoins (DefiLlama)`, covText].filter(Boolean).join('. '), config: () => lineConfig({ labels: al.dates, datasets: [lineDataset('Share', vals, isAll ? TOK['ink-2'] : colorOf(state.asset))], yFmt: (v) => fmtPct(v, { digits: 2 }), spanDays: daysBetween(start, end) }), tableView: () => seriesTable(al.dates, [{ label: 'Share', values: vals, fmt: (v) => fmtPct(v, { digits: 3 }) }]) })));
    }
    out.push(grid2);
    if (!shareSeries && !isAll) out.push(h('p', { class: 'small muted' }, `Market share applies to USD stablecoins; ${state.asset} is not one.`));
    return out;
  }
  function seriesTable(labels, cols) {
    const step = Math.max(1, Math.round(labels.length / 150));
    const idx = labels.map((_, i) => labels.length - 1 - i).filter((_, j) => j % step === 0);
    return table({ wrap: 'tall', caption: step > 1 ? `Every ${step}th day, newest first.` : 'Newest first.', head: ['Date', ...cols.map((c) => c.label)], rows: idx.map((i) => ({ cells: [labels[i], ...cols.map((c) => c.fmt(c.values[i]))] })) });
  }

  // 8. Peers
  function renderPeers() {
    const p = P();
    const r = rng();
    const pe = p.peers;
    if (!pe || !Array.isArray(pe.rows) || !pe.rows.length) return h('p', { class: 'placeholder' }, 'Peer data is not in this snapshot.');
    const avail = ['d30', 'd7', 'd1'].filter((w) => pe.rows.some((x) => x.change && x.change[w]));
    // The list carries 1, 7 and 30-day comparisons only; the longest available one is shown.
    const win = avail[0];
    if (!win) return h('p', { class: 'placeholder' }, 'Peer growth windows are not in this snapshot.');
    const wDays = { d1: 1, d7: 7, d30: 30 }[win];
    // The list is DefiLlama's hourly snapshot (pe.asOf), fresher than the daily supply snapshot in the hero.
    $('sub-peers').textContent = `Supply growth over ${wDays} days for the largest live USD stablecoins (DefiLlama list${pe.asOf ? ` as of ${fmtDateTime(pe.asOf)}` : ''}${r.win !== win ? `; the list only carries 1, 7 and 30-day comparisons, so ${r.text} is shown as ${wDays} days` : ''}). Its figures can differ slightly from the daily supply snapshot used above. Paxos assets are coloured and labelled in bold; other stablecoins are gray.${state.asset !== 'all' && !isUsdKind(meta(state.asset)) ? ` ${state.asset} is not a USD stablecoin, so it has no place in this peer set.` : ''}`;
    const sorted = pe.rows.slice().sort((a, b) => (b.supplyUsd || 0) - (a.supplyUsd || 0));
    const nTop = root.innerWidth < 600 ? 12 : 20;
    const pick = sorted.filter((x, i) => i < nTop || x.isPaxos).filter((x) => x.change && x.change[win] && isNum(x.change[win].pct));
    const t = p.totals.usd;
    const aggLabel = 'Active Paxos USD (total)';
    const aggregate = t.change && t.change[win] && isNum(t.change[win].pct) ? { symbol: aggLabel, name: t.label, supplyUsd: t.current, change: { [win]: t.change[win] }, isPaxos: true, aggregate: true } : null;
    const rows = [...pick, aggregate].filter(Boolean).sort((a, b) => b.change[win].pct - a.change[win].pct);
    const colorRow = (x) => (x.aggregate ? TOK['ink-2'] : x.isPaxos && x.assetKey ? colorOf(x.assetKey) : TOK.neutral);
    const height = rows.length * 22 + 50;
    const fig = figure({
      key: 'peers',
      title: `${wDays}-day supply growth, Paxos vs peers`,
      sub: `${rows.length} of ${fmtCount(pe.count)} live USD stablecoins`,
      label: `Growth ranking: ${rows.map((x) => `${x.symbol} ${fmtPct(x.change[win].pct, { signed: true })}`).join(', ')}`,
      legend: [...rows.filter((x) => x.isPaxos && !x.aggregate && isNum((meta(x.assetKey) || {}).colorIndex)).map((x) => ({ label: x.symbol, color: colorRow(x) })), { label: aggLabel, color: TOK['ink-2'] }, { label: 'Other stablecoins', color: TOK.neutral }],
      config: () => ({
        type: 'bar',
        data: { labels: rows.map((x) => x.symbol), datasets: [{ label: 'Growth', data: rows.map((x) => x.change[win].pct), backgroundColor: rows.map(colorRow), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 16, categoryPercentage: 0.85, barPercentage: 0.9 }] },
        options: {
          indexAxis: 'y',
          interaction: { mode: 'nearest', axis: 'y', intersect: false },
          scales: {
            x: axisY((v) => fmtPct(v, { signed: true, digits: 0 }), { grid: { color: (c) => (c.tick && c.tick.value === 0 ? TOK.axis : TOK.hair), drawTicks: false } }),
            // Paxos rows also get bold, brighter labels so identity is not carried by colour alone.
            y: { grid: { display: false }, border: { color: TOK.axis }, ticks: { autoSkip: false, color: (c) => (rows[c.index] && rows[c.index].isPaxos ? TOK.ink : TOK['ink-muted']), font: (c) => ({ weight: rows[c.index] && rows[c.index].isPaxos ? 'bold' : 'normal' }), callback(v) {
              const s = String(this.getLabelForValue(v));
              return s.length > 18 ? s.slice(0, 17) + '…' : s;
            } } },
          },
          plugins: { tooltip: { usePointStyle: false, callbacks: { label: (c) => {
            const x = rows[c.dataIndex];
            return [` ${fmtPct(x.change[win].pct, { signed: true })} (${fmtUsd(x.change[win].abs, { signed: true })})`, ` supply ${fmtUsd(x.supplyUsd)}${x.isPaxos ? ' · Paxos' : ''}`];
          } } } },
        },
      }),
      tableView: () => table({ wrap: 'tall', caption: pe.asOf ? `DefiLlama list as of ${fmtDateTime(pe.asOf)}.` : null, head: ['Stablecoin', 'Supply', '1d', '7d', '30d', 'Paxos'], rows: sorted.map((x) => ({ cells: [x.symbol + (x.name && x.name !== x.symbol ? ` (${x.name})` : ''), fmtUsd(x.supplyUsd), ...['d1', 'd7', 'd30'].map((w) => (x.change && x.change[w] ? `${fmtPct(x.change[w].pct, { signed: true })} (${fmtUsd(x.change[w].abs, { signed: true })})` : 'n/a')), x.isPaxos ? 'yes' : ''] })) }),
    });
    const box = fig.querySelector('.chart-box');
    if (box) box.style.height = height + 'px';
    const out = [h('div', { class: 'card' }, fig)];
    if ((pe.excluded || []).length) out.push(h('p', { class: 'small muted' }, `Excluded from peer rankings after failing list-vs-chart reconciliation: ${pe.excluded.map((x) => x.symbol).join(', ')}.`));
    return out;
  }

  // 9. Chains
  function renderChains() {
    const r = rng();
    const end = endIso();
    const scope = scopeAssets().filter((d) => d.data && (d.data.chains || []).length);
    $('sub-chains').textContent = `Weekly net change in supply per chain over ${r.text} (chain history covers the last 400 days at most). No chain colours: blue is net inflow, red net outflow, gray no change, hatched no data.`;
    if (!scope.length) return h('p', { class: 'placeholder' }, state.asset === 'all' ? 'No per-chain balances in this snapshot.' : `No per-chain balances are available for ${state.asset}.`);
    const byChain = new Map();
    for (const d of scope) for (const c of d.data.chains) {
      const g = byChain.get(c.chain) || { chain: c.chain, current: 0, series: [] };
      g.current += c.currentUsd || 0;
      if (c.series) g.series.push(c.series);
      byChain.set(c.chain, g);
    }
    const chains = [...byChain.values()].sort((a, b) => b.current - a.current);
    // Whole weeks ending at the data end, starting no earlier than the chain history does:
    // a bucket whose base precedes the (400-day) history would book the entire balance as inflow.
    const earliest = chains.flatMap((c) => c.series.map((s) => s.start)).sort()[0];
    const lo = rangeStart(earliest);
    const nWeeks = Math.max(1, Math.floor(daysBetween(lo, end) / 7));
    const start = addDays(end, -7 * nWeeks);
    const maxRows = root.innerWidth < 600 ? 8 : 12;
    const shown = chains.slice(0, chains.length > maxRows ? maxRows - 1 : maxRows);
    const rest = chains.slice(shown.length);
    const rowsDef = shown.map((c) => ({ label: c.chain, series: sumCompacts(c.series, start, end) }));
    if (rest.length) rowsDef.push({ label: `Other chains (${rest.length})`, series: sumCompacts(rest.flatMap((c) => c.series), start, end) });
    const weeks = bucketChanges(rowsDef[0].series, start, end, 'week').map((b) => ({ from: b.from, to: b.to }));
    const grid = rowsDef.map((rd) => bucketChanges(rd.series, start, end, 'week').map((b) => b.value));
    const absVals = grid.flat().filter((v) => isNum(v) && v !== 0).map(Math.abs);
    // Colour saturates at the 95th percentile of |weekly change| so one outlier week does not wash out the rest.
    const cap = quantile(absVals, 0.95) || Math.max(1, ...absVals);
    const col = (v) => (v === 0 ? TOK['div-mid'] : mixHex(TOK['div-mid'], v > 0 ? TOK['div-pos'] : TOK['div-neg'], Math.min(1, Math.abs(v) / cap)));
    const tip = getTooltip();
    const hm = h('div', { class: 'hm', role: 'img', 'aria-label': `Heatmap of weekly net supply change for ${rowsDef.length} chains over ${weeks.length} weeks; values in the table view.` });
    rowsDef.forEach((rd, i) => {
      const cells = h('div', { class: 'cells' });
      cells.style.gridTemplateColumns = `repeat(${weeks.length}, minmax(0, 1fr))`;
      grid[i].forEach((v, j) => {
        // No data is hatched so it cannot be mistaken for "no change" (the gray midpoint).
        const sp = h('span', { 'data-i': i, 'data-j': j, class: isNum(v) ? null : 'nd' });
        if (isNum(v)) sp.style.background = col(v);
        cells.append(sp);
      });
      hm.append(h('div', { class: 'row' }, h('span', { class: 'rl', title: rd.label }, rd.label), cells));
    });
    const axis = h('div', { class: 'axis' });
    // Each label is a week's end date, placed at that week's right edge.
    const marks = [0, Math.floor((weeks.length - 1) / 2), weeks.length - 1].filter((v, i, a) => a.indexOf(v) === i);
    for (const j of marks) {
      const pos = ((j + 1) / weeks.length) * 100;
      axis.append(h('span', { class: j === weeks.length - 1 ? 'last' : j === 0 ? 'edge' : 'mid' }, fmtTick(weeks[j].to, daysBetween(start, end))));
      axis.lastChild.style.left = pos + '%';
    }
    hm.append(h('div', { class: 'row' }, h('span'), axis));
    hm.addEventListener('pointermove', (e) => {
      const t = e.target;
      if (!t.dataset || t.dataset.j === undefined) {
        tip.hidden = true;
        return;
      }
      const i = +t.dataset.i;
      const j = +t.dataset.j;
      const v = grid[i][j];
      tip.replaceChildren(h('b', null, isNum(v) ? fmtUsd(v, { signed: true }) : 'no data'), `${rowsDef[i].label}`, h('br'), `${fmtDate(weeks[j].from)} to ${fmtDate(weeks[j].to)}`);
      tip.hidden = false;
      tip.style.left = Math.min(e.clientX + 12, root.innerWidth - 270) + 'px';
      tip.style.top = e.clientY + 14 + 'px';
    });
    hm.addEventListener('pointerleave', () => (tip.hidden = true));
    const scale = h('div', { class: 'scale' }, h('span', null, fmtUsd(-cap)), h('span', { class: 'bar' }), h('span', null, fmtUsd(cap, { signed: true })), h('span', null, `per week; colours saturate beyond ±${fmtUsd(cap)}`), h('span', { class: 'nd-key' }, h('span', { class: 'nd', 'aria-hidden': 'true' }), 'no data'));
    scale.querySelector('.bar').style.background = `linear-gradient(90deg, ${TOK['div-neg']}, ${TOK['div-mid']}, ${TOK['div-pos']})`;
    const hmTable = () => table({ wrap: 'tall', head: ['Week ending', ...rowsDef.map((rd) => rd.label)], rows: weeks.map((w, j) => weeks.length - 1 - j).map((j) => ({ cells: [weeks[j].to, ...grid.map((g) => fmtUsd(g[j], { signed: true }))] })) });
    const fig = h('figure', { class: 'viz' }, h('figcaption', null, `Chain flows, ${state.asset === 'all' ? 'all Paxos assets combined' : state.asset}`, h('span', { class: 'cap-sub' }, `${weeks.length} weeks to ${fmtDate(end)}; rows ordered by current supply`)), hm, scale, fold('tv:chain-hm', ['Table view', h('span', { class: 'sr-only' }, ': chain flows')], hmTable(), 'tv'));
    // Chain table
    const multi = state.asset === 'all';
    const STATUS = { tracked: 'tracked', tracking_ended: 'tracking ended', new: 'new (< 30 days)' };
    // Chains whose balance and 30-day move are both below the asset's materiality floor (a typical
    // day's net flow) are folded away: they cannot move the asset and only bury the chains that can.
    const floors = (P().insights && P().insights.floorsUsd) || {};
    const small = ({ d, c }) => isNum(floors[d.key]) && (c.currentUsd || 0) < floors[d.key] && !(c.change && c.change.d30 && Math.abs(c.change.d30.abs || 0) >= floors[d.key]);
    const toRow = ({ d, c }) => ({
        cells: [
          h('span', { class: 'cname' }, c.chain),
          ...(multi ? [assetLabel(d.key)] : []),
          fmtUsd(c.currentUsd),
          fmtShare(c.share),
          ...['d7', 'd30'].map((w) => (c.change && c.change[w] ? h('span', null, h('span', { class: 'nowrap' }, fmtUsd(c.change[w].abs, { signed: true })), h('div', { class: 'small muted nowrap' }, fmtPct(c.change[w].pct, { signed: true }))) : 'n/a')),
          h('span', { class: 'nowrap' }, c.first ? fmtDate(c.first) : 'n/a'),
          h('span', null, STATUS[c.status] || c.status || 'n/a', (c.notes || []).slice(0, 2).map((n) => h('div', { class: 'small muted' }, n)), (c.notes || []).length > 2 ? h('div', { class: 'small muted', title: c.notes.slice(2).join('\n') }, `+${c.notes.length - 2} more notes`) : null),
          spark((sliceCompact(c.series, r.days, end) || { values: [] }).values, multi ? colorOf(d.key) : TOK['ink-2'], { w: 90, h: 22 }),
        ],
      });
    const all = scope.flatMap((d) => d.data.chains.map((c) => ({ d, c }))).sort((x, y) => (y.c.currentUsd || 0) - (x.c.currentUsd || 0));
    const major = all.filter((x) => !small(x)), minor = all.filter(small);
    const head = ['Chain', ...(multi ? ['Asset'] : []), 'Current', 'Share of asset', '7d', '30d', 'First seen', { t: 'Status', l: true }, `Trend (${r.label})`];
    return [h('div', { class: 'card' }, fig), h('div', { class: 'card' }, h('h3', null, 'Chain balances'), table({ wrap: 'tall', head, rows: major.map(toRow) }),
      minor.length ? fold('chains-small', [`${plural(minor.length, 'small chain')} `, h('span', { class: 'muted' }, '(balance and 30-day move below the asset\'s typical daily flow)')], table({ wrap: 'tall', head, rows: minor.map(toRow) })) : null)];
  }
  let tooltipEl = null;
  function getTooltip() {
    if (!tooltipEl) {
      tooltipEl = h('div', { class: 'tooltip', role: 'presentation' });
      tooltipEl.hidden = true;
      document.body.append(tooltipEl);
    }
    return tooltipEl;
  }

  // 10. Peg
  function hourlyLabels(series) {
    return series.t.map((t) => new Date(Math.round(t / 3600) * 3600 * 1000).toISOString().slice(0, 16));
  }
  function alignHourly(base, other) {
    if (!other || !other.t) return base.map(() => null);
    const m = new Map(other.t.map((t, i) => [new Date(Math.round(t / 3600) * 3600 * 1000).toISOString().slice(0, 16), other.v[i]]));
    return base.map((l) => (m.has(l) && isNum(m.get(l)) ? m.get(l) : null));
  }
  // Placeholder for a panel whose input is missing: name the degraded sources of the kinds it needs.
  function degradedNote(kinds) {
    const bad = sourcesNow().filter((x) => kinds.includes(x.s.kind) && x.status !== 'ok' && x.status !== 'skipped');
    return bad.length ? ` (${bad.map((x) => `${x.s.label}: ${(SOURCE_STATUS[x.status] || {}).label || x.status}`).join('; ')})` : '';
  }
  const missingCard = (title, text) => h('div', { class: 'card missing' }, h('h3', null, title), h('p', { class: 'placeholder' }, text));
  function renderPeg() {
    const p = P();
    const r = rng();
    const end = endIso();
    const scope = scopeAssets().filter((d) => d.data && d.data.series);
    const peers = (p.pegPeers || []).filter((x) => x && (x.priceHourly || x.price));
    const hourlyMode = r.id === '30d';
    const panels = [];
    let usdPanels = 0;
    const bp = (v) => (isNum(v) ? (v - 1) * 1e4 : null);
    // Context lines are one neutral gray (>= 3:1 on the card); alternate ones are dashed, not darker.
    const peerStyle = (i) => ({ color: TOK.neutral, dash: i % 2 === 1 });
    for (const d of scope) {
      const s = d.data.series;
      if (isUsdKind(d)) {
        let labels;
        let own;
        let peerVals;
        let hourly = false;
        if (hourlyMode && s.priceHourly && s.priceHourly.t && s.priceHourly.t.length > 1) {
          hourly = true;
          labels = hourlyLabels(s.priceHourly);
          own = s.priceHourly.v.map(bp);
          peerVals = peers.map((x) => alignHourly(labels, x.priceHourly).map(bp));
        } else if (s.price) {
          const first = compactFirst(s.price);
          const start = rangeStart(first && first.date);
          const al = alignCompacts([s.price, ...peers.map((x) => x.price)], start, end);
          labels = al.dates;
          own = al.rows[0].map(bp);
          peerVals = al.rows.slice(1).map((row) => row.map(bp));
        } else {
          panels.push(missingCard(`${d.key}: deviation from $1`, `No price history for ${d.key} in this snapshot${degradedNote(['price'])}.`));
          continue;
        }
        usdPanels++;
        const spanD = hourly ? Math.max(1, Math.round(labels.length / 24)) : labels.length;
        const lim = Math.max(1, ...own.filter(isNum).map(Math.abs)) * 1.15;
        const datasets = [...peerVals.map((v, i) => lineDataset(peers[i].symbol, v, peerStyle(i).color, { borderWidth: 1.5, borderDash: peerStyle(i).dash ? [5, 3] : undefined })), lineDataset(d.key, own, colorOf(d.key))];
        panels.push(
          h(
            'div',
            { class: 'card' },
            figure({
              key: 'peg-' + d.key,
              title: `${d.key}: deviation from $1`,
              sub: `latest ${fmtBp(d.data.current.pegDevBp)}${hourly ? ' · hourly' : ' · daily'}`,
              size: 'sm',
              legend: [{ label: d.key, color: colorOf(d.key), line: true }, ...peers.map((x, i) => ({ label: x.symbol, color: peerStyle(i).color, line: true, dash: peerStyle(i).dash }))],
              config: () => lineConfig({ labels, datasets, yFmt: (v) => fmtBp(v), spanDays: spanD, hourly, yExtra: { suggestedMin: -lim, suggestedMax: lim } }),
              tableView: () => seriesTable(labels, [{ label: d.key, values: own, fmt: (v) => fmtBp(v) }, ...peers.map((x, i) => ({ label: x.symbol, values: peerVals[i], fmt: (v) => fmtBp(v) }))]),
            }),
          ),
        );
      } else if (d.kind === 'gold') {
        // Gold: premium of the price in XAU over 1 oz (daily), and vs other gold tokens (hourly).
        if (s.xau) {
          const first = compactFirst(s.xau);
          const start = rangeStart(first && first.date);
          const al = alignCompacts([s.xau], start, end);
          const own = al.rows[0].map(bp);
          panels.push(h('div', { class: 'card' }, figure({ key: 'peg-xau-' + d.key, title: `${d.key}: premium vs XAU`, sub: `latest ${fmtBp(d.data.current.pegDevBp)}${d.data.current.pegAsOf ? ` (${fmtDateTime(d.data.current.pegAsOf)})` : ''} · daily price in ounces of gold`, size: 'sm', config: () => lineConfig({ labels: al.dates, datasets: [lineDataset(d.key, own, colorOf(d.key))], yFmt: (v) => fmtBp(v), spanDays: al.dates.length }), tableView: () => seriesTable(al.dates, [{ label: `${d.key} vs XAU`, values: own, fmt: (v) => fmtBp(v) }]) })));
        } else {
          panels.push(missingCard(`${d.key}: premium vs XAU`, `XAU reference price unavailable in this snapshot${degradedNote(['price'])}.`));
        }
        const refs = (p.goldRefs || []).filter((g) => g && g.priceHourly && g.priceHourly.t && g.priceHourly.t.length);
        if (refs.length && s.priceHourly && s.priceHourly.t && s.priceHourly.t.length > 1) {
          const labels = hourlyLabels(s.priceHourly);
          const vals = refs.map((g) => {
            const ref = alignHourly(labels, g.priceHourly);
            return s.priceHourly.v.map((v, i) => (isNum(v) && isNum(ref[i]) && ref[i] ? (v / ref[i] - 1) * 1e4 : null));
          });
          const color = (i) => (i ? peerStyle(i).color : colorOf(d.key));
          panels.push(
            h(
              'div',
              { class: 'card' },
              figure({
                key: 'peg-ref-' + d.key,
                title: `${d.key} price vs other gold tokens`,
                sub: `${d.key} premium over ${refs.map((g) => g.symbol).join(', ')} in bp · hourly`,
                size: 'sm',
                legend: refs.map((g, i) => ({ label: `vs ${g.symbol}`, color: color(i), line: true, dash: i > 0 && peerStyle(i).dash })),
                config: () => lineConfig({ labels, datasets: vals.map((v, i) => lineDataset(`vs ${refs[i].symbol}`, v, color(i), { borderDash: i > 0 && peerStyle(i).dash ? [5, 3] : undefined })), yFmt: (v) => fmtBp(v), spanDays: Math.round(labels.length / 24), hourly: true }),
                tableView: () => seriesTable(labels, refs.map((g, i) => ({ label: `vs ${g.symbol}`, values: vals[i], fmt: (v) => fmtBp(v) }))),
              }),
            ),
          );
        } else {
          panels.push(missingCard(`${d.key} price vs other gold tokens`, `${refs.length ? `No recent hourly price for ${d.key}` : 'No other gold tokens with recent hourly prices'} in this snapshot${degradedNote(['price'])}.`));
        }
      } else {
        // Another peg (e.g. a non-USD fiat stablecoin): no reference series is charted for it yet.
        panels.push(missingCard(`${d.key}: peg`, `No peg reference is charted for ${d.unit || d.kind} assets; the price is in the asset table.`));
      }
    }
    $('sub-peg').textContent = `Deviation from the peg in basis points (1 bp = 0.01%). ${hourlyMode ? 'Hourly prices where available (about the last 3 weeks).' : `Daily prices over ${r.text}.`} ${usdPanels && peers.length ? `Gray lines: ${peers.map((x) => x.symbol).join(', ')} (peg peers) for context.` : ''} Each panel has its own scale.`;
    if (!panels.length) return h('p', { class: 'placeholder' }, `No price history for ${scopeLabel()} in this snapshot${degradedNote(['price'])}.`);
    return h('div', { class: 'grid g2' }, panels);
  }

  // 11. DeFi
  function renderDefi() {
    const scope = scopeAssets().filter((d) => d.data && d.data.defi);
    if (!scope.length) return h('p', { class: 'placeholder' }, `No matched DeFi pools for ${scopeLabel()}.`);
    const out = [];
    const tile = (label, v, m) => h('div', { class: 'tile' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, v), m ? h('span', { class: 'meta' }, m) : null);
    if (scope.length === 1) {
      const f = scope[0].data.defi;
      out.push(h('div', { class: 'tiles' }, tile('Footprint', fmtUsd(f.footprintUsd), 'sum of matched pool TVL'), tile('Share of supply', fmtShare(f.footprintShare), 'upper bound'), tile('Pools', fmtCount(f.poolCount), `effective ${isNum(f.effectivePools) ? f.effectivePools.toFixed(1) : 'n/a'} (TVL-weighted)`), tile('Incentive share', fmtShare(f.rewardShare), 'of TVL-weighted yield')));
    } else {
      const tot = scope.reduce((s, d) => s + (d.data.defi.footprintUsd || 0), 0);
      out.push(h('div', { class: 'tiles' }, tile('Footprint, all assets', fmtUsd(tot), 'sum of matched pool TVL'), tile('Pools', fmtCount(scope.reduce((s, d) => s + (d.data.defi.poolCount || 0), 0)), 'a pair pool counts once per asset')));
      out.push(table({ head: ['Asset', 'Footprint', 'Share of supply', 'Pools', 'Effective pools', 'Incentive share'], rows: scope.map((d) => ({ cells: [assetLabel(d.key), fmtUsd(d.data.defi.footprintUsd), fmtShare(d.data.defi.footprintShare), fmtCount(d.data.defi.poolCount), isNum(d.data.defi.effectivePools) ? d.data.defi.effectivePools.toFixed(1) : 'n/a', fmtShare(d.data.defi.rewardShare)] })) }));
    }
    const pools = scope.flatMap((d) => (d.data.defi.pools || []).map((x) => ({ ...x, asset: d.key }))).sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0));
    const more = state.more.has('pools');
    const limit = 20;
    const list = more ? pools : pools.slice(0, limit);
    const multi = scope.length > 1;
    const apy = (v) => (isNum(v) ? v.toFixed(2) + '%' : 'n/a');
    const rows = list.map((x) => {
      const url = safeUrl(x.url);
      return {
        cells: [
          url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, x.project) : x.project,
          h('span', { class: 'cname' }, x.chain),
          h('span', { class: 'cname' }, x.symbol),
          ...(multi ? [assetLabel(x.asset)] : []),
          fmtUsd(x.tvlUsd),
          apy(x.apy),
          apy(x.apyBase),
          apy(x.apyReward),
          isNum(x.utilization) ? fmtShare(x.utilization) : 'n/a',
        ],
      };
    });
    out.push(h('h3', null, `Pools (${fmtCount(pools.length)}${pools.length < scope.reduce((s, d) => s + (d.data.defi.poolCount || 0), 0) ? ' largest listed' : ''})`));
    out.push(table({ head: ['Project', { t: 'Chain', l: true }, { t: 'Symbol', l: true }, ...(multi ? ['Asset'] : []), 'TVL', 'APY', 'Base', 'Reward', 'Utilisation'], rows }));
    if (pools.length > limit) out.push(h('button', { type: 'button', class: 'btn', 'data-more': 'pools', 'aria-expanded': String(more) }, more ? `Show the top ${limit}` : `Show all ${pools.length} pools`));
    return out;
  }

  // 12. Economics
  function renderEcon() {
    const p = P();
    const e = p.economics;
    const r = rng();
    const end = endIso();
    $('sub-econ').textContent = e ? `${e.label || 'Model estimate'}. ${e.note || ''} Issuer-level; not split by asset${state.asset !== 'all' ? ', so the asset filter does not apply' : ''}.` : '';
    if (!e) {
      const src = (p.sources || []).find((x) => x.kind === 'economics' && x.status !== 'ok');
      return h('p', { class: 'placeholder' }, `Issuer economics are not in this snapshot${src ? ` (${src.label}: ${(SOURCE_STATUS[src.status] || {}).label || src.status}${src.message ? ', ' + src.message : ''})` : ''}.`);
    }
    const c = e.current || {};
    const tile = (label, v, m) => h('div', { class: 'tile' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, v), m ? h('span', { class: 'meta' }, m) : null);
    const out = [h('div', { class: 'tiles' }, tile('Modelled fees, 24h', fmtUsd(c.fees24h)), tile('Modelled revenue, 24h', fmtUsd(c.revenue24h)), tile('Modelled fees, 1 year', fmtUsd(c.fees1y)), tile('Implied yield', isNum(c.impliedYield) ? fmtShare(c.impliedYield) : 'n/a', isNum(c.baseUsd) ? `annualised, on ${fmtUsd(c.baseUsd)} of modelled supply` : null))];
    const grid = h('div', { class: 'grid g2' });
    const lastOf = (x) => compactEnd(x) || end;
    if (e.fees || e.revenue) {
      const fe = lastOf(e.fees || e.revenue);
      const first = compactFirst(e.fees || e.revenue);
      const start = isNum(r.days) ? addDays(fe, -r.days) : first ? first.date : fe;
      const al = alignCompacts([e.fees, e.revenue], start, fe);
      const sets = [e.fees ? { label: 'Fees', values: al.rows[0], color: TOK['ink-2'] } : null, e.revenue ? { label: 'Revenue', values: al.rows[1], color: TOK.neutral } : null].filter(Boolean);
      grid.append(h('div', { class: 'card' }, figure({ key: 'econ-fees', title: 'Modelled daily fees and revenue (USD)', sub: `${fmtDate(start)} to ${fmtDate(fe)}`, legend: sets.map((s) => ({ label: s.label, color: s.color, line: true })), config: () => lineConfig({ labels: al.dates, datasets: sets.map((s) => lineDataset(s.label, s.values, s.color)), yFmt: (v) => fmtUsd(v), spanDays: al.dates.length, endLabel: sets.length > 1 }), tableView: () => seriesTable(al.dates, sets.map((s) => ({ label: s.label, values: s.values, fmt: (v) => fmtUsd(v) }))) })));
    }
    if (e.impliedYield) {
      const fe = lastOf(e.impliedYield);
      const first = compactFirst(e.impliedYield);
      const start = isNum(r.days) ? addDays(fe, -r.days) : first ? first.date : fe;
      const al = alignCompacts([e.impliedYield], start, fe);
      const vals = al.rows[0].map((v) => (isNum(v) ? v * 100 : null));
      grid.append(h('div', { class: 'card' }, figure({ key: 'econ-yield', title: 'Implied yield on modelled supply', sub: 'daily modelled fees × 365 / supply of the fee-modelled assets', config: () => lineConfig({ labels: al.dates, datasets: [lineDataset('Implied yield', vals, TOK['ink-2'])], yFmt: (v) => fmtPct(v, { digits: 2 }), spanDays: al.dates.length }), tableView: () => seriesTable(al.dates, [{ label: 'Implied yield', values: vals, fmt: (v) => fmtPct(v, { digits: 2 }) }]) })));
    }
    out.push(grid);
    return out;
  }

  // 13. On-chain & usage
  const normName = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function assetChains(d) {
    const a = d.data || {};
    return [...new Set([...(a.chains || []).map((c) => c.chain), ...(a.onchain || []).map((x) => x.chain), ...addressesOf(d.key).map((x) => x.chain)].filter(Boolean))];
  }
  // Which chain a Coin Metrics series covers: the payload's activity.chain, else the series id's
  // suffix ("<asset>_<chain>") matched against the asset's own chain names.
  function activityScope(d) {
    const act = d.data && d.data.activity;
    if (!act) return null;
    if (typeof act.chain === 'string' && act.chain) return act.chain;
    const m = /_([a-z0-9]+)$/i.exec(String(act.key || ''));
    if (!m) return null;
    const hits = assetChains(d).filter((c) => normName(c).startsWith(normName(m[1])));
    return hits.length === 1 ? hits[0] : null;
  }
  function renderUsage() {
    const r = rng();
    const end = endIso();
    const scope = scopeAssets().filter((d) => d.data);
    const out = [];
    const tile = (d) => h('div', { class: 'tile' }, h('span', { class: 'label' }, swatch(colorOf(d.key)), `${d.key} 24h turnover`), h('span', { class: 'value' }, isNum(d.data.current.turnover24h) ? fmtShare(d.data.current.turnover24h) : 'n/a'), h('span', { class: 'meta' }, isNum(d.data.current.volume24hUsd) ? `${fmtUsd(d.data.current.volume24hUsd)} traded` : `volume unavailable${degradedNote(['price'])}`));
    out.push(h('div', { class: 'tiles' }, scope.filter((d) => d.status !== 'dead').map(tile)));
    const grid = h('div', { class: 'grid g2' });
    const turn = scope.filter((d) => d.data.series && d.data.series.turnover7d);
    if (turn.length) {
      const first = turn.map((d) => compactFirst(d.data.series.turnover7d)).filter(Boolean).map((x) => x.date).sort()[0];
      const start = rangeStart(first);
      const al = alignCompacts(turn.map((d) => d.data.series.turnover7d), start, end);
      const sets = turn.map((d, i) => ({ label: d.key, values: al.rows[i].map((v) => (isNum(v) ? v * 100 : null)), color: colorOf(d.key) }));
      grid.append(h('div', { class: 'card' }, figure({ key: 'turnover', title: 'Turnover, 7-day average', sub: 'daily trading volume / market cap (CoinGecko)', legend: sets.map((s) => ({ label: s.label, color: s.color, line: true })), config: () => lineConfig({ labels: al.dates, datasets: sets.map((s) => lineDataset(s.label, s.values, s.color)), yFmt: (v) => fmtPct(v, { digits: 0 }), tipFmt: (v) => fmtPct(v, { digits: 1 }), spanDays: al.dates.length, endLabel: sets.length > 1 && sets.length <= 4 }), tableView: () => seriesTable(al.dates, sets.map((s) => ({ label: s.label, values: s.values, fmt: (v) => fmtPct(v, { digits: 1 }) }))) })));
    } else if (scope.some((d) => d.status !== 'dead')) {
      grid.append(missingCard('Turnover, 7-day average', `Turnover history is not in this snapshot${degradedNote(['price'])}.`));
    }
    const METRICS = [['activeAddresses', 'Active addresses'], ['transfers', 'Transfers'], ['holders', 'Addresses with a balance']];
    for (const d of scope.filter((x) => x.data.activity && x.data.activity.series)) {
      const act = d.data.activity;
      const chain = activityScope(d);
      const others = assetChains(d).filter((c) => c !== chain).length;
      const src = `${act.source === 'coinmetrics' ? 'Coin Metrics' : act.source} series ${act.key}`;
      const sub = chain ? `${src}: ${chain} only${others ? '; other chains are not counted (see holders by chain below)' : ''}` : `${src}; the chains it covers are not stated, so compare with holders by chain below`;
      for (const [k, label] of METRICS) {
        const s = act.series[k];
        if (!s) continue;
        const first = compactFirst(s);
        const start = rangeStart(first && first.date);
        const al = alignCompacts([s], start, end);
        grid.append(h('div', { class: 'card' }, figure({ key: `act-${d.key}-${k}`, title: `${d.key}${chain ? ` on ${chain}` : ''}: ${label.toLowerCase()} per day`, sub, size: 'sm', config: () => lineConfig({ labels: al.dates, datasets: [lineDataset(label, al.rows[0], colorOf(d.key))], yFmt: (v) => fmtNum(v), spanDays: al.dates.length }), tableView: () => seriesTable(al.dates, [{ label, values: al.rows[0], fmt: (v) => fmtCount(v) }]) })));
      }
    }
    if (grid.childNodes.length) out.push(grid);
    // Holders: every reading, then the asset's material or contract chains that have none.
    const rows = [];
    for (const d of scope) {
      const a = d.data;
      const have = new Set((a.onchain || []).map((x) => x.chain));
      for (const x of a.onchain || []) rows.push({ cells: [x.chain, assetLabel(d.key), isNum(x.holders) ? fmtCount(x.holders) : h('span', { class: 'muted', title: 'Holder counts come from a block explorer; none answered for this chain' }, 'n/a'), fmtNum(x.totalSupply), x.source, x.asOf ? fmtDateTime(x.asOf) : 'n/a'] });
      if (d.status === 'dead') continue;
      const floor = floorOf(d.key);
      const material = (a.chains || []).filter((c) => isNum(c.currentUsd) && c.currentUsd > 0 && (!isNum(floor) || c.currentUsd >= floor)).map((c) => c.chain);
      const want = [...new Set([...material, ...addressesOf(d.key).map((x) => x.chain)])].filter((c) => !have.has(c));
      // Why a chain has no reading: an issuer contract that did not answer (the source's state says why),
      // or no issuer contract at all on that chain (supply DefiLlama counts there is bridged in or held by
      // a third-party contract), in which case there is nothing of Paxos's to read.
      const issuerChains = new Set(addressesOf(d.key).map((x) => x.chain));
      const thirdParty = new Set(((P().discovery && P().discovery.addresses) || []).filter((x) => x && x.asset === d.key && !isIssuerAddress(x)).map((x) => x.chain));
      const why = (c) => (issuerChains.has(c) ? `not available${degradedNote(['onchain']) || ': no on-chain reading for this chain'}` : thirdParty.has(c) ? 'no issuer contract on this chain (only a third-party contract; see the address registry)' : 'no issuer contract on this chain in the address registry');
      for (const c of want) rows.push({ cells: [c, assetLabel(d.key), 'n/a', 'n/a', h('span', { class: 'muted' }, why(c)), 'n/a'] });
    }
    out.push(h('h3', null, 'Holders and on-chain supply by chain'));
    out.push(h('p', { class: 'small muted' }, 'Token supply is read from each chain (ERC-20 totalSupply over its public RPC, or the explorer); holder counts need a block explorer (Blockscout, Jupiter on Solana).'));
    if (rows.length) out.push(table({ head: ['Chain', 'Asset', 'Holders', 'Token supply', { t: 'Source', l: true }, 'As of'], rows }));
    else out.push(h('p', { class: 'placeholder' }, `No holder counts for ${scopeLabel()} in this snapshot.`));
    return out;
  }

  // 14. Standing + watchlist
  function renderStanding() {
    const ins = P().insights || {};
    const key = state.asset;
    const st = (ins.standing || []).filter((i) => insightMatches(i, key));
    const wl = (ins.watch || []).filter((i) => insightMatches(i, key));
    const ctx = (ins.context || []).filter((i) => insightMatches(i, key));
    const list = (items) => (items.length ? h('div', { class: 'compact-list' }, items.map((i) => insightCard(i, null))) : h('p', { class: 'placeholder' }, 'None for this selection.'));
    return [
      fold('standing', [`Standing conditions `, h('span', { class: 'muted' }, `(${st.length})`)], list(st)),
      fold('watch', [`Watchlist `, h('span', { class: 'muted' }, `(${wl.length})`)], list(wl)),
      ctx.length ? fold('context', [`Context `, h('span', { class: 'muted' }, `(${ctx.length})`)], h('ul', { class: 'small' }, ctx.map((i) => h('li', null, i.headline)))) : null,
    ];
  }

  // 15. Data quality & methodology
  function sourcePill(x) {
    const s = x.s;
    const st = SOURCE_STATUS[x.status] || SOURCE_STATUS.skipped;
    const tip = [`${s.label} (${s.host})`, `Status: ${st.label}${x.status !== s.status ? ` (was ${s.status} when generated)` : ''}`, isNum(x.ageNow) ? `Data age ${fmtHours(x.ageNow)}${isNum(s.cadenceHours) ? ` vs ${fmtHours(s.cadenceHours)} cadence` : ''}` : null, s.message].filter(Boolean);
    return h('li', null, h('span', { class: `pill st-${x.status}`, tabindex: 0, 'data-src': s.id, 'aria-label': tip.join('. ') }, h('span', { class: 'ico', 'aria-hidden': 'true' }, st.ico), s.label, h('span', { class: 'sr-only' }, ` ${st.label}`), h('span', { class: 'tip', 'aria-hidden': 'true' }, tip.map((t, i) => (i ? [h('br'), t] : t)))));
  }
  function renderQuality() {
    const p = P();
    const ins = p.insights || {};
    const out = [];
    const now = sourcesNow();
    const bad = now.filter((x) => x.status !== 'ok');
    const counts = Object.entries(now.reduce((acc, x) => ((acc[x.status] = (acc[x.status] || 0) + 1), acc), {})).map(([k, n]) => `${n} ${(SOURCE_STATUS[k] || {}).label || k}`);
    out.push(h('h3', null, `Data sources (${counts.join(', ')})`));
    if (bad.length) out.push(h('ul', { class: 'pills', 'aria-label': 'Degraded data sources' }, bad.map(sourcePill)));
    out.push(fold('sources', `${plural(now.length - bad.length, 'healthy source')}`, h('ul', { class: 'pills', 'aria-label': 'Healthy data sources' }, now.filter((x) => x.status === 'ok').map(sourcePill)), 'srcfold'));
    const src = now.map((x) => {
      const s = x.s;
      return {
        cells: [
          h('span', null, s.label, h('div', { class: 'small muted' }, s.host)),
          h('span', { class: `nowrap st-${x.status}`, 'data-src-status': s.id, 'data-st': x.status }, ...statusLabel(x)),
          h('span', { 'data-src-age': s.id }, sourceAgeText(x)),
          s.dataAsOf ? fmtDateTime(s.dataAsOf) : 'n/a',
          `${fmtCount(s.requests)}${s.failed ? ` (${fmtCount(s.failed)} failed)` : ''}`,
          fmtBytes(s.bytes),
          isNum(s.latencyMs) ? `${fmtCount(s.latencyMs)} ms` : 'n/a',
          h('span', { class: 'mono-wrap' }, s.message || ''),
        ],
      };
    });
    out.push(table({ note: 'Age is measured now (the snapshot\'s age plus the data\'s age when it was generated), against each source\'s update cadence.', head: ['Source', { t: 'Status', l: true }, 'Age / cadence', 'Data as of', 'Requests', 'Bytes', 'Latency', { t: 'Message', l: true }], rows: src }));
    const disc = p.discovery || {};
    const keys = discovered().map((d) => d.key);
    if ((disc.tiers || []).length) {
      out.push(
        h('h3', null, 'Discovery'),
        h('p', { class: 'small' }, 'Which source found which asset. Active assets come from an active-issuance tier (the CoinGecko category or the Paxos docs); others are legacy, and DefiLlama-dead assets are marked dead.'),
        table({ head: ['Tier', ...keys], rows: disc.tiers.map((t) => ({ cells: [h('span', null, t.label || t.id, t.ok === false ? h('span', { class: 'badge' }, 'failed') : null), ...keys.map((k) => ((t.found || []).includes(k) ? h('span', { 'aria-label': 'found' }, '✓') : h('span', { 'aria-label': 'not found', class: 'muted' }, '–')))] })) }),
      );
    }
    const addrs = (disc.addresses || []).filter((a) => state.asset === 'all' || a.asset === state.asset);
    const third = addrs.filter((a) => !isIssuerAddress(a)).length;
    out.push(fold('addresses', [`Address registry `, h('span', { class: 'muted' }, `(${addrs.length} contracts${state.asset === 'all' ? '' : ' for ' + state.asset}${third ? `, ${fmtCount(third)} third-party` : ''})`)], [third ? h('p', { class: 'small muted' }, 'Third-party contracts carry the asset\'s name but are not issuer contracts (bridged copies, or listed only by an aggregator); they are shown for reference and never counted as issuance.') : null, table({ wrap: 'tall', head: ['Asset', { t: 'Chain', l: true }, { t: 'Address', l: true }, { t: 'Role', l: true }, 'Decimals', { t: 'Found via', l: true }], rows: addrs.map((a) => ({ cells: [a.asset, a.chain, h('code', { class: 'mono-wrap' }, a.address), roleText(a.role), isNum(a.decimals) ? String(a.decimals) : 'n/a', (a.via || []).join(', ')] })) })].filter(Boolean)));
    out.push(h('h3', null, 'How findings are flagged'));
    out.push(h('p', null, (ins.rule && ins.rule.text) || 'Notability rule not provided in this snapshot.'));
    const fam = ins.families ? Object.keys(ins.families).length : null;
    out.push(h('p', null, `This snapshot ran ${fmtCount(ins.testsRun)} checks${isNum(ins.groups) ? ` in ${fmtCount(ins.groups)} groups` : ''}${fam ? ` across ${fmtCount(fam)} health dimensions` : ''}. Materiality floors (a typical day's net flow): ${Object.entries(ins.floorsUsd || {}).map(([k, v]) => `${labelOf(k)} ${fmtUsd(v)}`).join(', ') || 'n/a'}.`));
    const errs = ins.errors || [];
    out.push(h('h3', null, 'Detector errors'));
    out.push(errs.length ? h('ul', { class: 'small' }, errs.map((e) => h('li', null, h('code', null, e.detector), `: ${e.error}`))) : h('p', { class: 'small' }, 'None in this snapshot.'));
    if (p.timingsMs) {
      const ms = (v) => (isNum(v) ? `${fmtCount(v)} ms` : 'n/a');
      out.push(h('p', { class: 'small muted' }, `Server timings: fetch ${ms(p.timingsMs.fetch)}, model ${ms(p.timingsMs.model)}, engine ${p.timingsMs.engine === null ? 'not run (insights reused from an identical model)' : ms(p.timingsMs.engine)}, total ${ms(p.timingsMs.total)}. Market definition: ${(p.market && p.market.definition) || 'n/a'}`));
    }
    return out;
  }

  // ===== Render loop =====
  const SECTIONS = [
    ['s-hero', renderHero],
    ['s-unusual', renderUnusual],
    ['s-changed', renderChanged],
    ['s-health', renderHealth],
    ['s-assets', renderAssets],
    ['s-supply', renderSupply],
    ['s-peers', renderPeers],
    ['s-chains', renderChains],
    ['s-peg', renderPeg],
    ['s-defi', renderDefi],
    ['s-econ', renderEcon],
    ['s-usage', renderUsage],
    ['s-standing', renderStanding],
    ['s-quality', renderQuality],
  ];
  let errorPanel = null;
  // Header, status and busy state only: a refetch keeps the previous render (dimmed) instead of rebuilding it.
  function renderChrome() {
    renderHeader();
    document.body.classList.toggle('is-refreshing', state.loading && !!state.payload);
    $('content').setAttribute('aria-busy', String(state.loading));
  }
  // Re-rendering replaces the focused control; remember what it was (its data-* identity and the
  // section it sits in) and focus the matching new node afterwards, so keyboard and screen-reader
  // users keep their place and hear the new state.
  const FOCUS_ATTRS = ['data-asset', 'data-range', 'data-action', 'data-more', 'data-a', 'data-d', 'data-src', 'id'];
  const FOCUS_SCOPE = 'section, #filters, header, .status-row';
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
    // An asset chosen from a tile or the table that no longer exists there lands on its filter button.
    return cands.find((el) => scopeIdOf(el) === key.scope) || (key.attrs['data-asset'] !== undefined ? cands.find((el) => el.closest('#filters')) : null) || null;
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
  function renderAll() {
    renderChrome();
    const p = state.payload;
    if (!p) {
      $('filters').hidden = true;
      for (const [id] of SECTIONS) $(id).hidden = !!state.error;
      if (state.error) {
        if (!errorPanel) {
          errorPanel = h('div', { class: 'error-panel', role: 'alert' });
          $('content').prepend(errorPanel);
        }
        errorPanel.hidden = false;
        errorPanel.replaceChildren(h('h2', null, 'The dashboard data could not be loaded'), h('p', null, `${state.error.message}. Nothing is shown rather than stale or partial numbers.`), h('button', { type: 'button', class: 'btn', 'data-action': 'reload' }, state.loading ? 'Retrying…' : 'Retry'));
      }
      return;
    }
    if (errorPanel) errorPanel.hidden = true;
    $('filters').hidden = false;
    for (const [id] of SECTIONS) $(id).hidden = false;
    renderFilters();
    for (const [id, fn] of SECTIONS) {
      const body = $(id).querySelector('[data-body]');
      destroyCharts(body);
      try {
        const out = fn();
        body.className = '';
        body.replaceChildren(...[out].flat(Infinity).filter(Boolean));
      } catch (e) {
        console.error(`section ${id} failed`, e);
        body.replaceChildren(h('p', { class: 'sec-error' }, `This section could not be rendered (${e.message}). Other sections are unaffected.`));
      }
    }
    rememberSeen();
  }

  // "New to you": insight ids this browser has not shown before (localStorage is optional).
  const SEEN_KEY = 'paxos-health:seen:v1';
  function loadSeen() {
    try {
      const raw = root.localStorage.getItem(SEEN_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      return new Set(Object.keys(obj && typeof obj === 'object' ? obj : {}));
    } catch {
      return null;
    }
  }
  function rememberSeen() {
    try {
      const raw = root.localStorage.getItem(SEEN_KEY);
      const obj = raw ? JSON.parse(raw) || {} : {};
      const now = Date.now();
      for (const id of insightIndex.keys()) if (!obj[id]) obj[id] = now;
      const keep = Object.entries(obj).filter(([, t]) => now - t < 90 * 864e5).sort((a, b) => b[1] - a[1]).slice(0, 2000);
      root.localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(keep)));
    } catch {
      /* storage unavailable: badges stay off */
    }
  }

  function validate(p) {
    if (!p || typeof p !== 'object') throw new Error('Empty response');
    if (p.schemaVersion !== 1) throw new Error(`Unsupported payload schema ${p.schemaVersion}`);
    if (!p.totals || !p.totals.usd || !p.assets) throw new Error('Payload is missing required sections');
  }
  // Derive percentages and drawdowns from levels (see pctFrom). Non-USD assets (gold) keep the payload's
  // USD fields as market-value figures and get their supply figures in their own unit: from
  // current.changeNative / athNative / drawdownNativePct when the payload has them, otherwise from the
  // native-unit series (older payloads).
  function normalizePayload(p) {
    const dd = (curr, ath) => (isNum(curr) && ath && ath.value > 0 ? 100 * (curr / ath.value - 1) : null);
    const t = p.totals.usd;
    t.change = normalizeChanges(t.change, t.current);
    if (t.ath) t.drawdownPct = dd(t.current, t.ath);
    for (const a of Object.values(p.assets || {})) {
      if (!a || !a.current) continue;
      const c = a.current;
      const usd = a.unit === 'USD' || a.kind === 'usd-stablecoin';
      c.change = normalizeChanges(c.change, c.supplyUsd);
      if (usd) {
        if (c.ath) c.drawdownPct = dd(c.supplyUsd, c.ath);
      } else {
        const nat = a.series && a.series.supply;
        const s = nat || (a.series && a.series.supplyUsd);
        c.nativeChange = c.changeNative ? normalizeChanges(c.changeNative, c.supply) : null;
        c.nativeAth = c.athNative || peakOf(s);
        c.nativeAthUnit = c.athNative || nat ? a.unit : 'USD';
        const last = c.athNative && isNum(c.supply) ? { value: c.supply } : compactLast(s);
        c.nativeDrawdownPct = isNum(c.drawdownNativePct) ? c.drawdownNativePct : last ? dd(last.value, c.nativeAth) : null;
      }
      for (const ch of a.chains || []) if (ch) ch.change = normalizeChanges(ch.change, ch.currentUsd);
    }
    for (const x of (p.peers && p.peers.rows) || []) if (x) x.change = normalizeChanges(x.change, x.supplyUsd);
  }
  function onPayload() {
    const p = state.payload;
    normalizePayload(p);
    indexInsights();
    if (state.seenBefore === null) state.seenBefore = loadSeen();
    const known = discovered().map((d) => d.key);
    const canon = canonicalAsset(state.asset, known);
    if (canon && canon !== state.asset) {
      state.asset = canon;
      syncUrl();
    }
    if (!canon) {
      state.notice = `Asset "${state.asset}" is not in the current discovery; showing all Paxos assets.`;
      state.asset = 'all';
      syncUrl();
    } else if (state.asset !== 'all' && meta(state.asset).status !== 'active' && !state.legacy) {
      state.legacy = true;
      syncUrl();
    }
    void p;
  }

  let inflight = null;
  function load() {
    if (inflight) return inflight;
    state.loading = true;
    if (state.payload) renderChrome();
    else render();
    const ctrl = new AbortController();
    let fresh = false;
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    inflight = (async () => {
      try {
        const res = await fetch(API, { signal: ctrl.signal, headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`The data service answered HTTP ${res.status}`);
        const p = await res.json();
        validate(p);
        // An unchanged snapshot (same generatedAt, e.g. still in the CDN cache) keeps the current render.
        fresh = !state.payload || p.generatedAt !== state.payload.generatedAt;
        state.error = null;
        state.receivedAt = Date.now();
        state.sameSnapshot = !fresh;
        if (fresh) {
          state.payload = p;
          onPayload();
        }
        // A snapshot older than its s-maxage was served stale-while-revalidate: the CDN is fetching a
        // new one in the background, so ask once more shortly instead of waiting for the minute tick.
        if (!snapshotAge(p, Date.now()).current && state.retryFor !== p.generatedAt) {
          state.retryFor = p.generatedAt;
          state.retryPending = true;
          setTimeout(() => {
            state.retryPending = false;
            load();
          }, REVALIDATE_RETRY_MS);
        }
      } catch (e) {
        state.error = e && e.name === 'AbortError' ? new Error(`No response within ${TIMEOUT_MS / 1000} s`) : e instanceof Error ? e : new Error(String(e));
        console.error('paxos load failed', e);
      } finally {
        clearTimeout(timer);
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
      if (q !== root.location.search) root.history.replaceState(null, '', root.location.pathname + q + root.location.hash);
    } catch {
      /* non-fatal */
    }
  }
  function setState(patch) {
    Object.assign(state, patch);
    state.notice = null;
    syncUrl();
    render();
  }

  function boot() {
    readTokens();
    setupCharts();
    Object.assign(state, parseQuery(root.location.search));
    syncUrl();
    document.addEventListener('click', (e) => {
      const t = e.target.closest('button, [data-asset]');
      if (!t) return;
      if (t.dataset.action === 'reload') return void load();
      if (t.dataset.asset !== undefined && t.closest('#filters, #s-hero, #s-assets')) {
        const a = t.dataset.asset;
        const fromContent = !!t.closest('#s-hero, #s-assets');
        if (a !== state.asset) setState({ asset: a });
        if (fromContent) {
          // The view moves to the filters, so focus moves to the now-pressed filter button too.
          $('filters').scrollIntoView({ block: 'start' });
          const btn = [...$('f-asset').querySelectorAll('button')].find((b) => b.dataset.asset === state.asset);
          if (btn) btn.focus({ preventScroll: true });
        }
        return;
      }
      if (t.dataset.range) return void (t.dataset.range !== state.range && setState({ range: t.dataset.range }));
      if (t.id === 'f-legacy') {
        const legacy = !state.legacy;
        const keep = legacy || state.asset === 'all' || (meta(state.asset) || {}).status === 'active';
        return void setState({ legacy, asset: keep ? state.asset : 'all' });
      }
      if (t.dataset.more) {
        if (state.more.has(t.dataset.more)) state.more.delete(t.dataset.more);
        else state.more.add(t.dataset.more);
        render();
      }
    });
    document.addEventListener(
      'toggle',
      (e) => {
        const d = e.target;
        if (d && d.tagName === 'DETAILS' && d.dataset.k) {
          if (d.open) state.open.add(d.dataset.k);
          else state.open.delete(d.dataset.k);
          if (d.open) for (const c of d.querySelectorAll('canvas')) if (!c._chart && io) io.observe(c);
        }
      },
      true,
    );
    // Source-pill tooltips never run past the viewport edge (they would make the page scroll sideways).
    const clampTip = (e) => {
      const pill = e.target && e.target.closest ? e.target.closest('.pill') : null;
      const tip = pill && pill.querySelector('.tip');
      if (!tip) return;
      tip.style.left = '';
      const fit = () => {
        const r = tip.getBoundingClientRect();
        const over = r.right - (document.documentElement.clientWidth - 16);
        if (r.width && over > 0) tip.style.left = `${-Math.min(over, pill.getBoundingClientRect().left - 16)}px`;
      };
      if (root.requestAnimationFrame) root.requestAnimationFrame(fit);
      else fit();
    };
    document.addEventListener('focusin', clampTip);
    document.addEventListener('mouseover', clampTip);
    root.addEventListener('popstate', () => {
      Object.assign(state, parseQuery(root.location.search));
      if (state.payload) onPayload();
      render();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && expired()) load();
    });
    root.addEventListener('online', () => {
      if (expired() || state.error) load();
    });
    setInterval(() => {
      if (document.visibilityState === 'visible' && state.payload) {
        if (expired()) load();
        else renderHeader();
      }
    }, 60000);
    let rt = null;
    let lastW = root.innerWidth;
    root.addEventListener('resize', () => {
      // Layout budgets (rows shown, tick counts) depend on width; re-render only when it changes materially.
      if (Math.abs(root.innerWidth - lastW) < 120) return;
      clearTimeout(rt);
      rt = setTimeout(() => {
        lastW = root.innerWidth;
        if (state.payload) render();
      }, 250);
    });
    load();
  }
  helpers.render = render;
  helpers.load = load;
  helpers.renderHeader = renderHeader; // tests: the minute tick
  helpers.flushCharts = () => document.querySelectorAll('canvas').forEach(createChart); // tests: draw lazy charts now
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
