#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/controller-home-env.sh
source "$ROOT/scripts/lib/controller-home-env.sh"

repo_harness_use_local_controller_home "$ROOT"

REPO_ROOT="$ROOT"
LOCAL_CLI="$ROOT/scripts/repo-harness-local.sh"
CONFIG_FILE_DEFAULT="$ROOT/_ops/secrets/controller-ngrok-rotation.env"
STATE_DIR_DEFAULT="$ROOT/_ops/state"
LOG_DIR_DEFAULT="$ROOT/_ops/logs"

CONFIG_FILE="${REPO_HARNESS_NGROK_ROTATION_CONFIG:-$CONFIG_FILE_DEFAULT}"
STATE_DIR="${REPO_HARNESS_NGROK_ROTATION_STATE_DIR:-$STATE_DIR_DEFAULT}"
LOG_DIR="${REPO_HARNESS_NGROK_ROTATION_LOG_DIR:-$LOG_DIR_DEFAULT}"

PID_FILE="$STATE_DIR/controller-ngrok-rotation.pid"
STATE_FILE="$STATE_DIR/controller-ngrok-rotation.state"
LOG_FILE="$LOG_DIR/controller-ngrok-rotation.log"
LOCK_DIR="$STATE_DIR/controller-ngrok-rotation.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"

STARTUP_RETRIES_DEFAULT=12
STARTUP_RETRY_DELAY_DEFAULT=3
POLL_INTERVAL_DEFAULT=20
FAILURE_THRESHOLD_DEFAULT=2
CURL_TIMEOUT_DEFAULT=12
ROTATE_BACKOFF_DEFAULT=5

ACTIVE_NGROK_PID=""
MANAGER_CHILD_PID=""
STOP_REQUESTED=0

usage() {
  cat <<'EOF' >&2
Usage: scripts/controller-ngrok-rotation.sh <start|stop|status|logs|run> [options]

Options:
  --repo <path>     Repository root (default: repo root containing this script)
  --config <path>   Rotation config file (default: _ops/secrets/controller-ngrok-rotation.env)
  --tail <lines>    Approximate number of log lines for `logs` (default: 200)
EOF
}

log() {
  printf '[controller-ngrok-rotation] %s\n' "$*"
}

ensure_dirs() {
  mkdir -p "$STATE_DIR" "$LOG_DIR" "$(dirname "$CONFIG_FILE")"
}

is_pid_alive() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid_file() {
  [[ -f "$PID_FILE" ]] || return 1
  tr -d '[:space:]' <"$PID_FILE"
}

read_lock_pid() {
  [[ -f "$LOCK_PID_FILE" ]] || return 1
  tr -d '[:space:]' <"$LOCK_PID_FILE"
}

acquire_lock() {
  ensure_dirs

  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    local lock_pid
    lock_pid="$(read_lock_pid || true)"
    if is_pid_alive "$lock_pid"; then
      return 1
    fi
    rm -rf "$LOCK_DIR"
  done

  printf '%s\n' "$$" >"$LOCK_PID_FILE"
}

release_lock() {
  local lock_pid
  lock_pid="$(read_lock_pid || true)"
  if [[ -d "$LOCK_DIR" ]] && [[ -z "$lock_pid" || "$lock_pid" == "$$" ]]; then
    rm -rf "$LOCK_DIR"
  fi
}

state_value() {
  local key="$1"
  [[ -f "$STATE_FILE" ]] || return 1
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$STATE_FILE"
}

write_state() {
  local status="$1"
  cat >"$STATE_FILE" <<EOF
MANAGER_PID=$$
STATUS=$status
ACTIVE_INDEX=${ACTIVE_INDEX:--1}
ACTIVE_NAME=${ACTIVE_NAME:-}
ACTIVE_URL=${ACTIVE_URL:-}
ACTIVE_CONFIG=${ACTIVE_CONFIG:-}
ACTIVE_NGROK_PID=${ACTIVE_NGROK_PID:-}
LAST_REASON=${LAST_REASON:-}
UPDATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF
}

