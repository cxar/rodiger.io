'use strict';

// Shared formatters for insight headlines/details: factual, plain English, numbers and dates only.

const DAY = 86400;
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// Compact USD: the unit is chosen by magnitude, then the rounded figure moves up a unit when rounding
// reaches 1000 of the current one ($999,999 -> $1.0M, never $1000K). Same tiers as the page.
const UNITS = [[1, '', 0], [1e3, 'K', 0], [1e6, 'M', 1], [1e9, 'B', 2], [1e12, 'T', 2]];
function usd(x) {
  if (!fin(x)) return 'n/a';
  const a = Math.abs(x);
  let i = UNITS.length - 1;
  while (i > 0 && a < UNITS[i][0]) i--;
  let s = (a / UNITS[i][0]).toFixed(UNITS[i][2]);
  if (Number(s) >= 1000 && i < UNITS.length - 1) { i++; s = (a / UNITS[i][0]).toFixed(UNITS[i][2]); }
  s += UNITS[i][1];
  return (x < 0 && Number(s.replace(/[^0-9.]/g, '')) !== 0 ? '-$' : '$') + s;
}
const susd = (x) => (fin(x) && x > 0 ? '+' : '') + usd(x);
// Fractions in, percent strings out.
const pct = (x, d = 1) => (fin(x) ? (x > 0 ? '+' : '') + (100 * x).toFixed(d) + '%' : 'n/a');
const share = (x, d = 1) => (fin(x) ? (100 * x).toFixed(d) + '%' : 'n/a');
// Small shares keep `sig` significant digits (0.0104%, not 0.0%), with at least `d` decimals.
const shareSig = (x, sig = 3, d = 1) => {
  if (!fin(x)) return 'n/a';
  const a = 100 * Math.abs(x), dec = a > 0 ? Math.max(d, sig - 1 - Math.floor(Math.log10(a))) : d;
  return (100 * x).toFixed(Math.min(dec, 10)) + '%';
};
const bp = (x, d = 1) => (fin(x) ? (x * 1e4).toFixed(d) + 'bp' : 'n/a');
const sbp = (x, d = 1) => (fin(x) ? (x > 0 ? '+' : '') + bp(x, d) : 'n/a');
const pp = (x, d = 1) => (fin(x) ? (x > 0 ? '+' : '') + (100 * x).toFixed(d) + 'pp' : 'n/a');
const num = (x, d = 0) => (fin(x) ? Number(x.toFixed(d)).toLocaleString('en-US') : 'n/a');
const fixed = (x, d = 2) => (fin(x) ? x.toFixed(d) : 'n/a');
const times = (x) => (fin(x) ? (x >= 10 ? Math.round(x) : x.toFixed(1)) + 'x' : 'n/a');
const date = (t) => (fin(t) ? new Date(t * 1000).toISOString().slice(0, 10) : 'n/a');
const dateTime = (t) => (fin(t) ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : 'n/a');
const isoTime = (t) => (fin(t) ? new Date(t * 1000).toISOString() : null);
const days = (h) => (h === 1 ? '1 day' : h + ' days');
const ago = (h) => (h === 1 ? '1 day ago' : h + ' days ago');
const pval = (p) => (fin(p) ? (p < 0.001 ? p.toExponential(1) : p < 0.1 ? p.toFixed(4) : p.toFixed(3)) : 'n/a');
// Share of a sample something is "more extreme than", from a percentile in [0,1].
const beat = (q) => (fin(q) ? Math.round(100 * q) + '%' : 'n/a');
function list(xs) {
  const a = xs.filter(Boolean);
  return a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}
// DefiLlama peg type ('pegged' + currency code) to the currency code.
const pegLabel = (pegType) => (pegType ? String(pegType).replace(/^pegged/, '') : 'n/a');

