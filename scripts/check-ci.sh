#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUN_TEST_TIMEOUT_MS="${BUN_TEST_TIMEOUT_MS:-60000}"
BUN_TEST_MAX_CONCURRENCY="${BUN_TEST_MAX_CONCURRENCY:-4}"
BUN_TEST_ISOLATE_FILES="${BUN_TEST_ISOLATE_FILES:-0}"
REPO_HARNESS_ALLOW_NODE_ONLY="${REPO_HARNESS_ALLOW_NODE_ONLY:-0}"

has_bun() {
  command -v bun >/dev/null 2>&1
}

run_install() {
  echo "[ci] install"
  if has_bun; then
    bun install --frozen-lockfile
    return
  fi
  if [[ "$REPO_HARNESS_ALLOW_NODE_ONLY" != "1" ]]; then
    echo "[ci] Bun is required for full CI. Set REPO_HARNESS_ALLOW_NODE_ONLY=1 for the Node-only gate." >&2
    return 1
  fi
  echo "[ci] Bun missing; using npm install for Node-only gate"
  npm install --ignore-scripts --no-audit --no-fund
}

run_typecheck() {
  echo "[ci] typecheck"
  if has_bun; then
    bun run check:type
  else
    npm run check:type -- --pretty false
  fi
}

run_bun_test_file() {
  local file="$1"
  echo "[ci] test $file"
  bun test --timeout "$BUN_TEST_TIMEOUT_MS" --max-concurrency "$BUN_TEST_MAX_CONCURRENCY" "$file"
}

run_bun_tests() {
  if ! has_bun; then
    if [[ "$REPO_HARNESS_ALLOW_NODE_ONLY" != "1" ]]; then
      echo "[ci] Bun test runner missing; full test suite cannot run" >&2
      return 1
    fi
    echo "[ci] Bun missing; running Node smoke tests only"
    node --test tests/node/*.test.mjs
    return
  fi

  if [[ "$BUN_TEST_ISOLATE_FILES" != "1" ]]; then
    bun test --timeout "$BUN_TEST_TIMEOUT_MS" --max-concurrency "$BUN_TEST_MAX_CONCURRENCY"
    return
  fi

  local found=0
  if [[ -n "${BUN_TEST_FILES:-}" ]]; then
    local file
    for file in $BUN_TEST_FILES; do
      found=1
      run_bun_test_file "$file"
    done
  else
    while IFS= read -r file; do
      found=1
      run_bun_test_file "$file"
    done < <(find tests -type f -name '*.test.ts' | LC_ALL=C sort)
  fi

  if [[ "$found" != "1" ]]; then
    echo "[ci] no test files matched" >&2
    return 1
  fi
}

run_workflow_checks() {
  echo "[ci] workflow checks"
  bash scripts/check-deploy-sql-order.sh
  if ! has_bun && [[ "$REPO_HARNESS_ALLOW_NODE_ONLY" == "1" ]]; then
    echo "[ci] Bun missing; skipping architecture/task workflow gates in Node-only gate"
    echo "[ci] Node-only gate intentionally skips task-sync because it is a repository governance gate, not an environment readiness gate"
    return
  fi
  bash scripts/check-architecture-sync.sh
  bash scripts/check-task-sync.sh

  if [[ -f scripts/prepare-handoff.sh ]]; then
    REPO_HARNESS_SKIP_RESUME_REFRESH=1 bash scripts/prepare-handoff.sh "ci gate" >/dev/null
  fi
  if [[ -f scripts/codex-handoff-resume.sh ]]; then
    bash scripts/codex-handoff-resume.sh --cwd . --reason "ci gate" >/dev/null
  fi
  bash scripts/check-task-workflow.sh --strict
}

run_repository_inspection() {
  echo "[ci] repository inspection"
  if has_bun; then
    bun scripts/inspect-project-state.ts --repo . --format text >/dev/null
  elif [[ "$REPO_HARNESS_ALLOW_NODE_ONLY" == "1" ]]; then
    echo "[ci] Bun missing; skipping inspect-project-state.ts in Node-only gate"
  else
    return 1
  fi
  if ! has_bun && [[ "$REPO_HARNESS_ALLOW_NODE_ONLY" == "1" ]]; then
    echo "[ci] Bun missing; skipping migrate-project-template dry-run in Node-only gate"
    return
  fi
  bash scripts/migrate-project-template.sh --repo . --dry-run >/dev/null
}

run_package_checks() {
  echo "[ci] package dry-run"
  if ! has_bun && [[ "$REPO_HARNESS_ALLOW_NODE_ONLY" == "1" ]]; then
    echo "[ci] Bun missing; skipping package dry-run and tarball smoke in Node-only gate"
    return
  fi
  npm pack --dry-run --json >/dev/null
  bash scripts/check-tarball-install-smoke.sh
}

node scripts/check-runtime-env.mjs
run_install
run_typecheck

echo "[ci] runtime architecture"
node scripts/check-runtime-architecture.mjs
node --loader ./src/runtime/shared/node-ts-loader.mjs scripts/check-mcp-compatibility.ts
node --loader ./src/runtime/shared/node-ts-loader.mjs scripts/smoke-runtime-recovery.ts
node --loader ./src/runtime/shared/node-ts-loader.mjs scripts/smoke-schedule-engine.ts
if has_bun || [[ "$REPO_HARNESS_ALLOW_NODE_ONLY" != "1" ]]; then
  node --loader ./src/runtime/shared/node-ts-loader.mjs scripts/smoke-runtime-control-plane.ts
  node --loader ./src/runtime/shared/node-ts-loader.mjs scripts/smoke-mcp-http-runtime.ts
else
  echo "[ci] Bun missing; skipping controller/http runtime smokes in Node-only gate"
fi

echo "[ci] tests"
run_bun_tests
run_workflow_checks
run_repository_inspection
run_package_checks

echo "[ci] OK"
