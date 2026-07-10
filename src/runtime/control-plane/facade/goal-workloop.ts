import { randomUUID } from 'crypto';
import {
  createHandoffItem,
  type HandoffInboxStoreOptions,
} from './handoff-inbox-store';
import {
  appendVerificationRecord,
  appendWorkEvidence,
  appendWorkHandoffRef,
  createWorkContract,
  getWorkContract,
  summarizeWorkContract,
  updateWorkContract,
  type WorkContractStoreOptions,
} from './work-contract-store';
import {
  classifyVerificationOutcome,
  normalizeCheckIds,
  reconcileVerificationHistory,
  type CheckDefinitionLike,
} from './check-normalization';
import { evaluatePolicyGate } from './policy-gate';
import { buildFacadeResult } from './facade-result';
import { validateSuggestedNextActions } from './suggested-actions';
import type {
  CapabilityRisk,
  EvidenceRef,
  ExecutionModeSelectionInput,
  FacadeResult,
  PolicyDecision,
  SuggestedNextAction,
  VerificationRecord,
  WorkContract,
} from './types';
import { selectExecutionMode } from './types';

export type GoalWorkloopOperation = 'start' | 'continue' | 'verify' | 'finalize' | 'stop';

export interface GoalWorkloopContext {
  workStore: WorkContractStoreOptions;
  handoffStore: HandoffInboxStoreOptions;
  repoId: string;
  availableChecks?: readonly CheckDefinitionLike[];
  now?: () => string;
}

export interface GoalWorkloopStartInput {
  objective: string;
  acceptanceCriteria?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  checks?: string[];
  constraints?: WorkContract['constraints'];
  modeInput: ExecutionModeSelectionInput;
  requestedBy?: WorkContract['requestedBy'];
  taskId?: string;
  issueId?: string;
  approvalConfirmed?: boolean;
  dryRun?: boolean;
  forceMode?: WorkContract['mode'];
}

export interface GoalWorkloopContinueInput {
  workId: string;
  note?: string;
}

export interface GoalWorkloopVerifyInput {
  workId: string;
  checkId: string;
  /** When true, simulate infrastructure failure rather than acceptance fail. */
  infrastructureFailed?: boolean;
  /** When true and check is valid, record acceptance failure. */
  checkFailed?: boolean;
  /** When true, skip without acceptance implication. */
  skipped?: boolean;
}

export interface GoalWorkloopFinalizeInput {
  workId: string;
  forceFailed?: boolean;
}

export interface GoalWorkloopStopInput {
  workId: string;
  reason?: string;
  /** Destructive worktree cleanup requires explicit authorization. */
  authorizeDestructiveCleanup?: boolean;
}

function nowIso(ctx: GoalWorkloopContext): string {
  return ctx.now?.() ?? new Date().toISOString();
}

function workIdFor(objective: string): string {
  const slug = objective
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'work';
  return `work-${slug}-${randomUUID().slice(0, 8)}`;
}

function handoffIdFor(prefix: string): string {
  return `hnd-${prefix}-${randomUUID().slice(0, 8)}`;
}

function suggestedForWork(work: WorkContract, extras: SuggestedNextAction[] = []): SuggestedNextAction[] {
  const base: SuggestedNextAction[] = [
    {
      label: 'Continue workloop',
      tool: 'rh_work',
      operation: 'continue',
      payload: { work_id: work.workId },
      risk: 'readonly',
      confidence: 'high',
    },
    {
      label: 'Verify registered checks',
      tool: 'rh_work',
      operation: 'verify',
      payload: { work_id: work.workId, check_id: work.checks[0] },
      risk: 'workspace_write',
      confidence: work.checks[0] ? 'high' : 'low',
    },
    {
      label: 'Finalize when ready',
      tool: 'rh_work',
      operation: 'finalize',
      payload: { work_id: work.workId },
      risk: 'readonly',
      confidence: 'medium',
    },
  ];
  return validateSuggestedNextActions([...extras, ...base], {
    validCheckIds: work.checks,
  }).actions;
}

function initialEvidence(objective: string): EvidenceRef {
  return {
    title: 'work contract created',
    summary: `Initial WorkContract for: ${objective.slice(0, 200)}`,
    detailLevel: 'summary',
  };
}

