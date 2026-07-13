import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { controllerExpectedToolNames } from '../../src/cli/mcp/legacy-tool-service';
import {
  ADVANCED_CONTROLLER_TOOL_NAMES,
  DEFAULT_CONTROLLER_TOOL_NAMES,
  PREFERRED_FACADE_TOOL_NAMES,
  allControllerToolDefinitions,
  classifyControllerToolExposure,
  exposedControllerToolDefinitions,
} from '../../src/cli/mcp/toolset';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { callRuntimeTool, runtimeToolDefinitions } from '../../src/runtime/gateway/mcp/runtime-tools';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function controllerFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-facade-mcp-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-facade-mcp-home-'));
  roots.push(repoRoot, controllerHome);
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
    name: 'facade-mcp-fixture',
    scripts: {
      'check:type': 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)"',
    },
  }, null, 2));
  spawnSync('git', ['add', 'package.json'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'fixture' });
  const policy = getMcpPolicy('controller', { repoRoot });
  const ctx = {
    repoRoot,
    controllerHome,
    policy,
    toolset: 'core' as const,
    enableChatgptBrowser: false,
    explicitRepository: repository,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
  return { ctx, repository, controllerHome, repoRoot, policy };
}

function structured(result: Awaited<ReturnType<typeof callRuntimeTool>>): Record<string, unknown> {
  expect(result).toBeTruthy();
  return (result!.structuredContent ?? JSON.parse(result!.content[0] && 'text' in result!.content[0] ? String(result!.content[0].text) : '{}')) as Record<string, unknown>;
}

