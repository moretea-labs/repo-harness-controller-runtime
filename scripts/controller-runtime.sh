#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/controller-home-env.sh
source "$ROOT/scripts/lib/controller-home-env.sh"

repo_harness_use_local_controller_home "$ROOT"

# Local HTTP/SOCKS proxies must not intercept Tailscale Funnel / MagicDNS or loopback.
# Bun fetch only honors leading-dot NO_PROXY forms for multi-label hosts (e.g. .ts.net).
# Portable (bash 3.2+): avoid associative arrays.
repo_harness_merge_no_proxy() {
  local existing="${NO_PROXY:-${no_proxy:-}}"
  local required="127.0.0.1,localhost,::1,.local,.ts.net,*.ts.net,.tailscale.com,*.tailscale.com,100.64.0.0/10"
  local merged=""
  local entry key
  local old_ifs="$IFS"
  IFS=','
  # shellcheck disable=SC2086
  set -- ${existing},${required}
  IFS="$old_ifs"
  for entry in "$@"; do
    entry="$(printf '%s' "$entry" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$entry" ] || continue
    key="$(printf '%s' "$entry" | tr '[:upper:]' '[:lower:]')"
    case ",${merged}," in
      *",${entry},"*|*",${key},"*) continue ;;
    esac
    # Case-insensitive dedupe against already-merged entries.
    if printf '%s' ",${merged}," | tr '[:upper:]' '[:lower:]' | grep -F ",${key}," >/dev/null 2>&1; then
      continue
    fi
    if [ -n "$merged" ]; then
      merged="${merged},${entry}"
    else
      merged="$entry"
    fi
  done
  export NO_PROXY="$merged"
  export no_proxy="$merged"
}
repo_harness_merge_no_proxy

cd "$ROOT"
LEGACY_NGROK_MANAGER="$ROOT/scripts/controller-ngrok-rotation.sh"
LOCAL_CLI="$ROOT/scripts/repo-harness-local.sh"
TUNNEL_CONFIG_DEFAULT="$ROOT/_ops/secrets/controller-ngrok-rotation.env"
TUNNEL_CONFIG="${REPO_HARNESS_NGROK_ROTATION_CONFIG:-$TUNNEL_CONFIG_DEFAULT}"
EXTERNAL_TUNNEL_MANAGER="${REPO_HARNESS_CONTROLLER_EXTERNAL_TUNNEL:-none}"

command -v bun >/dev/null 2>&1 || {
  echo "Bun is required to manage the repo-harness Controller stack." >&2
  exit 127
}

if [ "$#" -eq 0 ]; then
  echo "Usage: scripts/controller-runtime.sh <start|stop|status|restart|logs> [args...]" >&2
  echo "Controller home: $REPO_HARNESS_CONTROLLER_HOME" >&2
  echo "External tunnel manager: $EXTERNAL_TUNNEL_MANAGER (set REPO_HARNESS_CONTROLLER_EXTERNAL_TUNNEL=ngrok to enable legacy ngrok rotation)" >&2
  exit 2
fi

run_controller_service() {
  local action="${1:?controller service action is required}"
  shift
  "$LOCAL_CLI" controller service "$action" --repo "$ROOT" --controller-home "$REPO_HARNESS_CONTROLLER_HOME" "$@"
}

controller_daemon_pid() {
  local pid_file="$REPO_HARNESS_CONTROLLER_HOME/daemon/controller.pid"
  [ -f "$pid_file" ] || return 1
  tr -d '[:space:]' < "$pid_file"
}

pid_is_ancestor() {
  local target_pid="$1"
  local current_pid="$$"
  local parent_pid
  while [ "$current_pid" -gt 1 ] 2>/dev/null; do
    [ "$current_pid" = "$target_pid" ] && return 0
    parent_pid="$(ps -o ppid= -p "$current_pid" 2>/dev/null | tr -d '[:space:]')"
    case "$parent_pid" in
      ''|*[!0-9]*) return 1 ;;
    esac
    current_pid="$parent_pid"
  done
  return 1
}

restart_requires_detached_coordinator() {
  [ "${REPO_HARNESS_FORCE_DETACHED_RESTART:-0}" = "1" ] && return 0
  local daemon_pid
  daemon_pid="$(controller_daemon_pid 2>/dev/null || true)"
  case "$daemon_pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$daemon_pid" 2>/dev/null || return 1
  pid_is_ancestor "$daemon_pid"
}

