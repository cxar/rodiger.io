import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const manifest = require('../config/hyperliquid-live-strategy.json');
const researchManifest = require('../config/hyperliquid-research-lanes.json');
const {
  validateSnapshot: validateResearchSnapshot,
  buildResearchLanesStatus
} = require('../lib/hyperliquid-research-lanes.js');
const {
  HOUR_MS,
  topOfBook,
  flattenOrders,
  evaluateProtection,
  evaluateMarketSignal,
  accountPerformance,
  buildPublicStatus
} = require('../lib/hyperliquid-strategy.js');
const html = fs.readFileSync(new URL('../pages/trades/index.html', import.meta.url), 'utf8');
const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const vercelBuild = fs.readFileSync(new URL('./build-vercel.sh', import.meta.url), 'utf8');
const vercelIgnore = fs.readFileSync(new URL('../.vercelignore', import.meta.url), 'utf8');

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.version, 'zec-positive-funding-pump-fade-v5-tp250-r6gt5only-r3cooldown');
assert.equal(manifest.symbol, 'ZEC');
assert.equal(manifest.side, 'short');
assert.equal(manifest.accounting.baselineEquityUsd, 630.617157);
assert.equal(manifest.accounting.cashFlowCutoffMs, 1780668248226);
assert.equal(manifest.rule.minReturnExclusive, 0.03);
assert.equal(manifest.rule.liveEntryMinReturnExclusive, 0.05);
assert.equal(manifest.rule.minFundingRate, 0.00002);
assert.equal(manifest.rule.maxSpreadBps, 5);
assert.equal(manifest.execution.takeProfitBps, 250);
assert.equal(manifest.execution.stopLossBps, 800);
assert.equal(manifest.execution.maxHoldHours, 6);
assert.equal(manifest.execution.entrySlippageBps, 15);
assert.equal(manifest.execution.exitSlippageBps, 50);
assert.equal(manifest.execution.roundTripRiskAllowanceBps, 83);
assert.equal(manifest.execution.ordinarySignalsSubmitOrders, false);
assert.equal(manifest.risk.baseAccountRiskFraction, 0);
assert.equal(manifest.risk.strongReturnExclusive, 0.05);
assert.equal(manifest.risk.strongAccountRiskFraction, 0.2);
assert.equal(manifest.schedule.regimeCooldownIncludesOrdinarySignals, true);

