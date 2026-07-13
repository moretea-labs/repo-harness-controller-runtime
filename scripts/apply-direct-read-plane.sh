#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

BRANCH="$(git branch --show-current)"
if [[ "$BRANCH" != "perf/direct-hot-path-20260713" ]]; then
  echo "Expected branch perf/direct-hot-path-20260713, got $BRANCH" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Tracked worktree changes exist. Commit or stash them before running this migration." >&2
  git status --short
  exit 1
fi

python3 <<'PY'
from pathlib import Path


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"anchor not found in {path}: {old[:100]!r}")
    path.write_text(text.replace(old, new, 1))

router = Path('src/runtime/gateway/mcp/router.ts')
replace_once(
    router,
    "const DIRECT_HOT_READ_TOOLS = new Set([\n  'get_task_run', 'get_task_run_events', 'get_task_run_log',\n]);",
    """/** High-frequency bounded reads execute in the current MCP request. */
const DIRECT_HOT_READ_TOOLS = new Set([
  'get_task_run', 'get_task_run_events', 'get_task_run_log',
  'get_job', 'list_jobs',
  'work_get', 'work_list', 'work_status_digest', 'work_result_summary',
  'controller_ready', 'repository_runtime_snapshot',
  'rh_status', 'rh_context', 'rh_inbox',
  'controller_context', 'controller_context_pack',
  'repository_git_status', 'repository_git_diff', 'git_diff_paths',
]);

export function isDirectHotReadTool(name: string): boolean {
  return DIRECT_HOT_READ_TOOLS.has(name);
}""",
)
replace_once(
    router,
    """function wantsWaitForResult(args: Record<string, unknown>): boolean {
  return args.wait === true
    || args.await_result === true
    || args.wait_for_result === true
    || typeof args.wait_ms === 'number';
}""",
    """export function wantsWaitForResult(args: Record<string, unknown>): boolean {
  return args.wait === true
    || args.await_result === true
    || args.wait_for_result === true;
}""",
)
replace_once(router, "function waitTimeoutMs(args: Record<string, unknown>): number {", "export function waitTimeoutMs(args: Record<string, unknown>): number {")
replace_once(router, "if (DIRECT_HOT_READ_TOOLS.has(name)) return false;", "if (isDirectHotReadTool(name)) return false;")
replace_once(
    router,
    "description: 'Max wait for terminal job result when wait=true. Default 15000, max 120000.',",
    "description: 'Max wait for terminal job result. Only used when wait=true; never enables waiting by itself. Default 15000, max 120000.',",
)
replace_once(
    router,
    "? `Still ${waited.job.status}. Call get_job/work_get with wait=true again, or inspect job_id ${waited.job.jobId}.`",
    "? `Still ${waited.job.status}. Poll get_job/work_get without waiting; use work_wait only when blocking is explicitly required.`",
)
replace_once(
    router,
    "next: `Call get_job with job_id ${created.job.jobId} and wait=true for a terminal result digest.`,",
    "next: `Continue independent work, then poll get_job/work_get without waiting. Use work_wait only when blocking is explicitly required.`,",
)

store = Path('src/runtime/plugins/store.ts')
replace_once(
    store,
    """export function submitAssistantPluginAction(
  controllerHome: string,""",
    """export function isDirectPluginReadAction(action: AssistantPluginActionDescriptor): boolean {
  return action.readOnly === true
    && action.risk === 'readonly'
    && action.confirmation === 'none'
    && action.idempotent === true;
}

export async function executeAssistantPluginReadDirect(
  controllerHome: string,
  repository: RepositoryRecord,
  request: AssistantPluginActionRequest,
): Promise<{ manifest: AssistantPluginManifest; action: AssistantPluginActionDescriptor; result: Record<string, unknown> }> {
  const manifest = getAssistantPluginManifest(controllerHome, repository, request.pluginId);
  const action = actionForManifest(manifest, request.actionId);
  if (!manifest.enabled && action.actionId !== 'configure') {
    throw new Error(`PLUGIN_DISABLED: ${request.pluginId} is disabled`);
  }
  if (!isDirectPluginReadAction(action)) {
    throw new Error(`PLUGIN_DIRECT_READ_NOT_ALLOWED: ${request.pluginId}/${request.actionId}`);
  }
  const normalizedArgs = validateActionArguments(action, request.args ?? {});
  enforceConfirmation(action, { ...request, args: normalizedArgs });
  const result = await executeAssistantPluginAction({
    controllerHome,
    repoId: repository.repoId,
    repoRoot: repository.canonicalRoot,
    pluginId: request.pluginId,
    actionId: request.actionId,
    requestId: request.requestId,
    args: normalizedArgs,
    origin: request.origin,
  });
  return { manifest, action, result };
}

export function submitAssistantPluginAction(
  controllerHome: string,""",
)

