import { createHash, randomUUID } from 'crypto';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { withControllerLock } from '../../../cli/repositories/locks';
import type { ResourceClaimSpec } from '../../execution/jobs/types';
import { readJsonFile, removeFile, writeJsonAtomic } from '../../shared/json-files';
import { markRepositoryProjectionDirty } from '../../projections/invalidation';
import { touchSchedulerWakeSignal } from '../../control-plane/global-scheduler/wake-signal';
import { claimsConflict } from '../claims/conflicts';
import { appendRuntimeEvent } from '../../evidence/event-ledger';
import type {
  ExecutionLease,
  LeaseAcquisitionOptions,
  LeaseAcquisitionResult,
  LeaseVisibility,
} from './types';

function leaseRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'leases');
}
function activeRoot(controllerHome: string, repoId: string): string { return join(leaseRoot(controllerHome, repoId), 'active'); }
function leasePath(controllerHome: string, repoId: string, leaseId: string): string { return join(activeRoot(controllerHome, repoId), `${leaseId}.json`); }
function counterPath(controllerHome: string, repoId: string, resourceKey: string): string {
  const hash = createHash('sha256').update(resourceKey).digest('hex');
  return join(leaseRoot(controllerHome, repoId), 'counters', `${hash}.json`);
}
function expired(lease: ExecutionLease): boolean { return Date.parse(lease.expiresAt) <= Date.now(); }

function nextFencingToken(controllerHome: string, repoId: string, resourceKey: string): number {
  const path = counterPath(controllerHome, repoId, resourceKey);
  const current = readJsonFile<{ value: number }>(path, { value: 0 });
  const value = Math.max(0, current.value) + 1;
  writeJsonAtomic(path, { value, resourceKey, updatedAt: new Date().toISOString() });
  return value;
}

function resolveSideEffects(options?: LeaseAcquisitionOptions, visibility?: LeaseVisibility): {
  visibility: LeaseVisibility;
  notifyScheduler: boolean;
  invalidateProjection: boolean;
  emitRuntimeEvent: boolean;
} {
  const vis = options?.visibility ?? visibility ?? 'durable';
  const ephemeral = vis === 'ephemeral';
  return {
    visibility: vis,
    notifyScheduler: options?.notifyScheduler ?? !ephemeral,
    invalidateProjection: options?.invalidateProjection ?? !ephemeral,
    emitRuntimeEvent: options?.emitRuntimeEvent ?? !ephemeral,
  };
}

/** Instrumentation counters for Thin Harness metrics (process-local). */
const leaseSideEffectMetrics = {
  durableAcquireEvents: 0,
  durableReleaseEvents: 0,
  projectionDirtyMarks: 0,
  schedulerWakes: 0,
  ephemeralAcquires: 0,
  ephemeralReleases: 0,
};

export function getLeaseSideEffectMetrics() {
  return { ...leaseSideEffectMetrics };
}

export function resetLeaseSideEffectMetrics(): void {
  leaseSideEffectMetrics.durableAcquireEvents = 0;
  leaseSideEffectMetrics.durableReleaseEvents = 0;
  leaseSideEffectMetrics.projectionDirtyMarks = 0;
  leaseSideEffectMetrics.schedulerWakes = 0;
  leaseSideEffectMetrics.ephemeralAcquires = 0;
  leaseSideEffectMetrics.ephemeralReleases = 0;
}

export function listActiveLeases(controllerHome: string, repoId: string): ExecutionLease[] {
  try {
    const leases: ExecutionLease[] = [];
    for (const name of readdirSync(activeRoot(controllerHome, repoId)).filter((entry) => entry.endsWith('.json')).slice(0, 5000)) {
      const path = join(activeRoot(controllerHome, repoId), name);
      try {
        const lease = readJsonFile<ExecutionLease>(path);
        if (expired(lease)) removeFile(path);
        else leases.push(lease);
      } catch { removeFile(path); }
    }
    return leases;
  } catch { return []; }
}

