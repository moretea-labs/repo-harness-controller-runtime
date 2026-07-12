import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GlobalScheduler } from '../../src/runtime/control-plane/global-scheduler/scheduler';
import { reconcileExecutionJobsAsync } from '../../src/runtime/control-plane/global-scheduler/reconciliation';
import { createExecutionJob, cancelExecutionJob, getExecutionJob, updateExecutionJob } from '../../src/runtime/execution/jobs/store';
import { isProcessAlive, isProcessStatAlive, listProcessTreeMembers, terminateProcessTree } from '../../src/runtime/shared/process-tree';

const roots: string[] = [];
const trackedPids = new Set<number>();

function tempRoot(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(25);
  }
  throw new Error('timed out waiting for test process state');
}

async function spawnDetachedProcessTree(): Promise<{ leader: ChildProcess; leaderPid: number; childPid: number }> {
  const childPidPath = join(tempRoot('repo-harness-process-tree-'), 'child.pid');
  const leader = spawn('node', ['-e', `
    const { spawn } = require("child_process");
    const { writeFileSync } = require("fs");
    const childPidPath = process.argv[1];
    const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(childPidPath, String(child.pid), "utf8");
    setInterval(() => {}, 1000);
  `, childPidPath], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  leader.unref();
  if (!leader.pid) throw new Error('leader pid missing');
  trackedPids.add(leader.pid);
  const childPid = await waitFor(() => {
    if (!existsSync(childPidPath)) return undefined;
    const value = Number.parseInt(readFileSync(childPidPath, 'utf8').trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  });
  trackedPids.add(childPid);
  await waitFor(() => (isProcessAlive(leader.pid) && isProcessAlive(childPid) ? true : undefined));
  return { leader, leaderPid: leader.pid, childPid };
}

afterEach(async () => {
  for (const pid of trackedPids) {
    await terminateProcessTree(pid, { gracePeriodMs: 100, killAfterMs: 500, pollIntervalMs: 25 });
  }
  trackedPids.clear();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('worker process-tree reclamation', () => {
  test('treats POSIX zombie states as already exited', () => {
    expect(isProcessStatAlive('Z')).toBe(false);
    expect(isProcessStatAlive('Z+')).toBe(false);
    expect(isProcessStatAlive('S+')).toBe(true);
    expect(isProcessStatAlive(undefined)).toBe(false);
  });

  test('cancelExecutionJob waits for the full worker process tree to exit', async () => {
    const controllerHome = tempRoot('repo-harness-cancel-home-');
    const { leaderPid, childPid } = await spawnDetachedProcessTree();
    const created = createExecutionJob(controllerHome, {
      repoId: 'repo-a',
      type: 'check',
      requestId: 'cancel-process-tree',
      semanticKey: 'check:cancel-process-tree',
      origin: { surface: 'mcp' },
      payload: { operation: 'run_check', target: 'mcp-tool' },
      resourceClaims: [{ resourceKey: 'repo-state', mode: 'read' }],
    }).job;
    updateExecutionJob(controllerHome, 'repo-a', created.jobId, (job) => ({
      ...job,
      status: 'running',
      workerPid: leaderPid,
      attempt: 1,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }));

    const cancelled = await cancelExecutionJob(controllerHome, 'repo-a', created.jobId, 'test cancellation');

    expect(cancelled.status).toBe('cancelled');
    expect(isProcessAlive(leaderPid)).toBe(false);
    expect(isProcessAlive(childPid)).toBe(false);
    expect(listProcessTreeMembers(leaderPid)).toHaveLength(0);
  });

  test('reconcileExecutionJobs fully reaps timed-out worker process trees', async () => {
    const controllerHome = tempRoot('repo-harness-timeout-home-');
    const { leaderPid, childPid } = await spawnDetachedProcessTree();
    const created = createExecutionJob(controllerHome, {
      repoId: 'repo-a',
      type: 'check',
      requestId: 'timeout-process-tree',
      semanticKey: 'check:timeout-process-tree',
      origin: { surface: 'mcp' },
      payload: { operation: 'run_check', target: 'mcp-tool' },
      resourceClaims: [{ resourceKey: 'repo-state', mode: 'read' }],
      maxAttempts: 1,
    }).job;
    updateExecutionJob(controllerHome, 'repo-a', created.jobId, (job) => ({
      ...job,
      status: 'running',
      workerPid: leaderPid,
      attempt: 1,
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 10_000).toISOString(),
      deadlineAt: new Date(Date.now() - 1_000).toISOString(),
    }));

    const result = await reconcileExecutionJobsAsync(controllerHome);
    const refreshed = getExecutionJob(controllerHome, 'repo-a', created.jobId);

    expect(result.terminal).toBe(1);
    expect(refreshed.status).toBe('timed_out');
    expect(isProcessAlive(leaderPid)).toBe(false);
    expect(isProcessAlive(childPid)).toBe(false);
  });

  test('reconcileExecutionJobs safely requeues a lost worker before retries are exhausted', async () => {
    const controllerHome = tempRoot('repo-harness-worker-requeue-home-');
    const created = createExecutionJob(controllerHome, {
      repoId: 'repo-a',
      type: 'check',
      requestId: 'worker-lost-requeue',
      semanticKey: 'check:worker-lost-requeue',
      origin: { surface: 'mcp' },
      payload: { operation: 'run_check', target: 'mcp-tool' },
      resourceClaims: [{ resourceKey: 'repo-state', mode: 'read' }],
      maxAttempts: 2,
    }).job;
    updateExecutionJob(controllerHome, 'repo-a', created.jobId, (job) => ({
      ...job,
      status: 'running',
      workerPid: undefined,
      attempt: 1,
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    }));

    const result = await reconcileExecutionJobsAsync(controllerHome);
    const refreshed = getExecutionJob(controllerHome, 'repo-a', created.jobId);

    expect(result.requeued).toBe(1);
    expect(refreshed.status).toBe('queued');
    expect(refreshed.error?.code).toBe('WORKER_LOST');
    expect(refreshed.error?.retryable).toBe(true);
  });

  test('reconcileExecutionJobs marks worker-lost jobs failed after max attempts', async () => {
    const controllerHome = tempRoot('repo-harness-worker-lost-home-');
    const created = createExecutionJob(controllerHome, {
      repoId: 'repo-a',
      type: 'check',
      requestId: 'worker-lost-terminal',
      semanticKey: 'check:worker-lost-terminal',
      origin: { surface: 'mcp' },
      payload: { operation: 'run_check', target: 'mcp-tool' },
      resourceClaims: [{ resourceKey: 'repo-state', mode: 'read' }],
      maxAttempts: 1,
    }).job;
    updateExecutionJob(controllerHome, 'repo-a', created.jobId, (job) => ({
      ...job,
      status: 'running',
      workerPid: undefined,
      attempt: 1,
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    }));

    const result = await reconcileExecutionJobsAsync(controllerHome);
    const refreshed = getExecutionJob(controllerHome, 'repo-a', created.jobId);

    expect(result.terminal).toBe(1);
    expect(refreshed.status).toBe('failed');
    expect(refreshed.error?.code).toBe('WORKER_LOST');
    expect(refreshed.error?.retryable).toBe(false);
  });

  test('keeps a live synchronous worker running until its durable deadline', async () => {
    const controllerHome = tempRoot('repo-harness-stale-heartbeat-home-');
    const { leaderPid, childPid } = await spawnDetachedProcessTree();
    const created = createExecutionJob(controllerHome, {
      repoId: 'repo-a',
      type: 'check',
      requestId: 'stale-heartbeat-terminal',
      semanticKey: 'check:stale-heartbeat-terminal',
      origin: { surface: 'mcp' },
      payload: { operation: 'run_check', target: 'mcp-tool' },
      resourceClaims: [{ resourceKey: 'repo-state', mode: 'read' }],
      maxAttempts: 1,
    }).job;
    updateExecutionJob(controllerHome, 'repo-a', created.jobId, (job) => ({
      ...job,
      status: 'running',
      workerPid: leaderPid,
      attempt: 1,
      startedAt: new Date(Date.now() - 70_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 70_000).toISOString(),
    }));

    const result = await reconcileExecutionJobsAsync(controllerHome);
    const refreshed = getExecutionJob(controllerHome, 'repo-a', created.jobId);

    expect(result.terminal).toBe(0);
    expect(result.requeued).toBe(0);
    expect(refreshed.status).toBe('running');
    expect(refreshed.workerPid).toBe(leaderPid);
    expect(isProcessAlive(leaderPid)).toBe(true);
    expect(isProcessAlive(childPid)).toBe(true);
  });

  test('scheduler shutdown waits for spawned worker trees before returning', async () => {
    const controllerHome = tempRoot('repo-harness-scheduler-home-');
    const { leader, leaderPid, childPid } = await spawnDetachedProcessTree();
    const scheduler = new GlobalScheduler(controllerHome);
    const internal = scheduler as unknown as {
      children: Map<string, ChildProcess>;
      cleanupSpawnedWorkers: () => Promise<void>;
    };
    internal.children.set('job-under-test', leader);

    await internal.cleanupSpawnedWorkers();

    expect(isProcessAlive(leaderPid)).toBe(false);
    expect(isProcessAlive(childPid)).toBe(false);
  });
});
