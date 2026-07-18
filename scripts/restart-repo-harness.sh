#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/controller-home-env.sh
source "$ROOT/scripts/lib/controller-home-env.sh"

repo_harness_use_local_controller_home "$ROOT"
repo_harness_prepare_runtime_path
BUN_BIN="$(repo_harness_resolve_bun || true)"

WAIT_FOR_COMPLETION=1
TIMEOUT_SECONDS="${REPO_HARNESS_RESTART_TIMEOUT_SECONDS:-90}"
REQUEST_ID=""
REASON="manual one-command full runtime restart"

usage() {
  cat <<'EOF'
Usage: scripts/restart-repo-harness.sh [options]

Submit a durable full restart through the Stable Runtime Supervisor and, by
default, wait until the operation and local health endpoints succeed.

Options:
  --no-wait           Return immediately after the durable operation is accepted.
  --timeout SECONDS   Maximum wait time (default: 90).
  --request-id ID     Explicit idempotency key.
  --reason TEXT       Bounded operator reason.
  -h, --help          Show this help.
EOF
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --no-wait)
      WAIT_FOR_COMPLETION=0
      shift
      ;;
    --timeout)
      [[ "$#" -ge 2 ]] || { echo "--timeout requires a value" >&2; exit 2; }
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --request-id)
      [[ "$#" -ge 2 ]] || { echo "--request-id requires a value" >&2; exit 2; }
      REQUEST_ID="$2"
      shift 2
      ;;
    --reason)
      [[ "$#" -ge 2 ]] || { echo "--reason requires a value" >&2; exit 2; }
      REASON="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$BUN_BIN" ]]; then
  echo "Bun is required. Set REPO_HARNESS_BUN_BIN or install Bun under ~/.bun/bin." >&2
  exit 127
fi

case "$TIMEOUT_SECONDS" in
  ''|*[!0-9]*) echo "--timeout must be a positive integer" >&2; exit 2 ;;
esac
if [[ "$TIMEOUT_SECONDS" -le 0 ]]; then
  echo "--timeout must be a positive integer" >&2
  exit 2
fi

if [[ ! -e "$REPO_HARNESS_CONTROLLER_HOME/supervisor/current" ]]; then
  echo "Stable Runtime Supervisor is not installed; using the legacy restart coordinator." >&2
  exec "$ROOT/scripts/controller-runtime.sh" restart --reason "$REASON"
fi

CLI_ENTRY="$ROOT/src/cli/index.ts"
if [[ -f "$REPO_HARNESS_CONTROLLER_HOME/supervisor/current/repo-harness.js" ]]; then
  CLI_ENTRY="$REPO_HARNESS_CONTROLLER_HOME/supervisor/current/repo-harness.js"
fi

if [[ -z "$REQUEST_ID" ]]; then
  REQUEST_ID="manual-full-restart-$(date -u +%Y%m%dT%H%M%SZ)-$$"
fi

SUBMIT_JSON="$(
  "$BUN_BIN" "$CLI_ENTRY" supervisor restart full \
    --repo "$ROOT" \
    --controller-home "$REPO_HARNESS_CONTROLLER_HOME" \
    --request-id "$REQUEST_ID" \
    --reason "$REASON" \
    --json
)"

OPERATION_ID="$(
  printf '%s' "$SUBMIT_JSON" | "$BUN_BIN" -e '
    const value = JSON.parse(await Bun.stdin.text());
    const id = value.operation?.operationId ?? value.operationId ?? "";
    process.stdout.write(String(id));
  '
)"

if [[ -z "$OPERATION_ID" ]]; then
  echo "Supervisor accepted no readable operation id:" >&2
  printf '%s\n' "$SUBMIT_JSON" >&2
  exit 1
fi

echo "Repo Harness full restart accepted."
echo "  request_id: $REQUEST_ID"
echo "  operation_id: $OPERATION_ID"
echo "  reconnect_contract: stable_domain_retry"

if [[ "$WAIT_FOR_COMPLETION" -eq 0 ]]; then
  exit 0
fi

DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
LAST_PHASE=""
OPERATION_JSON=""
while [[ "$(date +%s)" -le "$DEADLINE" ]]; do
  if OPERATION_JSON="$(
    "$BUN_BIN" "$CLI_ENTRY" supervisor operation "$OPERATION_ID" \
      --repo "$ROOT" \
      --controller-home "$REPO_HARNESS_CONTROLLER_HOME" \
      --json 2>/dev/null
  )"; then
    PHASE="$(
      printf '%s' "$OPERATION_JSON" | "$BUN_BIN" -e '
        const value = JSON.parse(await Bun.stdin.text());
        const phase = value.operation?.phase ?? value.phase ?? "unknown";
        process.stdout.write(String(phase));
      '
    )"

    if [[ "$PHASE" != "$LAST_PHASE" ]]; then
      echo "  phase: $PHASE"
      LAST_PHASE="$PHASE"
    fi

    case "$PHASE" in
      succeeded) break ;;
      failed)
        printf '%s\n' "$OPERATION_JSON" >&2
        exit 1
        ;;
    esac
  fi
  sleep 1
done

if [[ "$LAST_PHASE" != "succeeded" ]]; then
  echo "Timed out waiting for Supervisor operation $OPERATION_ID." >&2
  [[ -n "$OPERATION_JSON" ]] && printf '%s\n' "$OPERATION_JSON" >&2
  exit 1
fi

MCP_PORT="${REPO_HARNESS_MCP_PORT:-8765}"
SUPERVISOR_PORT="${REPO_HARNESS_SUPERVISOR_PORT:-8770}"
while [[ "$(date +%s)" -le "$DEADLINE" ]]; do
  if curl -fsS --max-time 2 "http://127.0.0.1:${MCP_PORT}/health" >/dev/null 2>&1 \
    && curl -fsS --max-time 2 "http://127.0.0.1:${SUPERVISOR_PORT}/health" >/dev/null 2>&1; then
    echo "Repo Harness runtime is healthy."
    echo "  mcp_health: http://127.0.0.1:${MCP_PORT}/health"
    echo "  supervisor_health: http://127.0.0.1:${SUPERVISOR_PORT}/health"
    exit 0
  fi
  sleep 1
done

echo "Restart operation succeeded, but health verification timed out." >&2
exit 1