validateResearchSnapshot(researchManifest);
assert.equal(researchManifest.schemaVersion, 1);
assert.equal(researchManifest.observerScope, 'published_local_snapshot');
assert.equal(researchManifest.localDaemonHealth, 'not_publicly_observable');
const researchLaneIds = researchManifest.lanes.map((lane) => lane.id);
const expectedResearchLanes = [
  ['adaptive-ensemble-one-position-forward', 'adaptive-ensemble-one-position-forward-v2'],
  ['funding-squeeze-forward-source', 'funding-squeeze-forward-source-v4'],
  ['smart-money-directional-forward', 'smart-money-directional-forward-v10'],
  ['impact-skew-l2-forward', 'impact-skew-target-l2-causal-entry-v2.3'],
  ['macro-prediction-distribution-forward', 'macro-prediction-distribution-forward-v19'],
  ['skhx-skhy-settlement-basis-forward', 'skhx-skhy-settlement-basis-forward-v1'],
  ['deribit-near-dated-directional-option-flow-lead-v2', 'deribit-near-dated-directional-option-flow-lead-v2'],
  ['deribit-near-dated-directional-option-flow-lead', 'deribit-near-dated-directional-option-flow-lead-v1'],
  ['new-listing-positive-funding-blowoff-fade-forward', 'new-listing-positive-funding-blowoff-fade-forward-v1'],
  ['tsmc-earnings-relative-value-forward', 'tsmc-earnings-relative-value-forward-v10'],
  ['principled-research-lab-aggregate', 'principled-research-lab-aggregate-v1']
];
assert.deepEqual(
  researchManifest.lanes.map((lane) => [lane.id, lane.collectorVersion]),
  expectedResearchLanes,
  'research inventory must match the exact reviewed current set'
);
assert.equal(new Set(researchLaneIds).size, expectedResearchLanes.length, 'research lane ids must be unique');
assert.equal(researchManifest.lanes.some((lane) => lane.collectorVersion === 'smart-money-directional-forward-v5'), false);
assert.equal(researchManifest.lanes.some((lane) => lane.collectorVersion === 'macro-prediction-distribution-forward-v1'), false);
for (const lane of researchManifest.lanes) {
  assert.equal(lane.mode, 'paper');
  assert.equal(lane.paperOnly, true);
  assert.equal(lane.liveApproved, false);
  assert.equal(lane.promotionApproved, false);
  assert.equal(lane.crossEpochPoolingAllowed, false);
  assert.equal(typeof lane.source.manifestIdentityValid, 'boolean');
  assert.ok(lane.source.manifestSha256 === null || /^[0-9a-f]{64}$/.test(lane.source.manifestSha256));
  assert.ok(lane.source.stateMaterialSha256 === null || /^[0-9a-f]{64}$/.test(lane.source.stateMaterialSha256));
  const expectedSourceKeys = lane.id === 'principled-research-lab-aggregate'
    ? ['ledgerRawSha256', 'manifestIdentityValid', 'manifestSha256', 'reportRawSha256', 'schemaSha256', 'stateMaterialSha256']
    : ['manifestIdentityValid', 'manifestSha256', 'stateMaterialSha256'];
  assert.deepEqual(Object.keys(lane.source).sort(), expectedSourceKeys);
  if (lane.id === 'principled-research-lab-aggregate') {
    assert.match(lane.source.schemaSha256, /^[0-9a-f]{64}$/);
    assert.match(lane.source.reportRawSha256, /^[0-9a-f]{64}$/);
    assert.match(lane.source.ledgerRawSha256, /^[0-9a-f]{64}$/);
  }
}
const smartMoneyResearchLane = researchManifest.lanes.find((lane) => lane.id === 'smart-money-directional-forward');
const adaptiveResearchLane = researchManifest.lanes.find((lane) => lane.id === 'adaptive-ensemble-one-position-forward');
const macroResearchLane = researchManifest.lanes.find((lane) => lane.id === 'macro-prediction-distribution-forward');
const skhxSkhyResearchLane = researchManifest.lanes.find((lane) => lane.id === 'skhx-skhy-settlement-basis-forward');
const deribitV2ResearchLane = researchManifest.lanes.find((lane) => lane.id === 'deribit-near-dated-directional-option-flow-lead-v2');
const invalidDeribitResearchLane = researchManifest.lanes.find((lane) => lane.id === 'deribit-near-dated-directional-option-flow-lead');
const newListingResearchLane = researchManifest.lanes.find((lane) => lane.id === 'new-listing-positive-funding-blowoff-fade-forward');
const tsmcResearchLane = researchManifest.lanes.find((lane) => lane.id === 'tsmc-earnings-relative-value-forward');
const principledResearchLabLane = researchManifest.lanes.find((lane) => lane.id === 'principled-research-lab-aggregate');
assert.equal(smartMoneyResearchLane.collectorVersion, 'smart-money-directional-forward-v10');
assert.equal(macroResearchLane.collectorVersion, 'macro-prediction-distribution-forward-v19');
assert.equal(skhxSkhyResearchLane.operationalStatus, 'failed_closed');
assert.equal(skhxSkhyResearchLane.evidence.coverageGapOpen, true);
assert.equal(deribitV2ResearchLane.operationalStatus, 'rejected_prelaunch_integrity_review');
assert.equal(deribitV2ResearchLane.quarantined, true);
assert.equal(deribitV2ResearchLane.evidence.failedClosed, true);
assert.equal(deribitV2ResearchLane.evidence.evidenceHealthy, false);
assert.equal(invalidDeribitResearchLane.operationalStatus, 'invalid_prelaunch_cutoff_identity_mismatch');
assert.equal(invalidDeribitResearchLane.quarantined, true);
assert.equal(invalidDeribitResearchLane.evidence.failedClosed, true);
assert.equal(invalidDeribitResearchLane.evidence.evidenceHealthy, false);
assert.equal(invalidDeribitResearchLane.source.manifestIdentityValid, false);
assert.equal(invalidDeribitResearchLane.source.manifestSha256, null);
assert.equal(invalidDeribitResearchLane.source.stateMaterialSha256, null);
assert.equal(newListingResearchLane.collectorVersion, 'new-listing-positive-funding-blowoff-fade-forward-v1');
assert.equal(tsmcResearchLane.collectorVersion, 'tsmc-earnings-relative-value-forward-v10');
assert.equal(tsmcResearchLane.operationalStatus, 'failed_closed');
assert.equal(tsmcResearchLane.evidence.failedClosed, true);
assert.equal(tsmcResearchLane.evidence.coverageGapOpen, true);
assert.equal(tsmcResearchLane.evidence.evidenceHealthy, false);
assert.equal(tsmcResearchLane.evidence.failureReason, 'parent_chain_identity_restart_loop');
assert.equal(tsmcResearchLane.paperOnly, true);
assert.equal(tsmcResearchLane.liveApproved, false);
assert.equal(tsmcResearchLane.promotionApproved, false);
assert.equal(tsmcResearchLane.source.manifestSha256, '5adb6d7b9a7587f91e523f9ed4ad0527cd669878dfe1a59e2bbce84a5d19df9f');
assert.equal(principledResearchLabLane.collectorVersion, 'principled-research-lab-aggregate-v1');
assert.equal(['paper_position_open', 'running_flat'].includes(principledResearchLabLane.operationalStatus), true);
assert.equal(principledResearchLabLane.paperOnly, true);
assert.equal(principledResearchLabLane.liveApproved, false);
assert.equal(principledResearchLabLane.promotionApproved, false);
assert.equal(principledResearchLabLane.evidence.evidenceHealthy, true);
assert.equal(principledResearchLabLane.evidence.failedClosed, false);
assert.equal(principledResearchLabLane.evidence.liveApproved, false);
assert.equal(Number.isInteger(principledResearchLabLane.evidence.paperPositionCount), true);
assert.equal(Number.isFinite(principledResearchLabLane.evidence.paperEquityUsd), true);
assert.equal(Number.isInteger(principledResearchLabLane.evidence.forwardObservationCount), true);
assert.equal(Number.isFinite(principledResearchLabLane.evidence.forwardDurationHours), true);
assert.equal(Number.isInteger(principledResearchLabLane.evidence.readyCount), true);
assert.equal(Number.isInteger(principledResearchLabLane.evidence.eligibleCount), true);
assert.equal(principledResearchLabLane.source.schemaSha256, '58bcf0598d4af7f4f62b94b9eee478a4d4fba4d0744e263f1ae2836c6d890de2');
const latestStart = 50 * HOUR_MS;
const nowMs = latestStart + HOUR_MS + 60_000;
function researchSnapshot(atMs = nowMs) {
  const snapshot = structuredClone(researchManifest);
  snapshot.publishedAtMs = atMs;
  snapshot.publishedAt = new Date(atMs).toISOString();
  for (const lane of snapshot.lanes) {
    if (lane.observedAtMs !== null) lane.observedAtMs = atMs;
  }
  return snapshot;
}
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
assert.equal(passing.regimeRulePasses, true);
assert.equal(passing.marketRulePasses, false);
assert.equal(passing.riskTier, 'virtual_regime_only');
assert.equal(passing.maxAccountRiskFraction, 0);

