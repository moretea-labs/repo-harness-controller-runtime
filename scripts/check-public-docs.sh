#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

required=(
  README.md
  README.en.md
  README.zh-CN.md
  docs/README.md
  docs/tutorials/README.md
  docs/tutorials/README.zh-CN.md
  docs/tutorials/01-install-and-start.md
  docs/tutorials/01-install-and-start.zh-CN.md
  docs/tutorials/02-connect-chatgpt.md
  docs/tutorials/02-connect-chatgpt.zh-CN.md
  docs/tutorials/03-first-repository-task.md
  docs/tutorials/03-first-repository-task.zh-CN.md
  docs/operations/releasing.md
  docs/operations/releasing.zh-CN.md
  docs/operations/platform-support.md
  docs/operations/platform-support.zh-CN.md
  docs/operations/features.md
  docs/operations/features.zh-CN.md
  docs/operations/troubleshooting.md
  docs/operations/troubleshooting.zh-CN.md
  docs/researches/README.md
)

for path in "${required[@]}"; do
  [[ -f "$path" ]] || { echo "[public-docs] missing: $path" >&2; exit 1; }
done

if git grep -n -E 'controller_capabilities and project_snapshot|Start repository work with controller_capabilities|20260612-legacy-research-notes|github.com/greysonOuyang/' -- README*.md docs ':!docs/architecture/history/**' ':!docs/architecture/snapshots/**' >/dev/null; then
  echo "[public-docs] stale onboarding, personal repository URL, or removed legacy reference found" >&2
  exit 1
fi

for path in README.md README.en.md docs/tutorials/01-install-and-start.md docs/tutorials/01-install-and-start.zh-CN.md; do
  grep -q 'Node.js 20.10' "$path" || { echo "[public-docs] missing Node baseline: $path" >&2; exit 1; }
  grep -q '@moretea-labs/repo-harness-controller@next' "$path" || { echo "[public-docs] missing RC install reference: $path" >&2; exit 1; }
done

for path in docs/operations/releasing.md docs/operations/releasing.zh-CN.md; do
  grep -q '@moretea-labs/repo-harness-controller@next' "$path" || { echo "[public-docs] missing scoped package reference: $path" >&2; exit 1; }
  grep -q 'repo-harness-hook' "$path" || { echo "[public-docs] missing CLI identity note: $path" >&2; exit 1; }
done

grep -q 'WSL2' docs/operations/platform-support.md || { echo "[public-docs] platform matrix missing WSL2" >&2; exit 1; }
grep -q 'Windows 原生' docs/operations/platform-support.zh-CN.md || { echo "[public-docs] Chinese platform matrix missing native Windows scope" >&2; exit 1; }
grep -q 'rh_status' docs/tutorials/02-connect-chatgpt.md || { echo "[public-docs] connector tutorial missing facade verification" >&2; exit 1; }

node -e '
const p=require("./package.json");
const files=new Set(p.files||[]);
for (const x of ["LICENSE","NOTICE","THIRD_PARTY_NOTICES.md","README.en.md","README.zh-CN.md","docs/README.md","docs/tutorials/","docs/operations/"]) {
  if (!files.has(x)) throw new Error(`package files missing ${x}`);
}
if (!String(p.repository?.url||"").includes("moretea-labs/repo-harness-controller-runtime")) {
  throw new Error("package repository metadata is not canonical");
}
'

echo "[public-docs] OK"
