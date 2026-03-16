#!/usr/bin/env node
// Runs during Vercel build (or locally) to fetch Dune data and write static JSON.
// Usage: DUNE_API_KEY=xxx node scripts/fetch-dune.js
//
// Optimized for Dune free-tier quota:
// - evm_summary + evm_whales merged into one query (one full-history scan instead of two)
// - Daily windows cut from 90d → 30d
// - performance: 'low' to use fewer credits
// - Priority ordering: critical queries run first, degrade gracefully on quota

const fs = require('fs');
const path = require('path');

const DUNE_API_KEY = process.env.DUNE_API_KEY;
if (!DUNE_API_KEY) { console.log('No DUNE_API_KEY, skipping Dune fetch'); process.exit(0); }

// Queries ordered by priority (most important first).
// If quota runs out, later queries preserve existing cached data.
const QUERIES = {
  // ── Combined summary + whales (single full-history scan) ──
  // Returns two result types: summary rows (rank IS NULL) and whale rows (rank IS NOT NULL)
  evm_combined: `
    WITH raw AS (
      SELECT 'ethereum' as chain,
        CASE WHEN contract_address = 0xe343167631d89b6ffc58b88d6b7fb0228795491d THEN 'USDG' ELSE 'PYUSD' END as token,
        "from", "to", CAST(value AS DOUBLE) as value, evt_block_time
      FROM erc20_ethereum.evt_Transfer
      WHERE contract_address IN (0xe343167631d89b6ffc58b88d6b7fb0228795491d, 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8)
      UNION ALL
      SELECT 'ink', 'USDG', "from", "to", CAST(value AS DOUBLE), evt_block_time
      FROM erc20_ink.evt_Transfer WHERE contract_address = 0xe343167631d89b6ffc58b88d6b7fb0228795491d
      UNION ALL
      SELECT 'xlayer', 'USDG', "from", "to", CAST(value AS DOUBLE), evt_block_time
      FROM erc20_xlayer.evt_Transfer WHERE contract_address = 0x4ae46a509f6b1d9056937ba4500cb143933d2dc8
      UNION ALL
      SELECT 'arbitrum', 'PYUSD', "from", "to", CAST(value AS DOUBLE), evt_block_time
      FROM erc20_arbitrum.evt_Transfer WHERE contract_address = 0x46850ad61c2b7d64d08c9c754f45254596696984
    ),
    balances AS (
      SELECT chain, token, address, SUM(amt) as bal FROM (
        SELECT chain, token, "to" as address, value as amt FROM raw
        UNION ALL
        SELECT chain, token, "from" as address, -value as amt FROM raw
      ) GROUP BY 1,2,3 HAVING SUM(amt) > 0
    ),
    holder_counts AS (SELECT chain, token, COUNT(*) as holders FROM balances GROUP BY 1,2),
    a7 AS (
      SELECT chain, token,
        COUNT(DISTINCT "from")+COUNT(DISTINCT "to") as active_7d,
        COUNT(*) as transfers_7d, SUM(value/1e6) as volume_7d
      FROM raw WHERE evt_block_time > NOW()-INTERVAL '7' DAY GROUP BY 1,2
    ),
    a30 AS (
      SELECT chain, token,
        COUNT(DISTINCT "from")+COUNT(DISTINCT "to") as active_30d,
        COUNT(*) as transfers_30d, SUM(value/1e6) as volume_30d
      FROM raw WHERE evt_block_time > NOW()-INTERVAL '30' DAY GROUP BY 1,2
    ),
    summary AS (
      SELECT h.token, h.chain, h.holders,
        COALESCE(a7.active_7d,0) as active_7d, COALESCE(a7.transfers_7d,0) as transfers_7d, COALESCE(a7.volume_7d,0) as volume_7d,
        COALESCE(a30.active_30d,0) as active_30d, COALESCE(a30.transfers_30d,0) as transfers_30d, COALESCE(a30.volume_30d,0) as volume_30d,
        CAST(NULL AS VARCHAR) as address, CAST(NULL AS DOUBLE) as balance, CAST(NULL AS DOUBLE) as pct, CAST(NULL AS BIGINT) as rank
      FROM holder_counts h
      LEFT JOIN a7 ON h.chain=a7.chain AND h.token=a7.token
      LEFT JOIN a30 ON h.chain=a30.chain AND h.token=a30.token
    ),
    totals AS (SELECT chain, token, SUM(bal)/1e6 as total FROM balances GROUP BY 1,2),
    ranked AS (
      SELECT b.chain, b.token, b.address, b.bal/1e6 as balance,
        (b.bal/1e6)/t.total*100 as pct,
        ROW_NUMBER() OVER (PARTITION BY b.chain, b.token ORDER BY b.bal DESC) as rn
      FROM balances b JOIN totals t ON b.chain=t.chain AND b.token=t.token
    ),
    whales AS (
      SELECT token, chain,
        CAST(NULL AS BIGINT) as holders,
        CAST(NULL AS BIGINT) as active_7d, CAST(NULL AS BIGINT) as transfers_7d, CAST(NULL AS DOUBLE) as volume_7d,
        CAST(NULL AS BIGINT) as active_30d, CAST(NULL AS BIGINT) as transfers_30d, CAST(NULL AS DOUBLE) as volume_30d,
        CAST(address AS VARCHAR) as address, balance, pct, rn as rank
      FROM ranked WHERE rn <= 10
    )
    SELECT * FROM summary
    UNION ALL
    SELECT * FROM whales
    ORDER BY rank NULLS FIRST
  `,

  // ── EVM daily (30d instead of 90d) ──
  evm_daily: `
    SELECT token, chain, DATE_TRUNC('day', evt_block_time) as day,
      COUNT(*) as transfers, COUNT(DISTINCT "from") as unique_senders, SUM(value/1e6) as volume_m
    FROM (
      SELECT 'ethereum' as chain,
        CASE WHEN contract_address = 0xe343167631d89b6ffc58b88d6b7fb0228795491d THEN 'USDG' ELSE 'PYUSD' END as token,
        "from", CAST(value AS DOUBLE) as value, evt_block_time
      FROM erc20_ethereum.evt_Transfer
      WHERE contract_address IN (0xe343167631d89b6ffc58b88d6b7fb0228795491d, 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8)
        AND evt_block_time > NOW()-INTERVAL '30' DAY
      UNION ALL
      SELECT 'ink', 'USDG', "from", CAST(value AS DOUBLE), evt_block_time
      FROM erc20_ink.evt_Transfer
      WHERE contract_address = 0xe343167631d89b6ffc58b88d6b7fb0228795491d AND evt_block_time > NOW()-INTERVAL '30' DAY
      UNION ALL
      SELECT 'xlayer', 'USDG', "from", CAST(value AS DOUBLE), evt_block_time
      FROM erc20_xlayer.evt_Transfer
      WHERE contract_address = 0x4ae46a509f6b1d9056937ba4500cb143933d2dc8 AND evt_block_time > NOW()-INTERVAL '30' DAY
      UNION ALL
      SELECT 'arbitrum', 'PYUSD', "from", CAST(value AS DOUBLE), evt_block_time
      FROM erc20_arbitrum.evt_Transfer
      WHERE contract_address = 0x46850ad61c2b7d64d08c9c754f45254596696984 AND evt_block_time > NOW()-INTERVAL '30' DAY
    ) GROUP BY 1,2,3 ORDER BY 1,3
  `,

  // ── Solana summary ──
  sol_summary: `
    WITH usdg AS (
      SELECT block_time, from_token_account, to_token_account, amount
      FROM tokens_solana.transfers
      WHERE token_mint_address='2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH' AND block_time>NOW()-INTERVAL '30' DAY
    ),
    pyusd AS (
      SELECT block_time, from_token_account, to_token_account, amount
      FROM tokens_solana.transfers
      WHERE token_mint_address='2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' AND block_time>NOW()-INTERVAL '30' DAY
    )
    SELECT 'USDG' as token, 'solana' as chain,
      (SELECT COUNT(DISTINCT from_token_account)+COUNT(DISTINCT to_token_account) FROM usdg WHERE block_time>NOW()-INTERVAL '7' DAY) as active_7d,
      (SELECT COUNT(*) FROM usdg WHERE block_time>NOW()-INTERVAL '7' DAY) as transfers_7d,
      (SELECT COALESCE(SUM(amount),0)/1e6 FROM usdg WHERE block_time>NOW()-INTERVAL '7' DAY) as volume_7d,
      (SELECT COUNT(DISTINCT from_token_account)+COUNT(DISTINCT to_token_account) FROM usdg) as active_30d,
      (SELECT COUNT(*) FROM usdg) as transfers_30d,
      (SELECT COALESCE(SUM(amount),0)/1e6 FROM usdg) as volume_30d
    UNION ALL
    SELECT 'PYUSD', 'solana',
      (SELECT COUNT(DISTINCT from_token_account)+COUNT(DISTINCT to_token_account) FROM pyusd WHERE block_time>NOW()-INTERVAL '7' DAY),
      (SELECT COUNT(*) FROM pyusd WHERE block_time>NOW()-INTERVAL '7' DAY),
      (SELECT COALESCE(SUM(amount),0)/1e6 FROM pyusd WHERE block_time>NOW()-INTERVAL '7' DAY),
      (SELECT COUNT(DISTINCT from_token_account)+COUNT(DISTINCT to_token_account) FROM pyusd),
      (SELECT COUNT(*) FROM pyusd),
      (SELECT COALESCE(SUM(amount),0)/1e6 FROM pyusd)
  `,

  // ── Solana daily (30d instead of 90d) ──
  sol_daily: `
    SELECT token, 'solana' as chain, DATE_TRUNC('day', block_time) as day,
      COUNT(*) as transfers, COUNT(DISTINCT from_token_account) as unique_senders, SUM(amount)/1e6 as volume_m
    FROM (
      SELECT 'USDG' as token, block_time, from_token_account, amount
      FROM tokens_solana.transfers
      WHERE token_mint_address='2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH' AND block_time>NOW()-INTERVAL '30' DAY
      UNION ALL
      SELECT 'PYUSD', block_time, from_token_account, amount
      FROM tokens_solana.transfers
      WHERE token_mint_address='2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' AND block_time>NOW()-INTERVAL '30' DAY
    ) GROUP BY 1,2,3 ORDER BY 1,3
  `,

  // ── DEX volume (lowest priority — most likely to get cut by quota) ──
  dex_volume: `
    SELECT CASE WHEN token_bought_address=0xe343167631d89b6ffc58b88d6b7fb0228795491d
                  OR token_sold_address=0xe343167631d89b6ffc58b88d6b7fb0228795491d THEN 'USDG' ELSE 'PYUSD' END as token,
      project, token_pair, SUM(amount_usd) as volume_30d, COUNT(*) as trades
    FROM dex.trades WHERE block_time>NOW()-INTERVAL '30' DAY
      AND (token_bought_address IN (0xe343167631d89b6ffc58b88d6b7fb0228795491d, 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8)
        OR token_sold_address IN (0xe343167631d89b6ffc58b88d6b7fb0228795491d, 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8))
    GROUP BY 1,2,3 ORDER BY volume_30d DESC LIMIT 20
  `,
};

