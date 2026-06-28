import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerDaemon } from '../../src/runtime/control-plane/daemon-client';
import { GlobalScheduler } from '../../src/runtime/control-plane/global-scheduler/scheduler';
import {
  cleanupControllerRuntimeState,
  runtimeCleanupLogPath,
  type RuntimeCleanupReport,
} from '../../src/runtime/control-plane/runtime-cleanup';
import { isProcessAlive } from '../../src/runtime/shared/process-tree';

const homes: string[] = [];
const daemonPids = new Set<number>();

function controllerHome(): string {
  const value = mkdtempSync(join(tmpdir(), 'repo-harness-runtime-cleanup-'));
  homes.push(value);
  return value;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(25);
  }
  throw new Error('timed out waiting for test state');
}

function cleanupEntries(home: string): RuntimeCleanupReport[] {
  const path = runtimeCleanupLogPath(home);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeCleanupReport);
}

function writeDaemonState(home: string, pid: number): void {
  mkdirSync(join(home, 'daemon'), { recursive: true });
  writeFileSync(join(home, 'daemon', 'controller.pid'), `${pid}\n`, 'utf8');
  writeFileSync(join(home, 'daemon', 'state.json'), `${JSON.stringify({
    schemaVersion: 1,
    status: 'ready',
    pid,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  }, null, 2)}\n`, 'utf8');
}

function age(path: string, ageMs = 8 * 60 * 60_000): void {
  const old = new Date(Date.now() - ageMs);
  utimesSync(path, old, old);
}

