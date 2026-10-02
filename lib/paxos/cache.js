'use strict';

// In-memory TTL cache keyed by request URL. It lives in module scope, so it
// survives warm serverless invocations. Size is bounded by entry count and by
// the byte size the caller reports per entry (sources.js stores JSON text).
// Expired entries are kept until evicted so that a failed refresh can fall
// back to the last good response; callers must then label that data as stale
// (its fetchedAt is the original). Only responses that passed their type
// checks are stored (sources.js), so a malformed body is never cached: the
// last good copy keeps serving until the upstream is well-formed again.

const MIN = 60e3;
const HOUR = 60 * MIN;
const TTL = {
  // CoinGecko identity data (coins/{id} details, asset_platforms, the gold category): contracts,
  // platforms and category members change over weeks, and the demo plan's monthly call quota is shared
  // with prices and charts, so these are re-fetched weekly (a failed refresh keeps the last copy).
  identity: 7 * 24 * HOUR,
  registry: 24 * HOUR, // DefiLlama chain list + protocol graph, Paxos docs, Coin Metrics catalog, first prices
  chainscout: 24 * HOUR,
  cgMarkets: 5 * MIN, // CoinGecko markets rows: prices move by the minute
  cgChart: 6 * HOUR, // CoinGecko market_chart: daily points
  llama: 30 * MIN, // stablecoins.llama.fi refreshes hourly
  coins: 30 * MIN, // coins.llama.fi hourly charts
  fees: HOUR, // daily series
  yields: HOUR, // yields.llama.fi refreshes hourly
  cm: 6 * HOUR, // Coin Metrics community: daily rows
  history: 24 * HOUR, // closed historical windows (daily price chunks that end before yesterday)
  onchain: 5 * MIN,
};

function createCache({ maxEntries = 400, maxBytes = 128e6, now = Date.now } = {}) {
  const map = new Map(); // insertion order = LRU order
  let bytes = 0;
  const drop = (key) => {
    const e = map.get(key);
    if (!e) return;
    map.delete(key);
    bytes -= e.bytes;
  };
  const evict = () => {
    while (map.size && (map.size > maxEntries || bytes > maxBytes)) drop(map.keys().next().value);
  };
  return {
    // Fresh entry or null. Touches LRU order.
    get(key) {
      const e = map.get(key);
      if (!e || now() - e.storedAt >= e.ttlMs) return null;
      map.delete(key);
      map.set(key, e);
      return e;
    },
    // Any entry, fresh or expired (for stale-on-error fallback).
    peek(key) {
      return map.get(key) || null;
    },
    set(key, value, { ttlMs, bytes: b = 0 } = {}) {
      if (!(ttlMs > 0)) return null;
      drop(key);
      const e = { value, storedAt: now(), ttlMs, bytes: Math.max(0, Number(b) || 0) };
      map.set(key, e);
      bytes += e.bytes;
      evict();
      return e;
    },
    delete: drop,
    clear() {
      map.clear();
      bytes = 0;
    },
    get size() {
      return map.size;
    },
    get bytes() {
      return bytes;
    },
  };
}

const shared = createCache();

module.exports = { createCache, shared, TTL };
