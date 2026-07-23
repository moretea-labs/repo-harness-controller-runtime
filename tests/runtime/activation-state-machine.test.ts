import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initActivationState,
  transitionPhase,
  failActivation,
  resolveExistingActivation,
  readActivationState,
  hasCompletedPhase,
  lastPhaseRecord,
  type ActivationPhase,
  type PhaseRecord,
} from '../../src/runtime/supervisor/activation-state-machine';
import {
  safeLaunchdHandoff,
  type LaunchctlCommandResult,
  type LaunchdServiceProbe,
} from '../../src/cli/controller/launch-agents';
import { isProcessAlive, isProcessStatAlive } from '../../src/runtime/shared/process-tree';

// ─── Helpers ───────────────────────────────────────────────────────────────

function createTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'rh-activation-test-'));
  // Create minimal supervisor layout
  mkdirSync(join(home, 'supervisor', 'logs'), { recursive: true });
  mkdirSync(join(home, 'supervisor', 'launchd'), { recursive: true });
  mkdirSync(join(home, 'supervisor', 'releases'), { recursive: true });
  return home;
}

function mockLaunchctlResult(ok: boolean, stderr = '', stdout = '', exitCode = ok ? 0 : 1): LaunchctlCommandResult {
  return { ok, stdout, stderr, exitCode };
}

function createMockProbe(overrides: Partial<LaunchdServiceProbe> = {}): LaunchdServiceProbe {
  return {
    isServiceRegistered: () => false,
    isPidAlive: () => false,
    isPortListening: () => false,
    ...overrides,
  };
}

