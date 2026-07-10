'use strict';

const config = require('../config/hyperliquid-live-strategy.json');

const API_URL = 'https://api.hyperliquid.xyz/info';
const HOUR_MS = 3_600_000;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function completedHourlyRows(rows, nowMs) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && finiteNumber(row.t) !== null && finiteNumber(row.T ?? row.t) < nowMs)
    .slice()
    .sort((a, b) => Number(a.t) - Number(b.t));
}

function validateHourlyRows(hourly, nowMs) {
  if (hourly.length < 25) return ['fewer than 25 completed hourly candles'];
  const rows = hourly.slice(-25);
  const reasons = [];
  const starts = [];
  for (const row of rows) {
    const start = finiteNumber(row.t);
    const end = finiteNumber(row.T ?? (start === null ? null : start + HOUR_MS - 1));
    const open = finiteNumber(row.o);
    const high = finiteNumber(row.h);
    const low = finiteNumber(row.l);
    const close = finiteNumber(row.c);
    const volume = finiteNumber(row.v);
    if ([start, end, open, high, low, close, volume].some((value) => value === null)) {
      reasons.push('hourly candle is malformed');
      continue;
    }
    starts.push(start);
    if (start % HOUR_MS !== 0 || end !== start + HOUR_MS - 1) {
      reasons.push('hourly candle timestamps are misaligned');
    }
    if (low <= 0 || volume < 0 || low > Math.min(open, close) || Math.max(open, close) > high) {
      reasons.push('hourly candle OHLCV is invalid');
    }
  }
  if (starts.length === 25) {
    for (let index = 1; index < starts.length; index += 1) {
      if (starts[index] !== starts[index - 1] + HOUR_MS) {
        reasons.push('hourly candles are duplicated or gapped');
        break;
      }
    }
    const expectedLatest = Math.floor(nowMs / HOUR_MS) * HOUR_MS - HOUR_MS;
    if (starts[starts.length - 1] !== expectedLatest) {
      reasons.push('latest completed hourly candle is stale');
    }
  }
  return unique(reasons);
}

function fundingForSignalCandle(rows, signalStartMs, settlementGraceMs) {
  if (!Array.isArray(rows)) return { rate: null, error: 'post-signal funding settlement is missing' };
  const settlementHourMs = signalStartMs + HOUR_MS;
  const matching = rows.filter((row) => {
    const time = finiteNumber(row && row.time);
    return time !== null && Math.floor(time / HOUR_MS) * HOUR_MS === settlementHourMs;
  });
  if (matching.length === 0) return { rate: null, error: 'post-signal funding settlement is missing' };
  if (matching.length !== 1) return { rate: null, error: 'duplicate post-signal funding settlements' };
  const timestamp = finiteNumber(matching[0].time);
  const rate = finiteNumber(matching[0].fundingRate);
  const signalEndMs = signalStartMs + HOUR_MS - 1;
  if (timestamp === null || timestamp <= signalEndMs || timestamp > signalEndMs + settlementGraceMs) {
    return { rate: null, error: 'post-signal funding settlement timestamp is not immediate' };
  }
  if (rate === null) return { rate: null, error: 'post-signal funding settlement is not finite' };
  return { rate, timestamp, error: null };
}

function topOfBook(book) {
  try {
    const bid = finiteNumber(book.levels[0][0].px);
    const ask = finiteNumber(book.levels[1][0].px);
    if (bid === null || ask === null || bid <= 0 || ask <= bid) throw new Error('invalid book');
    const midPx = (bid + ask) / 2;
    return { bidPx: bid, askPx: ask, midPx, spreadBps: ((ask - bid) / midPx) * 10_000, error: null };
  } catch (_) {
    return { bidPx: null, askPx: null, midPx: null, spreadBps: null, error: 'top of book is missing or invalid' };
  }
}

function candleDollarVolume(row) {
  return ((Number(row.o) + Number(row.h) + Number(row.l) + Number(row.c)) / 4) * Number(row.v);
}

