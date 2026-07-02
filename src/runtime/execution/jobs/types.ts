export type ExecutionJobPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export type ExecutionJobType =
  | 'mcp-tool'
  | 'dispatch-task'
  | 'agent-run'
  | 'check'
  | 'verify-edit'
  | 'repository-command'
  | 'integration'
  | 'release-gate'
  | 'reconciliation'
  | 'scheduled-occurrence';

export type ExecutionJobStatus =
  | 'queued'
  | 'waiting_for_dependency'
  | 'waiting_for_workspace'
  | 'waiting_for_heavy_check'
  | 'waiting_for_integration'
  | 'waiting_for_release_barrier'
  | 'running'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'orphaned'
  | 'stale'
  | 'human_attention_required';

export type ResourceClaimMode = 'read' | 'write' | 'exclusive';

export interface ResourceClaimSpec {
  resourceKey: string;
  mode: ResourceClaimMode;
  quantity?: number;
}

export interface ExecutionJobOrigin {
  surface: 'mcp' | 'local-ui' | 'cli' | 'schedule' | 'reconciliation' | 'system';
  actor?: string;
  correlationId?: string;
  causationId?: string;
}

export interface ExecutionJobPayload {
  operation: string;
  arguments?: Record<string, unknown>;
  target?: 'repository-tool' | 'mcp-tool' | 'runtime' | 'workspace-agent';
  profile?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  [key: string]: unknown;
}

export interface ExecutionJobLeaseRef {
  leaseId: string;
  resourceKey: string;
  fencingToken: number;
  expiresAt: string;
}

export interface ExecutionJob {
  schemaVersion: 1;
  revision: number;
  jobId: string;
  repoId: string;
  checkoutId?: string;
  type: ExecutionJobType;
  status: ExecutionJobStatus;
  priority: ExecutionJobPriority;
  requestId: string;
  semanticKey: string;
  payload: ExecutionJobPayload;
  origin: ExecutionJobOrigin;
  resourceClaims: ResourceClaimSpec[];
  dependencies: string[];
  leaseRefs: ExecutionJobLeaseRef[];
  createdAt: string;
  updatedAt: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  heartbeatAt?: string;
  deadlineAt?: string;
  workerPid?: number;
  attempt: number;
  maxAttempts: number;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
  evidenceIds: string[];
}

export interface CreateExecutionJobInput {
  repoId: string;
  checkoutId?: string;
  type: ExecutionJobType;
  requestId: string;
  semanticKey: string;
  payload: ExecutionJobPayload;
  origin: ExecutionJobOrigin;
  priority?: ExecutionJobPriority;
  resourceClaims?: ResourceClaimSpec[];
  dependencies?: string[];
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface ExecutionJobEvent {
  schemaVersion: 1;
  eventId: string;
  eventType: string;
  repoId: string;
  entityType: 'job';
  entityId: string;
  correlationId?: string;
  causationId?: string;
  requestId: string;
  revision: number;
  occurredAt: string;
  data?: Record<string, unknown>;
}

export const TERMINAL_JOB_STATUSES = new Set<ExecutionJobStatus>([
  'succeeded', 'failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required',
]);

export const ACTIVE_JOB_STATUSES = new Set<ExecutionJobStatus>([
  'queued', 'waiting_for_dependency', 'waiting_for_workspace', 'waiting_for_heavy_check',
  'waiting_for_integration', 'waiting_for_release_barrier', 'running', 'dispatched',
]);
