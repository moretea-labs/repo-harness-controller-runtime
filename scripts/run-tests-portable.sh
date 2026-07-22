#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if command -v bun >/dev/null 2>&1; then
  focused=0
  for arg in "$@"; do
    if [[ "$arg" != -* ]]; then
      focused=1
      break
    fi
  done

  if [[ "$focused" -eq 1 ]]; then
    exec bun test --isolate "$@"
  fi

  test_parallelism="${REPO_HARNESS_TEST_PARALLELISM:-4}"
  case "$test_parallelism" in
    ''|*[!0-9]*)
      echo "[tests] REPO_HARNESS_TEST_PARALLELISM must be a positive integer." >&2
      exit 2
      ;;
  esac
  if [[ "$test_parallelism" -lt 1 ]]; then
    echo "[tests] REPO_HARNESS_TEST_PARALLELISM must be at least 1." >&2
    exit 2
  fi

  # Each file gets an independent Bun process. This isolates process.env and
  # open handles while bounded xargs concurrency keeps the exhaustive suite
  # within the Controller execution budget.
  git ls-files -z 'tests/*.test.ts' 'tests/**/*.test.ts' 'tests/**/*.test.mjs' |
    xargs -0 -n 1 -P "$test_parallelism" bash -c '
      args=("$@")
      last=$(( ${#args[@]} - 1 ))
      file="${args[$last]}"
      unset "args[$last]"
      exec bun test --no-orphans "${args[@]}" "$file"
    ' _ "$@"
  exit $?
fi

cat >&2 <<'MSG'
[tests] Bun is not installed, so the Bun-native test suite cannot run.
[tests] Running the Node-only smoke suite instead.
[tests] For exhaustive tests install Bun and run: npm run test:bun
MSG

node --test tests/node/*.test.mjs
