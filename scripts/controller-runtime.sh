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
  "$LOCAL_CLI" controller service "$@"
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
  start)
    run_controller_service start "$@"
    maybe_manage_external_tunnel start
    ;;
  stop)
    maybe_manage_external_tunnel stop
    run_controller_service stop "$@"
    ;;
  restart)
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
    exec "$LOCAL_CLI" controller service logs "$@"
    ;;
  *)
    exec "$LOCAL_CLI" controller service "$COMMAND" "$@"
    ;;
esac
