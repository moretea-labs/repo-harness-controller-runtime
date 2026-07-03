import type { ExecutionJobPriority, ResourceClaimSpec } from '../../execution/jobs/types';

export type CampaignStatus =
  | 'active'
  | 'waiting_for_supervisor'
  | 'paused'
  | 'ready_for_human_acceptance'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'cancelled_with_leaks';

export type CampaignTaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'waiting_review'
  | 'changes_requested'
  | 'succeeded'
  | 'succeeded_no_change'
  | 'failed'
  | 'failed_no_effect'
  | 'blocked'
  | 'skipped'
  | 'cancelled';

export type CampaignCheckpointKind = 'initial' | 'task_review' | 'failure' | 'scope_change' | 'final';
export type CampaignCheckpointStatus = 'open' | 'submitted' | 'superseded';
export type CampaignReviewPolicy = 'every_task' | 'failures_and_final' | 'final_only';

export interface CampaignWorkspace {
  mode: 'current' | 'isolated';
  checkoutId?: string;
  root?: string;
  branch?: string | null;
  baseRevision?: string | null;
  managed: boolean;
}

export interface CampaignGoalRevision {
  revision: number;
  goalHash: string;
  statement: string;
  acceptanceCriteria: string[];
  nonGoals: string[];
  changedBy: string;
  changedAt: string;
  reason?: string;
}

export interface CampaignExecutorOptions {
  enableDevRunner?: boolean;
  enableChatgptBrowser?: boolean;
  allowedAgents?: string[];
  runnerTimeoutMs?: number;
  runnerMaxTimeoutMs?: number;
}

export interface CampaignTask {
  taskId: string;
  title: string;
  objective: string;
  operation: string;
  arguments?: Record<string, unknown>;
  dependsOn: string[];
  priority: ExecutionJobPriority;
  resourceClaims: ResourceClaimSpec[];
  reviewRequired: boolean;
  requiresChanges: boolean;
  maxAttempts: number;
  status: CampaignTaskStatus;
  attempt: number;
  jobId?: string;
  runId?: string;
  checkpointId?: string;
  nextAttemptAt?: string;
  startedAt?: string;
  executionFinishedAt?: string;
  completedAt?: string;
  supervisorInstructions?: string;
  error?: { code: string; message: string; retryable: boolean };
  evidenceIds: string[];
  outcome?: 'changed' | 'already_satisfied' | 'no_effect';
  executor?: CampaignExecutorOptions;
}

export interface CampaignReviewPacketTask {
  taskId: string;
  title: string;
  objective: string;
  status: CampaignTaskStatus;
  attempt: number;
  operation: string;
  jobId?: string;
  runId?: string;
  error?: CampaignTask['error'];
  evidenceIds: string[];
}

export interface CampaignReviewPacket {
  schemaVersion: 1;
  campaignId: string;
  checkpointId: string;
  checkpointKind: CampaignCheckpointKind;
  nonce: string;
  goalRevision: number;
  goalHash: string;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  nonGoals: string[];
  task?: CampaignReviewPacketTask;
  progress: {
    total: number;
    succeeded: number;
    running: number;
    waitingReview: number;
    failed: number;
    blocked: number;
  };
  recentEvidenceIds: string[];
  createdAt: string;
  maxResponseBytes: number;
  workspace?: Pick<CampaignWorkspace, 'mode' | 'checkoutId' | 'branch' | 'baseRevision' | 'managed'>;
}

export type CampaignSupervisorAction =
  | 'accept'
  | 'request_changes'
  | 'retry'
  | 'skip'
  | 'pause'
  | 'resume'
  | 'approve_final'
  | 'revise_goal'
  | 'escalate';

export interface CampaignSupervisorDecision {
  action: CampaignSupervisorAction;
  summary: string;
  instructions?: string;
  revisedGoal?: {
    statement: string;
    acceptanceCriteria?: string[];
    nonGoals?: string[];
    reason?: string;
  };
  submittedBy: string;
  submittedAt: string;
}

