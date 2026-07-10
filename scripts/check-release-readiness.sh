#!/usr/bin/env bash
# Release-readiness gate for tool-surface + open-source hygiene.
# Does not publish, push, or modify remote state.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[release-readiness] typecheck"
bun run check:type

echo "[release-readiness] package identity"
node scripts/check-package-identity.mjs

echo "[release-readiness] third-party notices"
node scripts/check-third-party-notices.mjs

echo "[release-readiness] focused package contract"
bun test tests/release/package-release.test.ts tests/skill-version.test.ts

echo "[release-readiness] MCP tool exposure + facade coverage"
bun test --timeout 60000 \
  tests/cli/mcp-tool-exposure-profiles.test.ts \
  tests/runtime/facade-mcp-surface.test.ts \
  tests/cli/connector-freshness.test.ts

echo "[release-readiness] MCP compatibility fingerprints"
bun run check:mcp-compatibility

echo "[release-readiness] MCP tool-surface smoke"
bun scripts/smoke-mcp-tool-surface.ts

echo "[release-readiness] public documentation"
bash scripts/check-public-docs.sh

echo "[release-readiness] cross-platform install contract"
node scripts/check-platform-support.mjs
bun test tests/install-scripts.test.ts tests/cli/global-runtime-init.test.ts

echo "[release-readiness] open-source tracked-file audit"
bash scripts/check-open-source-tracked-surface.sh

echo "[release-readiness] public export surface"
bun run check:public-export

echo "[release-readiness] npm pack dry-run"
npm pack --dry-run --json >/dev/null

echo "[release-readiness] tarball install smoke"
bash scripts/check-tarball-install-smoke.sh

echo "[release-readiness] OK"
