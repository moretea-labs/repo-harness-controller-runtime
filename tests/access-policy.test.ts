import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  accessModeDescriptor,
  evaluateAccessMode,
  readRepositoryAccessPolicy,
  repositoryAccessPolicyPath,
  writeRepositoryAccessPolicy,
} from '../src/runtime/control-plane/governance/access-policy';
import {
  getWorkContract,
  listHandoffItems,
  routeWorkStart,
  runGoalWorkloop,
  type GoalWorkloopContext,
} from '../src/runtime/control-plane/facade';
import { evaluatePolicyGate } from '../src/runtime/control-plane/facade/policy-gate';

const tempRoots: string[] = [];

function controllerHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-access-policy-'));
  tempRoots.push(root);
  return root;
}

function workloopContext(home: string): GoalWorkloopContext {
  const store = { controllerHome: home, repoId: 'repo-test' };
  return {
    workStore: store,
    handoffStore: store,
    repoId: 'repo-test',
    availableChecks: [],
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository access policy', () => {
  test('defaults to Full Access without writing controller state', () => {
    const home = controllerHome();
    const policy = readRepositoryAccessPolicy(home, 'repo-test');

    expect(policy.mode).toBe('full_access');
    expect(policy.updatedBy).toBe('system');
    expect(repositoryAccessPolicyPath(home, 'repo-test')).toEndWith(
      join('repositories', 'repo-test', 'controller', 'access-policy.json'),
    );
  });

  test('persists full access under controllerHome repository storage', () => {
    const home = controllerHome();
    const written = writeRepositoryAccessPolicy(home, 'repo-test', 'full_access');
    const loaded = readRepositoryAccessPolicy(home, 'repo-test');

    expect(written.mode).toBe('full_access');
    expect(written.updatedBy).toBe('user');
    expect(loaded).toEqual(written);
  });

  test('falls back to request for malformed policy files', () => {
    const home = controllerHome();
    writeRepositoryAccessPolicy(home, 'repo-test', 'full_access');
    const path = repositoryAccessPolicyPath(home, 'repo-test');
    writeFileSync(path, '{invalid-json', 'utf-8');

    expect(readRepositoryAccessPolicy(home, 'repo-test').mode).toBe('request');
  });
});

describe('access decision matrix', () => {
  test('request allows reads and requests local side effects', () => {
    expect(evaluateAccessMode('request', 'read')).toBe('allow');
    expect(evaluateAccessMode('request', 'local_repo_write')).toBe('request');
    expect(evaluateAccessMode('request', 'local_command')).toBe('request');
    expect(evaluateAccessMode('request', 'local_git')).toBe('request');
  });

  test('full access allows local repository work only', () => {
    expect(evaluateAccessMode('full_access', 'local_repo_write')).toBe('allow');
    expect(evaluateAccessMode('full_access', 'workspace_write')).toBe('allow');
    expect(evaluateAccessMode('full_access', 'local_command')).toBe('allow');
    expect(evaluateAccessMode('full_access', 'dependency_change')).toBe('allow');
    expect(evaluateAccessMode('full_access', 'local_git')).toBe('allow');
    expect(evaluateAccessMode('full_access', 'external_network')).toBe('request');
    expect(evaluateAccessMode('full_access', 'remote_write')).toBe('request');
    expect(evaluateAccessMode('full_access', 'destructive')).toBe('request');
    expect(evaluateAccessMode('full_access', 'outside_repository')).toBe('request');
    expect(evaluateAccessMode('full_access', 'secret_access')).toBe('deny');
  });

  test('descriptors explain the remaining hard boundaries', () => {
    const full = accessModeDescriptor('full_access');
    expect(full.shortLabel).toBe('Full Access');
    expect(full.stillRequiresApproval.join(' ')).toContain('remote');
    expect(full.alwaysDenied.join(' ')).toContain('secrets');
  });
});