const strong = evaluateMarketSignal({ candleRows: candles(106), fundingRows: funding(), book: book(106), nowMs });
assert.equal(strong.marketRulePasses, true);
assert.equal(strong.regimeRulePasses, true);
assert.equal(strong.riskTier, 'strong_r6');
assert.equal(strong.maxAccountRiskFraction, 0.2);

const exactThreshold = evaluateMarketSignal({ candleRows: candles(103), fundingRows: funding(), book: book(103), nowMs });
assert.equal(exactThreshold.marketRulePasses, false, 'the 3% return gate must remain strictly greater-than');
assert.equal(exactThreshold.regimeRulePasses, false, 'the 3% regime gate must remain strictly greater-than');
assert.ok(exactThreshold.regimeBlockers.some((reason) => reason.includes('not above 3%')));

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
  userNonFundingLedgerUpdates: [],
  candleSnapshot: candles(),
  fundingHistory: funding(),
  l2Book: book()
};
const mockFetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  return { ok: true, status: 200, json: async () => publicPayloads[request.type] };
};
const contract = await buildPublicStatus({
  nowMs,
  fetchImpl: mockFetch,
  researchSnapshot: researchSnapshot()
});
assert.equal(contract.schemaVersion, 1);
assert.deepEqual(contract.strategy, manifest, 'research lanes must not mutate the frozen live strategy object');
assert.equal(contract.strategy.version, manifest.version);
assert.equal(contract.account.address, manifest.accountAddress);
assert.equal(contract.account.performance.status, 'reconciled');
assert.equal(contract.account.performance.subsequentCashFlowCount, 0);
assert.equal(contract.account.performance.lifetimeTradingPnlUsd, 450 - 630.617157);
assert.equal(
  contract.account.performance.lifetimeTradingReturnPct,
  ((450 - 630.617157) / 630.617157) * 100
);
assert.equal(contract.signal.regimeRulePasses, true);
assert.equal(contract.signal.marketRulePasses, false);
assert.equal(contract.signal.executionEligibility, null);
assert.equal(contract.protection.status, 'not_required');
assert.equal(contract.status.observerScope, 'public_exchange_only');
assert.equal(contract.status.localDaemonHealth, 'not_publicly_observable');
assert.equal(contract.services.executor, 'not_publicly_observable');
assert.equal(contract.researchLanes.availability, 'current');
assert.equal(contract.researchLanes.localDaemonHealth, 'not_publicly_observable');
assert.equal(contract.researchLanes.lanes.length, researchManifest.lanes.length);
assert.equal(
  contract.researchLanes.lanes[0].operationalStatus,
  adaptiveResearchLane.operationalStatus,
  'public research status must preserve the validated snapshot lifecycle'
);
assert.equal(contract.researchLanes.lanes[0].liveApproved, false);
const publicInvalidDeribitLane = contract.researchLanes.lanes.find((lane) => lane.id === 'deribit-near-dated-directional-option-flow-lead');
assert.equal(publicInvalidDeribitLane.operationalStatus, 'invalid_prelaunch_cutoff_identity_mismatch');
assert.equal(publicInvalidDeribitLane.quarantined, true);
const publicTsmcLane = contract.researchLanes.lanes.find((lane) => lane.id === 'tsmc-earnings-relative-value-forward');
assert.equal(publicTsmcLane.operationalStatus, 'failed_closed');
assert.equal(publicTsmcLane.evidence.failureReason, 'parent_chain_identity_restart_loop');
assert.equal(publicTsmcLane.paperOnly, true);
assert.equal(publicTsmcLane.liveApproved, false);
const publicPrincipledResearchLabLane = contract.researchLanes.lanes.find((lane) => lane.id === 'principled-research-lab-aggregate');
assert.equal(publicPrincipledResearchLabLane.paperOnly, true);
assert.equal(publicPrincipledResearchLabLane.liveApproved, false);
assert.equal(publicPrincipledResearchLabLane.evidence.liveApproved, false);
assert.equal(publicPrincipledResearchLabLane.evidence.paperPositionCount, principledResearchLabLane.evidence.paperPositionCount);
assert.equal(publicPrincipledResearchLabLane.evidence.forwardObservationCount, principledResearchLabLane.evidence.forwardObservationCount);
assert.ok(!JSON.stringify(contract).toLowerCase().includes('privatekey'));
assert.ok(!JSON.stringify(contract.researchLanes).includes('/Users/'), 'research contract must not expose local paths');

