**Overview**
- Rust + Vercel serverless site that renders Google Docs as pages.
- Root page renders `ROOT_DOC_ID`; links to other Google Docs are rewritten to internal routes and rendered on-demand.
- Static assets served from `static/` via a Rust function.

**Routes**
- `/` → renders the Google Doc from `ROOT_DOC_ID`.
- `/g/:id/:slug*` → renders the Google Doc ID `:id`.
- `/static/:path*` → serves files from local `static/`.

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
- Run dev: `vercel dev` (builds Rust functions and serves routes).

**Deploy**
- Set envs in Vercel Dashboard or via CLI:
  - `vercel env add ROOT_DOC_ID`
  - `vercel env add GOOGLE_CREDENTIALS_B64` (or JSON variant)
- Deploy preview: `vercel`.
- Promote to production: `vercel --prod`.

**Link Rewriting**
- Any link in your Google Doc matching `https://docs.google.com/document/d/<ID>` is rewritten to `/g/<ID>/<slug>`.
- The `<slug>` is derived from the link text for nicer URLs; it’s optional for routing.

**Performance Notes**
- HTML responses include `Cache-Control: s-maxage=600, stale-while-revalidate=60` for fast edge caching.
- Static assets use long-lived immutable caching.

**Next Enhancements (optional)**
- Add KV/ETag caching to reduce Docs API calls.
- Use Doc title as `<title>` for better SEO.
- Image proxying/transforms if needed.

