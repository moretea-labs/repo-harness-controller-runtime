import type { ControllerAgent, TaskRisk } from "../controller/types";
import type { ControllerCheckSnapshot } from "../controller/check-runner";

export type LocalBridgeApproval = "auto" | "confirm" | "manual-only";
export type LocalExecutionPreference = "auto" | "workspace" | "worktree";
export type LocalBridgeJobStatus =
  | "pending_approval"
  | "approved"
  | "running"
  | "dispatched"
  | "succeeded"
  | "timed_out"
  | "orphaned"
  | "stale"
  | "failed"
  | "cancelled";

export type LocalBridgeJobAction =
  | "launch-task"
  | "quick-agent-session"
  | "run-check"
  | "verify-edit-session"
  | "repository-command";

export interface LaunchTaskPayload {
  issueId: string;
  taskId: string;
  requestId?: string;
  agent?: ControllerAgent;
  isolate?: boolean;
  executionMode?: LocalExecutionPreference;
  timeoutMs?: number;
  githubRepo?: string;
  baseRef?: string;
  model?: string;
  createPullRequest?: boolean;
  approveDestructive?: boolean;
}

export interface QuickAgentSessionPayload {
  title: string;
  objective: string;
  requestId?: string;
  summary?: string;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  checks?: string[];
  acceptanceCriteria?: string[];
  risk?: TaskRisk;
  agent?: Exclude<ControllerAgent, "github-copilot">;
  isolate?: boolean;
  executionMode?: LocalExecutionPreference;
  timeoutMs?: number;
  ephemeral?: boolean;
  approveDestructive?: boolean;
}

export interface RunCheckPayload {
  checkId: string;
  requestId?: string;
  timeoutMs?: number;
  /** Immutable definition captured when the Job is accepted. */
  checkSnapshot?: ControllerCheckSnapshot;
}

export interface VerifyEditSessionPayload {
  sessionId: string;
  revision: number;
  requestId?: string;
  checkIds?: string[];
  reviewer?: string;
  note?: string;
}

export interface RepositoryCommandPayload {
  controllerHome: string;
  repoId: string;
  checkoutId?: string;
  requestId?: string;
  command: string;
  cwd?: string;
  approvalToken?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export type LocalBridgeJobPayload =
  | LaunchTaskPayload
  | QuickAgentSessionPayload
  | RunCheckPayload
  | VerifyEditSessionPayload
  | RepositoryCommandPayload;

export interface LocalBridgeJobRequest {
  action: LocalBridgeJobAction;
  payload: LocalBridgeJobPayload;
  requestedBy?: string;
}

export interface LocalBridgeJobEvent {
  at: string;
  type:
    | "job_created"
    | "job_approved"
    | "job_started"
    | "job_dispatched"
    | "job_progress"
    | "job_succeeded"
    | "job_failed"
    | "job_cancelled"
    | "job_cleaned";
  message?: string;
  data?: Record<string, unknown>;
}

export interface LocalBridgeJobOutcome {
  process?: {
    exitCode?: number | null;
    timedOut?: boolean;
    stdoutPath?: string;
    stderrPath?: string;
  };
  policy?: {
    decision: "allowed" | "approval_required" | "rejected";
    repositoryChanged?: boolean;
    changedPaths?: string[];
  };
  infrastructureError?: { code: string; message: string };
}

export interface LocalBridgeJob {
  schemaVersion: 1;
  jobId: string;
  action: LocalBridgeJobAction;
  payload: LocalBridgeJobPayload;
  requestedBy: string;
  approval: LocalBridgeApproval;
  status: LocalBridgeJobStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  runId?: string;
  issueId?: string;
  taskId?: string;
  result?: Record<string, unknown>;
  /** Structured process/policy outcome. `error` is retained for compatibility. */
  outcome?: LocalBridgeJobOutcome;
  error?: string;
  revision?: string;
  ownerPid?: number;
  workerPid?: number;
  deadlineAt?: string;
  heartbeatAt?: string;
  ephemeral?: boolean;
  cleanupAt?: string;
}

export interface LocalBridgeConfig {
  version: 1;
  host?: string;
  port?: number;
  autoOpen?: boolean;
  approvals?: Partial<Record<LocalBridgeJobAction, LocalBridgeApproval>>;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
}
