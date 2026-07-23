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

  test_parallelism="${REPO_HARNESS_TEST_PARALLELISM:-1}"
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

  max_test_parallelism=4
  if [[ "$test_parallelism" -gt "$max_test_parallelism" ]]; then
    echo "[tests] bounding file-level parallelism to ${max_test_parallelism} to preserve subprocess headroom." >&2
    test_parallelism="$max_test_parallelism"
  fi

  # Run the exhaustive suite in one Bun process. File isolation is provided by
  # --isolate, while bounded concurrency prevents shared host-level Git, hook,
  # launchd, process-tree, and user-tooling state from racing across files.
  test_files=()
  while IFS= read -r -d '' test_file; do
    test_files+=("$test_file")
  done < <(git ls-files -z 'tests/*.test.ts' 'tests/**/*.test.ts' 'tests/**/*.test.mjs')

  exec bun test --isolate --max-concurrency "$test_parallelism" "$@" "${test_files[@]}"
fi

cat >&2 <<'MSG'
[tests] Bun is not installed, so the Bun-native test suite cannot run.
[tests] Running the Node-only smoke suite instead.
[tests] For exhaustive tests install Bun and run: npm run test:bun
MSG

node --test tests/node/*.test.mjs