describe('facade MCP surface wiring', () => {
  test('preferred facade tools are part of default core exposure and runtime definitions', () => {
    expect(PREFERRED_FACADE_TOOL_NAMES).toEqual(['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work']);
    for (const name of PREFERRED_FACADE_TOOL_NAMES) {
      expect(DEFAULT_CONTROLLER_TOOL_NAMES).toContain(name);
      expect(ADVANCED_CONTROLLER_TOOL_NAMES).toContain(name);
      const all = allControllerToolDefinitions(controllerFixture().ctx);
      expect(all.some((tool) => tool.name === name)).toBe(true);
      expect(classifyControllerToolExposure(name)).toBe('facade');
    }
  });

  test('controllerExpectedToolNames includes rh_status/rh_inbox/rh_context/rh_work', () => {
    const policy = getMcpPolicy('controller');
    const expected = controllerExpectedToolNames(policy);
    expect(expected).toContain('rh_status');
    expect(expected).toContain('rh_inbox');
    expect(expected).toContain('rh_context');
    expect(expected).toContain('rh_work');
    // Preferred facade tools are listed first.
    expect(expected.slice(0, 5)).toEqual(['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work']);
  });

  test('core toolset exposes rh_* schemas in runtime registry', () => {
    const { ctx } = controllerFixture();
    const exposed = exposedControllerToolDefinitions(ctx).map((tool) => tool.name);
    expect(exposed).toContain('rh_status');
    expect(exposed).toContain('rh_inbox');
    expect(exposed).toContain('rh_context');
    expect(exposed).toContain('rh_work');
    const all = allControllerToolDefinitions(ctx);
    for (const name of PREFERRED_FACADE_TOOL_NAMES) {
      const def = all.find((tool) => tool.name === name);
      expect(def?.inputSchema).toBeTruthy();
      expect((def?.inputSchema as { properties?: Record<string, unknown> }).properties?.operation).toBeTruthy();
    }
  });

  test('rh_status returns FacadeResult', async () => {
    const { ctx, repository } = controllerFixture();
    const payload = structured(await callRuntimeTool(ctx, 'rh_status', {
      repo_id: repository.repoId,
      operation: 'get',
    }));
    expect(payload).toMatchObject({
      schemaVersion: 1,
      status: expect.stringMatching(/ok|blocked/),
      summary: expect.any(String),
      rawAvailable: false,
      detailLevel: 'summary',
    });
    const toolSurface = (payload.data as { toolSurface: string[] }).toolSurface;
    for (const name of PREFERRED_FACADE_TOOL_NAMES) expect(toolSurface).toContain(name);
    expect((payload.data as { toolSurfaceStatus: { missingTools: string[] } }).toolSurfaceStatus.missingTools).toEqual([]);
    expect(JSON.stringify(payload)).not.toMatch(/stdout|stderr|Bearer |private_key/i);
  });

  test('rh_inbox list/get/resolve returns bounded FacadeResult', async () => {
    const { ctx, repository } = controllerFixture();
    const created = structured(await callRuntimeTool(ctx, 'rh_inbox', {
      repo_id: repository.repoId,
      operation: 'create',
      title: 'Needs decision',
      reason: 'Ambiguous outcome',
    }));
    const handoffId = (created.data as { item: { id: string } }).item.id;
    const listed = structured(await callRuntimeTool(ctx, 'rh_inbox', {
      repo_id: repository.repoId,
      operation: 'list',
    }));
    expect((listed.data as { items: Array<{ id: string }> }).items.some((item) => item.id === handoffId)).toBe(true);
    expect(JSON.stringify(listed.data)).not.toContain('stdout');

    const got = structured(await callRuntimeTool(ctx, 'rh_inbox', {
      repo_id: repository.repoId,
      operation: 'get',
      handoff_id: handoffId,
    }));
    expect(got.status).toBe('ok');

    const resolved = structured(await callRuntimeTool(ctx, 'rh_inbox', {
      repo_id: repository.repoId,
      operation: 'resolve',
      handoff_id: handoffId,
      decision: 'continue',
      resolver: 'chatgpt',
    }));
    expect(resolved).toMatchObject({
      status: 'ok',
      data: { item: { id: handoffId, status: 'resolved', decision: 'continue', resolver: 'chatgpt' } },
    });
  });

  test('rh_context with invalid requested check id returns warning not failure', async () => {
    const { ctx, repository } = controllerFixture();
    const payload = structured(await callRuntimeTool(ctx, 'rh_context', {
      repo_id: repository.repoId,
      operation: 'get',
      requested_check_ids: ['not-a-real-check', 'typecheck'],
    }));
    expect(payload.status).toBe('ok');
    expect((payload.warnings as string[]).some((warning) => warning.includes('invalid_check_id'))).toBe(true);
    expect((payload.data as { invalidCheckIdsAreNotFailures: boolean }).invalidCheckIdsAreNotFailures).toBe(true);
  });

  test('rh_context distinguishes missing work ids and preserves raw detail level', async () => {
    const { ctx, repository } = controllerFixture();
    const missing = structured(await callRuntimeTool(ctx, 'rh_context', {
      repo_id: repository.repoId,
      operation: 'get',
      work_id: 'work-does-not-exist',
    }));
    expect(missing.status).toBe('not_found');

    const raw = structured(await callRuntimeTool(ctx, 'rh_context', {
      repo_id: repository.repoId,
      operation: 'list',
      detail_level: 'raw',
    }));
    expect(raw.detailLevel).toBe('raw');
    expect(raw.rawAvailable).toBe(true);
    expect((raw.suggestedNextActions as Array<{ operation: string; risk: string }>)[0]).toMatchObject({
      operation: 'start',
      risk: 'workspace_write',
    });
  });

  test('rh_work start routes small/complex/high-risk modes', async () => {
    const { ctx, repository } = controllerFixture();
    const small = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'start',
      objective: 'Fix typo',
      expected_files: 1,
      expected_changed_lines: 4,
      scope_clear: true,
    }));
    expect((small.data as { workContractCreated: boolean; mode: { mode: string } }).workContractCreated).toBe(false);
    expect((small.data as { mode: { mode: string } }).mode.mode).toBe('direct_control');

    const complex = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'start',
      objective: 'Refactor facade routing and recovery loop',
      expected_files: 12,
      expected_changed_lines: 600,
      requires_long_running_checks: true,
      scope_clear: true,
      check_ids: ['typecheck'],
    }));
    expect((complex.data as { workContractCreated: boolean }).workContractCreated).toBe(true);
    expect((complex.data as { mode: { mode: string } }).mode.mode).toBe('goal_workloop');
    const workId = (complex.data as { work: { workId: string } }).work.workId;

    const risky = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'start',
      objective: 'Force push and rotate secrets',
      destructive: true,
      secret_access: true,
      requires_approval: true,
      requires_user_approval: true,
      scope_clear: true,
    }));
    expect((risky.data as { workContractCreated: boolean; mode: { mode: string } }).workContractCreated).toBe(false);
    expect((risky.data as { mode: { mode: string } }).mode.mode).toBe('handoff_only');

    const invalidVerify = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'verify',
      work_id: workId,
      check_id: 'docs-not-registered',
      simulate_check: true,
    }));
    expect((invalidVerify.data as { verification: { outcome: string; isAcceptanceFailure: boolean } }).verification).toMatchObject({
      outcome: 'invalid_check_id',
      isAcceptanceFailure: false,
    });

    const validVerify = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'verify',
      work_id: workId,
      check_id: 'typecheck',
      simulate_check: true,
    }));
    expect((validVerify.data as { verification: { checkId: string; outcome: string } }).verification.checkId).toBe('package:check:type');
    expect((validVerify.data as { verification: { outcome: string } }).verification.outcome).toBe('valid_pass');
  });

  test('rh_work.delegate codex/grok are bounded and cannot finalize', async () => {
    const { ctx, repository } = controllerFixture();
    const started = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'start',
      objective: 'Delegate bounded patch',
      expected_files: 8,
      expected_changed_lines: 300,
      scope_clear: true,
    }));
    const workId = (started.data as { work: { workId: string } }).work.workId;

    const codex = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'delegate',
      target: 'codex',
      work_id: workId,
      objective: 'Implement bounded patch',
      available: true,
      worker_output: { summary: 'patch ready', patchProposal: 'diff --git a/x' },
    }));
    expect((codex.data as { canFinalize: boolean; target: string }).canFinalize).toBe(false);
    expect((codex.data as { target: string }).target).toBe('codex');
    expect((codex.data as { contextPack: { expectedOutputFormat: { mustNot: string[] } } }).contextPack.expectedOutputFormat.mustNot)
      .toContain('finalize_work_contract');

    const grok = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'delegate',
      target: 'grok',
      work_id: workId,
      objective: 'Parallel review',
    }));
    expect((grok.data as { target: string; directExecutionAvailable: boolean; canFinalize: boolean }).target).toBe('grok');
    expect((grok.data as { directExecutionAvailable: boolean }).directExecutionAvailable).toBe(false);
    expect((grok.data as { canFinalize: boolean }).canFinalize).toBe(false);
    expect((grok.data as { grokDelegateRequest: { requestId: string } }).grokDelegateRequest.requestId).toMatch(/^grok-req-/);
    expect((grok.data as { isAcceptanceFailure: boolean }).isAcceptanceFailure).toBe(false);
  });

  test('repair diagnose defaults dry_run; destructive requires approval', async () => {
    const { ctx, repository } = controllerFixture();
    const diagnose = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'repair',
      repair_operation: 'diagnose',
    }));
    expect((diagnose.data as { dryRun: boolean; isAcceptanceFailure: boolean }).dryRun).toBe(true);
    expect((diagnose.data as { isAcceptanceFailure: boolean }).isAcceptanceFailure).toBe(false);
    expect((diagnose.data as { linkedTools: string[] }).linkedTools).toContain('runtime_maintenance_status');

    const destructive = structured(await callRuntimeTool(ctx, 'rh_status', {
      repo_id: repository.repoId,
      operation: 'repair',
      repair_operation: 'repair',
      dry_run: false,
      process_kill_or_restart: true,
      destructive: true,
    }));
    expect(destructive.status).toBe('approval_required');
    expect((destructive.data as { applied: boolean; isAcceptanceFailure: boolean }).applied).toBe(false);
    expect((destructive.data as { isAcceptanceFailure: boolean }).isAcceptanceFailure).toBe(false);
  });

  test('invalid facade operation returns structured FacadeResult error', async () => {
    const { ctx, repository } = controllerFixture();
    const payload = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'explode',
    }));
    expect(payload.status).toBe('failed');
    expect((payload.data as { allowedOperations: string[] }).allowedOperations).toContain('start');
    expect((payload.suggestedNextActions as unknown[]).length).toBeGreaterThan(0);
  });
});
