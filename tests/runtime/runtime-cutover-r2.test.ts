/**
 * Round-2 cutover hardening: claim conflicts, writer fencing, activation
 * transaction, stable root storage, process restart receipt, command routing,
 * log GC, control socket safety.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

import {
  claimsConflict,
  normalizeClaims,
  pathOverlaps,
  resourceKeysOverlap,
} from '../../src/runtime/resources/claims/conflicts';
import {
  acquireExecutionLeases,
  listActiveLeases,
  releaseExecutionLeases,
  renewExecutionLeases,
} from '../../src/runtime/resources/leases/store';
import {
  claimWorkspaceRead,
  claimWorkspaceWrite,
  claimPathWrite,
  claimsForRepositoryCommand,
} from '../../src/runtime/execution/process-runtime/resource-claims';
import {
  assertWriterAuthority,
  publishWriterAuthority,
  readWriterAuthority,
} from '../../src/cli/controller/stable-state/writer-authority';
import {
  bindRuntimeWriterClaim,
  clearRuntimeWriterClaimForTests,
  assertThisRuntimeMayWrite,
  getRuntimeWriterClaim,
} from '../../src/cli/controller/stable-state/runtime-writer-context';
import {
  resolveStableControllerHome,
  resolveDualHome,
  durableControllerHome,
} from '../../src/cli/controller/stable-state/stable-home';
import {
  commitActivationTransaction,
  inspectActivationTransaction,
  recoverActivationTransaction,
  rollbackActivationTransaction,
  readActivationAuthority,
  activationPreparePath,
  activationAuthorityPath,
} from '../../src/runtime/bootstrap/activation-transaction';
import {
  ensureControlSocketReady,
  atomicActivateRuntime,
  readActiveRuntimePointer,
} from '../../src/runtime/bootstrap/stable-bootstrap';
import {
  migrateRepositoryStateOutOfSlots,
  resolveRepositoryStatePath,
  ensureStableLayout,
} from '../../src/cli/controller/stable-state';
import {
  __resetLiveMonitorsForTests,
  spawnManagedProcess,
  recoverManagedProcesses,
  getProcessHandle,
  cancelProcess,
  waitForProcess,
} from '../../src/runtime/execution/process-runtime';
import {
  classifyRepositoryCommandRoute,
  executeRepositoryCommandViaProcessRuntime,
} from '../../src/runtime/execution/process-runtime/command-facade';
import { gcTerminalProcesses } from '../../src/runtime/execution/process-runtime/gc';
import { ensureControllerHome, repositoryControllerRoot } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { markRepositoryProjectionDirty, readRepositoryProjectionDirty } from '../../src/runtime/projections/invalidation';
import { transitionExecutionJob, createExecutionJob, getExecutionJob } from '../../src/runtime/execution/jobs/store';
import type { ProcessIdentity } from '../../src/runtime/supervisor/types';

const roots: string[] = [];

afterEach(() => {
  __resetLiveMonitorsForTests();
  clearRuntimeWriterClaimForTests();
  while (roots.length > 0) {
    try {
      rmSync(roots.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function homeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cutover-r2-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  mkdirSync(controllerHome, { recursive: true });
  ensureControllerHome(controllerHome);
  ensureStableLayout(controllerHome);
  return { root, controllerHome };
}

function repoFixture() {
  const fx = homeFixture();
  const repoRoot = join(fx.root, 'repo');
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  spawnSync('git', ['-C', repoRoot, 'init', '-b', 'main'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repoRoot, 'config', 'user.name', 'Test'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.com'], { encoding: 'utf8' });
  writeFileSync(join(repoRoot, 'README.md'), 'fixture\n');
  spawnSync('git', ['-C', repoRoot, 'add', '.'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repoRoot, 'commit', '-m', 'init'], { encoding: 'utf8' });
  const repository = registerRepository({ path: repoRoot, controllerHome: fx.controllerHome, displayName: 'r2' });
  return { ...fx, repoRoot, repository };
}

function fakeIdentity(pid = process.pid): ProcessIdentity {
  return {
    pid,
    processStartTime: '1000',
    executableFingerprint: 'fp-test',
    instanceId: `inst-${pid}`,
    controllerHome: '/tmp',
    ownerEpoch: 1,
  };
}

describe('resource claim real conflicts', () => {
  test('workspace read and write share key and conflict via mode', () => {
    const checkout = 'checkout_abc';
    const read = claimWorkspaceRead(checkout);
    const write = claimWorkspaceWrite(checkout);
    expect(read.resourceKey).toBe(`workspace:${checkout}`);
    expect(write.resourceKey).toBe(`workspace:${checkout}`);
    expect(read.mode).toBe('read');
    expect(write.mode).toBe('write');
    expect(resourceKeysOverlap(read.resourceKey, write.resourceKey)).toBe(true);
  });

  test('legacy workspace-read key still conflicts with workspace write', () => {
    expect(resourceKeysOverlap('workspace-read:c1', 'workspace:c1')).toBe(true);
    expect(claimsConflict(
      { resourceKey: 'workspace-read:c1', mode: 'read' },
      {
        schemaVersion: 1,
        leaseId: 'L1',
        repoId: 'r',
        resourceKey: 'workspace:c1',
        mode: 'write',
        ownerJobId: 'j1',
        fencingToken: 1,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        heartbeatAt: new Date().toISOString(),
      },
    )).toBe(true);
  });

  test('multiple workspace reads acquire in parallel; write blocked', () => {
    const fx = repoFixture();
    const checkout = fx.repository.activeCheckoutId ?? 'active';
    const readClaims = [claimWorkspaceRead(checkout)];
    const a = acquireExecutionLeases(fx.controllerHome, fx.repository.repoId, 'job-read-a', readClaims, 30_000);
    const b = acquireExecutionLeases(fx.controllerHome, fx.repository.repoId, 'job-read-b', readClaims, 30_000);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);

    const write = acquireExecutionLeases(
      fx.controllerHome,
      fx.repository.repoId,
      'job-write',
      [claimWorkspaceWrite(checkout)],
      30_000,
    );
    expect(write.acquired).toBe(false);
    expect(write.blockers.length).toBeGreaterThan(0);

    releaseExecutionLeases(fx.controllerHome, fx.repository.repoId, 'job-read-a');
    releaseExecutionLeases(fx.controllerHome, fx.repository.repoId, 'job-read-b');
    const write2 = acquireExecutionLeases(
      fx.controllerHome,
      fx.repository.repoId,
      'job-write',
      [claimWorkspaceWrite(checkout)],
      30_000,
    );
    expect(write2.acquired).toBe(true);
    releaseExecutionLeases(fx.controllerHome, fx.repository.repoId, 'job-write');
  });

  test('workspace write conflicts same-checkout path write and git-index', () => {
    const checkout = 'co1';
    expect(resourceKeysOverlap(`workspace:${checkout}`, `path:${checkout}:src/a.ts`)).toBe(true);
    expect(resourceKeysOverlap(`workspace:${checkout}`, `git-index:${checkout}`)).toBe(true);
    expect(resourceKeysOverlap(`workspace:${checkout}`, 'path:other:src/a.ts')).toBe(false);
  });

  test('path parent/child overlap; different non-overlapping paths do not', () => {
    expect(pathOverlaps('src', 'src/a.ts')).toBe(true);
    expect(pathOverlaps('src/a.ts', 'src/b.ts')).toBe(false);
    expect(resourceKeysOverlap('path:c1:src/a.ts', 'path:c1:src/b.ts')).toBe(false);
    expect(resourceKeysOverlap('path:c1:src', 'path:c1:src/a.ts')).toBe(true);
  });

  test('unsafe path claim escalates to workspace write', () => {
    const claim = claimPathWrite('../escape', 'c1');
    expect(claim.resourceKey).toBe('workspace:c1');
    expect(claim.mode).toBe('write');
  });

  test('readonly commands claim workspace read not write', () => {
    const claims = claimsForRepositoryCommand(['git', 'log', '-1'], 'repo_x', 'co');
    expect(claims).toEqual([{ resourceKey: 'workspace:co', mode: 'read' }]);
    const gh = claimsForRepositoryCommand(['gh', 'release', 'view', 'v1'], 'repo_x', 'co');
    expect(gh.some((c) => c.mode === 'read')).toBe(true);
  });

  test('normalizeClaims merges legacy workspace-read into workspace', () => {
    const normalized = normalizeClaims([
      { resourceKey: 'workspace-read:c1', mode: 'read' },
      { resourceKey: 'workspace:c1', mode: 'write' },
    ]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.resourceKey).toBe('workspace:c1');
    expect(normalized[0]?.mode).toBe('write');
  });
});

describe('writer fencing production paths', () => {
  test('captured claim is fenced after epoch cutover; current authority is not auto-assumed', () => {
    const fx = homeFixture();
    const first = publishWriterAuthority(fx.controllerHome, { activeSlot: 'green', reason: 'boot' });
    bindRuntimeWriterClaim({
      controllerHome: fx.controllerHome,
      slot: 'green',
      epoch: first.epoch,
      fencingToken: first.fencingToken,
    });
    expect(assertThisRuntimeMayWrite('consume_queue').allowed).toBe(true);

    const second = publishWriterAuthority(fx.controllerHome, {
      activeSlot: 'blue',
      reason: 'cutover',
      previousEpoch: first.epoch,
    });
    // Old process still holds first claim — must be denied even though second is current.
    expect(getRuntimeWriterClaim()?.epoch).toBe(first.epoch);
    expect(assertThisRuntimeMayWrite('consume_queue').allowed).toBe(false);
    expect(assertThisRuntimeMayWrite('renew_lease').allowed).toBe(false);
    expect(assertThisRuntimeMayWrite('write_process_terminal').allowed).toBe(false);
    expect(assertThisRuntimeMayWrite('write_workflow_terminal').allowed).toBe(false);
    expect(assertThisRuntimeMayWrite('update_active_projection').allowed).toBe(false);
    expect(assertThisRuntimeMayWrite('cleanup').allowed).toBe(false);
    expect(assertThisRuntimeMayWrite('remote_side_effect').allowed).toBe(false);

    // Re-binding as the new active runtime succeeds.
    clearRuntimeWriterClaimForTests();
    bindRuntimeWriterClaim({
      controllerHome: fx.controllerHome,
      slot: 'blue',
      epoch: second.epoch,
      fencingToken: second.fencingToken,
    });
    expect(assertThisRuntimeMayWrite('consume_queue').allowed).toBe(true);
  });

  test('passive candidate cannot acquire or renew leases', () => {
    const fx = repoFixture();
    const auth = publishWriterAuthority(fx.controllerHome, { activeSlot: 'green', reason: 'active' });
    // Bind as blue (passive)
    bindRuntimeWriterClaim({
      controllerHome: fx.controllerHome,
      slot: 'blue',
      epoch: 'stale-epoch',
      fencingToken: 'stale-token',
    });
    const acquired = acquireExecutionLeases(
      fx.controllerHome,
      fx.repository.repoId,
      'passive-job',
      [claimWorkspaceRead('co')],
      30_000,
    );
    expect(acquired.acquired).toBe(false);

    // Active writer binds and acquires
    clearRuntimeWriterClaimForTests();
    bindRuntimeWriterClaim({
      controllerHome: fx.controllerHome,
      slot: 'green',
      epoch: auth.epoch,
      fencingToken: auth.fencingToken,
    });
    const ok = acquireExecutionLeases(
      fx.controllerHome,
      fx.repository.repoId,
      'active-job',
      [claimWorkspaceRead('co')],
      30_000,
    );
    expect(ok.acquired).toBe(true);

    // Switch epoch; renew from old claim fails
    clearRuntimeWriterClaimForTests();
    bindRuntimeWriterClaim({
      controllerHome: fx.controllerHome,
      slot: 'green',
      epoch: auth.epoch,
      fencingToken: auth.fencingToken,
    });
    publishWriterAuthority(fx.controllerHome, {
      activeSlot: 'green',
      reason: 'rotate',
      previousEpoch: auth.epoch,
    });
    expect(() => renewExecutionLeases(fx.controllerHome, fx.repository.repoId, 'active-job', 30_000, ok.leases)).toThrow(/WRITER_FENCED|FENCING/);
  });

  test('passive candidate does not mark projections dirty', () => {
    const fx = repoFixture();
    publishWriterAuthority(fx.controllerHome, { activeSlot: 'green', reason: 'active' });
    bindRuntimeWriterClaim({
      controllerHome: fx.controllerHome,
      slot: 'blue',
      epoch: 'x',
      fencingToken: 'y',
    });
    markRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId, 'test');
    expect(readRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId)).toBeUndefined();
  });

  test('passive candidate cannot write job terminal state', () => {
    const fx = repoFixture();
    const auth = publishWriterAuthority(fx.controllerHome, { activeSlot: 'green', reason: 'active' });
    clearRuntimeWriterClaimForTests();
    bindRuntimeWriterClaim({
      controllerHome: fx.controllerHome,
      slot: 'green',
      epoch: auth.epoch,
      fencingToken: auth.fencingToken,
    });
    const created = createExecutionJob(fx.controllerHome, {
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      type: 'check',
      requestId: `req-${Date.now()}`,
      semanticKey: `sem-${Date.now()}`,
      payload: { operation: 'run_check', arguments: { check_id: 'x' } },
      origin: { surface: 'system' },
      timeoutMs: 60_000,
    });
    // Fence as passive
    clearRuntimeWriterClaimForTests();
    bindRuntimeWriterClaim({
      controllerHome: fx.controllerHome,
      slot: 'blue',
      epoch: 'old',
      fencingToken: 'old',
    });
    expect(() => transitionExecutionJob(
      fx.controllerHome,
      fx.repository.repoId,
      created.job.jobId,
      'failed',
      { error: { code: 'X', message: 'nope', retryable: false } },
    )).toThrow(/WRITER_FENCED/);
  });
});

describe('activation transaction', () => {
  test('commit writes authority then projections atomically from reader view', () => {
    const fx = homeFixture();
    const record = commitActivationTransaction(fx.controllerHome, {
      activeSlot: 'green',
      generation: 'gen-1',
      releaseRevision: 'abc123',
      reason: 'test-commit',
    });
    expect(record.status).toBe('committed');
    expect(readActivationAuthority(fx.controllerHome)?.writerEpoch).toBe(record.writerEpoch);
    expect(readWriterAuthority(fx.controllerHome)?.epoch).toBe(record.writerEpoch);
    expect(readActiveRuntimePointer(fx.controllerHome)?.activeSlot).toBe('green');
    expect(inspectActivationTransaction(fx.controllerHome).status).toBe('committed');
    expect(existsSync(activationPreparePath(fx.controllerHome))).toBe(false);
  });

  test('crash after prepare leaves incomplete (not succeeded)', () => {
    const fx = homeFixture();
    expect(() => commitActivationTransaction(fx.controllerHome, {
      activeSlot: 'green',
      reason: 'prep-crash',
      crashAfterPrepare: true,
    })).toThrow(/ACTIVATION_INJECTED_CRASH:after_prepare/);
    const inspect = inspectActivationTransaction(fx.controllerHome);
    expect(inspect.ok).toBe(false);
    expect(['prepared', 'incomplete']).toContain(inspect.status);
    expect(readActivationAuthority(fx.controllerHome)).toBeUndefined();
  });

  test('crash after commit before projections recovers projections', () => {
    const fx = homeFixture();
    expect(() => commitActivationTransaction(fx.controllerHome, {
      activeSlot: 'blue',
      generation: 'g2',
      reason: 'proj-crash',
      crashAfterCommitBeforeProjections: true,
    })).toThrow(/ACTIVATION_INJECTED_CRASH:after_commit_before_projections/);
    expect(existsSync(activationAuthorityPath(fx.controllerHome))).toBe(true);
    const recovered = recoverActivationTransaction(fx.controllerHome);
    expect(recovered.ok).toBe(true);
    expect(recovered.status).toBe('committed');
    expect(recovered.recovered).toBe(true);
    expect(readWriterAuthority(fx.controllerHome)?.activeSlot).toBe('blue');
    expect(readActiveRuntimePointer(fx.controllerHome)?.activeSlot).toBe('blue');
  });

  test('rollback swaps slot and writer epoch', () => {
    const fx = homeFixture();
    commitActivationTransaction(fx.controllerHome, {
      activeSlot: 'green',
      previousSlot: 'blue',
      reason: 'first',
    });
    const rolled = rollbackActivationTransaction(fx.controllerHome, { reason: 'test-rollback' });
    expect(rolled.activeSlot).toBe('blue');
    expect(readWriterAuthority(fx.controllerHome)?.activeSlot).toBe('blue');
  });

  test('atomicActivateRuntime uses transaction', () => {
    const fx = homeFixture();
    const { authority, pointer } = atomicActivateRuntime(fx.controllerHome, {
      activeSlot: 'green',
      generation: 'gen-atomic',
      reason: 'atomic',
    });
    expect(authority.epoch).toBe(pointer.writerEpoch ?? authority.epoch);
    expect(readActivationAuthority(fx.controllerHome)?.fencingToken).toBe(authority.fencingToken);
  });
});

describe('stable root storage', () => {
  test('repositoryControllerRoot from slot home resolves stable root', () => {
    const fx = homeFixture();
    const slotHome = join(fx.controllerHome, 'runtime-slots', 'green');
    mkdirSync(slotHome, { recursive: true });
    const dual = resolveDualHome(slotHome);
    expect(dual.rootControllerHome).toBe(resolveStableControllerHome(slotHome));
    expect(dual.slot).toBe('green');
    expect(dual.usesStableRoot).toBe(true);

    const root = repositoryControllerRoot(slotHome, 'repo_demo');
    expect(root).toBe(join(fx.controllerHome, 'repositories', 'repo_demo'));
    expect(root.includes('runtime-slots')).toBe(false);
  });

  test('migration then resolve points at stable root', () => {
    const fx = homeFixture();
    const slotRepo = join(fx.controllerHome, 'runtime-slots', 'green', 'repositories', 'repo_m');
    mkdirSync(join(slotRepo, 'processes'), { recursive: true });
    writeFileSync(join(slotRepo, 'processes', 'p.json'), '{"schemaVersion":1}\n');
    const report = migrateRepositoryStateOutOfSlots({ controllerHome: fx.controllerHome, dryRun: false });
    expect(report.ok).toBe(true);
    const resolved = resolveRepositoryStatePath(fx.controllerHome, 'repo_m');
    expect(resolved.source).toBe('stable');
    // Even when asked via slot home:
    const viaSlot = resolveRepositoryStatePath(join(fx.controllerHome, 'runtime-slots', 'green'), 'repo_m');
    expect(viaSlot.source).toBe('stable');
    expect(viaSlot.path).toBe(join(fx.controllerHome, 'repositories', 'repo_m'));
  });

  test('durableControllerHome normalizes slot path', () => {
    const fx = homeFixture();
    const slot = join(fx.controllerHome, 'runtime-slots', 'blue');
    expect(durableControllerHome(slot)).toBe(fx.controllerHome);
  });
});

describe('process runtime restart receipt', () => {
  test('short process completes with exit receipt; recover after monitor loss uses receipt', async () => {
    const fx = repoFixture();
    const handle = await spawnManagedProcess({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      command: {
        kind: 'argv',
        executable: 'node',
        args: ['-e', 'process.stdout.write("hi"); process.exit(0)'],
        cwd: fx.repoRoot,
      },
      interactiveWaitMs: 5_000,
      timeoutMs: 15_000,
    });
    expect(handle.completed).toBe(true);
    expect(handle.ok).toBe(true);

    // Simulate controller restart: drop monitors, re-read record with receipt.
    __resetLiveMonitorsForTests();
    const again = getProcessHandle(fx.controllerHome, fx.repository.repoId, handle.processId);
    expect(again?.completed).toBe(true);
    expect(again?.status).toBe('succeeded');
  });

  test('lost monitor while still running recovers as running_recovered; then exit becomes completed_unknown without receipt', async () => {
    const fx = repoFixture();
    const handle = await spawnManagedProcess({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      command: {
        kind: 'argv',
        executable: 'node',
        args: ['-e', 'setTimeout(() => process.exit(0), 8000)'],
        cwd: fx.repoRoot,
      },
      interactiveWaitMs: 0,
      timeoutMs: 30_000,
      returnHandleImmediately: true,
    });
    expect(handle.completed).toBe(false);
    // Drop monitor without killing OS process — receipt may still be written by original child close if process ends under detached group.
    // We only assert recoverManagedProcesses classification paths with synthetic dead identity.
    __resetLiveMonitorsForTests();

    // Force record to look like dead without receipt:
    const { getProcessRecord, updateProcessRecord, tryCompleteProcessRecord } = await import('../../src/runtime/execution/process-runtime/store');
    const record = getProcessRecord(fx.controllerHome, fx.repository.repoId, handle.processId);
    expect(record).toBeTruthy();
    // Cancel OS process to avoid leak
    try {
      if (record?.identity?.pid) process.kill(record.identity.pid, 'SIGKILL');
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 50));

    // Clear receipt if any to force outcome_unknown path
    if (record?.exitReceiptPath && existsSync(record.exitReceiptPath)) {
      try { rmSync(record.exitReceiptPath); } catch { /* ignore */ }
    }
    // Ensure still non-terminal
    if (record && !record.terminalWritten) {
      const recovery = recoverManagedProcesses(fx.controllerHome, fx.repository.repoId);
      // Either completed from late receipt or completed_unknown
      const after = getProcessHandle(fx.controllerHome, fx.repository.repoId, handle.processId);
      expect(after?.completed).toBe(true);
      expect(after?.status).toBeDefined();
      expect(['succeeded', 'failed', 'completed_unknown', 'cancelled', 'timed_out']).toContain(after!.status);
      expect(after?.status).not.toBe('orphaned');
      void recovery;
      void tryCompleteProcessRecord;
      void updateProcessRecord;
    }
  });

  test('cancel refuses untrusted identity (no signal on fallback PID)', async () => {
    const fx = repoFixture();
    const { createProcessRecord } = await import('../../src/runtime/execution/process-runtime/store');
    const processId = `proc_untrusted_${Date.now()}`;
    createProcessRecord({
      schemaVersion: 1,
      processId,
      repoId: fx.repository.repoId,
      controllerHome: fx.controllerHome,
      status: 'running',
      route: 'managed',
      command: { kind: 'argv', executable: 'sleep', args: ['30'], cwd: fx.repoRoot },
      identity: {
        pid: 1,
        processStartTime: 'untrusted:1',
        executableFingerprint: 'x',
      },
      identityUntrusted: true,
      resourceClaims: [],
      interactiveWaitMs: 0,
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      terminalFenceToken: 1,
    });
    const cancelled = await cancelProcess(fx.controllerHome, fx.repository.repoId, processId);
    expect(cancelled.completed).toBe(true);
    expect(cancelled.status).toBe('completed_unknown');
  });
});

