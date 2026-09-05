// Read-only check for scheduled monitoring. Never signs or submits a transaction.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const strategy = require('../config/hyperliquid-live-strategy.json');
const audit = require('../config/hyperliquid-audit.json');
const origin = 'https://www.rodiger.io';
const issues = [];
try {
  const page = await fetch(`${origin}/trades`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(page.status, 200, 'trades page is unavailable');
  const html = await page.text();
  assert.ok(html.includes('Latest Verified Audit'), 'latest dashboard has not reached production');
  const response = await fetch(`${origin}/api/trades`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, 'trades API is unavailable');
  const value = await response.json();
  const ageMs = Date.now() - Date.parse(value.generatedAt);
  assert.ok(Number.isFinite(ageMs) && ageMs >= -5_000 && ageMs <= 90_000, 'public response is stale');
  assert.deepEqual(value.strategy, strategy, 'deployed strategy configuration differs');
  assert.equal(value.sources.hyperliquidPublicApi, 'ok', 'one or more public sources failed');
  assert.equal(value.audit?.profitabilityProven, false, 'audit is missing or incorrectly claims profitability');
  assert.deepEqual(value.audit.sources, audit.sources, 'latest research evidence has not reached production');
  assert.deepEqual(value.audit.findings, audit.findings, 'latest research findings have not reached production');
  assert.equal(value.audit.assembledAt, audit.assembledAt, 'local audit export differs from production');
  if (value.audit.availability !== 'published') issues.push('audit publication needs attention');
  const latestFill = Math.max(0, ...value.account.fills.map(fill => fill.time));
  if (latestFill > Date.parse(value.audit.accountEvidenceThrough)) issues.push('new fills require an updated account audit');
  const pilot = value.audit.fundingPilot;
  const expectedHours = Math.max(0, Math.min(pilot.plannedHours,
    Math.floor((Date.now() - pilot.firstBoundaryMs - 355_000) / 3_600_000) + 1));
  if (expectedHours > pilot.storedValidHours + pilot.finalizedOtherHours) issues.push('funding pilot snapshot is behind due boundaries');
  if (pilot.finalizedOtherHours || pilot.overdueMissingHours) issues.push('funding pilot has failed or missed source hours');
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), responseAgeMs: ageMs,
    equityUsd: value.account.accountValueUsd, baselinePnlUsd: value.account.performance.lifetimeTradingPnlUsd,
    latestFillAt: latestFill ? new Date(latestFill).toISOString() : null,
    auditAssembledAt: value.audit.assembledAt, storedPilotHours: pilot.storedValidHours,
    positions: value.account.positions.length, orders: value.account.openOrders.length, issues }, null, 2));
  if (issues.length) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
