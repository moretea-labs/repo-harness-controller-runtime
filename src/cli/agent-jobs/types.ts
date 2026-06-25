import type { ControllerAgent } from "../controller/types";
import type { TaskExecutionClass } from "../controller/execution-policy";

export type AgentJobStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_user"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";
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
  launchPid?: number;
  workerPid?: number;
  agentPid?: number;
  exitCode?: number | null;
  error?: string;
  timeoutMs?: number;
  deadlineAt?: string;
  startupDeadlineAt?: string;
  lastHeartbeatAt?: string;
  progress?: AgentJobProgress;
  autoIntegrate?: boolean;
  autoIntegrationError?: string;
  worktreeCleanedAt?: string;
  diffArtifactPath?: string;
  terminationReason?: "timeout" | "cancelled" | "signal" | "spawn_error";
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
}
