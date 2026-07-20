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
export type FastOutcome = 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'escalated' | 'rejected' | 'busy';
export type ReceiptMode = 'none' | 'standalone';

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
  | 'patch_proposal_validate';

/** Typed workspace effects used for mutation ownership and lane eligibility. */
export interface ExecutionEffects {
  readsWorkspace: boolean;
  mutatesWorkspace: boolean;
  mutatesGitRefs: boolean;
  remoteWrite: boolean;
}

export const READONLY_EFFECTS: ExecutionEffects = {
  readsWorkspace: true,
  mutatesWorkspace: false,
  mutatesGitRefs: false,
  remoteWrite: false,
};

export const WORKSPACE_WRITE_EFFECTS: ExecutionEffects = {
  readsWorkspace: true,
  mutatesWorkspace: true,
  mutatesGitRefs: false,
  remoteWrite: false,
};

export interface ExecutionDecision {
  mode: ExecutionMode;
  reasons: string[];
  risk: ExecutionRisk;
  estimatedClass: EstimatedClass;
  requiresIsolation: boolean;
  requiresRecovery: boolean;
  effects: ExecutionEffects;
  /** Present when mode is durable — caller must open a new durable request. */
  suggestedOperation?: string;
  /** Present when mode is reject. */
  rejectCode?: string;
}

/** Fast-path local timing segments (not full Gateway pipeline fiction). */
export interface LatencyBreakdown {
  routingMs: number;
  policyMs: number;
  snapshotMs: number;
  executionMs: number;
  receiptMs: number;
  totalMs: number;
  path?: 'fast' | 'durable' | 'mixed' | 'reject';
  /** @deprecated aliases for older field names; prefer routing/policy/execution. */
  gatewayValidationMs?: number;
  authorizationMs?: number;
  resourceClaimMs?: number;
  jobPersistenceMs?: number;
  schedulerWaitMs?: number;
  workerStartupMs?: number;
  repositorySnapshotMs?: number;
  operationExecutionMs?: number;
  evidencePersistenceMs?: number;
  projectionUpdateMs?: number;
  responseSerializationMs?: number;
}

export const EMPTY_LATENCY: LatencyBreakdown = {
  routingMs: 0,
  policyMs: 0,
  snapshotMs: 0,
  executionMs: 0,
  receiptMs: 0,
  totalMs: 0,
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
  latency?: LatencyBreakdown;
  stepCount?: number;
  laneCount?: number;
  reasons?: string[];
  requestId?: string;
  fencingToken?: number;
  baseHead?: string | null;
  inputHash?: string;
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
  input: Record<string, unknown>;
}

export interface RepositoryBatchRequest {
  repoId: string;
  checkoutId?: string;
  mode?: 'auto' | 'fast' | 'durable';
  steps: RepositoryBatchStep[];
  stopOnError?: boolean;
  includeLatencyBreakdown?: boolean;
  timeoutMs?: number;
  allowedPaths?: string[];
  purpose?: string;
  requestId?: string;
  signal?: AbortSignal;
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
  mode: 'fast' | 'durable' | 'reject' | 'busy';
  decision: ExecutionDecision;
  receipt?: FastExecutionReceipt;
  receiptPersisted?: boolean;
  receiptWarning?: string;
  steps: RepositoryBatchStepResult[];
  stoppedEarly: boolean;
  partialFailure: boolean;
  nonAtomic?: boolean;
  latency: LatencyBreakdown;
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

/** Validates caller-supplied patch proposals for path conflicts (not an Agent analyzer). */
export interface PatchProposalValidateRequest {
  id?: string;
  readPaths: string[];
  writePaths: string[];
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
  /** @deprecated use patchProposalValidations */
  patchProposalLanes?: PatchProposalValidateRequest[];
  patchProposalValidations?: PatchProposalValidateRequest[];
  failFast?: boolean;
  includeLatencyBreakdown?: boolean;
  maxConcurrency?: number;
  signal?: AbortSignal;
}

export interface ReadLaneResult {
  id: string;
  ok: boolean;
  durationMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  summary?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface PatchProposalValidateResult {
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
  proposalId?: string;
  baseRevision?: string | null;
  proposalDigest?: string;
  operationsDigest?: string;
  checkoutId?: string;
}

export interface LightweightLanesResult {
  ok: boolean;
  receipt?: FastExecutionReceipt;
  receiptPersisted?: boolean;
  readLanes: ReadLaneResult[];
  patchProposals: PatchProposalValidateResult[];
  conflicts: LaneConflict[];
  latency: LatencyBreakdown;
  appliedByIntegrator: false;
  createdIssue: false;
  createdCampaign: false;
  createdWorktree: false;
  concurrent: boolean;
}

/** Caps shared by Fast Path. */
export const FAST_PATH_MAX_TIMEOUT_MS = 15_000;
export const FAST_PATH_DEFAULT_TIMEOUT_MS = 10_000;
/** Hard budget for an entire write batch (not per-step). */
export const FAST_BATCH_MAX_TOTAL_MS = 45_000;
export const FAST_PATH_MAX_OUTPUT_BYTES = 128 * 1024;
export const FAST_PATH_MAX_FILE_BYTES = 256 * 1024;
export const FAST_BATCH_MAX_STEPS = 20;
export const FAST_LANE_MAX_CONCURRENCY = 4;
export const FAST_RECEIPT_RETENTION = 200;
export const FAST_RECEIPT_MAX_SUMMARY_BYTES = 4_096;
