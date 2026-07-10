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

ensure_git() {
  has_command git || die "Git is required. Install Git and reopen the terminal."
}

ensure_node() {
  has_command node || die "Node.js 20.10 or newer is required because the published repo-harness launcher uses Node."
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 10) ? 0 : 1)' \
    || die "Node.js 20.10 or newer is required; found $(node --version 2>/dev/null || printf unknown)"
}

install_bun() {
  if has_command bun; then
    return 0
  fi

  has_command bash || die "bash is required to install Bun automatically"

  if has_command curl; then
    printf '%s\n' "Installing Bun runtime..." >&2
    curl -fsSL https://bun.sh/install | bash
  elif has_command wget; then
    printf '%s\n' "Installing Bun runtime..." >&2
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
      has_command npm || die "npm is required for REPO_HARNESS_INSTALL_RUNTIME=node"
      printf 'node\n'
      ;;
    auto)
      if has_command bun; then
        printf 'bun\n'
      else
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
  has_command repo-harness || die "repo-harness is not on PATH after installation. Reopen the terminal or add the package-manager global bin directory to PATH."
  version="$(repo-harness --version 2>/dev/null || true)"
  [ -n "$version" ] || die "repo-harness installed, but version readback failed"
  repo-harness doctor --help >/dev/null 2>&1 || die "repo-harness installed, but the doctor command could not be loaded"
  log "repo-harness ${version} installed."
}

if [ "${REPO_HARNESS_DRY_RUN:-0}" = "1" ]; then
  log "DRY RUN: would require Git and Node.js 20.10+, choose runtime (${INSTALL_RUNTIME}), install ${PACKAGE_NAME}@${PACKAGE_VERSION}, and verify the CLI."
  exit 0
fi

ensure_git
ensure_node
runtime="$(choose_runtime)"
install_repo_harness "$runtime"
verify_repo_harness

log ""
log "Next:"
log "  repo-harness install --no-cli"
log "  repo-harness doctor"
log "  repo-harness adopt --repo /path/to/your-project --dry-run"
