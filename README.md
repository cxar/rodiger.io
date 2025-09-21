**Overview**
- Rust static-site generator that renders Google Docs to HTML during build on Vercel.
- Root page renders `ROOT_DOC_ID`; links to other Google Docs are rewritten to internal routes and those pages are generated too.
- Static assets are copied from `static/` to the final site.

**Routes**
- `/` → renders the Google Doc from `ROOT_DOC_ID`.
- `/g/:id/:slug*` → static page per linked Google Doc.

**Environment Variables**
- `ROOT_DOC_ID` — Google Doc ID for the homepage.
- One of the following for Google credentials (Service Account JSON):
  - `GOOGLE_CREDENTIALS_B64` — base64-encoded JSON
  - `GOOGLE_CREDENTIALS_JSON` — raw JSON
  - `GOOGLE_CREDENTIALS` — raw JSON
- Ensure the target Docs are shared with the Service Account email.

**Prepare Credentials**
- Base64 example: `base64 -w0 service-account.json` (macOS: `base64 service-account.json | tr -d '\n'`)
- Set in Vercel: `vercel env add GOOGLE_CREDENTIALS_B64` and paste.

**Local Development**
- Prereqs: Rust toolchain, Vercel CLI (`npm i -g vercel`).
- If Rust was just installed: `. "$HOME/.cargo/env"` to update your shell PATH.
- Link project: `vercel link` (once).
- Add envs locally: `vercel env pull .env` (or set manually in `.env`).
- Build locally: `cargo run --release --bin sitegen` → outputs to `dist/`.
- Preview locally: `npx serve dist` or `python -m http.server` inside `dist/`.

**Deploy**
- Vercel uses `buildCommand: cargo run --release --bin sitegen` and serves `dist/`.
- Set envs in Vercel Dashboard or via CLI:
  - `vercel env add ROOT_DOC_ID`
  - `vercel env add GOOGLE_CREDENTIALS_B64` (or JSON variant)
- Deploy preview: `vercel`.
- Promote to production: `vercel --prod`.

**Auto-Update (Hard Requirement)**
- Vercel Cron (implemented):
  - Create a Vercel Deploy Hook in Project Settings → Git → Deploy Hooks.
  - Add an environment variable in Vercel: `VERCEL_DEPLOY_HOOK_URL` with that URL.
  - The repo includes `/api/redeploy.ts` (Edge Function) which POSTs to your deploy hook.
  - `vercel.json` includes a cron entry that calls `/api/redeploy` every hour (`0 * * * *`). Adjust the schedule as needed.
  - Each cron call triggers a new deploy, re-running the Rust generator to pull the latest Google Docs.

**Link Rewriting**
- Any link in your Google Doc matching `https://docs.google.com/document/d/<ID>` is rewritten to `/g/<ID>/<slug>`.
- The `<slug>` is derived from the link text for nicer URLs; it’s optional for routing.

**Performance Notes**
- Fully static output, fast on Vercel’s CDN.
- You control rebuild cadence by redeploying (or adding a Vercel cron to trigger redeploys).

**Next Enhancements (optional)**
- Add KV/ETag caching to reduce Docs API calls.
- Use Doc title as `<title>` for better SEO.
- Image proxying/transforms if needed.
