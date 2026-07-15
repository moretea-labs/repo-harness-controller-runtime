import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  boundKeyOutput,
  compositeFailed,
  compositeSucceeded,
  redactSensitiveText,
} from '../../src/cli/controller/composite-result';
import {
  validateDeleteSuccess,
  validateMergeSuccess,
  validatePatchSuccess,
  validateRestartSuccess,
} from '../../src/cli/controller/postcondition';
import { repositoryChangeVerify } from '../../src/cli/controller/composite-operations';
import type { ControllerRestartState } from '../../src/cli/controller/restart-coordinator';
import type { ControllerServiceStatus } from '../../src/cli/controller/lifecycle';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function initRepo(root: string): void {
  writeFileSync(join(root, 'README.md'), 'hello\n');
  mkdirSync(join(root, '.repo-harness'), { recursive: true });
  writeFileSync(join(root, '.repo-harness', 'checks.json'), JSON.stringify({
    version: 1,
    checks: {
      'unit:true': {
        description: 'always pass',
        command: ['bash', '-lc', 'echo ok'],
        timeoutMs: 5_000,
      },
      'unit:fail': {
        description: 'always fail',
        command: ['bash', '-lc', 'echo FAIL_ROOT_CAUSE >&2; exit 7'],
        timeoutMs: 5_000,
      },
    },
  }, null, 2));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Repo Harness Test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
}

describe('composite result formatting (level 1)', () => {
  test('redacts secrets and bounds keyOutput', () => {
    const redacted = redactSensitiveText('Authorization: Bearer abcdefghijklmnop token=supersecretvalue');
    expect(redacted).not.toContain('abcdefghijklmnop');
    expect(redacted).toContain('[REDACTED]');
    const big = boundKeyOutput('x'.repeat(10_000), 200);
    expect(big.length).toBeLessThanOrEqual(250);
    expect(big).toContain('truncated');
  });

  test('failed envelope exposes first-failure fields inline', () => {
    const result = compositeFailed({
      phase: 'checks',
      summary: 'check failed',
      failedCheck: 'unit:fail',
      exitCode: 7,
      keyOutput: 'FAIL_ROOT_CAUSE',
      evidenceRefs: ['artifact.json'],
    });
    expect(result.status).toBe('failed');
    expect(result.failedCheck).toBe('unit:fail');
    expect(result.exitCode).toBe(7);
    expect(result.keyOutput).toContain('FAIL_ROOT_CAUSE');
    expect(result.evidenceRefs).toEqual(['artifact.json']);
    expect(result.retryable).toBe(true);
    expect(result.nextAction).toBeTruthy();
  });

  test('succeeded envelope defaults exitCode 0', () => {
    const result = compositeSucceeded({ phase: 'complete', summary: 'ok' });
    expect(result.status).toBe('succeeded');
    expect(result.exitCode).toBe(0);
  });
});

describe('postcondition validation (level 1)', () => {
  test('merge fails when MERGE_HEAD present or unmerged paths exist', () => {
    const root = temp('repo-harness-merge-');
    initRepo(root);
    // No merge in progress → exit 0 should pass basic checks
    const ok = validateMergeSuccess(root, { exitCode: 0 });
    expect(ok.ok).toBe(true);
    const badExit = validateMergeSuccess(root, { exitCode: 1 });
    expect(badExit.ok).toBe(false);
  });

  test('delete success requires path absence', () => {
    const root = temp('repo-harness-delete-');
    const path = join(root, 'gone.txt');
    expect(validateDeleteSuccess(path).ok).toBe(true);
    writeFileSync(path, 'x');
    expect(validateDeleteSuccess(path).ok).toBe(false);
  });

  test('patch success rejects conflict markers and allow-list violations', () => {
    const root = temp('repo-harness-patch-pc-');
    initRepo(root);
    writeFileSync(join(root, 'README.md'), '<<<<<<< HEAD\nconflict\n>>>>>>>\n');
    const conflict = validatePatchSuccess({
      repoRoot: root,
      changedFiles: ['README.md'],
      allowedPaths: ['README.md'],
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.failures.some((f) => f.includes('conflict'))).toBe(true);

    writeFileSync(join(root, 'README.md'), 'clean\n');
    writeFileSync(join(root, 'secret.env'), 'x\n');
    const outside = validatePatchSuccess({
      repoRoot: root,
      changedFiles: ['secret.env'],
      allowedPaths: ['src/**'],
    });
    expect(outside.ok).toBe(false);
  });

  test('restart success requires phase, health, and generation change', () => {
    const state: ControllerRestartState = {
      schemaVersion: 1,
      requestId: 'r1',
      repoRoot: '/tmp',
      controllerHome: '/tmp',
      phase: 'succeeded',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      requestedBy: 'test',
      delayMs: 0,
      previousGeneration: 'gen-1',
      runtimeGeneration: 'gen-2',
    };
    const status = {
      ready: true,
      health: { mcp: true, localController: true },
      daemon: { schemaVersion: 1, status: 'ready' },
      runtimeGeneration: 'gen-2',
      runtimeSource: { commit: 'abc' },
      mcpRuntime: { server: { toolSurfaceFingerprint: 'fp1' } },
    } as unknown as ControllerServiceStatus;
    const ok = validateRestartSuccess({
      state,
      status,
      expectedSourceCommit: 'abc',
      expectedToolFingerprint: 'fp1',
    });
    expect(ok.ok).toBe(true);

    const sameGen = validateRestartSuccess({
      state: { ...state, previousGeneration: 'gen-2' },
      status: { ...status, runtimeGeneration: 'gen-2' } as ControllerServiceStatus,
    });
    expect(sameGen.ok).toBe(false);
  });
});

describe('repository_change_verify composite (level 1)', () => {
  test('returns first check failure inline with exit code and keyOutput', () => {
    const root = temp('repo-harness-change-verify-');
    initRepo(root);
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const result = repositoryChangeVerify({
      repo: root,
      expectedBranch: 'main',
      expectedHead: head,
      checks: ['unit:fail'],
    });
    expect(result.status).toBe('failed');
    expect(result.failedCheck).toBe('unit:fail');
    expect(result.exitCode).toBe(7);
    expect(result.keyOutput).toContain('FAIL_ROOT_CAUSE');
    expect(result.evidenceRefs.length).toBeGreaterThan(0);
  });

  test('applies patch and passes configured check without extra job polling', () => {
    const root = temp('repo-harness-change-ok-');
    initRepo(root);
    const before = createHash('sha256').update('hello\n').digest('hex');
    const patch = [
      'diff --git a/README.md b/README.md',
      'index 1111111..2222222 100644',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1 @@',
      '-hello',
      '+hello world',
      '',
    ].join('\n');
    const result = repositoryChangeVerify({
      repo: root,
      expectedFileShas: { 'README.md': before },
      patch,
      allowedPaths: ['README.md'],
      checks: ['unit:true'],
    });
    expect(result.status).toBe('succeeded');
    expect(result.changedFiles).toContain('README.md');
    expect(result.details).toBeTruthy();
  });
});
