/**
 * Checkout Mutation Ownership backed by the shared Execution Lease arbiter.
 *
 * Fast Path uses visibility=ephemeral (active set + fencing only; no projection
 * dirty / scheduler wake / runtime events). Durable workers use default durable
 * leases. Both contend on the same claim set with expanded path/git-ref overlap.
 *
 * Ownership lifecycle is covered by the mutation lease alone — do NOT hold the
 * repository controller lock for the duration of the write (renew needs that lock).
 *
 * Claims cover: workspace, git-index, git-head, and optionally git-ref + paths.
 */
import { createHash } from 'crypto';
import {
  acquireExecutionLeases,
  assertFencingToken,
  releaseExecutionLeases,
  renewExecutionLeases,
} from '../../resources/leases/store';
import type { ExecutionLease } from '../../resources/leases/types';
import type { ResourceClaimSpec } from '../../execution/jobs/types';
import { runBoundedGit } from './async-process';
import { terminateProcessTree } from '../../shared/process-tree';

export interface CheckoutMutationGate {
  gateId: string;
  owner: string;
  ownerJobId: string;
  repoId: string;
  checkoutId: string;
  resourceKey: string;
  resourceKeys: string[];
  leaseIds: string[];
  primaryLeaseId: string;
  leaseId: string;
  fencingToken: number;
  fencingTokens: Record<string, number>;
  baseHead: string | null;
  baseStatusHash: string | null;
  acquiredAt: string;
  expiresAt: string;
  ttlMs: number;
  renewCount: number;
  claims: ResourceClaimSpec[];
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
  /** Register a child pid for ownership-loss process-tree kill. */
  trackChildPid: (pid: number) => void;
  /** True when ownership abort fired. */
  ownershipLost: () => boolean;
}

export interface MutationOwnershipOptions {
  /** Paths that will be written (path:<checkout>:<rel> claims). */
  writePaths?: string[];
  /** When true, also claim git-ref (commit / branch mutation). */
  mutatesGitRefs?: boolean;
  /** When true (default for workspace writes), claim git-index + git-head. */
  mutatesGitIndex?: boolean;
}

const DEFAULT_TTL_MS = 30_000;
const MIN_TTL_MS = 3_000;
const MAX_TTL_MS = 120_000;

const EPHEMERAL_OPTS = {
  visibility: 'ephemeral' as const,
  notifyScheduler: false,
  invalidateProjection: false,
  emitRuntimeEvent: false,
};

export function checkoutMutationResourceKey(checkoutId: string): string {
  return `workspace:${checkoutId}`;
}

