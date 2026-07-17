import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createExecutionJob, getExecutionJob } from '../../src/runtime/execution/jobs/store';
import { GlobalScheduler } from '../../src/runtime/control-plane/global-scheduler/scheduler';

const homes: string[] = [];

function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'repo-harness-worker-test-'));
  homes.push(value);
  return value;
}

function createReadOnlyJob(controllerHome: string, requestId: string) {
  return createExecutionJob(controllerHome, {
    repoId: '__controller__',
    type: 'mcp-tool',
    requestId,
    semanticKey: requestId,
    origin: { surface: 'mcp', actor: 'test' },
    payload: { operation: 'repository_list', target: 'repository-tool' },
    resourceClaims: [],
    maxAttempts: 1,
  }).job;
}

async function waitForTerminal(controllerHome: string, jobId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let job = getExecutionJob(controllerHome, '__controller__', jobId);
  while (!['succeeded', 'failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(job.status)) {
    if (Date.now() >= deadline) throw new Error(`worker test timed out in ${job.status}`);
    await Bun.sleep(25);
    job = getExecutionJob(controllerHome, '__controller__', jobId);
  }
  return job;
}

afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('durable Execution Worker lifecycle', () => {
  test('starts with an absolute Bun executable when PATH does not contain node', async () => {
    const controllerHome = home();
    const job = createReadOnlyJob(controllerHome, 'worker-no-node-path');
    const previousPath = process.env.PATH;
    process.env.PATH = '/usr/bin';
    try {
      const scheduler = new GlobalScheduler(controllerHome, {
        maxWorkers: 1,
        maxConcurrentRepositories: 1,
        maxHeavyChecks: 1,
        minFreeMemoryMb: 1,
        maxLoadPerCpu: 1000,
        pollIntervalMs: 25,
      }, { runtimeSourceRoot: process.cwd(), ownerEpoch: 'test-epoch' });
      await scheduler.tick();
      const finished = await waitForTerminal(controllerHome, job.jobId);
      expect(finished.status).toBe('succeeded');
      expect(finished.workerLifecycle?.executable).toBe(process.execPath);
      expect(finished.workerLifecycle?.environment.PATH).toBe('/usr/bin');
      expect(finished.workerLifecycle?.attempt).toBe(finished.attempt);
      expect(finished.workerLifecycle?.maxAttempts).toBe(finished.maxAttempts);
      await Bun.sleep(50);
      expect(getExecutionJob(controllerHome, '__controller__', job.jobId).workerLifecycle?.startupState).toBe('exited');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test('persists startup stderr, exit code, cwd, and lifecycle state for an immediate Worker failure', async () => {
    const controllerHome = home();
    const runtimeSourceRoot = mkdtempSync(join(tmpdir(), 'repo-harness-worker-entry-'));
    homes.push(runtimeSourceRoot);
    const workerEntry = join(runtimeSourceRoot, 'src', 'runtime', 'execution', 'workers', 'worker-entry.ts');
    mkdirSync(join(runtimeSourceRoot, 'src', 'runtime', 'execution', 'workers'), { recursive: true });
    writeFileSync(workerEntry, 'console.error("worker startup boom"); setTimeout(() => process.exit(7), 10);\n', 'utf8');
    const job = createReadOnlyJob(controllerHome, 'worker-startup-failure');

    const scheduler = new GlobalScheduler(controllerHome, {
      maxWorkers: 1,
      maxConcurrentRepositories: 1,
      maxHeavyChecks: 1,
      minFreeMemoryMb: 1,
      maxLoadPerCpu: 1000,
      pollIntervalMs: 25,
    }, { runtimeSourceRoot, ownerEpoch: 'test-epoch' });
    await scheduler.tick();
    const finished = await waitForTerminal(controllerHome, job.jobId);

    expect(finished.status).toBe('failed');
    expect(finished.error?.code).toBe('WORKER_EXITED');
    expect(finished.error?.details).toMatchObject({
      executable: process.execPath,
      cwd: runtimeSourceRoot,
      exitCode: 7,
      ownerEpoch: 'test-epoch',
      stderr: expect.stringContaining('worker startup boom'),
    });
    const stderrPath = finished.error?.details?.stderrPath;
    expect(typeof stderrPath).toBe('string');
    expect(existsSync(stderrPath as string)).toBe(true);
    expect(readFileSync(stderrPath as string, 'utf8')).toContain('worker startup boom');
    expect(finished.workerLifecycle?.exitCode).toBe(7);
    expect(finished.workerLifecycle?.processGroupId).toBeTypeOf('number');
    expect(finished.workerLifecycle?.startupState).toBe('exited');
  });
});
