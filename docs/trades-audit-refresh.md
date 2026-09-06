# Dated trades evidence

The public snapshot separates account evidence time, signal coverage time, and
snapshot assembly time. Refreshing funding observations must not renew either
underlying audit. The dashboard and live checker flag evidence older than 24 hours.

`scripts/refresh-trades-evidence.py --name YYYYMMDD-HHMMSS` performs a bounded,
unsigned account capture and market-history extension, then runs the existing
account and participation auditors unchanged. Run it with Python bytecode disabled
(`python3 -B`). It never writes to the sibling trading checkout, loads a wallet,
restarts a collector, or changes execution or strategy state.

Each run requires a new name and creates a private directory under
`.vercel/trades-audits/`, excluded from Git and deployment. Original September 5
evidence remains untouched. The input view contains only the auditor's required
history, recorded results, and read-only source links. Its September 5 capture
filename is a compatibility alias to the newer dated capture; dates are derived
from the actual request cutoff, never that alias. Request hashes cover decoded
JSON, not original HTTPS wire bytes.

After a successful capture, update `config/hyperliquid-evidence-sources.json` with
the exact two paths and hashes in that run's `export-references.json`. Run
`python3 -B scripts/check-trades-evidence.py` before exporting. It independently
replays the account, validates the captured market extension, and repeats the
participation audit against exactly its hashed runtime-log prefix. Later appended
observations are excluded from that replay. The private evidence directory and
corresponding source versions must remain available for future verification.

Then refresh `scripts/refresh-trades-audit.mjs --write`, verify the funding pilot
source bindings, and run the dashboard, freshness, and public-deployment checks.
Only allowlisted fields reach the public snapshot. The cost and retrospective
research reports retain their own original dates; a fresh account capture does
not refresh their evidence or establish profitability. New fills or changed
economics require reconciliation before publication; existing strict comparisons
intentionally stop the export when historical cost evidence no longer matches.

Missing runtime observations remain explicit even when the selector can be
replayed from historical market data. A market-history gap or disagreement,
saturated public response, changed source hash, or failed replay must be reported,
not replaced with a newer assembly timestamp.
