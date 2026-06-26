import { describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureRepositoryRuntimeStorage } from '../../src/cli/repositories/runtime-storage';
import { repositoryFixture } from './repository-v81-fixture';

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('v8.1 runtime storage active-state migration guards', () => {
  test('does not relocate a legacy Run while it is starting', () => {
    const fixture = repositoryFixture();
    try {
      const source = join(fixture.repoA.canonicalRoot, '.ai', 'harness', 'jobs');
      writeJson(join(source, 'RUN-starting', 'meta.json'), {
        schemaVersion: 3,
        runId: 'RUN-starting',
        status: 'starting',
      });

      const storage = ensureRepositoryRuntimeStorage(fixture.repoA, fixture.controllerHome);
      expect(storage.readyForExecution).toBe(false);
      expect(storage.bindings.find((entry) => entry.name === 'runs')?.status).toBe('legacy-active');
      expect(lstatSync(source).isSymbolicLink()).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('does not relocate a legacy Local Job pending approval', () => {
    const fixture = repositoryFixture();
    try {
      const source = join(fixture.repoA.canonicalRoot, '.ai', 'harness', 'local-jobs');
      writeJson(join(source, 'JOB-pending', 'job.json'), {
        schemaVersion: 1,
        jobId: 'JOB-pending',
        status: 'pending_approval',
      });

      const storage = ensureRepositoryRuntimeStorage(fixture.repoA, fixture.controllerHome);
      expect(storage.readyForExecution).toBe(false);
      expect(storage.bindings.find((entry) => entry.name === 'local-jobs')?.status).toBe('legacy-active');
      expect(lstatSync(source).isSymbolicLink()).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('does not relocate an incomplete Local Job directory without job.json', () => {
    const fixture = repositoryFixture();
    try {
      const source = join(fixture.repoA.canonicalRoot, '.ai', 'harness', 'local-jobs');
      mkdirSync(join(source, 'JOB-incomplete'), { recursive: true });

      const storage = ensureRepositoryRuntimeStorage(fixture.repoA, fixture.controllerHome);
      expect(storage.readyForExecution).toBe(false);
      expect(storage.bindings.find((entry) => entry.name === 'local-jobs')?.status).toBe('legacy-active');
      expect(lstatSync(source).isSymbolicLink()).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});