async function executeDuneQuery(sql) {
  const res = await fetch('https://api.dune.com/api/v1/sql/execute', {
    method: 'POST',
    headers: { 'X-Dune-Api-Key': DUNE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, performance: 'medium' }),
  });
  const data = await res.json();
  if (!data.execution_id) throw new Error(JSON.stringify(data.error || data));
  return data.execution_id;
}

async function pollResults(executionId, maxWaitMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`https://api.dune.com/api/v1/execution/${executionId}/results`, {
      headers: { 'X-Dune-Api-Key': DUNE_API_KEY },
    });
    const data = await res.json();
    if (data.state === 'QUERY_STATE_COMPLETED' && data.result) return data.result.rows;
    if (data.state === 'QUERY_STATE_FAILED') throw new Error(JSON.stringify(data.error));
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Query timed out after ' + (maxWaitMs/1000) + 's');
}

function loadExisting() {
  for (const dir of ['dist', 'static']) {
    const p = path.join(__dirname, '..', dir, 'data', 'dune.json');
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch {}
    }
  }
  return null;
}

// Split the combined query results back into evm_summary and evm_whales
// for backward-compatibility with the frontend.
function splitCombined(rows) {
  const summary = [];
  const whales = [];
  for (const row of rows) {
    if (row.rank == null) {
      // Summary row — strip whale-only fields
      const { address, balance, pct, rank, ...rest } = row;
      summary.push(rest);
    } else {
      // Whale row — strip summary-only fields
      const { holders, active_7d, transfers_7d, volume_7d, active_30d, transfers_30d, volume_30d, ...rest } = row;
      whales.push(rest);
    }
  }
  return { evm_summary: summary, evm_whales: whales };
}

