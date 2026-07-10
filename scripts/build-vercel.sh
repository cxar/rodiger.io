#!/usr/bin/env bash
set -euo pipefail

node scripts/check-paxos-dashboard.mjs
node scripts/check-trades-dashboard.mjs

curl -fsSL https://sh.rustup.rs | sh -s -- \
  -y \
  --profile minimal \
  --default-toolchain stable

source "${CARGO_HOME:-$HOME/.cargo}/env"
cargo --version
cargo run --release --bin sitegen
node scripts/fetch-dune.js
