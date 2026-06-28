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
import type { ExecutionLease, LeaseAcquisitionResult } from './types';

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
  ttlMs = 30_000,
): LeaseAcquisitionResult {
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
    }));
    for (const lease of leases) {
      writeJsonAtomic(leasePath(controllerHome, repoId, lease.leaseId), lease);
      appendRuntimeEvent(controllerHome, {
        repoId,
        entityType: 'lease',
        entityId: lease.leaseId,
        eventType: 'lease_acquired',
        requestId: ownerJobId,
        correlationId: ownerJobId,
        revision: lease.fencingToken,
        data: { resourceKey: lease.resourceKey, mode: lease.mode, expiresAt: lease.expiresAt },
      });
    }
    if (leases.length > 0) {
      markRepositoryProjectionDirty(controllerHome, repoId, `leases-acquired:${ownerJobId}`);
      touchSchedulerWakeSignal(controllerHome, `leases-acquired:${ownerJobId}`);
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
): void {
  withControllerLock(controllerHome, { scope: 'repository', repoId }, `lease-release:${ownerJobId}`, () => {
    const expectedTokens = expectedLeaseMap(expected);
    let released = false;
    for (const lease of listActiveLeases(controllerHome, repoId)) {
      if (lease.ownerJobId !== ownerJobId) continue;
      if (expectedTokens && expectedTokens.get(lease.leaseId) !== lease.fencingToken) continue;
      removeFile(leasePath(controllerHome, repoId, lease.leaseId));
      appendRuntimeEvent(controllerHome, {
        repoId,
        entityType: 'lease',
        entityId: lease.leaseId,
        eventType: 'lease_released',
        requestId: ownerJobId,
        correlationId: ownerJobId,
        revision: lease.fencingToken,
        data: { resourceKey: lease.resourceKey, mode: lease.mode },
      });
      released = true;
    }
    if (released) {
      markRepositoryProjectionDirty(controllerHome, repoId, `leases-released:${ownerJobId}`);
      touchSchedulerWakeSignal(controllerHome, `leases-released:${ownerJobId}`);
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
