export type IssueKind = 'bug' | 'feature' | 'governance' | 'investigation';
export type IssueStatus = 'backlog' | 'analysis' | 'planned' | 'launch_blocked' | 'in_progress' | 'review' | 'done' | 'cancelled';
export type TaskStatus = 'backlog' | 'analysis' | 'planned' | 'ready' | 'launch_blocked' | 'running' | 'blocked' | 'review' | 'verifying' | 'ready_to_integrate' | 'integrating' | 'integration_blocked' | 'integrated' | 'cleanup_pending' | 'cleanup_blocked' | 'changes_requested' | 'verified' | 'done' | 'cancelled' | 'superseded';
export type TaskRisk = 'readonly' | 'low' | 'medium' | 'high' | 'destructive';
export type ControllerAgent = 'codex' | 'claude' | 'github-copilot';

export interface GitHubIssueLink {
  owner: string;
  repo: string;
  number: number;
  url: string;
  projectOwner?: string;
  projectNumber?: number;
  projectItemId?: string;
  syncedAt: string;
}

export interface TaskCommandEvidence {
  id?: string;
  command: string[];
  cwd?: string;
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  artifactPath?: string;
  reportedBy?: string;
  executedAt?: string;
  source?: 'reported' | 'controller';
}

export interface IntegrationEvidence {
  runId: string;
  kind: 'commit' | 'no_change' | 'superseded';
  targetBranch: string;
  targetRevision: string;
  sourceRevision?: string;
  baseRevision?: string;
  strategy: 'edit_session_commit' | 'already_integrated' | 'no_change' | 'superseded';
  editSessionId?: string;
  reachable: boolean;
  recordedAt: string;
}

export interface CleanupEvidence {
  runId: string;
  worktreeRemovedOrNotCreated: boolean;
  branchDeletedOrRetained: boolean;
  leasesReleased: boolean;
  runTerminal: boolean;
  editSessionClosedOrNotCreated: boolean;
  noActiveProcess: boolean;
  noDirtyDiff: boolean;
  retainedReason?: string;
  maintenanceWarnings?: CompletionMaintenanceWarning[];
  resourceBlockers?: CompletionResourceBlocker[];
  recordedAt: string;
}

export type CompletionReceiptSource =
  | 'direct_edit'
  | 'isolated_agent_run'
  | 'workspace_run'
  | 'remote_no_change_execution';

export type CompletionReceiptDeliveryKind = 'commit' | 'no_change' | 'remote' | 'superseded';
export type CompletionReceiptDeliveryStatus = 'integrated' | 'blocked';
export type CompletionReceiptCleanupStatus = 'complete' | 'maintenance_warning' | 'blocked';

export interface CompletionMaintenanceWarning {
  code:
    | 'worktree_cleanup_failed'
    | 'branch_cleanup_failed'
    | 'edit_session_backup_retained'
    | 'cleanup_retained_by_request';
  message: string;
  resourceKind?: 'worktree' | 'branch' | 'edit_session' | 'lease' | 'process' | 'workspace';
  resourceId?: string;
  recordedAt: string;
}

export interface CompletionResourceBlocker {
  code:
    | 'unintegrated_changes'
    | 'active_write_process'
    | 'unknown_resource_ownership'
    | 'dirty_owned_paths'
    | 'edit_session_open'
    | 'lease_active'
    | 'target_revision_unreachable';
  message: string;
  resourceKind?: 'worktree' | 'branch' | 'edit_session' | 'lease' | 'process' | 'workspace';
  resourceId?: string;
  recordedAt: string;
}

