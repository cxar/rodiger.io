'use strict';

// Collects every upstream input of the Paxos health model into one raw bundle.
// Each request goes through http.js (timeouts, never throws) and the TTL
// cache, and is accounted to one of the logical sources below so the page can
// show provenance and honest freshness. A failed source degrades only what
// depends on it; collectRaw itself never throws.
//
// Every response is type-checked by its transform before anything reads or
// caches it: malformed rows are dropped (and reported on the source), a body
// that is mostly malformed is rejected like a failed request (not cached; the
// last good copy is served), and rows dated outside the plausible time range
// (model.timeOk) are dropped at ingestion.
//
// Each request records the time its data represents (asOf) and its own
// publication cadence: hourly snapshots (the stablecoin list) carry their
// Last-Modified; daily series carry the instant of their last point (a
// Last-Modified on a daily chart is only the CDN fill time).
//
// Flow (requests start as soon as their inputs exist, so phases overlap):
//   core      list, market chart, fees, protocol graph, CoinGecko category, docs, chain metadata
//   discover  registry.discover() over the tiers -> assets (+ pending docs joins)
//   details   /stablecoin/{id} for ACTIVE assets and pending candidates -> re-discover (addresses)
//   series    per-asset charts, coins.llama.fi hourly/daily, CoinGecko charts, chain totals
//   address   yields pools/lendBorrow filtered to stablecoin + Paxos-address pools, pool charts, on-chain
//   usage     Coin Metrics series for validated mappings (assets + largest USD peers); supply history
//             from inception (and the daily prices to value it) where Coin Metrics is an asset's supply

const { fetchJson, fetchText, hostOf, keys, BLOCKSCOUT_PRO } = require('./http');
const { shared: sharedCache, TTL } = require('./cache');
const R = require('./registry');
const M = require('./model');

const DAY = 86400;
const LLAMA = 'https://stablecoins.llama.fi';
const API = 'https://api.llama.fi';
const COINS = 'https://coins.llama.fi';
const YIELDS = 'https://yields.llama.fi';
const CG = 'https://api.coingecko.com/api/v3';
const CM = 'https://community-api.coinmetrics.io/v4';
const CHAINSCOUT = 'https://chains.blockscout.com/api/chains';
const CHAINLIST = 'https://chainid.network/chains_mini.json'; // EVM chain registry: public RPC endpoints by chain id
const JUPITER = 'https://lite-api.jup.ag/tokens/v2/search';
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const DOCS = 'https://docs.paxos.com/guides/stablecoin';
// Jupiter and the Solana RPC only serve Solana mints; this routes addresses to
// them (an API constant, not a statement about where Paxos issues).
const SOLANA_KEY = 'solana';
const CM_METRICS = 'AdrActCnt,AdrBalCnt,SplyCur,TxTfrCnt';
const COINS_SPAN = 500; // coins.llama.fi /chart returns at most 500 points per call
const DAILY = 24; // cadence (hours) of a daily series

// cadenceHours = how often the upstream publishes new data (from research).
const SOURCES = [
  { id: 'llama-stablecoins', label: 'DefiLlama stablecoins', host: 'stablecoins.llama.fi', kind: 'supply', cadenceHours: 1 },
  { id: 'llama-market', label: 'DefiLlama market & chain totals', host: 'stablecoins.llama.fi', kind: 'market', cadenceHours: DAILY },
  { id: 'coingecko', label: 'CoinGecko', host: 'api.coingecko.com', kind: 'price', cadenceHours: 0.25 },
  { id: 'llama-coins', label: 'DefiLlama coin prices', host: 'coins.llama.fi', kind: 'price', cadenceHours: 1 },
  { id: 'llama-yields', label: 'DefiLlama yields', host: 'yields.llama.fi', kind: 'defi', cadenceHours: 1 },
  { id: 'llama-fees', label: 'DefiLlama issuer fee model', host: 'api.llama.fi', kind: 'economics', cadenceHours: DAILY },
  { id: 'coinmetrics', label: 'Coin Metrics community', host: 'community-api.coinmetrics.io', kind: 'usage', cadenceHours: DAILY },
  { id: 'onchain', label: 'On-chain (explorers & RPC)', host: null, kind: 'onchain', cadenceHours: 0.25 },
  { id: 'paxos-docs', label: 'Paxos docs', host: 'docs.paxos.com', kind: 'discovery', cadenceHours: DAILY },
  { id: 'llama-protocol', label: 'DefiLlama protocol graph & chains', host: 'api.llama.fi', kind: 'discovery', cadenceHours: DAILY },
  { id: 'chainscout', label: 'Blockscout Chainscout', host: 'chains.blockscout.com', kind: 'discovery', cadenceHours: DAILY },
  { id: 'chainlist', label: 'EVM chain registry', host: 'chainid.network', kind: 'discovery', cadenceHours: DAILY },
];

const isoDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const dayOf = (t) => Math.floor(t / DAY) * DAY;
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
// Finite number from a number or a numeric string (Coin Metrics and some DefiLlama fields are strings).
const toNum = (x) => (typeof x === 'number' ? num(x) : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = (x) => (typeof x === 'string' ? x : null);
const strs = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === 'string') : null);
const numMap = (o) => (isObj(o) ? Object.fromEntries(Object.entries(o).filter(([, v]) => num(v) !== null)) : {});
const sum = (o) => Object.values(o || {}).reduce((s, v) => s + (num(v) || 0), 0);
const none = () => null;
const nonEmpty = (a) => Array.isArray(a) && a.length > 0;
const okGecko = (id) => typeof id === 'string' && /^[a-z0-9-]+$/.test(id);
const okLlama = (id) => /^\d+$/.test(String(id));
const shortUrl = (u) => {
  try {
    const x = new URL(u);
    return (x.host + x.pathname + x.search).slice(0, 90);
  } catch {
    return String(u).slice(0, 90);
  }
};
const hashStr = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

// ---------- response type checks + slimming (only fields the model reads) ----------
// ctx = { inTime(unixSeconds) -> boolean, drop(count, what) }. LOOSE (used when recording fixtures)
// only requires finite times, so recorded bodies keep every row the live code would see.
const LOOSE = { inTime: (t) => Number.isFinite(t), drop() {} };

// Keeps the well-formed rows of an upstream array. A body whose rows are mostly malformed is
// rejected (thrown: not cached, the last good copy is served instead); otherwise the bad rows are
// dropped and counted, so one wrong-typed field degrades one row, not the dashboard.
function keepRows(arr, fn, what, ctx = LOOSE) {
  if (!Array.isArray(arr)) throw new Error(`${what}: not an array`);
  const out = [];
  for (const r of arr) {
    let x = null;
    try {
      x = fn(r);
    } catch {
      x = null;
    }
    if (x != null) out.push(x);
  }
  const bad = arr.length - out.length;
  if (arr.length && bad * 2 > arr.length) throw new Error(`${what}: ${bad}/${arr.length} rows malformed or out of range`);
  if (bad) ctx.drop(bad, what);
  return out;
}
const optRows = (x, fn, what, ctx) => (x === undefined || x === null ? [] : keepRows(x, fn, what, ctx));
// Flat copy of an upstream record: primitives only (numbers must be finite), the named numeric
// fields coerced to number-or-null, the named list fields kept as string arrays.
function flat(o, { nums = [], lists = [] } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (typeof v === 'number') out[k] = Number.isFinite(v) ? v : null;
  }
  for (const k of nums) if (k in o) out[k] = toNum(o[k]);
  for (const k of lists) if (k in o) out[k] = strs(o[k]);
  return out;
}

const slimTotals = (rows, ctx = LOOSE) =>
  keepRows(rows, (r) => {
    const date = Number(isObj(r) ? r.date : NaN);
    return ctx.inTime(date) && isObj(r.totalCirculatingUSD) ? { date, totalCirculatingUSD: numMap(r.totalCirculatingUSD) } : null;
  }, 'chart rows', ctx);
const slimCharts = (rows, ctx = LOOSE) =>
  keepRows(rows, (r) => {
    const date = Number(isObj(r) ? r.date : NaN);
    return ctx.inTime(date) && (isObj(r.totalCirculating) || isObj(r.totalCirculatingUSD)) ? { date, totalCirculating: numMap(r.totalCirculating), totalCirculatingUSD: numMap(r.totalCirculatingUSD) } : null;
  }, 'chart rows', ctx);
