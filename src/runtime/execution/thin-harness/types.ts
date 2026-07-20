/**
 * Thin Harness V1 — shared types for Fast Path routing, receipts, batch, and lanes.
 * Durable Work (ExecutionJob / Scheduler / Worker) remains the escalation path.
 */

export type ExecutionMode = 'fast' | 'durable' | 'reject';
export type ExecutionRisk =
  | 'readonly'
  | 'workspace_write'
  | 'remote_write'
  | 'destructive'
  | 'unknown';
export type EstimatedClass = 'short' | 'long' | 'unknown';
export type FastOutcome = 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'escalated' | 'rejected';

export type FastOperationKind =
  | 'read_file'
  | 'search'
  | 'git_status'
  | 'git_diff'
  | 'apply_patch'
  | 'run_short_command'
  | 'run_focused_check'
  | 'stage_paths'
  | 'commit_paths'
  | 'batch'
  | 'read_lanes'
  | 'patch_proposal_lanes';

export interface ExecutionDecision {
  mode: ExecutionMode;
  reasons: string[];
  risk: ExecutionRisk;
  estimatedClass: EstimatedClass;
  requiresIsolation: boolean;
  requiresRecovery: boolean;
  /** Present when mode is durable — caller must open a new durable request. */
  suggestedOperation?: string;
  /** Present when mode is reject. */
  rejectCode?: string;
}

/** Latency breakdown segments for eligible operations. Sensitive args are never recorded. */
export interface LatencyBreakdown {
  gatewayValidationMs: number;
  authorizationMs: number;
  resourceClaimMs: number;
  jobPersistenceMs: number;
  schedulerWaitMs: number;
  workerStartupMs: number;
  repositorySnapshotMs: number;
  operationExecutionMs: number;
  evidencePersistenceMs: number;
  projectionUpdateMs: number;
  responseSerializationMs: number;
  totalMs: number;
  /** Path label: fast | durable | mixed */
  path?: 'fast' | 'durable' | 'mixed' | 'reject';
}

export const EMPTY_LATENCY: LatencyBreakdown = {
  gatewayValidationMs: 0,
  authorizationMs: 0,
  resourceClaimMs: 0,
  jobPersistenceMs: 0,
  schedulerWaitMs: 0,
  workerStartupMs: 0,
  repositorySnapshotMs: 0,
  operationExecutionMs: 0,
  evidencePersistenceMs: 0,
  projectionUpdateMs: 0,
  responseSerializationMs: 0,
  totalMs: 0,
};

export interface FastExecutionReceipt {
  schemaVersion: 1;
  executionId: string;
  repoId: string;
  checkoutId: string;
  mode: 'fast';
  operation: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: FastOutcome;
  changedPaths: string[];
  repositoryChanged: boolean;
  authorizationDecision: string;
  policyDecision: string;
  outputSummary?: string;
  artifactRefs?: string[];
  /** Optional detailed timing; omitted unless debug/benchmark requested. */
  latency?: LatencyBreakdown;
  stepCount?: number;
  laneCount?: number;
  reasons?: string[];
}

export type RepositoryBatchStepKind =
  | 'read_file'
  | 'search'
  | 'git_status'
  | 'git_diff'
  | 'apply_patch'
  | 'run_short_command'
  | 'run_focused_check'
  | 'stage_paths'
  | 'commit_paths';

export interface RepositoryBatchStep {
  id?: string;
  kind: RepositoryBatchStepKind;
  /** Step-specific typed payload — never free-form shell workflows. */
  input: Record<string, unknown>;
}

export interface RepositoryBatchRequest {
  repoId: string;
  checkoutId?: string;
  mode?: 'auto' | 'fast' | 'durable';
  steps: RepositoryBatchStep[];
  stopOnError?: boolean;
  /** When true, attach full latency breakdown on the receipt. */
  includeLatencyBreakdown?: boolean;
  timeoutMs?: number;
  allowedPaths?: string[];
  purpose?: string;
}

export interface RepositoryBatchStepResult {
  id: string;
  kind: RepositoryBatchStepKind;
  ok: boolean;
  outcome: FastOutcome;
  durationMs: number;
  summary?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  changedPaths?: string[];
}

export interface RepositoryBatchResult {
  ok: boolean;
  mode: 'fast' | 'durable' | 'reject';
  decision: ExecutionDecision;
  receipt?: FastExecutionReceipt;
  steps: RepositoryBatchStepResult[];
  stoppedEarly: boolean;
  partialFailure: boolean;
  latency: LatencyBreakdown;
  /** Present when mixed/durable mode requires explicit escalation. */
  escalation?: {
    reason: string;
    suggestedOperation: string;
  };
  resultRef?: string;
}

export interface ReadLaneRequest {
  id?: string;
  kind: 'search' | 'read_file' | 'git_status' | 'git_diff' | 'run_short_command';
  input: Record<string, unknown>;
}

export interface PatchProposalLaneRequest {
  id?: string;
  readPaths: string[];
  writePaths: string[];
  /** Proposed operations in apply_patch shape; never applied by the lane itself. */
  proposedOperations: unknown[];
  assumptions?: string[];
  riskNotes?: string[];
  suggestedFocusedCheck?: string | string[];
}

export interface LaneConflict {
  type: 'write_write' | 'write_read' | 'project_file' | 'schema_file';
  laneIds: string[];
  paths: string[];
  message: string;
}

export interface LightweightLanesRequest {
  repoId: string;
  checkoutId?: string;
  readLanes?: ReadLaneRequest[];
  patchProposalLanes?: PatchProposalLaneRequest[];
  failFast?: boolean;
  includeLatencyBreakdown?: boolean;
  maxConcurrency?: number;
}

export interface ReadLaneResult {
  id: string;
  ok: boolean;
  durationMs: number;
  summary?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface PatchProposalLaneResult {
  id: string;
  ok: boolean;
  durationMs: number;
  readPaths: string[];
  writePaths: string[];
  proposedOperations: unknown[];
  assumptions?: string[];
  riskNotes?: string[];
  suggestedFocusedCheck?: string | string[];
  analysisOnly?: boolean;
  conflicts?: LaneConflict[];
  summary?: string;
  error?: { code: string; message: string };
}

export interface LightweightLanesResult {
  ok: boolean;
  receipt?: FastExecutionReceipt;
  readLanes: ReadLaneResult[];
  patchProposals: PatchProposalLaneResult[];
  conflicts: LaneConflict[];
  latency: LatencyBreakdown;
  appliedByIntegrator: false;
  createdIssue: false;
  createdCampaign: false;
  createdWorktree: false;
}

/** Caps shared by Fast Path. */
export const FAST_PATH_MAX_TIMEOUT_MS = 30_000;
export const FAST_PATH_DEFAULT_TIMEOUT_MS = 15_000;
export const FAST_PATH_MAX_OUTPUT_BYTES = 128 * 1024;
export const FAST_BATCH_MAX_STEPS = 20;
export const FAST_LANE_MAX_CONCURRENCY = 4;
export const FAST_RECEIPT_RETENTION = 200;
export const FAST_RECEIPT_MAX_SUMMARY_BYTES = 4_096;
