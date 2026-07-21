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

  test('active and passive slots inherit complete claims, while passive remains fenced by slot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-writer-env-'));
    try {
      const authority = publishWriterAuthority(home, {
        activeSlot: 'blue',
        generation: 'generation-blue',
        reason: 'test-writer-env',
      });
      expect(runtimeWriterEnvironment(home, 'green')).toEqual({
        REPO_HARNESS_WRITER_SLOT: 'green',
        REPO_HARNESS_WRITER_EPOCH: authority.epoch,
        REPO_HARNESS_WRITER_FENCING_TOKEN: authority.fencingToken,
        REPO_HARNESS_WRITER_GENERATION: 'generation-blue',
      });
      expect(runtimeWriterEnvironment(home, 'blue')).toEqual({
        REPO_HARNESS_WRITER_SLOT: 'blue',
        REPO_HARNESS_WRITER_EPOCH: authority.epoch,
        REPO_HARNESS_WRITER_FENCING_TOKEN: authority.fencingToken,
        REPO_HARNESS_WRITER_GENERATION: 'generation-blue',
      });
      const { assertWriterAuthority } = await import('../../src/cli/controller/stable-state/writer-authority');
      expect(assertWriterAuthority(home, {
        slot: 'green',
        epoch: authority.epoch,
        fencingToken: authority.fencingToken,
      }).allowed).toBe(false);
      expect(assertWriterAuthority(home, {
        slot: 'blue',
        epoch: authority.epoch,
        fencingToken: authority.fencingToken,
      }).allowed).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});


describe('Gateway writer claim inheritance and child environment isolation', () => {
  test('supervised Gateway binds only a complete inherited claim', async () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-gateway-writer-'));
    try {
      const { bindInheritedRuntimeWriterClaimFromEnvironment, clearRuntimeWriterClaimForTests, assertThisRuntimeMayWrite } = await import('../../src/cli/controller/stable-state/runtime-writer-context');
      const authority = publishWriterAuthority(home, {
        activeSlot: 'green',
        generation: 'generation-green',
        reason: 'gateway-bind-test',
      });
      clearRuntimeWriterClaimForTests();
      bindInheritedRuntimeWriterClaimFromEnvironment({
        REPO_HARNESS_SUPERVISOR_CHILD: '1',
        REPO_HARNESS_CONTROLLER_HOME: join(home, 'runtime-slots', 'green'),
        REPO_HARNESS_RUNTIME_SLOT: 'green',
        REPO_HARNESS_WRITER_SLOT: 'green',
        REPO_HARNESS_WRITER_EPOCH: authority.epoch,
        REPO_HARNESS_WRITER_FENCING_TOKEN: authority.fencingToken,
        REPO_HARNESS_WRITER_GENERATION: authority.generation,
      });
      expect(assertThisRuntimeMayWrite('renew_lease', home).allowed).toBe(true);
      clearRuntimeWriterClaimForTests();
      expect(() => bindInheritedRuntimeWriterClaimFromEnvironment({
        REPO_HARNESS_SUPERVISOR_CHILD: '1',
        REPO_HARNESS_CONTROLLER_HOME: join(home, 'runtime-slots', 'green'),
        REPO_HARNESS_RUNTIME_SLOT: 'green',
      })).toThrow('stable authority present but process did not inherit full writer claim');
    } finally {
      const { clearRuntimeWriterClaimForTests } = await import('../../src/cli/controller/stable-state/runtime-writer-context');
      clearRuntimeWriterClaimForTests();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('Process Runner environment strips active-writer credentials', async () => {
    const { processRunnerEnvironment } = await import('../../src/runtime/execution/process-runtime/runtime');
    const result = processRunnerEnvironment({
      PATH: '/bin',
      REPO_HARNESS_WRITER_SLOT: 'blue',
      REPO_HARNESS_WRITER_EPOCH: 'epoch-secret',
      REPO_HARNESS_WRITER_FENCING_TOKEN: 'token-secret',
      REPO_HARNESS_WRITER_GENERATION: 'generation-secret',
      REPO_HARNESS_SUPERVISOR_CHILD: '1',
      REPO_HARNESS_SUPERVISOR_EPOCH: '123',
      REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER: '1',
      REPO_HARNESS_DAEMON_INSTANCE_ID: 'daemon-secret',
    });
    expect(result.PATH).toBe('/bin');
    expect(result.REPO_HARNESS_WRITER_EPOCH).toBeUndefined();
    expect(result.REPO_HARNESS_WRITER_FENCING_TOKEN).toBeUndefined();
    expect(result.REPO_HARNESS_SUPERVISOR_CHILD).toBeUndefined();
  });
});
