import type { ControllerAgent, TaskRisk } from '../controller/types';

export type LocalBridgeApproval = 'auto' | 'confirm' | 'manual-only';
export type LocalBridgeJobStatus =
  | 'pending_approval'
  | 'approved'
  | 'running'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type LocalBridgeJobAction = 'launch-task' | 'quick-agent-session' | 'run-check';

export interface LaunchTaskPayload {
  issueId: string;
  taskId: string;
  agent?: ControllerAgent;
  isolate?: boolean;
  timeoutMs?: number;
  githubRepo?: string;
  baseRef?: string;
  model?: string;
  createPullRequest?: boolean;
}

export interface QuickAgentSessionPayload {
  title: string;
  objective: string;
  summary?: string;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  checks?: string[];
  acceptanceCriteria?: string[];
  risk?: TaskRisk;
  agent?: Exclude<ControllerAgent, 'github-copilot'>;
  isolate?: boolean;
  timeoutMs?: number;
}

export interface RunCheckPayload {
  checkId: string;
  timeoutMs?: number;
}

export type LocalBridgeJobPayload = LaunchTaskPayload | QuickAgentSessionPayload | RunCheckPayload;

export interface LocalBridgeJobRequest {
  action: LocalBridgeJobAction;
  payload: LocalBridgeJobPayload;
  requestedBy?: string;
  approval?: LocalBridgeApproval;
}

export interface LocalBridgeJobEvent {
  at: string;
  type: 'job_created' | 'job_approved' | 'job_started' | 'job_dispatched' | 'job_succeeded' | 'job_failed' | 'job_cancelled';
  message?: string;
  data?: Record<string, unknown>;
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
  error?: string;
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