/**
 * Mode selection for facade routing. Direct control never creates a WorkContract.
 * Goal workloop creates one. Handoff-only creates a handoff and stops.
 */
export function routeWorkStart(
  ctx: GoalWorkloopContext,
  input: GoalWorkloopStartInput,
): FacadeResult {
  const mode = input.forceMode
    ? {
        mode: input.forceMode,
        reason: `Forced mode: ${input.forceMode}`,
        missingContractFields: [] as string[],
        createWorkContract: input.forceMode === 'goal_workloop',
        createHandoff: input.forceMode === 'handoff_only',
      }
    : selectExecutionMode({
        ...input.modeInput,
        objective: input.objective,
      });

  const policy = evaluatePolicyGate({
    capabilityId: mode.mode === 'direct_control' ? 'repository.direct_edit' : mode.mode === 'goal_workloop' ? 'controller.goal_workloop' : 'controller.handoff_inbox',
    risk: input.modeInput.risk
      ?? (input.modeInput.secretAccess === true ? 'raw_secret_config'
        : input.modeInput.destructive === true ? 'destructive'
          : input.modeInput.remoteWrite === true ? 'remote_write'
            : input.modeInput.requiresApproval === true || input.modeInput.requiresUserApproval === true ? 'workspace_write'
              : mode.mode === 'direct_control' ? 'local_repo_write'
                : mode.mode === 'goal_workloop' ? 'workspace_write'
                  : 'readonly'),
    approvalConfirmed: input.approvalConfirmed === true,
    dryRun: input.dryRun === true,
    directEditBoundary: {
      scopeClear: input.modeInput.scopeClear,
      maxChangedFiles: input.modeInput.expectedFiles,
      maxChangedLines: input.modeInput.expectedChangedLines,
      pathsExplicit: input.modeInput.scopeClear,
    },
  });

  if (mode.mode === 'direct_control') {
    const available = ctx.availableChecks ?? [];
    const normalized = normalizeCheckIds(input.checks ?? [], available);
    const suggested = validateSuggestedNextActions([
      {
        label: 'Apply bounded direct edit',
        tool: 'rh_work',
        operation: 'start',
        payload: { mode: 'direct_control', objective: input.objective.slice(0, 200) },
        risk: 'local_repo_write',
        confidence: 'high',
        reason: 'Small supervised task stays on Direct Control; no WorkContract created.',
      },
      ...normalized.suggestedNextActions,
      {
        label: 'Read repository context',
        tool: 'rh_context',
        operation: 'get',
        risk: 'readonly',
        confidence: 'medium',
      },
    ], { validCheckIds: normalized.validCheckIds }).actions;

    return buildFacadeResult({
      status: policy.decision === 'denied' ? 'blocked' : 'ok',
      summary: `Direct control recommended. No WorkContract created. ${mode.reason}`,
      data: {
        mode,
        policy,
        workContractCreated: false,
        directControlPreserved: true,
        objective: input.objective.slice(0, 1_000),
        normalizedChecks: normalized,
      },
      warnings: [...policy.warnings, ...normalized.warnings],
      suggestedNextActions: suggested,
      rawAvailable: false,
    });
  }

  // Handoff-only for underspecified/high-risk routes. Goal workloop start is allowed without
  // pre-approval; destructive/remote/secret still require handoff when mode says so.
  const blockForHandoff =
    mode.mode === 'handoff_only'
    || policy.decision === 'denied'
    || (
      policy.decision === 'approval_required'
      && (
        input.modeInput.requiresApproval === true
        || input.modeInput.requiresUserApproval === true
        || input.modeInput.destructive === true
        || input.modeInput.remoteWrite === true
        || input.modeInput.secretAccess === true
      )
    );

  if (blockForHandoff) {
    const handoff = createHandoffItem(ctx.handoffStore, {
      id: handoffIdFor('route'),
      repoId: ctx.repoId,
      title: 'Work blocked pending decision',
      severity: policy.decision === 'denied' ? 'blocked' : 'needs_review',
      creationReason: !input.modeInput.scopeClear
        ? 'invalid_objective'
        : policy.decision === 'approval_required'
          ? (input.modeInput.destructive ? 'destructive_action_requires_confirmation' : 'policy_approval_required')
          : 'missing_authorization',
      reason: mode.reason,
      summary: `Handoff-only routing: ${mode.reason}`,
      currentState: {
        repoId: ctx.repoId,
        mode: 'handoff_only',
        statusSummary: 'waiting for ChatGPT or user decision; no execution started',
        blockedBy: mode.missingContractFields,
      },
      attemptedActions: ['route_execution_mode'],
      evidenceRefs: [],
      blockingDecision: policy.decision === 'approval_required'
        ? 'Approve side effects or restate a safer objective.'
        : 'Clarify objective, scope, and acceptance criteria.',
      recommendedDecision: 'Provide a clear objective and authorization, or cancel the request.',
      recommendedPrompt: `Resolve handoff and restate work for repo ${ctx.repoId}.`,
      recommendedContinuationPrompt: `After approval, start the approved work for ${ctx.repoId}.`,
      approvalAction: policy.decision === 'approval_required'
        ? {
            operation: 'start',
            label: 'Approve and start work',
            summary: 'Create the work contract with the original scope and explicit approval.',
            risk: input.modeInput.destructive ? 'destructive' : 'workspace_write',
            payload: {
              objective: input.objective,
              acceptanceCriteria: input.acceptanceCriteria,
              allowedPaths: input.allowedPaths,
              forbiddenPaths: input.forbiddenPaths,
              checkIds: input.checks,
              expectedFiles: input.modeInput.expectedFiles,
              expectedChangedLines: input.modeInput.expectedChangedLines,
              scopeClear: input.modeInput.scopeClear,
              requiresInvestigation: input.modeInput.requiresInvestigation,
              requiresLongRunningChecks: input.modeInput.requiresLongRunningChecks,
              requiresWorker: input.modeInput.requiresWorker,
              requiresApproval: input.modeInput.requiresApproval === true || input.modeInput.requiresUserApproval === true,
              destructive: input.modeInput.destructive === true,
              approvalConfirmed: true,
              forceMode: 'goal_workloop',
            },
          }
        : undefined,
      suggestedNextActions: [
        {
          label: 'Review handoff inbox',
          tool: 'rh_inbox',
          operation: 'list',
          risk: 'readonly',
          confidence: 'high',
        },
      ],
    });

    return buildFacadeResult({
      status: policy.decision === 'denied' ? 'blocked' : policy.decision === 'approval_required' ? 'approval_required' : 'blocked',
      summary: `Handoff-only: no WorkContract created and no execution started. ${mode.reason}`,
      data: {
        mode,
        policy,
        workContractCreated: false,
        handoffId: handoff.id,
        handoff: {
          id: handoff.id,
          status: handoff.status,
          reason: handoff.reason,
          blockingDecision: handoff.blockingDecision,
        },
      },
      warnings: policy.warnings,
      suggestedNextActions: [
        {
          label: 'Read handoff',
          tool: 'rh_inbox',
          operation: 'get',
          payload: { handoff_id: handoff.id },
          risk: 'readonly',
          confidence: 'high',
        },
      ],
      evidenceRefs: [],
      rawAvailable: false,
    });
  }

  return startGoalWorkloop(ctx, input, policy);
}

