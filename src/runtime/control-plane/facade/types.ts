export const EXECUTION_MODES = ['direct_control', 'goal_workloop', 'handoff_only'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const FACADE_TOOLS = ['rh_status', 'rh_inbox', 'rh_context', 'rh_work'] as const;
export type FacadeTool = (typeof FACADE_TOOLS)[number];

export const FACADE_STATUSES = ['ok', 'blocked', 'failed', 'approval_required', 'not_found'] as const;
export type FacadeStatus = (typeof FACADE_STATUSES)[number];

export type FacadeDetailLevel = 'summary' | 'detail' | 'raw';

export const CAPABILITY_DOMAINS = ['repository', 'plugin', 'controller', 'evidence', 'maintenance'] as const;
export type CapabilityDomain = (typeof CAPABILITY_DOMAINS)[number];

export const CAPABILITY_OPERATION_CLASSES = ['read', 'write', 'execute', 'verify', 'finalize'] as const;
export type CapabilityOperationClass = (typeof CAPABILITY_OPERATION_CLASSES)[number];

export const CAPABILITY_RISKS = [
  'readonly',
  'local_repo_write',
  'workspace_write',
  'remote_write',
  'destructive_remote',
  'destructive',
  'raw_secret_config',
  'unknown',
] as const;
export type CapabilityRisk = (typeof CAPABILITY_RISKS)[number];

export const POLICY_DECISIONS = ['allowed', 'approval_required', 'denied', 'dry_run_only'] as const;
export type PolicyDecisionKind = (typeof POLICY_DECISIONS)[number];

export const HANDOFF_SEVERITIES = ['info', 'needs_review', 'blocked', 'failed', 'ready_to_continue'] as const;
export type HandoffSeverity = (typeof HANDOFF_SEVERITIES)[number];

export const HANDOFF_STATUSES = [
  'pending',
  'acknowledged',
  'in_progress',
  'resolved',
  'dismissed',
  'superseded',
  'expired',
] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const TERMINAL_HANDOFF_STATUSES: readonly HandoffStatus[] = [
  'resolved',
  'dismissed',
  'superseded',
  'expired',
] as const;

export const WORK_CONTRACT_STATUSES = [
  'pending',
  'running',
  'blocked',
  'waiting_for_review',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type WorkContractStatus = (typeof WORK_CONTRACT_STATUSES)[number];

export const TERMINAL_WORK_CONTRACT_STATUSES: readonly WorkContractStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const VERIFICATION_OUTCOMES = [
  'valid_pass',
  'valid_fail',
  'invalid_check_id',
  'infrastructure_failure',
  'skipped',
  'superseded',
] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export const HANDOFF_CREATION_REASONS = [
  'policy_approval_required',
  'ambiguous_outcome',
  'missing_authorization',
  'invalid_objective',
  'repeated_infrastructure_failure',
  'codex_worker_requires_review',
  'destructive_action_requires_confirmation',
] as const;
export type HandoffCreationReason = (typeof HANDOFF_CREATION_REASONS)[number];

export interface EvidenceRef {
  evidenceId?: string;
  artifactId?: string;
  title: string;
  summary?: string;
  detailLevel?: FacadeDetailLevel;
}

export interface SuggestedNextAction {
  label: string;
  tool: FacadeTool;
  operation: string;
  payload?: Record<string, unknown>;
  risk: CapabilityRisk;
  confidence?: 'low' | 'medium' | 'high';
  reason?: string;
  fallback?: string;
}

export interface FacadeResult<TData = Record<string, unknown>> {
  schemaVersion: 1;
  status: FacadeStatus;
  summary: string;
  data: TData;
  evidenceRefs: EvidenceRef[];
  warnings: string[];
  suggestedNextActions: SuggestedNextAction[];
  rawAvailable: boolean;
  detailLevel: FacadeDetailLevel;
}

export interface HandoffCurrentState {
  repoId: string;
  issueId?: string;
  taskId?: string;
  workId?: string;
  mode?: ExecutionMode;
  statusSummary: string;
  blockedBy?: string[];
  changedFiles?: string[];
  checks?: Array<{ checkId: string; ok: boolean; summary?: string; outcome?: VerificationOutcome }>;
}

export interface HandoffApprovalAction {
  operation: 'start' | 'repair';
  label: string;
  summary: string;
  risk: CapabilityRisk;
  payload: Record<string, unknown>;
}

export interface HandoffItem {
  schemaVersion: 1;
  id: string;
  repoId: string;
  workId?: string;
  issueId?: string;
  taskId?: string;
  title: string;
  severity: HandoffSeverity;
  status: HandoffStatus;
  reason: string;
  creationReason?: HandoffCreationReason;
  summary: string;
  currentState: HandoffCurrentState;
  attemptedActions?: string[];
  evidenceRefs: EvidenceRef[];
  blockingDecision?: string;
  recommendedDecision: string;
  recommendedPrompt: string;
  recommendedContinuationPrompt?: string;
  /** Exact action that may run after explicit approval. Absent on legacy/non-executable handoffs. */
  approvalAction?: HandoffApprovalAction;
  suggestedNextActions: SuggestedNextAction[];
  decision?: string;
  resolver?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HandoffInboxStore {
  schemaVersion: 1;
  updatedAt: string;
  items: HandoffItem[];
}

export interface WorkContractConstraints {
  maxChangedFiles?: number;
  maxChangedLines?: number;
  allowCommit?: boolean;
  allowMerge?: boolean;
  allowCleanup?: boolean;
  allowDestructive?: boolean;
  requireHandoffOnAmbiguity?: boolean;
}

export interface WorkContractDriverPolicy {
  preferred: 'direct_edit' | 'isolated_worktree' | 'codex_worker' | 'handoff_only';
  allowWorker: boolean;
  allowDirectEdit: boolean;
}

export interface WorktreePolicy {
  required: boolean;
  reason?: string;
  ref?: string;
}

export interface EvidencePolicy {
  defaultDetailLevel: FacadeDetailLevel;
  allowRawOptIn: boolean;
  maxEvidenceRefs: number;
}

export interface ApprovalPolicy {
  required: boolean;
  reasons: string[];
  confirmed: boolean;
}

export interface RecoveryPolicy {
  allowSelfHealing: boolean;
  maxInfrastructureRetries: number;
  handoffOnAmbiguity: boolean;
}

export interface VerificationRecord {
  checkId: string;
  outcome: VerificationOutcome;
  summary: string;
  recordedAt: string;
  supersedes?: string;
  evidenceRef?: EvidenceRef;
}

export interface WorkContract {
  schemaVersion: 1;
  workId: string;
  repoId: string;
  mode: ExecutionMode;
  objective: string;
  acceptanceCriteria: string[];
  constraints: WorkContractConstraints;
  status: WorkContractStatus;
  createdAt: string;
  updatedAt: string;
  /** @deprecated Prefer workId; kept for phase-1 contract compatibility. */
  issueId?: string;
  taskId?: string;
  scopeSummary?: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  checks: string[];
  driver: WorkContractDriverPolicy;
  worktreePolicy: WorktreePolicy;
  evidencePolicy: EvidencePolicy;
  approvalPolicy: ApprovalPolicy;
  recoveryPolicy: RecoveryPolicy;
  requestedBy: 'chatgpt' | 'user' | 'system' | 'scheduler';
  evidenceRefs: EvidenceRef[];
  handoffRefs: string[];
  suggestedNextActions: SuggestedNextAction[];
  policyDecisions: PolicyDecision[];
  checkRefs: VerificationRecord[];
  continuationPrompt?: string;
  worktreeRef?: string;
  workerRef?: string;
}

export interface WorkContractStore {
  schemaVersion: 1;
  updatedAt: string;
  contracts: WorkContract[];
}

export interface CapabilityDescriptor {
  capabilityId: string;
  domain: CapabilityDomain;
  operationClass: CapabilityOperationClass;
  risk: CapabilityRisk;
  exposedVia: FacadeTool;
  summary: string;
}

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  reason: string;
  capabilityId?: string;
  approvalRequestId?: string;
  requiredConfirmationText?: string;
  warnings: string[];
  suggestedNextActions: SuggestedNextAction[];
}

export interface ExecutionModeSelectionInput {
  objective?: string;
  expectedFiles?: number;
  expectedChangedLines?: number;
  scopeClear: boolean;
  requiresInvestigation?: boolean;
  requiresLongRunningChecks?: boolean;
  requiresParallelism?: boolean;
  needsDependencies?: boolean;
  requiresRecovery?: boolean;
  requiresWorker?: boolean;
  requiresExternalEffect?: boolean;
  requiresApproval?: boolean;
  requiresUserApproval?: boolean;
  destructive?: boolean;
  remoteWrite?: boolean;
  secretAccess?: boolean;
  risk?: CapabilityRisk;
}

export interface ExecutionModeSelection {
  mode: ExecutionMode;
  reason: string;
  missingContractFields: string[];
  createWorkContract: boolean;
  createHandoff: boolean;
}

export function isTerminalHandoffStatus(status: HandoffStatus): boolean {
  return TERMINAL_HANDOFF_STATUSES.includes(status);
}

export function isTerminalWorkContractStatus(status: WorkContractStatus): boolean {
  return TERMINAL_WORK_CONTRACT_STATUSES.includes(status);
}

export function selectExecutionMode(input: ExecutionModeSelectionInput): ExecutionModeSelection {
  const expectedFiles = input.expectedFiles ?? 0;
  const expectedChangedLines = input.expectedChangedLines ?? 0;
  const requiresApproval = input.requiresApproval === true || input.requiresUserApproval === true;
  const highRisk =
    input.destructive === true
    || input.remoteWrite === true
    || input.secretAccess === true
    || input.risk === 'destructive'
    || input.risk === 'destructive_remote'
    || input.risk === 'remote_write'
    || input.risk === 'raw_secret_config';

  const objectiveClear = input.scopeClear && (input.objective === undefined || input.objective.trim().length > 0);
  const missingContractFields: string[] = [];
  if (!input.scopeClear) missingContractFields.push('scopeSummary', 'acceptanceCriteria', 'allowedPaths');
  if (input.objective !== undefined && input.objective.trim().length === 0) missingContractFields.push('objective');

  if (!objectiveClear || (highRisk && requiresApproval && !input.scopeClear)) {
    return {
      mode: 'handoff_only',
      reason: 'The request is underspecified, high-risk without clear scope, or missing authorization and needs ChatGPT or user clarification before execution.',
      missingContractFields: missingContractFields.length ? missingContractFields : ['scopeSummary'],
      createWorkContract: false,
      createHandoff: true,
    };
  }

  if (highRisk && requiresApproval) {
    return {
      mode: 'handoff_only',
      reason: 'High-risk side effects require explicit authorization before any work contract or direct edit starts.',
      missingContractFields: [],
      createWorkContract: false,
      createHandoff: true,
    };
  }

  const complex =
    input.requiresRecovery === true
    || input.requiresWorker === true
    || input.requiresExternalEffect === true
    || input.requiresInvestigation === true
    || input.requiresLongRunningChecks === true
    || input.requiresParallelism === true
    || input.needsDependencies === true
    || requiresApproval
    || expectedFiles > 3
    || expectedChangedLines > 200;

  if (!complex) {
    return {
      mode: 'direct_control',
      reason: 'Small, clear, supervised work should stay on the fast direct-control path.',
      missingContractFields: [],
      createWorkContract: false,
      createHandoff: false,
    };
  }

  return {
    mode: 'goal_workloop',
    reason: 'The request benefits from recovery, isolation, worker execution, approval, investigation, or background continuation.',
    missingContractFields: [],
    createWorkContract: true,
    createHandoff: false,
  };
}
