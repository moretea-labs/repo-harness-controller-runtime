/**
 * Checkout Mutation Ownership backed by the shared Execution Lease arbiter.
 *
 * Fast Path uses visibility=ephemeral (active set + fencing only; no projection
 * dirty / scheduler wake / runtime events). Durable workers use default durable
 * leases. Both contend on workspace:<checkoutId> with expanded path/git-ref
 * overlap rules.
 *
 * Ownership lifecycle is covered by the mutation lease alone — do NOT hold the
 * repository controller lock for the duration of the write (renew needs that lock).
 */
import { createHash } from 'crypto';
import {
  acquireExecutionLeases,
  assertFencingToken,
  releaseExecutionLeases,
  renewExecutionLeases,
} from '../../resources/leases/store';
import type { ExecutionLease } from '../../resources/leases/types';
import { runBoundedGit } from './async-process';

export interface CheckoutMutationGate {
  gateId: string;
  owner: string;
  ownerJobId: string;
  repoId: string;
  checkoutId: string;
  resourceKey: string;
  leaseId: string;
  fencingToken: number;
  baseHead: string | null;
  baseStatusHash: string | null;
  acquiredAt: string;
  expiresAt: string;
  ttlMs: number;
  renewCount: number;
}

export interface MutationGateBusy {
  busy: true;
  reason: string;
  blockers: Array<{ kind: 'fast_gate' | 'durable_lease'; owner: string; resourceKey?: string; leaseId?: string }>;
}

export type MutationGateAcquireResult =
  | { acquired: true; gate: CheckoutMutationGate }
  | MutationGateBusy;

export interface MutationGateHelpers {
  renew: () => CheckoutMutationGate;
  assert: () => void;
  /** Aborts when ownership is lost or renew fails. Combine with caller signal. */
  signal: AbortSignal;
  getGate: () => CheckoutMutationGate;
}

const DEFAULT_TTL_MS = 30_000;
const MIN_TTL_MS = 3_000;
const MAX_TTL_MS = 120_000;

export function checkoutMutationResourceKey(checkoutId: string): string {
  return `workspace:${checkoutId}`;
}

async function snapshotHash(repoRoot: string, signal?: AbortSignal): Promise<{ head: string | null; statusHash: string | null }> {
  const [headResult, statusResult] = await Promise.all([
    runBoundedGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], {
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      signal,
    }),
    runBoundedGit(repoRoot, [
      'status', '--porcelain=v1', '--untracked-files=all', '--', '.', ':(exclude).ai/harness/**',
    ], {
      timeoutMs: 5_000,
      maxOutputBytes: 128 * 1024,
      signal,
    }),
  ]);
  if (statusResult.cancelled || headResult.cancelled) {
    throw new Error('CANCELLED: mutation snapshot aborted');
  }
  if (!statusResult.ok) {
    throw new Error(`MUTATION_SNAPSHOT_FAILED: git status failed: ${statusResult.stderr || statusResult.exitCode}`);
  }
  // unborn HEAD is ok (empty repo / no commits yet)
  const head = headResult.ok ? (headResult.stdout.trim() || null) : null;
  return {
    head,
    statusHash: createHash('sha256').update(statusResult.stdout).digest('hex'),
  };
}

/**
 * Acquire exclusive checkout mutation ownership via ephemeral Execution Lease.
 * Snapshot is taken AFTER lease acquisition under ownership.
 */
export async function acquireCheckoutMutationGate(input: {
  controllerHome: string;
  repoId: string;
  checkoutId: string;
  repoRoot: string;
  owner: string;
  ttlMs?: number;
}): Promise<MutationGateAcquireResult> {
  const ttlMs = Math.max(MIN_TTL_MS, Math.min(input.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS));
  const resourceKey = checkoutMutationResourceKey(input.checkoutId);
  const ownerJobId = input.owner.startsWith('fast:') || input.owner.startsWith('JOB-')
    ? input.owner
    : `fast:${input.owner}`;

  // 1) Acquire lease first (short controller lock only inside lease store).
  const result = acquireExecutionLeases(
    input.controllerHome,
    input.repoId,
    ownerJobId,
    [{ resourceKey, mode: 'write' }],
    {
      visibility: 'ephemeral',
      notifyScheduler: false,
      invalidateProjection: false,
      emitRuntimeEvent: false,
      ttlMs,
    },
  );

  if (!result.acquired || result.leases.length === 0) {
    return {
      busy: true,
      reason: 'mutation_ownership_busy',
      blockers: result.blockers.map((blocker) => ({
        kind: blocker.ownerJobId.startsWith('fast:') ? 'fast_gate' as const : 'durable_lease' as const,
        owner: blocker.ownerJobId,
        resourceKey: blocker.resourceKey,
        leaseId: blocker.leaseId,
      })),
    };
  }

  const lease = result.leases[0]!;

  // 2) Snapshot under ownership — never before lease.
  let snap: { head: string | null; statusHash: string | null };
  try {
    snap = await snapshotHash(input.repoRoot);
  } catch (error) {
    releaseExecutionLeases(
      input.controllerHome,
      input.repoId,
      ownerJobId,
      [{ leaseId: lease.leaseId, fencingToken: lease.fencingToken }],
      { visibility: 'ephemeral', notifyScheduler: false, invalidateProjection: false, emitRuntimeEvent: false },
    );
    return {
      busy: true,
      reason: 'snapshot_failed',
      blockers: [{
        kind: 'fast_gate',
        owner: error instanceof Error ? error.message : String(error),
      }],
    };
  }

  return {
    acquired: true,
    gate: {
      gateId: ownerJobId,
      owner: ownerJobId,
      ownerJobId,
      repoId: input.repoId,
      checkoutId: input.checkoutId,
      resourceKey,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      baseHead: snap.head,
      baseStatusHash: snap.statusHash,
      acquiredAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
      ttlMs,
      renewCount: 0,
    },
  };
}

