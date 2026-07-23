import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  replacedManagedPidsForRestart,
  resolveControllerRestartHome,
  waitForControllerRestartState,
} from '../../src/cli/controller/composite-operations';
import type { ControllerRestartState } from '../../src/cli/controller/restart-coordinator';
import { runtimeToolArgumentsForExecutionJob } from '../../src/runtime/execution/jobs/restart-resume';

function restartState(phase: ControllerRestartState['phase']): ControllerRestartState {
  return {
    schemaVersion: 1,
    requestId: 'restart-job-1',
    repoRoot: '/repo',
    controllerHome: '/controller',
    phase,
    requestedAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
    requestedBy: 'test',
    delayMs: 0,
  };
}

describe('controller restart durable resume', () => {
  it('binds controller_restart_verify to the Execution Job request id', () => {
    const args = runtimeToolArgumentsForExecutionJob({
      requestId: 'execution-request-1',
      payload: {
        operation: 'controller_restart_verify',
        arguments: { reason: 'controlled restart' },
      },
    });

    expect(args.request_id).toBe('execution-request-1');
    expect(args.reason).toBe('controlled restart');
  });

  it('preserves an explicit restart request id', () => {
    const args = runtimeToolArgumentsForExecutionJob({
      requestId: 'execution-request-1',
      payload: {
        operation: 'controller_restart_verify',
        arguments: { requestId: 'explicit-restart-1' },
      },
    });

    expect(args.request_id).toBe('explicit-restart-1');
  });

  it('uses the root Controller Home when Stable Supervisor is installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-restart-root-'));
    const slotHome = join(root, 'runtime-slots', 'blue');
    try {
      const resolved = resolveControllerRestartHome('/repo', slotHome, undefined, {
        stableSupervisorInstalled: (candidate) => candidate === root,
      });
      expect(resolved).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps slot-local fallback for an isolated nonregistered lifecycle', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-restart-slot-'));
    try {
      const resolved = resolveControllerRestartHome('/repo', root, 'green', {
        stableSupervisorInstalled: () => false,
      });
      expect(resolved).toBe(join(root, 'runtime-slots', 'green'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the Stable Supervisor PID while requiring Daemon and Gateway replacement', () => {
    const status = {
      supervisor: { pid: 101 },
      daemon: { pid: 202 },
      mcpRuntime: { server: { pid: 303 } },
    } as Parameters<typeof replacedManagedPidsForRestart>[0];

    expect(replacedManagedPidsForRestart(status, true)).toEqual([202, 303]);
    expect(replacedManagedPidsForRestart(status, false)).toEqual([101, 202, 303]);
  });

  it('waits for an existing nonterminal coordinator request instead of resubmitting', async () => {
    const initial = restartState('starting');
    let reads = 0;
    const state = await waitForControllerRestartState(
      '/controller',
      initial,
      { pollIntervalMs: 0 },
      {
        now: () => 0,
        sleep: async () => undefined,
        read: () => {
          reads += 1;
          return { ...initial, phase: 'succeeded', completedAt: '2026-07-23T00:00:01.000Z' };
        },
      },
    );

    expect(reads).toBe(1);
    expect(state.phase).toBe('succeeded');
  });
});
