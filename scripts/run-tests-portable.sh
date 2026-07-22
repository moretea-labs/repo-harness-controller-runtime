#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if command -v bun >/dev/null 2>&1; then
  exec bun test --isolate "$@"
fi

cat >&2 <<'MSG'
[tests] Bun is not installed, so the Bun-native test suite cannot run.
[tests] Running the Node-only smoke suite instead.
[tests] For exhaustive tests install Bun and run: npm run test:bun
MSG

node --test tests/node/*.test.mjs