export function acquireExecutionLeases(
  controllerHome: string,
  repoId: string,
  ownerJobId: string,
  claims: ResourceClaimSpec[],
  ttlMsOrOptions: number | LeaseAcquisitionOptions = 30_000,
): LeaseAcquisitionResult {
  // Writer fencing: passive / fenced runtimes must not acquire leases.
  try {
    const { assertThisRuntimeMayWrite } = require('../../../cli/controller/stable-state/runtime-writer-context') as typeof import('../../../cli/controller/stable-state/runtime-writer-context');
    const fence = assertThisRuntimeMayWrite('renew_lease', controllerHome);
    if (!fence.allowed) {
      return {
        acquired: false,
        leases: [],
        blockers: [{
          resourceKey: 'writer-authority',
          ownerJobId: 'writer-fence',
          leaseId: fence.reason ?? 'writer_fenced',
          mode: 'exclusive',
        }],
      };
    }
  } catch {
    /* unbound claim + missing authority → legacy single-runtime allow */
  }

  const options: LeaseAcquisitionOptions = typeof ttlMsOrOptions === 'number'
    ? { ttlMs: ttlMsOrOptions }
    : ttlMsOrOptions;
  const ttlMs = options.ttlMs ?? 30_000;
  const effects = resolveSideEffects(options);

  return withControllerLock(controllerHome, { scope: 'repository', repoId }, `lease-acquire:${ownerJobId}`, () => {
    const active = listActiveLeases(controllerHome, repoId).filter((lease) => lease.ownerJobId !== ownerJobId);
    const blockers = claims.flatMap((claim) => active
      .filter((lease) => claimsConflict(claim, lease))
      .map((lease) => ({ resourceKey: lease.resourceKey, ownerJobId: lease.ownerJobId, leaseId: lease.leaseId, mode: lease.mode })));
    if (blockers.length > 0) return { acquired: false, leases: [], blockers };
    const timestamp = new Date().toISOString();
    const expiresAt = new Date(Date.now() + Math.max(5_000, ttlMs)).toISOString();
    const leases = claims.map((claim): ExecutionLease => ({
      schemaVersion: 1,
      leaseId: `LEASE-${Date.now()}-${randomUUID().slice(0, 8)}`,
      repoId,
      resourceKey: claim.resourceKey,
      mode: claim.mode,
      ownerJobId,
      fencingToken: nextFencingToken(controllerHome, repoId, claim.resourceKey),
      acquiredAt: timestamp,
      expiresAt,
      heartbeatAt: timestamp,
      visibility: effects.visibility,
    }));
    for (const lease of leases) {
      writeJsonAtomic(leasePath(controllerHome, repoId, lease.leaseId), lease);
      if (effects.emitRuntimeEvent) {
        appendRuntimeEvent(controllerHome, {
          repoId,
          entityType: 'lease',
          entityId: lease.leaseId,
          eventType: 'lease_acquired',
          requestId: ownerJobId,
          correlationId: ownerJobId,
          revision: lease.fencingToken,
          data: {
            resourceKey: lease.resourceKey,
            mode: lease.mode,
            expiresAt: lease.expiresAt,
            visibility: lease.visibility,
          },
        });
        leaseSideEffectMetrics.durableAcquireEvents += 1;
      } else {
        leaseSideEffectMetrics.ephemeralAcquires += 1;
      }
    }
    if (leases.length > 0) {
      if (effects.invalidateProjection) {
        markRepositoryProjectionDirty(controllerHome, repoId, `leases-acquired:${ownerJobId}`);
        leaseSideEffectMetrics.projectionDirtyMarks += 1;
      }
      if (effects.notifyScheduler) {
        touchSchedulerWakeSignal(controllerHome, `leases-acquired:${ownerJobId}`);
        leaseSideEffectMetrics.schedulerWakes += 1;
      }
    }
    return { acquired: true, leases, blockers: [] };
  }, 10_000);
}

type ExpectedLeaseRef = Pick<ExecutionLease, 'leaseId' | 'fencingToken'>;

function expectedLeaseMap(expected?: ExpectedLeaseRef[]): Map<string, number> | undefined {
  return expected ? new Map(expected.map((ref) => [ref.leaseId, ref.fencingToken])) : undefined;
}

