#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v bun >/dev/null 2>&1 || {
  echo "Bun is required to verify repo-harness V8." >&2
  exit 127
}

bun test tests/cli/controller-chatgpt-bridge-v8.test.ts
bun test tests/cli/controller-execution-first-v7.test.ts
bun test tests/cli/mcp-execution-first-v7.test.ts
bun test tests/cli/mcp-controller.test.ts
bun test tests/cli/local-bridge.test.ts
bun run check:type