load_rotation_config() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    log "rotation config not found at $CONFIG_FILE"
    exit 1
  fi

  # shellcheck disable=SC1090
  source "$CONFIG_FILE"

  pin_entries_to_configured_endpoint

  if [[ ${NGROK_ENTRIES+x} != x ]] || (( ${#NGROK_ENTRIES[@]} == 0 )); then
    log "NGROK_ENTRIES is empty in $CONFIG_FILE"
    exit 1
  fi

  SERVER_NAME="${SERVER_NAME:-$(current_server_name)}"
  STARTUP_RETRIES="${STARTUP_RETRIES:-$STARTUP_RETRIES_DEFAULT}"
  STARTUP_RETRY_DELAY_SECONDS="${STARTUP_RETRY_DELAY_SECONDS:-$STARTUP_RETRY_DELAY_DEFAULT}"
  POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-$POLL_INTERVAL_DEFAULT}"
  FAILURE_THRESHOLD="${FAILURE_THRESHOLD:-$FAILURE_THRESHOLD_DEFAULT}"
  CURL_TIMEOUT_SECONDS="${CURL_TIMEOUT_SECONDS:-$CURL_TIMEOUT_DEFAULT}"
  ROTATE_BACKOFF_SECONDS="${ROTATE_BACKOFF_SECONDS:-$ROTATE_BACKOFF_DEFAULT}"
  LOCAL_PORT="${LOCAL_PORT:-8765}"
  LOCAL_ADDR="${LOCAL_ADDR:-127.0.0.1:${LOCAL_PORT}}"
}

current_server_name() {
  python3 - <<'PY'
from pathlib import Path
import json

p = Path(".repo-harness/mcp.local.json")
if not p.exists():
    print("repo-harness-controller-runtime")
else:
    data = json.loads(p.read_text())
    print(data.get("chatgpt", {}).get("serverName", "repo-harness-controller-runtime"))
PY
}

current_chatgpt_endpoint() {
  python3 - <<'PY'
from pathlib import Path
import json

p = Path(".repo-harness/mcp.local.json")
if not p.exists():
    print("")
else:
    data = json.loads(p.read_text())
    print(data.get("chatgpt", {}).get("endpoint", ""))
PY
}

pin_entries_to_configured_endpoint() {
  local configured_endpoint allow_rotation
  configured_endpoint="$(current_chatgpt_endpoint)"
  allow_rotation="${ALLOW_ENDPOINT_ROTATION:-0}"

  if [[ -z "$configured_endpoint" || "$allow_rotation" == "1" ]]; then
    return 0
  fi

  local configured_base="${configured_endpoint%/mcp}"
  local filtered=()
  local entry name config_path url
  for entry in "${NGROK_ENTRIES[@]}"; do
    IFS='|' read -r name config_path url <<<"$entry"
    if [[ "${url%/}" == "$configured_base" ]]; then
      filtered+=("$entry")
    fi
  done

  if (( ${#filtered[@]} > 0 )); then
    if (( ${#filtered[@]} != ${#NGROK_ENTRIES[@]} )); then
      log "pinning ngrok candidates to configured ChatGPT endpoint: $configured_endpoint"
    fi
    NGROK_ENTRIES=("${filtered[@]}")
  fi
}

stop_ngrok_child() {
  local pid="${1:-$ACTIVE_NGROK_PID}"
  [[ -n "$pid" ]] || return 0
  if ! is_pid_alive "$pid"; then
    ACTIVE_NGROK_PID=""
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  local waited=0
  while is_pid_alive "$pid" && (( waited < 20 )); do
    sleep 0.5
    waited=$((waited + 1))
  done
  if is_pid_alive "$pid"; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  ACTIVE_NGROK_PID=""
}

cleanup_worker() {
  STOP_REQUESTED=1
  LAST_REASON="${LAST_REASON:-stopped}"
  stop_ngrok_child
  write_state "stopped"
}

cleanup_supervisor() {
  STOP_REQUESTED=1
  LAST_REASON="${LAST_REASON:-stopped}"

  if [[ -n "$MANAGER_CHILD_PID" ]] && is_pid_alive "$MANAGER_CHILD_PID"; then
    kill "$MANAGER_CHILD_PID" 2>/dev/null || true
    local waited=0
    while is_pid_alive "$MANAGER_CHILD_PID" && (( waited < 20 )); do
      sleep 0.5
      waited=$((waited + 1))
    done
    if is_pid_alive "$MANAGER_CHILD_PID"; then
      kill -9 "$MANAGER_CHILD_PID" 2>/dev/null || true
    fi
  fi

  rm -f "$PID_FILE"
  release_lock
  write_state "stopped"
}

http_status() {
  local url="$1"
  local headers body status
  headers="$(mktemp)"
  body="$(mktemp)"
  if ! curl -sS --max-time "$CURL_TIMEOUT_SECONDS" -D "$headers" -o "$body" "$url" >/dev/null 2>&1; then
    rm -f "$headers" "$body"
    echo "curl_error"
    return 0
  fi
  status="$(awk 'toupper($1) ~ /^HTTP/ {code=$2} END {print code}' "$headers")"
  if grep -qiE 'ERR_NGROK_727|requests limit for the month|reached its HTTP requests limit' "$body"; then
    rm -f "$headers" "$body"
    echo "quota"
    return 0
  fi
  rm -f "$headers" "$body"
  echo "${status:-unknown}"
}

probe_current_endpoint() {
  local base_url="${1%/}"
  local health_status well_known_status mcp_status

  health_status="$(http_status "$base_url/health")"
  case "$health_status" in
    quota) echo "quota"; return 0 ;;
    200) ;;
    *) echo "fail"; return 0 ;;
  esac

  well_known_status="$(http_status "$base_url/.well-known/oauth-protected-resource/mcp")"
  case "$well_known_status" in
    quota) echo "quota"; return 0 ;;
    200) ;;
    *) echo "fail"; return 0 ;;
  esac

  mcp_status="$(http_status "$base_url/mcp")"
  case "$mcp_status" in
    quota) echo "quota"; return 0 ;;
    401) echo "ok"; return 0 ;;
    *) echo "fail"; return 0 ;;
  esac
}

