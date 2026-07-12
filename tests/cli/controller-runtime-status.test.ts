import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { controllerServiceStatus } from '../../src/cli/controller/lifecycle';
import { collectRuntimeSourceIdentity, rotateRuntimeGeneration } from '../../src/runtime/control-plane/runtime-generation';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(repoRoot: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

describe('controller runtime status', () => {
  test('marks restartRequired when the active runtime commit falls behind main', async () => {
    const repoRoot = tempRoot('repo-harness-runtime-status-repo-');
    const controllerHome = tempRoot('repo-harness-runtime-status-home-');
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'status-fixture' }, null, 2));
    git(repoRoot, 'init', '-b', 'main');
    git(repoRoot, 'config', 'user.email', 'test@example.com');
    git(repoRoot, 'config', 'user.name', 'Repo Harness Test');
    git(repoRoot, 'add', 'package.json');
    git(repoRoot, 'commit', '-m', 'init');

    const startedFrom = collectRuntimeSourceIdentity(repoRoot);
    rotateRuntimeGeneration(controllerHome, startedFrom);

    writeFileSync(join(repoRoot, 'README.md'), '# advanced\n');
    git(repoRoot, 'add', 'README.md');
    git(repoRoot, 'commit', '-m', 'advance main');

    const status = await controllerServiceStatus({ repo: repoRoot, controllerHome });
    expect(status.runtimeGeneration).toBeTruthy();
    expect(status.authority.runtimeState.authority).toBe('controller-home');
    expect(status.restartRequired).toBe(true);
    expect(status.restartReasons.some((reason) => reason.includes('runtime commit'))).toBe(true);
  });
});