describe('policy gate access mode integration', () => {
  test('full access removes repeated approval for local writes', () => {
    expect(evaluatePolicyGate({ risk: 'workspace_write', accessMode: 'full_access' }).decision).toBe('allowed');
    expect(evaluatePolicyGate({ risk: 'local_repo_write', accessMode: 'full_access' }).decision).toBe('allowed');
  });

  test('request still requires approval outside bounded direct edits', () => {
    expect(evaluatePolicyGate({ risk: 'workspace_write', accessMode: 'request' }).decision).toBe('approval_required');
    expect(evaluatePolicyGate({
      risk: 'local_repo_write',
      accessMode: 'request',
      directEditBoundary: {
        scopeClear: true,
        pathsExplicit: true,
        maxChangedFiles: 2,
        maxChangedLines: 100,
      },
    }).decision).toBe('allowed');
  });

  test('full access cannot bypass remote destructive or secret gates', () => {
    expect(evaluatePolicyGate({ risk: 'remote_write', accessMode: 'full_access' }).decision).toBe('approval_required');
    expect(evaluatePolicyGate({ risk: 'destructive', accessMode: 'full_access' }).decision).toBe('approval_required');
    expect(evaluatePolicyGate({ risk: 'raw_secret_config', accessMode: 'full_access' }).decision).toBe('denied');
  });
});

describe('access-aware work routing', () => {
  test('request mode creates an approval handoff for explicitly approval-gated work', () => {
    const home = controllerHome();
    const ctx = workloopContext(home);
    writeRepositoryAccessPolicy(home, 'repo-test', 'request');
    const result = routeWorkStart(ctx, {
      objective: 'Update several local repository files',
      modeInput: {
        objective: 'Update several local repository files',
        scopeClear: true,
        expectedFiles: 4,
        requiresApproval: true,
      },
      requestedBy: 'user',
    });

    expect(result.status).toBe('approval_required');
    expect(result.data.workContractCreated).toBe(false);
    expect(listHandoffItems({ controllerHome: home, repoId: 'repo-test', status: 'pending' })).toHaveLength(1);
  });

  test('repository full access creates work and captures the permission snapshot', () => {
    const home = controllerHome();
    const ctx = workloopContext(home);
    writeRepositoryAccessPolicy(home, 'repo-test', 'full_access');

    const result = routeWorkStart(ctx, {
      objective: 'Update several local repository files',
      modeInput: {
        objective: 'Update several local repository files',
        scopeClear: true,
        expectedFiles: 4,
        requiresApproval: true,
      },
      requestedBy: 'user',
    });

    expect(result.status).toBe('ok');
    expect(result.data.workContractCreated).toBe(true);
    const workId = String((result.data.work as { workId?: string }).workId ?? '');
    const work = getWorkContract({ controllerHome: home, repoId: 'repo-test' }, workId);
    expect(work?.constraints.accessMode).toBe('full_access');
    expect(work?.policyDecisions[0]?.reason).toContain('Full Access');
  });

  test('rh_work constraints may override the repository default for one task', () => {
    const home = controllerHome();
    const ctx = workloopContext(home);
    writeRepositoryAccessPolicy(home, 'repo-test', 'request');

    const result = runGoalWorkloop(ctx, 'start', {
      objective: 'Update several local repository files',
      expected_files: 4,
      scope_clear: true,
      requires_approval: true,
      constraints: { accessMode: 'full_access' },
      requested_by: 'user',
    });

    expect(result.status).toBe('ok');
    const workId = String((result.data.work as { workId?: string }).workId ?? '');
    expect(getWorkContract({ controllerHome: home, repoId: 'repo-test' }, workId)?.constraints.accessMode).toBe('full_access');
    expect(readRepositoryAccessPolicy(home, 'repo-test').mode).toBe('request');
  });
  test('running work keeps its captured mode and current-workspace policy after repository settings change', () => {
    const home = controllerHome();
    const ctx = workloopContext(home);
    writeRepositoryAccessPolicy(home, 'repo-test', 'full_access');
    const result = runGoalWorkloop(ctx, 'start', {
      objective: 'Refactor local source safely',
      expected_files: 5,
      expected_changed_lines: 250,
      scope_clear: true,
      constraints: { workspace_mode: 'current' },
      requested_by: 'user',
    });
    const workId = String((result.data.work as { workId?: string }).workId ?? '');
    const before = getWorkContract({ controllerHome: home, repoId: 'repo-test' }, workId)!;
    expect(before.constraints.accessMode).toBe('full_access');
    expect(before.worktreePolicy.required).toBe(false);
    expect(before.driver.preferred).toBe('direct_edit');

    writeRepositoryAccessPolicy(home, 'repo-test', 'request');
    const after = getWorkContract({ controllerHome: home, repoId: 'repo-test' }, workId)!;
    expect(after.constraints.accessMode).toBe('full_access');
    expect(readRepositoryAccessPolicy(home, 'repo-test').mode).toBe('request');
  });

});