export function renewCheckoutMutationGate(
  controllerHome: string,
  gate: CheckoutMutationGate,
  ttlMs?: number,
): CheckoutMutationGate {
  const nextTtl = Math.max(MIN_TTL_MS, Math.min(ttlMs ?? gate.ttlMs, MAX_TTL_MS));
  const renewed = renewExecutionLeases(
    controllerHome,
    gate.repoId,
    gate.ownerJobId,
    nextTtl,
    [{ leaseId: gate.leaseId, fencingToken: gate.fencingToken }],
  );
  const lease = renewed.find((entry) => entry.leaseId === gate.leaseId);
  if (!lease) {
    throw new Error(`MUTATION_RENEW_FAILED: lease ${gate.leaseId} missing after renew`);
  }
  return {
    ...gate,
    expiresAt: lease.expiresAt,
    fencingToken: lease.fencingToken,
    ttlMs: nextTtl,
    renewCount: gate.renewCount + 1,
  };
}

export function assertCheckoutMutationGate(
  controllerHome: string,
  gate: CheckoutMutationGate,
): ExecutionLease {
  return assertFencingToken(controllerHome, gate.repoId, gate.leaseId, gate.fencingToken);
}

export function releaseCheckoutMutationGate(
  controllerHome: string,
  repoId: string,
  _checkoutId: string,
  gateIdOrOwner?: string,
  fencing?: { leaseId: string; fencingToken: number },
): void {
  if (!gateIdOrOwner) return;
  releaseExecutionLeases(
    controllerHome,
    repoId,
    gateIdOrOwner,
    fencing ? [{ leaseId: fencing.leaseId, fencingToken: fencing.fencingToken }] : undefined,
    { visibility: 'ephemeral', notifyScheduler: false, invalidateProjection: false, emitRuntimeEvent: false },
  );
}

export function releaseCheckoutMutationGateOwned(
  controllerHome: string,
  gate: CheckoutMutationGate,
): void {
  releaseExecutionLeases(
    controllerHome,
    gate.repoId,
    gate.ownerJobId,
    [{ leaseId: gate.leaseId, fencingToken: gate.fencingToken }],
    { visibility: 'ephemeral', notifyScheduler: false, invalidateProjection: false, emitRuntimeEvent: false },
  );
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Hold mutation ownership for the duration of operation with automatic heartbeat renew.
 * Renew interval = ttl/3. Renew failure aborts ownershipSignal (not only flags).
 * Does NOT hold repository controller lock during operation.
 */
export async function withCheckoutMutationGate<T>(
  input: {
    controllerHome: string;
    repoId: string;
    checkoutId: string;
    repoRoot: string;
    owner: string;
    ttlMs?: number;
    signal?: AbortSignal;
  },
  operation: (gate: CheckoutMutationGate, helpers: MutationGateHelpers) => Promise<T>,
): Promise<{ ok: true; value: T; gate: CheckoutMutationGate } | { ok: false; busy: MutationGateBusy }> {
  const acquired = await acquireCheckoutMutationGate(input);
  if (!('acquired' in acquired) || !acquired.acquired) {
    return { ok: false, busy: acquired as MutationGateBusy };
  }

  let gate = acquired.gate;
  const ownershipAbort = new AbortController();
  const combined = combineAbortSignals([input.signal, ownershipAbort.signal]);
  let renewFailed: Error | undefined;
  const renewIntervalMs = Math.max(500, Math.floor(gate.ttlMs / 3));

  const failOwnership = (error: unknown) => {
    if (renewFailed) return;
    renewFailed = error instanceof Error ? error : new Error(String(error));
    try {
      ownershipAbort.abort(renewFailed);
    } catch {
      /* already aborted */
    }
  };

  const timer = setInterval(() => {
    try {
      gate = renewCheckoutMutationGate(input.controllerHome, gate);
    } catch (error) {
      failOwnership(error);
    }
  }, renewIntervalMs);
  timer.unref?.();

  const helpers: MutationGateHelpers = {
    renew: () => {
      if (renewFailed) throw renewFailed;
      gate = renewCheckoutMutationGate(input.controllerHome, gate);
      return gate;
    },
    assert: () => {
      if (renewFailed) throw renewFailed;
      if (combined.aborted) throw new Error('MUTATION_OWNERSHIP_LOST: ownership signal aborted');
      assertCheckoutMutationGate(input.controllerHome, gate);
    },
    signal: combined,
    getGate: () => gate,
  };

  try {
    const value = await operation(gate, helpers);
    if (renewFailed) throw renewFailed;
    // Final fencing check before success returns.
    assertCheckoutMutationGate(input.controllerHome, gate);
    return { ok: true, value, gate };
  } finally {
    clearInterval(timer);
    try {
      releaseCheckoutMutationGateOwned(input.controllerHome, gate);
    } catch {
      /* best-effort release */
    }
  }
}

export function mutationGateBusyMessage(busy: MutationGateBusy): string {
  const owners = busy.blockers.map((entry) => entry.owner).join(', ');
  return `${busy.reason}: active writers=[${owners}]`;
}