schedule_detached_restart() {
  local log_dir="$ROOT/.ai/local/logs"
  local log_file="$log_dir/controller-restart-coordinator.log"
  mkdir -p "$log_dir"
  REPO_HARNESS_RESTART_COORDINATOR=1 \
    nohup bash "$0" __restart_coordinator "$@" >>"$log_file" 2>&1 </dev/null &
  local coordinator_pid=$!
  echo "Controller restart scheduled via detached coordinator pid=$coordinator_pid"
  echo "Restart log: $log_file"
}

maybe_manage_external_tunnel() {
  local action="$1"
  shift

  case "$EXTERNAL_TUNNEL_MANAGER" in
    none|disabled|off|"")
      if [ "$action" = "status" ]; then
        echo
        echo "external tunnel manager: disabled"
      fi
      return 0
      ;;
    ngrok)
      ;;
    *)
      echo "Unsupported REPO_HARNESS_CONTROLLER_EXTERNAL_TUNNEL=$EXTERNAL_TUNNEL_MANAGER (expected: none or ngrok)" >&2
      return 2
      ;;
  esac

  if [ ! -x "$LEGACY_NGROK_MANAGER" ] || [ ! -f "$TUNNEL_CONFIG" ]; then
    if [ "$action" = "status" ]; then
      echo
      echo "ngrok rotation: unavailable"
    fi
    return 0
  fi

  case "$action" in
    start)
      "$LEGACY_NGROK_MANAGER" start --repo "$ROOT" --config "$TUNNEL_CONFIG"
      ;;
    stop)
      "$LEGACY_NGROK_MANAGER" stop --repo "$ROOT" --config "$TUNNEL_CONFIG"
      ;;
    status)
      echo
      "$LEGACY_NGROK_MANAGER" status --repo "$ROOT" --config "$TUNNEL_CONFIG"
      ;;
    restart)
      "$LEGACY_NGROK_MANAGER" stop --repo "$ROOT" --config "$TUNNEL_CONFIG" || true
      "$LEGACY_NGROK_MANAGER" start --repo "$ROOT" --config "$TUNNEL_CONFIG"
      ;;
  esac
}

COMMAND="$1"
shift || true

case "$COMMAND" in
  __restart_coordinator)
    # The caller may be a Worker owned by the daemon being replaced. Wait for
    # that caller to exit so this process is re-parented outside the old daemon
    # tree before stopping the complete stack.
    sleep "${REPO_HARNESS_RESTART_COORDINATOR_DELAY_SECONDS:-2}"
    maybe_manage_external_tunnel stop
    run_controller_service restart "$@"
    maybe_manage_external_tunnel start
    ;;
  start)
    run_controller_service start "$@"
    maybe_manage_external_tunnel start
    ;;
  stop)
    maybe_manage_external_tunnel stop
    run_controller_service stop "$@"
    ;;
  restart)
    if [ "${REPO_HARNESS_RESTART_COORDINATOR:-0}" != "1" ] && restart_requires_detached_coordinator; then
      schedule_detached_restart "$@"
      exit 0
    fi
    maybe_manage_external_tunnel stop
    run_controller_service restart "$@"
    maybe_manage_external_tunnel start
    ;;
  status)
    run_controller_service status "$@"
    maybe_manage_external_tunnel status
    ;;
  logs)
    if [ "${1:-}" = "tunnel" ]; then
      shift
      if [ "$EXTERNAL_TUNNEL_MANAGER" != "ngrok" ]; then
        echo "external tunnel manager is disabled; set REPO_HARNESS_CONTROLLER_EXTERNAL_TUNNEL=ngrok to read legacy ngrok logs" >&2
        exit 2
      fi
      exec "$LEGACY_NGROK_MANAGER" logs --repo "$ROOT" --config "$TUNNEL_CONFIG" "$@"
    fi
    exec "$LOCAL_CLI" controller service logs --repo "$ROOT" --controller-home "$REPO_HARNESS_CONTROLLER_HOME" "$@"
    ;;
  *)
    exec "$LOCAL_CLI" controller service "$COMMAND" --repo "$ROOT" --controller-home "$REPO_HARNESS_CONTROLLER_HOME" "$@"
    ;;
esac
