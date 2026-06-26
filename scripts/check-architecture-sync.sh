#!/bin/bash
set -euo pipefail

usage() {
  cat <<'USAGE_EOF'
Usage: scripts/check-architecture-sync.sh [--mode off|advisory|strict] [--target <branch>] [--changed-files <file>] [--format text|json]

Checks architecture request index integrity, then gates pending architecture
drift only for capabilities touched by the current branch or working tree.
USAGE_EOF
}

repo="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
repo="$(cd "$repo" && pwd)"
cd "$repo"

mode=""
target_branch=""
changed_files_file=""
format="text"

required_current_docs=(
  "docs/architecture/current/README.md"
  "docs/architecture/current/governance.md"
  "docs/architecture/current/system-overview.md"
  "docs/architecture/current/architecture-invariants.md"
  "docs/architecture/current/entity-model.md"
  "docs/architecture/current/job-and-run-lifecycle.md"
  "docs/architecture/current/dispatch-and-agent-strategy.md"
  "docs/architecture/current/scheduler-and-resource-claims.md"
  "docs/architecture/current/multi-repository-execution.md"
  "docs/architecture/current/automation-and-schedule-engine.md"
  "docs/architecture/current/failure-recovery.md"
  "docs/architecture/current/verification-and-release-gates.md"
  "docs/architecture/current/implementation-status.md"
  "docs/architecture/current/migration-roadmap.md"
  "docs/architecture/current/runtime-directory-map.md"
  "docs/architecture/current/operations-runbook.md"
)

historical_runtime_docs=(
  "docs/repo-harness-chatgpt-controller.md"
  "docs/repo-harness-local-execution-bridge.md"
  "docs/repo-harness-execution-closure-v5.md"
  "docs/repo-harness-direct-change-v6.md"
  "docs/repo-harness-execution-first-v7.md"
  "docs/repo-harness-chatgpt-bridge-v8.md"
  "docs/repo-harness-v8-verification.md"
)

runtime_architecture_gate_enabled() {
  [[ -d "docs/architecture/current" ]] && return 0
  local file
  for file in "${historical_runtime_docs[@]}"; do
    [[ -f "$file" ]] && return 0
  done
  [[ -f "docs/architecture/index.md" ]] && grep -Fq -- "Controller Runtime" "docs/architecture/index.md"
}

architecture_baseline_fail() {
  echo "[ArchitectureSync] current Controller Runtime architecture baseline failed: $1" >&2
  return 1
}

require_architecture_file() {
  local file="$1"
  [[ -f "$file" ]] || architecture_baseline_fail "missing required file $file"
}

require_architecture_text() {
  local file="$1"
  local text="$2"
  if ! require_architecture_file "$file"; then
    return 1
  fi
  grep -Fq -- "$text" "$file" || architecture_baseline_fail "$file must contain: $text"
}

check_runtime_architecture_baseline() {
  local file
  local failed=0
  require_architecture_text "docs/architecture/index.md" "Runtime Authority" || failed=1
  require_architecture_text "docs/architecture/index.md" "docs/architecture/current/" || failed=1
  require_architecture_text "docs/architecture/current/README.md" "Runtime Authority" || failed=1
  require_architecture_text "docs/architecture/current/governance.md" "Runtime Authority" || failed=1

  for file in "${required_current_docs[@]}"; do
    require_architecture_file "$file" || failed=1
  done

  for file in "${historical_runtime_docs[@]}"; do
    require_architecture_text "$file" "Historical Design" || failed=1
    require_architecture_text "$file" "Not Runtime Authority" || failed=1
    require_architecture_text "$file" "architecture/current/README.md" || failed=1
  done

  require_architecture_text "docs/architecture/current/architecture-invariants.md" "Invariant 2 — Persist Before Execute" || failed=1
  require_architecture_text "docs/architecture/current/architecture-invariants.md" "Invariant 4 — Task Is Intent; Run Is Attempt" || failed=1
  require_architecture_text "docs/architecture/current/architecture-invariants.md" "Invariant 16 — Evidence Binds to Exact Revision" || failed=1
  require_architecture_text "docs/architecture/current/architecture-invariants.md" "Invariant 21 — Scheduled Work Is Bounded" || failed=1
  require_architecture_text "docs/architecture/current/implementation-status.md" "## Completion Statement" || failed=1
  require_architecture_text "docs/architecture/current/migration-roadmap.md" "## P0" || failed=1
  require_architecture_text "docs/architecture/current/migration-roadmap.md" "## P5" || failed=1
  return "$failed"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ -n "${2:-}" ]] || { echo "check-architecture-sync: --mode requires a value" >&2; exit 2; }
      mode="$2"
      shift 2
      ;;
    --target)
      [[ -n "${2:-}" ]] || { echo "check-architecture-sync: --target requires a value" >&2; exit 2; }
      target_branch="$2"
      shift 2
      ;;
    --changed-files)
      [[ -n "${2:-}" ]] || { echo "check-architecture-sync: --changed-files requires a value" >&2; exit 2; }
      changed_files_file="$2"
      shift 2
      ;;
    --format)
      [[ -n "${2:-}" ]] || { echo "check-architecture-sync: --format requires a value" >&2; exit 2; }
      format="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "check-architecture-sync: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