export function renewExecutionLeases(
  controllerHome: string,
  repoId: string,
  ownerJobId: string,
  ttlMs = 30_000,
  expected?: ExpectedLeaseRef[],
): ExecutionLease[] {
  try {
    const { assertThisRuntimeMayWriteOrThrow } = require('../../../cli/controller/stable-state/runtime-writer-context') as typeof import('../../../cli/controller/stable-state/runtime-writer-context');
    assertThisRuntimeMayWriteOrThrow('renew_lease', controllerHome);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('WRITER_FENCED:')) throw error;
    /* unbound legacy */
  }
  return withControllerLock(controllerHome, { scope: 'repository', repoId }, `lease-renew:${ownerJobId}`, () => {
    const expectedTokens = expectedLeaseMap(expected);
    const timestamp = new Date().toISOString();
    const owned = listActiveLeases(controllerHome, repoId)
      .filter((lease) => lease.ownerJobId === ownerJobId)
      .filter((lease) => !expectedTokens || expectedTokens.get(lease.leaseId) === lease.fencingToken);
    if (expectedTokens && owned.length !== expectedTokens.size) {
      throw new Error(`FENCING_TOKEN_STALE: ${ownerJobId} no longer owns the expected lease set`);
    }
    return owned.map((lease) => {
      const next = { ...lease, heartbeatAt: timestamp, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
      writeJsonAtomic(leasePath(controllerHome, repoId, lease.leaseId), next);
      return next;
    });
  }, 10_000);
}

export function releaseExecutionLeases(
  controllerHome: string,
  repoId: string,
  ownerJobId: string,
  expected?: ExpectedLeaseRef[],
  options?: Pick<LeaseAcquisitionOptions, 'visibility' | 'notifyScheduler' | 'invalidateProjection' | 'emitRuntimeEvent'>,
): void {
  withControllerLock(controllerHome, { scope: 'repository', repoId }, `lease-release:${ownerJobId}`, () => {
    const expectedTokens = expectedLeaseMap(expected);
    let released = false;
    let visibility: LeaseVisibility = options?.visibility ?? 'durable';
    for (const lease of listActiveLeases(controllerHome, repoId)) {
      if (lease.ownerJobId !== ownerJobId) continue;
      if (expectedTokens && expectedTokens.get(lease.leaseId) !== lease.fencingToken) continue;
      visibility = lease.visibility ?? visibility;
      removeFile(leasePath(controllerHome, repoId, lease.leaseId));
      const effects = resolveSideEffects(options, lease.visibility);
      if (effects.emitRuntimeEvent) {
        appendRuntimeEvent(controllerHome, {
          repoId,
          entityType: 'lease',
          entityId: lease.leaseId,
          eventType: 'lease_released',
          requestId: ownerJobId,
          correlationId: ownerJobId,
          revision: lease.fencingToken,
          data: { resourceKey: lease.resourceKey, mode: lease.mode, visibility: lease.visibility },
        });
        leaseSideEffectMetrics.durableReleaseEvents += 1;
      } else {
        leaseSideEffectMetrics.ephemeralReleases += 1;
      }
      released = true;
    }
    if (released) {
      const effects = resolveSideEffects(options, visibility);
      if (effects.invalidateProjection) {
        markRepositoryProjectionDirty(controllerHome, repoId, `leases-released:${ownerJobId}`);
        leaseSideEffectMetrics.projectionDirtyMarks += 1;
      }
      if (effects.notifyScheduler) {
        touchSchedulerWakeSignal(controllerHome, `leases-released:${ownerJobId}`);
        leaseSideEffectMetrics.schedulerWakes += 1;
      }
    }
  }, 10_000);
}

export function assertFencingToken(
  controllerHome: string,
  repoId: string,
  leaseId: string,
  fencingToken: number,
): ExecutionLease {
  const path = leasePath(controllerHome, repoId, leaseId);
  if (!existsSync(path)) throw new Error(`LEASE_EXPIRED: ${leaseId}`);
  const lease = readJsonFile<ExecutionLease>(path);
  if (expired(lease)) {
    removeFile(path);
    throw new Error(`LEASE_EXPIRED: ${leaseId}`);
  }
  if (lease.fencingToken !== fencingToken) throw new Error(`FENCING_TOKEN_STALE: ${leaseId}`);
  return lease;
}