export function startGoalWorkloop(
  ctx: GoalWorkloopContext,
  input: GoalWorkloopStartInput,
  policy?: PolicyDecision,
): FacadeResult {
  const at = nowIso(ctx);
  const available = ctx.availableChecks ?? [];
  const normalized = normalizeCheckIds(input.checks ?? [], available);
  const needsWorktree = true;
  const work = createWorkContract(ctx.workStore, {
    workId: workIdFor(input.objective),
    repoId: ctx.repoId,
    mode: 'goal_workloop',
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    constraints: input.constraints ?? { requireHandoffOnAmbiguity: true },
    status: 'running',
    issueId: input.issueId,
    taskId: input.taskId,
    scopeSummary: input.modeInput.scopeClear ? 'scope declared at start' : 'scope incomplete',
    allowedPaths: input.allowedPaths ?? [],
    forbiddenPaths: input.forbiddenPaths ?? [],
    checks: normalized.validCheckIds,
    driver: {
      preferred: input.modeInput.requiresWorker ? 'codex_worker' : 'isolated_worktree',
      allowWorker: true,
      allowDirectEdit: false,
    },
    worktreePolicy: {
      required: needsWorktree,
      reason: 'Goal workloop isolates multi-step work in a worktree by default.',
    },
    evidencePolicy: {
      defaultDetailLevel: 'summary',
      allowRawOptIn: true,
      maxEvidenceRefs: 20,
    },
    approvalPolicy: {
      required: input.modeInput.requiresApproval === true || input.modeInput.requiresUserApproval === true,
      reasons: input.modeInput.requiresApproval || input.modeInput.requiresUserApproval ? ['approval requested at start'] : [],
      confirmed: input.approvalConfirmed === true,
    },
    recoveryPolicy: {
      allowSelfHealing: true,
      maxInfrastructureRetries: 3,
      handoffOnAmbiguity: true,
    },
    requestedBy: input.requestedBy ?? 'chatgpt',
    evidenceRefs: [initialEvidence(input.objective)],
    policyDecisions: policy ? [policy] : [],
    suggestedNextActions: [],
    continuationPrompt: `Continue work ${ctx.repoId}: ${input.objective.slice(0, 200)}`,
  });

  const suggested = suggestedForWork(work, normalized.suggestedNextActions);
  const updated = updateWorkContract(ctx.workStore, work.workId, {
    suggestedNextActions: suggested,
    updatedAt: at,
  });

  return buildFacadeResult({
    status: 'ok',
    summary: `Goal workloop started as ${updated.workId}.`,
    data: {
      mode: { mode: 'goal_workloop', reason: 'WorkContract created for multi-step recoverable work.', createWorkContract: true, createHandoff: false, missingContractFields: [] },
      workContractCreated: true,
      work: summarizeWorkContract(updated),
      worktreeRequired: updated.worktreePolicy.required,
      normalizedChecks: normalized,
      policy,
    },
    evidenceRefs: updated.evidenceRefs,
    warnings: normalized.warnings,
    suggestedNextActions: suggested,
    rawAvailable: false,
  });
}