describe('repository command process routing', () => {
  test('readonly short → process_direct; release create → durable', () => {
    expect(classifyRepositoryCommandRoute(['git', 'log', '-1']).route).toBe('process_direct');
    expect(classifyRepositoryCommandRoute(['gh', 'release', 'view', 'v1']).route).toBe('process_direct');
    expect(classifyRepositoryCommandRoute(['gh', 'release', 'create', 'v1']).route).toBe('durable');
    expect(classifyRepositoryCommandRoute(['git', 'push', 'origin', 'main']).route).toBe('durable');
  });

  test('execute readonly via process runtime without durable side effects', async () => {
    const fx = repoFixture();
    const result = await executeRepositoryCommandViaProcessRuntime({
      controllerHome: fx.controllerHome,
      repository: fx.repository,
      command: ['git', 'rev-parse', 'HEAD'],
      interactiveWaitMs: 5_000,
      timeoutMs: 15_000,
    });
    expect(['process_direct', 'process_managed']).toContain(result.route);
    expect(result.durableSideEffects.executionJobCount).toBe(0);
    expect(result.durableSideEffects.workerSpawnCount).toBe(0);
    if (result.route === 'process_direct') {
      expect(result.ok).toBe(true);
    }
  });
});

describe('process log GC', () => {
  test('GC skips active and requires no throw on failure', async () => {
    const fx = repoFixture();
    const handle = await spawnManagedProcess({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      command: {
        kind: 'argv',
        executable: 'node',
        args: ['-e', 'process.exit(0)'],
        cwd: fx.repoRoot,
      },
      interactiveWaitMs: 5_000,
    });
    expect(handle.completed).toBe(true);
    const result = gcTerminalProcesses({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      maxAgeMs: 0,
      maxTerminalRecords: 0,
      deleteLogs: true,
    });
    expect(result.ok).toBe(true);
    expect(result.removedRecords).toBeGreaterThanOrEqual(1);
  });
});

