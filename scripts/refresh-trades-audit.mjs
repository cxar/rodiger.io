// Export only explicitly selected, non-secret audit fields. No wallet or network access.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const research = path.resolve(root, '../internet-money-machine');
const sources = [];
function read(relative, expectedSha256 = null) {
  const bytes = fs.readFileSync(path.join(research, relative));
  if (bytes.length > 4_000_000) throw new Error('audit source exceeds size limit');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 && sha256 !== expectedSha256) throw new Error('fixed research source changed');
  sources.push({ name: path.basename(relative), sha256 });
  return JSON.parse(bytes);
}
const account = read('reviews/hl-account-audit-20260905.json');
const participation = read('reviews/hl-zec-v5-participation-audit-20260905.json');
const expansion = read('reviews/hl-aggressive-expansion-audit-20260905.json',
  '8dd055df502838bdc6914a097ab41cbd5deea63f6e30f2636458f5d13e2e1ff6');
const markDepth = read('reviews/hl-zec-v5-mark-depth-audit-20260905-v2.json',
  'be715b94b4608ceb2bde2b5bfa6e03757b8c8704ace727f665473f408a660be2');
const mechanism = read('reviews/hl-pump-failure-mechanism-audit-20260905.json',
  '34b09066d1afe70ea64ac33e4a80abfd98cd3af126c3e7f35a6c9a19e732c126');
if (account.profitabilityProven !== false || participation.counterfactualFillsCredited !== false
    || account.v5.freshNetUsd !== String(participation.actualLiveEconomics.netRealizedUsd)
    || account.v5.tradeCount !== participation.actualLiveEconomics.tradeCount) {
  throw new Error('audit sources disagree');
}
const breadth = expansion.portfolios.thirty_market_price_proxy;
const scenarios = breadth.scenarios.filter(s => s.modeledCostBps === 83);
const risk20 = scenarios.find(s => s.modeledStopRiskFraction === 0.2);
const risk40 = scenarios.find(s => s.modeledStopRiskFraction === 0.4);
if (expansion.submissionCapability !== false || expansion.liveActivation !== false
    || expansion.profitabilityProven !== false || expansion.untouchedOutOfSample !== false
    || expansion.researchUniverse.length !== 30 || breadth.allocatedCount !== 30
    || !risk20 || !risk40 || scenarios.some(s => s.fundingIncluded !== false || s.actualProfitUsd !== null)
    || markDepth.submissionCapability !== false || markDepth.profitabilityProven !== false
    || markDepth.liveRiskChanged !== false || markDepth.events.length !== 6
    || markDepth.events.filter(e => e.actualNetRealizedUsd !== null).length !== account.v5.tradeCount
    || markDepth.events.some(e => e.observations.hypotheticalStrategyPnlUsd !== null)
    || markDepth.events.at(-1).observations.status !== 'missing_samples') {
  throw new Error('research scope or safety labels disagree');
}
const crowding = mechanism.rules.funding_doubled;
const crowding83 = crowding.scenarios.find(s => s.modeledCostBps === 83);
const crowding166 = crowding.scenarios.find(s => s.modeledCostBps === 166);
if (mechanism.submissionCapability !== false || mechanism.liveActivation !== false
    || mechanism.profitabilityProven !== false || mechanism.untouchedOutOfSample !== false
    || mechanism.thresholdsOptimized !== false || mechanism.combinationsTested !== 0
    || mechanism.candidateCount !== 78 || !crowding83 || !crowding166
    || crowding83.modeledStopRiskFraction !== 0.2 || crowding.allocatedCount !== 23
    || Object.values(mechanism.rules).some(r => r.actualProfitUsd !== null || r.netFundingCashIncluded !== false)) {
  throw new Error('mechanism diagnostic scope changed');
}
const firstBoundary = Date.UTC(2026, 8, 5, 17);
const now = Date.now();
const pilot = { firstBoundaryMs: firstBoundary, lastBoundaryMs: firstBoundary + 71 * 3_600_000,
  plannedHours: 72, storedValidHours: 0, finalizedOtherHours: 0, dueHours: 0, lastStoredBoundaryMs: null,
  actualTradingProfitUsd: null, scope: 'Stored accounting-source observations only; no position or earned profit.' };
