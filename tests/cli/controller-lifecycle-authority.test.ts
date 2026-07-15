import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import {
  CONTROLLER_LIFECYCLE_OWNER_ENV,
  assertControllerLifecycleOwner,
  isControllerLifecycleOwnerEnvironment,
} from '../../src/cli/controller/lifecycle-authority';

const ROOT = join(import.meta.dir, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');

function run(args: string[]) {
  const env = { ...process.env };
  delete env[CONTROLLER_LIFECYCLE_OWNER_ENV];
  return spawnSync('bun', [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
  });
}

describe('single Controller lifecycle authority', () => {
  test('recognizes only the explicit lifecycle owner environment', () => {
    expect(isControllerLifecycleOwnerEnvironment({})).toBe(false);
    expect(isControllerLifecycleOwnerEnvironment({ [CONTROLLER_LIFECYCLE_OWNER_ENV]: '0' })).toBe(false);
    expect(isControllerLifecycleOwnerEnvironment({ [CONTROLLER_LIFECYCLE_OWNER_ENV]: '1' })).toBe(true);
    expect(() => assertControllerLifecycleOwner('test component')).toThrow('repo-harness controller start|stop|restart|status|logs');
  });

  test('rejects direct Controller HTTP and keepalive startup', () => {
    for (const args of [
      ['mcp', 'serve', '--transport', 'http', '--profile', 'controller'],
      ['mcp', 'keepalive', '--profile', 'controller'],
    ]) {
      const result = run(args);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('repo-harness controller start|stop|restart|status|logs|rollout|rollback');
    }
  });

  test('does not expose legacy lifecycle entry points', () => {
    const controllerHelp = run(['controller', '--help']);
    expect(controllerHelp.status).toBe(0);
    expect(controllerHelp.stdout).not.toMatch(/^\s+service\b/m);
    expect(controllerHelp.stdout).not.toMatch(/^\s+ui\b/m);

    const mcpHelp = run(['mcp', '--help']);
    expect(mcpHelp.status).toBe(0);
    expect(mcpHelp.stdout).not.toMatch(/^\s+restart\b/m);
  });
});