const slimFees = (j, ctx = LOOSE) => {
  if (!isObj(j)) throw new Error('not an object');
  const out = { name: str(j.name), slug: str(j.slug) };
  for (const k of ['total24h', 'total48hto24h', 'total7d', 'total30d', 'total1y', 'totalAllTime']) out[k] = toNum(j[k]);
  if (isObj(j.methodology) || typeof j.methodology === 'string') out.methodology = j.methodology;
  out.breakdownMethodology = isObj(j.breakdownMethodology) ? j.breakdownMethodology : null;
  out.totalDataChart = keepRows(j.totalDataChart, (p) => (Array.isArray(p) && ctx.inTime(Number(p[0])) && (p[1] === null || toNum(p[1]) !== null) ? [Number(p[0]), toNum(p[1])] : null), 'fee rows', ctx);
  return out;
};
const slimProtocol = (j) => {
  if (!isObj(j)) throw new Error('not an object');
  const out = {};
  for (const k of ['name', 'address', 'symbol', 'chain', 'gecko_id', 'category', 'parentProtocol']) if (typeof j[k] === 'string') out[k] = j[k];
  if (typeof j.id === 'string' || num(j.id) !== null) out.id = j.id;
  for (const k of ['chains', 'tags', 'otherProtocols']) if (Array.isArray(j[k])) out[k] = strs(j[k]);
  if (typeof j.isParentProtocol === 'boolean') out.isParentProtocol = j.isParentProtocol;
  return out;
};
// /stablecoin/{id}: per-chain history (circulating, minted, bridged-in per day) and contracts;
// the asset totals come from /stablecoincharts.
const slimDetail = (j, ctx = LOOSE) => {
  if (!isObj(j) || !isObj(j.chainBalances)) throw new Error('no chain balances');
  const chainBalances = {};
  for (const [chain, cb] of Object.entries(j.chainBalances)) {
    if (!isObj(cb)) continue;
    const tokens = optRows(cb.tokens, (x) => {
      const date = Number(isObj(x) ? x.date : NaN);
      return ctx.inTime(date) ? { date, circulating: numMap(x.circulating), minted: numMap(x.minted), bridgedTo: numMap(x.bridgedTo) } : null;
    }, `${chain} chain rows`, ctx);
    chainBalances[chain] = { tokens };
  }
  const currentChainBalances = {};
  for (const [chain, v] of Object.entries(isObj(j.currentChainBalances) ? j.currentChainBalances : {})) currentChainBalances[chain] = numMap(v);
  return {
    id: typeof j.id === 'string' || num(j.id) !== null ? j.id : null,
    name: str(j.name), symbol: str(j.symbol), address: str(j.address), gecko_id: str(j.gecko_id), pegType: str(j.pegType), pegMechanism: str(j.pegMechanism),
    deadFrom: str(j.deadFrom), price: toNum(j.price), chainConfig: isObj(j.chainConfig) ? j.chainConfig : null, chainBalances, currentChainBalances,
  };
};
const slimCgDetail = (j) => {
  if (!isObj(j) || typeof j.id !== 'string') throw new Error('not a coin');
  if (j.categories !== undefined && j.categories !== null && !Array.isArray(j.categories)) throw new Error('categories is not a list');
  const platforms = {};
  for (const [pid, d] of Object.entries(isObj(j.detail_platforms) ? j.detail_platforms : {})) {
    if (isObj(d) && typeof d.contract_address === 'string') platforms[pid] = { contract_address: d.contract_address, decimal_place: num(d.decimal_place) };
  }
  return { id: j.id, symbol: str(j.symbol), name: str(j.name), categories: strs(j.categories) || [], asset_platform_id: str(j.asset_platform_id), detail_platforms: platforms };
};
const slimCgChart = (j, ctx = LOOSE) => {
  if (!isObj(j)) throw new Error('not an object');
  const pairs = (x, what) => optRows(x, (p) => (Array.isArray(p) && p.length >= 2 && num(p[0]) !== null && ctx.inTime(p[0] / 1000) && (p[1] === null || num(p[1]) !== null) ? [p[0], p[1]] : null), what, ctx);
  return { prices: pairs(j.prices, 'prices'), market_caps: pairs(j.market_caps, 'market caps'), total_volumes: pairs(j.total_volumes, 'volumes') };
};
const CG_NUM = ['current_price', 'market_cap', 'market_cap_rank', 'total_volume', 'circulating_supply', 'total_supply', 'max_supply', 'fully_diluted_valuation'];
const slimCgMarkets = (rows, ctx = LOOSE) => keepRows(rows, (r) => (isObj(r) && okGecko(r.id) ? flat(r, { nums: CG_NUM }) : null), 'coins', ctx);
const slimPlatforms = (rows, ctx = LOOSE) =>
  keepRows(rows, (p) => (isObj(p) && typeof p.id === 'string' ? { id: p.id, chain_identifier: num(p.chain_identifier), name: str(p.name), shortname: str(p.shortname), native_coin_id: str(p.native_coin_id) } : null), 'platforms', ctx);
const slimLlamaChains = (rows, ctx = LOOSE) =>
  keepRows(rows, (c) => (isObj(c) && typeof c.name === 'string' ? { name: c.name, chainId: num(c.chainId) ?? (typeof c.chainId === 'string' ? c.chainId : null), gecko_id: str(c.gecko_id) } : null), 'chains', ctx);
const slimList = (j, ctx = LOOSE) => {
  if (!isObj(j)) throw new Error('not an object');
  const peggedAssets = keepRows(j.peggedAssets, (x) => {
    if (!isObj(x) || (typeof x.id !== 'string' && num(x.id) === null)) return null;
    const cc = {};
    for (const [chain, v] of Object.entries(isObj(x.chainCirculating) ? x.chainCirculating : {})) {
      if (isObj(v)) cc[chain] = { current: numMap(v.current), circulatingPrevDay: numMap(v.circulatingPrevDay), circulatingPrevWeek: numMap(v.circulatingPrevWeek), circulatingPrevMonth: numMap(v.circulatingPrevMonth) };
    }
    return {
      id: x.id, name: str(x.name), symbol: str(x.symbol), gecko_id: str(x.gecko_id), pegType: str(x.pegType), priceSource: str(x.priceSource), pegMechanism: str(x.pegMechanism),
      circulating: numMap(x.circulating), circulatingPrevDay: numMap(x.circulatingPrevDay), circulatingPrevWeek: numMap(x.circulatingPrevWeek), circulatingPrevMonth: numMap(x.circulatingPrevMonth),
      chainCirculating: cc, chains: strs(x.chains) || [], price: toNum(x.price), ...(typeof x.deadFrom === 'string' && x.deadFrom ? { deadFrom: x.deadFrom } : {}),
    };
  }, 'stablecoins', ctx);
  const chains = keepRows(j.chains, (c) => (isObj(c) && typeof c.name === 'string' ? { gecko_id: str(c.gecko_id), totalCirculatingUSD: numMap(c.totalCirculatingUSD), tokenSymbol: str(c.tokenSymbol), name: c.name } : null), 'chains', ctx);
  return { peggedAssets, chains };
};
const slimChainscout = (j) => {
  if (!isObj(j)) throw new Error('not an object');
  const out = {};
  for (const [id, c] of Object.entries(j)) {
    if (!isObj(c) || c.isTestnet || !Array.isArray(c.explorers)) continue;
    out[id] = { name: str(c.name), explorers: c.explorers.filter((e) => isObj(e) && typeof e.url === 'string').map((e) => ({ url: e.url, hostedBy: str(e.hostedBy) })) };
  }
  return out;
};
// chainid.network: name and public RPC endpoints per EVM chain id. RPCs kept: https on a public DNS name
// with a plain path (no templated "${KEY}" placeholders, credentials, ports or query strings), at most 4.
const PUBLIC_HTTPS = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/[A-Za-z0-9._~/-]*)?$/i;
const slimChainlist = (j) => {
  if (!Array.isArray(j)) throw new Error('not an array');
  const out = {};
  for (const c of j) {
    if (!isObj(c) || !Number.isInteger(c.chainId) || !Array.isArray(c.rpc)) continue;
    const rpc = c.rpc.filter((u) => typeof u === 'string' && PUBLIC_HTTPS.test(u)).slice(0, 4);
    if (rpc.length) out[c.chainId] = { name: str(c.name), rpc };
  }
  return out;
};
const coinPrices = (j, ctx = LOOSE) => {
  const v = isObj(j) && isObj(j.coins) ? Object.values(j.coins)[0] : null;
  if (!isObj(v) || !Array.isArray(v.prices)) throw new Error('no prices');
  return keepRows(v.prices, (p) => (isObj(p) && num(p.timestamp) !== null && ctx.inTime(p.timestamp) && num(p.price) !== null ? { t: p.timestamp, p: p.price } : null), 'prices', ctx);
};
const slimCoinsMap = (j) => {
  if (!isObj(j) || !isObj(j.coins)) throw new Error('no coins');
  const coins = {};
  for (const [k, v] of Object.entries(j.coins)) if (isObj(v)) coins[k] = { price: num(v.price), timestamp: num(v.timestamp), symbol: str(v.symbol), decimals: num(v.decimals), confidence: num(v.confidence) };
  return { coins };
};
const POOL_NUM = ['tvlUsd', 'apy', 'apyBase', 'apyReward', 'apyPct1D', 'apyPct7D', 'apyPct30D', 'apyMean30d', 'apyBase7d', 'il7d', 'volumeUsd1d', 'volumeUsd7d', 'apyBaseInception', 'mu', 'sigma', 'count'];
const LEND_NUM = ['totalSupplyUsd', 'totalBorrowUsd', 'apyBaseBorrow', 'apyRewardBorrow', 'ltv', 'debtCeilingUsd', 'borrowFactor'];
const slimPoolRows = (rows, ctx = LOOSE) => keepRows(rows, (p) => (isObj(p) && typeof p.pool === 'string' ? flat(p, { nums: POOL_NUM, lists: ['underlyingTokens', 'rewardTokens'] }) : null), 'pools', ctx);
const slimLendRows = (rows, ctx = LOOSE) => keepRows(rows, (p) => (isObj(p) && typeof p.pool === 'string' ? flat(p, { nums: LEND_NUM, lists: ['underlyingTokens', 'rewardTokens'] }) : null), 'lending markets', ctx);
const slimPoolChart = (j, ctx = LOOSE) =>
  keepRows(isObj(j) ? j.data : null, (x) => {
    const t = isObj(x) && typeof x.timestamp === 'string' ? Date.parse(x.timestamp) / 1000 : NaN;
    return ctx.inTime(t) ? { timestamp: x.timestamp, tvlUsd: num(x.tvlUsd), apy: num(x.apy), apyBase: num(x.apyBase), apyReward: num(x.apyReward) } : null;
  }, 'pool chart rows', ctx);

