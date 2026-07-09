/**
 * Autonomous Goal Loop contracts.
 *
 * GoalContract sits above Issue/Task: Issue/Task manage work items;
 * GoalContract owns objective-level durable loop state.
 *
 * Models are workers/reviewers/planners/handoff recipients.
 * Policy, audit, state, approval, verification, and finalization stay in repo-harness.
 */

export const GOAL_MODES = ['manual', 'supervised', 'autonomous'] as const;
export type GoalMode = (typeof GOAL_MODES)[number];

export const GOAL_STATUSES = [
  'created',
  'planning',
  'ready',
  'dispatching',
  'running',
  'verifying',
  'repairing',
  'waiting_for_user',
  'handoff_ready',
  'finalized',
  'failed',
  'stopped',
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const TERMINAL_GOAL_STATUSES: readonly GoalStatus[] = [
  'finalized',
  'failed',
  'stopped',
] as const;

export const ACTIVE_GOAL_STATUSES: readonly GoalStatus[] = [
  'created',
  'planning',
  'ready',
  'dispatching',
  'running',
  'verifying',
  'repairing',
  'waiting_for_user',
  'handoff_ready',
] as const;

export const PROVIDER_KINDS = [
  'direct_edit',
  'local_cli',
  'remote_api',
  'cloud_agent',
  'handoff_only',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const MODEL_FAMILIES = [
  'none',
  'codex',
  'claude',
  'grok',
  'deepseek',
  'openai',
  'github_copilot',
  'chatgpt_handoff',
] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

export const PROVIDER_STATUSES = [
  'ready',
  'disabled',
  'missing_auth',
  'rate_limited',
  'unavailable',
  'failed_health_check',
  'handoff_only',
] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const PROVIDER_CAPABILITIES = [
  'code_patch',
  'code_review',
  'architecture_planning',
  'long_context',
  'structured_output',
  'browser_planning',
  'ios_log_analysis',
  'test_failure_repair',
  'tool_calling',
  'local_file_mutation',
  'remote_side_effects',
] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export const FAILURE_CLASSES = [
  'source_defect',
  'test_failure',
  'typecheck_failure',
  'merge_conflict',
  'provider_unavailable',
  'provider_rate_limited',
  'missing_auth',
  'policy_blocked',
  'external_write_requires_approval',
  'dirty_worktree',
  'stale_runtime_projection',
  'controller_restart_required',
  'unknown',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const APPROVAL_STATES = [
  'approval_not_required',
  'normal_authorization_required',
  'strong_confirmation_required',
  'blocked_by_policy',
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const TASK_INTENTS = [
  'deterministic_edit',
  'code_implementation',
  'code_repair',
  'architecture_planning',
  'ios_build_or_sim',
  'browser_automation',
  'verification_repair',
  'review',
  'unknown',
] as const;
export type TaskIntent = (typeof TASK_INTENTS)[number];

export interface ProviderLimits {
  maxContextChars: number;
  maxRuntimeMs: number;
  maxPatchFiles: number;
  maxChangedLines: number;
}

export interface ProviderSafety {
  mayMutateFiles: boolean;
  mayRunCommands: boolean;
  /** When true, model output is applied by repo-harness, never by the model itself. */
  requiresApplyByRepoHarness: boolean;
  requiresApprovalForExternalEffects: boolean;
}

export interface ProviderDescriptor {
  providerId: string;
  kind: ProviderKind;
  modelFamily: ModelFamily;
  status: ProviderStatus;
  capabilities: ProviderCapability[];
  limits: ProviderLimits;
  safety: ProviderSafety;
  /** True only when the provider can be invoked through local CLI/API. */
  directDispatch: boolean;
  summary: string;
  lastErrorCode?: string;
  rateLimited?: boolean;
  configured?: boolean;
  authPresent?: boolean;
}

export interface ProviderHealthReport {
  providerId: string;
  configured: boolean;
  authPresent: boolean;
  executableOrApiReachable: boolean;
  modelAvailable: boolean | 'skipped';
  lastErrorCode?: string;
  rateLimitState?: 'unknown' | 'ok' | 'limited';
  directDispatchAllowed: boolean;
  handoffOnly: boolean;
  status: ProviderStatus;
  summary: string;
  /** Never includes tokens, headers, or key material. */
  redacted: true;
}

export interface GoalConstraints {
  maxChangedFiles?: number;
  maxChangedLines?: number;
  allowCommit?: boolean;
  allowPush?: boolean;
  allowDestructive?: boolean;
  allowExternalWrite?: boolean;
  requireHandoffOnAmbiguity?: boolean;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
}

export interface GoalVerificationPolicy {
  requiredCheckIds: string[];
  requirePassingEvidence: boolean;
  maxInfrastructureRetries: number;
}

export interface GoalArtifactRef {
  kind: string;
  id?: string;
  title: string;
  summary?: string;
  createdAt: string;
}

export interface GoalTransitionEvidence {
  from: GoalStatus;
  to: GoalStatus;
  reason: string;
  at: string;
  providerId?: string;
  failureClass?: FailureClass;
  note?: string;
}

export interface GoalContract {
  schemaVersion: 1;
  goalId: string;
  repoId: string;
  title: string;
  objective: string;
  mode: GoalMode;
  status: GoalStatus;
  currentStep: string;
  issueId?: string;
  taskIds: string[];
  constraints: GoalConstraints;
  allowedExecutors: string[];
  forbiddenExecutors: string[];
  requiredApprovals: string[];
  acceptanceCriteria: string[];
  verificationPolicy: GoalVerificationPolicy;
  lastRunId?: string;
  lastProviderId?: string;
  retryBudget: number;
  repairAttempts: number;
  artifacts: GoalArtifactRef[];
  handoffPacketIds: string[];
  transitionHistory: GoalTransitionEvidence[];
  lastFailureClass?: FailureClass;
  waitingReason?: string;
  nextSafeAction?: string;
  verificationEvidence?: Array<{ checkId: string; ok: boolean; summary: string; at: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface GoalContractStore {
  schemaVersion: 1;
  updatedAt: string;
  goals: GoalContract[];
}

export interface GoalHandoffPacket {
  schemaVersion: 1;
  packetId: string;
  goalId: string;
  repoId: string;
  objective: string;
  currentState: {
    status: GoalStatus;
    currentStep: string;
    lastProviderId?: string;
    waitingReason?: string;
  };
  completedSteps: string[];
  blockers: string[];
  lastEvidence: Array<{ title: string; summary?: string }>;
  currentDiffSummary?: string;
  nextSafeActions: string[];
  recommendedProvider?: string;
  requiredUserDecision?: string;
  exactToolCallsSuggested: Array<{
    tool: string;
    operation?: string;
    payload?: Record<string, unknown>;
    risk?: string;
  }>;
  constraints: GoalConstraints;
  acceptanceCriteria: string[];
  timestamp: string;
  /** Secrets are never stored in packets. */
  redacted: true;
}

export interface GoalHandoffPacketStore {
  schemaVersion: 1;
  updatedAt: string;
  packets: GoalHandoffPacket[];
}

export interface StructuredProviderOutput {
  summary: string;
  proposed_patch?: string;
  patch_instructions?: string;
  changed_files: string[];
  verification_commands: string[];
  risk_notes: string[];
}

export interface ExecutorRouteInput {
  goal: Pick<
    GoalContract,
    | 'goalId'
    | 'repoId'
    | 'mode'
    | 'status'
    | 'objective'
    | 'constraints'
    | 'allowedExecutors'
    | 'forbiddenExecutors'
    | 'lastProviderId'
    | 'repairAttempts'
    | 'retryBudget'
    | 'lastFailureClass'
  >;
  taskIntent: TaskIntent;
  risk: 'readonly' | 'local_repo_write' | 'workspace_write' | 'remote_write' | 'destructive' | 'raw_secret_config';
  requiredCapabilities?: ProviderCapability[];
  providers: ProviderDescriptor[];
  retryHistory?: Array<{ providerId: string; failureClass?: FailureClass }>;
  userConstraints?: {
    preferProvider?: string;
    forbidProvider?: string[];
  };
  policyBlocked?: boolean;
  requiresApproval?: boolean;
  externalWrite?: boolean;
}

export interface ExecutorRouteDecision {
  selectedProviderId: string | null;
  selectedProvider?: ProviderDescriptor;
  reason: string;
  directDispatch: boolean;
  handoffOnly: boolean;
  waitForUser: boolean;
  approvalState: ApprovalState;
  alternatives: string[];
}

export interface GoalLoopTickResult {
  goalId: string;
  from: GoalStatus;
  to: GoalStatus;
  transitioned: boolean;
  reason: string;
  providerId?: string;
  handoffPacketId?: string;
  waitingReason?: string;
  nextSafeAction?: string;
}

export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return (TERMINAL_GOAL_STATUSES as readonly string[]).includes(status);
}

export function isActiveGoalStatus(status: GoalStatus): boolean {
  return (ACTIVE_GOAL_STATUSES as readonly string[]).includes(status);
}
