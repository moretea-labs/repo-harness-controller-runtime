#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[release-surface] typecheck"
bun run check:type

echo "[release-surface] focused tests"
bun test --timeout 60000 \
  tests/cli/local-bridge.test.ts \
  tests/install-scripts.test.ts \
  tests/readme-dx.test.ts

echo "[release-surface] public export"
bun run check:public-export

echo "[release-surface] OK"
