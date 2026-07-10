'use strict';

const { buildPublicStatus, config } = require('../lib/hyperliquid-strategy');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const payload = await buildPublicStatus();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=15');
    return res.status(200).json(payload);
  } catch (error) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({
      schemaVersion: config.schemaVersion,
      generatedAt: new Date().toISOString(),
      error: 'strategy_status_unavailable',
      message: error instanceof Error ? error.message : 'unknown status error'
    });
  }
};
