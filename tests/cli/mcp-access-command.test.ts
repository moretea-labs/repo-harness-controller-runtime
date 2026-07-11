import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { readRepositoryAccessPolicy } from '../../src/runtime/control-plane/governance/access-policy';

const ROOT = join(import.meta.dir, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');
const roots: string[] = [];

function createRepository(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `repo-harness-${name}-`));
  roots.push(root);
  expect(spawnSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' }).status).toBe(0);
  writeFileSync(join(root, 'README.md'), `# ${name}\n`);
  expect(spawnSync('git', ['add', 'README.md'], { cwd: root, stdio: 'ignore' }).status).toBe(0);
  expect(spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], {
    cwd: root,
    stdio: 'ignore',
  }).status).toBe(0);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('mcp access command', () => {
  test('sets Full Access for every enabled repository through the shared access tool', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-access-cli-home-'));
    roots.push(controllerHome);
    ensureControllerHome(controllerHome);
    const firstRoot = createRepository('access-cli-first');
    const secondRoot = createRepository('access-cli-second');
    const first = registerRepository({
      path: firstRoot,
      controllerHome,
      repoIdOverride: 'repo-access-cli-first',
    });
    const second = registerRepository({
      path: secondRoot,
      controllerHome,
      repoIdOverride: 'repo-access-cli-second',
    });

    const result = spawnSync('bun', [
      CLI,
      'mcp',
      'access',
      'set',
      '--repo',
      firstRoot,
      '--controller-home',
      controllerHome,
      '--all-repositories',
      '--mode',
      'full_access',
      '--confirm-authorization',
      '--confirmation-text',
      'enable-full-access-all',
    ], {
      cwd: ROOT,
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const payload = JSON.parse(result.stdout) as { scope?: string; updatedCount?: number };
    expect(payload.scope).toBe('all_enabled_repositories');
    expect(payload.updatedCount).toBe(2);
    expect(readRepositoryAccessPolicy(controllerHome, first.repoId).mode).toBe('full_access');
    expect(readRepositoryAccessPolicy(controllerHome, second.repoId).mode).toBe('full_access');
  });
});
