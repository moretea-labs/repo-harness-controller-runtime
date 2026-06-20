#!/bin/bash
set -euo pipefail

usage() {
  cat <<'USAGE_EOF'
Usage:
  scripts/archive-architecture-request.sh --request <docs/architecture/requests/file.md> --status <resolved|superseded|rejected|no-change> [--artifact <path>] [--note <text>]

Archives a handled architecture drift request without making semantic architecture decisions.
USAGE_EOF
}

repo="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
repo="$(cd "$repo" && pwd)"
cd "$repo"

request_file=""
status=""
note=""
artifacts=()

safe_token() {
  local value="$1"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  value="$(printf '%s' "$value" | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-{2,}/-/g')"
  printf '%s' "${value:-request}"
}

repo_relative_path() {
  local value="$1"
  value="${value#file://}"
  case "$value" in
    "$repo"/*)
      value="${value#$repo/}"
      ;;
    /*)
      return 1
      ;;
    ./*)
      value="${value#./}"
      ;;
  esac

  case "$value" in
    ""|.|..|../*|*/../*|*$'\n'*|*$'\r'*)
      return 1
      ;;
  esac

  printf '%s' "$value"
}

canonical_status() {
  case "$(safe_token "$1")" in
    resolved)
      printf 'Resolved'
      ;;
    superseded)
      printf 'Superseded'
      ;;
    rejected)
      printf 'Rejected'
      ;;
    no-change|no-architecture-change|no-arch-change)
      printf 'No architecture change'
      ;;
    *)
      return 1
      ;;
  esac
}

clear_contract_pending_request() {
  local rel_request="$1"
  local short_request="${rel_request#docs/architecture/}"
  local file tmp

  find . \
    \( -path './.git' -o -path './node_modules' -o -path './_ref' -o -path './_ops' \) -prune -o \
    \( -name 'AGENTS.md' -o -name 'CLAUDE.md' \) -type f -print 2>/dev/null |
    while IFS= read -r file; do
      if ! grep -Fq "Pending architecture request: \`${rel_request}\`" "$file" &&
         ! grep -Fq "Pending architecture request: \`${short_request}\`" "$file"; then
        continue
      fi
      tmp="$(mktemp)" || continue
      awk -v rel="$rel_request" -v short="$short_request" '
        index($0, "Pending architecture request: `" rel "`") > 0 ||
        index($0, "Pending architecture request: `" short "`") > 0 {
          print "- Pending architecture request: `(none)`"
          next
        }
        { print }
      ' "$file" > "$tmp"
      mv "$tmp" "$file"
      echo "[ArchitectureArchive] Cleared pending architecture request in ${file#./}"
    done
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --request)
      [[ -n "${2:-}" ]] || { echo "archive-architecture-request: --request requires a value" >&2; exit 2; }
      request_file="$2"
      shift 2
      ;;
    --status)
      [[ -n "${2:-}" ]] || { echo "archive-architecture-request: --status requires a value" >&2; exit 2; }
      status="$2"
      shift 2
      ;;
    --artifact)
      [[ -n "${2:-}" ]] || { echo "archive-architecture-request: --artifact requires a value" >&2; exit 2; }
      artifacts+=("$2")
      shift 2
      ;;
    --note)
      [[ -n "${2:-}" ]] || { echo "archive-architecture-request: --note requires a value" >&2; exit 2; }
      note="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "archive-architecture-request: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$request_file" || -z "$status" ]]; then
  usage >&2
  exit 2
fi

rel_request="$(repo_relative_path "$request_file" || true)"
if [[ -z "$rel_request" ]]; then
  echo "archive-architecture-request: unsafe request path: $request_file" >&2
  exit 2
fi

case "$rel_request" in
  docs/architecture/requests/*.md)
    ;;
  *)
    echo "archive-architecture-request: request must be under docs/architecture/requests/: $rel_request" >&2
    exit 2
    ;;
esac

case "$rel_request" in
  docs/architecture/requests/archive/*)
    echo "archive-architecture-request: request is already archived: $rel_request" >&2
    exit 2
    ;;
esac

if [[ ! -f "$rel_request" ]]; then
  echo "archive-architecture-request: request not found: $rel_request" >&2
  exit 1
fi

resolved_status="$(canonical_status "$status" || true)"
if [[ -z "$resolved_status" ]]; then
  echo "archive-architecture-request: unsupported status: $status" >&2
  usage >&2
  exit 2
fi

artifact_lines=()
if [[ "${#artifacts[@]}" -gt 0 ]]; then
  for artifact in "${artifacts[@]-}"; do
    [[ -n "$artifact" ]] || continue
    rel_artifact="$(repo_relative_path "$artifact" || true)"
    if [[ -z "$rel_artifact" ]]; then
      echo "archive-architecture-request: unsafe artifact path: $artifact" >&2
      exit 2
    fi
    artifact_lines+=("- \`${rel_artifact}\`")
  done
fi

archive_year="$(date '+%Y')"
archive_dir="docs/architecture/requests/archive/${archive_year}"
archive_file="${archive_dir}/$(basename "$rel_request")"
if [[ -e "$archive_file" ]]; then
  archive_file="${archive_dir}/$(date '+%Y%m%d-%H%M%S')-$(basename "$rel_request")"
fi

mkdir -p "$archive_dir"

tmp_file="$(mktemp)"
awk -v status="$resolved_status" '
  BEGIN { replaced = 0 }
  /^\> \*\*Status\*\*:/ {
    print "> **Status**: " status
    replaced = 1
    next
  }
  { print }
  END {
    if (replaced == 0) {
      print ""
      print "> **Status**: " status
    }
  }
' "$rel_request" > "$tmp_file"

{
  echo ""
  echo "## Archive Resolution"
  echo ""
  echo "- Status: ${resolved_status}"
  echo "- Archived: $(date '+%Y-%m-%dT%H:%M:%S%z')"
  if [[ "${#artifact_lines[@]}" -gt 0 ]]; then
    echo "- Artifacts:"
    printf '%s\n' "${artifact_lines[@]}"
  else
    echo "- Artifacts: (none)"
  fi
  if [[ -n "$note" ]]; then
    echo "- Note: ${note}"
  fi
} >> "$tmp_file"

mv "$tmp_file" "$archive_file"
rm -f "$rel_request"

index_file="docs/architecture/index.md"
if [[ -f "$index_file" ]]; then
  index_tmp="$(mktemp)"
  awk -v rel="$rel_request" -v short="${rel_request#docs/architecture/}" '
    index($0, rel) == 0 && index($0, short) == 0 { print }
  ' "$index_file" > "$index_tmp"
  mv "$index_tmp" "$index_file"
fi

clear_contract_pending_request "$rel_request"

echo "[ArchitectureArchive] Archived ${rel_request} -> ${archive_file}"
echo "[ArchitectureArchive] status=${resolved_status}"
