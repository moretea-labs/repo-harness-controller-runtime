import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { spawnSync } from 'child_process';

const ROOT = join(import.meta.dir, '..', '..');
const CLI = join(ROOT, 'src/cli/index.ts');

describe('repository command entry', () => {
  test('main CLI help exposes the repo command', () => {
    const result = spawnSync('bun', [CLI, '--help'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('  repo');
    expect(result.stdout).toContain('Register and inspect repositories managed by the');
    expect(result.stdout).toContain('global Controller');
  });

  test('repo help exposes the rollout command', () => {
    const result = spawnSync('bun', [CLI, 'repo', '--help'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('diagnose-local');
    expect(result.stdout).toContain('bootstrap-local');
    expect(result.stdout).toContain('rollout');
    expect(result.stdout).toContain('Apply the latest repo-harness workflow to');
    expect(result.stdout).toContain('registered repositories and restart');
    expect(result.stdout).toContain('configured MCP controllers');
  });
});
