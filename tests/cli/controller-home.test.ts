import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { resolveRepoPreferredControllerHome } from '../../src/cli/repositories/controller-home';

const roots: string[] = [];
const originalControllerHome = process.env.REPO_HARNESS_CONTROLLER_HOME;

afterEach(() => {
  if (originalControllerHome === undefined) delete process.env.REPO_HARNESS_CONTROLLER_HOME;
  else process.env.REPO_HARNESS_CONTROLLER_HOME = originalControllerHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repo-preferred controller home', () => {
  test('uses repo _ops/controller-home when present and no explicit override exists', () => {
    delete process.env.REPO_HARNESS_CONTROLLER_HOME;
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-controller-home-'));
    roots.push(repoRoot);
    const controllerHome = join(repoRoot, '_ops', 'controller-home');
    mkdirSync(join(controllerHome, 'mcp'), { recursive: true });
    writeFileSync(join(controllerHome, 'mcp', 'mcp.local.json'), '{}\n');

    expect(resolveRepoPreferredControllerHome(repoRoot)).toBe(resolve(controllerHome));
  });

  test('keeps explicit controller home above repo-local discovery', () => {
    delete process.env.REPO_HARNESS_CONTROLLER_HOME;
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-controller-home-'));
    const explicit = mkdtempSync(join(tmpdir(), 'repo-harness-controller-home-explicit-'));
    roots.push(repoRoot, explicit);
    mkdirSync(join(repoRoot, '_ops', 'controller-home'), { recursive: true });

    expect(resolveRepoPreferredControllerHome(repoRoot, explicit)).toBe(resolve(explicit));
  });
});
