/**
 * Checkout Mutation Ownership backed by the shared Execution Lease arbiter.
 *
 * Fast Path and Durable Work both claim `workspace:<checkoutId>` (write mode)
 * through acquireExecutionLeases — no separate file-gate race, no one-way
 * observation. Heartbeat renew keeps long batches alive; release is
 * compare-and-delete via fencing tokens.
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
  /** Alias of ownerJobId used for lease ownership. */
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
}

export interface MutationGateBusy {
  busy: true;
  reason: string;
  blockers: Array<{ kind: 'fast_gate' | 'durable_lease'; owner: string; resourceKey?: string; leaseId?: string }>;
}

export type MutationGateAcquireResult =
  | { acquired: true; gate: CheckoutMutationGate }
  | MutationGateBusy;

const DEFAULT_TTL_MS = 30_000;
const MIN_TTL_MS = 5_000;
const MAX_TTL_MS = 120_000;

export function checkoutMutationResourceKey(checkoutId: string): string {
  return `workspace:${checkoutId}`;
}

async function snapshotHash(repoRoot: string): Promise<{ head: string | null; statusHash: string | null }> {
  const [headResult, statusResult] = await Promise.all([
    runBoundedGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], {
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }),
    runBoundedGit(repoRoot, [
      'status', '--porcelain=v1', '--untracked-files=all', '--', '.', ':(exclude).ai/harness/**',
    ], {
      timeoutMs: 5_000,
      maxOutputBytes: 128 * 1024,
    }),
  ]);
  if (!headResult.ok && !headResult.stdout.trim()) {
    // Unborn HEAD is ok (empty repo); hard failures still produce empty status.
  }
  const head = headResult.ok ? (headResult.stdout.trim() || null) : null;
  if (!statusResult.ok && !statusResult.cancelled) {
    throw new Error(`MUTATION_SNAPSHOT_FAILED: git status failed: ${statusResult.stderr || statusResult.exitCode}`);
  }
  const status = statusResult.stdout;
  return {
    head,
    statusHash: createHash('sha256').update(status).digest('hex'),
  };
}

/**
 * Acquire exclusive checkout mutation ownership via the durable lease store.
 * Does not create ExecutionJob. Durable writers claiming the same workspace key conflict atomically.
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

  let snap: { head: string | null; statusHash: string | null };
  try {
    snap = await snapshotHash(input.repoRoot);
  } catch (error) {
    return {
      busy: true,
      reason: 'snapshot_failed',
      blockers: [{
        kind: 'fast_gate',
        owner: error instanceof Error ? error.message : String(error),
      }],
    };
  }

  const result = acquireExecutionLeases(
    input.controllerHome,
    input.repoId,
    ownerJobId,
    [{ resourceKey, mode: 'write' }],
    ttlMs,
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
  );
}

/**
 * Hold mutation ownership for the duration of operation with automatic heartbeat renew.
 * Renew interval = ttl/3. Renew failure aborts by throwing after operation cancellation is signalled.
 */
export async function withCheckoutMutationGate<T>(
  input: {
    controllerHome: string;
    repoId: string;
    checkoutId: string;
    repoRoot: string;
    owner: string;
    ttlMs?: number;
  },
  operation: (gate: CheckoutMutationGate, helpers: {
    renew: () => CheckoutMutationGate;
    assert: () => void;
  }) => Promise<T>,
): Promise<{ ok: true; value: T; gate: CheckoutMutationGate } | { ok: false; busy: MutationGateBusy }> {
  const acquired = await acquireCheckoutMutationGate(input);
  if (!('acquired' in acquired) || !acquired.acquired) {
    return { ok: false, busy: acquired as MutationGateBusy };
  }

  let gate = acquired.gate;
  let renewFailed: Error | undefined;
  const renewIntervalMs = Math.max(1_000, Math.floor(gate.ttlMs / 3));
  const timer = setInterval(() => {
    try {
      gate = renewCheckoutMutationGate(input.controllerHome, gate);
    } catch (error) {
      renewFailed = error instanceof Error ? error : new Error(String(error));
    }
  }, renewIntervalMs);
  timer.unref?.();

  try {
    const value = await operation(gate, {
      renew: () => {
        gate = renewCheckoutMutationGate(input.controllerHome, gate);
        return gate;
      },
      assert: () => {
        if (renewFailed) throw renewFailed;
        assertCheckoutMutationGate(input.controllerHome, gate);
      },
    });
    if (renewFailed) throw renewFailed;
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
