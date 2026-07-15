import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import {
  normalizeRemoteUrl,
  stableCheckoutId,
  stableRemoteRepoId,
} from '../../src/cli/repositories/identity';
import {
  listRepositories,
  refreshRepository,
  registerRepository,
  updateRepository,
  validateRepository,
  resolveRepositorySelection,
} from '../../src/cli/repositories/registry';
import { repositoryFixture } from './repository-v81-fixture';

describe('v8.1 repository identity and selection', () => {
  test('normalizes SSH and HTTPS forms to one stable repository identity', () => {
    const ssh = normalizeRemoteUrl('git@github.com:Example/Same.git');
    const https = normalizeRemoteUrl('https://GITHUB.com/example/same.git');
    expect(ssh).toBe('github.com/example/same');
    expect(https).toBe(ssh);
    expect(stableRemoteRepoId(ssh!)).toBe(stableRemoteRepoId(https!));
  });

  test('keeps repository and checkout identities separate', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-v81-checkouts-'));
    try {
      const repoId = stableRemoteRepoId('github.com/example/same');
      expect(stableCheckoutId(repoId, join(root, 'one')))
        .not.toBe(stableCheckoutId(repoId, join(root, 'two')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects an implicit selection when two repositories are enabled', () => {
    const fixture = repositoryFixture();
    try {
      expect(listRepositories(fixture.controllerHome)).toHaveLength(2);
      expect(() => resolveRepositorySelection({ controllerHome: fixture.controllerHome }))
        .toThrow('REPOSITORY_AMBIGUOUS');
      expect(resolveRepositorySelection({
        controllerHome: fixture.controllerHome,
        repoId: fixture.repoB.repoId,
      }).repoId).toBe(fixture.repoB.repoId);
    } finally {
      fixture.cleanup();
    }
  });

  test('refresh preserves repoId when the Git origin changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-v81-refresh-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-v81-controller-'));
    try {
      execSync('git init -q', { cwd: root });
      execSync('git remote add origin https://github.com/example/original.git', { cwd: root });
      const registered = registerRepository({ path: root, controllerHome });
      execSync('git remote set-url origin https://github.com/example/renamed.git', { cwd: root });
      const refreshed = refreshRepository(registered.repoId, controllerHome);
      expect(refreshed.repoId).toBe(registered.repoId);
      expect(refreshed.canonicalRemote).toBe('github.com/example/renamed');
      expect(listRepositories(controllerHome)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });


  test('reports remote and GitHub mapping drift without changing repoId', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-v81-diagnostics-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-v81-diagnostics-controller-'));
    try {
      execSync('git init -q', { cwd: root });
      execSync('git remote add origin https://github.com/example/original.git', { cwd: root });
      const registered = registerRepository({ path: root, controllerHome });
      execSync('git remote set-url origin https://github.com/example/renamed.git', { cwd: root });
      const validation = validateRepository(registered.repoId, controllerHome);
      expect(validation.ok).toBe(false);
      expect(validation.githubMappingMatches).toBe(false);
      expect(validation.warnings.join('\n')).toContain('was not changed automatically');
      expect(listRepositories(controllerHome)[0]?.repoId).toBe(registered.repoId);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('registers GitHub repositories with the GitHub plugin enabled by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-v81-register-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-v81-register-controller-'));
    try {
      execSync('git init -q', { cwd: root });
      execSync('git remote add origin https://github.com/example/repo-a.git', { cwd: root });
      const registered = registerRepository({
        path: root,
        controllerHome,
      });
      expect(registered.github?.pluginEnabled).toBe(true);
      expect(registered.github?.repository).toBe('example/repo-a');
      expect(registered.github?.syncMode).toBe('manual');
      expect(registered.github?.includeTasks).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('reuses the repo-local identity for remote repositories', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-v81-local-identity-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-v81-local-identity-controller-'));
    try {
      mkdirSync(join(root, '.ai', 'harness'), { recursive: true });
      writeFileSync(join(root, '.ai', 'harness', 'repository.json'), JSON.stringify({
        schemaVersion: 1,
        repoId: 'repo_preserved_from_local_identity',
        checkoutId: 'checkout_previous',
        stateStorageStrategy: 'hybrid',
      }, null, 2));
      execSync('git init -q', { cwd: root });
      execSync('git remote add origin https://github.com/example/repo-a.git', { cwd: root });

      const registered = registerRepository({ path: root, controllerHome });
      expect(registered.repoId).toBe('repo_preserved_from_local_identity');
      expect(listRepositories(controllerHome)[0]?.repoId).toBe('repo_preserved_from_local_identity');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('allows explicit enable to restore a disabled repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-v81-restore-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-v81-restore-controller-'));
    try {
      execSync('git init -q', { cwd: root });
      const registered = registerRepository({ path: root, controllerHome });
      const disabled = updateRepository(registered.repoId, { enabled: false }, controllerHome);
      expect(disabled.enabled).toBe(false);

      expect(() => resolveRepositorySelection({
        controllerHome,
        repoId: registered.repoId,
      })).toThrow(`repository is disabled: ${registered.repoId}`);

      const restored = updateRepository(registered.repoId, { enabled: true }, controllerHome);
      expect(restored.enabled).toBe(true);
      expect(restored.disabledAt).toBeUndefined();
      expect(resolveRepositorySelection({
        controllerHome,
        repoId: registered.repoId,
      }).repoId).toBe(registered.repoId);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('re-registering the same disabled path reuses repoId and restores execution', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-v81-reregister-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-v81-reregister-controller-'));
    try {
      execSync('git init -q', { cwd: root });
      const registered = registerRepository({ path: root, controllerHome });
      updateRepository(registered.repoId, { enabled: false }, controllerHome);

      const restored = registerRepository({ path: root, controllerHome });
      expect(restored.repoId).toBe(registered.repoId);
      expect(restored.enabled).toBe(true);
      expect(restored.removedAt).toBeUndefined();
      expect(listRepositories(controllerHome)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });
});
