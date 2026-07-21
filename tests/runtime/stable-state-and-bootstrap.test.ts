import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  migrateRepositoryStateOutOfSlots,
  planStableStateMigration,
  resolveRepositoryStatePath,
  ensureStableLayout,
  readStableStateMarker,
} from '../../src/cli/controller/stable-state';
import {
  assertWriterAuthority,
  isPassiveRuntime,
  publishWriterAuthority,
  readWriterAuthority,
  assertActiveWriterForAction,
} from '../../src/cli/controller/stable-state/writer-authority';
import {
  atomicActivateRuntime,
  assertVersionedRuntimePort,
  bootstrapStatus,
  ensureControlSocketReady,
  readActiveRuntimePointer,
  STABLE_PUBLIC_PORTS,
} from '../../src/runtime/bootstrap/stable-bootstrap';
import { markCutoverAuthority, markRollbackAuthority } from '../../src/cli/controller/runtime-slots';
import { evaluateRuntimeReleaseCoherence } from '../../src/runtime/supervisor/release-coherence';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    try {
      rmSync(roots.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function homeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'stable-state-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  mkdirSync(controllerHome, { recursive: true });
  return { root, controllerHome };
}

describe('stable repository state migration', () => {
  test('dry-run plans without mutating', () => {
    const fx = homeFixture();
    const slotRepo = join(fx.controllerHome, 'runtime-slots', 'green', 'repositories', 'repo_test');
    mkdirSync(join(slotRepo, 'processes'), { recursive: true });
    writeFileSync(join(slotRepo, 'processes', 'a.json'), '{}\n');
    mkdirSync(join(slotRepo, 'worktrees', 'wt1'), { recursive: true });
    writeFileSync(join(slotRepo, 'worktrees', 'wt1', '.git'), `gitdir: ${slotRepo}/.git/worktrees/wt1\n`);

    const plan = planStableStateMigration(fx.controllerHome);
    expect(plan.dryRun).toBe(true);
    expect(plan.repositories.some((r) => r.repoId === 'repo_test')).toBe(true);
    expect(existsSync(join(fx.controllerHome, 'repositories', 'repo_test'))).toBe(false);
    // source retained
    expect(existsSync(join(slotRepo, 'processes', 'a.json'))).toBe(true);
  });

  test('migration is idempotent and keeps source until validated', () => {
    const fx = homeFixture();
    const slotRepo = join(fx.controllerHome, 'runtime-slots', 'green', 'repositories', 'repo_test');
    mkdirSync(join(slotRepo, 'processes'), { recursive: true });
    writeFileSync(join(slotRepo, 'processes', 'a.json'), '{"id":1}\n');
    mkdirSync(join(slotRepo, 'worktrees', 'wt1'), { recursive: true });
    writeFileSync(join(slotRepo, 'worktrees', 'wt1', '.git'), `gitdir: ${slotRepo}/worktrees/wt1/git\n`);

    const first = migrateRepositoryStateOutOfSlots({ controllerHome: fx.controllerHome, dryRun: false });
    expect(first.ok).toBe(true);
    expect(existsSync(join(fx.controllerHome, 'repositories', 'repo_test', 'processes', 'a.json'))).toBe(true);
    // source still present
    expect(existsSync(join(slotRepo, 'processes', 'a.json'))).toBe(true);
    const marker = readStableStateMarker(fx.controllerHome);
    expect(marker?.layout).toBe('stable-v1');

    const second = migrateRepositoryStateOutOfSlots({ controllerHome: fx.controllerHome, dryRun: false });
    expect(second.ok).toBe(true);
    const body = readFileSync(join(fx.controllerHome, 'repositories', 'repo_test', 'processes', 'a.json'), 'utf8');
    expect(body).toContain('"id":1');

    const resolved = resolveRepositoryStatePath(fx.controllerHome, 'repo_test');
    expect(resolved.source).toBe('stable');
  });

  test('ensureStableLayout creates bootstrap and slots', () => {
    const fx = homeFixture();
    const layout = ensureStableLayout(fx.controllerHome);
    expect(existsSync(layout.bootstrap)).toBe(true);
    expect(existsSync(join(layout.runtimeSlots, 'blue', 'logs'))).toBe(true);
    expect(existsSync(join(layout.runtimeSlots, 'green', 'pids'))).toBe(true);
  });
});

describe('writer fencing and passive candidate', () => {
  test('publish authority fences previous epoch', () => {
    const fx = homeFixture();
    const first = publishWriterAuthority(fx.controllerHome, { activeSlot: 'green', reason: 'test' });
    expect(assertWriterAuthority(fx.controllerHome, {
      slot: 'green',
      epoch: first.epoch,
      fencingToken: first.fencingToken,
    }).allowed).toBe(true);

    const second = publishWriterAuthority(fx.controllerHome, {
      activeSlot: 'blue',
      reason: 'cutover',
      previousEpoch: first.epoch,
    });
    expect(second.epoch).not.toBe(first.epoch);
    expect(assertWriterAuthority(fx.controllerHome, {
      slot: 'green',
      epoch: first.epoch,
      fencingToken: first.fencingToken,
    }).allowed).toBe(false);
    expect(isPassiveRuntime(fx.controllerHome, 'green')).toBe(true);
    expect(assertActiveWriterForAction(
      fx.controllerHome,
      { slot: 'green', epoch: first.epoch, fencingToken: first.fencingToken },
      'consume_queue',
    ).allowed).toBe(false);
  });

  test('atomicActivateRuntime updates pointer and authority together', () => {
    const fx = homeFixture();
    const { pointer, authority } = atomicActivateRuntime(fx.controllerHome, {
      activeSlot: 'green',
      generation: 'gen-1',
      releaseRevision: 'rev-1',
      reason: 'rollout',
    });
    expect(pointer.activeSlot).toBe('green');
    expect(pointer.writerEpoch).toBe(authority.epoch);
    expect(pointer.fencingToken).toBe(authority.fencingToken);
    const readBack = readActiveRuntimePointer(fx.controllerHome);
    expect(readBack?.generation).toBe('gen-1');
    expect(readWriterAuthority(fx.controllerHome)?.activeSlot).toBe('green');
  });

  test('markCutoverAuthority publishes writer authority', () => {
    const fx = homeFixture();
    markCutoverAuthority(fx.controllerHome, 'blue', 'gen-a');
    const after = markCutoverAuthority(fx.controllerHome, 'green', 'gen-b');
    expect(after.activeSlot).toBe('green');
    const authority = readWriterAuthority(fx.controllerHome);
    expect(authority?.activeSlot).toBe('green');
    expect(authority?.generation).toBe('gen-b');
    markRollbackAuthority(fx.controllerHome, 'gen-a');
    expect(readWriterAuthority(fx.controllerHome)?.activeSlot).toBe('blue');
  });
});

describe('stable bootstrap control socket and ports', () => {
  test('versioned runtime must not bind stable public ports', () => {
    for (const port of STABLE_PUBLIC_PORTS) {
      expect(() => assertVersionedRuntimePort(port, 'gateway')).toThrow(/VERSIONED_RUNTIME_MUST_NOT_BIND_STABLE_PORT/);
    }
    expect(() => assertVersionedRuntimePort(18765, 'gateway')).not.toThrow();
  });

  test('ensureControlSocketReady removes only stale sockets', () => {
    const fx = homeFixture();
    ensureStableLayout(fx.controllerHome);
    const path = join(fx.controllerHome, 'bootstrap', 'control.sock');
    writeFileSync(path, '');
    // Owner missing → stale cleanup allowed
    const self = {
      pid: process.pid,
      instanceId: 'bootstrap-test',
      processStartTime: 'start',
      executableFingerprint: 'fp',
      controllerHome: fx.controllerHome,
      ownerEpoch: 1,
    };
    const probe = {
      isAlive: () => false,
      command: () => undefined,
      startTime: () => undefined,
    };
    const result = ensureControlSocketReady(fx.controllerHome, self, probe);
    expect(result.removedStale).toBe(true);
    expect(result.path).toContain('control.sock');
  });

  test('bootstrapStatus reports layout', () => {
    const fx = homeFixture();
    const status = bootstrapStatus(fx.controllerHome);
    expect(status.layout.bootstrap).toContain('bootstrap');
    expect(status.socketActivation.platform === 'none' || status.socketActivation.activated).toBeTruthy();
  });
});

describe('release coherence transplant', () => {
  test('evaluateRuntimeReleaseCoherence detects path mismatch', () => {
    const releasePath = '/tmp/releases/revision-a';
    const daemon = {
      pid: 1,
      instanceId: 'd',
      processStartTime: 's',
      executableFingerprint: 'f',
      controllerHome: '/tmp',
      ownerEpoch: 1,
      slot: 'green' as const,
      generation: 'generation-a',
      releasePath,
      releaseRevision: 'revision-a',
    };
    const state = {
      schemaVersion: 1 as const,
      supervisor: {
        pid: 500,
        instanceId: 'supervisor-500',
        processStartTime: 'start-500',
        executableFingerprint: 'fingerprint-500',
        controllerHome: '/tmp/controller-home',
        ownerEpoch: 1,
        epoch: 1,
        startedAt: '2026-07-21T00:00:00.000Z',
        releasePath,
        releaseRevision: 'revision-a',
      },
      desiredState: 'running' as const,
      observedState: 'healthy' as const,
      activeSlot: 'green' as const,
      activeGeneration: 'generation-a',
      controllerDaemon: daemon as any,
      gatewayHost: { ...daemon, pid: 2 } as any,
      ingress: { state: 'running' as const, activeUpstreamSlot: 'green' as const },
      restartBudget: {},
      updatedAt: '2026-07-21T00:00:00.000Z',
    };
    const authority = {
      schemaVersion: 1 as const,
      activeSlot: 'green' as const,
      generation: 'generation-a',
      reason: 'test',
      updatedAt: '2026-07-21T00:00:00.000Z',
    };
    const identity = {
      schemaVersion: 1 as const,
      slot: 'green' as const,
      role: 'active' as const,
      controllerHome: '/tmp/controller-home',
      slotHome: '/tmp/controller-home/runtime-slots/green',
      mcpPort: 8795,
      localControllerPort: 8776,
      generation: 'generation-a',
      releasePath: '/tmp/releases/revision-b',
      releaseRevision: 'revision-a',
      startedAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      logDir: '/tmp/logs',
    };
    const mismatched = evaluateRuntimeReleaseCoherence({
      supervisorState: state as any,
      authority: authority as any,
      slotIdentity: identity as any,
    });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.releasePathCoherent).toBe(false);
  });
});