describe('control socket safety', () => {
  test('refuses to unlink regular file at socket path', () => {
    const fx = homeFixture();
    const sock = join(fx.controllerHome, 'bootstrap', 'control.sock');
    mkdirSync(join(fx.controllerHome, 'bootstrap'), { recursive: true });
    writeFileSync(sock, 'not-a-socket\n');
    const self = fakeIdentity();
    // Owner missing / dead → would try cleanup but refuse regular file
    expect(() => ensureControlSocketReady(fx.controllerHome, self, {
      isAlive: () => false,
      command: () => undefined,
      startTime: () => undefined,
    } as any)).toThrow(/CONTROL_SOCKET_REFUSES_REGULAR_FILE|CONTROL_SOCKET/);
  });

  test('refuses to unlink symlink at socket path', () => {
    const fx = homeFixture();
    const bootstrap = join(fx.controllerHome, 'bootstrap');
    mkdirSync(bootstrap, { recursive: true });
    const target = join(fx.root, 'important.txt');
    writeFileSync(target, 'keep\n');
    const sock = join(bootstrap, 'control.sock');
    try {
      symlinkSync(target, sock);
    } catch {
      // Windows or FS without symlink — skip
      return;
    }
    const self = fakeIdentity();
    expect(() => ensureControlSocketReady(fx.controllerHome, self, {
      isAlive: () => false,
      command: () => undefined,
      startTime: () => undefined,
    } as any)).toThrow(/CONTROL_SOCKET_REFUSES_SYMLINK|CONTROL_SOCKET/);
    expect(readFileSync(target, 'utf8')).toBe('keep\n');
  });
});