async function main() {
  // Check if existing data is fresh (<24h old)
  const existing = loadExisting();
  if (existing && existing.updated) {
    const age = Date.now() - new Date(existing.updated).getTime();
    const hours = age / (1000 * 60 * 60);
    if (hours < 24) {
      console.log(`Dune data is fresh (${hours.toFixed(1)}h old, <24h), skipping fetch`);
      process.exit(0);
    }
    console.log(`Dune data is ${hours.toFixed(1)}h old, refreshing...`);
  }

  console.log('Fetching Dune data...');
  const existingData = (existing && existing.data) || {};
  const results = {};
  let quotaExhausted = false;

  // Execute queries sequentially by priority (stop submitting on quota hit)
  for (const [name, sql] of Object.entries(QUERIES)) {
    if (quotaExhausted) {
      console.log(`  Skipping ${name} (quota exhausted), preserving existing data`);
      // Preserve existing data for this key
      if (name === 'evm_combined') {
        // Preserve the split keys
        if (Array.isArray(existingData.evm_summary)) results.evm_summary = existingData.evm_summary;
        if (Array.isArray(existingData.evm_whales)) results.evm_whales = existingData.evm_whales;
      } else if (Array.isArray(existingData[name])) {
        results[name] = existingData[name];
      }
      continue;
    }

    try {
      const clean = sql.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      const id = await executeDuneQuery(clean);
      console.log(`  Submitted: ${name} -> ${id}`);

      const rows = await pollResults(id);

      if (name === 'evm_combined') {
        const { evm_summary, evm_whales } = splitCombined(rows);
        results.evm_summary = evm_summary;
        results.evm_whales = evm_whales;
        console.log(`  Completed: ${name} (${evm_summary.length} summary + ${evm_whales.length} whale rows)`);
      } else {
        results[name] = rows;
        console.log(`  Completed: ${name} (${rows.length} rows)`);
      }
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('exceed your configured datapoint limit') || msg.includes('Query limit')) {
        console.warn(`  Quota exceeded on ${name}, stopping new queries`);
        quotaExhausted = true;
      } else {
        console.error(`  Failed ${name}: ${msg}`);
      }
      // Preserve existing data
      if (name === 'evm_combined') {
        if (Array.isArray(existingData.evm_summary)) results.evm_summary = existingData.evm_summary;
        if (Array.isArray(existingData.evm_whales)) results.evm_whales = existingData.evm_whales;
      } else if (Array.isArray(existingData[name])) {
        console.log(`    Preserving existing data for ${name}`);
        results[name] = existingData[name];
      } else {
        results[name] = { error: msg };
      }
    }
    // Delay between queries to be nice to the API
    await new Promise(r => setTimeout(r, 500));
  }

  // Only update timestamp if we actually fetched fresh data
  const freshKeys = Object.keys(results).filter(k =>
    Array.isArray(results[k]) && !Object.values(existingData).includes(results[k])
  );
  const updated = freshKeys.length > 0 ? new Date().toISOString() : (existing && existing.updated) || new Date().toISOString();
  const output = { updated, data: results };
  console.log(`  Fresh queries: ${freshKeys.length} (${freshKeys.join(', ') || 'none'}), timestamp: ${freshKeys.length > 0 ? 'updated' : 'preserved'}`);

  // Write to dist/ (for Vercel build) and static/ (for local dev)
  for (const dir of ['dist', 'static']) {
    const outDir = path.join(__dirname, '..', dir, 'data');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'dune.json');
    fs.writeFileSync(outPath, JSON.stringify(output));
    console.log(`Wrote ${outPath} (${(JSON.stringify(output).length / 1024).toFixed(1)}KB)`);
  }

  const ok = Object.keys(results).filter(k => Array.isArray(results[k])).length;
  const fail = Object.keys(results).filter(k => results[k]?.error).length;
  console.log(`Done: ${ok} data keys succeeded, ${fail} failed${quotaExhausted ? ' (quota hit, graceful degradation)' : ''}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