afterEach(async () => {
  for (const pid of daemonPids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // The daemon may already be gone.
    }
    await waitFor(() => (!isProcessAlive(pid) ? true : undefined), 5_000).catch(() => undefined);
  }
  daemonPids.clear();
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe('runtime cleanup', () => {
  test('startup cleanup removes stale daemon pid files and records the action', async () => {
    const home = controllerHome();
    mkdirSync(join(home, 'daemon'), { recursive: true });
    writeFileSync(join(home, 'daemon', 'controller.pid'), 'not-a-pid\n', 'utf8');
    writeFileSync(join(home, 'daemon', 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'ready',
      pid: 999_999,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    }, null, 2)}\n`, 'utf8');

    const status = ensureControllerDaemon(home);
    if (status.pid) daemonPids.add(status.pid);

    await waitFor(() => cleanupEntries(home).find((entry) => entry.reason === 'startup'));
    const startup = cleanupEntries(home).find((entry) => entry.reason === 'startup');

    expect(startup?.removedPidFiles).toContain('daemon/controller.pid');
    expect(startup?.removedWorktrees).toEqual([]);
    expect(existsSync(runtimeCleanupLogPath(home))).toBe(true);
  });

  test('protects the current Controller PID even when command identity differs', () => {
    const home = controllerHome();
    writeDaemonState(home, 41_001);

    const report = cleanupControllerRuntimeState(home, {
      protectedControllerPid: 41_001,
      inspectProcess: () => ({ alive: true, commandLine: '/usr/bin/sleep 100' }),
    });

    expect(existsSync(join(home, 'daemon', 'controller.pid'))).toBe(true);
    expect(report.removedPidFiles).toEqual([]);
    expect(report.skippedPidFiles).toContain('daemon/controller.pid');
  });

  test('removes a reused PID reference without signaling the unrelated live process', () => {
    const home = controllerHome();
    writeDaemonState(home, 41_002);
    let inspections = 0;

    const report = cleanupControllerRuntimeState(home, {
      inspectProcess: () => {
        inspections += 1;
        return { alive: true, commandLine: '/usr/bin/sleep 100' };
      },
    });

    expect(inspections).toBe(1);
    expect(existsSync(join(home, 'daemon', 'controller.pid'))).toBe(false);
    expect(report.removedPidFiles).toContain('daemon/controller.pid');
    const state = JSON.parse(readFileSync(join(home, 'daemon', 'state.json'), 'utf8')) as { status: string };
    expect(state.status).toBe('stopped');
  });

  test('fails closed when a live PID command identity cannot be inspected', () => {
    const home = controllerHome();
    writeDaemonState(home, 41_003);

    const report = cleanupControllerRuntimeState(home, {
      inspectProcess: () => ({ alive: true }),
    });

    expect(existsSync(join(home, 'daemon', 'controller.pid'))).toBe(true);
    expect(report.skippedPidFiles).toContain('daemon/controller.pid');
    expect(report.errors.some((entry) => entry.includes('command identity is unavailable'))).toBe(true);
  });

  test('scheduler periodic cleanup removes expired temp state and orphaned worktrees without touching active ones', async () => {
    const home = controllerHome();
    const activeWorktree = join(home, 'repositories', 'repo-a', 'worktrees', 'RUN-active');
    const orphanWorktree = join(home, 'repositories', 'repo-a', 'worktrees', 'RUN-orphaned');
    const runMetaPath = join(home, 'repositories', 'repo-a', 'runs', 'RUN-active', 'meta.json');
    const staleTempPath = join(home, 'repositories', 'repo-a', 'execution-jobs', 'records', 'job.json.123.tmp');
    mkdirSync(activeWorktree, { recursive: true });
    mkdirSync(orphanWorktree, { recursive: true });
    mkdirSync(join(home, 'repositories', 'repo-a', 'runs', 'RUN-active'), { recursive: true });
    mkdirSync(join(home, 'repositories', 'repo-a', 'execution-jobs', 'records'), { recursive: true });
    writeFileSync(runMetaPath, `${JSON.stringify({
      schemaVersion: 3,
      runId: 'RUN-active',
      issueId: 'ISS-1',
      taskId: 'T1',
      agent: 'codex',
      provider: 'local',
      executionMode: 'worktree',
      status: 'running',
      repoRoot: '/repo',
      worktree: activeWorktree,
      branch: 'controller/branch',
      baseRevision: 'HEAD',
      promptPath: 'prompt.md',
      stdoutPath: 'stdout.log',
      stderrPath: 'stderr.log',
      resultPath: 'result.json',
      eventsPath: 'events.jsonl',
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    writeFileSync(staleTempPath, 'temporary\n', 'utf8');
    age(activeWorktree);
    age(orphanWorktree);
    age(staleTempPath);

    const scheduler = new GlobalScheduler(home, { pollIntervalMs: 1 });
    await scheduler.tick();

    expect(existsSync(activeWorktree)).toBe(true);
    expect(existsSync(orphanWorktree)).toBe(false);
    expect(existsSync(staleTempPath)).toBe(false);

    const periodic = cleanupEntries(home).find((entry) => entry.reason === 'periodic');
    expect(periodic?.removedWorktrees).toContain('repositories/repo-a/worktrees/RUN-orphaned');
    expect(periodic?.removedTemporaryPaths).toContain('repositories/repo-a/execution-jobs/records/job.json.123.tmp');
    expect(periodic?.skippedActiveWorktrees).toContain('repositories/repo-a/worktrees/RUN-active');
  });

  test('malformed Run metadata prevents worktree deletion for that repository', () => {
    const home = controllerHome();
    const worktree = join(home, 'repositories', 'repo-a', 'worktrees', 'RUN-unknown');
    const runRoot = join(home, 'repositories', 'repo-a', 'runs', 'RUN-broken');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(join(runRoot, 'meta.json'), '{not-json', 'utf8');
    age(worktree);

    const report = cleanupControllerRuntimeState(home, { maxEntries: 100 });

    expect(existsSync(worktree)).toBe(true);
    expect(report.skippedActiveWorktrees).toContain('repositories/repo-a/worktrees/RUN-unknown');
    expect(report.errors.some((entry) => entry.includes('unreadable Run metadata'))).toBe(true);
  });

  test('stops scanning at the configured budget and records truncation', () => {
    const home = controllerHome();
    const records = join(home, 'repositories', 'repo-a', 'execution-jobs', 'records');
    mkdirSync(records, { recursive: true });
    for (let index = 0; index < 20; index += 1) {
      const path = join(records, `record-${index}.tmp`);
      writeFileSync(path, 'temporary\n', 'utf8');
      age(path);
    }

    const report = cleanupControllerRuntimeState(home, { maxEntries: 3 });

    expect(report.inspectedPaths).toBeLessThanOrEqual(3);
    expect(report.budgetExhausted).toBe(true);
    expect(cleanupEntries(home).at(-1)?.budgetExhausted).toBe(true);
  });

  test('a cleanup failure does not interrupt the scheduler tick', async () => {
    const home = controllerHome();
    const scheduler = new GlobalScheduler(home, { pollIntervalMs: 1 });
    const internal = scheduler as unknown as {
      runtimeCleanup: () => never;
    };
    internal.runtimeCleanup = () => {
      throw new Error('synthetic cleanup failure');
    };
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await expect(scheduler.tick()).resolves.toEqual({ activeJobs: 0 });
    } finally {
      console.error = originalError;
    }
  });
});
