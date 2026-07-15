import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { registerRepository } from '../../src/cli/repositories/registry';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { writeRepositoryAccessPolicy } from '../../src/runtime/control-plane/governance/access-policy';
import {
  assertResolvedAuthorization,
  createGoalDelegation,
  decideAuthorization,
  resolveAuthorizationRequest,
} from '../../src/runtime/control-plane/governance/authorization';
import { callExecutionTool } from '../../src/runtime/gateway/mcp/execution-tools';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(mode: 'full_access' | 'request' = 'full_access') {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-goal-auth-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-goal-auth-home-'));
  roots.push(repoRoot, controllerHome);
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'goal-auth-fixture' }));
  spawnSync('git', ['add', 'package.json'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'goal auth fixture' });
  writeRepositoryAccessPolicy(controllerHome, repository.repoId, mode);
  const ctx = {
    repoRoot,
    controllerHome,
    policy: getMcpPolicy('controller', { repoRoot }),
    toolset: 'advanced' as const,
    toolsetLocked: true,
    enableChatgptBrowser: false,
    explicitRepository: repository,
    sessionId: 'session-goal-auth',
    principalId: 'principal-goal-auth',
    controllerInstanceId: 'instance-goal-auth',
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
  return { repoRoot, controllerHome, repository, ctx };
}

function allowContext(overrides: Partial<Parameters<typeof decideAuthorization>[0]> = {}) {
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-goal-auth-decision-home-'));
  roots.push(controllerHome);
  return {
    controllerHome,
    accessMode: 'full_access' as const,
    risk: 'workspace_write' as const,
    repositoryId: 'repo-a',
    currentRepositoryId: 'repo-a',
    permissionSnapshotVersion: 1,
    ...overrides,
  };
}

function structured(result: Awaited<ReturnType<typeof callExecutionTool>>): Record<string, any> {
  expect(result).toBeTruthy();
  return (result!.structuredContent ?? {}) as Record<string, any>;
}

async function prepare(ctx: MultiRepositoryMcpToolContext, repoId: string, goalId = 'goal-1') {
  structured(await callExecutionTool(ctx, 'session_start', {}));
  structured(await callExecutionTool(ctx, 'session_bind_repository', { repo_id: repoId }));
  const prepared = structured(await callExecutionTool(ctx, 'work_prepare', { repo_id: repoId, goal_id: goalId, objective: 'Run the bounded Goal checks', isolation: 'reuse' }));
  return String(prepared.work.workId);
}

