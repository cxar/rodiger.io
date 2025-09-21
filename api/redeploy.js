export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(500).send('Missing CRON_SECRET');
  }
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).send('Unauthorized');
  }

  const hook = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hook) {
    return res.status(500).send('Missing VERCEL_DEPLOY_HOOK_URL');
  }
  try {
    const r = await fetch(hook, { method: 'POST' });
    return res.status(200).json({ ok: r.ok, status: r.status });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || String(e)}`);
  }
}

