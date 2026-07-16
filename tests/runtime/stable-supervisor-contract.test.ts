import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createSupervisorOperation, findSupervisorOperationByRequestId, readSupervisorOperation, updateSupervisorOperation } from '../../src/runtime/supervisor/operation-store';
import { acquireSupervisorLock } from '../../src/runtime/supervisor/lock';
import { captureProcessIdentity, defaultProcessIdentityProbe, executableFingerprint, processIdentityMatches, type ProcessIdentityProbe } from '../../src/runtime/supervisor/identity';
import { DEFAULT_RESTART_POLICY, decideRestart, lockout, newRestartBudgetRecord, recordFailure, recordRestart, recordStable } from '../../src/runtime/supervisor/restart-policy';
import { createSupervisorState, readSupervisorState, supervisorEpoch, writeSupervisorState } from '../../src/runtime/supervisor/state-store';
import { supervisorLockPath, supervisorOperationLockPath, supervisorOperationPath, supervisorStatePath, ensureStableSupervisorLayout } from '../../src/runtime/supervisor/paths';
import type { ProcessIdentity } from '../../src/runtime/supervisor/types';

function temporary(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fakeProbe(input: { alive?: boolean; command?: string; startTime?: string } = {}): ProcessIdentityProbe {
  return {
    isAlive: () => input.alive ?? true,
    command: () => input.command ?? '/usr/bin/bun supervisor --controller-home /tmp/home --owner-epoch 7',
    startTime: () => input.startTime ?? 'Thu Jul 16 12:00:00 2026',
  };
}

describe('stable external supervisor contract', () => {
  test('writes supervisor state atomically and projects existing slot/generation authority', () => {
    const home = temporary('repo-harness-supervisor-state-');
    const identity: ProcessIdentity = {
      pid: 100,
      instanceId: 'sup-test',
      processStartTime: 'start',
      executableFingerprint: 'fingerprint',
      controllerHome: home,
      ownerEpoch: 7,
    };
    const state = createSupervisorState(home, identity, { releaseRevision: 'rev-a' });
    writeSupervisorState(home, state);

    expect(existsSync(supervisorStatePath(home))).toBe(true);
    expect(readSupervisorState(home)?.supervisor.instanceId).toBe('sup-test');
    expect(supervisorEpoch(home)).toBe(7);
    expect(readSupervisorState(home)?.activeSlot).toBe('blue');
  });

  test('persists accepted operation before any later phase and deduplicates request id', () => {
    const home = temporary('repo-harness-supervisor-operation-');
    const first = createSupervisorOperation({
      controllerHome: home,
      requestId: 'request-1',
      kind: 'restart_full',
      requestedBy: 'chatgpt',
      actor: 'Repo Harness',
      reason: 'test restart',
    });
    expect(first.deduplicated).toBe(false);
    expect(first.operation.phase).toBe('accepted');
    expect(existsSync(supervisorOperationPath(home, first.operation.operationId))).toBe(true);

    const second = createSupervisorOperation({ controllerHome: home, requestId: 'request-1', kind: 'rollback' });
    expect(second.deduplicated).toBe(true);
    expect(second.operation.operationId).toBe(first.operation.operationId);

    const verifying = updateSupervisorOperation(home, first.operation.operationId, {
      phase: 'verifying',
      result: { operationId: first.operation.operationId, bounded: true },
    });
    expect(readSupervisorOperation(home, first.operation.operationId)?.phase).toBe('verifying');
    expect(findSupervisorOperationByRequestId(home, 'request-1')?.operationId).toBe(first.operation.operationId);
    expect(verifying.updatedAt).toBeTruthy();
  });

  test('does not delete an active operation schedule lock when a second writer is rejected', () => {
    const home = temporary('repo-harness-supervisor-operation-lock-');
    ensureStableSupervisorLayout(home);
    const pid = process.pid;
    writeFileSync(supervisorOperationLockPath(home), `${JSON.stringify({
      pid,
      instanceId: 'active-operation-lock',
      processStartTime: defaultProcessIdentityProbe.startTime(pid),
      executableFingerprint: executableFingerprint(defaultProcessIdentityProbe.command(pid) ?? process.argv.join(' ')),
      controllerHome: home,
      ownerEpoch: 0,
      acquiredAt: new Date().toISOString(),
    })}\n`);

    expect(() => createSupervisorOperation({ controllerHome: home, requestId: 'busy-request', kind: 'restart_full' }))
      .toThrow('SUPERVISOR_OPERATION_LOCK_BUSY');
    expect(existsSync(supervisorOperationLockPath(home))).toBe(true);
  });

  test('fences stale locks and refuses a live matching owner', () => {
    const home = temporary('repo-harness-supervisor-lock-');
    const probe = fakeProbe();
    const lock = acquireSupervisorLock(home, null, probe);
    expect(() => acquireSupervisorLock(home, null, probe)).toThrow('SUPERVISOR_ALREADY_RUNNING');
    lock.release();

    ensureStableSupervisorLayout(home);
    writeFileSync(supervisorLockPath(home), `${JSON.stringify({
      pid: 42,
      instanceId: 'old-instance',
      processStartTime: 'old-start',
      executableFingerprint: executableFingerprint('/old/process'),
      controllerHome: home,
      ownerEpoch: 1,
      acquiredAt: new Date().toISOString(),
    })}\n`);
    const recovered = acquireSupervisorLock(home, null, fakeProbe({ command: '/new/process', startTime: 'new-start' }));
    expect(recovered.metadata.ownerEpoch).toBeGreaterThan(0);
    recovered.release();
  });

  test('does not treat a reused PID as the original process', () => {
    const expected = captureProcessIdentity(42, { controllerHome: '/tmp/home', ownerEpoch: 1 }, fakeProbe({ command: '/old/process', startTime: 'old-start' }));
    expect(expected).toBeTruthy();
    const result = processIdentityMatches(expected, 42, fakeProbe({ command: '/new/process', startTime: 'new-start' }));
    expect(result.matches).toBe(false);
    expect(result.reason).toBe('process_start_time_changed');
  });

  test('enforces bounded restart budget, backoff, stable reset, and lockout', () => {
    const base = new Date('2026-07-16T12:00:00.000Z');
    let record = newRestartBudgetRecord('gatewayHost', 'runtime-a', base);
    expect(decideRestart(record, base).allowed).toBe(true);
    record = recordRestart(record, base);
    record = recordFailure(record, 'gateway crashed', new Date(base.getTime() + 100));
    expect(decideRestart(record, new Date(base.getTime() + 200)).reason).toBe('backoff');
    record = lockout(record, 'restart budget exhausted', new Date(base.getTime() + 300));
    expect(decideRestart(record, new Date(base.getTime() + 10_000)).reason).toBe('restart_budget_exhausted');

    const stable = recordStable({ ...record, lockedOut: false, stableSinceAt: new Date(base.getTime() - 16 * 60_000).toISOString() }, new Date(base.getTime()), DEFAULT_RESTART_POLICY);
    expect(stable.attempts).toBe(0);
    expect(stable.consecutiveFailures).toBe(0);
  });
});