function evaluateMarketSignal({ candleRows, fundingRows, book, nowMs = Date.now() }, strategy = config) {
  const hourly = completedHourlyRows(candleRows, nowMs);
  const validationReasons = validateHourlyRows(hourly, nowMs);
  const bookState = topOfBook(book || {});
  if (validationReasons.length) {
    return {
      dataComplete: false,
      marketRulePasses: false,
      blockers: unique([...validationReasons, bookState.error]),
      observedAt: new Date(nowMs).toISOString(),
      nextSignalCandleCloseAtMs: Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS,
      bidPx: bookState.bidPx,
      askPx: bookState.askPx,
      midPx: bookState.midPx,
      spreadBps: bookState.spreadBps
    };
  }

  const rows = hourly.slice(-25);
  const signal = rows[rows.length - 1];
  const signalStartMs = Number(signal.t);
  const signalEndMs = Number(signal.T ?? signalStartMs + HOUR_MS - 1);
  const signalClose = Number(signal.c);
  const r6 = signalClose / Number(rows[rows.length - 7].c) - 1;
  const dayVolumeUsd = rows.slice(-24).reduce((sum, row) => sum + candleDollarVolume(row), 0);
  const funding = fundingForSignalCandle(
    fundingRows,
    signalStartMs,
    strategy.schedule.fundingSettlementGraceMs
  );
  const signalAgeMs = nowMs - signalEndMs;
  const liveVsSignal = bookState.midPx !== null && signalClose > 0 ? bookState.midPx / signalClose : null;
  const rule = strategy.rule;
  const checks = [
    [!funding.error, funding.error],
    [r6 > rule.minReturnExclusive + 1e-12, `completed six-hour return is not above ${(rule.minReturnExclusive * 100).toFixed(0)}%`],
    [funding.rate !== null && funding.rate >= rule.minFundingRate, `post-signal funding settlement is below ${(rule.minFundingRate * 10_000).toFixed(1)} bps`],
    [dayVolumeUsd >= rule.minDayVolumeUsd, `trailing dollar volume is below $${(rule.minDayVolumeUsd / 1_000_000).toFixed(0)}m`],
    [bookState.error === null, bookState.error],
    [bookState.spreadBps !== null && bookState.spreadBps <= rule.maxSpreadBps, `top spread exceeds ${rule.maxSpreadBps} bps`],
    [signalAgeMs >= 0 && signalAgeMs <= rule.maxSignalAgeMs, 'completed signal candle is stale'],
    [
      liveVsSignal !== null && liveVsSignal >= rule.minLiveVsSignal && liveVsSignal <= rule.maxLiveVsSignal,
      'live price moved outside the frozen entry band'
    ]
  ];
  const blockers = unique(checks.filter(([passed]) => !passed).map(([, reason]) => reason));
  const strong = r6 > strategy.risk.strongReturnExclusive + 1e-12;
  return {
    dataComplete: !funding.error && !bookState.error,
    marketRulePasses: blockers.length === 0,
    blockers,
    observedAt: new Date(nowMs).toISOString(),
    signalCandleStartMs: signalStartMs,
    signalCandleEndMs: signalEndMs,
    nextSignalCandleCloseAtMs: Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS,
    signalClose,
    r6,
    r6Pct: r6 * 100,
    fundingRate: funding.rate,
    fundingBps: funding.rate === null ? null : funding.rate * 10_000,
    dayVolumeUsd,
    bidPx: bookState.bidPx,
    askPx: bookState.askPx,
    midPx: bookState.midPx,
    spreadBps: bookState.spreadBps,
    liveVsSignal,
    signalAgeMs,
    riskTier: strong ? 'strong_r6' : 'base',
    maxAccountRiskFraction: strong
      ? strategy.risk.strongAccountRiskFraction
      : strategy.risk.baseAccountRiskFraction
  };
}

async function hyperliquidInfo(body, fetchImpl = global.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Hyperliquid ${body.type} returned HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function publicPosition(row) {
  const p = row && row.position ? row.position : row;
  if (!p || typeof p !== 'object') return null;
  return {
    coin: String(p.coin || ''),
    szi: finiteNumber(p.szi),
    entryPx: finiteNumber(p.entryPx),
    positionValue: finiteNumber(p.positionValue),
    unrealizedPnl: finiteNumber(p.unrealizedPnl),
    marginUsed: finiteNumber(p.marginUsed),
    liquidationPx: finiteNumber(p.liquidationPx),
    leverage: p.leverage && typeof p.leverage === 'object' ? p.leverage : null
  };
}

function publicOrder(order) {
  if (!order || typeof order !== 'object') return null;
  return {
    coin: String(order.coin || ''),
    side: String(order.side || ''),
    limitPx: finiteNumber(order.limitPx),
    sz: finiteNumber(order.sz),
    oid: order.oid ?? null,
    timestamp: finiteNumber(order.timestamp),
    triggerPx: finiteNumber(order.triggerPx),
    triggerCondition: order.triggerCondition ?? null,
    reduceOnly: Boolean(order.reduceOnly),
    isTrigger: Boolean(order.isTrigger),
    orderType: order.orderType ?? null
  };
}

function flattenOrders(rows) {
  const flattened = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const children = Array.isArray(row.children) ? row.children : [];
    if (!children.length || row.cloid) flattened.push(row);
    if (children.length) flattened.push(...flattenOrders(children));
  }
  return flattened;
}

