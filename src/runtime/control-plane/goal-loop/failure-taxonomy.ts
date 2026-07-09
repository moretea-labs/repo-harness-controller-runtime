import type { FailureClass, GoalStatus } from './types';

export interface FailureClassificationInput {
  message?: string;
  exitCode?: number;
  checkId?: string;
  providerStatus?: string;
  policyBlocked?: boolean;
  externalWrite?: boolean;
  dirtyWorktree?: boolean;
  staleProjection?: boolean;
  restartRequired?: boolean;
  knownClass?: FailureClass;
}

export interface FailureClassification {
  failureClass: FailureClass;
  summary: string;
  repairableByModel: boolean;
  requiresApproval: boolean;
  suggestedNextStatus: GoalStatus;
  suggestedAction: string;
}

/**
 * Classify a failure into the goal-loop taxonomy and recommend the next bounded status.
 */
export function classifyFailure(input: FailureClassificationInput): FailureClassification {
  if (input.knownClass) {
    return classificationFor(input.knownClass, input.message);
  }

  if (input.policyBlocked) {
    return classificationFor('policy_blocked', input.message);
  }
  if (input.externalWrite) {
    return classificationFor('external_write_requires_approval', input.message);
  }
  if (input.dirtyWorktree) {
    return classificationFor('dirty_worktree', input.message);
  }
  if (input.staleProjection) {
    return classificationFor('stale_runtime_projection', input.message);
  }
  if (input.restartRequired) {
    return classificationFor('controller_restart_required', input.message);
  }

  const text = `${input.message ?? ''} ${input.checkId ?? ''} ${input.providerStatus ?? ''}`.toLowerCase();

  if (text.includes('rate limit') || text.includes('rate_limited') || text.includes('429')) {
    return classificationFor('provider_rate_limited', input.message);
  }
  if (text.includes('missing_auth') || text.includes('api key') || text.includes('unauthorized') || text.includes('401')) {
    return classificationFor('missing_auth', input.message);
  }
  if (text.includes('unavailable') || text.includes('not found on path') || text.includes('econnrefused')) {
    return classificationFor('provider_unavailable', input.message);
  }
  if (text.includes('merge conflict') || text.includes('conflict')) {
    return classificationFor('merge_conflict', input.message);
  }
  if (text.includes('typecheck') || text.includes('tsc') || text.includes('type error')) {
    return classificationFor('typecheck_failure', input.message);
  }
  if (text.includes('test') || text.includes('spec failed') || text.includes('assertion')) {
    return classificationFor('test_failure', input.message);
  }
  if (text.includes('compile') || text.includes('syntax') || text.includes('source')) {
    return classificationFor('source_defect', input.message);
  }

  return classificationFor('unknown', input.message);
}

function classificationFor(failureClass: FailureClass, message?: string): FailureClassification {
  const summary = (message ?? failureClass).slice(0, 400);
  switch (failureClass) {
    case 'source_defect':
    case 'test_failure':
    case 'typecheck_failure':
    case 'merge_conflict':
      return {
        failureClass,
        summary,
        repairableByModel: true,
        requiresApproval: false,
        suggestedNextStatus: 'repairing',
        suggestedAction: 'Dispatch repair to a repair-capable invokable provider',
      };
    case 'provider_unavailable':
    case 'provider_rate_limited':
      return {
        failureClass,
        summary,
        repairableByModel: false,
        requiresApproval: false,
        suggestedNextStatus: 'handoff_ready',
        suggestedAction: 'Retry another provider or create handoff packet',
      };
    case 'missing_auth':
      return {
        failureClass,
        summary,
        repairableByModel: false,
        requiresApproval: true,
        suggestedNextStatus: 'waiting_for_user',
        suggestedAction: 'Configure provider credentials outside the repo',
      };
    case 'policy_blocked':
    case 'external_write_requires_approval':
      return {
        failureClass,
        summary,
        repairableByModel: false,
        requiresApproval: true,
        suggestedNextStatus: 'waiting_for_user',
        suggestedAction: 'Obtain explicit user approval',
      };
    case 'dirty_worktree':
    case 'stale_runtime_projection':
      return {
        failureClass,
        summary,
        repairableByModel: false,
        requiresApproval: false,
        suggestedNextStatus: 'repairing',
        suggestedAction: 'Run local maintenance / reconcile before model repair',
      };
    case 'controller_restart_required':
      return {
        failureClass,
        summary,
        repairableByModel: false,
        requiresApproval: true,
        suggestedNextStatus: 'waiting_for_user',
        suggestedAction: 'Restart controller/local bridge with authorization',
      };
    default:
      return {
        failureClass: 'unknown',
        summary,
        repairableByModel: false,
        requiresApproval: false,
        suggestedNextStatus: 'handoff_ready',
        suggestedAction: 'Create handoff packet for human/ChatGPT review',
      };
  }
}
