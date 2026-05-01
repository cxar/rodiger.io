#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../pages/paxos/index.html', import.meta.url), 'utf8');
const duneFetcher = readFileSync(new URL('./fetch-dune.js', import.meta.url), 'utf8');

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
assertIncludes('id="executive-readout"', 'dashboard should include an executive what-changed readout');
assertIncludes('id="portfolio-scorecard"', 'dashboard should include a product/portfolio scorecard');
assertIncludes('id="momentum-scorecard"', 'dashboard should include a momentum scorecard');
assertIncludes('id="driver-waterfall-chart"', 'dashboard should include a dynamic contribution waterfall chart');
assertIncludes('id="watchlist-alerts"', 'dashboard should include a dynamic watchlist/alert section');
assertIncludes('renderExecutiveReadout', 'dashboard JS should render business readout from live metrics');
assertIncludes('buildBusinessSnapshot', 'dashboard JS should derive doing-well/needs-attention/watchlist signals dynamically');
assertIncludes('peerPositionHeadline', 'executive readout should use a data-only peer-position tile, not an opinionated action recommendation');
assertIncludes('Peer position', 'executive readout should label the fourth tile as data, not recommended action');
assertIncludes('renderDriverWaterfall', 'dashboard JS should render selected-period drivers, not fixed-window data');
assertIncludes('selectedPeriodDelta', 'dashboard JS should compute deltas using the selected period');
assertIncludes('renderSupplyMomentum(history, color, assetLabel, period)', 'supply momentum smoothing should follow the selected period');
assertIncludes('periodDays(period)', 'dashboard should derive day windows from the selected period instead of hard-coded chart windows');
assertIncludes('tokens.length - 31', '30d chain deltas should use a full 30 daily intervals, not a 29-interval off-by-one');
assertIncludes('tokens.length - 8', '7d chain deltas should use a full 7 daily intervals, not a 6-interval off-by-one');
assertIncludes('history.slice(-(paceDays + 1))', 'race pace should use selected-period intervals with one more point than days');
assertIncludes('assetIds.length === 1', 'combined peer rank should use synthetic combined growth, not one component asset rank');
assertIncludes('volume_7d', 'Dune DEX/activity data should support 7d dynamic windows');
assertIncludes('trades_7d', 'Dune DEX data should support 7d dynamic windows');
assertIncludes('Daily refreshed on-chain data', 'Dune section should be labeled as daily refreshed, not live page-load data');
assertIncludes('Chain-summed Active Addresses', 'Dune address metrics should disclose chain-summed rather than globally de-duplicated counting');
assertIncludes('function esc(value)', 'dashboard should escape external text before injecting into new HTML templates');
assertIncludes('function stableId(asset)', 'dashboard should normalize DefiLlama IDs before comparing target stablecoins');
assertIncludes('Number(row.trades_7d) || 0', 'Dune DEX 7d trade counts should be numeric-coerced before innerHTML insertion');
assertIncludes('Number(row.trades_30d ?? row.trades) || 0', 'Dune DEX 30d trade counts should be numeric-coerced with backward-compatible cached-data fallback');
assert.ok(!html.includes('Live on-chain data from <a href="https://dune.com"'), 'Dune cache must not be mislabeled as live data');
assert.ok(!html.includes('Recommended action'), 'executive readout must not include opinionated recommended-action copy');
assert.ok(!html.includes('const recommended'), 'business snapshot should not synthesize subjective recommendations');
assert.ok(!html.includes('snapshot.recommended'), 'executive readout should render data signals directly');
assert.ok(!html.includes('Investigate '), 'dashboard should not tell the reader what to investigate from generated opinion copy');
assert.ok(!html.includes('Use the peer and chain leaders'), 'dashboard should not emit subjective recommended-action fallback copy');
assert.ok(!html.includes('DEX Trading Activity (30d)'), 'DEX section title must not be fixed to 30d');
assert.ok(!html.includes('buildMomentumSeries(history, 45)'), 'adoption/momentum panels must not trim to a hidden fixed 45-day window');
assert.ok(!html.includes('buildMomentumSeries(history, 120)'), 'supply momentum graph must not trim to a hidden fixed 120-day window');
assert.ok(!html.includes('buildPaxosMixSeries(usdgHistory, pyusdHistory, 240)'), 'Paxos mix graph must not trim to a hidden fixed 240-day window');
assert.ok(!html.includes('buildChainTrendSeries(chainBalanceMaps, 5, 180)'), 'chain trend graph must not trim to a hidden fixed 180-day window');
assert.ok(duneFetcher.includes('volume_7d'), 'Dune fetcher should emit 7d DEX volume for dynamic period toggles');
assert.ok(duneFetcher.includes('trades_7d'), 'Dune fetcher should emit 7d DEX trades for dynamic period toggles');
assert.ok(duneFetcher.includes('trades_30d'), 'Dune fetcher should emit explicit 30d DEX trades for dynamic period toggles');

const scriptMatch = html.match(/<script>\n([\s\S]*)\n\s*<\/script>/);
assert.ok(scriptMatch, 'expected one inline dashboard script');
assert.doesNotThrow(() => new Function(scriptMatch[1]), 'embedded dashboard script should parse as JavaScript');

console.log('paxos dashboard static checks passed');