describe('GPT risk delegation and resumable authorization', () => {
  test('host-managed execution automatically allows an ordinary local operation', async () => {
    const { ctx, repository } = fixture();
    const workId = await prepare(ctx, repository.repoId);
    const response = structured(await callExecutionTool(ctx, 'work_execute', { work_id: workId, command: 'printf ordinary-local-command' }));
    expect(response.commands[0].status).toBe('executed');
    expect(response.commands[0].authorizationDecision).toMatchObject({ decision: 'allow', source: 'gpt_risk_delegate' });
    expect(response.commands[0].approvalRequestId).toBeUndefined();
  });

  test('legacy Request mode does not create a second approval layer for ordinary repository work', async () => {
    const { ctx, repository } = fixture('request');
    const workId = await prepare(ctx, repository.repoId);
    const response = structured(await callExecutionTool(ctx, 'work_execute', { work_id: workId, command: 'printf delegated-local-command > goal-output.txt' }));
    expect(response.commands[0].status).toBe('executed');
    expect(response.commands[0].authorizationDecision).toMatchObject({ decision: 'allow' });
  });

  test('the composite tool surfaces outside-worktree writes as resumable approval', async () => {
    const { ctx, repository } = fixture('request');
    const workId = await prepare(ctx, repository.repoId);
    const response = structured(await callExecutionTool(ctx, 'work_execute', { work_id: workId, command: 'printf outside', cwd: '../outside' }));
    expect(response.authorization).toMatchObject({ decision: 'user_confirmation_required' });
    expect(response.authorization.approvalRequestId).toBeTruthy();
    expect(response.authorization.continuation).toContain('retry');
  });

  test('approval_resolve is a conversation continuation, not a GUI-only handoff', async () => {
    const { ctx, repository } = fixture();
    const workId = await prepare(ctx, repository.repoId);
    const blocked = structured(await callExecutionTool(ctx, 'work_execute', { work_id: workId, command: 'git reset --hard HEAD' }));
    const approvalRequestId = String(blocked.authorization.approvalRequestId);
    const resolved = structured(await callExecutionTool(ctx, 'approval_resolve', { approval_request_id: approvalRequestId, confirm_authorization: true, work_id: workId }));
    expect(resolved.authorization).toMatchObject({ decision: 'allow', source: 'user_confirmation' });
    const retried = structured(await callExecutionTool(ctx, 'work_execute', { work_id: workId, command: 'git reset --hard HEAD', approval_request_id: approvalRequestId }));
    expect(retried.commands[0].status).toBe('executed');
    expect(retried.commands[0].authorizationDecision).toMatchObject({ decision: 'allow', source: 'user_confirmation' });
  });

  test('outside-repository writes return a resumable confirmation request', () => {
    const decision = decideAuthorization(allowContext({ risk: 'outside_repository', cwd: '../outside', worktreePath: '/tmp/controlled-worktree', command: 'printf x > ../outside/file' }));
    expect(decision).toMatchObject({ decision: 'user_confirmation_required' });
    if (decision.decision === 'user_confirmation_required') {
      expect(decision.approvalRequestId).toMatch(/^apr_/);
      expect(decision.continuation).toContain('approvalRequestId');
      expect(decision.consequences.length).toBeGreaterThan(0);
    }
  });

  test('destructive operations remain gated even in Full Access', () => {
    const decision = decideAuthorization(allowContext({ risk: 'destructive', command: 'git reset --hard HEAD' }));
    expect(decision.decision).toBe('user_confirmation_required');
    if (decision.decision === 'user_confirmation_required') expect(decision.approvalRequestId).toBeTruthy();
  });

  test('natural-language confirmation resolves the request and exact retry only', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-goal-auth-resolution-'));
    roots.push(controllerHome);
    const pending = decideAuthorization(allowContext({ controllerHome, risk: 'destructive', command: 'git clean -fd' }));
    expect(pending.decision).toBe('user_confirmation_required');
    if (pending.decision !== 'user_confirmation_required') return;
    const resolved = resolveAuthorizationRequest({ controllerHome, repositoryId: 'repo-a', approvalRequestId: pending.approvalRequestId, permissionSnapshotVersion: 1, confirm: true });
    expect(resolved.status).toBe('resolved');
    expect(assertResolvedAuthorization({ controllerHome, repositoryId: 'repo-a', approvalRequestId: pending.approvalRequestId, permissionSnapshotVersion: 1, command: 'git clean -fd' }).status).toBe('resolved');
    expect(() => assertResolvedAuthorization({ controllerHome, repositoryId: 'repo-a', approvalRequestId: pending.approvalRequestId, permissionSnapshotVersion: 1, command: 'git clean -fdx' })).toThrow('APPROVAL_REQUEST_COMMAND_CHANGED');
  });

  test('approval resolution rejects repository, work, and permission changes', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-goal-auth-stale-'));
    roots.push(controllerHome);
    const pending = decideAuthorization(allowContext({ controllerHome, risk: 'destructive', sessionId: 'session-1', principalId: 'principal-1', workId: 'work-1', command: 'git clean -fd' }));
    expect(pending.decision).toBe('user_confirmation_required');
    if (pending.decision !== 'user_confirmation_required') return;
    expect(() => resolveAuthorizationRequest({ controllerHome, repositoryId: 'repo-b', approvalRequestId: pending.approvalRequestId, sessionId: 'session-1', principalId: 'principal-1', workId: 'work-1', permissionSnapshotVersion: 1, confirm: true })).toThrow('APPROVAL_REQUEST_NOT_FOUND');
    expect(() => resolveAuthorizationRequest({ controllerHome, repositoryId: 'repo-a', approvalRequestId: pending.approvalRequestId, sessionId: 'session-1', principalId: 'principal-2', workId: 'work-1', permissionSnapshotVersion: 1, confirm: true })).toThrow('APPROVAL_REQUEST_PRINCIPAL_MISMATCH');
    expect(() => resolveAuthorizationRequest({ controllerHome, repositoryId: 'repo-a', approvalRequestId: pending.approvalRequestId, sessionId: 'session-1', principalId: 'principal-1', workId: 'work-2', permissionSnapshotVersion: 1, confirm: true })).toThrow('APPROVAL_REQUEST_WORK_MISMATCH');
    expect(() => resolveAuthorizationRequest({ controllerHome, repositoryId: 'repo-a', approvalRequestId: pending.approvalRequestId, sessionId: 'session-1', principalId: 'principal-1', workId: 'work-1', permissionSnapshotVersion: 2, confirm: true })).toThrow('APPROVAL_REQUEST_STALE_PERMISSION');
  });

  test('Goal delegation remains bounded provenance while ordinary mismatches fall back to host policy', () => {
    const delegation = createGoalDelegation({ sessionId: 'session-1', repositoryId: 'repo-a', workId: 'work-1', goalId: 'goal-1', allowedRiskClasses: ['workspace_write'], deniedRiskClasses: ['destructive'], permissionSnapshotVersion: 3, source: 'gpt_risk_delegate' });
    expect(decideAuthorization(allowContext({ accessMode: 'request', sessionId: 'session-1', repositoryId: 'repo-a', workId: 'work-1', boundWorkId: 'work-1', goalId: 'goal-1', boundGoalId: 'goal-1', permissionSnapshotVersion: 3, delegation }))).toMatchObject({ decision: 'allow', source: 'gpt_risk_delegate' });
    expect(decideAuthorization(allowContext({ accessMode: 'request', sessionId: 'session-1', repositoryId: 'repo-b', currentRepositoryId: 'repo-b', workId: 'work-1', boundWorkId: 'work-1', goalId: 'goal-1', permissionSnapshotVersion: 3, delegation }))).toMatchObject({ decision: 'allow', source: 'policy' });
    expect(decideAuthorization(allowContext({ accessMode: 'request', sessionId: 'session-1', repositoryId: 'repo-a', workId: 'work-1', boundWorkId: 'work-1', goalId: 'goal-2', boundGoalId: 'goal-2', permissionSnapshotVersion: 3, delegation }))).toMatchObject({ decision: 'allow', source: 'policy' });
    expect(decideAuthorization(allowContext({ accessMode: 'request', sessionId: 'session-1', repositoryId: 'repo-a', workId: 'work-1', boundWorkId: 'work-1', goalId: 'goal-1', permissionSnapshotVersion: 4, delegation }))).toMatchObject({ decision: 'allow', source: 'policy' });
  });

  test('secret access is denied and never becomes an approval request', () => {
    expect(decideAuthorization(allowContext({ risk: 'secret_access', command: 'cat ~/.ssh/id_ed25519' }))).toEqual({ decision: 'deny', reason: expect.stringContaining('always denied') });
  });
});
