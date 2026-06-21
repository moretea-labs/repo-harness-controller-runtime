export type IssueKind = 'bug' | 'feature' | 'governance' | 'investigation';
export type IssueStatus = 'backlog' | 'analysis' | 'planned' | 'launch_blocked' | 'in_progress' | 'review' | 'done' | 'cancelled';
export type TaskStatus = 'backlog' | 'analysis' | 'planned' | 'ready' | 'launch_blocked' | 'running' | 'blocked' | 'review' | 'integrated' | 'verifying' | 'changes_requested' | 'verified' | 'done' | 'cancelled' | 'superseded';
export type TaskRisk = 'low' | 'medium' | 'high';
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

export interface TaskVerification {
  runId?: string;
  integratedRevision?: string;
  reviewedDiffHash?: string;
  checkResults: Array<{ checkId: string; ok: boolean; summary?: string }>;
  acceptanceResults: Array<{ criterion: string; ok: boolean; evidence?: string }>;
  reviewer: string;
  verifiedAt: string;
}

export interface ControllerTask {
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
  recommendedAgent: ControllerAgent;
  notes: string[];
  runIds: string[];
  github?: GitHubIssueLink;
  verification?: TaskVerification;
  supersededBy?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ControllerIssue {
  schemaVersion: 1 | 2 | 3;
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
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDraft {
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

export interface IssueReadiness {
  issueId: string;
  score: number;
  ready: boolean;
  blockers: IssueReadinessFinding[];
  warnings: IssueReadinessFinding[];
  readyTaskIds: string[];
  suggestedMaxParallel: number;
  agents: Record<ControllerAgent, number>;
}
