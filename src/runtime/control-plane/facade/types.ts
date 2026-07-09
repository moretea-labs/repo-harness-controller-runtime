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
  'workspace_write',
  'remote_write',
  'destructive',
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
  mode?: ExecutionMode;
  statusSummary: string;
  blockedBy?: string[];
  changedFiles?: string[];
  checks?: Array<{ checkId: string; ok: boolean; summary?: string }>;
}

export interface HandoffItem {
  schemaVersion: 1;
  id: string;
  repoId: string;
  issueId?: string;
  taskId?: string;
  title: string;
  severity: HandoffSeverity;
  status: HandoffStatus;
  reason: string;
  summary: string;
  currentState: HandoffCurrentState;
  evidenceRefs: EvidenceRef[];
  recommendedDecision: string;
  recommendedPrompt: string;
  suggestedNextActions: SuggestedNextAction[];
  createdAt: string;
  updatedAt: string;
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

export interface WorkContract {
  schemaVersion: 1;
  objective: string;
  mode: ExecutionMode;
  repoId: string;
  issueId?: string;
  taskId?: string;
  scopeSummary: string;
  acceptanceCriteria: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  checks: string[];
  constraints: WorkContractConstraints;
  driver: WorkContractDriverPolicy;
  requestedBy: 'chatgpt' | 'user' | 'system' | 'scheduler';
  createdAt: string;
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
  expectedFiles?: number;
  expectedChangedLines?: number;
  scopeClear: boolean;
  requiresRecovery: boolean;
  requiresWorker: boolean;
  requiresExternalEffect: boolean;
  requiresApproval: boolean;
}

export interface ExecutionModeSelection {
  mode: ExecutionMode;
  reason: string;
  missingContractFields: string[];
}

export function isTerminalHandoffStatus(status: HandoffStatus): boolean {
  return TERMINAL_HANDOFF_STATUSES.includes(status);
}

export function selectExecutionMode(input: ExecutionModeSelectionInput): ExecutionModeSelection {
  const expectedFiles = input.expectedFiles ?? 0;
  const expectedChangedLines = input.expectedChangedLines ?? 0;
  const directControlFits =
    input.scopeClear &&
    !input.requiresRecovery &&
    !input.requiresWorker &&
    !input.requiresExternalEffect &&
    !input.requiresApproval &&
    expectedFiles <= 3 &&
    expectedChangedLines <= 200;

  if (directControlFits) {
    return {
      mode: 'direct_control',
      reason: 'Small, clear, supervised work should stay on the fast direct-control path.',
      missingContractFields: [],
    };
  }

  if (!input.scopeClear) {
    return {
      mode: 'handoff_only',
      reason: 'The request is underspecified and needs ChatGPT or user clarification before execution.',
      missingContractFields: ['scopeSummary', 'acceptanceCriteria', 'allowedPaths'],
    };
  }

  return {
    mode: 'goal_workloop',
    reason: 'The request benefits from recovery, isolation, worker execution, approval, or background continuation.',
    missingContractFields: [],
  };
}