apply_chatgpt_endpoint() {
  local base_url="${1%/}"
  "$LOCAL_CLI" mcp setup chatgpt --repo "$REPO_ROOT" --server-name "$SERVER_NAME" --endpoint "$base_url/mcp" >/dev/null
}

start_candidate() {
  local index="$1"
  local entry="$2"
  local name config_path url
  IFS='|' read -r name config_path url <<<"$entry"

  ACTIVE_INDEX="$index"
  ACTIVE_NAME="$name"
  ACTIVE_URL="$url"
  ACTIVE_CONFIG="$config_path"
  LAST_REASON="starting"
  write_state "starting"

  if [[ ! -f "$config_path" ]]; then
    LAST_REASON="missing-config:$name"
    log "candidate $name skipped because config file is missing: $config_path"
    write_state "rotating"
    return 1
  fi

  log "starting candidate $name -> $url"
  env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
    ngrok http "$LOCAL_ADDR" --config "$config_path" --url "$url" --log stdout --log-format logfmt &
  ACTIVE_NGROK_PID="$!"
  write_state "starting"

  apply_chatgpt_endpoint "$url"

  local attempt result
  for ((attempt = 1; attempt <= STARTUP_RETRIES; attempt += 1)); do
    if ! is_pid_alive "$ACTIVE_NGROK_PID"; then
      LAST_REASON="ngrok-exited-during-start:$name"
      write_state "rotating"
      log "candidate $name exited before becoming healthy"
      return 1
    fi

    result="$(probe_current_endpoint "$url")"
    case "$result" in
      ok)
        LAST_REASON="healthy"
        write_state "active"
        log "candidate $name is healthy at $url/mcp"
        return 0
        ;;
      quota)
        LAST_REASON="quota-exhausted:$name"
        log "candidate $name hit ngrok request quota"
        stop_ngrok_child
        write_state "rotating"
        return 1
        ;;
      *)
        sleep "$STARTUP_RETRY_DELAY_SECONDS"
        ;;
    esac
  done

  LAST_REASON="startup-timeout:$name"
  log "candidate $name failed startup health checks"
  stop_ngrok_child
  write_state "rotating"
  return 1
}

