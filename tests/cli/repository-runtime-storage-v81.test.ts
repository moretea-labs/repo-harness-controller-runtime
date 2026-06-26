import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { callMultiRepositoryTool, createMcpToolContext } from '../../src/cli/mcp/server';
import { repositoryControllerRoot } from '../../src/cli/repositories/controller-home';
import { ensureRepositoryRuntimeStorage } from '../../src/cli/repositories/runtime-storage';
import { repositoryFixture } from './repository-v81-fixture';

function writeRun(root: string, runId: string, status: string, marker: string): void {
  const directory = join(root, '.ai', 'harness', 'jobs', runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'meta.json'), `${JSON.stringify({
    schemaVersion: 3,
    runId,
    status,
    marker,
  }, null, 2)}\n`, 'utf-8');
}

function writeLocalJob(root: string, jobId: string, status: string, marker: string): void {
  const directory = join(root, '.ai', 'harness', 'local-jobs', jobId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'job.json'), `${JSON.stringify({
    schemaVersion: 1,
    jobId,
    status,
    marker,
  }, null, 2)}\n`, 'utf-8');
}

describe('v8.1 repository runtime storage isolation', () => {
  test('isolates identical Run IDs for two repositories under Controller Home', () => {
    const fixture = repositoryFixture();
    try {
      const storageA = ensureRepositoryRuntimeStorage(fixture.repoA, fixture.controllerHome);
      const storageB = ensureRepositoryRuntimeStorage(fixture.repoB, fixture.controllerHome);
      expect(storageA.readyForExecution).toBe(true);
      expect(storageB.readyForExecution).toBe(true);

      const sourceA = join(fixture.repoA.canonicalRoot, '.ai', 'harness', 'jobs');
      const sourceB = join(fixture.repoB.canonicalRoot, '.ai', 'harness', 'jobs');
      const targetA = join(repositoryControllerRoot(fixture.controllerHome, fixture.repoA.repoId), 'runs');
      const targetB = join(repositoryControllerRoot(fixture.controllerHome, fixture.repoB.repoId), 'runs');
      expect(lstatSync(sourceA).isSymbolicLink()).toBe(true);
      expect(lstatSync(sourceB).isSymbolicLink()).toBe(true);
      expect(realpathSync(sourceA)).toBe(realpathSync(targetA));
      expect(realpathSync(sourceB)).toBe(realpathSync(targetB));

      writeRun(fixture.repoA.canonicalRoot, 'RUN-same', 'succeeded', 'repo-a');
      writeRun(fixture.repoB.canonicalRoot, 'RUN-same', 'succeeded', 'repo-b');
      expect(readFileSync(join(targetA, 'RUN-same', 'meta.json'), 'utf-8')).toContain('repo-a');
      expect(readFileSync(join(targetB, 'RUN-same', 'meta.json'), 'utf-8')).toContain('repo-b');
    } finally {
      fixture.cleanup();
    }
  });

  test('isolates Local Job tickets and MCP audit data under Controller Home', () => {
    const fixture = repositoryFixture();
    try {
      const storage = ensureRepositoryRuntimeStorage(fixture.repoA, fixture.controllerHome);
      expect(storage.readyForExecution).toBe(true);

      const controllerRoot = repositoryControllerRoot(fixture.controllerHome, fixture.repoA.repoId);
      const localJobsSource = join(fixture.repoA.canonicalRoot, '.ai', 'harness', 'local-jobs');
      const localJobsTarget = join(controllerRoot, 'local-jobs');
      const mcpSource = join(fixture.repoA.canonicalRoot, '.ai', 'harness', 'mcp');
      const mcpTarget = join(controllerRoot, 'mcp');

      expect(storage.bindings.find((binding) => binding.name === 'local-jobs')?.status).toBe('linked');
      expect(storage.bindings.find((binding) => binding.name === 'mcp')?.status).toBe('linked');
      expect(lstatSync(localJobsSource).isSymbolicLink()).toBe(true);
      expect(lstatSync(mcpSource).isSymbolicLink()).toBe(true);
      expect(realpathSync(localJobsSource)).toBe(realpathSync(localJobsTarget));
      expect(realpathSync(mcpSource)).toBe(realpathSync(mcpTarget));

      writeLocalJob(fixture.repoA.canonicalRoot, 'JOB-same', 'succeeded', 'controller-home');
      writeFileSync(join(mcpSource, 'audit.log'), '{"tool":"controller_ready"}\n', 'utf-8');

      expect(readFileSync(join(localJobsTarget, 'JOB-same', 'job.json'), 'utf-8')).toContain('controller-home');
      expect(readFileSync(join(mcpTarget, 'audit.log'), 'utf-8')).toContain('controller_ready');
    } finally {
      fixture.cleanup();
    }
  });

  test('migrates terminal legacy Local Jobs before linking repository runtime storage', () => {
    const fixture = repositoryFixture();
    try {
      writeLocalJob(fixture.repoA.canonicalRoot, 'JOB-legacy', 'succeeded', 'terminal');
      const storage = ensureRepositoryRuntimeStorage(fixture.repoA, fixture.controllerHome);
      const binding = storage.bindings.find((entry) => entry.name === 'local-jobs');
      const source = join(fixture.repoA.canonicalRoot, '.ai', 'harness', 'local-jobs');
      const target = join(repositoryControllerRoot(fixture.controllerHome, fixture.repoA.repoId), 'local-jobs');
      expect(storage.readyForExecution).toBe(true);
      expect(binding?.status).toBe('migrated');
      expect(lstatSync(source).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(target, 'JOB-legacy', 'job.json'), 'utf-8')).toContain('terminal');
    } finally {
      fixture.cleanup();
    }
  });

  test('blocks execution while an active legacy Local Job remains repository-local', () => {
    const fixture = repositoryFixture();
    try {
      writeLocalJob(fixture.repoA.canonicalRoot, 'JOB-active', 'running', 'active');
      const storage = ensureRepositoryRuntimeStorage(fixture.repoA, fixture.controllerHome);
      const binding = storage.bindings.find((entry) => entry.name === 'local-jobs');
      const source = join(fixture.repoA.canonicalRoot, '.ai', 'harness', 'local-jobs');
      expect(storage.readyForExecution).toBe(false);
      expect(binding?.status).toBe('legacy-active');
      expect(lstatSync(source).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(source, 'JOB-active', 'job.json'), 'utf-8')).toContain('active');
    } finally {
      fixture.cleanup();
    }
  });

  test('migrates terminal legacy Runs before linking repository runtime storage', () => {
    const fixture = repositoryFixture();
    try {
      writeRun(fixture.repoA.canonicalRoot, 'RUN-legacy', 'succeeded', 'terminal');
      const storage = ensureRepositoryRuntimeStorage(fixture.repoA, fixture.controllerHome);
      const runs = storage.bindings.find((binding) => binding.name === 'runs');
      const source = join(fixture.repoA.canonicalRoot, '.ai', 'harness', 'jobs');
      const target = join(repositoryControllerRoot(fixture.controllerHome, fixture.repoA.repoId), 'runs');
      expect(storage.readyForExecution).toBe(true);
      expect(runs?.status).toBe('migrated');
      expect(lstatSync(source).isSymbolicLink()).toBe(true);
      expect(existsSync(join(target, 'RUN-legacy', 'meta.json'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('blocks execution while an active legacy Run remains repository-local', async () => {
    const fixture = repositoryFixture();
    try {
      writeRun(fixture.repoA.canonicalRoot, 'RUN-active', 'running', 'active');
      const storage = ensureRepositoryRuntimeStorage(fixture.repoA, fixture.controllerHome);
      const runs = storage.bindings.find((binding) => binding.name === 'runs');
      expect(storage.readyForExecution).toBe(false);
      expect(runs?.status).toBe('legacy-active');
      expect(lstatSync(join(fixture.repoA.canonicalRoot, '.ai', 'harness', 'jobs')).isSymbolicLink()).toBe(false);

      const ctx = createMcpToolContext({ controllerHome: fixture.controllerHome, profile: 'controller' });
      const result = await callMultiRepositoryTool(ctx, 'dispatch_task', {
        repo_id: fixture.repoA.repoId,
        issue_id: 'ISS-missing',
        task_id: 'TASK-missing',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('RUNTIME_STORAGE_NOT_READY');
    } finally {
      fixture.cleanup();
    }
  });

  test('preserves non-empty legacy worktree storage and reports an explicit blocker', () => {
    const fixture = repositoryFixture();
    try {
      const worktree = join(fixture.repoA.canonicalRoot, '.ai', 'harness', 'worktrees', 'active-worktree');
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, 'marker.txt'), 'do not move\n', 'utf-8');
      const storage = ensureRepositoryRuntimeStorage(fixture.repoA, fixture.controllerHome);
      const binding = storage.bindings.find((entry) => entry.name === 'worktrees');
      expect(storage.readyForExecution).toBe(false);
      expect(binding?.status).toBe('legacy-active');
      expect(existsSync(join(worktree, 'marker.txt'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
