import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { evaluateRuntimeHealth, type RuntimeHealthObservations } from '../../src/runtime/health';
import { resolveStableIngressSlot } from '../../src/runtime/supervisor/entry';
import { runtimeWriterEnvironment } from '../../src/runtime/supervisor/process-manager';
import { createSupervisorState, writeSupervisorState } from '../../src/runtime/supervisor/state-store';
import { writeActiveSlotAuthority } from '../../src/cli/controller/runtime-slots';
import { publishWriterAuthority } from '../../src/cli/controller/stable-state/writer-authority';

function healthyObservations(): RuntimeHealthObservations {
  return {
    daemon: { status: 'ready', heartbeatAgeMs: 50 },
    scheduler: { status: 'ready', heartbeatAgeMs: 50, dispatchHeartbeatAgeMs: 50 },
    workers: { queueDepth: 0, runningWorkers: 0, activeLeases: 0, activeAttentionCount: 0 },
    projection: { readable: true, persisted: true, producerHealthy: true },
    localBridge: {
      enabled: false,
      requiredForReadiness: false,
      mode: 'disabled',
      endpointReachable: false,
      expectedSurface: false,
    },
    runtimeStorage: { readable: true, ready: true },
  };
}

describe('restart handoff and runtime health hardening', () => {
  test('fresh degraded scheduler is warning-only while idle, but blocks queued work', () => {
    const idle = healthyObservations();
    idle.scheduler.status = 'degraded';
    const idleEvaluation = evaluateRuntimeHealth(idle);
    expect(idleEvaluation.ready).toBe(true);
    expect(idleEvaluation.state).toBe('warning');
    expect(idleEvaluation.components.scheduler.warnings.map((item) => item.code)).toContain('SCHEDULER_DEGRADED_IDLE');

    const waiting = healthyObservations();
    waiting.scheduler.status = 'degraded';
    waiting.workers.queueDepth = 1;
    const waitingEvaluation = evaluateRuntimeHealth(waiting);
    expect(waitingEvaluation.ready).toBe(false);
    expect(waitingEvaluation.components.scheduler.activeBlockers.map((item) => item.code)).toContain('SCHEDULER_NOT_PROGRESSING');
  });

  test('stable ingress keeps the last verified Supervisor route until explicitly switched', () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-ingress-route-'));
    try {
      writeActiveSlotAuthority(home, { activeSlot: 'blue', generation: 'generation-blue', reason: 'test-authority' });
      const state = createSupervisorState(home, {
        pid: 12345,
        instanceId: 'supervisor-test',
        processStartTime: 'start-test',
        executableFingerprint: 'fingerprint-test',
        controllerHome: home,
        ownerEpoch: 1,
      });
      writeSupervisorState(home, {
        ...state,
        activeSlot: 'blue',
        ingress: {
          ...state.ingress,
          activeUpstreamSlot: 'green',
        },
      });
      expect(resolveStableIngressSlot(home)).toBe('green');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('only the active slot inherits writer credentials from Supervisor', () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-writer-env-'));
    try {
      const authority = publishWriterAuthority(home, {
        activeSlot: 'blue',
        generation: 'generation-blue',
        reason: 'test-writer-env',
      });
      expect(runtimeWriterEnvironment(home, 'green')).toEqual({});
      expect(runtimeWriterEnvironment(home, 'blue')).toEqual({
        REPO_HARNESS_WRITER_SLOT: 'blue',
        REPO_HARNESS_WRITER_EPOCH: authority.epoch,
        REPO_HARNESS_WRITER_FENCING_TOKEN: authority.fencingToken,
        REPO_HARNESS_WRITER_GENERATION: 'generation-blue',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