export function continueGoalWorkloop(ctx: GoalWorkloopContext, input: GoalWorkloopContinueInput): FacadeResult {
  const work = getWorkContract(ctx.workStore, input.workId);
  if (!work) {
    return buildFacadeResult({
      status: 'not_found',
      summary: `WorkContract ${input.workId} not found.`,
      data: { workId: input.workId },
      suggestedNextActions: [{ label: 'List work status', tool: 'rh_status', operation: 'get', risk: 'readonly' }],
    });
  }

  if (work.status === 'cancelled' || work.status === 'succeeded' || work.status === 'failed') {
    return buildFacadeResult({
      status: 'blocked',
      summary: `WorkContract ${work.workId} is terminal (${work.status}); continue is not allowed.`,
      data: { work: summarizeWorkContract(work) },
      suggestedNextActions: [
        {
          label: 'Inspect work via context',
          tool: 'rh_context',
          operation: 'get',
          payload: { work_id: work.workId },
          risk: 'readonly',
        },
      ],
    });
  }

  const history = reconcileVerificationHistory(
    work.checkRefs.map((record) => ({ checkId: record.checkId, outcome: record.outcome, recordedAt: record.recordedAt })),
  );

  // Ambiguous: acceptance failure present → handoff for ChatGPT review rather than pretend progress.
  if (history.acceptanceFailures.length > 0 && work.recoveryPolicy.handoffOnAmbiguity) {
    const handoff = createHandoffItem(ctx.handoffStore, {
      id: handoffIdFor('continue'),
      repoId: ctx.repoId,
      workId: work.workId,
      title: 'Acceptance failure needs review',
      severity: 'needs_review',
      creationReason: 'ambiguous_outcome',
      reason: `Acceptance checks failed: ${history.acceptanceFailures.join(', ')}`,
      summary: 'Continue paused; ChatGPT must decide repair vs re-scope.',
      currentState: {
        repoId: ctx.repoId,
        workId: work.workId,
        mode: work.mode,
        statusSummary: 'waiting_for_review after acceptance failure',
        checks: history.acceptanceFailures.map((checkId) => ({ checkId, ok: false, outcome: 'valid_fail' as const })),
      },
      attemptedActions: ['continue'],
      evidenceRefs: work.evidenceRefs.slice(0, 5),
      blockingDecision: 'Decide whether to repair code, adjust acceptance criteria, or stop.',
      recommendedDecision: 'Inspect evidence and either repair or stop the workloop.',
      recommendedPrompt: work.continuationPrompt ?? `Continue from work ${work.workId}.`,
      recommendedContinuationPrompt: work.continuationPrompt,
      suggestedNextActions: [
        {
          label: 'Read work context',
          tool: 'rh_context',
          operation: 'get',
          payload: { work_id: work.workId },
          risk: 'readonly',
        },
      ],
    });
    const updated = updateWorkContract(ctx.workStore, work.workId, {
      status: 'waiting_for_review',
      handoffRefs: [handoff.id, ...work.handoffRefs],
    });
    appendWorkHandoffRef(ctx.workStore, work.workId, handoff.id);

    return buildFacadeResult({
      status: 'blocked',
      summary: `Continue paused for ChatGPT review; handoff ${handoff.id} created. No background execution pretended.`,
      data: {
        work: summarizeWorkContract(updated),
        handoffId: handoff.id,
        acceptanceFailures: history.acceptanceFailures,
        infrastructureIssues: history.infrastructureIssues,
        backgroundCompleted: false,
      },
      evidenceRefs: work.evidenceRefs.slice(0, 5),
      suggestedNextActions: [
        {
          label: 'Get handoff',
          tool: 'rh_inbox',
          operation: 'get',
          payload: { handoff_id: handoff.id },
          risk: 'readonly',
          confidence: 'high',
        },
      ],
    });
  }

  // Infrastructure issues: suggest self-healing, not acceptance failure.
  if (history.infrastructureIssues.length > 0) {
    const updated = updateWorkContract(ctx.workStore, work.workId, {
      status: 'running',
      suggestedNextActions: [
        {
          label: 'Diagnose runtime (dry-run)',
          tool: 'rh_work',
          operation: 'repair',
          payload: { work_id: work.workId, repair_operation: 'diagnose', dry_run: true },
          risk: 'readonly',
          confidence: 'high',
          reason: 'Infrastructure failure is not an acceptance failure.',
        },
        ...suggestedForWork(work),
      ],
    });
    return buildFacadeResult({
      status: 'ok',
      summary: `Continue: infrastructure issues detected for ${history.infrastructureIssues.join(', ')}; suggest self-healing, not acceptance failure.`,
      data: {
        work: summarizeWorkContract(updated),
        infrastructureIssues: history.infrastructureIssues,
        acceptanceFailures: [],
        backgroundCompleted: false,
        nextStep: 'repair_or_reverify',
      },
      warnings: ['infrastructure_failure ≠ acceptance_failure'],
      suggestedNextActions: updated.suggestedNextActions,
    });
  }

  if (work.checks.length > 0 && history.validPasses.length < work.checks.length) {
    const remaining = work.checks.filter((checkId) => !history.validPasses.includes(checkId));
    const suggested = validateSuggestedNextActions(
      remaining.map((checkId) => ({
        label: `Verify ${checkId}`,
        tool: 'rh_work' as const,
        operation: 'verify',
        payload: { work_id: work.workId, check_id: checkId },
        risk: 'workspace_write' as const,
        confidence: 'high' as const,
      })),
      { validCheckIds: work.checks },
    ).actions;
    const updated = updateWorkContract(ctx.workStore, work.workId, {
      status: 'running',
      suggestedNextActions: suggested,
      continuationPrompt: input.note
        ? `${work.continuationPrompt ?? ''}\nNote: ${input.note}`.slice(0, 2_000)
        : work.continuationPrompt,
    });
    return buildFacadeResult({
      status: 'ok',
      summary: `Continue: next step is verification of ${remaining[0]}. No background work was completed.`,
      data: {
        work: summarizeWorkContract(updated),
        remainingChecks: remaining,
        backgroundCompleted: false,
        nextStep: 'verify',
      },
      suggestedNextActions: suggested,
    });
  }

  const suggested = validateSuggestedNextActions([
    {
      label: 'Finalize work',
      tool: 'rh_work',
      operation: 'finalize',
      payload: { work_id: work.workId },
      risk: 'readonly',
      confidence: 'high',
    },
  ]).actions;
  const updated = updateWorkContract(ctx.workStore, work.workId, {
    status: 'running',
    suggestedNextActions: suggested,
  });
  return buildFacadeResult({
    status: 'ok',
    summary: `Continue: checks satisfied or none required; ready to finalize after ChatGPT review.`,
    data: {
      work: summarizeWorkContract(updated),
      backgroundCompleted: false,
      nextStep: 'finalize',
    },
    suggestedNextActions: suggested,
  });
}

