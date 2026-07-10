import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bootstrapManagedRuntimeEnv } from '../../src/runtime/shared/managed-env';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_GMAIL_ACCESS_TOKEN;
  delete process.env.REPO_HARNESS_GOOGLE_ACCESS_TOKEN;
  delete process.env.REPO_HARNESS_ENV_FILE;
  delete process.env.APP_ONLY_SECRET;
});

describe('managed runtime env bootstrap', () => {
  test('loads repo-harness variables from _ops/env/.env.local', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-env-'));
    roots.push(repoRoot);
    mkdirSync(join(repoRoot, '_ops', 'env'), { recursive: true });
    writeFileSync(join(repoRoot, '_ops', 'env', '.env.local'), [
      'REPO_HARNESS_GMAIL_ACCESS_TOKEN=token-from-local-env',
      'APP_ONLY_SECRET=must-not-load',
      '',
    ].join('\n'));

    const result = bootstrapManagedRuntimeEnv({ repoRoot });
    expect(result.loadedFiles).toContain(join(repoRoot, '_ops', 'env', '.env.local'));
    expect(result.appliedKeys).toContain('REPO_HARNESS_GMAIL_ACCESS_TOKEN');
    expect(process.env.REPO_HARNESS_GMAIL_ACCESS_TOKEN).toBe('token-from-local-env');
    expect(process.env.APP_ONLY_SECRET).toBeUndefined();
  });

  test('keeps explicit process env ahead of managed files', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-env-'));
    roots.push(repoRoot);
    mkdirSync(join(repoRoot, '_ops', 'secrets'), { recursive: true });
    writeFileSync(join(repoRoot, '_ops', 'secrets', 'repo-harness.env'), 'REPO_HARNESS_GMAIL_ACCESS_TOKEN=file-token\n');
    process.env.REPO_HARNESS_GMAIL_ACCESS_TOKEN = 'shell-token';

    const result = bootstrapManagedRuntimeEnv({ repoRoot });
    expect(result.loadedFiles).toContain(join(repoRoot, '_ops', 'secrets', 'repo-harness.env'));
    expect(result.appliedKeys).not.toContain('REPO_HARNESS_GMAIL_ACCESS_TOKEN');
    expect(process.env.REPO_HARNESS_GMAIL_ACCESS_TOKEN).toBe('shell-token');
  });

  test('loads managed variables from the controllerHome parent when cwd is outside the repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-controller-home-env-'));
    roots.push(root);
    const controllerHome = join(root, '_ops', 'controller-home');
    mkdirSync(join(root, '_ops', 'secrets'), { recursive: true });
    mkdirSync(controllerHome, { recursive: true });
    writeFileSync(
      join(root, '_ops', 'secrets', 'controller.env'),
      'REPO_HARNESS_GOOGLE_ACCESS_TOKEN=controller-home-token\n',
    );

    const result = bootstrapManagedRuntimeEnv({
      controllerHome,
      cwd: tmpdir(),
    });

    expect(result.loadedFiles).toContain(join(root, '_ops', 'secrets', 'controller.env'));
    expect(result.appliedKeys).toContain('REPO_HARNESS_GOOGLE_ACCESS_TOKEN');
    expect(process.env.REPO_HARNESS_GOOGLE_ACCESS_TOKEN).toBe('controller-home-token');
  });
});
