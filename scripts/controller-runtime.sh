#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/controller-home-env.sh
source "$ROOT/scripts/lib/controller-home-env.sh"

repo_harness_use_local_controller_home "$ROOT"

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
