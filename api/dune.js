// Vercel serverless function: on-chain metrics from Dune Analytics
// Both USDG and PYUSD on Ethereum + Solana. Cached 1hr via edge.

const DUNE_API_KEY = process.env.DUNE_API_KEY;

// Contract addresses
// USDG Ethereum: 0xe343167631d89b6ffc58b88d6b7fb0228795491d
// USDG Solana:   2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH
// PYUSD Ethereum: 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8
// PYUSD Solana:   2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo

const QUERIES = {
  // Ethereum: holders + activity for BOTH tokens
  eth_summary: `
    WITH balances AS (
      SELECT "to" as address, CAST(value AS DOUBLE) as amount, contract_address FROM erc20_ethereum.evt_Transfer
        WHERE contract_address IN (0xe343167631d89b6ffc58b88d6b7fb0228795491d, 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8)
      UNION ALL
      SELECT "from" as address, -CAST(value AS DOUBLE) as amount, contract_address FROM erc20_ethereum.evt_Transfer
        WHERE contract_address IN (0xe343167631d89b6ffc58b88d6b7fb0228795491d, 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8)
    ),
    holders AS (
      SELECT contract_address, COUNT(DISTINCT address) as holders
      FROM (SELECT contract_address, address, SUM(amount) as bal FROM balances GROUP BY 1, 2 HAVING SUM(amount) > 0)
      GROUP BY 1
    ),
    active_7d AS (
      SELECT contract_address,
             COUNT(DISTINCT "from") + COUNT(DISTINCT "to") as active_7d,
             COUNT(*) as transfers_7d,
             SUM(CAST(value AS DOUBLE) / 1e6) as volume_7d
      FROM erc20_ethereum.evt_Transfer
      WHERE contract_address IN (0xe343167631d89b6ffc58b88d6b7fb0228795491d, 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8)
        AND evt_block_time > NOW() - INTERVAL '7' DAY
      GROUP BY 1
    ),
    active_30d AS (
      SELECT contract_address,
             COUNT(DISTINCT "from") + COUNT(DISTINCT "to") as active_30d,
             COUNT(*) as transfers_30d,
             SUM(CAST(value AS DOUBLE) / 1e6) as volume_30d
      FROM erc20_ethereum.evt_Transfer
      WHERE contract_address IN (0xe343167631d89b6ffc58b88d6b7fb0228795491d, 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8)
        AND evt_block_time > NOW() - INTERVAL '30' DAY
      GROUP BY 1
    )
    SELECT CASE WHEN h.contract_address = 0xe343167631d89b6ffc58b88d6b7fb0228795491d THEN 'USDG' ELSE 'PYUSD' END as token,
           'ethereum' as chain,
           h.holders,
           COALESCE(a7.active_7d, 0) as active_7d, COALESCE(a7.transfers_7d, 0) as transfers_7d, COALESCE(a7.volume_7d, 0) as volume_7d,
           COALESCE(a30.active_30d, 0) as active_30d, COALESCE(a30.transfers_30d, 0) as transfers_30d, COALESCE(a30.volume_30d, 0) as volume_30d
    FROM holders h
    LEFT JOIN active_7d a7 ON h.contract_address = a7.contract_address
    LEFT JOIN active_30d a30 ON h.contract_address = a30.contract_address
  `,

  // Ethereum: top 20 holders for BOTH tokens
  eth_whales: `
    WITH balances AS (
      SELECT contract_address, address, SUM(amount) / 1e6 as balance FROM (
        SELECT contract_address, "to" as address, CAST(value AS DOUBLE) as amount FROM erc20_ethereum.evt_Transfer
          WHERE contract_address IN (0xe343167631d89b6ffc58b88d6b7fb0228795491d, 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8)
        UNION ALL
        SELECT contract_address, "from" as address, -CAST(value AS DOUBLE) as amount FROM erc20_ethereum.evt_Transfer
          WHERE contract_address IN (0xe343167631d89b6ffc58b88d6b7fb0228795491d, 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8)
      ) GROUP BY 1, 2 HAVING SUM(amount) > 0
    ),
    totals AS (SELECT contract_address, SUM(balance) as total FROM balances GROUP BY 1),
    ranked AS (
      SELECT b.contract_address, b.address, b.balance,
             b.balance / t.total * 100 as pct,
             ROW_NUMBER() OVER (PARTITION BY b.contract_address ORDER BY b.balance DESC) as rn
      FROM balances b JOIN totals t ON b.contract_address = t.contract_address
    )
    SELECT CASE WHEN contract_address = 0xe343167631d89b6ffc58b88d6b7fb0228795491d THEN 'USDG' ELSE 'PYUSD' END as token,
           address, balance, pct, rn as rank
    FROM ranked WHERE rn <= 20
    ORDER BY token, rn
  `,

  // Ethereum: daily volume for BOTH tokens (90d)
  eth_daily: `
    SELECT CASE WHEN contract_address = 0xe343167631d89b6ffc58b88d6b7fb0228795491d THEN 'USDG' ELSE 'PYUSD' END as token,
           DATE_TRUNC('day', evt_block_time) as day,
           COUNT(*) as transfers,
           COUNT(DISTINCT "from") as unique_senders,
           SUM(CAST(value AS DOUBLE)) / 1e6 as volume_m
    FROM erc20_ethereum.evt_Transfer
    WHERE contract_address IN (0xe343167631d89b6ffc58b88d6b7fb0228795491d, 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8)
      AND evt_block_time > NOW() - INTERVAL '90' DAY
    GROUP BY 1, 2 ORDER BY 1, 2
  `,

  // DEX volume for BOTH tokens
  dex_volume: `
    SELECT CASE
      WHEN token_bought_address IN (0xe343167631d89b6ffc58b88d6b7fb0228795491d)
        OR token_sold_address IN (0xe343167631d89b6ffc58b88d6b7fb0228795491d) THEN 'USDG'
      ELSE 'PYUSD' END as token,
      project, token_pair,
      SUM(amount_usd) as volume_30d, COUNT(*) as trades
    FROM dex.trades
    WHERE block_time > NOW() - INTERVAL '30' DAY
      AND (token_bought_address IN (0xe343167631d89b6ffc58b88d6b7fb0228795491d, 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8)
        OR token_sold_address IN (0xe343167631d89b6ffc58b88d6b7fb0228795491d, 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8))
    GROUP BY 1, 2, 3 ORDER BY volume_30d DESC LIMIT 30
  `,

  // Solana: USDG activity
  usdg_sol: `
    WITH transfers AS (
      SELECT block_time, from_token_account, to_token_account, amount
      FROM tokens_solana.transfers
      WHERE token_mint_address = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'
        AND block_time > NOW() - INTERVAL '30' DAY
    )
    SELECT 'USDG' as token, 'solana' as chain,
      (SELECT COUNT(DISTINCT from_token_account) + COUNT(DISTINCT to_token_account) FROM transfers WHERE block_time > NOW() - INTERVAL '7' DAY) as active_7d,
      (SELECT COUNT(*) FROM transfers WHERE block_time > NOW() - INTERVAL '7' DAY) as transfers_7d,
      (SELECT SUM(amount) / 1e6 FROM transfers WHERE block_time > NOW() - INTERVAL '7' DAY) as volume_7d,
      COUNT(DISTINCT from_token_account) + COUNT(DISTINCT to_token_account) as active_30d,
      COUNT(*) as transfers_30d,
      SUM(amount) / 1e6 as volume_30d
    FROM transfers
  `,

  // Solana: PYUSD activity
  pyusd_sol: `
    WITH transfers AS (
      SELECT block_time, from_token_account, to_token_account, amount
      FROM tokens_solana.transfers
      WHERE token_mint_address = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
        AND block_time > NOW() - INTERVAL '30' DAY
    )
    SELECT 'PYUSD' as token, 'solana' as chain,
      (SELECT COUNT(DISTINCT from_token_account) + COUNT(DISTINCT to_token_account) FROM transfers WHERE block_time > NOW() - INTERVAL '7' DAY) as active_7d,
      (SELECT COUNT(*) FROM transfers WHERE block_time > NOW() - INTERVAL '7' DAY) as transfers_7d,
      (SELECT SUM(amount) / 1e6 FROM transfers WHERE block_time > NOW() - INTERVAL '7' DAY) as volume_7d,
      COUNT(DISTINCT from_token_account) + COUNT(DISTINCT to_token_account) as active_30d,
      COUNT(*) as transfers_30d,
      SUM(amount) / 1e6 as volume_30d
    FROM transfers
  `,

  // Solana: daily volume for BOTH tokens (90d)
  sol_daily: `
    SELECT CASE WHEN token_mint_address = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH' THEN 'USDG' ELSE 'PYUSD' END as token,
           DATE_TRUNC('day', block_time) as day,
           COUNT(*) as transfers,
           COUNT(DISTINCT from_token_account) as unique_senders,
           SUM(amount) / 1e6 as volume_m
    FROM tokens_solana.transfers
    WHERE token_mint_address IN ('2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo')
      AND block_time > NOW() - INTERVAL '90' DAY
    GROUP BY 1, 2 ORDER BY 1, 2
  `,
};

