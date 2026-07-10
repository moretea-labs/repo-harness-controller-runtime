#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

required=(
  README.md
  README.en.md
  docs/README.md
  docs/tutorials/README.md
  docs/tutorials/README.zh-CN.md
  docs/tutorials/01-install-and-start.md
  docs/tutorials/01-install-and-start.zh-CN.md
  docs/tutorials/02-connect-chatgpt.md
  docs/tutorials/02-connect-chatgpt.zh-CN.md
  docs/tutorials/03-first-repository-task.md
  docs/tutorials/03-first-repository-task.zh-CN.md
  docs/researches/README.md
)

for path in "${required[@]}"; do
  [[ -f "$path" ]] || { echo "[public-docs] missing: $path" >&2; exit 1; }
done

if git grep -n -E 'controller_capabilities and project_snapshot|Start repository work with controller_capabilities|20260612-legacy-research-notes' -- README.md README.en.md docs ':!docs/architecture/history/**' ':!docs/architecture/snapshots/**' >/dev/null; then
  echo "[public-docs] stale onboarding or removed legacy reference found" >&2
  exit 1
fi

node -e '
const p=require("./package.json");
const files=new Set(p.files||[]);
for (const x of ["docs/README.md","docs/tutorials/"]) {
  if (!files.has(x)) throw new Error(`package files missing ${x}`);
}
if (!String(p.repository?.url||"").includes("moretea-labs/repo-harness-controller-runtime")) {
  throw new Error("package repository metadata is not canonical");
}
'

echo "[public-docs] OK"