policy_value() {
  local jq_path="$1"
  local default_value="$2"
  local value=""

  if [[ -f ".ai/harness/policy.json" ]] && command -v jq >/dev/null 2>&1; then
    value="$(jq -r "$jq_path // empty" .ai/harness/policy.json 2>/dev/null || true)"
  elif [[ -f ".ai/harness/policy.json" ]] && command -v node >/dev/null 2>&1; then
    value="$(POLICY_PATH="$jq_path" node -e '
const fs = require("fs");
const path = process.env.POLICY_PATH || "";
try {
  const policy = JSON.parse(fs.readFileSync(".ai/harness/policy.json", "utf8"));
  const keys = path.replace(/^\./, "").split(".");
  let value = policy;
  for (const key of keys) value = value && value[key];
  if (value === undefined || value === null || value === "") process.exit(1);
  process.stdout.write(String(value));
} catch {
  process.exit(1);
}
' 2>/dev/null || true)"
  fi

  printf '%s' "${value:-$default_value}"
}

severity_rank() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    critical) printf '4' ;;
    high) printf '3' ;;
    medium) printf '2' ;;
    low) printf '1' ;;
    *) printf '0' ;;
  esac
}

metadata_value() {
  local file="$1"
  local label="$2"
  [[ -f "$file" ]] || return 1
  awk -v label="> **${label}**:" '
    index($0, label) == 1 {
      value = substr($0, length(label) + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^`|`$/, "", value)
      print value
      exit
    }
  ' "$file"
}

