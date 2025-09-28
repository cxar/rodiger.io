module.exports = async function handler(req, res) {
  try {
    console.log('[cron] invoke', {
      method: req.method,
      path: req.url,
      hasAuth: Boolean(req.headers?.authorization),
      isCron: Boolean(req.headers?.['x-vercel-cron']),
    });
  } catch (_) {}
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn('[cron] Missing CRON_SECRET');
    return res.status(500).send('Missing CRON_SECRET');
  }
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${secret}`) {
    console.warn('[cron] Unauthorized');
    return res.status(401).send('Unauthorized');
  }

  const hook = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hook) {
    console.warn('[cron] Missing VERCEL_DEPLOY_HOOK_URL');
    return res.status(500).send('Missing VERCEL_DEPLOY_HOOK_URL');
  }
  try {
    const r = await fetch(hook, { method: 'POST' });
    console.log('[cron] hook response', { status: r.status, ok: r.ok });
    return res.status(200).json({ ok: r.ok, status: r.status });
  } catch (e) {
    console.error('[cron] error', e);
    return res.status(500).send(`Error: ${e?.message || String(e)}`);
  }
}
