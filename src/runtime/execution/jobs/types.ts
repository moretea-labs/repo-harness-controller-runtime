export type ExecutionJobPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
import type { ManagedResource } from '../../resources';

export type ExecutionJobType =
  | 'mcp-tool'
  | 'plugin-action'
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
  | 'waiting_for_approval'
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
  surface: 'mcp' | 'local-ui' | 'mobile-intent' | 'chatgpt-action' | 'assistant-routine' | 'cli' | 'schedule' | 'reconciliation' | 'system';
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

export interface ExecutionJobTimings {
  durablePersistedAt?: string;
  schedulerNotifiedAt?: string;
  schedulerObservedAt?: string;
  leaseCreatedAt?: string;
  workerRunningAt?: string;
}

export type ExecutionOperationMode = 'readonly' | 'mutating' | 'remote_write' | 'destructive';

export interface ExecutionOperationMetadata {
  mode: ExecutionOperationMode;
  idempotent: boolean;
  replayable: boolean;
  timeoutMs: number;
  retryPolicy: 'none' | 'safe_retry' | 'idempotent_request';
  approvalPolicy: 'none' | 'request' | 'required';
  lockScope: string[];
  resourceClaims: ResourceClaimSpec[];
}

export interface ExecutionJobOutcome {
  /** Optional semantic classification; normal check failures are acceptance failures. */
  failureClass?: 'acceptance_failure' | 'infrastructure_failure';
  acceptanceFailure?: { code: string; message: string };
  process?: { exitCode?: number | null; timedOut?: boolean; stdoutPath?: string; stderrPath?: string };
  policy?: { decision: 'allowed' | 'approval_required' | 'rejected'; repositoryChanged?: boolean; changedPaths?: string[] };
  infrastructureError?: { code: string; message: string };
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
  timings?: ExecutionJobTimings;
  operationMetadata?: ExecutionOperationMetadata;
  /** Additive ownership metadata; absent on legacy Jobs means unknown ownership. */
  resources?: ManagedResource[];
  result?: Record<string, unknown>;
  outcome?: ExecutionJobOutcome;
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
  operationMetadata?: ExecutionOperationMetadata;
  resources?: ManagedResource[];
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
  'waiting_for_integration', 'waiting_for_release_barrier', 'waiting_for_approval', 'running', 'dispatched',
]);