function evaluateProtection(positions, orders, symbol = config.symbol) {
  const activePositions = (Array.isArray(positions) ? positions : [])
    .filter((position) => position && Math.abs(Number(position.szi) || 0) > 0);
  const symbolPositions = activePositions.filter((position) => String(position.coin || '').toUpperCase() === symbol.toUpperCase());
  const symbolOrders = (Array.isArray(orders) ? orders : [])
    .filter((order) => order && String(order.coin || '').toUpperCase() === symbol.toUpperCase());
  if (activePositions.length === 0) {
    const blockers = symbolOrders.length
      ? [`found ${symbolOrders.length} ${symbol} order(s) while the account is flat`]
      : [];
    return {
      status: blockers.length ? 'unprotected' : 'not_required',
      protected: blockers.length ? false : null,
      blockers,
      symbol,
      positionSize: null,
      protectionOrderCount: symbolOrders.length
    };
  }

  const blockers = [];
  if (activePositions.length !== 1 || symbolPositions.length !== 1) {
    blockers.push(`expected exactly one open ${symbol} position and no other positions`);
  }
  if (symbolOrders.length !== 2) blockers.push(`expected exactly two ${symbol} protection orders`);
  const position = symbolPositions.length === 1 ? symbolPositions[0] : null;
  if (position) {
    const size = Math.abs(Number(position.szi));
    const oppositeSide = Number(position.szi) < 0 ? 'B' : 'A';
    const tolerance = Math.max(1e-9, size * 1e-6);
    const matchingOrders = symbolOrders.filter((order) => (
      order.reduceOnly === true
      && order.isTrigger === true
      && String(order.side || '').toUpperCase() === oppositeSide
      && Number.isFinite(Number(order.sz))
      && Math.abs(Number(order.sz) - size) <= tolerance
    ));
    if (matchingOrders.length !== 2) blockers.push('protection orders must be opposite-side, reduce-only triggers matching the full position size');
    const types = matchingOrders.map((order) => String(order.orderType || '').toLowerCase());
    if (types.filter((value) => value.includes('take profit')).length !== 1) blockers.push('exactly one take-profit trigger is required');
    if (types.filter((value) => value.includes('stop')).length !== 1) blockers.push('exactly one stop trigger is required');
  }
  return {
    status: blockers.length ? 'unprotected' : 'protected',
    protected: blockers.length === 0,
    blockers: unique(blockers),
    symbol,
    positionSize: position ? Math.abs(Number(position.szi)) : null,
    protectionOrderCount: symbolOrders.length
  };
}

function publicFill(fill) {
  if (!fill || typeof fill !== 'object') return null;
  return {
    time: finiteNumber(fill.time),
    coin: String(fill.coin || ''),
    side: String(fill.side || ''),
    dir: String(fill.dir || ''),
    px: finiteNumber(fill.px),
    sz: finiteNumber(fill.sz),
    closedPnl: finiteNumber(fill.closedPnl),
    fee: finiteNumber(fill.fee),
    crossed: Boolean(fill.crossed)
  };
}

function cleanPortfolio(portfolio) {
  if (!Array.isArray(portfolio)) return [];
  return portfolio.map((entry) => {
    if (!Array.isArray(entry) || !entry[1] || typeof entry[1] !== 'object') return null;
    const cleanHistory = (history) => (Array.isArray(history) ? history : [])
      .map((point) => Array.isArray(point) ? [finiteNumber(point[0]), finiteNumber(point[1])] : null)
      .filter((point) => point && point[0] !== null && point[1] !== null);
    return [String(entry[0]), {
      accountValueHistory: cleanHistory(entry[1].accountValueHistory),
      pnlHistory: cleanHistory(entry[1].pnlHistory),
      vlm: finiteNumber(entry[1].vlm)
    }];
  }).filter(Boolean);
}

