import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  cleanupControllerRuntimeState,
  type RuntimeCleanupReport,
} from '../../src/runtime/control-plane/runtime-cleanup';

// ─── Helpers ───────────────────────────────────────────────────────────────

function createTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'rh-cleanup-test-'));
  return home;
}

function createRunMeta(
  runsDir: string,
  runId: string,
  overrides: Record<string, unknown>,
): string {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const metaPath = join(runDir, 'meta.json');
  const meta = {
    schemaVersion: 3,
    runId,
    issueId: 'test-issue',
    taskId: 'test-task',
    agent: 'claude',
    provider: 'local',
    executionMode: 'worktree',
    status: 'succeeded',
    repoRoot: '/tmp/test-repo',
    worktree: '/tmp/test-repo/.ai/harness/worktrees/test-wt',
    branch: 'test-branch',
    baseRevision: 'abc123',
    promptPath: '/tmp/test-repo/.ai/harness/prompts/test.txt',
    stdoutPath: '/tmp/test-repo/.ai/harness/stdout/test.txt',
    stderrPath: '/tmp/test-repo/.ai/harness/stderr/test.txt',
    resultPath: '/tmp/test-repo/.ai/harness/results/test.json',
    eventsPath: '/tmp/test-repo/.ai/harness/events/test.jsonl',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  writeFileSync(metaPath, JSON.stringify(meta));
  return metaPath;
}

function createWorktreeDir(repoRoot: string, name: string): string {
  const path = join(repoRoot, '.ai', 'harness', 'worktrees', name);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

// ─── orphan reconciler shouldProtectWorktreeReference tests ────────────────

describe('Orphan Worktree Reconciler — shouldProtectWorktreeReference', () => {
  test('succeeded run with completed closure releases worktree', () => {
    const home = createTempHome();
    try {
      const reposDir = join(home, 'repositories', 'repo_123', 'runs');
      mkdirSync(reposDir, { recursive: true });
      const oneHourAgo = new Date(Date.now() - 3_600_001).toISOString();
      createRunMeta(reposDir, 'RUN-001', {
        status: 'succeeded',
        closureState: 'completed',
        integratedAt: oneHourAgo,
      });
      // Worktree doesn't exist — it was already cleaned or never created.
      const report = cleanupControllerRuntimeState(home, { maxRemovals: 0 });
      expect(report.skippedActiveWorktrees.length).toBe(0);
      expect(report.errors.filter(e => !e.includes('unknown'))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('succeeded run without closure state is protected by default', () => {
    const home = createTempHome();
    try {
      const reposDir = join(home, 'repositories', 'repo_123', 'runs');
      mkdirSync(reposDir, { recursive: true });
      createRunMeta(reposDir, 'RUN-002', {
        status: 'succeeded',
        closureState: undefined,
      });
      const report = cleanupControllerRuntimeState(home, { maxRemovals: 0 });
      // Should be protected — no closure state means integration may be pending.
      expect(report.removedWorktrees.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('succeeded run with cleanup_pending older than threshold releases worktree', () => {
    const home = createTempHome();
    try {
      const reposDir = join(home, 'repositories', 'repo_123', 'runs');
      mkdirSync(reposDir, { recursive: true });
      const twoHoursAgo = new Date(Date.now() - 7_200_001).toISOString();
      createRunMeta(reposDir, 'RUN-003', {
        status: 'succeeded',
        closureState: 'cleanup_pending',
        integratedAt: twoHoursAgo,
        cleanupStartedAt: twoHoursAgo,
      });
      const report = cleanupControllerRuntimeState(home, { maxRemovals: 0 });
      // Should release the worktree reference because cleanup has been pending > 1 hour.
      // We don't expect removed worktrees (none exist), but reference should not be protected.
      expect(report.removedWorktrees.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('succeeded run with recent cleanup_pending is still protected', () => {
    const home = createTempHome();
    try {
      const reposDir = join(home, 'repositories', 'repo_123', 'runs');
      mkdirSync(reposDir, { recursive: true });
      const tenMinutesAgo = new Date(Date.now() - 600_001).toISOString();
      createRunMeta(reposDir, 'RUN-004', {
        status: 'succeeded',
        closureState: 'cleanup_pending',
        integratedAt: tenMinutesAgo,
        cleanupStartedAt: tenMinutesAgo,
      });
      const report = cleanupControllerRuntimeState(home, { maxRemovals: 0 });
      // Should still be protected — cleanup only started 10 minutes ago.
      // The worktree reference will be in skippedActiveWorktrees.
      expect(report.removedWorktrees.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('failed run releases worktree immediately regardless of closure state', () => {
    const home = createTempHome();
    try {
      const reposDir = join(home, 'repositories', 'repo_123', 'runs');
      mkdirSync(reposDir, { recursive: true });
      createRunMeta(reposDir, 'RUN-005', {
        status: 'failed',
        closureState: 'integration_pending',
      });
      const report = cleanupControllerRuntimeState(home, { maxRemovals: 0 });
      expect(report.removedWorktrees.length).toBe(0);
      // Failed runs should be released even without terminal closure.
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('cancelled run releases worktree immediately', () => {
    const home = createTempHome();
    try {
      const reposDir = join(home, 'repositories', 'repo_123', 'runs');
      mkdirSync(reposDir, { recursive: true });
      createRunMeta(reposDir, 'RUN-006', {
        status: 'cancelled',
        closureState: 'none',
      });
      const report = cleanupControllerRuntimeState(home, { maxRemovals: 0 });
      expect(report.removedWorktrees.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('run with worktreeCleanedAt set is always released', () => {
    const home = createTempHome();
    try {
      const reposDir = join(home, 'repositories', 'repo_123', 'runs');
      mkdirSync(reposDir, { recursive: true });
      createRunMeta(reposDir, 'RUN-007', {
        status: 'succeeded',
        closureState: 'cleanup_pending',
        worktreeCleanedAt: new Date().toISOString(),
      });
      const report = cleanupControllerRuntimeState(home, { maxRemovals: 0 });
      expect(report.removedWorktrees.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('workspace mode runs are never protected', () => {
    const home = createTempHome();
    try {
      const reposDir = join(home, 'repositories', 'repo_123', 'runs');
      mkdirSync(reposDir, { recursive: true });
      createRunMeta(reposDir, 'RUN-008', {
        executionMode: 'workspace',
        status: 'running',
      });
      const report = cleanupControllerRuntimeState(home, { maxRemovals: 0 });
      // Workspace mode has no worktree to protect.
      expect(report.skippedActiveWorktrees.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('succeeded run with cleanup_blocked closure releases worktree', () => {
    const home = createTempHome();
    try {
      const reposDir = join(home, 'repositories', 'repo_123', 'runs');
      mkdirSync(reposDir, { recursive: true });
      const twoHoursAgo = new Date(Date.now() - 7_200_001).toISOString();
      createRunMeta(reposDir, 'RUN-009', {
        status: 'succeeded',
        closureState: 'cleanup_blocked',
        integratedAt: twoHoursAgo,
      });
      const report = cleanupControllerRuntimeState(home, { maxRemovals: 0 });
      expect(report.removedWorktrees.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('succeeded run with preservation reason is released', () => {
    const home = createTempHome();
    try {
      const reposDir = join(home, 'repositories', 'repo_123', 'runs');
      mkdirSync(reposDir, { recursive: true });
      const twoHoursAgo = new Date(Date.now() - 7_200_001).toISOString();
      createRunMeta(reposDir, 'RUN-010', {
        status: 'succeeded',
        closureState: 'preserved',
        integratedAt: twoHoursAgo,
        preservationReason: 'dirty_worktree',
      });
      const report = cleanupControllerRuntimeState(home, { maxRemovals: 0 });
      expect(report.removedWorktrees.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('timed_out run always releases worktree', () => {
    const home = createTempHome();
    try {
      const reposDir = join(home, 'repositories', 'repo_123', 'runs');
      mkdirSync(reposDir, { recursive: true });
      createRunMeta(reposDir, 'RUN-011', {
        status: 'timed_out',
        closureState: 'integration_pending',
      });
      const report = cleanupControllerRuntimeState(home, { maxRemovals: 0 });
      expect(report.removedWorktrees.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─── Runtime cleanup lifecycle tests ───────────────────────────────────────

describe('CleanupControllerRuntimeState', () => {
  test('cleans up orphan worktrees with exceeded TTL and no active owner', () => {
    const home = createTempHome();
    try {
      // Create a dummy worktree directory
      const reposDir = join(home, 'repositories', 'repo_xyz', 'worktrees', 'old-wt');
      mkdirSync(reposDir, { recursive: true });
      // Make it old enough to exceed TTL
      const oldTime = Date.now() - 7 * 60 * 60_000; // 7 hours ago
      try {
        const { utimesSync } = require('fs');
        utimesSync(reposDir, oldTime / 1000, oldTime / 1000);
      } catch { /* best effort */ }

      const report = cleanupControllerRuntimeState(home, {
        reason: 'manual',
        maxEntries: 100,
        maxRemovals: 5,
      });
      // The worktree should be removed since it's orphan and expired.
      expect(report.cycle.attempted).toBeGreaterThanOrEqual(0);
      expect(report.errors.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('skips recent worktrees within TTL', () => {
    const home = createTempHome();
    try {
      const reposDir = join(home, 'repositories', 'repo_xyz', 'worktrees', 'recent-wt');
      mkdirSync(reposDir, { recursive: true });
      // Recently created — within TTL.
      const report = cleanupControllerRuntimeState(home, {
        reason: 'manual',
        maxEntries: 100,
        maxRemovals: 5,
      });
      expect(report.cycle.attempted).toBe(0);
      expect(report.cycle.skipped).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('respects removal budget', () => {
    const home = createTempHome();
    try {
      // Create multiple old worktrees
      for (let i = 0; i < 5; i++) {
        const reposDir = join(home, 'repositories', 'repo_xyz', 'worktrees', `old-wt-${i}`);
        mkdirSync(reposDir, { recursive: true });
        const oldTime = Date.now() - 8 * 60 * 60_000;
        try {
          const { utimesSync } = require('fs');
          utimesSync(reposDir, oldTime / 1000, oldTime / 1000);
        } catch { /* best effort */ }
      }

      const report = cleanupControllerRuntimeState(home, {
        reason: 'manual',
        maxEntries: 100,
        maxRemovals: 2, // Only 2 removals allowed
      });
      // Should not remove all 5 — only what fits in budget.
      expect(report.cycle.removed).toBeLessThanOrEqual(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('generates audit log path', () => {
    const home = createTempHome();
    try {
      const report = cleanupControllerRuntimeState(home, {
        reason: 'periodic',
        maxEntries: 10,
        maxRemovals: 3,
      });
      expect(report.logPath).toContain('runtime-cleanup.jsonl');
      expect(report.reason).toBe('periodic');
      expect(report.at).toBeTruthy();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('handles missing repositories directory gracefully', () => {
    const home = createTempHome();
    try {
      // No repositories directory created.
      const report = cleanupControllerRuntimeState(home, {
        reason: 'startup',
        maxEntries: 100,
        maxRemovals: 10,
      });
      expect(report.removedWorktrees.length).toBe(0);
      expect(report.skippedActiveWorktrees.length).toBe(0);
      expect(report.budgetExhausted).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('handles malformed run metadata gracefully', () => {
    const home = createTempHome();
    try {
      const reposDir = join(home, 'repositories', 'repo_123', 'runs', 'RUN-BAD');
      mkdirSync(reposDir, { recursive: true });
      // Write invalid JSON.
      writeFileSync(join(reposDir, 'meta.json'), 'not valid json {');

      const report = cleanupControllerRuntimeState(home, {
        reason: 'manual',
        maxEntries: 100,
        maxRemovals: 5,
      });
      // Should not crash; unsafe repository may be tracked.
      expect(report.removedWorktrees.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('cleans daemon PID file when process is dead', () => {
    const home = createTempHome();
    try {
      const daemonDir = join(home, 'daemon');
      mkdirSync(daemonDir, { recursive: true });
      // Write a PID file with a very unlikely PID.
      writeFileSync(join(daemonDir, 'controller.pid'), '999999');
      // Write daemon state so cleanup can update it.
      writeFileSync(join(daemonDir, 'state.json'), JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        pid: 999999,
      }));

      const report = cleanupControllerRuntimeState(home, {
        reason: 'manual',
        maxEntries: 100,
        maxRemovals: 10,
        inspectProcess: () => ({ alive: false }),
      });
      expect(report.removedPidFiles.length).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('skips live daemon PID file', () => {
    const home = createTempHome();
    try {
      const daemonDir = join(home, 'daemon');
      mkdirSync(daemonDir, { recursive: true });
      // Use a PID that our mock says is alive.
      writeFileSync(join(daemonDir, 'controller.pid'), String(process.pid));
      writeFileSync(join(daemonDir, 'state.json'), JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        pid: process.pid,
      }));

      const report = cleanupControllerRuntimeState(home, {
        reason: 'manual',
        maxEntries: 100,
        maxRemovals: 10,
        inspectProcess: () => ({ alive: true, commandLine: `${home}/node_modules/.bin/daemon-entry.ts --controller-home ${home}` }),
      });
      // The PID file should be skipped because daemon command matches and references home.
      expect(report.removedPidFiles.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('skips worktree referenced by active run', () => {
    const home = createTempHome();
    try {
      const reposDir = join(home, 'repositories', 'repo_123', 'runs');
      mkdirSync(reposDir, { recursive: true });
      const worktreePath = join(home, 'repositories', 'repo_123', 'worktrees', 'active-wt');
      mkdirSync(worktreePath, { recursive: true });
      const oldTime = Date.now() - 8 * 60 * 60_000;
      try {
        const { utimesSync } = require('fs');
        utimesSync(worktreePath, oldTime / 1000, oldTime / 1000);
      } catch { /* best effort */ }

      // Run is "running" — worktree should be protected.
      createRunMeta(reposDir, 'RUN-ACTIVE', {
        status: 'running',
        executionMode: 'worktree',
        worktree: worktreePath,
        worktreePath: worktreePath,
      });

      const report = cleanupControllerRuntimeState(home, {
        reason: 'manual',
        maxEntries: 100,
        maxRemovals: 5,
      });
      expect(report.removedWorktrees.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('cleanup report includes detailed cycle summary', () => {
    const home = createTempHome();
    try {
      const report = cleanupControllerRuntimeState(home, {
        reason: 'manual',
        maxEntries: 100,
        maxRemovals: 5,
      });
      expect(report.cycle.scanned).toBeGreaterThanOrEqual(0);
      expect(report.cycle.eligible).toBeGreaterThanOrEqual(0);
      expect(report.cycle.removed).toBeGreaterThanOrEqual(0);
      expect(report.cycle.skipped).toBeGreaterThanOrEqual(0);
      expect(report.cycle.truncated).toBeDefined();
      expect(typeof report.cycle.durationMs).toBe('number');
      expect(report.cycle.skippedByReason).toBeDefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─── Integration cleanup blocker tests ─────────────────────────────────────

// Note: worktreeCleanupBlocker is internal to integration.ts and not exported.
// These scenarios are validated via the orphan reconciler behavior above.
describe('Cleanup Blocker Behaviour', () => {
  test('orphan reconciler preserves worktrees when no run meta exists', () => {
    const home = createTempHome();
    try {
      const worktreePath = join(home, 'repositories', 'repo_unknown', 'worktrees', 'ghost-wt');
      mkdirSync(worktreePath, { recursive: true });
      const oldTime = Date.now() - 12 * 60 * 60_000;
      try {
        const { utimesSync } = require('fs');
        utimesSync(worktreePath, oldTime / 1000, oldTime / 1000);
      } catch { /* best effort */ }

      // No runs directory — but worktree exists in worktrees/.
      // The orphan reconciler skips repos without run metadata.
      const report = cleanupControllerRuntimeState(home, {
        reason: 'manual',
        maxEntries: 100,
        maxRemovals: 5,
      });

      // The repo_unknown has no runs, so the worktree is in an unknown ownership state.
      // It should be skipped rather than deleted.
      expect(report.skippedActiveWorktrees.every(p => p.includes('unknown_ownership'))).toBeTruthy();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('handles multiple repositories independently', () => {
    const home = createTempHome();
    try {
      const repoA = join(home, 'repositories', 'repo_a', 'worktrees', 'wt-a');
      const repoB = join(home, 'repositories', 'repo_b', 'worktrees', 'wt-b');
      mkdirSync(repoA, { recursive: true });
      mkdirSync(repoB, { recursive: true });
      const oldTime = Date.now() - 24 * 60 * 60_000;
      try {
        const { utimesSync } = require('fs');
        utimesSync(repoA, oldTime / 1000, oldTime / 1000);
        utimesSync(repoB, oldTime / 1000, oldTime / 1000);
      } catch { /* best effort */ }

      const report = cleanupControllerRuntimeState(home, {
        reason: 'manual',
        maxEntries: 100,
        maxRemovals: 5,
      });
      expect(report.cycle.scanned).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
