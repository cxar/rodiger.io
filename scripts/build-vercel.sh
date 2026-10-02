#!/usr/bin/env bash
set -euo pipefail

# The Paxos checks (about 10 s locally, 30 s on Vercel) are skipped only when nothing they cover changed
# since the last successful deployment, whose build ran them (e.g. the daily same-commit cron redeploy).
# Any doubt runs them: no previous SHA, a shallow clone without it, no git, or a diff in these paths.
# Vercel sets VERCEL_GIT_PREVIOUS_SHA only for projects with an Ignored Build Step: vercel.json's
# "ignoreCommand": "exit 1" is that step, and it always builds (exit 1 = continue).
PAXOS_PATHS=(lib/paxos api/paxos.js pages/paxos 'scripts/check-paxos-*.mjs' scripts/fixtures/paxos scripts/dev-paxos.mjs scripts/monitor-paxos.mjs .github/workflows/paxos-monitor.yml scripts/build-vercel.sh vercel.json static)
if [ -n "${VERCEL_GIT_PREVIOUS_SHA:-}" ] \
  && git cat-file -e "${VERCEL_GIT_PREVIOUS_SHA}^{commit}" 2>/dev/null \
  && git diff --quiet "${VERCEL_GIT_PREVIOUS_SHA}" HEAD -- "${PAXOS_PATHS[@]}" 2>/dev/null; then
  echo "paxos unchanged since ${VERCEL_GIT_PREVIOUS_SHA}; the checks passed on that deployment"
else
  node scripts/check-paxos-dashboard.mjs
fi
node scripts/check-trades-dashboard.mjs
node scripts/check-trades-freshness.mjs

curl -fsSL https://sh.rustup.rs | sh -s -- \
  -y \
  --profile minimal \
  --default-toolchain stable

source "${CARGO_HOME:-$HOME/.cargo}/env"
cargo --version
cargo run --release --bin sitegen
