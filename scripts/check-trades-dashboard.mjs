import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const manifest = require('../config/hyperliquid-live-strategy.json');
const {
  HOUR_MS,
  topOfBook,
  flattenOrders,
  evaluateProtection,
  evaluateMarketSignal,
  buildPublicStatus
} = require('../lib/hyperliquid-strategy.js');
const html = fs.readFileSync(new URL('../pages/trades/index.html', import.meta.url), 'utf8');
const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const vercelBuild = fs.readFileSync(new URL('./build-vercel.sh', import.meta.url), 'utf8');
const vercelIgnore = fs.readFileSync(new URL('../.vercelignore', import.meta.url), 'utf8');

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.version, 'zec-positive-funding-pump-fade-v4-tp250-r6tier20');
assert.equal(manifest.symbol, 'ZEC');
assert.equal(manifest.side, 'short');
assert.equal(manifest.rule.minReturnExclusive, 0.03);
assert.equal(manifest.rule.minFundingRate, 0.00002);
assert.equal(manifest.rule.maxSpreadBps, 5);
assert.equal(manifest.execution.takeProfitBps, 250);
assert.equal(manifest.execution.stopLossBps, 800);
assert.equal(manifest.execution.maxHoldHours, 6);
assert.equal(manifest.execution.entrySlippageBps, 15);
assert.equal(manifest.execution.exitSlippageBps, 50);
assert.equal(manifest.execution.roundTripRiskAllowanceBps, 83);
assert.equal(manifest.risk.baseAccountRiskFraction, 0.15);
assert.equal(manifest.risk.strongReturnExclusive, 0.05);
assert.equal(manifest.risk.strongAccountRiskFraction, 0.2);

const latestStart = 50 * HOUR_MS;
const nowMs = latestStart + HOUR_MS + 60_000;
function candles(lastClose = 104, shiftMs = 0) {
  const firstStart = latestStart - 24 * HOUR_MS + shiftMs;
  return Array.from({ length: 25 }, (_, index) => {
    const start = firstStart + index * HOUR_MS;
    const close = index === 24 ? lastClose : 100;
    return { t: start, T: start + HOUR_MS - 1, o: close, h: close + 1, l: close - 1, c: close, v: 1000 };
  });
}
function funding(rate = 0.00002, start = latestStart) {
  return [{ time: start + HOUR_MS, fundingRate: String(rate) }];
}
function book(mid = 104, spreadBps = 2) {
  const half = mid * spreadBps / 20_000;
  return { levels: [[{ px: String(mid - half) }], [{ px: String(mid + half) }]] };
}

const passing = evaluateMarketSignal({ candleRows: candles(), fundingRows: funding(), book: book(), nowMs });
assert.equal(passing.dataComplete, true);
assert.equal(passing.marketRulePasses, true);
assert.equal(passing.riskTier, 'base');
assert.equal(passing.maxAccountRiskFraction, 0.15);

const strong = evaluateMarketSignal({ candleRows: candles(106), fundingRows: funding(), book: book(106), nowMs });
assert.equal(strong.marketRulePasses, true);
assert.equal(strong.riskTier, 'strong_r6');
assert.equal(strong.maxAccountRiskFraction, 0.2);

const exactThreshold = evaluateMarketSignal({ candleRows: candles(103), fundingRows: funding(), book: book(103), nowMs });
assert.equal(exactThreshold.marketRulePasses, false, 'the 3% return gate must remain strictly greater-than');
assert.ok(exactThreshold.blockers.some((reason) => reason.includes('not above 3%')));

const missingFunding = evaluateMarketSignal({ candleRows: candles(), fundingRows: [], book: book(), nowMs });
assert.equal(missingFunding.dataComplete, false);
assert.equal(missingFunding.marketRulePasses, false);
assert.ok(missingFunding.blockers.includes('post-signal funding settlement is missing'));

const staleCandles = evaluateMarketSignal({ candleRows: candles(104, -HOUR_MS), fundingRows: funding(0.00002, latestStart - HOUR_MS), book: book(), nowMs });
assert.equal(staleCandles.marketRulePasses, false);
assert.ok(staleCandles.blockers.includes('latest completed hourly candle is stale'));

