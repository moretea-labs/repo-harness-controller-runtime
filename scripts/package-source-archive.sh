#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'EOF'
Usage: scripts/package-source-archive.sh [output.zip]

Build a portable source archive from the current working tree.
The archive excludes rebuildable dependencies, Git metadata, and machine-local runtime state.
EOF
}

fail() {
  echo "source-archive: $*" >&2
  exit 1
}

normalize_path() {
  local value="${1#./}"
  printf '%s\n' "${value%/}"
}

is_allowed_ai_path() {
  case "$1" in
    .ai/context/*) return 0 ;;
    .ai/hooks/*) return 0 ;;
    .ai/harness/brain-manifest.json) return 0 ;;
    .ai/harness/policy.json) return 0 ;;
    .ai/harness/workflow-contract.json) return 0 ;;
    .ai/harness/*/.gitkeep) return 0 ;;
    .ai/harness/*/*/.gitkeep) return 0 ;;
    *) return 1 ;;
  esac
}

should_include() {
  local path
  path="$(normalize_path "$1")"
  [[ -n "$path" ]] || return 1

  case "$path" in
    node_modules|node_modules/*) return 1 ;;
    .git|.git/*) return 1 ;;
    .codegraph|.codegraph/*) return 1 ;;
    _ops|_ops/*) return 1 ;;
    coverage|coverage/*) return 1 ;;
    artifacts|artifacts/*) return 1 ;;
    autoresearch|autoresearch/*) return 1 ;;
    .DS_Store|*/.DS_Store) return 1 ;;
    *.log|*.tgz|*.tar.gz|*.zip) return 1 ;;
    SOURCE_ARCHIVE_MANIFEST.sha256) return 1 ;;
    .ai|.ai/*)
      is_allowed_ai_path "$path"
      return
      ;;
    *)
      return 0
      ;;
  esac
}

copy_path() {
  local rel="$1"
  local source="$ROOT/$rel"
  local target="$STAGE_ROOT/$rel"

  if [[ -L "$source" ]]; then
    fail "symlink is not allowed in source archive: $rel"
  fi
  if [[ -d "$source" ]]; then
    return 0
  fi
  if [[ ! -f "$source" ]]; then
    fail "missing source file: $rel"
  fi

  mkdir -p "$(dirname "$target")"
  cp "$source" "$target"
}

build_manifest() {
  local manifest="$STAGE_ROOT/SOURCE_ARCHIVE_MANIFEST.sha256"
  : >"$manifest"
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    local file="${rel#./}"
    [[ "$file" == "SOURCE_ARCHIVE_MANIFEST.sha256" ]] && continue
    shasum -a 256 "$file"
  done < <(
    cd "$STAGE_ROOT"
    find . -type f | LC_ALL=C sort
  ) >>"$manifest"
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi

TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
ARCHIVE_STEM="repo-harness-source-${TIMESTAMP}"
OUTPUT="${1:-$ROOT/artifacts/source-archives/${ARCHIVE_STEM}.zip}"
[[ "$OUTPUT" == *.zip ]] || OUTPUT="${OUTPUT}.zip"
[[ "$OUTPUT" == /* ]] || OUTPUT="$ROOT/$OUTPUT"

mkdir -p "$(dirname "$OUTPUT")"
[[ ! -e "$OUTPUT" ]] || fail "output already exists: $OUTPUT"

STAGE_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/repo-harness-source-archive.XXXXXX")"
trap 'rm -rf "$STAGE_PARENT"' EXIT
STAGE_ROOT="$STAGE_PARENT/$ARCHIVE_STEM"
mkdir -p "$STAGE_ROOT"

included_count=0
while IFS= read -r -d '' rel; do
  rel="$(normalize_path "$rel")"
  should_include "$rel" || continue
  copy_path "$rel"
  included_count=$((included_count + 1))
done < <(git ls-files --cached --others --exclude-standard -z)

(( included_count > 0 )) || fail "no files selected for archive"

build_manifest

(
  cd "$STAGE_PARENT"
  zip -qr "$OUTPUT" "$ARCHIVE_STEM"
)

if unzip -Z -1 "$OUTPUT" | rg -q '(^|/)node_modules/'; then
  fail "archive unexpectedly contains node_modules"
fi
if unzip -Z -1 "$OUTPUT" | rg -q '(^|/)\.git/'; then
  fail "archive unexpectedly contains .git"
fi

echo "source archive ready: $OUTPUT"
echo "included files: $included_count + SOURCE_ARCHIVE_MANIFEST.sha256"