normalize_repo_path() {
  local value="$1"
  value="${value#file://}"
  case "$value" in
    "$repo"/*) value="${value#$repo/}" ;;
    /*) return 1 ;;
    ./*) value="${value#./}" ;;
  esac
  value="${value%/}"
  case "$value" in
    ""|.|..|../*|*/../*|*$'\n'*|*$'\r'*) return 1 ;;
  esac
  printf '%s\n' "$value"
}

collect_changed_files() {
  local merge_base=""

  if [[ -n "$changed_files_file" ]]; then
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      normalize_repo_path "$path" || true
    done < "$changed_files_file"
    return 0
  fi

  if [[ -n "$target_branch" ]] && git rev-parse --verify --quiet "$target_branch" >/dev/null 2>&1; then
    merge_base="$(git merge-base HEAD "$target_branch" 2>/dev/null || true)"
  fi

  if [[ -n "$merge_base" ]]; then
    git diff --name-only --diff-filter=ACMRTUXB "$merge_base"...HEAD
  fi

  git status --porcelain=v1 --untracked-files=all | while IFS= read -r line; do
    path="${line:3}"
    case "$line" in
      R*|C*)
        path="${path##* -> }"
        ;;
    esac
    [[ -n "$path" ]] || continue
    normalize_repo_path "$path" || true
  done
}

pending_request_files() {
  [[ -d "docs/architecture/requests" ]] || return 0
  find "docs/architecture/requests" -maxdepth 1 -type f -name '*.md' | sort | while IFS= read -r request; do
    [[ "$(metadata_value "$request" "Status" || true)" == "Pending" ]] || continue
    printf '%s\n' "$request"
  done
}

pending_requests_for_capabilities() {
  local threshold="$1"
  local min_rank capability_set="$2"
  local request capability severity
  min_rank="$(severity_rank "$threshold")"

  while IFS= read -r request; do
    capability="$(metadata_value "$request" "Capability ID" || true)"
    capability="${capability:-root}"
    severity="$(metadata_value "$request" "Severity" || true)"
    [[ "$(severity_rank "$severity")" -ge "$min_rank" ]] || continue
    if printf '%s\n' "$capability_set" | grep -Fxq "$capability"; then
      printf '%s\t%s\t%s\n' "$capability" "$severity" "$request"
    fi
  done < <(pending_request_files)
}

mode="${mode:-$(policy_value '.architecture.freshness_gate' 'advisory')}"
target_branch="${target_branch:-$(policy_value '.worktree_strategy.merge_back.target' 'main')}"
threshold="$(policy_value '.architecture.gate_min_severity' 'medium')"

case "$mode" in
  off|advisory|strict) ;;
  *)
    echo "check-architecture-sync: unknown mode: $mode" >&2
    exit 1
    ;;
esac

# Structural authority checks are invariant and must run even when freshness gating is disabled.
if runtime_architecture_gate_enabled; then
  if ! check_runtime_architecture_baseline; then
    exit 1
  fi
fi

if [[ ! -x "scripts/architecture-queue.sh" ]]; then
  if [[ "$mode" == "strict" ]]; then
    echo "[ArchitectureSync] strict gate failed: missing scripts/architecture-queue.sh" >&2
    exit 1
  fi
  echo "[ArchitectureSync] WARN: missing scripts/architecture-queue.sh; skipping advisory freshness gate" >&2
  exit 0
fi

if ! bash scripts/architecture-queue.sh reindex --check >/dev/null; then
  echo "[ArchitectureSync] architecture request index is stale; run bash scripts/architecture-queue.sh reindex" >&2
  exit 1
fi

if [[ "$mode" == "off" ]]; then
  case "$format" in
    json) printf '{"mode":"off","changed_capabilities":0,"blocking":0}\n' ;;
    text) echo "[ArchitectureSync] mode=off changed_capabilities=0 blocking=0" ;;
    *) echo "check-architecture-sync: unsupported --format: $format" >&2; exit 2 ;;
  esac
  exit 0
fi

if ! command -v bun >/dev/null 2>&1 || [[ ! -f "scripts/capability-resolver.ts" ]]; then
  if [[ "$mode" == "strict" ]]; then
    echo "[ArchitectureSync] strict gate failed: missing bun or scripts/capability-resolver.ts" >&2
    exit 1
  fi
  echo "[ArchitectureSync] WARN: missing bun or scripts/capability-resolver.ts; skipping advisory freshness gate" >&2
  exit 0
fi

changed_files="$(collect_changed_files | sort -u)"
if [[ -z "$changed_files" ]]; then
  case "$format" in
    json) printf '{"mode":"%s","gate_min_severity":"%s","changed_capabilities":0,"blocking":0}\n' "$(json_escape "$mode")" "$(json_escape "$threshold")" ;;
    text) echo "[ArchitectureSync] mode=$mode gate_min_severity=$threshold changed_capabilities=0 blocking=0" ;;
    *) echo "check-architecture-sync: unsupported --format: $format" >&2; exit 2 ;;
  esac
  exit 0
fi

matches_json="$(printf '%s\n' "$changed_files" | bun scripts/capability-resolver.ts match --paths-from - --format json)"
capabilities="$(
  MATCHES_JSON="$matches_json" node -e '
const matches = JSON.parse(process.env.MATCHES_JSON || "[]");
const ids = new Set();
for (const item of matches) ids.add(item.capability_id || "root");
for (const id of [...ids].sort()) console.log(id);
'
)"
changed_count="$(printf '%s\n' "$capabilities" | sed '/^$/d' | wc -l | tr -d ' ')"
blocking_lines="$(pending_requests_for_capabilities "$threshold" "$capabilities")"
blocking_count="$(printf '%s\n' "$blocking_lines" | sed '/^$/d' | wc -l | tr -d ' ')"

case "$format" in
  json)
    blocking_json="$(
      printf '%s\n' "$blocking_lines" | awk -F '\t' 'NF >= 3 { printf "%s{\"capability_id\":\"%s\",\"severity\":\"%s\",\"request\":\"%s\"}", sep, $1, $2, $3; sep="," }'
    )"
    printf '{"mode":"%s","gate_min_severity":"%s","changed_capabilities":%s,"blocking":%s,"blocking_requests":[%s]}\n' \
      "$(json_escape "$mode")" "$(json_escape "$threshold")" "$changed_count" "$blocking_count" "$blocking_json"
    ;;
  text)
    echo "[ArchitectureSync] mode=$mode gate_min_severity=$threshold changed_capabilities=$changed_count blocking=$blocking_count"
    if [[ "$blocking_count" -gt 0 ]]; then
      printf '%s\n' "$blocking_lines" | while IFS=$'\t' read -r capability severity request; do
        [[ -n "$capability" ]] || continue
        echo "[ArchitectureSync] pending $severity $capability -> $request"
      done
    fi
    ;;
  *)
    echo "check-architecture-sync: unsupported --format: $format" >&2
    exit 2
    ;;
esac

if [[ "$blocking_count" -gt 0 ]]; then
  if [[ "$mode" == "strict" ]]; then
    echo "[ArchitectureSync] strict gate failed: changed capabilities have pending architecture requests" >&2
    exit 1
  fi
  echo "[ArchitectureSync] WARN: changed capabilities have pending architecture requests" >&2
fi

exit 0
