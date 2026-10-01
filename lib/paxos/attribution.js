'use strict';

// "What changed": a deterministic decomposition (no statistics, no filtering by surprise) of the Paxos USD
// supply change over fixed windows, by asset and by asset x chain. Rows are token flows, like every
// "change" on the page: the asset rows are the aggregate's parts (USD stablecoins' native supply at
// today's price, H.aggregate) and the chain rows are the repaired chain panel at the same price (non-USD
// assets: each day's implied price); whatever the chain series do not explain (coverage
// differences between the chain data and the asset total) and chains below the asset's materiality
// floor are folded into one "Other chains" row per asset, so every asset's chain rows sum exactly to it.

const S = require('./stats');
const D = require('./detectors');

const { DAY } = D;
const H = D.helpers;
const OTHER = 'Other chains';
const WINDOWS = { d1: 1, d7: 7, d30: 30, d90: 90, d365: 365, all: null };
const date = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const r0 = (x) => Math.round(x);

function attribution(model0) {
  const model = H.bounded(model0, model0 && model0.now); // future-dated points dropped (none in the normal case)
  const agg = H.aggregate(model);
  if (!agg) return { windows: {} };
  const floors = H.floors(model), n = agg.t.length;
  const assets = model.assets.filter((a) => agg.members.includes(a.key));
  // USD value of each chain of an asset on day t: today's price for USD stablecoins (token flows, as in
  // the aggregate), else the implied price that day (falling back to today's).
  const chainUsd = new Map();
  for (const a of assets) {
    const p = H.chainPanel(model, a), sup = H.grid(a.supply), usd = H.grid(a.supplyUsd), px = H.priceOf(a) || 1, flows = a.kind === 'usd-stablecoin';
    chainUsd.set(a.key, (t) => {
      if (!p) return {};
      const i = Math.min(p.days.length - 1, Math.round((t - p.days[0]) / DAY));
      if (i < 0) return {};
      const s = sup && H.at(sup, t), u = usd && H.at(usd, t), price = !flows && s > 0 && S.isNum(u) ? u / s : px;
      return Object.fromEntries(p.names.map((k) => [k, p.m[k][i] * price]));
    });
  }
  const windows = {};
  for (const [name, h] of Object.entries(WINDOWS)) {
    const i1 = n - 1, i0 = h === null ? 0 : Math.max(0, n - 1 - h);
    const t0 = agg.t[i0], t1 = agg.t[i1];
    const assetRows = [], chainRows = [], parts = [];
    for (const a of assets) {
      const prev = agg.parts[a.key][i0], curr = agg.parts[a.key][i1];
      assetRows.push({ asset: a.key, prevUsd: r0(prev), currUsd: r0(curr), deltaUsd: r0(curr - prev) });
      const c0 = chainUsd.get(a.key)(t0), c1 = chainUsd.get(a.key)(t1), floor = floors[a.key] || 0;
      let shownPrev = 0, shownCurr = 0, otherDust = false;
      for (const chain of [...new Set([...Object.keys(c0), ...Object.keys(c1)])]) {
        const p = c0[chain] || 0, c = c1[chain] || 0;
        parts.push(c - p);
        if (Math.max(Math.abs(p), Math.abs(c)) < floor) { otherDust = true; continue; }
        shownPrev += p;
        shownCurr += c;
        chainRows.push({ asset: a.key, chain, prevUsd: r0(p), currUsd: r0(c), deltaUsd: r0(c - p) });
      }
      // Residual = asset total minus the chains shown; equals folded dust plus any coverage difference.
      const op = prev - shownPrev, oc = curr - shownCurr;
      const chainSum = S.sum(Object.values(c1)) - S.sum(Object.values(c0));
      parts.push(curr - prev - chainSum);
      if (otherDust || Math.abs(op) >= 0.5 || Math.abs(oc) >= 0.5) chainRows.push({ asset: a.key, chain: OTHER, prevUsd: r0(op), currUsd: r0(oc), deltaUsd: r0(oc - op) });
    }
    const net = agg.v[i1] - agg.v[i0], gross = parts.reduce((s, x) => s + Math.abs(x), 0);
    const byAbs = (x, y) => Math.abs(y.deltaUsd) - Math.abs(x.deltaUsd) || (x.asset + x.chain < y.asset + y.chain ? -1 : 1);
    windows[name] = {
      from: date(t0), to: date(t1), totalDeltaUsd: r0(net), grossUsd: r0(gross), rotationUsd: r0(Math.max(0, (gross - Math.abs(net)) / 2)),
      assets: assetRows.sort((x, y) => Math.abs(y.deltaUsd) - Math.abs(x.deltaUsd) || (x.asset < y.asset ? -1 : 1)),
      chains: chainRows.sort(byAbs),
    };
  }
  return { windows };
}

module.exports = { attribution, OTHER, WINDOWS };