export interface CampaignCheckpoint {
  checkpointId: string;
  kind: CampaignCheckpointKind;
  status: CampaignCheckpointStatus;
  nonce: string;
  goalRevision: number;
  taskId?: string;
  packet: CampaignReviewPacket;
  decision?: CampaignSupervisorDecision;
  triggerJobId?: string;
  triggerAttempts: number;
  nextTriggerAt?: string;
  triggeredAt?: string;
  triggerError?: string;
  createdAt: string;
  submittedAt?: string;
}

export interface CampaignBudget {
  maxParallelTasks: number;
  maxExecutionJobs: number;
  maxSupervisorReviews: number;
  defaultTaskMaxAttempts: number;
  taskTimeoutMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  reviewPacketMaxBytes: number;
}

export interface CampaignSupervisorConfig {
  mode: 'pull' | 'operation' | 'workspace_agent';
  operation?: string;
  workspaceAgentId?: string;
  conversationKey?: string;
  arguments?: Record<string, unknown>;
  priority?: ExecutionJobPriority;
  resourceClaims?: ResourceClaimSpec[];
  triggerCooldownMs: number;
  maxTriggerAttempts: number;
  decisionTimeoutMs: number;
}

export interface CampaignMutationReceipt {
  requestId: string;
  fingerprint: string;
  revision: number;
  appliedAt: string;
}

export interface CampaignCounters {
  executionJobsCreated: number;
  supervisorReviewsOpened: number;
  supervisorDecisionsAccepted: number;
}

export interface CampaignCleanupResource {
  kind: 'job' | 'checkpoint' | 'worktree' | 'branch' | 'lease' | 'process';
  id: string;
  status: 'cleaned' | 'preserved' | 'missing' | 'failed';
  message?: string;
}

export interface CampaignCleanupReport {
  schemaVersion: 1;
  startedAt: string;
  finishedAt?: string;
  resources: CampaignCleanupResource[];
  leaks: string[];
}

export interface Campaign {
  schemaVersion: 1;
  revision: number;
  campaignId: string;
  repoId: string;
  checkoutId?: string;
  workspace: CampaignWorkspace;
  requestId: string;
  semanticKey: string;
  title: string;
  status: CampaignStatus;
  goals: CampaignGoalRevision[];
  tasks: CampaignTask[];
  checkpoints: CampaignCheckpoint[];
  budget: CampaignBudget;
  supervisor: CampaignSupervisorConfig;
  reviewPolicy: CampaignReviewPolicy;
  counters: CampaignCounters;
  mutationReceipts?: CampaignMutationReceipt[];
  pauseReason?: string;
  failureReason?: string;
  nextReconcileAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  completionOutcome?: 'changed' | 'already_satisfied';
  cleanup?: CampaignCleanupReport;
}

export interface CreateCampaignTaskInput {
  taskId: string;
  title: string;
  objective?: string;
  operation: string;
  arguments?: Record<string, unknown>;
  dependsOn?: string[];
  priority?: ExecutionJobPriority;
  resourceClaims?: ResourceClaimSpec[];
  reviewRequired?: boolean;
  requiresChanges?: boolean;
  maxAttempts?: number;
  executor?: CampaignExecutorOptions;
}

export interface CreateCampaignInput {
  repoId: string;
  checkoutId?: string;
  workspace?: CampaignWorkspace;
  requestId: string;
  semanticKey: string;
  title: string;
  goal: string;
  acceptanceCriteria?: string[];
  nonGoals?: string[];
  tasks: CreateCampaignTaskInput[];
  budget?: Partial<CampaignBudget>;
  supervisor?: Partial<CampaignSupervisorConfig>;
  reviewPolicy?: CampaignReviewPolicy;
  createdBy?: string;
}

export interface CampaignReconcileResult {
  campaignId: string;
  changed: boolean;
  dispatched: number;
  checkpointsOpened: number;
  status: CampaignStatus;
}
