import { describe, expect, it } from 'bun:test';
import type { ControllerRestartState } from '../../src/cli/controller/restart-coordinator';
import { shouldDeferControllerRestartRetry } from '../../src/runtime/control-plane/repo-actor/actor';
import type { ExecutionJob } from '../../src/runtime/execution/jobs/types';

function job(options: {
  operation?: string;
  requestId?: string;
  explicitRequestId?: string;
  ownerPid?: number;
  ownerStartedAt?: string;
} = {}): ExecutionJob {
  return {
    requestId: options.requestId ?? 'execution-request-1',
    payload: {
      operation: options.operation ?? 'controller_restart_verify',
      arguments: options.explicitRequestId ? { request_id: options.explicitRequestId } : {},
    },
    workerLifecycle: {
      executable: '/worker',
      args: [],
      cwd: '/repo',
      environment: {},
      ownerPid: options.ownerPid ?? 42,
      ownerStartedAt: options.ownerStartedAt ?? 'controller-start-a',
      attempt: 1,
      maxAttempts: 2,
      spawnedAt: '2026-07-23T00:00:00.000Z',
      startupState: 'exited',
    },
  } as unknown as ExecutionJob;
}

function state(phase: ControllerRestartState['phase']): ControllerRestartState {
  return {
    schemaVersion: 1,
    requestId: 'restart-request-1',
    repoRoot: '/repo',
    controllerHome: '/controller',
    phase,
    requestedAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
    requestedBy: 'test',
    delayMs: 0,
  };
}

describe('controller restart retry dispatch barrier', () => {
  it('defers a nonterminal restart retry on the same Controller process identity', () => {
    expect(shouldDeferControllerRestartRetry(
      '/controller',
      job(),
      42,
      'controller-start-a',
      () => state('starting'),
    )).toBe(true);
  });

  it('allows the new Controller process to claim the durable retry', () => {
    expect(shouldDeferControllerRestartRetry(
      '/controller',
      job(),
      43,
      'controller-start-b',
      () => state('starting'),
    )).toBe(false);
  });

  it('does not confuse PID reuse with the same Controller process', () => {
    expect(shouldDeferControllerRestartRetry(
      '/controller',
      job(),
      42,
      'controller-start-b',
      () => state('starting'),
    )).toBe(false);
  });

  it('preserves ordinary retry when coordinator state is absent or terminal', () => {
    expect(shouldDeferControllerRestartRetry('/controller', job(), 42, 'controller-start-a', () => undefined)).toBe(false);
    expect(shouldDeferControllerRestartRetry('/controller', job(), 42, 'controller-start-a', () => state('succeeded'))).toBe(false);
    expect(shouldDeferControllerRestartRetry('/controller', job(), 42, 'controller-start-a', () => state('failed'))).toBe(false);
  });

  it('uses the explicit restart request id when one was supplied', () => {
    let observedRequestId = '';
    const deferred = shouldDeferControllerRestartRetry(
      '/controller',
      job({ explicitRequestId: 'explicit-restart-1' }),
      42,
      'controller-start-a',
      (_home, requestId) => {
        observedRequestId = requestId;
        return state('verifying');
      },
    );

    expect(deferred).toBe(true);
    expect(observedRequestId).toBe('explicit-restart-1');
  });

  it('does not defer unrelated operations', () => {
    expect(shouldDeferControllerRestartRetry(
      '/controller',
      job({ operation: 'controller_ready' }),
      42,
      'controller-start-a',
      () => state('starting'),
    )).toBe(false);
  });
});
