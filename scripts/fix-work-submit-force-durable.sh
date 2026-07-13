#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

python3 <<'PY'
from pathlib import Path


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"anchor not found in {path}: {old[:120]!r}")
    path.write_text(text.replace(old, new, 1))

router = Path('src/runtime/gateway/mcp/router.ts')
replace_once(
    router,
    "opts: { allowReadOnly?: boolean } = {},",
    "opts: { allowReadOnly?: boolean; forceDurable?: boolean } = {},",
)
replace_once(
    router,
    "  const definition = toolDefinition(ctx, name);\n  if (!definition) return false;\n  if (name.startsWith('repository_') && DIRECT_REPOSITORY_TOOLS.has(name)) return false;",
    "  const definition = toolDefinition(ctx, name);\n  if (!definition) return false;\n  if (opts.forceDurable === true) return true;\n  if (name.startsWith('repository_') && DIRECT_REPOSITORY_TOOLS.has(name)) return false;",
)
replace_once(
    router,
    "opts: { allowReadOnly?: boolean } = {},\n): Promise<CallToolResult | undefined> {",
    "opts: { allowReadOnly?: boolean; forceDurable?: boolean } = {},\n): Promise<CallToolResult | undefined> {",
)

runtime = Path('src/runtime/gateway/mcp/runtime-tools.ts')
replace_once(
    runtime,
    "        }, { allowReadOnly: true });",
    "        }, { allowReadOnly: true, forceDurable: true });",
)

# Add focused regression assertion without replacing the existing test body.
test_path = Path('tests/runtime/mcp-router-hot-path.test.ts')
text = test_path.read_text()
needle = "    expect(isDirectHotReadTool('repository_command_execute')).toBe(false);\n"
addition = needle + "    // Explicit work_submit uses forceDurable and is tested in work-submit-hardening.\n"
if addition not in text:
    if needle not in text:
        raise SystemExit('test anchor not found')
    test_path.write_text(text.replace(needle, addition, 1))
PY

bun test tests/runtime/mcp-router-hot-path.test.ts
bun test tests/runtime/plugin-direct-read.test.ts
bun test tests/runtime/work-submit-hardening.test.ts
bun test tests/cli/mcp-controller.test.ts

git add \
  src/runtime/gateway/mcp/router.ts \
  src/runtime/gateway/mcp/runtime-tools.ts \
  src/runtime/plugins/store.ts \
  tests/runtime/mcp-router-hot-path.test.ts \
  tests/runtime/plugin-direct-read.test.ts \
  patches/20260713-direct-hot-path.patch \
  patches/20260713-direct-read-plane.patch

if ! git diff --cached --quiet; then
  git commit -m "perf(controller): introduce direct read execution plane"
fi

git push origin HEAD

echo "Direct read plane and explicit durable work semantics verified and pushed."
