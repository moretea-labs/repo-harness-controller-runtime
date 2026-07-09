/** Plain-language view models for the Execution Assistant Console. */

export type PlainStatusTone = 'green' | 'amber' | 'red' | 'blue' | 'gray';

export interface SuggestedActionViewModel {
  id: string;
  label: string;
  kind: 'continue' | 'verify' | 'finalize' | 'stop' | 'delegate' | 'repair' | 'resolve' | 'dismiss' | 'open' | 'diagnose' | 'other';
  tool?: string;
  operation?: string;
  payload?: Record<string, unknown>;
  primary?: boolean;
}

export interface ModePreviewViewModel {
  mode: 'direct_control' | 'goal_workloop' | 'handoff_only';
  label: string;
  explanation: string;
  createWorkContract: boolean;
  createHandoff: boolean;
}

export interface VerificationViewModel {
  label: string;
  tone: PlainStatusTone;
  outcome?: string;
  checkLabel?: string;
  isAcceptanceFailure: boolean;
  isInfrastructureIssue: boolean;
  summary: string;
}

export interface HandoffCardViewModel {
  id: string;
  title: string;
  reason: string;
  recommendedDecision: string;
  continuationPrompt: string;
  severityLabel: string;
  tone: PlainStatusTone;
  statusLabel: string;
  workTitle?: string;
  attemptedActions: string[];
  evidenceLabels: string[];
  suggestedActions: SuggestedActionViewModel[];
  /** Advanced only */
  advanced?: {
    handoffId: string;
    workId?: string;
    creationReason?: string;
  };
}

export interface WorkSummaryViewModel {
  id: string;
  title: string;
  modeLabel: string;
  mode: ModePreviewViewModel['mode'];
  statusLabel: string;
  tone: PlainStatusTone;
  nextAction: string;
  progressSteps: Array<{ label: string; done: boolean; active: boolean }>;
  latestVerification?: VerificationViewModel;
  acceptanceCriteria: string[];
  evidenceLabels: string[];
  delegateSummary?: string;
  suggestedActions: SuggestedActionViewModel[];
  advanced?: {
    workId: string;
    status: string;
    checkIds: string[];
    handoffRefs: string[];
  };
}

export interface SystemReadinessViewModel {
  state: 'ready' | 'needs_setup' | 'blocked';
  label: string;
  headline: string;
  description: string;
  connectorLabel: string;
  connectorTone: PlainStatusTone;
  pendingHandoffCount: number;
  sections: Array<{
    id: string;
    title: string;
    statusLabel: string;
    tone: PlainStatusTone;
    detail: string;
  }>;
  selfHealing?: {
    dryRun: boolean;
    issueCount: number;
    summary: string;
    actions: SuggestedActionViewModel[];
  };
}

export interface RepositoryCardViewModel {
  id: string;
  name: string;
  path: string;
  statusLabel: string;
  tone: PlainStatusTone;
  current: boolean;
  advanced?: {
    repoId: string;
    remote?: string;
    defaultBranch?: string;
  };
}

export interface CommandCenterViewModel {
  schemaVersion: 1;
  generatedAt: string;
  readiness: SystemReadinessViewModel;
  currentRepository?: RepositoryCardViewModel;
  repositories: RepositoryCardViewModel[];
  currentWork?: WorkSummaryViewModel;
  recentWork: WorkSummaryViewModel[];
  handoffs: HandoffCardViewModel[];
  modePreviewDefault: ModePreviewViewModel;
  warnings: string[];
}
