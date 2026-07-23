import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ControllerRestartState } from '../../src/cli/controller/restart-coordinator';
import { shouldDeferControllerRestartRetry } from '../../src/runtime/control-plane/repo-actor/actor';
import type { ExecutionJob } from '../../src/runtime/execution/jobs/types';

function job(options: {
  operation?: string;
  requestId?: string;
  explicitRequestId?: string;
} = {}): ExecutionJob {
  return {
    requestId: options.requestId ?? 'execution-request-1',
    payload: {
      operation: options.operation ?? 'controller_restart_verify',
      arguments: options.explicitRequestId ? { request_id: options.explicitRequestId } : {},
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
  it('defers a restart retry for every nonterminal operation phase', () => {
    for (const phase of ['scheduled', 'coordinator_started', 'waiting_for_handoff', 'stopping', 'starting', 'verifying'] as const) {
      expect(shouldDeferControllerRestartRetry('/controller', job(), () => state(phase))).toBe(true);
    }
  });

  it('reads restart state from the root authority when Scheduler runs in a slot home', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-restart-barrier-'));
    const slotHome = join(root, 'runtime-slots', 'blue');
    let observedHome = '';
    try {
      const deferred = shouldDeferControllerRestartRetry(slotHome, job(), (home) => {
        observedHome = home;
        return state('verifying');
      });
      expect(deferred).toBe(true);
      expect(observedHome).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves ordinary retry when operation state is absent or terminal', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-restart-terminal-'));
    try {
      expect(shouldDeferControllerRestartRetry(root, job(), () => undefined)).toBe(false);
      expect(shouldDeferControllerRestartRetry(root, job(), () => state('succeeded'))).toBe(false);
      expect(shouldDeferControllerRestartRetry(root, job(), () => state('failed'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the explicit restart request id when one was supplied', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-restart-request-id-'));
    let observedRequestId = '';
    try {
      const deferred = shouldDeferControllerRestartRetry(
        root,
        job({ explicitRequestId: 'explicit-restart-1' }),
        (_home, requestId) => {
          observedRequestId = requestId;
          return state('verifying');
        },
      );

      expect(deferred).toBe(true);
      expect(observedRequestId).toBe('explicit-restart-1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not defer unrelated operations', () => {
    expect(shouldDeferControllerRestartRetry(
      '/controller',
      job({ operation: 'controller_ready' }),
      () => state('starting'),
    )).toBe(false);
  });
});
