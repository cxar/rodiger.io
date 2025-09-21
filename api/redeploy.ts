export const config = { runtime: 'edge' };

export default async function handler() {
  const hook = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hook) {
    return new Response('Missing VERCEL_DEPLOY_HOOK_URL', { status: 500 });
  }
  try {
    const res = await fetch(hook, { method: 'POST' });
    return new Response(
      JSON.stringify({ ok: res.ok, status: res.status }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(`Error: ${err?.message || String(err)}`, { status: 500 });
  }
}