// ---------- plain copy (insight titles, why lines, the briefing): the page's number formats ----------
// Every function returns '' for a non-number, so a sentence drops the clause instead of printing n/a.
// Signs use U+2212 for minus and '+' for gains.
const MINUS = '−';
const signOf = (x) => (x < 0 ? MINUS : '+');
// Money: $5.85B (2 decimals; $311.5B from $100B), $99M (0 decimals from $10M), $2.0M (1 decimal below $10M),
// $850K, $850.
// A figure that rounds up into the next tier moves there ($999.6K -> $1.0M, $9.96M -> $10M).
const MONEY = [[1e12, 1e12, 'T', 2], [1e11, 1e9, 'B', 1], [1e9, 1e9, 'B', 2], [1e7, 1e6, 'M', 0], [1e6, 1e6, 'M', 1], [1e3, 1e3, 'K', 0], [0, 1, '', 0]];
function moneyAbs(a) {
  let i = MONEY.findIndex(([lo]) => a >= lo);
  let s = (a / MONEY[i][1]).toFixed(MONEY[i][3]);
  while (i > 0 && Number(s) * MONEY[i][1] >= MONEY[i - 1][0]) { i--; s = (a / MONEY[i][1]).toFixed(MONEY[i][3]); }
  return '$' + s + MONEY[i][2];
}
const money = (x) => (fin(x) ? (x < 0 && moneyAbs(-x) !== '$0' ? MINUS : '') + moneyAbs(Math.abs(x)) : '');
const smoney = (x) => (fin(x) ? (moneyAbs(Math.abs(x)) === '$0' ? '' : signOf(x)) + moneyAbs(Math.abs(x)) : '');
// Percent change, fraction in: 2 decimals below 0.1%, 1 below 10%, 0 from 10% (never "100%" below 100).
function pctAbs(a) {
  if (a === 0) return '0%';
  if (a < 0.005) return '<0.01%';
  let d = a < 0.1 ? 2 : a < 10 ? 1 : 0, s = a.toFixed(d);
  if (d === 2 && Number(s) >= 0.1) s = a.toFixed((d = 1));
  if (d === 1 && Number(s) >= 10) s = a.toFixed((d = 0));
  while (Number(s) >= 100 && a < 100 && d < 2) s = a.toFixed(++d);
  return s + '%';
}
const pctPlain = (f) => (fin(f) ? pctAbs(Math.abs(100 * f)) : '');
// Signed; a change too small to print (under 0.005%) reads as about zero.
const spctPlain = (f) => (!fin(f) ? '' : f !== 0 && Math.abs(100 * f) < 0.005 ? '\u2248 0%' : (f === 0 ? '' : signOf(f)) + pctAbs(Math.abs(100 * f)));
// Shares, fraction in: 2 significant digits below 1% (0.99%, 0.0084%), 2 decimals below 10% (1.88%),
// 0 decimals from 10% (46%). `extra` adds digits (two shares that would print alike).
function sharePlain(f, extra = 0) {
  if (!fin(f)) return '';
  const a = Math.abs(100 * f);
  if (a === 0) return '0%';
  if (a < 1e-4) return (f < 0 ? MINUS : '') + '<0.0001%';
  let s = a < 1 ? a.toPrecision(2 + extra) : a.toFixed((a < 10 ? 2 : 0) + extra);
  if (a < 1 && Number(s) >= 1) s = a.toFixed(2 + extra);
  if (a < 10 && Number(s) >= 10) s = a.toFixed(extra);
  if (Number(s) >= 100 && a < 100) s = a.toFixed(1 + extra);
  return (f < 0 ? MINUS : '') + s + '%';
}
// Distance from $1 as a percent of $1, 2 decimals; ceil rounds up (truthful "within" / "or less") unless
// the figure exceeds its rounded value by under 0.001% (0.0302% is "within 0.03%", as a table prints it).
const pegPct = (f, { ceil = false } = {}) => {
  if (!fin(f)) return '';
  const hundredths = Math.abs(100 * f) * 100; // in 0.01% steps
  return (ceil ? Math.max(f ? 1 : 0, Math.ceil(hundredths - 0.1)) / 100 : hundredths / 100).toFixed(2) + '%';
};
// Ounces (or another native unit): thousands separators; whole units from 100, else up to 2 decimals.
function ounces(x, { signed = false, unit = 'oz' } = {}) {
  if (!fin(x)) return '';
  const a = Math.abs(x), s = a >= 100 ? Math.round(a).toLocaleString('en-US') : String(Number(a.toFixed(a >= 1 ? 1 : 2)));
  return (signed ? (x === 0 ? '' : signOf(x)) : x < 0 ? MINUS : '') + s + (unit ? ' ' + unit : '');
}
// 'Sep 11' when the date is in the same year as ref (both YYYY-MM-DD...), else 'Mar 2023'.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthDay(iso, ref) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  const mon = MONTHS[Number(m[2]) - 1], day = Number(m[3]), r = /^(\d{4})/.exec(String(ref || ''));
  return !r ? `${mon} ${day}, ${m[1]}` : r[1] === m[1] ? `${mon} ${day}` : `${mon} ${m[1]}`;
}
const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const overDays = (h) => (h === 1 ? 'yesterday' : `over ${h} days`);
// Counted words (the page's word budget): whitespace tokens whose first letter-or-digit is a letter, so
// tickers and names count while $5.85B, -1.0%, 7d and glyphs do not.
const wordsCount = (s) => String(s || '').split(/\s+/).filter((w) => { const c = /[A-Za-z0-9]/.exec(w); return Boolean(c) && /[A-Za-z]/.test(c[0]); }).length;

module.exports = {
  DAY, usd, susd, pct, share, shareSig, bp, sbp, pp, num, fixed, times, date, dateTime, isoTime, days, ago, pval, beat, list, pegLabel,
  MINUS, money, smoney, pctPlain, spctPlain, sharePlain, pegPct, ounces, monthDay, ord, overDays, wordsCount,
};
