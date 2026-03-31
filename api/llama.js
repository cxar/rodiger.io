// Proxy for DefiLlama stablecoins API to avoid CORS issues.
// Usage: /api/llama?path=/stablecoins?includePrices=false

export default async function handler(req, res) {
  const { path } = req.query;
  if (!path) {
    return res.status(400).json({ error: 'Missing ?path= parameter' });
  }

  // Only allow stablecoins.llama.fi paths
  const url = `https://stablecoins.llama.fi${path}`;

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
    }
    const data = await upstream.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
