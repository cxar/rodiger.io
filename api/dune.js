// Vercel serverless function: fetches on-chain metrics from Dune Analytics
// Called by the Paxos dashboard client-side. Results cached via Vercel edge (Cache-Control).

const DUNE_API_KEY = process.env.DUNE_API_KEY;

// PYUSD on Ethereum: 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8
// USDG on Solana mint: 2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo

const QUERIES = {
  // Ethereum: PYUSD holders, active addresses, transfer volume
  pyusd_eth_summary: `
    WITH balances AS (
      SELECT "to" as address, CAST(value AS DOUBLE) as amount, contract_address FROM erc20_ethereum.evt_Transfer WHERE contract_address = 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8
      UNION ALL
      SELECT "from" as address, -CAST(value AS DOUBLE) as amount, contract_address FROM erc20_ethereum.evt_Transfer WHERE contract_address = 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8
    ),
    holders AS (
      SELECT address, SUM(amount) / 1e6 as balance FROM balances GROUP BY 1 HAVING SUM(amount) > 0
    ),
    active AS (
      SELECT COUNT(DISTINCT "from") + COUNT(DISTINCT "to") as active_7d,
             COUNT(*) as transfers_7d,
             SUM(CAST(value AS DOUBLE)) / 1e6 as volume_7d
      FROM erc20_ethereum.evt_Transfer
      WHERE contract_address = 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8
        AND evt_block_time > NOW() - INTERVAL '7' DAY
    ),
    active_30 AS (
      SELECT COUNT(DISTINCT "from") + COUNT(DISTINCT "to") as active_30d,
             COUNT(*) as transfers_30d,
             SUM(CAST(value AS DOUBLE)) / 1e6 as volume_30d
      FROM erc20_ethereum.evt_Transfer
      WHERE contract_address = 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8
        AND evt_block_time > NOW() - INTERVAL '30' DAY
    )
    SELECT 'PYUSD' as token, 'ethereum' as chain,
           (SELECT COUNT(*) FROM holders) as holders,
           a.active_7d, a.transfers_7d, a.volume_7d,
           b.active_30d, b.transfers_30d, b.volume_30d
    FROM active a, active_30 b
  `,

  // Ethereum: PYUSD top 20 holders
  pyusd_eth_whales: `
    WITH balances AS (
      SELECT address, SUM(amount) / 1e6 as balance FROM (
        SELECT "to" as address, CAST(value AS DOUBLE) as amount FROM erc20_ethereum.evt_Transfer WHERE contract_address = 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8
        UNION ALL
        SELECT "from" as address, -CAST(value AS DOUBLE) as amount FROM erc20_ethereum.evt_Transfer WHERE contract_address = 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8
      ) GROUP BY 1 HAVING SUM(amount) > 0
    ),
    total AS (SELECT SUM(balance) as total FROM balances),
    ranked AS (SELECT address, balance, ROW_NUMBER() OVER (ORDER BY balance DESC) as rn FROM balances)
    SELECT r.address, r.balance, r.balance / t.total * 100 as pct, r.rn as rank
    FROM ranked r, total t WHERE r.rn <= 20
  `,

  // Ethereum: PYUSD daily volume (90d)
  pyusd_eth_daily: `
    SELECT DATE_TRUNC('day', evt_block_time) as day,
           COUNT(*) as transfers,
           COUNT(DISTINCT "from") as unique_senders,
           SUM(CAST(value AS DOUBLE)) / 1e6 as volume_m
    FROM erc20_ethereum.evt_Transfer
    WHERE contract_address = 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8
      AND evt_block_time > NOW() - INTERVAL '90' DAY
    GROUP BY 1 ORDER BY 1
  `,

  // DEX volume for both tokens (Ethereum)
  dex_volume: `
    SELECT project, token_pair,
           SUM(amount_usd) as volume_30d,
           COUNT(*) as trades
    FROM dex.trades
    WHERE block_time > NOW() - INTERVAL '30' DAY
      AND (token_bought_address IN (0x6c3ea9036406852006290770BEdFcAbA0e23A0e8)
        OR token_sold_address IN (0x6c3ea9036406852006290770BEdFcAbA0e23A0e8))
    GROUP BY 1, 2 ORDER BY volume_30d DESC LIMIT 20
  `,

  // Solana: USDG holders + activity via token_accounts
  usdg_sol_summary: `
    WITH transfers AS (
      SELECT block_time, from_token_account, to_token_account, amount
      FROM tokens_solana.transfers
      WHERE token_mint_address = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
        AND block_time > NOW() - INTERVAL '30' DAY
    ),
    active_7d AS (
      SELECT COUNT(DISTINCT from_token_account) + COUNT(DISTINCT to_token_account) as active_7d,
             COUNT(*) as transfers_7d,
             SUM(amount) / 1e6 as volume_7d
      FROM transfers WHERE block_time > NOW() - INTERVAL '7' DAY
    ),
    active_30d AS (
      SELECT COUNT(DISTINCT from_token_account) + COUNT(DISTINCT to_token_account) as active_30d,
             COUNT(*) as transfers_30d,
             SUM(amount) / 1e6 as volume_30d
      FROM transfers
    )
    SELECT 'USDG' as token, 'solana' as chain,
           a.active_7d, a.transfers_7d, a.volume_7d,
           b.active_30d, b.transfers_30d, b.volume_30d
    FROM active_7d a, active_30d b
  `,

  // Solana: USDG daily volume (90d)
  usdg_sol_daily: `
    SELECT DATE_TRUNC('day', block_time) as day,
           COUNT(*) as transfers,
           COUNT(DISTINCT from_token_account) as unique_senders,
           SUM(amount) / 1e6 as volume_m
    FROM tokens_solana.transfers
    WHERE token_mint_address = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
      AND block_time > NOW() - INTERVAL '90' DAY
    GROUP BY 1 ORDER BY 1
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

async function pollResults(executionId, maxWaitMs = 90000) {
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
  throw new Error('Query timed out after ' + maxWaitMs + 'ms');
}

module.exports = async function handler(req, res) {
  if (!DUNE_API_KEY) return res.status(500).json({ error: 'Missing DUNE_API_KEY env var' });

  try {
    // Execute all queries in parallel
    const entries = Object.entries(QUERIES);
    const executionIds = await Promise.all(
      entries.map(([name, sql]) =>
        executeDuneQuery(sql.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim())
          .then(id => ({ name, id }))
          .catch(err => ({ name, error: err.message }))
      )
    );

    // Poll for results (with parallelism)
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

    // Cache for 1 hour
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({
      updated: new Date().toISOString(),
      data: results,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
