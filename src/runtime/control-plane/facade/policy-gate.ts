import {
  evaluateAccessMode,
  normalizeAccessMode,
  type AccessEffect,
  type AccessMode,
} from '../governance/access-policy';
import type { CapabilityDescriptor, CapabilityRisk, PolicyDecision, SuggestedNextAction } from './types';

export type PolicySideEffect =
  | 'none'
  | 'local_repo_write'
  | 'workspace_write'
  | 'remote_write'
  | 'destructive_remote'
  | 'raw_secret_config';

export interface DirectEditBoundary {
  scopeClear: boolean;
  maxChangedFiles?: number;
  maxChangedLines?: number;
  pathsExplicit?: boolean;
}

export interface PolicyGateInput {
  capability?: CapabilityDescriptor;
  capabilityId?: string;
  risk?: CapabilityRisk;
  sideEffect?: PolicySideEffect;
  accessMode?: AccessMode;
  approvalConfirmed?: boolean;
  dryRun?: boolean;
  directEditBoundary?: DirectEditBoundary;
}

function approvalAction(reason: string, capabilityId?: string): SuggestedNextAction {
  return {
    label: 'Create a handoff for approval',
    tool: 'rh_inbox',
    operation: 'list',
    risk: 'readonly',
    reason,
    payload: capabilityId ? { capability_id: capabilityId } : undefined,
  };
}

function sideEffectFromRisk(risk: CapabilityRisk | undefined): PolicySideEffect {
  if (risk === 'readonly') return 'none';
  if (risk === 'local_repo_write') return 'local_repo_write';
  if (risk === 'workspace_write') return 'workspace_write';
  if (risk === 'remote_write') return 'remote_write';
  if (risk === 'destructive_remote' || risk === 'destructive') return 'destructive_remote';
  if (risk === 'raw_secret_config') return 'raw_secret_config';
  return 'workspace_write';
}

function accessEffectFromSideEffect(sideEffect: PolicySideEffect): AccessEffect {
  if (sideEffect === 'none') return 'read';
  if (sideEffect === 'local_repo_write') return 'local_repo_write';
  if (sideEffect === 'workspace_write') return 'workspace_write';
  if (sideEffect === 'remote_write') return 'remote_write';
  if (sideEffect === 'destructive_remote') return 'destructive';
  return 'secret_access';
}

function directEditWithinBoundary(boundary: DirectEditBoundary | undefined): boolean {
  if (!boundary) return false;
  return boundary.scopeClear && boundary.pathsExplicit === true && (boundary.maxChangedFiles ?? 99) <= 3 && (boundary.maxChangedLines ?? 9999) <= 200;
}

export function evaluatePolicyGate(input: PolicyGateInput): PolicyDecision {
  const capabilityId = input.capability?.capabilityId ?? input.capabilityId;
  const risk = input.risk ?? input.capability?.risk;
  const sideEffect = input.sideEffect ?? sideEffectFromRisk(risk);
  const accessMode = normalizeAccessMode(input.accessMode);
  const warnings: string[] = [];

  if (input.dryRun) {
    return {
      decision: 'dry_run_only',
      reason: 'The request is explicitly dry-run-only; no mutation should be executed.',
      capabilityId,
      warnings,
      suggestedNextActions: [],
    };
  }

  if (sideEffect === 'raw_secret_config') {
    return {
      decision: 'denied',
      reason: 'Raw secrets, tokens, and auth configuration cannot be returned or modified through the ChatGPT-facing facade.',
      capabilityId,
      warnings: ['Use a local trusted OAuth/keychain flow or a redacted readiness handoff.'],
      suggestedNextActions: [],
    };
  }

  if (sideEffect === 'none') {
    return { decision: 'allowed', reason: 'Readonly bounded facade operation.', capabilityId, warnings, suggestedNextActions: [] };
  }

  if (evaluateAccessMode(accessMode, accessEffectFromSideEffect(sideEffect)) === 'allow') {
    return {
      decision: 'allowed',
      reason: 'Full Access permits this local repository operation without another approval prompt.',
      capabilityId,
      warnings: ['Remote writes, destructive actions, outside-repository access, and raw secrets remain separately gated.'],
      suggestedNextActions: [],
    };
  }

  if (sideEffect === 'local_repo_write' && directEditWithinBoundary(input.directEditBoundary)) {
    return {
      decision: 'allowed',
      reason: 'Bounded direct edit is within the lightweight Direct Control policy boundary.',
      capabilityId,
      warnings,
      suggestedNextActions: [],
    };
  }

  if (input.approvalConfirmed) {
    return {
      decision: 'allowed',
      reason: 'Required approval was explicitly confirmed before executing the side-effecting operation.',
      capabilityId,
      warnings,
      suggestedNextActions: [],
    };
  }

  if (sideEffect === 'destructive_remote') {
    return {
      decision: 'approval_required',
      reason: 'Destructive remote operations require explicit strong confirmation.',
      capabilityId,
      requiredConfirmationText: 'confirm-destructive-remote-operation',
      warnings,
      suggestedNextActions: [approvalAction('Strong confirmation is required.', capabilityId)],
    };
  }

  return {
    decision: 'approval_required',
    reason: accessMode === 'request'
      ? 'Request mode requires approval for side effects outside the bounded Direct Control path.'
      : 'This operation is outside the local repository permissions granted by Full Access.',
    capabilityId,
    warnings,
    suggestedNextActions: [approvalAction('Approval is required before execution.', capabilityId)],
  };
}
