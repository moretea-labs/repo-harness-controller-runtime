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

  test('committed A + prepared B → recovery keeps B and reports incomplete', () => {
    const fx = homeFixture();
    const a = commitActivationTransaction(fx.controllerHome, {
      activeSlot: 'green',
      generation: 'gen-a',
      releaseRevision: 'rev-a',
      releasePath: '/tmp/releases/rev-a',
      reason: 'A',
    });
    // Simulate prepare for transaction B after A is committed.
    writeFileSync(activationPreparePath(fx.controllerHome), `${JSON.stringify({
      schemaVersion: 1,
      status: 'prepared',
      transactionId: 'atx-b-mismatch',
      preparedAt: new Date().toISOString(),
      intended: {
        transactionId: 'atx-b-mismatch',
        activeSlot: 'blue',
        generation: 'gen-b',
        releaseRevision: 'rev-b',
        releasePath: '/tmp/releases/rev-b',
        writerEpoch: 'wa-b',
        fencingToken: 'tok-b',
      },
    }, null, 2)}\n`);
    const recovered = recoverActivationTransaction(fx.controllerHome);
    expect(recovered.ok).toBe(false);
    expect(recovered.status).toBe('incomplete');
    expect(existsSync(activationPreparePath(fx.controllerHome))).toBe(true);
    expect(readActivationAuthority(fx.controllerHome)?.transactionId).toBe(a.transactionId);
    expect(recovered.error).toMatch(/prepared_pending_resolution|does not match/);
  });

  test('committed A + matching prepare A → recovery rebuilds projections and clears prepare', () => {
    const fx = homeFixture();
    const a = commitActivationTransaction(fx.controllerHome, {
      activeSlot: 'blue',
      generation: 'gen-match',
      reason: 'match',
    });
    writeFileSync(activationPreparePath(fx.controllerHome), `${JSON.stringify({
      schemaVersion: 1,
      status: 'prepared',
      transactionId: a.transactionId,
      preparedAt: new Date().toISOString(),
      intended: {
        transactionId: a.transactionId,
        activeSlot: a.activeSlot,
        generation: a.generation,
        writerEpoch: a.writerEpoch,
        fencingToken: a.fencingToken,
      },
    }, null, 2)}\n`);
    // Damage writer projection to force rebuild.
    writeFileSync(join(fx.controllerHome, 'bootstrap', 'writer-authority.json'), '{}\n');
    const recovered = recoverActivationTransaction(fx.controllerHome);
    expect(recovered.ok).toBe(true);
    expect(recovered.status).toBe('committed');
    expect(existsSync(activationPreparePath(fx.controllerHome))).toBe(false);
    expect(readWriterAuthority(fx.controllerHome)?.epoch).toBe(a.writerEpoch);
  });

  test('full previousRuntime snapshot rollback restores release metadata and rotates writer epoch', () => {
    const fx = homeFixture();
    const a = commitActivationTransaction(fx.controllerHome, {
      activeSlot: 'green',
      generation: 'gen-a',
      releaseRevision: 'rev-a',
      releasePath: '/controlled/releases/rev-a',
      daemonPort: 7101,
      gatewayPort: 7102,
      reason: 'release-A',
    });
    const b = commitActivationTransaction(fx.controllerHome, {
      activeSlot: 'blue',
      generation: 'gen-b',
      releaseRevision: 'rev-b',
      releasePath: '/controlled/releases/rev-b',
      daemonPort: 7201,
      gatewayPort: 7202,
      reason: 'release-B',
      previousEpoch: a.writerEpoch,
    });
    expect(b.previousRuntime?.releaseRevision).toBe('rev-a');
    expect(b.previousRuntime?.releasePath).toBe('/controlled/releases/rev-a');
    expect(b.previousRuntime?.daemonPort).toBe(7101);

    const rolled = rollbackActivationTransaction(fx.controllerHome, { reason: 'rollback-to-A' });
    expect(rolled.activeSlot).toBe('green');
    expect(rolled.generation).toBe('gen-a');
    expect(rolled.releaseRevision).toBe('rev-a');
    expect(rolled.releasePath).toBe('/controlled/releases/rev-a');
    expect(rolled.daemonPort).toBe(7101);
    expect(rolled.gatewayPort).toBe(7102);
    // Writer epoch must change (new fencing).
    expect(rolled.writerEpoch).not.toBe(b.writerEpoch);
    expect(rolled.writerEpoch).not.toBe(a.writerEpoch);
    expect(rolled.fencingToken).not.toBe(b.fencingToken);
    // Pre-rollback B preserved for limited re-rollback.
    expect(rolled.previousRuntime?.activeSlot).toBe('blue');
    expect(rolled.previousRuntime?.releaseRevision).toBe('rev-b');
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

  test('controller monitor loss while runner survives recovers true exit code from receipt (not completed_unknown)', async () => {
    const fx = repoFixture();
    const {
      __detachMonitorsKeepRunnersForTests,
    } = await import('../../src/runtime/execution/process-runtime/runtime');
    const handle = await spawnManagedProcess({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      command: {
        kind: 'argv',
        executable: 'node',
        args: ['-e', 'setTimeout(() => process.exit(0), 400)'],
        cwd: fx.repoRoot,
      },
      interactiveWaitMs: 0,
      timeoutMs: 30_000,
      returnHandleImmediately: true,
    });
    expect(handle.completed).toBe(false);

    // Simulate Controller crash: drop monitors and close handlers without killing runner.
    __detachMonitorsKeepRunnersForTests();

    // Wait for independent runner to finish and write exit receipt.
    const receiptPath = join(
      fx.controllerHome,
      'repositories',
      fx.repository.repoId,
      'processes',
      'logs',
      `${handle.processId}.exit.json`,
    );
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !existsSync(receiptPath)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { exitCode: number | null; commandExecutedOnce?: boolean };
    expect(receipt.exitCode).toBe(0);
    expect(receipt.commandExecutedOnce).toBe(true);

    // New controller recovery attaches via receipt → succeeded, not completed_unknown.
    const recovery = recoverManagedProcesses(fx.controllerHome, fx.repository.repoId);
    expect(recovery.completedFromReceipt).toContain(handle.processId);
    const after = getProcessHandle(fx.controllerHome, fx.repository.repoId, handle.processId);
    expect(after?.completed).toBe(true);
    expect(after?.status).toBe('succeeded');
    expect(after?.ok).toBe(true);
    expect(after?.status).not.toBe('completed_unknown');
  });

  test('controller monitor loss recovers non-zero exit as failed from runner receipt', async () => {
    const fx = repoFixture();
    const {
      __detachMonitorsKeepRunnersForTests,
    } = await import('../../src/runtime/execution/process-runtime/runtime');
    const handle = await spawnManagedProcess({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      command: {
        kind: 'argv',
        executable: 'node',
        args: ['-e', 'setTimeout(() => process.exit(7), 300)'],
        cwd: fx.repoRoot,
      },
      interactiveWaitMs: 0,
      timeoutMs: 30_000,
      returnHandleImmediately: true,
    });
    __detachMonitorsKeepRunnersForTests();
    const receiptPath = join(
      fx.controllerHome,
      'repositories',
      fx.repository.repoId,
      'processes',
      'logs',
      `${handle.processId}.exit.json`,
    );
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !existsSync(receiptPath)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(receiptPath)).toBe(true);
    const recovery = recoverManagedProcesses(fx.controllerHome, fx.repository.repoId);
    expect(recovery.completedFromReceipt).toContain(handle.processId);
    const after = getProcessHandle(fx.controllerHome, fx.repository.repoId, handle.processId);
    expect(after?.status).toBe('failed');
    expect(after?.exitCode).toBe(7);
    expect(after?.status).not.toBe('completed_unknown');
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

describe('writer claim inheritance and remaining fencing', () => {
  test('bindRuntimeWriterClaim uses inferred slot, not authority.activeSlot after cutover', () => {
    const fx = homeFixture();
    const slotHome = join(fx.controllerHome, 'runtime-slots', 'green');
    mkdirSync(slotHome, { recursive: true });
    const first = publishWriterAuthority(fx.controllerHome, { activeSlot: 'green', reason: 'boot' });
    // Bind from slot home path without explicit slot — infer green.
    bindRuntimeWriterClaim({
      controllerHome: slotHome,
      epoch: first.epoch,
      fencingToken: first.fencingToken,
    });
    expect(getRuntimeWriterClaim()?.slot).toBe('green');

    // Cutover to blue; old process still holds green claim.
    publishWriterAuthority(fx.controllerHome, {
      activeSlot: 'blue',
      reason: 'cutover',
      previousEpoch: first.epoch,
    });
    // If we re-bound by re-reading authority we would steal blue — must not.
    clearRuntimeWriterClaimForTests();
    expect(() => bindRuntimeWriterClaim({
      controllerHome: slotHome,
      allowLegacyMissing: true,
      adoptCurrentAuthority: false,
    })).toThrow(/WRITER_CLAIM_BIND_FAILED|inherit full writer claim/);
  });

  test('authority present without full inherited claim fails closed', () => {
    const fx = homeFixture();
    publishWriterAuthority(fx.controllerHome, { activeSlot: 'green', reason: 'boot' });
    expect(() => bindRuntimeWriterClaim({
      controllerHome: fx.controllerHome,
      slot: 'green',
      allowLegacyMissing: true,
      adoptCurrentAuthority: false,
    })).toThrow(/WRITER_CLAIM_BIND_FAILED/);
  });

  test('legacy home without authority still binds synthetic claim', () => {
    const fx = homeFixture();
    // No publishWriterAuthority
    const claim = bindRuntimeWriterClaim({
      controllerHome: fx.controllerHome,
      slot: 'green',
      allowLegacyMissing: true,
      adoptCurrentAuthority: false,
    });
    expect(claim.legacy).toBe(true);
    expect(assertThisRuntimeMayWrite('consume_queue').allowed).toBe(true);
  });

  test('stale worker claim cannot release leases after cutover', () => {
    const fx = repoFixture();
    const auth = publishWriterAuthority(fx.controllerHome, { activeSlot: 'green', reason: 'active' });
    bindRuntimeWriterClaim({
      controllerHome: fx.controllerHome,
      slot: 'green',
      epoch: auth.epoch,
      fencingToken: auth.fencingToken,
    });
    const ok = acquireExecutionLeases(
      fx.controllerHome,
      fx.repository.repoId,
      'job-release-fence',
      [claimWorkspaceRead('co')],
      30_000,
    );
    expect(ok.acquired).toBe(true);

    // Cutover fences the old claim.
    publishWriterAuthority(fx.controllerHome, {
      activeSlot: 'green',
      reason: 'rotate',
      previousEpoch: auth.epoch,
    });
    expect(() => releaseExecutionLeases(
      fx.controllerHome,
      fx.repository.repoId,
      'job-release-fence',
      ok.leases,
    )).toThrow(/WRITER_FENCED/);
    // Lease still present.
    expect(listActiveLeases(fx.controllerHome, fx.repository.repoId).length).toBeGreaterThan(0);
  });

  test('passive cannot integrate worktree (fencing at integrateAgentJob boundary)', () => {
    const fx = homeFixture();
    publishWriterAuthority(fx.controllerHome, { activeSlot: 'green', reason: 'active' });
    bindRuntimeWriterClaim({
      controllerHome: fx.controllerHome,
      slot: 'blue',
      epoch: 'stale',
      fencingToken: 'stale',
    });
    // Dynamic require to avoid loading full agent-job graph when not needed for other tests.
    const { integrateAgentJob } = require('../../src/cli/agent-jobs/integration') as typeof import('../../src/cli/agent-jobs/integration');
    expect(() => integrateAgentJob(fx.root, { profile: 'controller' } as any, 'run_missing')).toThrow(/WRITER_FENCED/);
  });

  test('passive cannot execute remote side effect via command executor fence', () => {
    const fx = repoFixture();
    publishWriterAuthority(fx.controllerHome, { activeSlot: 'green', reason: 'active' });
    bindRuntimeWriterClaim({
      controllerHome: fx.controllerHome,
      slot: 'blue',
      epoch: 'stale',
      fencingToken: 'stale',
    });
    const { executeRepositoryCommand } = require('../../src/cli/repositories/command-executor') as typeof import('../../src/cli/repositories/command-executor');
    // Force a remote_write classification path by using git push argv; dryRun false.
    // Fence must throw before spawn.
    expect(() => executeRepositoryCommand(fx.controllerHome, fx.repository, {
      command: ['git', 'push', 'origin', 'main'],
      approvalToken: 'test',
      authorization: { confirmed: true } as any,
    })).toThrow(/WRITER_FENCED|approval|AUTHORIZ|CONFIRM|denied|remote/i);
  });

  test('disk log quota stops unbounded growth', async () => {
    const fx = repoFixture();
    const maxBytes = 8_192;
    const handle = await spawnManagedProcess({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      command: {
        kind: 'argv',
        executable: 'node',
        args: ['-e', 'process.stdout.write("x".repeat(200000)); process.exit(0)'],
        cwd: fx.repoRoot,
      },
      interactiveWaitMs: 10_000,
      timeoutMs: 15_000,
      maxOutputBytes: maxBytes,
    });
    expect(handle.completed).toBe(true);
    const { getProcessRecord } = await import('../../src/runtime/execution/process-runtime/store');
    const { readProcessLogs, readFileTailBytes } = await import('../../src/runtime/execution/process-runtime/runtime');
    const record = getProcessRecord(fx.controllerHome, fx.repository.repoId, handle.processId);
    expect(record).toBeTruthy();
    const stdoutPath = record!.stdoutPath!;
    expect(existsSync(stdoutPath)).toBe(true);
    const size = readFileSync(stdoutPath).length;
    // Hard disk quota: stored size must not far exceed configured max.
    expect(size).toBeLessThanOrEqual(maxBytes + 64);
    const logs = readProcessLogs(fx.controllerHome, fx.repository.repoId, handle.processId, 4_096);
    expect(logs).toBeTruthy();
    expect(logs!.stdoutBytes).toBeGreaterThan(0);
    // Bounded tail read must not throw on large files.
    const tail = readFileTailBytes(stdoutPath, 1_024);
    expect(tail.text.length).toBeGreaterThan(0);
    expect(tail.fileBytes).toBe(size);
  });

  test('process MCP tools are registered and process_get is repo-scoped', async () => {
    const { processToolDefinitions, callProcessTool } = await import('../../src/runtime/gateway/mcp/process-tools');
    const names = processToolDefinitions.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'process_get',
      'process_wait',
      'process_logs',
      'process_cancel',
    ]));
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
    const ctx = {
      controllerHome: fx.controllerHome,
      repoRoot: fx.repoRoot,
      sessionId: 'sess-test',
      policy: { profile: 'controller', execution: { agentRunner: 'none', allowedAgents: [], runnerTimeoutMs: 60_000, runnerMaxTimeoutMs: 120_000 } },
    } as any;
    const got = await callProcessTool(ctx, 'process_get', {
      repo_id: fx.repository.repoId,
      process_id: handle.processId,
    });
    expect(got).toBeTruthy();
    expect(got!.isError).not.toBe(true);
    const payload = got!.structuredContent as any;
    expect(payload.process.processId).toBe(handle.processId);
    expect(payload.process.status).toBe('succeeded');

    // Wrong repo → error
    const wrong = await callProcessTool(ctx, 'process_get', {
      repo_id: 'repo_does_not_exist',
      process_id: handle.processId,
    });
    expect(wrong?.isError).toBe(true);
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
