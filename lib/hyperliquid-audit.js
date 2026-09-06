'use strict';

const snapshot = require('../config/hyperliquid-audit.json');

function buildAuditStatus(value = snapshot, nowMs = Date.now()) {
  const unavailable = { availability: 'unavailable', profitabilityProven: false };
  const decimal = v => typeof v === 'string' && /^-?\d+(\.\d{1,12})?$/.test(v) && Number.isFinite(Number(v));
  const count = v => Number.isSafeInteger(v) && v >= 0;
  if (!value || value.schemaVersion !== 1 || value.profitabilityProven !== false
      || !Number.isFinite(Date.parse(value.assembledAt)) || Date.parse(value.assembledAt) > nowMs + 5_000
      || !Number.isFinite(Date.parse(value.accountEvidenceThrough))
      || !Number.isFinite(Date.parse(value.signalEvidenceThrough))
      || Date.parse(value.accountEvidenceThrough) > Date.parse(value.assembledAt)
      || Date.parse(value.signalEvidenceThrough) > Date.parse(value.assembledAt)
      || !decimal(value.allCapturedTradingNetUsd)
      || !value.v5 || !decimal(value.v5.netRealizedUsd)
      || value.v5.missedSignalPnlUsd !== null || value.fundingPilot?.actualTradingProfitUsd !== null
      || !Array.isArray(value.findings) || !Array.isArray(value.sources)) return unavailable;
  const v = value.v5, p = value.fundingPilot;
  if (![v.completedTrades, v.selectedStrongSignals, v.unfilledStrongSignals,
    p.plannedHours, p.storedValidHours, p.diagnosticExactCashHours, p.ambiguousQuantizationHours,
    p.finalizedOtherHours, p.dueHours, p.overdueMissingHours].every(count)
    || v.completedTrades + v.unfilledStrongSignals !== v.selectedStrongSignals
    || p.diagnosticExactCashHours + p.ambiguousQuantizationHours !== p.storedValidHours
    || p.plannedHours !== 72 || p.storedValidHours + p.finalizedOtherHours > p.plannedHours
    || p.dueHours > p.plannedHours || !count(p.firstBoundaryMs) || !count(p.lastBoundaryMs)
    || (p.lastStoredBoundaryMs !== null && !count(p.lastStoredBoundaryMs))
    || value.sources.some(s => typeof s.name !== 'string' || !/^[0-9a-f]{64}$/.test(s.sha256))
    || value.findings.some(f => ['name', 'status', 'detail'].some(k => typeof f[k] !== 'string'))
    || typeof v.note !== 'string') return unavailable;
  // Evidence dates are never replaced with the HTTP response's current timestamp.
  return { schemaVersion: 1, assembledAt: value.assembledAt, accountEvidenceThrough: value.accountEvidenceThrough,
    signalEvidenceThrough: value.signalEvidenceThrough, profitabilityProven: false,
    allCapturedTradingNetUsd: value.allCapturedTradingNetUsd,
    v5: { netRealizedUsd: v.netRealizedUsd, completedTrades: v.completedTrades, selectedStrongSignals: v.selectedStrongSignals,
      unfilledStrongSignals: v.unfilledStrongSignals, missedSignalPnlUsd: null, note: v.note },
    fundingPilot: { plannedHours: p.plannedHours, storedValidHours: p.storedValidHours,
      diagnosticExactCashHours: p.diagnosticExactCashHours, ambiguousQuantizationHours: p.ambiguousQuantizationHours,
      finalizedOtherHours: p.finalizedOtherHours, dueHours: p.dueHours, overdueMissingHours: p.overdueMissingHours,
      firstBoundaryMs: p.firstBoundaryMs, lastBoundaryMs: p.lastBoundaryMs, lastStoredBoundaryMs: p.lastStoredBoundaryMs,
      actualTradingProfitUsd: null },
    findingsAsOf: value.findingsAsOf,
    findings: value.findings.map(f => ({ name: f.name, status: f.status, detail: f.detail })),
    sources: value.sources.map(s => ({ name: s.name, sha256: s.sha256 })),
    availability: [value.assembledAt, value.accountEvidenceThrough, value.signalEvidenceThrough]
      .some(at => nowMs - Date.parse(at) > 86_400_000) ? 'update_due' : 'published',
    accountEvidenceUpdateDue: nowMs - Date.parse(value.accountEvidenceThrough) > 86_400_000,
    signalEvidenceUpdateDue: nowMs - Date.parse(value.signalEvidenceThrough) > 86_400_000,
    accountEvidenceAgeMs: nowMs - Date.parse(value.accountEvidenceThrough),
    signalEvidenceAgeMs: nowMs - Date.parse(value.signalEvidenceThrough),
    scope: 'Dated audit, not a current account balance or live service-health check.' };
}

module.exports = { buildAuditStatus };