export function verifyGoalWorkloop(ctx: GoalWorkloopContext, input: GoalWorkloopVerifyInput): FacadeResult {
  const work = getWorkContract(ctx.workStore, input.workId);
  if (!work) {
    return buildFacadeResult({
      status: 'not_found',
      summary: `WorkContract ${input.workId} not found.`,
      data: { workId: input.workId },
    });
  }

  const available = ctx.availableChecks ?? work.checks.map((id) => ({ id }));
  const classified = classifyVerificationOutcome({
    checkId: input.checkId,
    available,
    infrastructureFailed: input.infrastructureFailed,
    checkFailed: input.checkFailed,
    skipped: input.skipped,
  });

  const at = nowIso(ctx);
  const record: VerificationRecord = {
    checkId: classified.normalizedCheckId ?? classified.checkId,
    outcome: classified.outcome,
    summary: classified.summary,
    recordedAt: at,
    evidenceRef: {
      title: `verification:${classified.outcome}`,
      summary: classified.summary,
      detailLevel: 'summary',
    },
  };

  // Supersede prior invalid/infrastructure noise when a valid outcome arrives for the same check.
  let checkRefs = work.checkRefs;
  if (classified.outcome === 'valid_pass' || classified.outcome === 'valid_fail') {
    checkRefs = work.checkRefs.map((existing) => {
      if (
        existing.checkId === record.checkId
        && (existing.outcome === 'invalid_check_id' || existing.outcome === 'infrastructure_failure')
      ) {
        return { ...existing, outcome: 'superseded' as const, summary: `Superseded by ${classified.outcome} at ${at}` };
      }
      return existing;
    });
    updateWorkContract(ctx.workStore, work.workId, { checkRefs });
  }

  const updated = appendVerificationRecord(ctx.workStore, work.workId, record);
  if (record.evidenceRef) appendWorkEvidence(ctx.workStore, work.workId, record.evidenceRef);

  const status =
    classified.outcome === 'invalid_check_id' || classified.outcome === 'infrastructure_failure'
      ? 'ok'
      : classified.outcome === 'valid_fail'
        ? 'failed'
        : 'ok';

  const suggested = validateSuggestedNextActions(
    classified.outcome === 'valid_pass'
      ? [{
          label: 'Continue workloop',
          tool: 'rh_work',
          operation: 'continue',
          payload: { work_id: work.workId },
          risk: 'readonly',
          confidence: 'high',
        }]
      : classified.outcome === 'valid_fail'
        ? [{
            label: 'Continue for review handoff',
            tool: 'rh_work',
            operation: 'continue',
            payload: { work_id: work.workId },
            risk: 'readonly',
            confidence: 'high',
          }]
        : [{
            label: 'Diagnose infrastructure (dry-run)',
            tool: 'rh_work',
            operation: 'repair',
            payload: { work_id: work.workId, repair_operation: 'diagnose', dry_run: true },
            risk: 'readonly',
            confidence: 'high',
          }],
    { validCheckIds: work.checks },
  ).actions;

  return buildFacadeResult({
    status: status === 'failed' ? 'failed' : 'ok',
    summary: classified.summary,
    data: {
      work: summarizeWorkContract(updated),
      verification: {
        checkId: record.checkId,
        outcome: classified.outcome,
        isAcceptanceFailure: classified.isAcceptanceFailure,
        isInfrastructureIssue: classified.isInfrastructureIssue,
        // Explicitly separate pollution classes for ChatGPT.
        doesNotRequestTaskChanges: !classified.isAcceptanceFailure,
      },
      backgroundCompleted: false,
    },
    warnings: classified.warnings,
    evidenceRefs: record.evidenceRef ? [record.evidenceRef] : [],
    suggestedNextActions: suggested,
  });
}

