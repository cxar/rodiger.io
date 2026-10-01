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

module.exports = { DAY, usd, susd, pct, share, shareSig, bp, sbp, pp, num, fixed, times, date, dateTime, isoTime, days, ago, pval, beat, list, pegLabel };