async function buildPublicStatus({ nowMs = Date.now(), fetchImpl = global.fetch } = {}) {
  const startTime = nowMs - 9 * 24 * HOUR_MS;
  const fundingStartTime = nowMs - 36 * HOUR_MS;
  const user = config.accountAddress;
  const requests = {
    clearinghouse: { type: 'clearinghouseState', user },
    orders: { type: 'frontendOpenOrders', user },
    portfolio: { type: 'portfolio', user },
    fills: { type: 'userFills', user },
    candles: { type: 'candleSnapshot', req: { coin: config.symbol, interval: '1h', startTime, endTime: nowMs } },
    funding: { type: 'fundingHistory', coin: config.symbol, startTime: fundingStartTime, endTime: nowMs },
    book: { type: 'l2Book', coin: config.symbol }
  };
  const names = Object.keys(requests);
  const settled = await Promise.allSettled(names.map((name) => hyperliquidInfo(requests[name], fetchImpl)));
  const data = {};
  const sourceErrors = {};
  settled.forEach((result, index) => {
    const name = names[index];
    if (result.status === 'fulfilled') data[name] = result.value;
    else sourceErrors[name] = result.reason instanceof Error ? result.reason.message : String(result.reason);
  });
  if (!data.clearinghouse || !Array.isArray(data.orders)) {
    throw new Error('required public account state is unavailable');
  }

  const signal = evaluateMarketSignal({
    candleRows: data.candles,
    fundingRows: data.funding,
    book: data.book,
    nowMs
  });
  for (const name of ['candles', 'funding', 'book']) {
    if (sourceErrors[name]) signal.blockers = unique([...(signal.blockers || []), `${name} source unavailable`]);
  }
  signal.marketRulePasses = signal.blockers.length === 0;
  signal.dataComplete = signal.dataComplete && !sourceErrors.candles && !sourceErrors.funding && !sourceErrors.book;

  const margin = data.clearinghouse.marginSummary || {};
  if (finiteNumber(margin.accountValue) === null || !Array.isArray(data.clearinghouse.assetPositions)) {
    throw new Error('required public account state is malformed');
  }
  const positions = data.clearinghouse.assetPositions
    .map(publicPosition)
    .filter((position) => position && position.szi !== null && Math.abs(position.szi) > 0);
  const openOrders = flattenOrders(data.orders).map(publicOrder).filter(Boolean);
  const protection = evaluateProtection(positions, openOrders);
  const accountBlockers = [];
  if (positions.length) accountBlockers.push('account already has exposure');
  if (openOrders.length) accountBlockers.push('account already has open orders');

  return {
    schemaVersion: config.schemaVersion,
    generatedAt: new Date(nowMs).toISOString(),
    strategy: config,
    account: {
      address: user,
      accountValueUsd: finiteNumber(margin.accountValue),
      withdrawableUsd: finiteNumber(data.clearinghouse.withdrawable),
      totalMarginUsedUsd: finiteNumber(margin.totalMarginUsed),
      totalNotionalUsd: finiteNumber(margin.totalNtlPos),
      positions,
      openOrders,
      accountGatePasses: accountBlockers.length === 0,
      blockers: accountBlockers,
      portfolio: cleanPortfolio(data.portfolio),
      fills: (Array.isArray(data.fills) ? data.fills : []).map(publicFill).filter(Boolean).sort((a, b) => b.time - a.time).slice(0, 250)
    },
    signal: {
      ...signal,
      executionEligibility: null,
      executionEligibilityReason: 'local attempt, cooldown, lock, and process state are not externally observable'
    },
    protection,
    services: {
      executor: 'not_publicly_observable',
      timedExit: 'not_publicly_observable',
      researchMonitor: 'not_publicly_observable'
    },
    status: {
      observerScope: 'public_exchange_only',
      localDaemonHealth: 'not_publicly_observable',
      note: 'Public exchange freshness does not prove local executor or supervisor health.'
    },
    sources: {
      hyperliquidPublicApi: Object.keys(sourceErrors).length ? 'partial' : 'ok',
      errors: sourceErrors
    }
  };
}

module.exports = {
  API_URL,
  HOUR_MS,
  config,
  completedHourlyRows,
  validateHourlyRows,
  fundingForSignalCandle,
  topOfBook,
  flattenOrders,
  evaluateProtection,
  evaluateMarketSignal,
  buildPublicStatus
};