// ---------- client: cache + provenance accounting ----------
// Cached data is kept as JSON text so no caller can mutate what a later
// (warm) invocation will read.
const thaw = (e) => {
  const { json, ...v } = e.value;
  return { ...v, data: JSON.parse(json) };
};

function createClient({ fetch, cache, deadline, now = Math.floor(Date.now() / 1000) }) {
  const acc = new Map();
  const ingest = { inTime: (t) => M.timeOk(t, now) };
  const stat = (id) => {
    if (!acc.has(id)) acc.set(id, { requests: 0, ok: 0, failed: 0, skipped: 0, cached: 0, stale: 0, degraded: 0, recovered: 0, bytes: 0, latencyMs: 0, fetchedAt: [], asOf: [], errors: [], hosts: new Set(), notes: [] });
    return acc.get(id);
  };
  const degrade = (src, m) => {
    const s = stat(src);
    s.degraded++;
    if (!s.notes.includes(m)) s.notes.push(m);
  };
  const use = (s, v, stale, error, url, cadenceHours) => {
    s.ok++;
    if (num(v.fetchedAt)) s.fetchedAt.push(v.fetchedAt);
    if (num(v.asOf)) s.asOf.push({ t: v.asOf, url, cadenceHours });
    return stale ? { ...v, stale: true, error } : v;
  };
  async function get(src, url, o = {}) {
    const s = stat(src);
    s.requests++;
    const host = hostOf(url);
    s.hosts.add(host);
    const cadence = num(o.cadenceHours);
    const key = o.cacheKey || (o.body ? null : url);
    const cacheable = Boolean(cache && key && o.ttlMs > 0);
    const hit = cacheable ? cache.get(key) : null;
    const noteDrops = (v) => {
      if (v.dropped) degrade(src, `dropped ${v.dropped} malformed or out-of-range rows (${v.droppedWhat.slice(0, 3).join(', ')}) from ${shortUrl(url)}`);
    };
    if (hit) {
      s.cached++;
      const v = thaw(hit);
      noteDrops(v);
      return use(s, v, false, null, url, cadence);
    }
    const opts = { url, fetch, timeoutMs: o.timeoutMs, method: o.method, body: o.body, headers: o.headers, priority: o.priority, deadline: Math.min(deadline, o.deadline || Infinity) };
    const res = await (o.text ? fetchText : fetchJson)(opts);
    s.bytes += res.bytes || 0;
    s.latencyMs = Math.max(s.latencyMs, res.latencyMs || 0);
    let data = res.data;
    let error = res.ok ? null : res.error || 'failed';
    let dropped = 0;
    const droppedWhat = [];
    if (!error) {
      try {
        const ctx = { inTime: ingest.inTime, drop: (n, what) => { dropped += n; if (!droppedWhat.includes(what)) droppedWhat.push(what); } };
        if (o.transform) data = o.transform(data, ctx);
        if (o.validate && !o.validate(data)) error = 'unexpected response shape';
      } catch (e) {
        error = 'unexpected response shape: ' + String((e && e.message) || e).slice(0, 80);
      }
    }
    if (!error) {
      let asOf = null;
      try {
        asOf = o.asOf ? o.asOf(data, res) : res.lastModified;
      } catch {
        asOf = null;
      }
      const value = { ok: true, status: res.status, data, fetchedAt: res.fetchedAt, asOf: num(asOf), ...(dropped ? { dropped, droppedWhat } : {}) };
      if (cacheable) {
        const json = JSON.stringify(data);
        cache.set(key, { ...value, data: undefined, json }, { ttlMs: o.ttlMs, bytes: json.length });
      }
      noteDrops(value);
      return use(s, value, false, null, url, cadence);
    }
    // o.attempt: one of several interchangeable endpoints (e.g. public RPCs for one chain). Its failure
    // is not a data gap while another endpoint answers; the caller reports fail() if all of them fail.
    if (o.attempt) s.recovered++;
    else if (/^skipped/.test(error)) s.skipped++;
    else s.failed++;
    if (!o.attempt) s.errors.push(`${error} (${shortUrl(url)})`);
    const old = cacheable ? cache.peek(key) : null;
    if (old) {
      s.stale++;
      return use(s, thaw(old), true, error, url, cadence);
    }
    return { ok: false, status: res.status, data: null, error, fetchedAt: res.fetchedAt };
  }
  function summary(nowSec) {
    return SOURCES.map((d) => {
      const s = acc.get(d.id);
      // staleAfterHours: the age at which an ok source reads stale (two of its own publication
      // intervals); published so the page re-judges a cached snapshot with the same rule.
      const staleAfterHours = Number.isFinite(d.cadenceHours) ? 2 * d.cadenceHours : null;
      const base = { id: d.id, label: d.label, host: d.host, kind: d.kind, cadenceHours: d.cadenceHours, staleAfterHours };
      if (!s || !s.requests) {
        return { ...base, host: d.host, status: 'skipped', requests: 0, failed: 0, bytes: 0, latencyMs: 0, fetchedAt: null, dataAsOf: null, ageHours: null, message: (s && s.notes.join('; ')) || 'not requested in this run' };
      }
      // A source is as fresh as its freshest series. A series whose data is older than two of its
      // own publication intervals (hourly snapshot: 2 h; daily series: 2 days) lags (status partial).
      const asOf = s.asOf.length ? Math.max(...s.asOf.map((x) => x.t)) : null;
      const ageHours = asOf === null ? null : Math.round(((nowSec * 1000 - asOf) / 3.6e6) * 100) / 100;
      const lag = s.asOf.filter((x) => nowSec * 1000 - x.t > 2 * (x.cadenceHours || d.cadenceHours) * 3.6e6);
      const failed = s.failed + s.skipped;
      let status;
      if (!s.ok) status = s.failed ? 'error' : 'skipped';
      else if (s.stale) status = 'stale';
      // Stale = even the freshest data is older than two of the source's own publication intervals.
      else if (ageHours !== null && staleAfterHours !== null && ageHours > staleAfterHours) status = 'stale';
      else if (failed || lag.length || s.degraded) status = 'partial';
      else status = 'ok';
      const errs = [...new Set(s.errors)];
      const msg = [
        failed ? `${failed}/${s.requests} requests failed: ${errs.slice(0, 3).join('; ')}${errs.length > 3 ? '; ...' : ''}` : null,
        s.stale ? `${s.stale} served from the last good copy` : null,
        s.cached ? `${s.cached}/${s.requests} from cache` : null,
        s.recovered ? `${s.recovered} endpoint ${s.recovered === 1 ? 'attempt' : 'attempts'} failed over to an alternative` : null,
        status === 'stale' && !s.stale ? `data ${ageHours} h old vs ${d.cadenceHours} h cadence` : null,
        lag.length ? `${lag.length} series lag: ${lag.slice(0, 3).map((x) => `${shortUrl(x.url)} as of ${new Date(x.t).toISOString().slice(0, 16)}Z`).join('; ')}${lag.length > 3 ? '; ...' : ''}` : null,
        ...s.notes,
      ].filter(Boolean);
      const hosts = [...s.hosts].filter(Boolean);
      return {
        ...base,
        host: d.host || (hosts.length > 3 ? hosts.slice(0, 3).join(', ') + ', ...' : hosts.join(', ')),
        status,
        requests: s.requests,
        failed,
        bytes: s.bytes,
        latencyMs: s.latencyMs,
        fetchedAt: s.fetchedAt.length ? new Date(Math.min(...s.fetchedAt)).toISOString() : null,
        dataAsOf: asOf === null ? null : new Date(asOf).toISOString(),
        cadenceHours: d.cadenceHours,
        ageHours,
        message: msg.length ? msg.join('; ') : null,
      };
    });
  }
  // fail(): every alternative for one datum failed (see o.attempt); counts like a failed request.
  const fail = (src, m) => {
    const s = stat(src);
    s.failed++;
    s.errors.push(m);
  };
  return { get, summary, note: (src, m) => { const s = stat(src); if (!s.notes.includes(m)) s.notes.push(m); }, degrade, fail };
}

const { assetId, coinKeyOf } = R;

// Daily [{t, nat, usd}] of an asset from /stablecoincharts?stablecoin=.
function supplyRows(rows, pegType) {
  return (Array.isArray(rows) ? rows : []).filter(isObj).map((r) => {
    const pick = (o) => (isObj(o) ? (pegType && num(o[pegType]) !== null ? o[pegType] : num(Object.values(o)[0])) : null);
    return { t: dayOf(Number(r.date)), nat: pick(r.totalCirculating), usd: pick(r.totalCirculatingUSD) };
  });
}

