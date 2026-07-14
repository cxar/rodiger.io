'use strict';

const trackedSnapshot = require('../config/hyperliquid-research-lanes.json');

const SHA256_RE = /^[0-9a-f]{64}$/;
const KNOWN_STATUSES = new Set([
  'running_predecision',
  'running_flat',
  'paper_position_open',
  'terminal_reconciliation_pending',
  'failed_closed',
  'not_launched_pending_review',
  'invalid_prelaunch_cutoff_identity_mismatch',
  'retired'
]);
const NO_STATE_STATUSES = new Set([
  'not_launched_pending_review',
  'invalid_prelaunch_cutoff_identity_mismatch'
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteInteger(value, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  return Number.isSafeInteger(value) && value >= 0;
}

function exactBoolean(value, expected, field) {
  if (value !== expected) throw new Error(`${field} must be ${expected}`);
}

function validateEvidence(evidence, status, prefix) {
  if (!isObject(evidence)) throw new Error(`${prefix}.evidence must be an object`);
  for (const key of ['decisions', 'terminals']) {
    if (!finiteInteger(evidence[key])) throw new Error(`${prefix}.evidence.${key} must be a non-negative integer`);
  }
  const nullable = NO_STATE_STATUSES.has(status);
  for (const key of ['failedClosed', 'coverageGapOpen', 'evidenceHealthy']) {
    if (nullable && evidence[key] === null) continue;
    if (typeof evidence[key] !== 'boolean') throw new Error(`${prefix}.evidence.${key} must be boolean or an allowed null`);
  }
  if (status === 'running_predecision') {
    exactBoolean(evidence.failedClosed, false, `${prefix}.evidence.failedClosed`);
    exactBoolean(evidence.coverageGapOpen, false, `${prefix}.evidence.coverageGapOpen`);
    exactBoolean(evidence.evidenceHealthy, true, `${prefix}.evidence.evidenceHealthy`);
    if (evidence.decisions !== 0 || evidence.terminals !== 0) {
      throw new Error(`${prefix} running_predecision must have zero decisions and terminals`);
    }
  }
  if (status === 'not_launched_pending_review') {
    if (evidence.decisions !== 0 || evidence.terminals !== 0) {
      throw new Error(`${prefix} not-launched lane must have zero decisions and terminals`);
    }
  }
  if (status === 'invalid_prelaunch_cutoff_identity_mismatch') {
    if (
      evidence.decisions !== 0
      || evidence.terminals !== 0
      || evidence.failedClosed !== true
      || evidence.coverageGapOpen !== null
      || evidence.evidenceHealthy !== false
    ) {
      throw new Error(`${prefix} invalid prelaunch lane must be terminally quarantined with zero evidence`);
    }
  }
}

function validateLane(lane, index) {
  const prefix = `lanes[${index}]`;
  if (!isObject(lane)) throw new Error(`${prefix} must be an object`);
  for (const field of ['id', 'name', 'collectorVersion', 'epochId', 'operationalStatus']) {
    if (typeof lane[field] !== 'string' || !lane[field]) throw new Error(`${prefix}.${field} must be a non-empty string`);
  }
  if (!KNOWN_STATUSES.has(lane.operationalStatus)) throw new Error(`${prefix}.operationalStatus is unknown`);
  if (lane.mode !== 'paper') throw new Error(`${prefix}.mode must be paper`);
  exactBoolean(lane.paperOnly, true, `${prefix}.paperOnly`);
  exactBoolean(lane.liveApproved, false, `${prefix}.liveApproved`);
  exactBoolean(lane.promotionApproved, false, `${prefix}.promotionApproved`);
  if (typeof lane.quarantined !== 'boolean') throw new Error(`${prefix}.quarantined must be boolean`);
  exactBoolean(lane.crossEpochPoolingAllowed, false, `${prefix}.crossEpochPoolingAllowed`);
  if (!finiteInteger(lane.observedAtMs, { nullable: true })) throw new Error(`${prefix}.observedAtMs is invalid`);
  if (!finiteInteger(lane.firstDecisionBoundaryMs)) throw new Error(`${prefix}.firstDecisionBoundaryMs is invalid`);
  if (!Number.isSafeInteger(lane.strategyCount) || lane.strategyCount <= 0) throw new Error(`${prefix}.strategyCount is invalid`);
  validateEvidence(lane.evidence, lane.operationalStatus, prefix);
  if (!isObject(lane.source) || typeof lane.source.manifestIdentityValid !== 'boolean') {
    throw new Error(`${prefix}.source manifest identity flag is invalid`);
  }
  if (lane.source.manifestSha256 !== null && !SHA256_RE.test(lane.source.manifestSha256 || '')) {
    throw new Error(`${prefix}.source.manifestSha256 is invalid`);
  }
  if (lane.source.stateMaterialSha256 !== null && !SHA256_RE.test(lane.source.stateMaterialSha256 || '')) {
    throw new Error(`${prefix}.source.stateMaterialSha256 is invalid`);
  }
  if (NO_STATE_STATUSES.has(lane.operationalStatus)) {
    if (lane.observedAtMs !== null || lane.source.stateMaterialSha256 !== null) {
      throw new Error(`${prefix} prelaunch lane must not claim a state observation`);
    }
  } else if (lane.observedAtMs === null || lane.source.stateMaterialSha256 === null) {
    throw new Error(`${prefix} active lane requires a material state observation`);
  }
  if (lane.operationalStatus === 'invalid_prelaunch_cutoff_identity_mismatch') {
    if (lane.source.manifestIdentityValid !== false || lane.source.manifestSha256 !== null) {
      throw new Error(`${prefix} invalid prelaunch identity may not publish a manifest hash`);
    }
  } else if (lane.source.manifestIdentityValid !== true || lane.source.manifestSha256 === null) {
    throw new Error(`${prefix} requires a valid manifest identity and hash`);
  }
  if (
    (lane.operationalStatus === 'invalid_prelaunch_cutoff_identity_mismatch')
    !== lane.quarantined
  ) {
    throw new Error(`${prefix}.quarantined disagrees with operational status`);
  }
}

function validateSnapshot(snapshot) {
  if (!isObject(snapshot)) throw new Error('research snapshot must be an object');
  if (snapshot.schema !== 'rodiger.hyperliquid.research_lanes' || snapshot.schemaVersion !== 1) {
    throw new Error('research snapshot schema is unknown');
  }
  if (!finiteInteger(snapshot.publishedAtMs) || Date.parse(snapshot.publishedAt) !== snapshot.publishedAtMs) {
    throw new Error('research snapshot publication time is invalid');
  }
  if (!Number.isSafeInteger(snapshot.staleAfterMs) || snapshot.staleAfterMs < 60_000 || snapshot.staleAfterMs > 86_400_000) {
    throw new Error('research snapshot freshness window is invalid');
  }
  if (snapshot.observerScope !== 'published_local_snapshot') throw new Error('research observer scope is invalid');
  if (snapshot.localDaemonHealth !== 'not_publicly_observable') throw new Error('research snapshot may not claim public daemon health');
  if (!Array.isArray(snapshot.lanes) || snapshot.lanes.length === 0) throw new Error('research snapshot lanes are missing');
  snapshot.lanes.forEach(validateLane);
  for (const [index, lane] of snapshot.lanes.entries()) {
    if (lane.observedAtMs !== null && lane.observedAtMs > snapshot.publishedAtMs) {
      throw new Error(`lanes[${index}].observedAtMs is after publication`);
    }
  }
  const ids = snapshot.lanes.map((lane) => lane.id);
  if (new Set(ids).size !== ids.length) throw new Error('research snapshot lane ids are duplicated');
}

function publicLane(lane, stale) {
  return {
    id: lane.id,
    name: lane.name,
    collectorVersion: lane.collectorVersion,
    epochId: lane.epochId,
    mode: 'paper',
    paperOnly: true,
    liveApproved: false,
    promotionApproved: false,
    operationalStatus: stale ? 'snapshot_stale' : lane.operationalStatus,
    quarantined: lane.quarantined,
    crossEpochPoolingAllowed: false,
    observedAtMs: stale ? null : lane.observedAtMs,
    firstDecisionBoundaryMs: lane.firstDecisionBoundaryMs,
    strategyCount: lane.strategyCount,
    evidence: stale ? {
      decisions: null,
      terminals: null,
      failedClosed: null,
      coverageGapOpen: null,
      evidenceHealthy: null
    } : { ...lane.evidence },
    source: { ...lane.source }
  };
}

function unavailable(blocker) {
  return {
    schemaVersion: 1,
    availability: 'unavailable',
    observerScope: 'published_local_snapshot',
    localDaemonHealth: 'not_publicly_observable',
    publishedAt: null,
    publishedAtMs: null,
    ageMs: null,
    staleAfterMs: null,
    blocker,
    lanes: []
  };
}

function buildResearchLanesStatus(snapshot = trackedSnapshot, nowMs = Date.now()) {
  try {
    validateSnapshot(snapshot);
  } catch (error) {
    return unavailable(`research lane contract failed closed: ${error instanceof Error ? error.message : 'unknown validation error'}`);
  }
  const ageMs = nowMs - snapshot.publishedAtMs;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || ageMs < -5_000) {
    return unavailable('research lane contract failed closed: publication time is in the future');
  }
  const stale = ageMs > snapshot.staleAfterMs;
  return {
    schemaVersion: 1,
    availability: stale ? 'stale' : 'current',
    observerScope: 'published_local_snapshot',
    localDaemonHealth: 'not_publicly_observable',
    publishedAt: snapshot.publishedAt,
    publishedAtMs: snapshot.publishedAtMs,
    ageMs,
    staleAfterMs: snapshot.staleAfterMs,
    blocker: stale ? 'published research snapshot is stale; operational claims are hidden' : null,
    lanes: snapshot.lanes.map((lane) => publicLane(lane, stale))
  };
}

module.exports = {
  trackedSnapshot,
  validateSnapshot,
  buildResearchLanesStatus
};
