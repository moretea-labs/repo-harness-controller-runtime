#!/usr/bin/env bash
# Audit tracked files for open-source release hygiene.
# Reports path + finding class only. Never prints secret values or full match bodies.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ALLOWLIST_FILE="${REPO_HARNESS_OPEN_SOURCE_ALLOWLIST:-scripts/open-source-audit-allowlist.txt}"
STRICT="${REPO_HARNESS_OPEN_SOURCE_AUDIT_STRICT:-1}"

echo "[open-source-audit] scanning tracked files (values redacted)"

declare -a TRACKED=()
while IFS= read -r tracked_path; do
  TRACKED+=("$tracked_path")
done < <(git ls-files)
if [[ ${#TRACKED[@]} -eq 0 ]]; then
  echo "[open-source-audit] ERROR: no tracked files" >&2
  exit 1
fi

declare -a ALLOWLIST=()
if [[ -f "$ALLOWLIST_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ -z "$line" ]] && continue
    ALLOWLIST+=("$line")
  done <"$ALLOWLIST_FILE"
fi

is_allowlisted() {
  local path="$1"
  local entry
  for entry in "${ALLOWLIST[@]:-}"; do
    if [[ "$path" == "$entry" || "$path" == $entry ]]; then
      return 0
    fi
  done
  return 1
}

# Runtime / credential-like paths that should not be tracked in a public surface.
declare -a FORBIDDEN_PATH_GLOBS=(
  '_ops/*'
  '.ai/local/*'
  '.ai/harness/jobs/*'
  '.ai/harness/local-jobs/*'
  '.ai/harness/runs/*'
  '.ai/harness/artifacts/*'
  '.ai/harness/worktrees/*'
  '.ai/harness/edit-sessions/*'
  'artifacts/*'
  'coverage/*'
  'tmp/*'
  'cache/*'
  '*.log'
  '**/*.log'
  '*.out'
  '**/*.out'
  '*.pid'
  '**/*.pid'
  '*.trace'
  '**/*.trace'
  '.env'
  '.env.*'
  '*.pem'
  '*.key'
  '*.p12'
  '*.pfx'
  '**/mcp.local.json'
  '**/mcp.tokens.json'
  '**/mcp.oauth.json'
  '**/mcp.oauth-tokens.json'
  '**/mcp.runtime.json'
  '**/*tokens*.json'
  '**/*secret*'
  '**/external-filesystem-grants.json'
  '**/.repo-harness/plugins/*.json'
)

path_forbidden=0
for path in "${TRACKED[@]}"; do
  for glob in "${FORBIDDEN_PATH_GLOBS[@]}"; do
    if [[ "$path" == $glob ]]; then
      if is_allowlisted "$path"; then
        continue
      fi
      echo "BLOCK path-runtime: $path"
      path_forbidden=$((path_forbidden + 1))
    fi
  done
done

# Content patterns. Match lines are never printed — only path + class + line number.
content_hits=0
scan_content() {
  local class="$1"
  local pattern="$2"
  local path line_no
  # Use rg for speed; silence if no matches.
  while IFS= read -r match; do
    path="${match%%:*}"
    rest="${match#*:}"
    line_no="${rest%%:*}"
    if is_allowlisted "$path"; then
      continue
    fi
    # Skip binary-ish / lock noise.
    case "$path" in
      bun.lock|package-lock.json|*.png|*.svg|*.jpg|*.jpeg|*.gif|*.webp|*.pdf) continue ;;
    esac
    echo "BLOCK content-${class}: ${path}:${line_no}"
    content_hits=$((content_hits + 1))
  done < <(git grep -n -I -E -e "$pattern" -- . || true)
}

# Personal absolute paths (common maintainer home roots). Placeholder hosts with example/your-machine are still scanned;
# real usernames beyond generic placeholders are the concern.
scan_content "personal-macos-path" '/Users/[A-Za-z0-9._-]+/'
scan_content "personal-linux-path" '/home/[A-Za-z0-9._-]+/'
scan_content "repo-id" 'repo_[0-9a-f]{24,}'
scan_content "checkout-id" 'checkout_[0-9a-f]{16,}'
scan_content "tailscale-host" '[a-z0-9-]+\.ts\.net'
scan_content "cg-nat" '100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}'
# Credential markers only — do not print match text.
scan_content "private-key-marker" '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
scan_content "aws-access-key" 'AKIA[0-9A-Z]{16}'
scan_content "github-token" 'gh[pousr]_[A-Za-z0-9_]{20,}'
scan_content "openai-style-secret" '(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}'

total=$((path_forbidden + content_hits))
echo "[open-source-audit] findings: path=${path_forbidden} content=${content_hits} total=${total}"

if [[ "$total" -gt 0 ]]; then
  echo "[open-source-audit] FAIL: tracked surface still contains personal/runtime/sensitive markers." >&2
  echo "[open-source-audit] Add justified paths to ${ALLOWLIST_FILE} or untrack/sanitize the files." >&2
  if [[ "$STRICT" == "1" ]]; then
    exit 1
  fi
  echo "[open-source-audit] STRICT=0 — continuing with warnings only."
  exit 0
fi

echo "[open-source-audit] OK"
