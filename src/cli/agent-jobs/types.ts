import type { ControllerAgent } from '../controller/types';

export type AgentJobStatus = 'queued' | 'running' | 'waiting_for_user' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export type AgentExecutionProvider = 'local' | 'github';

export interface AgentJobEvent {
  at: string;
  type: 'run_created' | 'run_started' | 'run_heartbeat' | 'log_updated' | 'run_waiting' | 'run_succeeded' | 'run_failed' | 'run_cancelled' | 'run_integrated' | 'run_verified';
  message?: string;
  data?: Record<string, unknown>;
}

export interface AgentJobMeta {
  schemaVersion: 1 | 2;
  runId: string;
  issueId: string;
  taskId: string;
  agent: ControllerAgent;
  provider: AgentExecutionProvider;
  status: AgentJobStatus;
  repoRoot: string;
  worktree: string;
  branch: string | null;
  baseRevision: string | null;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  eventsPath: string;
  workerPid?: number;
  agentPid?: number;
  exitCode?: number | null;
  error?: string;
  timeoutMs?: number;
  deadlineAt?: string;
  lastHeartbeatAt?: string;
  terminationReason?: 'timeout' | 'cancelled' | 'signal' | 'spawn_error';
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  integratedSessionId?: string;
  integratedAt?: string;
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
  agent: Exclude<ControllerAgent, 'github-copilot'>;
  worktree: string;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  eventsPath: string;
  timeoutMs: number;
}
