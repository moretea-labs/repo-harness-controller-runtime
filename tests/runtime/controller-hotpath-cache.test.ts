import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  collectCurrentControllerRuntimeSourceIdentity,
  collectRuntimeSourceIdentity,
  clearRuntimeSourceIdentityCacheForTest,
  CONTROLLER_RUNTIME_SOURCE_ROOT_ENV,
} from '../../src/runtime/control-plane/runtime-generation';
import {
  clearRuntimeProcessListCacheForTest,
  collectRuntimeProcesses,
} from '../../src/runtime/diagnostics/performance';
import { clearGitSnapshotCacheForTest, gitSnapshot } from '../../src/cli/repository/inspector';

const roots: string[] = [];
const previousRuntimeSourceEnv = process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  clearRuntimeSourceIdentityCacheForTest();
  clearRuntimeProcessListCacheForTest();
  clearGitSnapshotCacheForTest();
  if (previousRuntimeSourceEnv === undefined) delete process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV];
  else process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV] = previousRuntimeSourceEnv;
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function initRepo(root: string): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'hotpath-fixture' }, null, 2));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export const ready = true;\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Repo Harness Test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
}

describe('controller hotpath caches', () => {
  test('current controller runtime source identity reuses a short-lived cache entry', () => {
    const root = temp('repo-harness-identity-cache-');
    initRepo(root);
    process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV] = root;
    clearRuntimeSourceIdentityCacheForTest();
    const first = collectCurrentControllerRuntimeSourceIdentity();
    const second = collectCurrentControllerRuntimeSourceIdentity();
    expect(first).toBeTruthy();
    expect(second).toEqual(first);
    expect(second?.observedAt).toBe(first?.observedAt);
    // Explicit collect remains uncached so startup/dirty checks stay immediate.
    const explicit = collectRuntimeSourceIdentity(root);
    expect(explicit.canonicalRoot).toBe(first!.canonicalRoot);
  });

  test('gitSnapshot reuses cache within TTL', () => {
    const root = temp('repo-harness-git-cache-');
    initRepo(root);
    const first = gitSnapshot(root);
    const second = gitSnapshot(root);
    expect(second).toEqual(first);
  });

  test('process list cache returns the same base samples within TTL', () => {
    const first = collectRuntimeProcesses();
    const second = collectRuntimeProcesses();
    expect(second.map((entry) => entry.pid)).toEqual(first.map((entry) => entry.pid));
    const forced = collectRuntimeProcesses([], { forceRefresh: true });
    expect(Array.isArray(forced)).toBe(true);
  });
});
