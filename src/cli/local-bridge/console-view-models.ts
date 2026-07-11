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

export interface HandoffDecisionViewModel {
  type: 'approval' | 'authorization' | 'review' | 'clarification';
  typeLabel: string;
  requestedAction: string;
  necessityLabel: string;
  necessityExplanation: string;
  impact: string;
  afterApproval: string;
  ifRejected: string;
  canApproveAndContinue: boolean;
  primaryActionLabel: string;
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
  decision: HandoffDecisionViewModel;
  /** Advanced only */
  advanced?: {
    handoffId: string;
    workId?: string;
    creationReason?: string;
  };
}

export interface ChangedFileEntryViewModel {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'unknown';
  statusLabel: string;
}

export interface ChangedFilesSummaryViewModel {
  total: number;
  modified: number;
  added: number;
  deleted: number;
  files: ChangedFileEntryViewModel[];
  summaryLabel: string;
}

export interface ConsoleErrorViewModel {
  errorClass:
    | 'controller_unavailable'
    | 'connector_stale'
    | 'infrastructure_failure'
    | 'acceptance_failure'
    | 'invalid_check_id'
    | 'approval_required'
    | 'handoff_required'
    | 'timeout'
    | 'policy_denied'
    | 'not_found'
    | 'unknown_failure';
  title: string;
  explanation: string;
  nextActions: string[];
}

export interface WorkSummaryViewModel {
  id: string;
  title: string;
  objective: string;
  modeLabel: string;
  mode: ModePreviewViewModel['mode'];
  accessMode: 'request' | 'full_access';
  accessModeLabel: string;
  statusLabel: string;
  tone: PlainStatusTone;
  /** Machine phase for UI feedback: running | waiting | succeeded | failed | blocked | ... */
  phase: string;
  phaseLabel: string;
  nextAction: string;
  latestAction: string;
  latestSummary: string;
  progressSteps: Array<{ label: string; done: boolean; active: boolean }>;
  latestVerification?: VerificationViewModel;
  acceptanceCriteria: string[];
  evidenceLabels: string[];
  changedFiles?: ChangedFilesSummaryViewModel;
  error?: ConsoleErrorViewModel;
  delegateSummary?: string;
  suggestedActions: SuggestedActionViewModel[];
  primaryActionLabel?: string;
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
  branchLabel?: string;
  dirtyLabel?: string;
  readinessLabel?: string;
  advanced?: {
    repoId: string;
    remote?: string;
    defaultBranch?: string;
    checkoutId?: string;
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

/** Compact autonomous goal-loop status for console / local-bridge (no raw internal dumps). */
export interface GoalLoopStatusViewModel {
  activeCount: number;
  goals: Array<{
    title: string;
    stage: string;
    currentStep: string;
    providerSelected?: string;
    waitingReason?: string;
    nextSafeAction?: string;
    handoffPacketAvailable: boolean;
    approvalRequired: boolean;
    whyThisProvider?: string;
    whatHappensNext?: string;
    whatIsBlocked?: string;
  }>;
  invokableProviders: string[];
  handoffOnlyProviders: string[];
  providerHealth: Array<{
    providerId: string;
    status: string;
    directDispatchAllowed: boolean;
    handoffOnly: boolean;
    summary: string;
  }>;
  /** Plain-language automation overview snippet. */
  automationSummary?: string;
  liveModelProvidersEffective?: boolean;
  settingsPathHint?: string;
  nextTickHint?: string;
}

export interface CommandCenterViewModel {
  schemaVersion: 1;
  generatedAt: string;
  accessMode: 'request' | 'full_access';
  accessModeLabel: string;
  accessModeDescription: string;
  readiness: SystemReadinessViewModel;
  currentRepository?: RepositoryCardViewModel;
  repositories: RepositoryCardViewModel[];
  currentWork?: WorkSummaryViewModel;
  recentWork: WorkSummaryViewModel[];
  handoffs: HandoffCardViewModel[];
  /** Autonomous goal loop surface (daemon-owned, above Issue/Task). */
  goalLoop?: GoalLoopStatusViewModel;
  /** Assistant/plugin capabilities available to the controller (not the primary workflow). */
  pluginSummary?: PluginSummaryViewModel;
  plugins?: PluginCardViewModel[];
  modePreviewDefault: ModePreviewViewModel;
  warnings: string[];
  /** Setup guidance when no usable repository is selected. */
  setupGuide?: {
    needed: boolean;
    title: string;
    body: string;
    actionLabel: string;
  };
}
