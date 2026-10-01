**Overview**
- Rust static-site generator that renders Google Docs to HTML during build on Vercel.
- Root page renders `ROOT_DOC_ID`; links to other Google Docs are rewritten to internal routes and those pages are generated too.
- Static assets are copied from `static/` to the final site.

**Routes**
- `/` → renders the Google Doc from `ROOT_DOC_ID`.
- `/g/:id/:slug*` → static page per linked Google Doc.
- `/trades` → active Hyperliquid strategy dashboard.
- `/api/trades` → versioned, secret-free strategy/account/signal JSON assembled from the public Hyperliquid API.
- `/paxos` → Paxos Health dashboard (static page in `pages/paxos/`; `paxos.rodiger.io/` redirects here).
- `/api/paxos` → Paxos Health JSON (schemaVersion 1, GET or HEAD): assets, chains, addresses and peers discovered from public data on each build, plus statistically unusual findings. CDN-cached for up to 30 minutes from generation; query strings are ignored and a warm instance rebuilds at most every 15 minutes. Architecture, sources, methodology and limitations: `docs/paxos-dashboard.md`.

The Paxos dashboard has no build-time data step: the former Dune snapshot and the `/api/llama` proxy were removed (DefiLlama sends CORS headers itself, and the Dune plan has no API access). `node scripts/check-paxos-dashboard.mjs` runs its offline checks against a recorded upstream fixture (payload semantics, the API handler, the deploy config, and the page rendered under a DOM shim); the Vercel build runs it first. Its wall-clock budget only warns (`PAXOS_PERF_STRICT=1` makes it fail). `paxos.rodiger.io` is routed by a host-conditioned redirect in `vercel.json` (a rewrite would lose to the root `index.html`); the domain has to be added to the Vercel project and to DNS by the owner. `vercel.json` also sets a CSP and other security headers on `/paxos` and `/api/paxos`; update the CSP when the page loads a new script or resource. `node scripts/dev-paxos.mjs` previews the dashboard locally on 127.0.0.1 with live data and the same redirects and headers.

The tracked strategy manifest at `config/hyperliquid-live-strategy.json` is the dashboard's single source of truth for rule, execution, and risk constants. The API reports local executor/supervisor health as `not_publicly_observable`; it never infers daemon health from fresh exchange data.

Paper research lanes are a separate additive contract sourced from the compact tracked snapshot at `config/hyperliquid-research-lanes.json`. They never modify the live strategy object, live P&L, account exposure, or order state. Stale or invalid research snapshots hide operational claims while leaving the live ZEC status semantically unchanged.

The latest dated account/participation audit and read-only funding-pilot progress are separate in `config/hyperliquid-audit.json`. Run `node scripts/refresh-trades-audit.mjs --write` to assemble the allowlisted fields from the sibling research checkout. Assembly time is not evidence time: preserve the original account and signal cutoffs, and re-audit when newer fills arrive. Do not refresh the legacy July snapshot's timestamp or restart rejected publishers to make it look current. No audit or paper observation is added to live P&L.

The export also pins the September 5 aggressive-expansion, six-signal mark/depth and three-filter mechanism reports. Their findings are labeled retrospective/hypothetical, exclude unobserved executions from earned profit, and do not alter the live strategy. The public checker compares exact evidence hashes and findings with the local export so a fresh HTTP timestamp cannot conceal an unpublished research update.

The trades page refreshes every 30 seconds, expires exchange responses after 90 seconds, times out requests (including JSON bodies) after 12 seconds, prevents overlapping refreshes, and refreshes on reconnect/tab resume. Failed or expired requests clear positions, orders, exposure and charts. `node scripts/check-trades-freshness.mjs` tests these paths without a browser. `node scripts/check-trades-live.mjs` checks the deployed page/API, strategy identity, source health, new fills versus audit coverage, and pilot publication lag without any wallet access.

**Environment Variables**
- `ROOT_DOC_ID` — Google Doc ID for the homepage.
- One of the following for Google credentials (Service Account JSON):
  - `GOOGLE_CREDENTIALS_B64` — base64-encoded JSON
  - `GOOGLE_CREDENTIALS_JSON` — raw JSON
  - `GOOGLE_CREDENTIALS` — raw JSON
- Ensure the target Docs are shared with the Service Account email.
- `COINGECKO_DEMO_API_KEY` (recommended for production) — CoinGecko demo API key for `/api/paxos`. Without it CoinGecko is called keyless (2 s spacing) and from Vercel's shared IPs it is mostly rate-limited, so its figures (turnover, gold premium, gold references) are often missing on cold instances; with it the spacing is 0.65 s. A cold build makes about 13 CoinGecko calls and a warm instance rebuilds at most 4 times an hour, well within the demo plan's monthly quota at normal traffic. Sent only to api.coingecko.com.
- `BLOCKSCOUT_API_KEY` (recommended) — free Blockscout PRO API key from https://dev.blockscout.com, used for holder counts and token data on every Blockscout chain via api.blockscout.com. Without it the public explorer hosts are used, and some (e.g. Robinhood Chain's) block scripted requests, so those holder counts are missing. Sent only to api.blockscout.com, as a header.

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
- Vercel runs `bash scripts/build-vercel.sh` (offline dashboard checks, then `cargo run --release --bin sitegen`) and serves `dist/`.
- Set envs in Vercel Dashboard or via CLI:
  - `vercel env add ROOT_DOC_ID`
  - `vercel env add GOOGLE_CREDENTIALS_B64` (or JSON variant)
- Deploy preview: `vercel`.
- Promote to production: `vercel --prod`.

**Auto-Update (Hard Requirement)**
- Vercel Cron (implemented):
  - Create a Vercel Deploy Hook in Project Settings → Git → Deploy Hooks.
  - Add environment variables in Vercel:
    - `VERCEL_DEPLOY_HOOK_URL` with that URL.
    - `CRON_SECRET` to any random string; Vercel will send it as `Authorization: Bearer <value>`.
  - The repo includes `/api/redeploy.js` (Serverless Function) which checks `Authorization` and POSTs to your deploy hook.
  - `vercel.json` includes a cron entry that calls `/api/redeploy` daily at 06:00 UTC (`0 6 * * *`). Adjust the schedule as needed.
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
