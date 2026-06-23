export type IssueKind = 'bug' | 'feature' | 'governance' | 'investigation';
export type IssueStatus = 'backlog' | 'analysis' | 'planned' | 'launch_blocked' | 'in_progress' | 'review' | 'done' | 'cancelled';
export type TaskStatus = 'backlog' | 'analysis' | 'planned' | 'ready' | 'launch_blocked' | 'running' | 'blocked' | 'review' | 'integrated' | 'verifying' | 'changes_requested' | 'verified' | 'done' | 'cancelled' | 'superseded';
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

export interface TaskVerification {
  repoId?: string;
  runId?: string;
  integratedRevision?: string;
  reviewedDiffHash?: string;
  checkResults: Array<{ checkId: string; ok: boolean; summary?: string }>;
  commandEvidence?: TaskCommandEvidence[];
  acceptanceResults: Array<{ criterion: string; ok: boolean; evidence?: string }>;
  reviewer: string;
  verifiedAt: string;
  autoCompleted?: boolean;
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