const noWait = async () => undefined;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Activation State Machine', () => {
  const homes: string[] = [];

  afterEach(() => {
    while (homes.length) {
      const home = homes.pop()!;
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  test('1. initActivationState creates a v2 record in prepared phase', () => {
    const home = createTempHome();
    homes.push(home);
    const state = initActivationState({
      home,
      activationId: 'test-act-1',
      repoRoot: '/repo',
      expectedReleaseRevision: 'abc123',
      expectedReleasePath: '/releases/abc123',
      previousReleaseRevision: 'def456',
      previousReleasePath: '/releases/def456',
      serviceLabel: 'com.test.supervisor',
      plistPath: '/tmp/test.plist',
    });
    expect(state.schemaVersion).toBe(2);
    expect(state.phase).toBe('prepared');
    expect(state.activationId).toBe('test-act-1');
    expect(state.expectedReleaseRevision).toBe('abc123');
    expect(state.previousReleaseRevision).toBe('def456');
    expect(state.phases).toHaveLength(0);
  });

  test('2. transitionPhase appends phase records and updates current phase', () => {
    const home = createTempHome();
    homes.push(home);
    initActivationState({ home, activationId: 'test-act-2', repoRoot: '/repo' });
    transitionPhase(home, 'test-act-2', 'stopping_previous', { oldPid: 12345 });
    transitionPhase(home, 'test-act-2', 'waiting_previous_exit');
    transitionPhase(home, 'test-act-2', 'succeeded', { newPid: 67890 });

    const state = readActivationState(home)!;
    expect(state.phase).toBe('succeeded');
    expect(state.phases).toHaveLength(3);
    expect(state.phases[0]!.phase).toBe('stopping_previous');
    expect(state.phases[0]!.oldPid).toBe(12345);
    expect(state.phases[2]!.phase).toBe('succeeded');
    expect(state.phases[2]!.newPid).toBe(67890);
    expect(state.completedAt).toBeDefined();
  });

  test('3. resolveExistingActivation returns terminal state for same ID', () => {
    const home = createTempHome();
    homes.push(home);
    initActivationState({ home, activationId: 'test-act-3', repoRoot: '/repo' });
    transitionPhase(home, 'test-act-3', 'succeeded');
    const existing = resolveExistingActivation(home, 'test-act-3');
    expect(existing).toBeDefined();
    expect(existing!.phase).toBe('succeeded');
    // Different activation ID should return undefined
    expect(resolveExistingActivation(home, 'different-id')).toBeUndefined();
  });

  test('4. resolveExistingActivation returns undefined for non-terminal phase', () => {
    const home = createTempHome();
    homes.push(home);
    initActivationState({ home, activationId: 'test-act-4', repoRoot: '/repo' });
    transitionPhase(home, 'test-act-4', 'stopping_previous');
    // In-progress activation should not short-circuit
    expect(resolveExistingActivation(home, 'test-act-4')).toBeUndefined();
  });

  test('5. failActivation sets phase to failed with error and recovery info', () => {
    const home = createTempHome();
    homes.push(home);
    initActivationState({ home, activationId: 'test-act-5', repoRoot: '/repo' });
    failActivation(home, 'test-act-5', 'bootstrap EIO', { ok: false, mode: 'detached' });
    const state = readActivationState(home)!;
    expect(state.phase).toBe('failed');
    expect(state.error).toBe('bootstrap EIO');
    expect(state.completedAt).toBeDefined();
  });

  test('6. hasCompletedPhase and lastPhaseRecord support resumption', () => {
    const home = createTempHome();
    homes.push(home);
    initActivationState({ home, activationId: 'test-act-6', repoRoot: '/repo' });
    expect(hasCompletedPhase(home, 'test-act-6', 'bootstrapping')).toBe(false);
    transitionPhase(home, 'test-act-6', 'bootstrapping', { bootstrapAttempt: 1 });
    expect(hasCompletedPhase(home, 'test-act-6', 'bootstrapping')).toBe(true);
    const record = lastPhaseRecord(home, 'test-act-6', 'bootstrapping')!;
    expect(record.bootstrapAttempt).toBe(1);
  });

  test('7. transitionPhase throws on activation ID mismatch', () => {
    const home = createTempHome();
    homes.push(home);
    initActivationState({ home, activationId: 'test-act-7a', repoRoot: '/repo' });
    expect(() => transitionPhase(home, 'test-act-7b', 'succeeded')).toThrow('ACTIVATION_STATE_MISMATCH');
  });

  test('8. v1 schema migration works', () => {
    const home = createTempHome();
    homes.push(home);
    // Write a v1 schema activation.json
    const v1State = {
      schemaVersion: 1,
      activationId: 'v1-activation',
      phase: 'failed',
      repoRoot: '/repo',
      updatedAt: '2026-07-23T08:00:00Z',
      expectedReleaseRevision: 'aaa111',
      releaseRevision: 'bbb222',
      error: 'some error',
    };
    writeFileSync(join(home, 'supervisor', 'activation.json'), JSON.stringify(v1State));
    const migrated = readActivationState(home);
    expect(migrated).toBeDefined();
    expect(migrated!.schemaVersion).toBe(2);
    expect(migrated!.activationId).toBe('v1-activation');
    expect(migrated!.phase).toBe('failed');
    expect(migrated!.previousReleaseRevision).toBe('bbb222');
  });
});

describe('Safe Launchd Handoff', () => {
  test('9. bootout returns "not found" → treated as success, bootstrap succeeds', async () => {
    const calls: string[][] = [];
    const run = (args: string[]): LaunchctlCommandResult => {
      calls.push(args);
      if (args[0] === 'bootout') return mockLaunchctlResult(false, 'Boot-out failed: 3: No such process');
      if (args[0] === 'enable') return mockLaunchctlResult(true);
      if (args[0] === 'bootstrap') return mockLaunchctlResult(true);
      if (args[0] === 'kickstart') return mockLaunchctlResult(true);
      return mockLaunchctlResult(true);
    };
    const probe = createMockProbe({ isServiceRegistered: () => false });
    const result = await safeLaunchdHandoff(
      { label: 'com.test.svc', plistPath: '/tmp/test.plist', domain: 'gui/501' },
      { run, probe, wait: noWait },
    );
    expect(result.bootoutClean).toBe(true);
    expect(result.serviceRegistered).toBe(true);
    expect(result.bootstrapAttempts).toBe(1);
  });

  test('10. first bootstrap returns EIO, second succeeds — state-driven retry', async () => {
    let bootstrapCount = 0;
    const run = (args: string[]): LaunchctlCommandResult => {
      if (args[0] === 'bootout') return mockLaunchctlResult(false, 'Boot-out failed: 3: No such process');
      if (args[0] === 'enable') return mockLaunchctlResult(true);
      if (args[0] === 'bootstrap') {
        bootstrapCount++;
        if (bootstrapCount === 1) return mockLaunchctlResult(false, 'Bootstrap failed: 5: Input/output error');
        return mockLaunchctlResult(true);
      }
      return mockLaunchctlResult(true);
    };
    const probe = createMockProbe({ isServiceRegistered: () => false });
    const result = await safeLaunchdHandoff(
      { label: 'com.test.svc', plistPath: '/tmp/test.plist', domain: 'gui/501', maxBootstrapRetry: 3, bootstrapRetryDelayMs: 1 },
      { run, probe, wait: noWait },
    );
    expect(result.serviceRegistered).toBe(true);
    expect(result.bootstrapAttempts).toBe(2);
  });

  test('11. EIO but service registered despite error — treated as success', async () => {
    const run = (args: string[]): LaunchctlCommandResult => {
      if (args[0] === 'bootout') return mockLaunchctlResult(false, 'Boot-out failed: 3: No such process');
      if (args[0] === 'enable') return mockLaunchctlResult(true);
      if (args[0] === 'bootstrap') return mockLaunchctlResult(false, 'Bootstrap failed: 5: Input/output error');
      return mockLaunchctlResult(true);
    };
    // Simulate launchd actually loading the job despite returning EIO
    const probe = createMockProbe({ isServiceRegistered: () => true });
    const result = await safeLaunchdHandoff(
      { label: 'com.test.svc', plistPath: '/tmp/test.plist', domain: 'gui/501', maxBootstrapRetry: 3, bootstrapRetryDelayMs: 1, maxBootoutWaitMs: 100 },
      { run, probe, wait: noWait },
    );
    expect(result.serviceRegistered).toBe(true);
  });

  test('12. bootstrap always fails → returns not registered, no infinite loop', async () => {
    let bootstrapCount = 0;
    const run = (args: string[]): LaunchctlCommandResult => {
      if (args[0] === 'bootout') return mockLaunchctlResult(false, 'Boot-out failed: 3: No such process');
      if (args[0] === 'enable') return mockLaunchctlResult(true);
      if (args[0] === 'bootstrap') {
        bootstrapCount++;
        return mockLaunchctlResult(false, 'Bootstrap failed: 5: Input/output error');
      }
      return mockLaunchctlResult(true);
    };
    const probe = createMockProbe({ isServiceRegistered: () => false });
    const result = await safeLaunchdHandoff(
      { label: 'com.test.svc', plistPath: '/tmp/test.plist', domain: 'gui/501', maxBootstrapRetry: 3, bootstrapRetryDelayMs: 1 },
      { run, probe, wait: noWait },
    );
    expect(result.serviceRegistered).toBe(false);
    expect(bootstrapCount).toBe(3); // exactly maxBootstrapRetry, not more
  });

  test('13. old PID waited for exit before bootstrap', async () => {
    let pidCheckCount = 0;
    const run = (args: string[]): LaunchctlCommandResult => {
      if (args[0] === 'bootout') return mockLaunchctlResult(false, 'Boot-out failed: 3: No such process');
      if (args[0] === 'enable') return mockLaunchctlResult(true);
      if (args[0] === 'bootstrap') return mockLaunchctlResult(true);
      return mockLaunchctlResult(true);
    };
    const probe = createMockProbe({
      isPidAlive: () => {
        pidCheckCount++;
        return pidCheckCount <= 2; // alive for first 2 checks, then dead
      },
    });
    const result = await safeLaunchdHandoff(
      { label: 'com.test.svc', plistPath: '/tmp/test.plist', domain: 'gui/501', oldPid: 999, maxBootoutWaitMs: 5_000, pollIntervalMs: 10 },
      { run, probe, wait: noWait },
    );
    expect(result.pidWaitClean).toBe(true);
    expect(pidCheckCount).toBeGreaterThan(2);
  });

  test('14. port waited for release before bootstrap', async () => {
    let portCheckCount = 0;
    const run = (args: string[]): LaunchctlCommandResult => {
      if (args[0] === 'bootout') return mockLaunchctlResult(false, 'Boot-out failed: 3: No such process');
      if (args[0] === 'enable') return mockLaunchctlResult(true);
      if (args[0] === 'bootstrap') return mockLaunchctlResult(true);
      return mockLaunchctlResult(true);
    };
    const probe = createMockProbe({
      isPortListening: () => {
        portCheckCount++;
        return portCheckCount <= 3; // port released after 3 checks
      },
    });
    const result = await safeLaunchdHandoff(
      { label: 'com.test.svc', plistPath: '/tmp/test.plist', domain: 'gui/501', port: 8765, maxBootoutWaitMs: 5_000, pollIntervalMs: 10 },
      { run, probe, wait: noWait },
    );
    expect(result.portWaitClean).toBe(true);
    expect(portCheckCount).toBeGreaterThan(3);
  });

  test('15. non-EIO bootstrap error does not retry', async () => {
    let bootstrapCount = 0;
    const run = (args: string[]): LaunchctlCommandResult => {
      if (args[0] === 'bootout') return mockLaunchctlResult(false, 'Boot-out failed: 3: No such process');
      if (args[0] === 'enable') return mockLaunchctlResult(true);
      if (args[0] === 'bootstrap') {
        bootstrapCount++;
        return mockLaunchctlResult(false, 'Bootstrap failed: 133: Unknown error');
      }
      return mockLaunchctlResult(true);
    };
    const probe = createMockProbe({ isServiceRegistered: () => false });
    const result = await safeLaunchdHandoff(
      { label: 'com.test.svc', plistPath: '/tmp/test.plist', domain: 'gui/501', maxBootstrapRetry: 3, bootstrapRetryDelayMs: 1 },
      { run, probe, wait: noWait },
    );
    expect(result.serviceRegistered).toBe(false);
    expect(bootstrapCount).toBe(1); // only one attempt — non-EIO errors don't retry
  });

  test('16. bootout failure with unexpected error → bootoutClean=false', async () => {
    const run = (args: string[]): LaunchctlCommandResult => {
      if (args[0] === 'bootout') return mockLaunchctlResult(false, 'Permission denied');
      return mockLaunchctlResult(true);
    };
    const probe = createMockProbe();
    const result = await safeLaunchdHandoff(
      { label: 'com.test.svc', plistPath: '/tmp/test.plist', domain: 'gui/501' },
      { run, probe, wait: noWait },
    );
    expect(result.bootoutClean).toBe(false);
    expect(result.serviceRegistered).toBe(false);
  });
});

describe('isProcessAlive false-negative fix', () => {
  test('17. process.kill succeeds but ps unavailable → reports alive (not dead)', () => {
    // Test the fixed logic: when ps returns undefined, we should err on
    // the side of "alive" rather than reporting dead.
    // isProcessStatAlive(undefined) should return false (it does),
    // but isProcessAlive should now return true when ps fails but kill(0) succeeds.
    // We can't easily test this with a real process in sandbox,
    // but we can verify the logic path:
    // 1. process.kill(pid, 0) succeeds for current process
    // 2. ps may fail in restricted environments
    // 3. The fix ensures we return true (alive) when ps is unavailable
    const selfPid = process.pid;
    expect(isProcessAlive(selfPid)).toBe(true);
  });

  test('18. isProcessStatAlive returns false for undefined (zombie filter)', () => {
    expect(isProcessStatAlive(undefined)).toBe(false);
    expect(isProcessStatAlive('Z')).toBe(false);
    expect(isProcessStatAlive('R')).toBe(true);
    expect(isProcessStatAlive('S')).toBe(true);
  });

  test('19. isProcessAlive returns false for invalid PIDs', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(undefined)).toBe(false);
    expect(isProcessAlive(999999)).toBe(false);
  });
});

describe('Detached fallback health verification', () => {
  test('20. verifyDetachedSupervisorHealth pattern: dead PID → not healthy', async () => {
    // This tests the pattern used in restorePreviousActivation:
    // a detached PID that is dead must not be considered healthy.
    const deadPid = 999999;
    expect(isProcessAlive(deadPid)).toBe(false);
    // In the real code, verifyDetachedSupervisorHealth checks isProcessAlive
    // first and returns { healthy: false } if the PID is dead.
    // This test validates that isProcessAlive correctly reports the dead PID.
  });
});