monitor_candidate() {
  local failures=0
  while (( STOP_REQUESTED == 0 )); do
    if ! is_pid_alive "$ACTIVE_NGROK_PID"; then
      LAST_REASON="ngrok-exited:${ACTIVE_NAME:-unknown}"
      log "active candidate ${ACTIVE_NAME:-unknown} exited"
      write_state "rotating"
      return 1
    fi

    sleep "$POLL_INTERVAL_SECONDS"
    local result
    result="$(probe_current_endpoint "$ACTIVE_URL")"
    case "$result" in
      ok)
        failures=0
        LAST_REASON="healthy"
        write_state "active"
        ;;
      quota)
        LAST_REASON="quota-exhausted:${ACTIVE_NAME:-unknown}"
        log "active candidate ${ACTIVE_NAME:-unknown} hit ngrok request quota"
        stop_ngrok_child
        write_state "rotating"
        return 1
        ;;
      *)
        failures=$((failures + 1))
        LAST_REASON="probe-failed:${ACTIVE_NAME:-unknown}:$failures"
        write_state "active"
        if (( failures >= FAILURE_THRESHOLD )); then
          log "active candidate ${ACTIVE_NAME:-unknown} failed ${failures} consecutive health checks"
          stop_ngrok_child
          write_state "rotating"
          return 1
        fi
        ;;
    esac
  done

  LAST_REASON="stop-requested"
  return 0
}