runtime = Path('src/runtime/gateway/mcp/runtime-tools.ts')
replace_once(
    runtime,
    "import { controllerPluginRepository, getAssistantPluginManifest, listAssistantPluginManifests, submitAssistantPluginAction } from '../../plugins/store';",
    "import { controllerPluginRepository, executeAssistantPluginReadDirect, getAssistantPluginManifest, isDirectPluginReadAction, listAssistantPluginManifests, submitAssistantPluginAction } from '../../plugins/store';",
)
replace_once(runtime, "if (args.wait === true || typeof args.wait_ms === 'number') {", "if (args.wait === true) {")
replace_once(runtime, "waited: args.wait === true || typeof args.wait_ms === 'number',", "waited: args.wait === true,")
replace_once(runtime, "waited: args.wait === true || typeof args.wait_ms === 'number',", "waited: args.wait === true,")
replace_once(runtime, "if (args.wait === true || typeof args.wait_ms === 'number') {", "if (args.wait === true) {")
replace_once(runtime, "const digest = buildJobOperationDigest(job, { waited: args.wait === true || typeof args.wait_ms === 'number', stillRunning: timedOut });", "const digest = buildJobOperationDigest(job, { waited: args.wait === true, stillRunning: timedOut });")
replace_once(runtime, "waited: args.wait === true || typeof args.wait_ms === 'number',", "waited: args.wait === true,")
replace_once(
    runtime,
    """        const submitted = submitAssistantPluginAction(ctx.controllerHome, repository, {
          pluginId,
          actionId: String(args.action_id ?? '').trim(),
          requestId: String(args.request_id ?? '').trim(),
          args: args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
            ? args.arguments as Record<string, unknown>
            : {},
          timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
          confirmAuthorization: args.confirm_authorization === true,
          confirmationText: typeof args.confirmation_text === 'string' ? args.confirmation_text : undefined,
          origin: { surface: 'mcp', actor: 'plugin_action_execute', correlationId: String(args.request_id ?? '').trim() },
        });""",
    """        const actionId = String(args.action_id ?? '').trim();
        const requestId = String(args.request_id ?? '').trim();
        const actionArguments = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
          ? args.arguments as Record<string, unknown>
          : {};
        const request = {
          pluginId,
          actionId,
          requestId,
          args: actionArguments,
          timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
          confirmAuthorization: args.confirm_authorization === true,
          confirmationText: typeof args.confirmation_text === 'string' ? args.confirmation_text : undefined,
          origin: { surface: 'mcp' as const, actor: 'plugin_action_execute', correlationId: requestId },
        };
        const manifest = getAssistantPluginManifest(ctx.controllerHome, repository, pluginId);
        const action = manifest.actions.find((entry) => entry.actionId === actionId);
        if (action && isDirectPluginReadAction(action)) {
          const direct = await executeAssistantPluginReadDirect(ctx.controllerHome, repository, request);
          return result({
            accepted: true,
            direct: true,
            durable: false,
            plugin: summarizePlugin(direct.manifest),
            action: {
              actionId: direct.action.actionId,
              risk: direct.action.risk,
              confirmation: direct.action.confirmation,
            },
            scope: repository.repoId === '__controller__' ? 'controller' : 'repository',
            result: direct.result,
            next: 'Continue with the returned bounded result; no Job polling is required.',
          });
        }
        const submitted = submitAssistantPluginAction(ctx.controllerHome, repository, request);""",
)
replace_once(runtime, "'Job is still active. Call get_job with wait=true for a terminal digest, or use get_artifact for bounded evidence.'", "'Job is still active. Poll get_job without waiting, or use work_wait only when blocking is explicitly required.'")

