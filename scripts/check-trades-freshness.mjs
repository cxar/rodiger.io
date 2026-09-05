import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildAuditStatus } = require('../lib/hyperliquid-audit');
const audit = require('../config/hyperliquid-audit.json');
const now = Date.parse(audit.assembledAt);
assert.equal(buildAuditStatus(audit, now).availability, 'published');
assert.equal(buildAuditStatus(audit, now + 86_400_001).availability, 'update_due');
assert.equal(buildAuditStatus(audit, now - 5_001).availability, 'unavailable');
assert.equal(buildAuditStatus({ ...audit, profitabilityProven: true }, now).availability, 'unavailable');
assert.equal(buildAuditStatus({ ...audit, fundingPilot: { actualTradingProfitUsd: 1 } }, now).availability, 'unavailable');
assert.equal(buildAuditStatus(audit, now + 1_000).accountEvidenceThrough, audit.accountEvidenceThrough);
assert.equal(audit.v5.completedTrades + audit.v5.unfilledStrongSignals, audit.v5.selectedStrongSignals);
assert.equal(audit.v5.missedSignalPnlUsd, null);
assert.ok(!JSON.stringify(audit).includes('/Users/'));
assert.equal(buildAuditStatus({ ...audit, allCapturedTradingNetUsd: null }, now).availability, 'unavailable');
assert.equal(buildAuditStatus({ ...audit, v5: { ...audit.v5, selectedStrongSignals: 99 } }, now).availability, 'unavailable');
assert.equal(buildAuditStatus({ ...audit, unwantedPrivateField: 'do not publish' }, now).unwantedPrivateField, undefined);
const aggressive = audit.findings.find(f => f.name === 'Aggressive 30-market test');
assert.ok(aggressive, 'aggressive test must be visible in the current audit');
assert.match(aggressive.detail, /-45\.27%.*-79\.12%/);
assert.match(aggressive.detail, /excluding funding/);
assert.match(aggressive.detail, /hypothetical returns, not actual losses/);
assert.match(aggressive.detail, /Live risk is unchanged/);
assert.equal(audit.sources.find(s => s.name === 'hl-aggressive-expansion-audit-20260905.json')?.sha256,
  '8dd055df502838bdc6914a097ab41cbd5deea63f6e30f2636458f5d13e2e1ff6');
assert.equal(audit.sources.find(s => s.name === 'hl-zec-v5-mark-depth-audit-20260905-v2.json')?.sha256,
  'be715b94b4608ceb2bde2b5bfa6e03757b8c8704ace727f665473f408a660be2');
assert.match(audit.findings.find(f => f.name === 'Missed ZEC entries').detail, /missed trades receive no profit credit/);

const html = fs.readFileSync(new URL('../pages/trades/index.html', import.meta.url), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const elements = new Map();
const timers = new Map();
let clock = Date.now(), fetches = 0, timerId = 0, responseFactory;
class FakeDate extends Date { static now() { return clock; } }
const sandbox = {
  Date: FakeDate, AbortController,
  document: { getElementById(id) { if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', className: '' }); return elements.get(id); },
    querySelectorAll() { return []; }, addEventListener() {} },
  window: { addEventListener() {} },
  fetch: (...args) => { fetches++; return responseFactory(...args); },
  setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
  clearTimeout(id) { timers.delete(id); }, setInterval() {},
};
const context = vm.createContext(sandbox);
// Evaluate production functions without scheduling a browser or sending requests.
vm.runInContext(code.replace('setActive(); load(); setInterval(load,30000);', 'setActive(); setInterval(load,30000);'), context);
const valid = () => ({ schemaVersion: 1, generatedAt: new Date(clock).toISOString(), strategy: {}, account: {}, signal: {}, protection: {}, researchLanes: {} });
const respond = body => { responseFactory = async () => ({ ok: true, json: async () => body }); };
respond(valid());
assert.equal((await vm.runInContext('statusApi()', context)).schemaVersion, 1);
assert.equal(timers.size, 0);
for (const timestamp of [new Date(clock - 90_001).toISOString(), new Date(clock + 5_001).toISOString(), 'invalid']) {
  respond({ ...valid(), generatedAt: timestamp });
  await assert.rejects(vm.runInContext('statusApi()', context), /stale|timestamp/);
}
// Both a stalled connection and a stalled JSON body must have a deadline.
for (const bodyStalls of [false, true]) {
  responseFactory = bodyStalls
    ? async () => ({ ok: true, json: () => new Promise(() => {}) })
    : () => new Promise(() => {});
  const pending = vm.runInContext('statusApi()', context);
  assert.equal([...timers.values()][0].delay, 12_000);
  [...timers.values()][0].fn();
  await assert.rejects(pending, /timed out/);
  assert.equal(timers.size, 0);
}
// Concurrent triggers cannot overlap or permit out-of-order responses to win.
responseFactory = () => new Promise(() => {});
const before = fetches;
const first = vm.runInContext('load()', context);
await vm.runInContext('load()', context);
assert.equal(fetches, before + 1);
[...timers.values()][0].fn();
await first;
assert.match(elements.get('positions').innerHTML, /unavailable/);
assert.match(elements.get('orders').innerHTML, /unavailable/);
assert.equal(elements.get('poscount').textContent, '?');
assert.equal(vm.runInContext('loading', context), false);
// A previously accepted payload expires without waiting for another response.
context.expiring = { ...valid(), sources: { hyperliquidPublicApi: 'ok' } };
vm.runInContext('payload=expiring; renderFreshness()', context);
assert.match(elements.get('sub').innerHTML, /0s old/);
clock += 31_000;
vm.runInContext('renderFreshness()', context);
assert.match(elements.get('sub').innerHTML, /31s old/);
clock += 60_000;
vm.runInContext('renderFreshness()', context);
assert.equal(vm.runInContext('payload', context), null);
assert.match(elements.get('sub').innerHTML, /expired/);
assert.ok(html.includes('Equity change (${label})'));
assert.ok(html.includes('visibilitychange'));
assert.ok(html.includes('window.addEventListener("online",load)'));
console.log('trades freshness, timeout, overlap, expiry, cleanup and audit checks passed');