const staleResearch = buildResearchLanesStatus(
  researchSnapshot(nowMs),
  nowMs + researchManifest.staleAfterMs + 1
);
assert.equal(staleResearch.availability, 'stale');
assert.equal(staleResearch.lanes[0].operationalStatus, 'snapshot_stale');
assert.equal(staleResearch.lanes[0].evidence.decisions, null);

const mislabelledLiveResearch = researchSnapshot();
mislabelledLiveResearch.lanes[0].liveApproved = true;
const unavailableResearch = buildResearchLanesStatus(mislabelledLiveResearch, nowMs);
assert.equal(unavailableResearch.availability, 'unavailable');
assert.deepEqual(unavailableResearch.lanes, []);
assert.match(unavailableResearch.blocker, /liveApproved must be false/);
const contractWithMislabelledResearch = await buildPublicStatus({
  nowMs,
  fetchImpl: mockFetch,
  researchSnapshot: mislabelledLiveResearch
});
assert.deepEqual(contractWithMislabelledResearch.strategy, manifest);
assert.equal(contractWithMislabelledResearch.account.accountValueUsd, 450);
assert.equal(contractWithMislabelledResearch.researchLanes.availability, 'unavailable');
assert.deepEqual(contractWithMislabelledResearch.researchLanes.lanes, []);

