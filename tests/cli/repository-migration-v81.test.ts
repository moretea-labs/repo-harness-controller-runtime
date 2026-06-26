import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { bindRepositoryEntities } from '../../src/cli/repositories/entity-migration';
import { repositoryFixture } from './repository-v81-fixture';

describe('v8.1 repository ownership migration', () => {
  test('binds legacy durable entities to the owning repository', () => {
    const fixture = repositoryFixture();
    try {
      const repo = fixture.repoA;
      const issuePath = join(repo.canonicalRoot, 'tasks', 'issues', 'ISS-1-example.issue.json');
      writeFileSync(issuePath, JSON.stringify({
        schemaVersion: 5,
        id: 'ISS-1',
        title: 'Example',
        tasks: [{ id: 'T1', verification: { checkResults: [] } }],
      }), 'utf-8');
      const jobRoot = join(repo.canonicalRoot, '.ai', 'harness', 'jobs', 'RUN-1');
      mkdirSync(jobRoot, { recursive: true });
      writeFileSync(join(jobRoot, 'meta.json'), JSON.stringify({
        schemaVersion: 2,
        runId: 'RUN-1',
        issueId: 'ISS-1',
        taskId: 'T1',
        repoRoot: repo.canonicalRoot,
        worktree: repo.canonicalRoot,
      }), 'utf-8');
      const editRoot = join(repo.canonicalRoot, '.ai', 'harness', 'edit-sessions', 'EDIT-1');
      mkdirSync(editRoot, { recursive: true });
      writeFileSync(join(editRoot, 'session.json'), JSON.stringify({ sessionId: 'EDIT-1' }), 'utf-8');
      writeFileSync(join(repo.canonicalRoot, '.ai', 'harness', 'worklog.jsonl'), `${JSON.stringify({ action: 'legacy' })}\n`, 'utf-8');

      const report = bindRepositoryEntities(repo);
      expect(report.unresolved).toBe(0);
      expect(report.updated).toBe(4);
      const issue = JSON.parse(readFileSync(issuePath, 'utf-8'));
      expect(issue.repoId).toBe(repo.repoId);
      expect(issue.tasks[0].repoId).toBe(repo.repoId);
      expect(issue.tasks[0].verification.repoId).toBe(repo.repoId);
      const run = JSON.parse(readFileSync(join(jobRoot, 'meta.json'), 'utf-8'));
      expect(run.repoId).toBe(repo.repoId);
      expect(run.checkoutId).toBe(repo.activeCheckoutId);
      expect(run.executionRoot).toBe(repo.canonicalRoot);
    } finally {
      fixture.cleanup();
    }
  });

  test('retains conflicting ownership as unresolved instead of rebinding', () => {
    const fixture = repositoryFixture();
    try {
      const issuePath = join(fixture.repoA.canonicalRoot, 'tasks', 'issues', 'ISS-conflict.issue.json');
      writeFileSync(issuePath, JSON.stringify({
        schemaVersion: 5,
        repoId: fixture.repoB.repoId,
        id: 'ISS-conflict',
        title: 'Conflict',
        tasks: [],
      }), 'utf-8');
      const report = bindRepositoryEntities(fixture.repoA);
      expect(report.unresolved).toBe(1);
      expect(JSON.parse(readFileSync(issuePath, 'utf-8')).repoId).toBe(fixture.repoB.repoId);
    } finally {
      fixture.cleanup();
    }
  });

  test('rebinds conflicting run ownership when the run roots still prove local ownership', () => {
    const fixture = repositoryFixture();
    try {
      const jobRoot = join(fixture.repoA.canonicalRoot, '.ai', 'harness', 'jobs', 'RUN-rebind');
      mkdirSync(jobRoot, { recursive: true });
      writeFileSync(join(jobRoot, 'meta.json'), JSON.stringify({
        schemaVersion: 2,
        runId: 'RUN-rebind',
        repoId: fixture.repoB.repoId,
        checkoutId: fixture.repoB.activeCheckoutId,
        repoRoot: fixture.repoA.canonicalRoot,
        worktree: fixture.repoA.canonicalRoot,
        executionRoot: fixture.repoA.canonicalRoot,
        worktreePath: fixture.repoA.canonicalRoot,
      }), 'utf-8');

      const report = bindRepositoryEntities(fixture.repoA);
      expect(report.unresolved).toBe(0);
      expect(report.updated).toBe(1);
      const run = JSON.parse(readFileSync(join(jobRoot, 'meta.json'), 'utf-8'));
      expect(run.repoId).toBe(fixture.repoA.repoId);
      expect(run.checkoutId).toBe(fixture.repoA.activeCheckoutId);
    } finally {
      fixture.cleanup();
    }
  });
});
