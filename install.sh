#!/usr/bin/env sh
set -eu

PACKAGE_NAME="repo-harness"
PACKAGE_VERSION="${REPO_HARNESS_VERSION:-latest}"
INSTALL_RUNTIME="${REPO_HARNESS_INSTALL_RUNTIME:-auto}"

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'repo-harness install: %s\n' "$*" >&2
  exit 1
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

HOME_DIR="${HOME:-}"
[ -n "$HOME_DIR" ] || die "HOME is not set"
BUN_INSTALL_DIR="${BUN_INSTALL:-$HOME_DIR/.bun}"

node_major() {
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0'
}

ensure_node() {
  has_command node || die "Node.js 20+ is required when Bun is not available. Install Node.js or set REPO_HARNESS_INSTALL_RUNTIME=bun."
  major="$(node_major)"
  [ "$major" -ge 20 ] || die "Node.js 20+ is required for Node fallback; found major version $major"
}

install_bun() {
  if has_command bun; then
    return 0
  fi

  has_command bash || die "bash is required to install Bun automatically"

  if has_command curl; then
    log "Installing Bun runtime..."
    curl -fsSL https://bun.sh/install | bash
  elif has_command wget; then
    log "Installing Bun runtime..."
    wget -qO- https://bun.sh/install | bash
  else
    die "curl or wget is required to install Bun automatically"
  fi

  export PATH="$BUN_INSTALL_DIR/bin:$PATH"
  has_command bun || die "Bun install completed, but bun is still not on PATH"
}

choose_runtime() {
  case "$INSTALL_RUNTIME" in
    bun)
      install_bun
      printf 'bun\n'
      ;;
    node)
      ensure_node
      has_command npm || die "npm is required for REPO_HARNESS_INSTALL_RUNTIME=node"
      printf 'node\n'
      ;;
    auto)
      if has_command bun; then
        printf 'bun\n'
      else
        ensure_node
        has_command npm || die "npm is required when Bun is unavailable"
        printf 'node\n'
      fi
      ;;
    *)
      die "invalid REPO_HARNESS_INSTALL_RUNTIME=$INSTALL_RUNTIME (expected auto, bun, node)"
      ;;
  esac
}

install_repo_harness() {
  runtime="$1"
  package_spec="${PACKAGE_NAME}@${PACKAGE_VERSION}"
  if [ "$runtime" = "bun" ]; then
    log "Installing ${package_spec} with Bun..."
    bun add -g "$package_spec"
  else
    log "Installing ${package_spec} with npm..."
    npm install -g "$package_spec" --omit=optional --no-audit --no-fund
  fi
}

verify_repo_harness() {
  export PATH="$BUN_INSTALL_DIR/bin:$PATH"
  has_command repo-harness || die "repo-harness is not on PATH after installation"
  version="$(repo-harness --version 2>/dev/null || true)"
  [ -n "$version" ] || die "repo-harness installed, but version readback failed"
  log "repo-harness ${version} installed."
}

if [ "${REPO_HARNESS_DRY_RUN:-0}" = "1" ]; then
  log "DRY RUN: would choose runtime (${INSTALL_RUNTIME}), install ${PACKAGE_NAME}@${PACKAGE_VERSION}, and verify repo-harness --version."
  exit 0
fi

runtime="$(choose_runtime)"
install_repo_harness "$runtime"
verify_repo_harness

log ""
log "Next:"
log "  repo-harness init"
log "  repo-harness adopt --dry-run"
