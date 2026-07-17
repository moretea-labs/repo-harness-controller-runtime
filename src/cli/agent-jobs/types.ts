import type { ControllerAgent } from "../controller/types";
import type { TaskExecutionClass } from "../controller/execution-policy";
import type { ExecutorHealth } from "./executor-health";
import type { ManagedResource } from "../../runtime/resources";

export type AgentJobStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_user"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";
export type AgentJobClosureState =
  | "none"
  | "ready_to_integrate"
  | "integration_pending"
  | "integrating"
  | "integrated"
  | "cleanup_pending"
  | "cleaning"
  | "cleanup_blocked"
  | "preserved"
  | "completed";
export type AgentJobPreservationReason =
  | "dirty_worktree"
  | "active_worktree"
  | "protected_branch"
  | "unknown_worktree_state"
  | "unmerged_branch"
  | "main_workspace_occupied"
  | "integration_review_required"
  | "integration_failed"
  | "cleanup_failed";
export type AgentExecutionProvider = "local" | "github";
export type AgentExecutionMode = "workspace" | "worktree" | "github";
export type AgentProgressPhase =
  | "queued"
  | "starting"
  | "inspecting"
  | "editing"
  | "testing"
  | "finalizing"
  | "waiting"
  | "completed"
  | "failed";

export interface AgentJobProgress {
  phase: AgentProgressPhase;
  percent: number;
  currentActivity: string;
  lastActivityAt: string;
  activityCount: number;
}

export interface AgentJobEvent {
  at: string;
  type:
    | "run_created"
    | "run_started"
    | "run_activity"
    | "run_heartbeat"
    | "log_updated"
    | "run_waiting"
    | "run_succeeded"
    | "run_failed"
    | "run_cancelled"
    | "run_cleanup_completed"
    | "run_cleanup_failed"
    | "run_integrated"
    | "run_auto_integrated"
    | "run_worktree_cleaned"
    | "run_verified";
  message?: string;
  data?: Record<string, unknown>;
}

export interface AgentJobMeta {
  schemaVersion: 1 | 2 | 3;
  repoId?: string;
  checkoutId?: string;
  requestId?: string;
  supervisorInstructions?: string;
  runId: string;
  issueId: string;
  taskId: string;
  agent: ControllerAgent;
  provider: AgentExecutionProvider;
  executionMode: AgentExecutionMode;
  executionClass?: TaskExecutionClass;
  allowedPaths?: string[];
  status: AgentJobStatus;
  repoRoot: string;
  executionRoot?: string;
  worktree: string;
  worktreePath?: string;
  branch: string | null;
  baseRevision: string | null;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  eventsPath: string;
  controllerPid?: number;
  controllerEpoch?: string;
  controllerEpochPath?: string;
  launchPid?: number;
  workerPid?: number;
  agentPid?: number;
  exitCode?: number | null;
  error?: string;
  executorHealth?: ExecutorHealth;
  timeoutMs?: number;
  deadlineAt?: string;
  startupDeadlineAt?: string;
  lastHeartbeatAt?: string;
  progress?: AgentJobProgress;
  autoIntegrate?: boolean;
  closureState?: AgentJobClosureState;
  closureUpdatedAt?: string;
  autoIntegrationError?: string;
  worktreeCleanedAt?: string;
  cleanupBranchDeletedAt?: string;
  diffArtifactPath?: string;
  changeOutcome?: "changed" | "no_change" | "already_integrated";
  changedFiles?: string[];
  integrationReviewPath?: string;
  preservationReason?: AgentJobPreservationReason;
  preservationDetails?: string;
  terminationReason?: "timeout" | "cancelled" | "signal" | "spawn_error";
  cancellationRequestedAt?: string;
  cancellationPids?: number[];
  cleanupPending?: boolean;
  cleanupStartedAt?: string;
  cleanupFinishedAt?: string;
  cleanupError?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  integratedSessionId?: string;
  integratedAt?: string;
  timing?: { elapsedMs: number; remainingMs: number | null; overdue: boolean };
  github?: {
    owner: string;
    repo: string;
    taskId: string;
    state?: string;
    url?: string;
    pullRequestUrl?: string;
    baseRef?: string;
    model?: string;
    createPullRequest?: boolean;
    raw?: Record<string, unknown>;
  };
  /** Additive ownership metadata; legacy Run records without it are protected. */
  resources?: ManagedResource[];
}

export interface AgentJobWorkerConfig {
  metaPath: string;
  agent: Exclude<ControllerAgent, "github-copilot">;
  worktree: string;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  eventsPath: string;
  timeoutMs: number;
  autoIntegrate: boolean;
  controllerPid?: number;
  controllerEpoch?: string;
  controllerEpochPath?: string;
  parentPid?: number;
}