const missingBook = evaluateMarketSignal({ candleRows: candles(), fundingRows: funding(), book: {}, nowMs });
assert.equal(missingBook.dataComplete, false);
assert.equal(missingBook.marketRulePasses, false);
assert.ok(missingBook.blockers.includes('top of book is missing or invalid'));

assert.equal(topOfBook({ levels: [[{ px: '100' }], [{ px: '100' }]] }).error, 'top of book is missing or invalid', 'locked books must fail closed');
const nestedOrders = flattenOrders([{ children: [{ coin: 'ZEC', oid: 1 }, { coin: 'ZEC', oid: 2 }] }]);
assert.deepEqual(nestedOrders.map((order) => order.oid), [1, 2], 'frontend order children must be flattened');
assert.equal(evaluateProtection([], []).status, 'not_required');
const orphanProtection = evaluateProtection([], [
  { coin: 'ZEC', side: 'B', sz: 2, reduceOnly: true, isTrigger: true, orderType: 'Stop Market' }
]);
assert.equal(orphanProtection.status, 'unprotected', 'orphan ZEC orders while flat must be visible');
assert.ok(orphanProtection.blockers.some((reason) => reason.includes('while the account is flat')));
const shortPosition = [{ coin: 'ZEC', szi: -2 }];
const bracketOrders = [
  { coin: 'ZEC', side: 'B', sz: 2, reduceOnly: true, isTrigger: true, orderType: 'Take Profit Market' },
  { coin: 'ZEC', side: 'B', sz: 2, reduceOnly: true, isTrigger: true, orderType: 'Stop Market' }
];
assert.equal(evaluateProtection(shortPosition, bracketOrders).status, 'protected');
const unprotected = evaluateProtection(shortPosition, bracketOrders.slice(0, 1));
assert.equal(unprotected.status, 'unprotected');
assert.ok(unprotected.blockers.some((reason) => reason.includes('exactly two')));

const publicPayloads = {
  clearinghouseState: { marginSummary: { accountValue: '450', totalMarginUsed: '0', totalNtlPos: '0' }, withdrawable: '450', assetPositions: [] },
  frontendOpenOrders: [],
  portfolio: [],
  userFills: [],
  candleSnapshot: candles(),
  fundingHistory: funding(),
  l2Book: book()
};
const mockFetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  return { ok: true, status: 200, json: async () => publicPayloads[request.type] };
};
const contract = await buildPublicStatus({ nowMs, fetchImpl: mockFetch });
assert.equal(contract.schemaVersion, 1);
assert.equal(contract.strategy.version, manifest.version);
assert.equal(contract.account.address, manifest.accountAddress);
assert.equal(contract.signal.marketRulePasses, true);
assert.equal(contract.signal.executionEligibility, null);
assert.equal(contract.protection.status, 'not_required');
assert.equal(contract.status.observerScope, 'public_exchange_only');
assert.equal(contract.status.localDaemonHealth, 'not_publicly_observable');
assert.equal(contract.services.executor, 'not_publicly_observable');
assert.ok(!JSON.stringify(contract).toLowerCase().includes('privatekey'));

const missingAccountFetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  return { ok: true, status: 200, json: async () => request.type === 'clearinghouseState' ? null : publicPayloads[request.type] };
};
await assert.rejects(
  buildPublicStatus({ nowMs, fetchImpl: missingAccountFetch }),
  /required public account state is unavailable/,
  'missing account data must fail the public status endpoint closed'
);

assert.ok(html.includes('fetch("/api/trades"'), 'dashboard must consume the versioned public status endpoint');
assert.ok(html.includes('no stale strategy is being shown'), 'dashboard failures must be visible and must not render stale strategy copy');
for (const staleCopy of ['cross-sectional momentum', 'maker-first', 'Next Rebalance', '−45% kill-switch']) {
  assert.ok(!html.includes(staleCopy), `dashboard must not retain retired copy: ${staleCopy}`);
}
assert.equal(vercel.buildCommand, 'bash scripts/build-vercel.sh');
assert.ok(vercelBuild.includes('node scripts/check-trades-dashboard.mjs'), 'Vercel build must run dashboard contract checks');
assert.match(vercelIgnore, /^target\/$/m, 'Vercel uploads must exclude the local Rust build cache');

console.log('trades dashboard contract checks passed');