const futureResearch = buildResearchLanesStatus(researchSnapshot(nowMs + 5_001), nowMs);
assert.equal(futureResearch.availability, 'unavailable');
assert.deepEqual(futureResearch.lanes, []);

const cashFlowFault = accountPerformance(450, [{
  time: manifest.accounting.cashFlowCutoffMs + 1,
  delta: { type: 'send', usdcValue: '1' }
}]);
assert.equal(cashFlowFault.status, 'cash_flow_reconciliation_required');
assert.equal(cashFlowFault.subsequentCashFlowCount, 1);
assert.equal(cashFlowFault.lifetimeTradingPnlUsd, null);
assert.match(cashFlowFault.blocker, /occurred after the accounting baseline/);
const cashFlowUnavailable = accountPerformance(450, null, 'HTTP 503');
assert.equal(cashFlowUnavailable.status, 'unavailable');
assert.match(cashFlowUnavailable.blocker, /cash-flow source unavailable/);

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
assert.ok(html.includes('Live Trading P&L'), 'dashboard must show cash-flow-gated lifetime trading performance');
assert.ok(html.includes('Research / Paper Lanes'), 'dashboard must show research in a separate panel');
assert.ok(html.includes('PAPER ONLY'), 'research lanes must be visibly paper-only');
assert.ok(html.includes('QUARANTINED'), 'invalid research epochs must be visibly quarantined');
assert.ok(html.includes('0% live risk'), 'research lanes must explicitly show zero live risk');
assert.ok(html.includes('local daemon health remains not publicly observable'), 'research snapshot must not claim public daemon health');
assert.ok(html.includes('no stale strategy is being shown'), 'dashboard failures must be visible and must not render stale strategy copy');
for (const staleCopy of ['cross-sectional momentum', 'maker-first', 'Next Rebalance', '−45% kill-switch']) {
  assert.ok(!html.includes(staleCopy), `dashboard must not retain retired copy: ${staleCopy}`);
}
assert.equal(vercel.buildCommand, 'bash scripts/build-vercel.sh');
assert.ok(vercelBuild.includes('node scripts/check-trades-dashboard.mjs'), 'Vercel build must run dashboard contract checks');
assert.match(vercelIgnore, /^target\/$/m, 'Vercel uploads must exclude the local Rust build cache');

console.log('trades dashboard contract checks passed');
