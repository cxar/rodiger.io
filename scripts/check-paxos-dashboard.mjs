#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../pages/paxos/index.html', import.meta.url), 'utf8');

function assertIncludes(needle, message) {
  assert.ok(html.includes(needle), message || `Expected dashboard HTML to include ${needle}`);
}

assertIncludes('Paxos Stablecoin Dashboard', 'dashboard title should remain present');
assertIncludes('id="supply-momentum-chart"', 'dashboard should include a live supply momentum chart canvas');
assertIncludes('id="chain-trend-chart"', 'dashboard should include a live chain adoption trend chart canvas');
assertIncludes('USDG vs PYUSD Supply', 'dashboard should label absolute USDG/PYUSD supply comparison clearly');
assertIncludes('id="paxos-mix-chart"', 'dashboard should include a live USDG/PYUSD supply comparison chart canvas');
assertIncludes('id="adoption-brief"', 'dashboard should include a concise adoption brief panel');
assertIncludes('buildMomentumSeries', 'dashboard JS should compute daily net issuance from live history');
assertIncludes('buildChainTrendSeries', 'dashboard JS should compute chain-level adoption trends from live DefiLlama chain histories');
assertIncludes('renderSupplyMomentum', 'dashboard JS should render the supply momentum graph');
assertIncludes('renderChainTrend', 'dashboard JS should render chain adoption trend graph');
assertIncludes('renderPaxosMix', 'dashboard JS should render USDG/PYUSD mix over time');
assertIncludes('Daily refreshed on-chain data', 'Dune section should be labeled as daily refreshed, not live page-load data');
assertIncludes('Chain-summed Active Addresses', 'Dune address metrics should disclose chain-summed rather than globally de-duplicated counting');
assertIncludes('function esc(value)', 'dashboard should escape external text before injecting into new HTML templates');
assertIncludes('function stableId(asset)', 'dashboard should normalize DefiLlama IDs before comparing target stablecoins');
assertIncludes('Number(row.trades) || 0', 'Dune DEX trade counts should be numeric-coerced before innerHTML insertion');
assert.ok(!html.includes('Live on-chain data from <a href="https://dune.com"'), 'Dune cache must not be mislabeled as live data');

const scriptMatch = html.match(/<script>\n([\s\S]*)\n\s*<\/script>/);
assert.ok(scriptMatch, 'expected one inline dashboard script');
assert.doesNotThrow(() => new Function(scriptMatch[1]), 'embedded dashboard script should parse as JavaScript');

console.log('paxos dashboard static checks passed');
