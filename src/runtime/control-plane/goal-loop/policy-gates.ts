import type { ApprovalState, GoalConstraints } from './types';

export type ExternalEffectKind =
  | 'none'
  | 'local_repo_write'
  | 'workspace_write'
  | 'destructive_file_change'
  | 'external_write'
  | 'email_send_or_delete'
  | 'app_store_connect_write'
  | 'browser_form_submit'
  | 'push'
  | 'release_or_publish'
  | 'broad_refactor'
  | 'secret_or_sensitive_path';

export interface GoalPolicyGateInput {
  effect: ExternalEffectKind;
  constraints?: GoalConstraints;
  approvalConfirmed?: boolean;
  strongConfirmationText?: string;
  expectedChangedFiles?: number;
  expectedChangedLines?: number;
  paths?: string[];
  /** Broad refactor thresholds (defaults: 40 files / 2000 lines). */
  broadRefactorFiles?: number;
  broadRefactorLines?: number;
}

export interface GoalPolicyGateResult {
  approvalState: ApprovalState;
  allowed: boolean;
  reason: string;
  requiredConfirmationText?: string;
  effect: ExternalEffectKind;
}

const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)secrets?\//i,
  /(^|\/)_ops\//i,
  /id_rsa|id_ed25519|\.pem$/i,
  /credentials?\.json$/i,
  /auth\.json$/i,
];

const STRONG_CONFIRMATION = 'confirm-destructive-or-external-effect';

export function pathIsSensitive(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export function evaluateGoalPolicyGate(input: GoalPolicyGateInput): GoalPolicyGateResult {
  const effect = input.effect;
  const paths = input.paths ?? [];

  if (paths.some(pathIsSensitive) || effect === 'secret_or_sensitive_path') {
    return {
      approvalState: 'blocked_by_policy',
      allowed: false,
      reason: 'Secret/config-sensitive paths cannot be mutated through the autonomous goal loop.',
      effect: 'secret_or_sensitive_path',
    };
  }

  if (effect === 'none') {
    return {
      approvalState: 'approval_not_required',
      allowed: true,
      reason: 'Readonly or policy-neutral operation.',
      effect,
    };
  }

  const requiresStrong =
    effect === 'destructive_file_change'
    || effect === 'external_write'
    || effect === 'email_send_or_delete'
    || effect === 'app_store_connect_write'
    || effect === 'browser_form_submit'
    || effect === 'push'
    || effect === 'release_or_publish';

  if (effect === 'push' && input.constraints?.allowPush !== true) {
    return {
      approvalState: 'blocked_by_policy',
      allowed: false,
      reason: 'Push is disabled by goal constraints; remote push requires explicit constraint + approval.',
      effect,
    };
  }

  if (
    (effect === 'external_write' || effect === 'email_send_or_delete' || effect === 'app_store_connect_write')
    && input.constraints?.allowExternalWrite !== true
  ) {
    return {
      approvalState: 'strong_confirmation_required',
      allowed: false,
      reason: 'External writes require allowExternalWrite constraint and strong confirmation.',
      requiredConfirmationText: STRONG_CONFIRMATION,
      effect,
    };
  }

  if (effect === 'destructive_file_change' && input.constraints?.allowDestructive !== true) {
    return {
      approvalState: 'strong_confirmation_required',
      allowed: false,
      reason: 'Destructive file changes require allowDestructive constraint and strong confirmation.',
      requiredConfirmationText: STRONG_CONFIRMATION,
      effect,
    };
  }

  const fileThreshold = input.broadRefactorFiles ?? 40;
  const lineThreshold = input.broadRefactorLines ?? 2_000;
  const files = input.expectedChangedFiles ?? 0;
  const lines = input.expectedChangedLines ?? 0;
  if (effect === 'broad_refactor' || files > fileThreshold || lines > lineThreshold) {
    if (input.approvalConfirmed && input.strongConfirmationText === STRONG_CONFIRMATION) {
      return {
        approvalState: 'approval_not_required',
        allowed: true,
        reason: 'Broad refactor authorized with strong confirmation.',
        effect: 'broad_refactor',
      };
    }
    return {
      approvalState: 'strong_confirmation_required',
      allowed: false,
      reason: `Broad refactor exceeds threshold (files>${fileThreshold} or lines>${lineThreshold}) and requires strong confirmation.`,
      requiredConfirmationText: STRONG_CONFIRMATION,
      effect: 'broad_refactor',
    };
  }

  if (requiresStrong) {
    if (input.approvalConfirmed && input.strongConfirmationText === STRONG_CONFIRMATION) {
      return {
        approvalState: 'approval_not_required',
        allowed: true,
        reason: 'Strong confirmation provided for external/destructive effect.',
        effect,
      };
    }
    return {
      approvalState: 'strong_confirmation_required',
      allowed: false,
      reason: 'Destructive or external side effects require strong confirmation.',
      requiredConfirmationText: STRONG_CONFIRMATION,
      effect,
    };
  }

  if (effect === 'workspace_write' || effect === 'local_repo_write') {
    if (input.approvalConfirmed) {
      return {
        approvalState: 'approval_not_required',
        allowed: true,
        reason: 'Workspace write authorized.',
        effect,
      };
    }
    // Autonomous/supervised goal loop may perform bounded workspace writes without per-step approval
    // when not destructive/external. Callers still apply patches via repo-harness.
    return {
      approvalState: 'approval_not_required',
      allowed: true,
      reason: 'Bounded local/workspace write allowed under goal-loop ownership.',
      effect,
    };
  }

  if (input.approvalConfirmed) {
    return {
      approvalState: 'approval_not_required',
      allowed: true,
      reason: 'Normal authorization confirmed.',
      effect,
    };
  }

  return {
    approvalState: 'normal_authorization_required',
    allowed: false,
    reason: 'Side-effecting operation requires authorization.',
    effect,
  };
}

export function effectFromRisk(
  risk: 'readonly' | 'local_repo_write' | 'workspace_write' | 'remote_write' | 'destructive' | 'raw_secret_config',
  options: { externalWrite?: boolean; push?: boolean } = {},
): ExternalEffectKind {
  if (risk === 'raw_secret_config') return 'secret_or_sensitive_path';
  if (risk === 'destructive') return 'destructive_file_change';
  if (options.push) return 'push';
  if (options.externalWrite || risk === 'remote_write') return 'external_write';
  if (risk === 'workspace_write') return 'workspace_write';
  if (risk === 'local_repo_write') return 'local_repo_write';
  return 'none';
}
