#!/bin/bash
set -euo pipefail

usage() {
  cat <<'USAGE_EOF'
Usage: scripts/check-deploy-sql-order.sh [--quiet] [--root deploy/sql]

Validates deployment SQL assets:
- deployment SQL files must live directly under deploy/sql/
- filenames must start with a 4-digit numeric prefix
- prefixes must be strictly ascending in filename order
- if tests/sql/control_plane_invariants.sql exists, it must reference every deployment SQL file

Example: deploy/sql/0001_create_tables.sql
USAGE_EOF
}

quiet=0
sql_root="deploy/sql"
invariant_file="tests/sql/control_plane_invariants.sql"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet)
      quiet=1
      shift
      ;;
    --root)
      sql_root="${2:-}"
      if [[ -z "$sql_root" ]]; then
        echo "--root requires a path" >&2
        exit 1
      fi
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

sql_root="${sql_root%/}"
deploy_root="${sql_root%%/sql}"
issues=0

report_issue() {
  echo "[deploy-sql] $1"
  issues=$((issues + 1))
}

if [[ "$sql_root" != "deploy/sql" ]]; then
  report_issue "SQL root must be deploy/sql; got: $sql_root"
fi

if [[ ! -d "$sql_root" ]]; then
  report_issue "Missing SQL directory: $sql_root"
else
  if [[ -d "$deploy_root" ]]; then
    while IFS= read -r file; do
      [[ -z "$file" ]] && continue
      if [[ "$file" != "$sql_root/"* ]]; then
        report_issue "Deploy SQL file must live under $sql_root/: $file"
        continue
      fi

      rel="${file#"$sql_root"/}"
      if [[ "$rel" == */* ]]; then
        report_issue "SQL file must be a direct child of $sql_root/: $file"
      fi
    done < <(find "$deploy_root" -type f -name '*.sql' | sort)
  fi

  previous_number=-1
  previous_file=""
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    base="$(basename "$file")"

    if [[ ! "$base" =~ ^([0-9]{4})[_-].+\.sql$ ]]; then
      report_issue "SQL filename must start with a 4-digit prefix: $file (example: deploy/sql/0001_create_tables.sql)"
      continue
    fi

    number="${BASH_REMATCH[1]}"
    number_value=$((10#$number))
    if (( previous_number >= 0 && number_value <= previous_number )); then
      report_issue "SQL prefixes must be strictly ascending: $previous_file before $file"
    fi

    previous_number="$number_value"
    previous_file="$file"
  done < <(find "$sql_root" -maxdepth 1 -type f -name '*.sql' | sort)

  if [[ -f "$invariant_file" ]]; then
    while IFS= read -r file; do
      [[ -z "$file" ]] && continue
      base="$(basename "$file")"
      if ! grep -Fq "$file" "$invariant_file" && ! grep -Fq "$base" "$invariant_file"; then
        report_issue "SQL migration must be referenced by $invariant_file: $file"
      fi
    done < <(find "$sql_root" -maxdepth 1 -type f -name '*.sql' | sort)
  fi
fi

if (( issues > 0 )); then
  exit 1
fi

if (( quiet == 0 )); then
  echo "[deploy-sql] OK"
fi
