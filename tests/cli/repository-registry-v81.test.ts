import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  normalizeRemoteUrl,
  stableCheckoutId,
  stableRemoteRepoId,
} from '../../src/cli/repositories/identity';
import {
  listRepositories,
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
});