// Max |ln(S_t / S_{t-30d})| over the past year: how far this supply moves in a month.
function monthlyTau(points) {
  const by = new Map(points.filter((p) => p.v > 0).map((p) => [p.t, p.v]));
  if (!by.size) return 0;
  const last = Math.max(...by.keys());
  let tau = 0;
  for (const [t, v] of by) if (t > last - 365 * DAY && by.has(t - 30 * DAY)) tau = Math.max(tau, Math.abs(Math.log(v / by.get(t - 30 * DAY))));
  return tau;
}

// Time a daily series represents: its last point's instant (00:00 UTC of the labelled day).
const lastDateMs = (key) => (rows) => {
  const ts = (Array.isArray(rows) ? rows : []).map((r) => Number(r && r[key])).filter(Number.isFinite);
  return ts.length ? Math.max(...ts) * 1000 : null;
};
// A detail's history is daily: its newest chain row.
const detailAsOf = (d) => {
  let t = null;
  for (const cb of Object.values((d && d.chainBalances) || {})) for (const x of cb.tokens || []) if (num(x.date) !== null && (t === null || x.date > t)) t = x.date;
  return t === null ? null : t * 1000;
};

async function collectRaw({ fetch = globalThis.fetch, now = Math.floor(Date.now() / 1000), log = () => {}, budgetMs = 12000, cache = sharedCache, timeoutMs = 8000, onchain = true, onchainBudgetMs = 6000 } = {}) {
  const t0 = Date.now();
  const deadline = t0 + budgetMs;
  const c = createClient({ fetch, cache, deadline, now });
  const errors = [];
  const raw = { now, startedAt: new Date(t0).toISOString(), errors };
  const safe = (label, fn, fallback = null) =>
    Promise.resolve()
      .then(fn)
      .catch((e) => {
        errors.push(`${label}: ${String((e && e.message) || e).slice(0, 160)}`);
        log('[paxos] ' + label + ' failed', e);
        return fallback;
      });
  const get = (src, url, o = {}) => c.get(src, url, { timeoutMs, ...o });
  const data = (r) => (r && r.ok ? r.data : null);
  const track = (p) => {
    const w = p.then((v) => {
      w.done = true;
      w.value = v;
      return v;
    });
    return w;
  };
  const memo = (fn) => {
    const m = new Map();
    return (k, ...rest) => {
      if (!m.has(k)) m.set(k, fn(k, ...rest));
      return m.get(k);
    };
  };
  // Discovery never takes the run down: per-record problems come back as errors, anything else
  // keeps the previous pass.
  const discover = (inputs, prev) => {
    try {
      const r = R.discover(inputs);
      for (const e of r.errors || []) if (!errors.includes(e)) errors.push(e);
      return r;
    } catch (e) {
      errors.push('discover: ' + String((e && e.message) || e).slice(0, 160));
      return prev || { assets: [], tiers: [], pending: [], errors: [] };
    }
  };

  try {
    // ---------- core ----------
    const listP = get('llama-stablecoins', `${LLAMA}/stablecoins`, { ttlMs: TTL.llama, transform: slimList, validate: (j) => j.peggedAssets.length > 0 });
    const chartsAllP = get('llama-market', `${LLAMA}/stablecoincharts/all`, { ttlMs: TTL.llama, transform: slimTotals, validate: nonEmpty, asOf: lastDateMs('date'), cadenceHours: DAILY });
    // Fee series are daily totals; the last point covers its whole day, so the data is as of the end of that day.
    const feesAsOf = (j) => {
      const last = j.totalDataChart.filter((p) => p[0] < dayOf(now)).at(-1);
      return last ? (last[0] + DAY) * 1000 : null;
    };
    const feeUrl = (type) => `${API}/summary/fees/${R.ISSUER.feesSlug}?dataType=${type}`;
    const feesP = get('llama-fees', feeUrl('dailyFees'), { ttlMs: TTL.fees, transform: slimFees, asOf: feesAsOf });
    const revenueP = get('llama-fees', feeUrl('dailyRevenue'), { ttlMs: TTL.fees, transform: slimFees, asOf: feesAsOf });
    const llamaChainsP = get('llama-protocol', `${API}/v2/chains`, { ttlMs: TTL.registry, transform: slimLlamaChains, validate: nonEmpty, asOf: none });
    const protocolsP = safe('protocol graph', async () => {
      const parent = await get('llama-protocol', `${API}/protocol/${R.ISSUER.protocolSlug}`, { ttlMs: TTL.registry, transform: slimProtocol, validate: (j) => Boolean(j.name), asOf: none });
      if (!parent.ok) return [];
      // otherProtocols lists display names of the family; DefiLlama slugs are the lower-cased, hyphenated names.
      const slugs = [...new Set((parent.data.otherProtocols || []).map((n) => n.toLowerCase().trim().replace(/\s+/g, '-')))].filter((s) => /^[a-z0-9-]+$/.test(s) && s !== R.ISSUER.protocolSlug);
      const kids = await Promise.all(slugs.map((s) => get('llama-protocol', `${API}/protocol/${s}`, { ttlMs: TTL.registry, transform: slimProtocol, validate: (j) => Boolean(j.name), asOf: none })));
      return [parent.data, ...kids.filter((k) => k.ok).map((k) => k.data)];
    }, []);
    const cgMarketsAsOf = (rows) => {
      const ts = rows.map((r) => Date.parse(r.last_updated)).filter(Number.isFinite);
      return ts.length ? Math.min(...ts) : null;
    };
    const cgMarketsP = get('coingecko', `${CG}/coins/markets?vs_currency=usd&category=${R.ISSUER.cgCategory}&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h,7d,30d,1y`, {
      ttlMs: TTL.cgMarkets,
      priority: 0,
      transform: slimCgMarkets,
      asOf: cgMarketsAsOf,
    });
    const cgPlatformsP = track(get('coingecko', `${CG}/asset_platforms`, { ttlMs: TTL.registry, priority: 6, transform: slimPlatforms, validate: nonEmpty, asOf: none }));
    const cgGoldP = track(get('coingecko', `${CG}/coins/markets?vs_currency=usd&category=${R.ISSUER.goldCategory}&order=market_cap_desc&per_page=50&page=1&sparkline=false`, { ttlMs: TTL.registry, priority: 2, transform: slimCgMarkets, asOf: none }));
    const cgDetails = {};
    const cgDetail = memo((id, priority) =>
      get('coingecko', `${CG}/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`, {
        ttlMs: TTL.registry,
        priority,
        transform: slimCgDetail,
        validate: (j) => j.id === id,
        asOf: none,
      }).then((r) => {
        if (r.ok) cgDetails[id] = r.data;
        return r;
      }),
    );
    const cgDetailsP = track(cgMarketsP.then((r) => Promise.all((data(r) || []).map((x) => cgDetail(x.id, 1)))));
    const docsP = safe('paxos docs', async () => {
      const idx = await get('paxos-docs', R.ISSUER.docsIndex, { text: true, ttlMs: TTL.registry, asOf: none });
      if (!idx.ok) return null;
      const slugs = R.parseDocsIndex(idx.data);
      // Parser self-checks: a page that loads but yields no token table is reported, not silently empty.
      if (!slugs.length) c.degrade('paxos-docs', 'the docs index lists no stablecoin mainnet pages (index format changed?)');
      const pages = await Promise.all(slugs.map((s) => get('paxos-docs', `${DOCS}/${s}/mainnet.md`, { text: true, ttlMs: TTL.registry, asOf: none })));
      const out = {};
      slugs.forEach((s, i) => {
        if (!pages[i].ok) return;
        const p = R.parseDocsMainnet(pages[i].data, s);
        if (p.rows.length) out[s] = p;
        else c.degrade('paxos-docs', `${s}/mainnet.md: no token address table recognised (${p.tables} tables on the page; format changed?)`);
      });
      return Object.keys(out).length ? out : null;
    });
    const chainscoutP = onchain ? get('chainscout', CHAINSCOUT, { ttlMs: TTL.chainscout, transform: slimChainscout, validate: (j) => Object.keys(j).length > 0, asOf: none }) : Promise.resolve(null);
    const chainlistP = onchain ? get('chainlist', CHAINLIST, { ttlMs: TTL.chainscout, transform: slimChainlist, validate: (j) => Object.keys(j).length > 0, asOf: none }) : Promise.resolve(null);
    const cmCatalogP = get('coinmetrics', `${CM}/catalog-v2/asset-metrics?metrics=SplyCur&page_size=10000`, {
      ttlMs: TTL.registry,
      transform: (j) => keepRows(isObj(j) ? j.data : null, (x) => (isObj(x) && typeof x.asset === 'string' ? x.asset : null), 'catalog').filter((id) => /^[a-z0-9_]+$/.test(id)),
      validate: nonEmpty,
      asOf: none,
    });

    const [listR, feesR, revenueR, llamaChainsR, protocols, cgMarketsR, docs, chainlistR] = await Promise.all([listP, feesP, revenueP, llamaChainsP, protocolsP, cgMarketsP, docsP, chainlistP]);
    // CoinGecko registry calls (details, platforms, gold category) are waited
    // for only briefly: keyless CoinGecko is slow by design and every one of
    // them has a non-CoinGecko fallback. Late arrivals are used by the final
    // discovery pass and cached for the next run.
    await safe('coingecko grace', () => {
      const ms = deadline - budgetMs * 0.65 - Date.now();
      let timer;
      const wait = new Promise((r) => (timer = setTimeout(r, Math.max(0, ms))));
      return Promise.race([Promise.all([cgPlatformsP, cgGoldP, cgDetailsP]), wait]).finally(() => clearTimeout(timer));
    });

    // Without the list there are no DefiLlama ids, peers or chain totals, but
    // CoinGecko/docs/protocol discovery and CoinGecko supply still work.
    const list = data(listR) || { peggedAssets: [], chains: [] };
    raw.list = data(listR);
    // The list is an hourly snapshot; its Last-Modified is the snapshot time (seconds).
    raw.listAsOf = listR && listR.ok && num(listR.asOf) !== null ? Math.floor(listR.asOf / 1000) : null;
    raw.fees = data(feesR);
    raw.revenue = data(revenueR);
    raw.llamaChains = data(llamaChainsR);
    raw.chainlist = data(chainlistR);
    raw.protocols = protocols || [];
    raw.cgMarkets = data(cgMarketsR);
    raw.docs = docs;
    const feeNames = R.feeLabelNames(raw.fees);
    if (raw.fees && !feeNames.length) c.degrade('llama-fees', 'no fee label names an asset (expected "Yields from <asset> backing"; label format changed?), so the fee-label discovery tier found nothing');
    if (Array.isArray(raw.cgMarkets) && !raw.cgMarkets.length) c.degrade('coingecko', `category "${R.ISSUER.cgCategory}" returned no coins`);
    const namerFor = () => R.makeChainNamer({ listChains: list.chains, llamaChains: raw.llamaChains, cgPlatforms: cgPlatformsP.done ? data(cgPlatformsP.value) : null, evmChains: raw.chainlist });
    // A tier is ok only when it answered AND its parser found something to work with.
    const tierOk = {
      'coingecko:category': Array.isArray(raw.cgMarkets) && raw.cgMarkets.length > 0,
      'paxos-docs': Boolean(docs),
      'defillama:fees-label': feeNames.length > 0,
      'defillama:protocol': raw.protocols.length > 0,
    };
    const llamaDetails = {};
    const links = [];
    const coreInputs = () => ({
      list,
      fees: raw.fees,
      protocols: raw.protocols,
      cgMarkets: raw.cgMarkets,
      cgDetails: { ...cgDetails },
      cgGold: cgGoldP.done ? data(cgGoldP.value) : null,
      docs: raw.docs,
      llamaDetails,
      links,
      tierOk,
      namer: namerFor(),
    });

    // ---------- discovery + details for active assets ----------
    const detail = memo((id) =>
      get('llama-stablecoins', `${LLAMA}/stablecoin/${id}`, { ttlMs: TTL.llama, transform: slimDetail, validate: (j) => String(j.id) === String(id), asOf: detailAsOf, cadenceHours: DAILY }).then((r) => {
        if (r.ok) llamaDetails[id] = r.data;
        return r;
      }),
    );
    const charts = memo((id) => get('llama-stablecoins', `${LLAMA}/stablecoincharts/all?stablecoin=${id}`, { ttlMs: TTL.llama, transform: slimCharts, validate: nonEmpty, asOf: lastDateMs('date'), cadenceHours: DAILY }));
    let reg = discover(coreInputs());
    // CoinGecko rows still lacking contracts vs. entries with contracts but no
    // CoinGecko id: let coins.llama.fi's contract -> id mapping join them.
    const cgOrphans = reg.assets.filter((a) => a.cg && !a.addresses.length).map((a) => a.geckoId);
    const contracts = reg.assets
      .filter((a) => !a.geckoId)
      .flatMap((a) => a.addresses.filter((x) => R.isEvm(x.address)).slice(0, 2))
      .map((x) => ({ key: `${x.llamaKey || R.chainKey(x.chain)}:${x.address.toLowerCase()}`, chain: x.chain, address: x.address }))
      .filter((x) => /^[a-z0-9-]+:0x[0-9a-f]{40}$/.test(x.key));
    if (cgOrphans.length && contracts.length) {
      const keys = [...cgOrphans.map((id) => 'coingecko:' + id), ...contracts.map((x) => x.key)];
      const r = await get('llama-coins', `${COINS}/prices/current/${keys.join(',')}`, { ttlMs: TTL.coins, transform: slimCoinsMap, asOf: none });
      if (r.ok) links.push(...R.coinLinks(r.data.coins, cgOrphans, contracts));
      if (links.length) reg = discover(coreInputs(), reg);
    }
    // Docs entries not yet joined: try their ticker-sharing list entries one
    // at a time (largest first) until a detail's contract confirms the join.
    const confirms = (d, rows) => {
      const mine = new Set(rows.map((r) => R.normAddr(r.address)));
      const theirs = [String(d.address || '').split(':').pop(), ...Object.values((d.chainConfig && isObj(d.chainConfig.chains) && d.chainConfig.chains) || {}).flatMap((k) => (isObj(k) ? Object.values(k) : []).flat())];
      return theirs.some((a) => typeof a === 'string' && mine.has(R.normAddr(a)));
    };
    const verify = async (p) => {
      for (const id of p.candidates.filter(okLlama)) {
        await detail(id);
        if (llamaDetails[id] && raw.docs[p.slug] && confirms(llamaDetails[id], raw.docs[p.slug].rows)) return;
      }
    };
    for (let pass = 0; pass < 3; pass++) {
      for (const a of reg.assets) if (a.llamaId && okLlama(a.llamaId)) charts(a.llamaId); // start early; memoised
      const active = reg.assets.filter((a) => a.status === 'active' && okLlama(a.llamaId)).map((a) => a.llamaId);
      const pending = reg.pending.filter((p) => p.candidates.some((id) => !(id in llamaDetails)));
      const missing = active.filter((id) => !(id in llamaDetails));
      if (!missing.length && !pending.length) break;
      const had = Object.keys(llamaDetails).length;
      await Promise.all([...missing.map((id) => detail(id)), ...pending.map(verify)]);
      if (Object.keys(llamaDetails).length === had) break;
      reg = discover(coreInputs(), reg);
    }
    const assets = reg.assets;
    log(`[paxos] discovered ${assets.map((a) => `${a.key}:${a.status}`).join(', ')} in ${Date.now() - t0} ms`);

    // ---------- per-asset supply ----------
    const chartRows = {};
    await Promise.all(
      assets.filter((a) => a.llamaId && okLlama(a.llamaId)).map(async (a) => {
        const r = await charts(a.llamaId);
        if (r.ok) chartRows[a.llamaId] = r.data;
      }),
    );
    raw.charts = chartRows;
    const chartsAll = data(await chartsAllP);
    raw.chartsAll = chartsAll;

    // Peers / references
    let excluded = new Set();
    try {
      excluded = new Set(M.listSanity(list, chartsAll || []).excluded.map((x) => String(x.id)));
    } catch (e) {
      errors.push('listSanity: ' + e.message);
    }
    raw.pegPeers = R.selectPegPeers(list, assets, excluded);

    // ---------- prices ----------
    const endH = Math.ceil(now / 3600) * 3600;
    const endD = Math.ceil(now / DAY) * DAY;
    const okCoinKey = (k) => typeof k === 'string' && /^[a-z0-9-]+:[A-Za-z0-9-]+$/.test(k);
    const hourly = {};
    const dailyPx = {};
    const coinSeries = memo((key) =>
      Promise.all([
        // coins.llama.fi answers each grid time with a print within searchWidth of it (default 10% of the
        // period, 6 min). Hourly prints sit anywhere in the hour, so the default silently drops every
        // print more than 6 min off the hour and a live feed looks stopped; half the period assigns
        // every print to its nearest grid time.
        get('llama-coins', `${COINS}/chart/${key}?end=${endH}&span=${COINS_SPAN}&period=1h&searchWidth=${3600 / 2}`, { ttlMs: TTL.coins, transform: coinPrices, validate: nonEmpty, asOf: (p) => p.at(-1).t * 1000 }),
        get('llama-coins', `${COINS}/chart/${key}?end=${endD}&span=${COINS_SPAN}&period=1d`, { ttlMs: TTL.coins, transform: coinPrices, validate: nonEmpty, asOf: none }),
      ]).then(([h, d]) => {
        if (h.ok) hourly[key] = h.data;
        if (d.ok) dailyPx[key] = d.data;
      }),
    );
    const coinKeys = {};
    for (const a of assets) coinKeys[assetId(a)] = coinKeyOf(a);
    const priceJobs = [];
    for (const a of assets) if (a.status !== 'dead' && okCoinKey(coinKeys[assetId(a)])) priceJobs.push(coinSeries(coinKeys[assetId(a)]));
    for (const p of raw.pegPeers) if (okGecko(p.geckoId)) priceJobs.push(coinSeries('coingecko:' + p.geckoId));
    const goldRefsP = safe('gold refs', async () => {
      const refs = R.selectGoldRefs(data(await cgGoldP), assets);
      await Promise.all(refs.map((r) => coinSeries('coingecko:' + r.geckoId)));
      return refs;
    }, []);
    const firstKeys = [...new Set(Object.values(coinKeys).filter(okCoinKey))];
    const firstP = firstKeys.length
      ? get('llama-coins', `${COINS}/prices/first/${firstKeys.join(',')}`, { ttlMs: TTL.registry, transform: slimCoinsMap, asOf: none })
      : Promise.resolve(null);

    const cgCharts = {};
    const cgXau = {};
    const cgJobs = [];
    const liveCg = assets.filter((a) => a.status === 'active' && okGecko(a.geckoId));
    // Gold first: DefiLlama does not track gold-token supply, CoinGecko is its primary source.
    liveCg.sort((x, y) => (y.kind === 'gold') - (x.kind === 'gold') || ((y.cg && y.cg.market_cap) || 0) - ((x.cg && x.cg.market_cap) || 0));
    const cgChartUrl = (id, vs) => `${CG}/coins/${id}/market_chart?vs_currency=${vs}&days=365&interval=daily`;
    const cgChartOpts = (priority) => ({ ttlMs: TTL.cgChart, priority, transform: slimCgChart, validate: (j) => j.prices.length > 0, asOf: none });
    for (const a of liveCg) {
      const gold = a.kind === 'gold';
      cgJobs.push(get('coingecko', cgChartUrl(a.geckoId, 'usd'), cgChartOpts(gold ? 3 : 5)).then((r) => r.ok && (cgCharts[a.geckoId] = r.data)));
      if (gold) cgJobs.push(get('coingecko', cgChartUrl(a.geckoId, 'xau'), cgChartOpts(4)).then((r) => r.ok && (cgXau[a.geckoId] = r.data)));
    }
    // Registry details for non-category assets (e.g. legacy ones): lowest priority, cached a day.
    for (const a of assets) if (a.status !== 'dead' && okGecko(a.geckoId) && !a.cg) cgJobs.push(cgDetail(a.geckoId, 7));

    // ---------- chain totals for material chains ----------
    // The engine's materiality rule (model.materialityFloor / materialChain): a chain is material when
    // its largest native balance over the past month, at today's price, reaches the asset's floor
    // (median non-flat daily net flow of the past year). Chain series are built exactly as the model
    // builds them (model.chainSeries over the same detail), so every chain the engine tests gets a total.
    const chainTotalsP = safe('chain totals', async () => {
      const want = new Set();
      for (const a of assets) {
        if (a.status === 'dead' || !chartRows[a.llamaId]) continue;
        const rows = supplyRows(chartRows[a.llamaId], a.pegType);
        const sup = M.daily(rows.map((r) => ({ t: r.t, v: r.nat })), { now });
        const usd = M.daily(rows.map((r) => ({ t: r.t, v: r.usd })), { now });
        const { floorUsd, px } = M.materialityFloor(sup, usd, (a.cg && num(a.cg.current_price)) || (a.kind === 'usd-stablecoin' ? 1 : null));
        if (floorUsd === null) continue;
        const det = llamaDetails[a.llamaId];
        if (det) {
          for (const [chain, cb] of Object.entries(det.chainBalances)) if (M.materialChain(M.chainSeries(cb, a.pegType, now), px, floorUsd)) want.add(chain);
        } else {
          // No detail: the list's month of chain values (USD) stands in for the chain series.
          for (const [chain, cc] of Object.entries((a.list && a.list.chainCirculating) || {})) {
            const vals = ['current', 'circulatingPrevDay', 'circulatingPrevWeek', 'circulatingPrevMonth'].map((k) => num(Object.values(cc[k] || {})[0])).filter((v) => v !== null);
            if (vals.length && Math.max(...vals) >= floorUsd) want.add(chain);
          }
        }
      }
      const known = new Set((list.chains || []).map((x) => x.name));
      const out = {};
      await Promise.all(
        [...want].filter((ch) => known.has(ch)).map(async (ch) => {
          const r = await get('llama-market', `${LLAMA}/stablecoincharts/${encodeURIComponent(ch)}`, { ttlMs: TTL.llama, transform: slimTotals, validate: nonEmpty, asOf: lastDateMs('date'), cadenceHours: DAILY });
          if (r.ok) out[ch] = r.data.map((x) => [x.date, sum(x.totalCirculatingUSD)]);
        }),
      );
      return out;
    }, {});

    // ---------- DeFi: pools matched by Paxos (issuer) contract addresses ----------
    const addrSet = new Set(assets.flatMap((a) => a.addresses.map((x) => R.normAddr(x.address))));
    const sig = hashStr([...addrSet].sort().join(','));
    const holds = (toks) => Array.isArray(toks) && toks.some((t) => typeof t === 'string' && addrSet.has(R.normAddr(t)));
    const yieldsAsOf = (d, res) => (res.expires ? res.expires - 3600e3 : res.lastModified); // yields refresh hourly; expires = next refresh
    const poolsP = get('llama-yields', `${YIELDS}/pools`, {
      cacheKey: `${YIELDS}/pools#${sig}`,
      ttlMs: TTL.yields,
      timeoutMs: Math.max(timeoutMs, 10000),
      // 11.7 MB upstream: keep stablecoin pools (peer context) and pools holding a Paxos contract, drop the rest at once.
      transform: (j, ctx) => slimPoolRows(isObj(j) ? j.data : null, ctx).filter((p) => p.stablecoin === true || holds(p.underlyingTokens)),
      asOf: yieldsAsOf,
    });
    const lendBorrowP = get('llama-yields', `${YIELDS}/lendBorrow`, { ttlMs: TTL.yields, transform: slimLendRows, asOf: yieldsAsOf });
    const defiP = safe('defi', async () => {
      const pools = data(await poolsP);
      const lb = data(await lendBorrowP);
      const keep = new Set((pools || []).map((p) => p.pool));
      raw.pools = pools;
      raw.lendBorrow = lb ? lb.filter((r) => keep.has(r.pool) || holds(r.underlyingTokens)) : null;
      raw.poolCharts = {};
      if (!pools) return;
      // Top pools per asset by TVL until half of its matched footprint, at most 8.
      const want = new Set();
      for (const a of assets.filter((x) => x.status !== 'dead')) {
        const mine = new Set(a.addresses.map((x) => R.normAddr(x.address)));
        const matched = pools.filter((p) => num(p.tvlUsd) > 0 && (p.underlyingTokens || []).some((t) => mine.has(R.normAddr(t)))).sort((x, y) => y.tvlUsd - x.tvlUsd);
        const total = matched.reduce((s, p) => s + p.tvlUsd, 0);
        let cum = 0;
        for (const p of matched.slice(0, 8)) {
          if (cum >= total / 2) break;
          want.add(p.pool);
          cum += p.tvlUsd;
        }
      }
      const ids = [...want].filter((id) => /^[0-9a-f-]{8,64}$/i.test(id)).sort();
      for (const id of ids) raw.poolCharts[id] = null; // fixed key order; failures are removed below
      await Promise.all(
        ids.map(async (id) => {
          const r = await get('llama-yields', `${YIELDS}/chart/${id}`, { ttlMs: TTL.yields, transform: slimPoolChart, validate: nonEmpty, asOf: none });
          if (r.ok) raw.poolCharts[id] = r.data;
          else delete raw.poolCharts[id];
        }),
      );
    });

    // ---------- on-chain snapshot (strict sub-budget, best effort) ----------
    const onchainP = safe('onchain', async () => {
      const out = {};
      if (!onchain) {
        c.note('onchain', 'disabled');
        return out;
      }
      const scout = data(await chainscoutP) || {};
      const rpcs = Object.fromEntries(Object.entries(raw.chainlist || {}).map(([id, c]) => [id, c.rpc]));
      const sub = Math.min(deadline, Date.now() + onchainBudgetMs);
      const put = (a, rec) => (out[assetId(a)] = out[assetId(a)] || []).push(rec);
      const jobs = [];
      const sol = [];
      const keyed = keys.blockscout();
      const iso = (ms) => new Date(ms).toISOString();
      const tokenOk = (j) => isObj(j) && (j.total_supply != null || j.holders_count != null || j.holders != null);
      // Holders (and a supply cross-check) from Blockscout. With BLOCKSCOUT_API_KEY every chain goes through
      // the PRO API, the supported route for scripted access; without it the public per-chain explorer is
      // used, and hosts behind bot protection answer 403 (reported, with the fix, in the source message).
      const explorerRead = async (ad) => {
        // Explorer hosts come from Chainscout data: Blockscout-hosted, https, a public DNS name, fixed API path
        // (http.js refuses any redirect off that host).
        const ex = scout[ad.chainId] && scout[ad.chainId].explorers.find((e) => e.hostedBy === 'blockscout' && /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\/?$/i.test(e.url));
        if (!ex) return null;
        const pub = `${new URL(ex.url).origin}/api/v2/tokens/${ad.address}`;
        const o = { ttlMs: TTL.onchain, deadline: sub, validate: tokenOk, asOf: (j, res) => res.date || res.fetchedAt };
        let r = keyed ? await get('onchain', `https://${BLOCKSCOUT_PRO}/${ad.chainId}/api/v2/tokens/${ad.address}`, { ...o, attempt: true }) : null;
        let host = BLOCKSCOUT_PRO;
        if (r && !r.ok && /HTTP 40[123]\b/.test(r.error || '')) c.note('onchain', `${BLOCKSCOUT_PRO} refused BLOCKSCOUT_API_KEY (${/HTTP \d+/.exec(r.error)[0]}); falling back to the public explorers`);
        if (!r || !r.ok) {
          r = await get('onchain', pub, o);
          host = hostOf(pub);
          if (!r.ok && !keyed && /HTTP 403/.test(r.error || '')) c.note('onchain', `${host} blocks scripted requests; set BLOCKSCOUT_API_KEY to read holders through ${BLOCKSCOUT_PRO}`);
        }
        if (!r.ok) return null;
        const dec = Number(r.data.decimals), ts = Number(r.data.total_supply), holders = Number(r.data.holders_count ?? r.data.holders);
        return { holders: Number.isFinite(holders) ? holders : null, totalSupply: Number.isFinite(ts) && Number.isInteger(dec) ? ts / 10 ** dec : null, decimals: Number.isInteger(dec) ? dec : null, host, asOf: r.asOf || r.fetchedAt };
      };
      // Total supply straight from the chain: ERC-20 totalSupply() (and decimals() when the registry has
      // none) by eth_call on the chain's public RPCs from the chain registry, trying them in turn; the last
      // endpoint that answered for a chain is tried first next time (remembered in the request cache).
      const goodKey = (chainId) => `rpc-last-good ${chainId}`;
      const rpcCall = async (chainId, to, sig) => {
        const list = rpcs[chainId] || [];
        const hit = cache && cache.get(goodKey(chainId));
        const remembered = hit ? hit.value : null;
        const order = [...new Set([remembered, ...list].filter((u) => u && list.includes(u)))];
        for (const u of order) {
          const r = await get('onchain', u, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data: sig }, 'latest'] }), cacheKey: `eth_call ${u} ${to.toLowerCase()} ${sig}`, ttlMs: TTL.onchain, deadline: sub, timeoutMs: Math.min(timeoutMs, 2500), attempt: true, validate: (j) => isObj(j) && typeof j.result === 'string' && /^0x[0-9a-f]{1,64}$/i.test(j.result), asOf: (j, res) => res.date || res.fetchedAt });
          if (r.ok) { if (cache) cache.set(goodKey(chainId), u, { ttlMs: TTL.registry, bytes: u.length }); return { value: BigInt(r.data.result), host: hostOf(u), asOf: r.asOf || r.fetchedAt }; }
        }
        if (order.length) c.fail('onchain', `no RPC answered eth_call on chain ${chainId} (${order.map(hostOf).join(', ')})`);
        return null;
      };
      const rpcSupply = async (ad) => {
        if (!(rpcs[ad.chainId] || []).length) return null;
        let dec = Number.isInteger(ad.decimals) ? ad.decimals : null;
        if (dec === null) { const d = await rpcCall(ad.chainId, ad.address, '0x313ce567'); dec = d && d.value <= 36n ? Number(d.value) : null; }
        if (dec === null) return null;
        const s = await rpcCall(ad.chainId, ad.address, '0x18160ddd');
        // Scale by 10^dec in two steps so 18-decimal supplies keep their precision before Number().
        return s ? { totalSupply: Number(s.value / 10n ** BigInt(Math.max(0, dec - 6))) / 10 ** Math.min(dec, 6), decimals: dec, host: s.host, asOf: s.asOf } : null;
      };
      for (const a of assets.filter((x) => x.status === 'active')) {
        for (const ad of a.addresses) {
          if (R.chainKey(ad.chain) === SOLANA_KEY && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ad.address)) {
            sol.push({ a, ad });
            continue;
          }
          if (!R.isEvm(ad.address) || !ad.chainId) continue;
          jobs.push(
            Promise.all([explorerRead(ad), rpcSupply(ad)]).then(([ex, rpc]) => {
              if (!ex && !rpc) return;
              // Supply: the chain's own answer when the RPC gave one, else the explorer's; holders only
              // come from an explorer.
              put(a, {
                chain: ad.chain, address: ad.address,
                holders: ex ? ex.holders : null,
                totalSupply: rpc ? rpc.totalSupply : ex.totalSupply,
                decimals: rpc ? rpc.decimals : ex.decimals,
                source: [ex && ex.host, rpc && rpc.host].filter(Boolean).join(' + '),
                asOf: iso(Math.max(ex ? ex.asOf : 0, rpc ? rpc.asOf : 0)),
              });
            }),
          );
        }
      }
      if (sol.length) {
        const mints = [...new Set(sol.map((s) => s.ad.address))];
        jobs.push(
          (async () => {
            const jupAsOf = (j) => {
              const ts = j.map((x) => Date.parse(isObj(x) ? x.updatedAt : NaN)).filter(Number.isFinite);
              return ts.length ? Math.max(...ts) : null;
            };
            const r = await get('onchain', `${JUPITER}?query=${mints.join(',')}`, { ttlMs: TTL.onchain, deadline: sub, validate: Array.isArray, asOf: jupAsOf });
            for (const { a, ad } of sol) {
              const t = r.ok ? r.data.find((x) => isObj(x) && x.id === ad.address) : null;
              if (t) {
                const up = typeof t.updatedAt === 'string' && Number.isFinite(Date.parse(t.updatedAt)) ? new Date(t.updatedAt).toISOString() : new Date(r.asOf || r.fetchedAt).toISOString();
                put(a, { chain: ad.chain, address: ad.address, holders: num(t.holderCount), totalSupply: toNum(t.totalSupply), decimals: Number.isInteger(t.decimals) ? t.decimals : null, source: 'lite-api.jup.ag', asOf: up });
                continue;
              }
              if (r.ok) continue; // Jupiter answered without this mint
              const s = await get('onchain', SOLANA_RPC, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [ad.address] }), deadline: sub, validate: (j) => isObj(j) && isObj(j.result) && isObj(j.result.value), asOf: (j, res) => res.date || res.fetchedAt });
              if (s.ok) put(a, { chain: ad.chain, address: ad.address, holders: null, totalSupply: toNum(s.data.result.value.uiAmountString), decimals: num(s.data.result.value.decimals), source: hostOf(SOLANA_RPC), asOf: new Date(s.asOf || s.fetchedAt).toISOString() });
            }
          })(),
        );
      }
      await Promise.all(jobs);
      for (const recs of Object.values(out)) recs.sort((x, y) => x.chain.localeCompare(y.chain) || x.address.localeCompare(y.address));
      return out;
    }, {});

    // ---------- Coin Metrics: validated mappings only ----------
    const dailyHist = {};
    const cmP = safe('coinmetrics', async () => {
      const out = { map: {}, peers: {}, rows: {}, supply: {} };
      const catalog = data(await cmCatalogP);
      if (!catalog) return out;
      const oc = await onchainP;
      const goldCg = (a) => (a.cg ? [num(a.cg.circulating_supply), num(a.cg.total_supply)] : []);
      const today = dayOf(now);
      const subjects = [];
      for (const a of assets.filter((x) => x.status !== 'dead')) {
        const ms = [];
        let tau = 0;
        const sup = a.llamaId && chartRows[a.llamaId] ? supplyRows(chartRows[a.llamaId], a.pegType).slice(-400) : [];
        for (const r of sup) if (r.t >= today - 5 * DAY) ms.push({ chain: null, t: r.t, v: r.nat });
        if (sup.length) tau = monthlyTau(sup.map((r) => ({ t: r.t, v: r.nat })));
        for (const v of goldCg(a)) ms.push({ chain: null, t: today, v });
        const det = a.llamaId && llamaDetails[a.llamaId];
        for (const [chain, cb] of Object.entries((det && det.chainBalances) || {})) {
          for (const x of cb.tokens.slice(-6)) {
            const t = dayOf(x.date);
            ms.push({ chain, t, v: num(Object.values(x.circulating)[0]) });
            ms.push({ chain, t, v: num(Object.values(x.minted)[0]) });
          }
        }
        for (const [chain, cc] of Object.entries((a.list && a.list.chainCirculating) || {})) {
          ms.push({ chain, t: today, v: num(Object.values(cc.current || {})[0]) });
          ms.push({ chain, t: today - DAY, v: num(Object.values(cc.circulatingPrevDay || {})[0]) });
        }
        const ocs = (oc && oc[assetId(a)]) || [];
        for (const o of ocs) ms.push({ chain: o.chain, t: today, v: o.totalSupply });
        if (ocs.length) ms.push({ chain: null, t: today, v: ocs.reduce((s, o) => s + (o.totalSupply || 0), 0) });
        subjects.push({ key: assetId(a), symbol: a.symbol, measures: ms.filter((m) => m.v > 0), tau });
      }
      // 1-2 of the largest USD peers give usage context; they have list data only.
      for (const p of raw.pegPeers.slice(0, 2)) {
        const e = list.peggedAssets.find((x) => String(x.id) === p.llamaId);
        if (!e) continue;
        const pv = (o) => num((o || {})[e.pegType]) ?? num(Object.values(o || {})[0]);
        const ms = [
          { chain: null, t: today, v: pv(e.circulating) },
          { chain: null, t: today - DAY, v: pv(e.circulatingPrevDay) },
        ];
        for (const [chain, cc] of Object.entries(e.chainCirculating || {})) {
          ms.push({ chain, t: today, v: pv(cc && cc.current) });
          ms.push({ chain, t: today - DAY, v: pv(cc && cc.circulatingPrevDay) });
        }
        subjects.push({ key: 'peer:' + p.llamaId, symbol: p.symbol, measures: ms.filter((m) => m.v > 0), tau: 0 });
      }
      const syms = new Set(subjects.map((s) => s.symbol && s.symbol.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean));
      const cands = catalog.filter((id) => syms.has(id.split('_')[0]));
      if (!cands.length) return out;
      const start = isoDay(today - 400 * DAY);
      const groupRows = (j, ctx = LOOSE) => {
        const by = {};
        const rows = keepRows(isObj(j) ? j.data : null, (r) => (isObj(r) && typeof r.asset === 'string' && typeof r.time === 'string' && ctx.inTime(Date.parse(r.time) / 1000) ? r : null), 'metric rows', ctx);
        for (const r of rows) (by[r.asset] = by[r.asset] || []).push(r);
        for (const rs of Object.values(by)) rs.sort((x, y) => (x.time < y.time ? -1 : 1));
        return by;
      };
      const sply = await get('coinmetrics', `${CM}/timeseries/asset-metrics?assets=${cands.join(',')}&metrics=SplyCur&frequency=1d&start_time=${start}&page_size=10000&ignore_unsupported_errors=true`, {
        ttlMs: TTL.cm,
        transform: groupRows,
        asOf: none,
      });
      if (!sply.ok) return out;
      const matched = R.matchCoinMetrics(cands, subjects, sply.data);
      for (const [k, m] of Object.entries(matched)) (k.startsWith('peer:') ? out.peers : out.map)[k.startsWith('peer:') ? k.slice(5) : k] = m;
      const ids = [...new Set(Object.values(matched).map((m) => m.id))];
      if (!ids.length) return out;
      const cmAsOf = (j) => {
        const ts = (isObj(j) && Array.isArray(j.data) ? j.data : []).map((r) => Date.parse(isObj(r) ? r.time : NaN)).filter(Number.isFinite);
        return ts.length ? Math.max(...ts) + DAY * 1000 : null; // a daily row is complete at the end of its day
      };
      const pages = async (first, into) => {
        let url = first;
        for (let page = 0; url && page < 5; page++) {
          const r = await get('coinmetrics', url, { ttlMs: TTL.cm, transform: (j, ctx) => ({ next: isObj(j) ? j.next_page_url : null, by: groupRows(j, ctx), asOf: cmAsOf(j) }), asOf: (d) => d.asOf, cadenceHours: DAILY });
          if (!r.ok) break;
          for (const [id, rows] of Object.entries(r.data.by)) into[id] = (into[id] || []).concat(rows);
          const next = r.data.next;
          url = typeof next === 'string' && hostOf(next) === hostOf(CM) && next.startsWith('https://') ? next : null;
        }
      };
      // Activity metrics: the past three years. Supply: from inception, for unsuffixed ids that stand in
      // for an asset's supply (no DefiLlama chart), so a history gap is never an artefact of our window.
      const supplyIds = Object.entries(out.map).filter(([k, m]) => !m.id.includes('_') && assets.some((a) => assetId(a) === k && !(a.llamaId && chartRows[a.llamaId]))).map(([, m]) => m.id);
      await Promise.all([
        pages(`${CM}/timeseries/asset-metrics?assets=${ids.join(',')}&metrics=${CM_METRICS}&frequency=1d&start_time=${isoDay(today - 1095 * DAY)}&page_size=10000&ignore_unsupported_errors=true`, out.rows),
        supplyIds.length ? pages(`${CM}/timeseries/asset-metrics?assets=${[...new Set(supplyIds)].sort().join(',')}&metrics=SplyCur&frequency=1d&paging_from=start&page_size=10000&ignore_unsupported_errors=true`, out.supply) : null,
      ]);
      // Daily prices to value that history: coins.llama.fi serves 500 points per call, so earlier
      // windows come in fixed 500-day chunks (stable URLs; closed chunks are cached a day).
      const windowStart = endD - COINS_SPAN * DAY;
      await Promise.all(Object.entries(out.map).map(async ([k, m]) => {
        const rows = out.supply[m.id];
        const key = coinKeys[k];
        if (!Array.isArray(rows) || !rows.length || !okCoinKey(key)) return;
        const first = Date.parse(rows[0].time) / 1000;
        if (!(first < windowStart)) return;
        const span = COINS_SPAN * DAY;
        const chunks = [];
        for (let s = Math.floor(first / span) * span; s < windowStart; s += span) chunks.push(s);
        const got = await Promise.all(chunks.map((s) => get('llama-coins', `${COINS}/chart/${key}?start=${s}&span=${COINS_SPAN}&period=1d`, { ttlMs: s + span < now - DAY ? TTL.history : TTL.coins, transform: coinPrices, asOf: none })));
        dailyHist[key] = got.filter((r) => r.ok).flatMap((r) => r.data.filter((p) => p.t < windowStart));
      }));
      return out;
    }, { map: {}, peers: {}, rows: {}, supply: {} });

    // ---------- gather ----------
    const [chainTotals, onchainOut, cm, goldRefs, firstR] = await Promise.all([chainTotalsP, onchainP, cmP, goldRefsP, firstP, defiP, Promise.all(priceJobs), Promise.all(cgJobs)]);
    raw.chainTotals = chainTotals || {};
    raw.onchain = onchainOut || {};
    raw.cm = cm;
    raw.goldRefs = goldRefs || [];
    raw.hourly = hourly;
    for (const [key, pts] of Object.entries(dailyHist)) if (pts.length) dailyPx[key] = [...pts, ...(dailyPx[key] || [])];
    raw.daily = dailyPx;
    raw.first = {};
    for (const [k, v] of Object.entries((data(firstR) || {}).coins || {})) if (num(v && v.timestamp)) raw.first[k] = v.timestamp;
    raw.cgCharts = cgCharts;
    raw.cgXau = cgXau;
    raw.cgDetails = cgDetails;
    raw.cgGold = cgGoldP.done ? data(cgGoldP.value) : null;
    raw.cgPlatforms = cgPlatformsP.done ? data(cgPlatformsP.value) : null;
    raw.details = llamaDetails;
    raw.coinKeys = coinKeys;
    // Final discovery pass with everything that arrived (late CoinGecko
    // registry calls add addresses, decimals and categories).
    const final = discover(coreInputs(), reg);
    // Phase-2 results are keyed by the identity an asset had when they were
    // fetched. An early pass can split one asset (e.g. a CoinGecko row whose
    // contract addresses had not arrived yet, next to the docs entry with
    // those addresses); the final asset inherits from every early asset it
    // shares an id or a (chain, address) with.
    const addrKeys = (a) => new Set(a.addresses.map((x) => R.chainKey(x.chain) + '|' + R.normAddr(x.address)));
    const remap = { onchain: {}, cm: {}, coinKeys: {} };
    for (const b of final.assets) {
      b.id = assetId(b);
      const bk = addrKeys(b);
      const from = [b.id, ...assets.filter((a) => (a.llamaId && a.llamaId === b.llamaId) || (a.geckoId && a.geckoId === b.geckoId) || [...addrKeys(a)].some((k) => bk.has(k))).map(assetId)];
      const seen = new Set();
      for (const id of from) {
        for (const o of (raw.onchain && raw.onchain[id]) || []) {
          const k = R.chainKey(o.chain) + '|' + R.normAddr(o.address);
          if (seen.has(k)) continue;
          seen.add(k);
          (remap.onchain[b.id] = remap.onchain[b.id] || []).push(o);
        }
        if (!remap.cm[b.id] && cm && cm.map[id]) remap.cm[b.id] = cm.map[id];
        if (!remap.coinKeys[b.id] && coinKeys[id]) remap.coinKeys[b.id] = coinKeys[id];
      }
    }
    raw.onchain = remap.onchain;
    raw.coinKeys = remap.coinKeys;
    if (raw.cm) raw.cm.map = remap.cm;
    raw.registry = final;
  } catch (e) {
    errors.push('collectRaw: ' + String((e && e.message) || e).slice(0, 200));
    log('[paxos] collectRaw failed', e);
  }
  raw.elapsedMs = Date.now() - t0;
  raw.sources = c.summary(now);
  return raw;
}

// slim: the response transforms above, exported so fixture recording trims
// bodies exactly the way this module would discard them anyway (loose time check: the replay
// applies the live bounds).
const slim = {
  totals: slimTotals, charts: slimCharts, fees: slimFees, protocol: slimProtocol, detail: slimDetail, cgDetail: slimCgDetail, cgChart: slimCgChart,
  chainscout: slimChainscout, chainlist: slimChainlist, list: slimList, cgMarkets: slimCgMarkets, platforms: slimPlatforms, llamaChains: slimLlamaChains, poolRows: slimPoolRows, lendRows: slimLendRows, poolChart: slimPoolChart,
};

module.exports = { collectRaw, createClient, SOURCES, slim, keepRows };
