import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  accessModeDescriptor,
  evaluateAccessMode,
  readRepositoryAccessPolicy,
  repositoryAccessPolicyPath,
  writeRepositoryAccessPolicy,
} from '../src/runtime/control-plane/governance/access-policy';
import { evaluatePolicyGate } from '../src/runtime/control-plane/facade/policy-gate';

const tempRoots: string[] = [];

function controllerHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-access-policy-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository access policy', () => {
  test('defaults to request without writing controller state', () => {
    const home = controllerHome();
    const policy = readRepositoryAccessPolicy(home, 'repo-test');

    expect(policy.mode).toBe('request');
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
    Bun.write(path, '{invalid-json');

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
    expect(full.stillRequiresApproval.join(' ')).toContain('远程');
    expect(full.alwaysDenied.join(' ')).toContain('密钥');
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