export function finalizeGoalWorkloop(ctx: GoalWorkloopContext, input: GoalWorkloopFinalizeInput): FacadeResult {
  const work = getWorkContract(ctx.workStore, input.workId);
  if (!work) {
    return buildFacadeResult({
      status: 'not_found',
      summary: `WorkContract ${input.workId} not found.`,
      data: { workId: input.workId },
    });
  }

  if (work.status === 'cancelled') {
    return buildFacadeResult({
      status: 'blocked',
      summary: `WorkContract ${work.workId} was cancelled; finalize is not allowed.`,
      data: { work: summarizeWorkContract(work) },
    });
  }

  const history = reconcileVerificationHistory(
    work.checkRefs.map((record) => ({ checkId: record.checkId, outcome: record.outcome, recordedAt: record.recordedAt })),
  );

  if (input.forceFailed || history.acceptanceFailures.length > 0) {
    const updated = updateWorkContract(ctx.workStore, work.workId, { status: 'failed' });
    return buildFacadeResult({
      status: 'failed',
      summary: `Finalize result: failed. Acceptance failures: ${history.acceptanceFailures.join(', ') || 'forced'}.`,
      data: {
        work: summarizeWorkContract(updated),
        finalStatus: 'failed',
        acceptanceFailures: history.acceptanceFailures,
        infrastructureIssues: history.infrastructureIssues,
        invalidCheckIds: history.invalidCheckIds,
        // Failures are not hidden.
        hiddenFailure: false,
      },
      suggestedNextActions: [
        {
          label: 'List handoffs',
          tool: 'rh_inbox',
          operation: 'list',
          risk: 'readonly',
        },
      ],
    });
  }

  // Invalid check ids and infrastructure issues do not force failure, but may require review.
  if (history.infrastructureIssues.length > 0 || (work.checks.length > 0 && history.validPasses.length === 0 && work.acceptanceCriteria.length > 0)) {
    const updated = updateWorkContract(ctx.workStore, work.workId, { status: 'waiting_for_review' });
    return buildFacadeResult({
      status: 'blocked',
      summary: 'Finalize result: waiting_for_review. Evidence is incomplete or infrastructure issues remain; failure is not hidden.',
      data: {
        work: summarizeWorkContract(updated),
        finalStatus: 'waiting_for_review',
        infrastructureIssues: history.infrastructureIssues,
        invalidCheckIds: history.invalidCheckIds,
        validPasses: history.validPasses,
        hiddenFailure: false,
      },
      suggestedNextActions: [
        {
          label: 'Continue workloop',
          tool: 'rh_work',
          operation: 'continue',
          payload: { work_id: work.workId },
          risk: 'readonly',
        },
      ],
    });
  }

  const updated = updateWorkContract(ctx.workStore, work.workId, { status: 'succeeded' });
  return buildFacadeResult({
    status: 'ok',
    summary: `Finalize result: succeeded for ${work.workId}.`,
    data: {
      work: summarizeWorkContract(updated),
      finalStatus: 'succeeded',
      validPasses: history.validPasses,
      hiddenFailure: false,
    },
    evidenceRefs: work.evidenceRefs.slice(0, 5),
    suggestedNextActions: [
      {
        label: 'Read controller status',
        tool: 'rh_status',
        operation: 'get',
        risk: 'readonly',
      },
    ],
  });
}