export function buildMutationClaims(
  checkoutId: string,
  options: MutationOwnershipOptions = {},
): ResourceClaimSpec[] {
  const claims: ResourceClaimSpec[] = [
    { resourceKey: `workspace:${checkoutId}`, mode: 'write' },
  ];
  const mutatesIndex = options.mutatesGitIndex !== false;
  if (mutatesIndex) {
    claims.push({ resourceKey: `git-index:${checkoutId}`, mode: 'write' });
    claims.push({ resourceKey: `git-head:${checkoutId}`, mode: 'write' });
  }
  if (options.mutatesGitRefs) {
    claims.push({ resourceKey: `git-ref:HEAD`, mode: 'write' });
    claims.push({ resourceKey: `git-ref:refs/heads/*`, mode: 'write' });
  }
  for (const path of options.writePaths ?? []) {
    const relative = path.replace(/^\.\//, '').replace(/\\/g, '/');
    if (!relative) continue;
    claims.push({ resourceKey: `path:${checkoutId}:${relative}`, mode: 'write' });
  }
  // Dedupe by resourceKey, prefer exclusive/write
  const map = new Map<string, ResourceClaimSpec>();
  for (const claim of claims) {
    map.set(claim.resourceKey, claim);
  }
  return [...map.values()];
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
  const head = headResult.ok ? (headResult.stdout.trim() || null) : null;
  return {
    head,
    statusHash: createHash('sha256').update(statusResult.stdout).digest('hex'),
  };
}

function gateFromLeases(
  ownerJobId: string,
  repoId: string,
  checkoutId: string,
  claims: ResourceClaimSpec[],
  leases: ExecutionLease[],
  snap: { head: string | null; statusHash: string | null },
  ttlMs: number,
): CheckoutMutationGate {
  const primary = leases.find((lease) => lease.resourceKey === `workspace:${checkoutId}`) ?? leases[0]!;
  const fencingTokens: Record<string, number> = {};
  for (const lease of leases) {
    fencingTokens[lease.leaseId] = lease.fencingToken;
  }
  return {
    gateId: ownerJobId,
    owner: ownerJobId,
    ownerJobId,
    repoId,
    checkoutId,
    resourceKey: primary.resourceKey,
    resourceKeys: leases.map((lease) => lease.resourceKey),
    leaseIds: leases.map((lease) => lease.leaseId),
    primaryLeaseId: primary.leaseId,
    leaseId: primary.leaseId,
    fencingToken: primary.fencingToken,
    fencingTokens,
    baseHead: snap.head,
    baseStatusHash: snap.statusHash,
    acquiredAt: primary.acquiredAt,
    expiresAt: primary.expiresAt,
    ttlMs,
    renewCount: 0,
    claims,
  };
}

/**
 * Acquire exclusive checkout mutation ownership via ephemeral Execution Lease(s).
 * Snapshot is taken AFTER lease acquisition under ownership.
 */
export async function acquireCheckoutMutationGate(input: {
  controllerHome: string;
  repoId: string;
  checkoutId: string;
  repoRoot: string;
  owner: string;
  ttlMs?: number;
  ownership?: MutationOwnershipOptions;
}): Promise<MutationGateAcquireResult> {
  const ttlMs = Math.max(MIN_TTL_MS, Math.min(input.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS));
  const claims = buildMutationClaims(input.checkoutId, input.ownership);
  const ownerJobId = input.owner.startsWith('fast:') || input.owner.startsWith('JOB-')
    ? input.owner
    : `fast:${input.owner}`;

  const result = acquireExecutionLeases(
    input.controllerHome,
    input.repoId,
    ownerJobId,
    claims,
    {
      ...EPHEMERAL_OPTS,
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

  let snap: { head: string | null; statusHash: string | null };
  try {
    snap = await snapshotHash(input.repoRoot);
  } catch (error) {
    releaseExecutionLeases(
      input.controllerHome,
      input.repoId,
      ownerJobId,
      result.leases.map((lease) => ({ leaseId: lease.leaseId, fencingToken: lease.fencingToken })),
      EPHEMERAL_OPTS,
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
    gate: gateFromLeases(ownerJobId, input.repoId, input.checkoutId, claims, result.leases, snap, ttlMs),
  };
}

export function renewCheckoutMutationGate(
  controllerHome: string,
  gate: CheckoutMutationGate,
  ttlMs?: number,
): CheckoutMutationGate {
  const nextTtl = Math.max(MIN_TTL_MS, Math.min(ttlMs ?? gate.ttlMs, MAX_TTL_MS));
  const expected = gate.leaseIds.map((leaseId) => ({
    leaseId,
    fencingToken: gate.fencingTokens[leaseId] ?? gate.fencingToken,
  }));
  const renewed = renewExecutionLeases(
    controllerHome,
    gate.repoId,
    gate.ownerJobId,
    nextTtl,
    expected,
  );
  if (renewed.length === 0) {
    throw new Error(`MUTATION_RENEW_FAILED: no leases renewed for ${gate.ownerJobId}`);
  }
  const fencingTokens: Record<string, number> = { ...gate.fencingTokens };
  let expiresAt = gate.expiresAt;
  let fencingToken = gate.fencingToken;
  for (const lease of renewed) {
    fencingTokens[lease.leaseId] = lease.fencingToken;
    expiresAt = lease.expiresAt;
    if (lease.leaseId === gate.primaryLeaseId || lease.resourceKey === gate.resourceKey) {
      fencingToken = lease.fencingToken;
    }
  }
  return {
    ...gate,
    expiresAt,
    fencingToken,
    fencingTokens,
    ttlMs: nextTtl,
    renewCount: gate.renewCount + 1,
  };
}

export function assertCheckoutMutationGate(
  controllerHome: string,
  gate: CheckoutMutationGate,
): ExecutionLease {
  let primary: ExecutionLease | undefined;
  for (const leaseId of gate.leaseIds) {
    const token = gate.fencingTokens[leaseId] ?? gate.fencingToken;
    const lease = assertFencingToken(controllerHome, gate.repoId, leaseId, token);
    if (leaseId === gate.primaryLeaseId) primary = lease;
  }
  if (!primary) {
    primary = assertFencingToken(controllerHome, gate.repoId, gate.leaseId, gate.fencingToken);
  }
  return primary;
}

export function releaseCheckoutMutationGate(
  controllerHome: string,
  repoId: string,
  _checkoutId: string,
  gateIdOrOwner?: string,
  fencing?: { leaseId: string; fencingToken: number } | Array<{ leaseId: string; fencingToken: number }>,
): void {
  if (!gateIdOrOwner) return;
  const expected = fencing
    ? (Array.isArray(fencing) ? fencing : [fencing])
    : undefined;
  releaseExecutionLeases(
    controllerHome,
    repoId,
    gateIdOrOwner,
    expected,
    EPHEMERAL_OPTS,
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
    gate.leaseIds.map((leaseId) => ({
      leaseId,
      fencingToken: gate.fencingTokens[leaseId] ?? gate.fencingToken,
    })),
    EPHEMERAL_OPTS,
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

export interface WithMutationGateResult<T> {
  ok: true;
  value: T;
  gate: CheckoutMutationGate;
  /** When kill of tracked children could not be confirmed. */
  processStopUnconfirmed?: boolean;
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
    ownership?: MutationOwnershipOptions;
  },
  operation: (gate: CheckoutMutationGate, helpers: MutationGateHelpers) => Promise<T>,
): Promise<WithMutationGateResult<T> | { ok: false; busy: MutationGateBusy }> {
  const acquired = await acquireCheckoutMutationGate(input);
  if (!('acquired' in acquired) || !acquired.acquired) {
    return { ok: false, busy: acquired as MutationGateBusy };
  }

  let gate = acquired.gate;
  const ownershipAbort = new AbortController();
  const combined = combineAbortSignals([input.signal, ownershipAbort.signal]);
  let renewFailed: Error | undefined;
  const trackedPids = new Set<number>();
  let processStopUnconfirmed = false;
  const renewIntervalMs = Math.max(500, Math.floor(gate.ttlMs / 3));

  const killTracked = async () => {
    for (const pid of trackedPids) {
      try {
        const result = await terminateProcessTree(pid, {
          gracePeriodMs: 200,
          killAfterMs: 1_500,
          pollIntervalMs: 50,
        });
        if (!result.exited || result.remainingPids.length > 0) {
          processStopUnconfirmed = true;
        }
      } catch {
        processStopUnconfirmed = true;
      }
    }
  };

  const failOwnership = (error: unknown) => {
    if (renewFailed) return;
    renewFailed = error instanceof Error ? error : new Error(String(error));
    try {
      ownershipAbort.abort(renewFailed);
    } catch {
      /* already aborted */
    }
    void killTracked();
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
    trackChildPid: (pid: number) => {
      if (pid > 0) trackedPids.add(pid);
    },
    ownershipLost: () => Boolean(renewFailed) || ownershipAbort.signal.aborted,
  };

  try {
    const value = await operation(gate, helpers);
    if (renewFailed) throw renewFailed;
    assertCheckoutMutationGate(input.controllerHome, gate);
    return { ok: true, value, gate, processStopUnconfirmed: processStopUnconfirmed || undefined };
  } catch (error) {
    if (ownershipAbort.signal.aborted) {
      await killTracked();
    }
    throw error;
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

/**
 * Build unknown-outcome payload when process stop cannot be confirmed after ownership loss.
 */
export function unknownOwnershipOutcome(input: {
  repositoryChanged?: boolean;
}): {
  outcome: 'unknown';
  repositoryChanged: true;
  reconciliationRequired: true;
} {
  return {
    outcome: 'unknown',
    repositoryChanged: true,
    reconciliationRequired: true,
    ...(input.repositoryChanged === false ? {} : {}),
  };
}