export interface CompletionReceipt {
  schemaVersion: 1;
  receiptId: string;
  source: CompletionReceiptSource;
  issueId: string;
  taskId: string;
  runId?: string;
  editSessionId?: string;
  targetBranch: string;
  targetRevision: string;
  sourceRevision?: string;
  baseRevision?: string;
  changedPaths: string[];
  delivery: {
    kind: CompletionReceiptDeliveryKind;
    status: CompletionReceiptDeliveryStatus;
    strategy: 'edit_session_commit' | 'already_integrated' | 'no_change' | 'remote';
    reachable: boolean;
    recordedAt: string;
  };
  cleanup: {
    status: CompletionReceiptCleanupStatus;
    warnings: CompletionMaintenanceWarning[];
    blockers: CompletionResourceBlocker[];
    recordedAt: string;
  };
  verifiedAt: string;
  recordedAt: string;
}

export type TaskAcceptanceOutcome = 'passed' | 'failed' | 'not_evaluated';
export type TaskAcceptanceSource = 'human_review' | 'controller_check' | 'run_completion' | 'reported' | 'legacy';

export interface TaskAcceptanceResult {
  criterion: string;
  /** Backward-compatible projection. New decision code must prefer outcome/source. */
  ok: boolean;
  outcome?: TaskAcceptanceOutcome;
  source?: TaskAcceptanceSource;
  evidence?: string;
}

export interface TaskVerification {
  repoId?: string;
  runId?: string;
  integratedRevision?: string;
  reviewedDiffHash?: string;
  checkResults: Array<{ checkId: string; ok: boolean; summary?: string }>;
  commandEvidence?: TaskCommandEvidence[];
  acceptanceResults: TaskAcceptanceResult[];
  reviewer: string;
  verifiedAt: string;
  autoCompleted?: boolean;
  completionReceipt?: CompletionReceipt;
  integrationEvidence?: IntegrationEvidence;
  cleanupEvidence?: CleanupEvidence;
}

export interface ControllerTask {
  repoId?: string;
  id: string;
  title: string;
  objective: string;
  status: TaskStatus;
  dependsOn: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  checks: string[];
  acceptanceCriteria: string[];
  risk: TaskRisk;
  /** Optional planning hint only. The executor is selected at dispatch time. */
  recommendedAgent?: ControllerAgent;
  notes: string[];
  runIds: string[];
  github?: GitHubIssueLink;
  verification?: TaskVerification;
  supersededBy?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ControllerIssue {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6;
  repoId?: string;
  id: string;
  title: string;
  slug: string;
  kind: IssueKind;
  status: IssueStatus;
  summary: string;
  goals: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  relatedArtifacts: string[];
  tasks: ControllerTask[];
  github?: GitHubIssueLink;
  ephemeral?: boolean;
  ephemeralOwnerJobId?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDraft {
  repoId?: string;
  title: string;
  objective: string;
  dependsOn?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  checks?: string[];
  acceptanceCriteria?: string[];
  risk?: TaskRisk;
  recommendedAgent?: ControllerAgent;
}

export interface IssueReadinessFinding {
  code: string;
  level: 'blocker' | 'warning';
  message: string;
  taskId?: string;
}

export interface TaskReadiness {
  issueId: string;
  taskId: string;
  ready: boolean;
  queueable: boolean;
  approvalSatisfied: boolean;
  score: number;
  blockers: IssueReadinessFinding[];
  warnings: IssueReadinessFinding[];
  approval: 'auto' | 'confirm' | 'manual-only';
  executionClass: 'read_only' | 'low_risk_change' | 'medium_risk_change' | 'high_risk_change' | 'destructive_change';
  effectiveStatus: string;
  requiresExplicitRetry: boolean;
  retryable: boolean;
}

export interface IssueReadiness {
  issueId: string;
  score: number;
  ready: boolean;
  queueable: boolean;
  blockers: IssueReadinessFinding[];
  taskBlockers: IssueReadinessFinding[];
  warnings: IssueReadinessFinding[];
  readyTaskIds: string[];
  queueableTaskIds: string[];
  approvalPendingTaskIds: string[];
  blockedTaskIds?: string[];
  taskReadiness?: TaskReadiness[];
  suggestedMaxParallel: number;
  agents: Record<ControllerAgent, number>;
}
