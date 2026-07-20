import type { ResourceClaimMode } from '../../execution/jobs/types';

export type LeaseVisibility = 'durable' | 'ephemeral';

export interface ExecutionLease {
  schemaVersion: 1;
  leaseId: string;
  repoId: string;
  resourceKey: string;
  mode: ResourceClaimMode;
  ownerJobId: string;
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
  /** ephemeral = Fast Path ownership: active set only, no scheduler/projection noise */
  visibility?: LeaseVisibility;
}

export interface LeaseAcquisitionOptions {
  /** Default durable (existing Job path). ephemeral skips scheduler/projection/events. */
  visibility?: LeaseVisibility;
  notifyScheduler?: boolean;
  invalidateProjection?: boolean;
  emitRuntimeEvent?: boolean;
  ttlMs?: number;
}

export interface LeaseAcquisitionResult {
  acquired: boolean;
  leases: ExecutionLease[];
  blockers: Array<{ resourceKey: string; ownerJobId: string; leaseId: string; mode: ResourceClaimMode }>;
}
