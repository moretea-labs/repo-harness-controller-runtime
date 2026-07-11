import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-campaign-preflight-'));
  roots.push(root);
  const repoRoot = join(root, 'repo');
  const controllerHome = join(root, 'controller');
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n');
  writeFileSync(join(repoRoot, 'README.md'), '# fixture\n');
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Repo Harness Test'], { cwd: repoRoot });
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repoRoot });
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, repoIdOverride: 'repo-campaign-preflight' });
  const ctx = {
    repoRoot,
    controllerHome,
    policy: getMcpPolicy('controller', { repoRoot }),
    toolset: 'advanced' as const,
    enableChatgptBrowser: false,
    explicitRepository: repository,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
  return { ctx, repoRoot };
}

function structured(result: Awaited<ReturnType<typeof callRuntimeTool>>): Record<string, any> {
  return result?.structuredContent as Record<string, any>;
}

describe('campaign preflight ordering', () => {
  test('invalid supervisor configuration is rejected before an isolated worktree is created', async () => {
    const { ctx, repoRoot } = fixture();
    const before = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
    const result = structured(await callRuntimeTool(ctx, 'create_campaign', {
      repo_id: ctx.explicitRepository?.repoId,
      request_id: 'invalid-supervisor-preflight',
      title: 'Invalid supervisor',
      goal: 'Must fail before workspace allocation',
      tasks: [{ task_id: 'T1', title: 'Record', operation: 'record_candidate_finding', arguments: { semantic_key: 'x', title: 'x' } }],
      supervisor: { mode: 'operation' },
      workspace: { mode: 'isolated' },
    }));
    expect(result.error.code).toBe('CAMPAIGN_SUPERVISOR_OPERATION_REQUIRED');
    const after = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
    expect(after).toBe(before);
    expect(existsSync(join(repoRoot, '.ai/harness/worktrees'))).toBe(false);
  });

  test('invalid task DAG is rejected before workspace allocation', async () => {
    const { ctx, repoRoot } = fixture();
    const result = structured(await callRuntimeTool(ctx, 'create_campaign', {
      repo_id: ctx.explicitRepository?.repoId,
      request_id: 'invalid-task-preflight',
      title: 'Invalid task',
      goal: 'Must fail before workspace allocation',
      tasks: [{ task_id: 'T1', title: 'Cycle', operation: 'record_candidate_finding', depends_on: ['T1'], arguments: { semantic_key: 'x', title: 'x' } }],
      workspace: { mode: 'isolated' },
    }));
    expect(String(result.error.code)).toMatch(/CAMPAIGN_/);
    expect(existsSync(join(repoRoot, '.ai/harness/worktrees'))).toBe(false);
  });
});
