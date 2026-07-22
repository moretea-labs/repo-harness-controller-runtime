import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import {
  listRepositories,
  registerRepository,
  repositoryCheckoutLifecycle,
} from '../../src/cli/repositories/registry';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { writeRepositoryAccessPolicy } from '../../src/runtime/control-plane/governance/access-policy';
import { callExecutionTool } from '../../src/runtime/gateway/mcp/execution-tools';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-work-recovery-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-work-recovery-home-'));
  roots.push(repoRoot, controllerHome);
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Repo Harness Test');
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'work-recovery-fixture' }, null, 2));
  git(repoRoot, 'add', 'package.json');
  git(repoRoot, 'commit', '-m', 'init');
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'work recovery fixture' });
  writeRepositoryAccessPolicy(controllerHome, repository.repoId, 'full_access');
  const context = (sessionId: string, controllerInstanceId: string): MultiRepositoryMcpToolContext => ({
    repoRoot,
    controllerHome,
    policy: getMcpPolicy('controller', { repoRoot }),
    toolset: 'advanced' as const,
    toolsetLocked: true,
    enableChatgptBrowser: false,
    explicitRepository: repository,
    sessionId,
    principalId: 'principal-work-recovery',
    controllerInstanceId,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext);
  return { repoRoot, controllerHome, repository, context };
}

function structured(result: Awaited<ReturnType<typeof callExecutionTool>>): Record<string, any> {
  expect(result).toBeTruthy();
  return (result!.structuredContent ?? {}) as Record<string, any>;
}

describe('controller-owned Work recovery and finalize cleanup', () => {
  test('continues an explicit Work handle across controller and MCP session changes', async () => {
    const { repository, context } = fixture();
    const first = context('session-original', 'controller-a');
    structured(await callExecutionTool(first, 'session_start', {}));
    structured(await callExecutionTool(first, 'session_bind_repository', { repo_id: repository.repoId }));
    const prepared = structured(await callExecutionTool(first, 'work_prepare', {
      repo_id: repository.repoId,
      objective: 'Recover this work after session restart',
      isolation: 'reuse',
    }));
    const workId = String(prepared.work.workId);

    const sameSessionAfterRestart = context('session-original', 'controller-b');
    const inspectedAfterControllerRestart = structured(await callExecutionTool(sameSessionAfterRestart, 'work_inspect', {
      repo_id: repository.repoId,
      work_id: workId,
    }));
    expect(inspectedAfterControllerRestart.work.workId).toBe(workId);
    expect(inspectedAfterControllerRestart.readiness.valid).toBe(true);

    const newSession = context('session-new', 'controller-c');
    structured(await callExecutionTool(newSession, 'session_start', {}));
    const inspectedAfterSessionRestart = structured(await callExecutionTool(newSession, 'work_inspect', {
      repo_id: repository.repoId,
      work_id: workId,
    }));
    expect(inspectedAfterSessionRestart.work.workId).toBe(workId);
    expect(inspectedAfterSessionRestart.readiness.warnings.join('\n')).toContain('different MCP session');
  });

  test('finalize commits, merges, removes managed checkout, deletes branch, and clears session focus', async () => {
    const { repoRoot, controllerHome, repository, context } = fixture();
    const ctx = context('session-finalize', 'controller-finalize');
    structured(await callExecutionTool(ctx, 'session_start', {}));
    structured(await callExecutionTool(ctx, 'session_bind_repository', { repo_id: repository.repoId }));
    const prepared = structured(await callExecutionTool(ctx, 'work_prepare', {
      repo_id: repository.repoId,
      objective: 'Finalize managed worktree',
      isolation: 'new_worktree',
    }));
    const workId = String(prepared.work.workId);
    const branch = String(prepared.work.branch);
    const checkoutId = String(prepared.work.checkoutId);
    const worktreePath = String(prepared.work.worktreePath);

    const executed = structured(await callExecutionTool(ctx, 'work_execute', {
      repo_id: repository.repoId,
      work_id: workId,
      command: 'printf managed-finalize > feature.txt',
    }));
    expect(executed.executedCount).toBe(1);

    const finalized = structured(await callExecutionTool(ctx, 'work_finalize', {
      repo_id: repository.repoId,
      work_id: workId,
      commit: true,
      message: 'Finalize managed worktree',
      merge: true,
      cleanup: true,
    }));
    expect(finalized.completed).toBe(true);
    expect(finalized.work.state).toBe('cleaned');
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repoRoot, 'branch', '--list', branch)).toBe('');

    const refreshed = listRepositories(controllerHome, { includeRemoved: true }).find((entry) => entry.repoId === repository.repoId)!;
    const managedCheckout = refreshed.checkouts.find((checkout) => checkout.checkoutId === checkoutId)!;
    expect(repositoryCheckoutLifecycle(managedCheckout)).toBe('removed');
    expect(git(repoRoot, 'show', 'HEAD:feature.txt')).toBe('managed-finalize');

    const status = structured(await callExecutionTool(ctx, 'session_start', {}));
    expect(status.session.activeWorkId).toBeUndefined();
    expect(status.session.activeCheckoutId).toBe(repository.activeCheckoutId);
  });
});