export function stopGoalWorkloop(ctx: GoalWorkloopContext, input: GoalWorkloopStopInput): FacadeResult {
  const work = getWorkContract(ctx.workStore, input.workId);
  if (!work) {
    return buildFacadeResult({
      status: 'not_found',
      summary: `WorkContract ${input.workId} not found.`,
      data: { workId: input.workId },
    });
  }

  const destructiveCleanup = input.authorizeDestructiveCleanup === true;
  const updated = updateWorkContract(ctx.workStore, work.workId, {
    status: 'cancelled',
    continuationPrompt: input.reason
      ? `Stopped: ${input.reason}`.slice(0, 2_000)
      : work.continuationPrompt,
    // Evidence is retained; worktree is not force-deleted without authorization.
    worktreeRef: destructiveCleanup ? undefined : work.worktreeRef,
  });

  return buildFacadeResult({
    status: 'ok',
    summary: `WorkContract ${work.workId} cancelled/stopped. Evidence retained. Worktree cleanup ${destructiveCleanup ? 'authorized' : 'not performed'}.`,
    data: {
      work: summarizeWorkContract(updated),
      finalStatus: 'cancelled',
      evidenceRetained: true,
      worktreeDeleted: destructiveCleanup && Boolean(work.worktreeRef),
      destructiveCleanupAuthorized: destructiveCleanup,
    },
    evidenceRefs: work.evidenceRefs.slice(0, 5),
    suggestedNextActions: [
      {
        label: 'List pending handoffs',
        tool: 'rh_inbox',
        operation: 'list',
        risk: 'readonly',
      },
    ],
  });
}