rotation_run_once() {
  ensure_dirs
  load_rotation_config

  local start_index=0
  if [[ -f "$STATE_FILE" ]]; then
    local previous_index
    previous_index="$(state_value ACTIVE_INDEX || true)"
    if [[ "$previous_index" =~ ^[0-9]+$ ]] && (( previous_index < ${#NGROK_ENTRIES[@]} )); then
      start_index="$previous_index"
    fi
  fi

  while (( STOP_REQUESTED == 0 )); do
    local rotated=0
    local count="${#NGROK_ENTRIES[@]}"
    local offset index
    for ((offset = 0; offset < count; offset += 1)); do
      index=$(((start_index + offset) % count))
      if start_candidate "$index" "${NGROK_ENTRIES[$index]}"; then
        rotated=1
        if monitor_candidate; then
          break
        fi
        start_index=$(((index + 1) % count))
      fi
      stop_ngrok_child
    done

    if (( STOP_REQUESTED != 0 )); then
      break
    fi

    if (( rotated == 0 )); then
      LAST_REASON="all-candidates-unhealthy"
      write_state "waiting"
      log "all ngrok candidates are unhealthy; retrying in ${ROTATE_BACKOFF_SECONDS}s"
      sleep "$ROTATE_BACKOFF_SECONDS"
    fi
  done
}

rotation_run_supervisor() {
  ensure_dirs
  load_rotation_config

  if ! acquire_lock; then
    local existing_pid
    existing_pid="$(read_lock_pid || true)"
    if [[ -n "$existing_pid" ]]; then
      printf '%s\n' "$existing_pid" >"$PID_FILE"
      log "rotation manager already running (pid $existing_pid)"
    else
      log "rotation manager already running"
    fi
    return 0
  fi

  printf '%s\n' "$$" >"$PID_FILE"
  write_state "starting"
  log "rotation manager started for $REPO_ROOT"

  trap 'cleanup_supervisor' EXIT
  trap 'exit 0' INT TERM

  while (( STOP_REQUESTED == 0 )); do
    "$0" run-once --repo "$REPO_ROOT" --config "$CONFIG_FILE" &
    MANAGER_CHILD_PID="$!"

    local child_status=0
    if wait "$MANAGER_CHILD_PID"; then
      child_status=0
    else
      child_status=$?
    fi
    MANAGER_CHILD_PID=""

    if (( STOP_REQUESTED != 0 )); then
      break
    fi

    if (( child_status != 0 )); then
      log "rotation worker exited with status $child_status; restarting in ${ROTATE_BACKOFF_SECONDS}s"
    else
      log "rotation worker exited unexpectedly; restarting in ${ROTATE_BACKOFF_SECONDS}s"
    fi
    sleep "$ROTATE_BACKOFF_SECONDS"
  done
}

start_manager() {
  ensure_dirs
  if [[ ! -f "$CONFIG_FILE" ]]; then
    log "rotation config missing at $CONFIG_FILE"
    exit 1
  fi

  local existing_pid
  existing_pid="$(read_pid_file || true)"
  if ! is_pid_alive "$existing_pid"; then
    local lock_pid
    lock_pid="$(read_lock_pid || true)"
    if is_pid_alive "$lock_pid"; then
      printf '%s\n' "$lock_pid" >"$PID_FILE"
      existing_pid="$lock_pid"
    fi
  fi
  if is_pid_alive "$existing_pid"; then
    log "rotation manager already running (pid $existing_pid)"
    return 0
  fi

  local manager_pid
  manager_pid="$(SCRIPT_PATH="$0" REPO_ROOT="$REPO_ROOT" CONFIG_FILE="$CONFIG_FILE" LOG_FILE="$LOG_FILE" python3 - <<'PY'
import os
import subprocess

cmd = [
    os.environ["SCRIPT_PATH"],
    "supervise",
    "--repo",
    os.environ["REPO_ROOT"],
    "--config",
    os.environ["CONFIG_FILE"],
]

with open(os.environ["LOG_FILE"], "ab", buffering=0) as handle:
    proc = subprocess.Popen(
        cmd,
        cwd=os.environ["REPO_ROOT"],
        stdin=subprocess.DEVNULL,
        stdout=handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
print(proc.pid)
PY
)"
  printf '%s\n' "$manager_pid" >"$PID_FILE"
  log "rotation manager started (pid $manager_pid); logs: $LOG_FILE"
}

stop_manager() {
  local pid
  pid="$(read_pid_file || true)"
  if ! is_pid_alive "$pid"; then
    local lock_pid
    lock_pid="$(read_lock_pid || true)"
    if is_pid_alive "$lock_pid"; then
      printf '%s\n' "$lock_pid" >"$PID_FILE"
      pid="$lock_pid"
    fi
  fi
  if ! is_pid_alive "$pid"; then
    rm -f "$PID_FILE"
    release_lock
    log "rotation manager is not running"
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  local waited=0
  while is_pid_alive "$pid" && (( waited < 20 )); do
    sleep 0.5
    waited=$((waited + 1))
  done
  if is_pid_alive "$pid"; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  release_lock
  log "rotation manager stopped"
}

status_manager() {
  ensure_dirs
  local pid lock_pid status active_name active_url last_reason updated_at
  pid="$(read_pid_file || true)"
  lock_pid="$(read_lock_pid || true)"
  if ! is_pid_alive "$pid" && is_pid_alive "$lock_pid"; then
    printf '%s\n' "$lock_pid" >"$PID_FILE"
    pid="$lock_pid"
  fi
  status="$(state_value STATUS || true)"
  active_name="$(state_value ACTIVE_NAME || true)"
  active_url="$(state_value ACTIVE_URL || true)"
  last_reason="$(state_value LAST_REASON || true)"
  updated_at="$(state_value UPDATED_AT || true)"

  if is_pid_alive "$pid"; then
    printf 'ngrok rotation: running (pid=%s)\n' "$pid"
  else
    printf 'ngrok rotation: stopped\n'
  fi
  printf 'status: %s\n' "${status:-unknown}"
  [[ -n "$active_name" ]] && printf 'active candidate: %s\n' "$active_name"
  [[ -n "$active_url" ]] && printf 'active url: %s/mcp\n' "${active_url%/}"
  [[ -n "$last_reason" ]] && printf 'last reason: %s\n' "$last_reason"
  [[ -n "$updated_at" ]] && printf 'updated at: %s\n' "$updated_at"
  printf 'config: %s\n' "$CONFIG_FILE"
  printf 'log file: %s\n' "$LOG_FILE"
}

logs_manager() {
  ensure_dirs
  local tail_lines="${TAIL_LINES:-200}"
  if [[ ! -f "$LOG_FILE" ]]; then
    log "log file does not exist yet: $LOG_FILE"
    return 0
  fi
  tail -n "$tail_lines" -f "$LOG_FILE"
}

TAIL_LINES=200
COMMAND="${1:-}"
if [[ -z "$COMMAND" ]]; then
  usage
  exit 2
fi
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_ROOT="$2"
      shift 2
      ;;
    --config)
      CONFIG_FILE="$2"
      shift 2
      ;;
    --tail)
      TAIL_LINES="$2"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

PID_FILE="$STATE_DIR/controller-ngrok-rotation.pid"
STATE_FILE="$STATE_DIR/controller-ngrok-rotation.state"
LOG_FILE="$LOG_DIR/controller-ngrok-rotation.log"
LOCK_DIR="$STATE_DIR/controller-ngrok-rotation.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"

case "$COMMAND" in
  start)
    start_manager
    ;;
  stop)
    stop_manager
    ;;
  status)
    status_manager
    ;;
  logs)
    logs_manager
    ;;
  supervise)
    rotation_run_supervisor
    ;;
  run|run-once)
    trap 'cleanup_worker' EXIT
    trap 'exit 0' INT TERM
    rotation_run_once
    ;;
  *)
    usage
    exit 2
    ;;
esac
