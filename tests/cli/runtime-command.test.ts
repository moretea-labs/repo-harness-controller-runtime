import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';

const ROOT = join(import.meta.dir, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');

describe('runtime command surface', () => {
  test('includes unified lifecycle entrypoints', () => {
    const result = spawnSync('bun', [CLI, 'runtime', '--help'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('start');
    expect(result.stdout).toContain('stop');
    expect(result.stdout).toContain('restart');
    expect(result.stdout).toContain('status');
    expect(result.stdout).toContain('doctor');
  });
});