export function runGoalWorkloop(
  ctx: GoalWorkloopContext,
  operation: GoalWorkloopOperation,
  args: Record<string, unknown>,
): FacadeResult {
  switch (operation) {
    case 'start':
      return routeWorkStart(ctx, {
        objective: String(args.objective ?? ''),
        acceptanceCriteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String) : undefined,
        allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
        forbiddenPaths: Array.isArray(args.forbidden_paths) ? args.forbidden_paths.map(String) : undefined,
        checks: Array.isArray(args.check_ids) ? args.check_ids.map(String) : undefined,
        modeInput: {
          objective: typeof args.objective === 'string' ? args.objective : undefined,
          expectedFiles: typeof args.expected_files === 'number' ? args.expected_files : undefined,
          expectedChangedLines: typeof args.expected_changed_lines === 'number' ? args.expected_changed_lines : undefined,
          scopeClear: args.scope_clear === undefined ? true : args.scope_clear === true,
          requiresInvestigation: args.requires_investigation === true,
          requiresLongRunningChecks: args.requires_long_running_checks === true,
          requiresParallelism: args.requires_parallelism === true,
          needsDependencies: args.needs_dependencies === true,
          requiresRecovery: args.requires_recovery === true,
          requiresWorker: args.requires_worker === true,
          requiresExternalEffect: args.requires_external_effect === true,
          requiresApproval: args.requires_approval === true,
          requiresUserApproval: args.requires_user_approval === true,
          destructive: args.destructive === true,
          remoteWrite: args.remote_write === true,
          secretAccess: args.secret_access === true,
          risk: typeof args.risk === 'string' ? args.risk as CapabilityRisk : undefined,
        },
        requestedBy: args.requested_by === 'user' || args.requested_by === 'system' || args.requested_by === 'scheduler' ? args.requested_by : 'chatgpt',
        taskId: typeof args.task_id === 'string' ? args.task_id : undefined,
        issueId: typeof args.issue_id === 'string' ? args.issue_id : undefined,
        approvalConfirmed: args.approval_confirmed === true,
        dryRun: args.dry_run === true,
        forceMode: args.force_mode === 'direct_control' || args.force_mode === 'goal_workloop' || args.force_mode === 'handoff_only'
          ? args.force_mode
          : undefined,
      });
    case 'continue':
      return continueGoalWorkloop(ctx, {
        workId: String(args.work_id ?? ''),
        note: typeof args.note === 'string' ? args.note : undefined,
      });
    case 'verify':
      return verifyGoalWorkloop(ctx, {
        workId: String(args.work_id ?? ''),
        checkId: String(args.check_id ?? args.checkId ?? ''),
        infrastructureFailed: args.infrastructure_failed === true,
        checkFailed: args.check_failed === true,
        skipped: args.skipped === true,
      });
    case 'finalize':
      return finalizeGoalWorkloop(ctx, {
        workId: String(args.work_id ?? ''),
        forceFailed: args.force_failed === true,
      });
    case 'stop':
      return stopGoalWorkloop(ctx, {
        workId: String(args.work_id ?? ''),
        reason: typeof args.reason === 'string' ? args.reason : undefined,
        authorizeDestructiveCleanup: args.authorize_destructive_cleanup === true,
      });
    default:
      return buildFacadeResult({
        status: 'failed',
        summary: `Unknown goal workloop operation: ${String(operation)}`,
        data: { operation },
      });
  }
}