for (let index = 0; index < pilot.plannedHours; index++) {
  const boundary = firstBoundary + index * 3_600_000;
  if (now >= boundary + 355_000) pilot.dueHours++;
  const relative = `state/hyperliquid/funding-settlement-pilot-20260905/hours/${boundary}/final.json`;
  if (!fs.existsSync(path.join(research, relative))) continue;
  const row = read(relative);
  if (row.boundaryMs !== boundary || row.submissionCapability !== false || row.promotionAuthorized !== false
      || row.manifestSha256 !== '83ddcc899671adae6a51e6bfa857712f963bdfbe03278df55eb7d962a85b1a63') {
    throw new Error('pilot result identity is invalid');
  }
  if (row.status === 'valid_source_interval' && row.rawSourceBindingsVerified === true
      && row.officialHttpsObserved === true && row.derivation?.cashExactAtQuantum === true) {
    pilot.storedValidHours++;
  } else pilot.finalizedOtherHours++;
  pilot.lastStoredBoundaryMs = boundary;
}
pilot.overdueMissingHours = Math.max(0, pilot.dueHours - pilot.storedValidHours - pilot.finalizedOtherHours);
const output = {
  schemaVersion: 1,
  assembledAt: new Date(now).toISOString(),
  accountEvidenceThrough: new Date(account.cutoffMs).toISOString(),
  signalEvidenceThrough: new Date(participation.auditThroughSignalStartMs + 3_600_000).toISOString(),
  profitabilityProven: false,
  auditRefreshAfterMs: 86_400_000,
  allCapturedTradingNetUsd: account.accounting.netTradingPnlUsd,
  v5: { netRealizedUsd: account.v5.freshNetUsd, completedTrades: account.v5.tradeCount,
    selectedStrongSignals: participation.strongSelectedEvents,
    unfilledStrongSignals: participation.strongSelectedEvents - account.v5.tradeCount,
    missedSignalPnlUsd: null,
    note: 'Three filled trades are a small selected sample, not proof of a profitable full-signal strategy.' },
  fundingPilot: pilot,
  findingsAsOf: '2026-09-05',
  findings: [
    { name: 'Aggressive 30-market test', status: 'More risk magnified modeled losses', detail: `The 30-entry retrospective price simulation returned ${risk20.hypotheticalReturnPct.toFixed(2)}% at 20% modeled stop risk and ${risk40.hypotheticalReturnPct.toFixed(2)}% at 40%, using 83 bp costs and excluding funding. These are hypothetical returns, not actual losses or a clean out-of-sample test. Live risk is unchanged.` },
    { name: 'Regime and funding filters', status: 'No robust improvement established', detail: `Three fixed single filters were tested on all 78 original candidates. Funding at least twice its prior-day median produced ${crowding83.hypotheticalReturnPct.toFixed(2)}% across 23 hypothetical entries at 20% modeled risk and 83 bp costs, but ${crowding.calendarSegmentsAt83Bps.after.hypotheticalReturnPct.toFixed(2)}% in the later period and ${crowding166.hypotheticalReturnPct.toFixed(2)}% with doubled costs. Funding cash is excluded; this is retrospective, not clean holdout evidence. No live promotion.` },
    { name: 'ZEC execution', status: 'Wallet approval restored', detail: 'The locally generated API wallet was approved September 5. The IOC rounding repair remains offline and is not deployed.' },
    { name: 'Missed ZEC entries', status: 'Depth evidence improved; profit unproven', detail: 'All seven nearby August 29 book samples covered the original size at the offline corrected limit, but its six-hour minute-mark sample showed no target crossing. September 4 daily marks remain missing. Displayed depth and sampled marks do not prove actual fills or native exits; missed trades receive no profit credit.' },
    { name: 'Swing / order-book ideas', status: 'Not approved for live trading', detail: 'The frozen swing holdout and impact-skew tests were negative after costs. No risk increase or live promotion.' },
    { name: 'Cross-DEX SNDK', status: 'No executable edge established', detail: 'All 18 captured matched-size quote calculations were negative after modeled round-trip fees. No trade activated.' },
    { name: 'New-listing readiness', status: 'Read-only observation', detail: 'A future-only 72-hour observer was installed September 5. It does not place orders or establish profitability.' },
    { name: 'Legacy research publishers', status: 'Retired after failures', detail: 'Six failed research/publishing retry loops were stopped September 5. Their historical evidence is preserved below; they are not represented as healthy live systems.' }
  ],
  sources
};
const text = JSON.stringify(output, null, 2) + '\n';
if (process.argv.includes('--write')) {
  const destination = path.join(root, 'config/hyperliquid-audit.json');
  const temporary = destination + '.tmp';
  fs.writeFileSync(temporary, text, { mode: 0o644 });
  fs.renameSync(temporary, destination);
  console.log(`Exported audited results and ${pilot.storedValidHours}/${pilot.plannedHours} stored pilot hours.`);
} else process.stdout.write(text);
