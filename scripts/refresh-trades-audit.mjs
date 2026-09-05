// Export only explicitly selected, non-secret audit fields. No wallet or network access.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const research = path.resolve(root, '../internet-money-machine');
const sources = [];
function read(relative) {
  const bytes = fs.readFileSync(path.join(research, relative));
  if (bytes.length > 4_000_000) throw new Error('audit source exceeds size limit');
  sources.push({ name: path.basename(relative), sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  return JSON.parse(bytes);
}
const account = read('reviews/hl-account-audit-20260905.json');
const participation = read('reviews/hl-zec-v5-participation-audit-20260905.json');
if (account.profitabilityProven !== false || participation.counterfactualFillsCredited !== false
    || account.v5.freshNetUsd !== String(participation.actualLiveEconomics.netRealizedUsd)
    || account.v5.tradeCount !== participation.actualLiveEconomics.tradeCount) {
  throw new Error('audit sources disagree');
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
    { name: 'ZEC execution', status: 'Wallet approval restored', detail: 'The locally generated API wallet was approved September 5. The IOC rounding repair remains offline and is not deployed.' },
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