async function executeDuneQuery(sql) {
  const res = await fetch('https://api.dune.com/api/v1/sql/execute', {
    method: 'POST',
    headers: { 'X-Dune-Api-Key': DUNE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, performance: 'medium' }),
  });
  const data = await res.json();
  if (!data.execution_id) throw new Error('No execution_id: ' + JSON.stringify(data));
  return data.execution_id;
}

async function pollResults(executionId, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`https://api.dune.com/api/v1/execution/${executionId}/results`, {
      headers: { 'X-Dune-Api-Key': DUNE_API_KEY },
    });
    const data = await res.json();
    if (data.state === 'QUERY_STATE_COMPLETED' && data.result) return data.result.rows;
    if (data.state === 'QUERY_STATE_FAILED') throw new Error('Query failed: ' + JSON.stringify(data.error));
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Query timed out');
}

module.exports = async function handler(req, res) {
  if (!DUNE_API_KEY) return res.status(500).json({ error: 'Missing DUNE_API_KEY env var' });

  try {
    const entries = Object.entries(QUERIES);
    const executionIds = await Promise.all(
      entries.map(([name, sql]) =>
        executeDuneQuery(sql.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim())
          .then(id => ({ name, id }))
          .catch(err => ({ name, error: err.message }))
      )
    );

    const results = {};
    await Promise.all(
      executionIds.map(async ({ name, id, error }) => {
        if (error) { results[name] = { error }; return; }
        try {
          results[name] = await pollResults(id);
        } catch (err) {
          results[name] = { error: err.message };
        }
      })
    );

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ updated: new Date().toISOString(), data: results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
