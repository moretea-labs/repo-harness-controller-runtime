import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireControllerLock, releaseControllerLock } from '../../src/cli/repositories/locks';
import {
  GlobalScheduler,
  isSchedulerResourcePressured,
  parseDarwinAvailableMemoryMb,
  sampleDarwinAvailableMemoryMb,
} from '../../src/runtime/control-plane/global-scheduler/scheduler';
import { attachExecutionWorker, createExecutionJob, getExecutionJob } from '../../src/runtime/execution/jobs/store';

const roots: string[] = [];
const originalPerRepoWorkers = process.env.REPO_HARNESS_PER_REPO_WORKERS;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-scheduler-capacity-'));
  roots.push(root);
  return root;
}

function createCheck(controllerHome: string, repoId: string, requestId: string): string {
  return createExecutionJob(controllerHome, {
    repoId,
    type: 'check',
    requestId,
    semanticKey: `check:${requestId}`,
    origin: { surface: 'mcp' },
    payload: { operation: 'run_check', target: 'mcp-tool' },
    resourceClaims: [],
  }).job.jobId;
}

function testScheduler(controllerHome: string, maxWorkers: number): GlobalScheduler {
  const scheduler = new GlobalScheduler(controllerHome, {
    maxWorkers,
    maxConcurrentRepositories: 8,
    maxHeavyChecks: 8,
    minFreeMemoryMb: 64,
    maxLoadPerCpu: 1_000,
  });
  const internal = scheduler as unknown as {
    lastReconcile: number;
    lastScheduleTick: number;
    lastPortfolioTick: number;
    spawnWorker: (repoId: string, jobId: string) => boolean;
  };
  const now = Date.now();
  internal.lastReconcile = now;
  internal.lastScheduleTick = now;
  internal.lastPortfolioTick = now;
  internal.spawnWorker = () => true;
  return scheduler;
}

afterEach(() => {
  if (originalPerRepoWorkers === undefined) delete process.env.REPO_HARNESS_PER_REPO_WORKERS;
  else process.env.REPO_HARNESS_PER_REPO_WORKERS = originalPerRepoWorkers;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('scheduler capacity', () => {
  test('counts reclaimable macOS pages as available memory', () => {
    const availableMemoryMb = parseDarwinAvailableMemoryMb(`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               32768.
Pages active:                            999999.
Pages inactive:                          16384.
Pages speculative:                        4096.
Pages wired down:                        999999.
Pages purgeable:                           2048.
Pages occupied by compressor:            999999.
`);

    expect(availableMemoryMb).toBe(864);
    expect(isSchedulerResourcePressured(
      { freeMemoryMb: availableMemoryMb!, loadPerCpu: 0.4 },
      { minFreeMemoryMb: 512, maxLoadPerCpu: 1.5 },
    )).toBe(false);
  });

  test('fails closed to the caller fallback when vm_stat cannot be parsed', () => {
    expect(parseDarwinAvailableMemoryMb('unrecognized output')).toBeUndefined();
  });

  test('samples macOS memory asynchronously and preserves the fallback contract', async () => {
    const output = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               32768.
Pages inactive:                          16384.
Pages speculative:                        4096.
Pages purgeable:                           2048.
`;
    expect(await sampleDarwinAvailableMemoryMb(128, (callback) => callback(null, output))).toBe(864);
    expect(await sampleDarwinAvailableMemoryMb(128, (callback) => callback(null, 'invalid'))).toBe(128);
    expect(await sampleDarwinAvailableMemoryMb(128, (callback) => callback(new Error('unavailable'), ''))).toBe(128);
    expect(await sampleDarwinAvailableMemoryMb(128, () => { throw new Error('spawn failed'); })).toBe(128);
  });

  test('still applies real memory and load pressure limits', () => {
    const limits = { minFreeMemoryMb: 512, maxLoadPerCpu: 1.5 };
    expect(isSchedulerResourcePressured({ freeMemoryMb: 128, loadPerCpu: 0.4 }, limits)).toBe(true);
    expect(isSchedulerResourcePressured({ freeMemoryMb: 2_048, loadPerCpu: 2 }, limits)).toBe(true);
  });

  test('counts dispatched jobs as global reservations before PID binding', async () => {
    const controllerHome = tempRoot();
    const first = createCheck(controllerHome, 'repo-a', 'global-cap-a');
    const second = createCheck(controllerHome, 'repo-b', 'global-cap-b');
    const firstScheduler = testScheduler(controllerHome, 1);
    const secondScheduler = testScheduler(controllerHome, 1);

    await Promise.all([firstScheduler.tick(), secondScheduler.tick()]);

    const jobs = [
      getExecutionJob(controllerHome, 'repo-a', first),
      getExecutionJob(controllerHome, 'repo-b', second),
    ];
    expect(jobs.filter((job) => job.status === 'dispatched')).toHaveLength(1);
    expect(jobs.filter((job) => job.status === 'queued')).toHaveLength(1);
    expect(jobs.find((job) => job.status === 'dispatched')?.workerPid).toBeUndefined();
  });

  test('binds the worker pid without re-entering the scheduler dispatch lock', async () => {
    const controllerHome = tempRoot();
    const jobId = createCheck(controllerHome, 'repo-a', 'bind-after-dispatch-lock');
    const scheduler = testScheduler(controllerHome, 1);
    const internal = scheduler as unknown as {
      spawnWorker: (repoId: string, jobId: string) => boolean;
    };
    internal.spawnWorker = (repoId, currentJobId) => Boolean(
      attachExecutionWorker(controllerHome, repoId, currentJobId, 41_001),
    );

    await scheduler.tick();

    const job = getExecutionJob(controllerHome, 'repo-a', jobId);
    expect(job.status).toBe('running');
    expect(job.workerPid).toBe(41_001);
  });

  test('keeps a second same-repository job queued at the per-repo hard limit', async () => {
    process.env.REPO_HARNESS_PER_REPO_WORKERS = '1';
    const controllerHome = tempRoot();
    const first = createCheck(controllerHome, 'repo-a', 'repo-cap-a');
    const second = createCheck(controllerHome, 'repo-a', 'repo-cap-b');
    const firstScheduler = testScheduler(controllerHome, 4);
    const secondScheduler = testScheduler(controllerHome, 4);

    await Promise.all([firstScheduler.tick(), secondScheduler.tick()]);

    const jobs = [
      getExecutionJob(controllerHome, 'repo-a', first),
      getExecutionJob(controllerHome, 'repo-a', second),
    ];
    expect(jobs.filter((job) => job.status === 'dispatched')).toHaveLength(1);
    expect(jobs.filter((job) => job.status === 'queued')).toHaveLength(1);
  });

  test('fails closed when another scheduler owns the dedicated dispatch lock', async () => {
    const controllerHome = tempRoot();
    const jobId = createCheck(controllerHome, 'repo-a', 'lock-contention');
    const scheduler = testScheduler(controllerHome, 4);
    const dispatchLock = {
      scope: 'task' as const,
      repoId: '__controller__',
      taskId: 'global-scheduler-dispatch',
    };
    const lock = acquireControllerLock(controllerHome, dispatchLock, 'scheduler-capacity-test', 10_000);

    try {
      await scheduler.tick();
    } finally {
      releaseControllerLock(controllerHome, dispatchLock, lock.lockId);
    }

    expect(getExecutionJob(controllerHome, 'repo-a', jobId).status).toBe('queued');
  });
});
