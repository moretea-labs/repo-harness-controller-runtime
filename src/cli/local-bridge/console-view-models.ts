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

export interface ConnectorFreshnessViewModel {
  status:
    | 'local_mcp_updated'
    | 'local_mcp_missing_facade'
    | 'chatgpt_snapshot_missing_facade'
    | 'unable_to_verify_chatgpt_snapshot'
    | 'stale_fingerprint'
    | 'unknown';
  severity: 'ok' | 'info' | 'warning' | 'error';
  summary: string;
  expectedFacadeTools: string[];
  missingLocalTools: string[];
  missingConnectorTools: string[];
  restartRecommended: boolean;
  reconnectRecommended: boolean;
  howToFix: string[];
  suggestedActions: string[];
}

export interface SystemReadinessViewModel {
  state: 'ready' | 'needs_setup' | 'blocked';
  label: string;
  headline: string;
  description: string;
  connectorLabel: string;
  connectorTone: PlainStatusTone;
  pendingHandoffCount: number;
  /** Normalized connector freshness; distinguishes local MCP vs ChatGPT snapshot. */
  connectorFreshness?: ConnectorFreshnessViewModel;
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

export interface PluginActionViewModel {
  id: string;
  title: string;
  description: string;
  risk: string;
  riskLabel: string;
  readOnly: boolean;
  confirmation: string;
  confirmationLabel: string;
  canPreview: boolean;
  requiredConfirmationText?: string;
}

export interface PluginCardViewModel {
  id: string;
  name: string;
  provider: string;
  status: 'ready' | 'authorization_required' | 'failed' | 'disabled' | 'needs_setup';
  statusLabel: string;
  tone: PlainStatusTone;
  enabled: boolean;
  actionCount: number;
  description: string;
  nextStep: string;
  healthLabel: string;
  lifecycleLabel: string;
  capabilityLabels: string[];
  actions: PluginActionViewModel[];
  warnings: string[];
  advanced?: {
    pluginId: string;
    provider: string;
    revision?: number;
  };
}

export interface PluginSummaryViewModel {
  ready: number;
  total: number;
  needsAttention: number;
  lines: string[];
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
  /** Assistant/plugin capabilities available to the controller. */
  pluginSummary?: PluginSummaryViewModel;
  plugins?: PluginCardViewModel[];
  modePreviewDefault: ModePreviewViewModel;
  warnings: string[];
}