Path('tests/runtime/mcp-router-hot-path.test.ts').write_text("""import { describe, expect, test } from 'bun:test';
import { isDirectHotReadTool, waitTimeoutMs, wantsWaitForResult } from '../../src/runtime/gateway/mcp/router';

describe('MCP durable routing hot path', () => {
  test('wait_ms configures but never enables waiting', () => {
    expect(wantsWaitForResult({ wait_ms: 30_000 })).toBe(false);
    expect(wantsWaitForResult({ wait: false, wait_ms: 30_000 })).toBe(false);
    expect(wantsWaitForResult({ wait: true, wait_ms: 30_000 })).toBe(true);
  });

  test('explicit wait timeout remains bounded', () => {
    expect(waitTimeoutMs({ wait: true, wait_ms: 10 })).toBe(200);
    expect(waitTimeoutMs({ wait: true, wait_ms: 30_000 })).toBe(30_000);
    expect(waitTimeoutMs({ wait: true, wait_ms: 999_999 })).toBe(120_000);
  });

  test('high-frequency reads bypass durable execution', () => {
    for (const name of ['get_job', 'work_get', 'work_list', 'controller_ready', 'rh_status', 'rh_context', 'controller_context_pack', 'git_diff_paths']) {
      expect(isDirectHotReadTool(name)).toBe(true);
    }
    expect(isDirectHotReadTool('run_check')).toBe(false);
    expect(isDirectHotReadTool('repository_command_execute')).toBe(false);
  });
});
""")

Path('tests/runtime/plugin-direct-read.test.ts').write_text("""import { describe, expect, test } from 'bun:test';
import { isDirectPluginReadAction } from '../../src/runtime/plugins/store';
import type { AssistantPluginActionDescriptor } from '../../src/runtime/plugins/types';

function action(overrides: Partial<AssistantPluginActionDescriptor> = {}): AssistantPluginActionDescriptor {
  return {
    actionId: 'read_text',
    title: 'Read text',
    description: 'Read bounded text',
    readOnly: true,
    risk: 'readonly',
    confirmation: 'none',
    defaultTimeoutMs: 5_000,
    cancellable: false,
    idempotent: true,
    scopes: [],
    resourceClaims: [{ resource: 'repo-state', mode: 'read' }],
    argumentsSchema: { type: 'object' },
    ...overrides,
  };
}

describe('plugin direct read eligibility', () => {
  test('allows only bounded idempotent unconfirmed reads', () => {
    expect(isDirectPluginReadAction(action())).toBe(true);
    expect(isDirectPluginReadAction(action({ readOnly: false, risk: 'workspace_write' }))).toBe(false);
    expect(isDirectPluginReadAction(action({ confirmation: 'authorization' }))).toBe(false);
    expect(isDirectPluginReadAction(action({ idempotent: false }))).toBe(false);
  });
});
""")
PY

rm -f patches/20260713-direct-hot-path.patch patches/20260713-direct-read-plane.patch

bun test tests/runtime/mcp-router-hot-path.test.ts
bun test tests/runtime/plugin-direct-read.test.ts
bun test tests/runtime/work-submit-hardening.test.ts
bun test tests/cli/mcp-controller.test.ts

git add src/runtime/gateway/mcp/router.ts \
  src/runtime/gateway/mcp/runtime-tools.ts \
  src/runtime/plugins/store.ts \
  tests/runtime/mcp-router-hot-path.test.ts \
  tests/runtime/plugin-direct-read.test.ts \
  patches/20260713-direct-hot-path.patch \
  patches/20260713-direct-read-plane.patch

git commit -m "perf(controller): introduce direct read execution plane"
git push origin HEAD

echo "Direct read plane migration committed and pushed successfully."
