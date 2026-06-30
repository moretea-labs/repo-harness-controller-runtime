import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { repositoryScopedToolArgs } from '../../src/cli/mcp/multi-repository';
import {
  acquireControllerLock,
  controllerLockPath,
  readControllerLock,
  releaseControllerLock,
} from '../../src/cli/repositories/locks';
import { repositoryFixture } from './repository-v81-fixture';

describe('v8.1 repository lock and remote routing', () => {
  test('repository locks conflict only within the same repoId', () => {
    const fixture = repositoryFixture();
    const keyA = { scope: 'repository' as const, repoId: fixture.repoA.repoId };
    const keyB = { scope: 'repository' as const, repoId: fixture.repoB.repoId };
    const lockA = acquireControllerLock(fixture.controllerHome, keyA, 'repo-a-test');
    let lockB: ReturnType<typeof acquireControllerLock> | undefined;
    try {
      expect(() => acquireControllerLock(fixture.controllerHome, keyA, 'same-repo-test'))
        .toThrow('LOCK_HELD');
      lockB = acquireControllerLock(fixture.controllerHome, keyB, 'repo-b-test');
      expect(lockB.repoId).toBe(fixture.repoB.repoId);
    } finally {
      if (lockB) releaseControllerLock(fixture.controllerHome, keyB, lockB.lockId);
      releaseControllerLock(fixture.controllerHome, keyA, lockA.lockId);
      fixture.cleanup();
    }
  });

  test('named global locks isolate unrelated controller resources', () => {
    const fixture = repositoryFixture();
    const indexKey = { scope: 'global' as const, resource: 'execution-index' };
    const requestKey = { scope: 'global' as const, resource: 'execution-request-abc' };
    const indexLock = acquireControllerLock(fixture.controllerHome, indexKey, 'index-owner');
    let requestLock: ReturnType<typeof acquireControllerLock> | undefined;
    try {
      requestLock = acquireControllerLock(fixture.controllerHome, requestKey, 'request-owner');
      expect(requestLock.path).not.toBe(indexLock.path);
      expect(() => acquireControllerLock(fixture.controllerHome, indexKey, 'second-index-owner', 10_000, 0))
        .toThrow('LOCK_HELD');
    } finally {
      if (requestLock) releaseControllerLock(fixture.controllerHome, requestKey, requestLock.lockId);
      releaseControllerLock(fixture.controllerHome, indexKey, indexLock.lockId);
      fixture.cleanup();
    }
  });

  test('reaps an expired lock even while its recorded pid is alive', () => {
    const fixture = repositoryFixture();
    const key = { scope: 'global' as const, resource: 'expired-live-owner' };
    try {
      const path = controllerLockPath(fixture.controllerHome, key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({
        ...key,
        lockId: 'global:expired-live-owner',
        owner: 'expired-owner',
        pid: process.pid,
        acquiredAt: '2026-06-24T00:00:00.000Z',
        heartbeatAt: '2026-06-24T00:00:00.000Z',
        expiresAt: '2026-06-24T00:00:01.000Z',
        path,
      }, null, 2)}\n`, 'utf-8');
      expect(readControllerLock(fixture.controllerHome, key)).toBeUndefined();
      const reacquired = acquireControllerLock(fixture.controllerHome, key, 'fresh-owner');
      releaseControllerLock(fixture.controllerHome, key, reacquired.lockId);
    } finally {
      fixture.cleanup();
    }
  });

  test('reaps a repository lock whose owner pid is no longer alive', () => {
    const fixture = repositoryFixture();
    const key = { scope: 'repository' as const, repoId: fixture.repoA.repoId };
    try {
      const path = controllerLockPath(fixture.controllerHome, key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({
        ...key,
        lockId: 'repository:stale',
        owner: 'stale-test',
        pid: 999_999_999,
        acquiredAt: '2026-06-24T00:00:00.000Z',
        path,
      }, null, 2)}\n`, 'utf-8');
      expect(readControllerLock(fixture.controllerHome, key)).toBeUndefined();
      expect(() => readFileSync(path, 'utf-8')).toThrow();
      const reacquired = acquireControllerLock(fixture.controllerHome, key, 'fresh-owner');
      releaseControllerLock(fixture.controllerHome, key, reacquired.lockId);
    } finally {
      fixture.cleanup();
    }
  });

  test('injects repository-specific GitHub and default branch mappings', () => {
    const fixture = repositoryFixture();
    try {
      const repository = {
        ...fixture.repoA,
        defaultBranch: 'release/v8.1',
        github: {
          owner: 'example-owner',
          repo: 'repo-a-remote',
          labels: ['controller', 'v8.1'],
          projectOwner: 'example-owner',
          projectNumber: 81,
        },
      };
      const dispatch = repositoryScopedToolArgs('dispatch_task', {
        repo_id: repository.repoId,
        issue_id: 'ISS-1',
        task_id: 'TASK-1',
      }, repository);
      expect(dispatch.repo_id).toBeUndefined();
      expect(dispatch.github_repo).toBe('example-owner/repo-a-remote');
      expect(dispatch.base_ref).toBe('release/v8.1');

      const publish = repositoryScopedToolArgs('publish_issue_to_github', {
        repo_id: repository.repoId,
        issue_id: 'ISS-1',
      }, repository);
      expect(publish.repo).toBe('example-owner/repo-a-remote');
      expect(publish.labels).toEqual(['controller', 'v8.1']);
      expect(publish.project_owner).toBe('example-owner');
      expect(publish.project_number).toBe(81);
    } finally {
      fixture.cleanup();
    }
  });

  test('does not override explicit GitHub routing arguments', () => {
    const fixture = repositoryFixture();
    try {
      const repository = {
        ...fixture.repoA,
        defaultBranch: 'main',
        github: { owner: 'registry-owner', repo: 'registry-repo' },
      };
      const args = repositoryScopedToolArgs('dispatch_task', {
        repo_id: repository.repoId,
        github_repo: 'explicit-owner/explicit-repo',
        base_ref: 'hotfix',
      }, repository);
      expect(args.github_repo).toBe('explicit-owner/explicit-repo');
      expect(args.base_ref).toBe('hotfix');
    } finally {
      fixture.cleanup();
    }
  });
});
