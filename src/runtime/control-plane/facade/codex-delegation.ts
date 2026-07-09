import { randomUUID } from 'crypto';
import { createHandoffItem, type HandoffInboxStoreOptions } from './handoff-inbox-store';
import {
  appendWorkEvidence,
  appendWorkHandoffRef,
  getWorkContract,
  updateWorkContract,
  type WorkContractStoreOptions,
} from './work-contract-store';
import { buildFacadeResult } from './facade-result';
import { validateSuggestedNextActions } from './suggested-actions';
import type {
  EvidenceRef,
  FacadeResult,
  SuggestedNextAction,
  WorkContract,
} from './types';

export type DelegateTarget = 'codex' | 'grok' | 'claude';

export interface CodexContextPack {
  schemaVersion: 1;
  workId?: string;
  repoId: string;
  target: DelegateTarget;
  objective: string;
  acceptanceCriteria: string[];
  constraints: WorkContract['constraints'];
  relevantFilesSummary: string[];
  policyBoundaries: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  currentEvidenceRefs: EvidenceRef[];
  workContractState?: {
    workId: string;
    status: WorkContract['status'];
    mode: WorkContract['mode'];
  };
  policyDecision?: string;
  expectedOutputFormat: {
    mustProduce: Array<'evidence_artifact' | 'handoff_item' | 'patch_proposal' | 'suggested_next_actions'>;
    mustNot: string[];
  };
}

export interface GrokDelegateRequestPacket {
  schemaVersion: 1;
  requestId: string;
  target: 'grok';
  mode: 'bounded_handoff_request';
  repoId: string;
  workId?: string;
  objective: string;
  acceptanceCriteria: string[];
  constraints: WorkContract['constraints'];
  allowedPaths: string[];
  forbiddenPaths: string[];
  relevantFilesSummary: string[];
  policyBoundaries: string[];
  currentEvidenceRefs: EvidenceRef[];
  requiredOutputFormat: CodexContextPack['expectedOutputFormat'];
  instructions: string[];
  /** Direct Grok execution is not assumed available; ChatGPT remains authority. */
  directExecutionAvailable: false;
  returnPath: 'evidence_or_handoff_for_chatgpt_review';
}

export interface CodexDelegationInput {
  workId?: string;
  target?: DelegateTarget;
  objective: string;
  acceptanceCriteria?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  constraints?: WorkContract['constraints'];
  relevantFilesSummary?: string[];
  policyBoundaries?: string[];
  evidenceRefs?: EvidenceRef[];
  policyDecision?: string;
  /** When false, target executor is treated as unavailable. Defaults: codex/claude true if not set; grok false for direct exec. */
  available?: boolean;
  /** @deprecated Use available. Kept for stage-2 callers. */
  codexAvailable?: boolean;
  workerOutput?: {
    uncertain?: boolean;
    summary?: string;
    patchProposal?: string;
    evidenceSummary?: string;
  };
}

export interface CodexDelegationContext {
  repoId: string;
  workStore?: WorkContractStoreOptions;
  handoffStore: HandoffInboxStoreOptions;
  now?: () => string;
}

function normalizeTarget(value: unknown): DelegateTarget {
  if (value === 'grok' || value === 'claude' || value === 'codex') return value;
  return 'codex';
}

export function buildCodexContextPack(input: CodexDelegationInput & { repoId: string; work?: WorkContract }): CodexContextPack {
  const work = input.work;
  const target = normalizeTarget(input.target);
  return {
    schemaVersion: 1,
    workId: input.workId ?? work?.workId,
    repoId: input.repoId,
    target,
    objective: (input.objective || work?.objective || '').slice(0, 2_000),
    acceptanceCriteria: (input.acceptanceCriteria ?? work?.acceptanceCriteria ?? []).slice(0, 20),
    constraints: input.constraints ?? work?.constraints ?? { requireHandoffOnAmbiguity: true },
    relevantFilesSummary: (input.relevantFilesSummary ?? []).slice(0, 30).map((entry) => entry.slice(0, 200)),
    policyBoundaries: (input.policyBoundaries ?? [
      `${target} is a bounded small-brain executor, not the controller.`,
      'Do not finalize WorkContract.',
      'Do not push, merge, or perform destructive cleanup.',
      'Do not return raw secrets, tokens, auth config, or full runtime state.',
      'Output must be evidence / handoff / patch proposal / suggested_next_actions only.',
      'ChatGPT must review before rh_work.finalize.',
    ]).slice(0, 20),
    allowedPaths: (input.allowedPaths ?? work?.allowedPaths ?? []).slice(0, 50),
    forbiddenPaths: (input.forbiddenPaths ?? work?.forbiddenPaths ?? ['.env', '_ops/secrets', '**/*secret*', '**/*token*']).slice(0, 50),
    currentEvidenceRefs: (input.evidenceRefs ?? work?.evidenceRefs ?? []).slice(0, 10),
    workContractState: work
      ? { workId: work.workId, status: work.status, mode: work.mode }
      : undefined,
    policyDecision: input.policyDecision,
    expectedOutputFormat: {
      mustProduce: ['evidence_artifact', 'handoff_item', 'patch_proposal', 'suggested_next_actions'],
      mustNot: [
        'finalize_work_contract',
        'mutate_mainline_state_directly',
        'push_or_remote_write',
        'return_raw_stdout_stderr',
        'return_secrets_or_tokens',
      ],
    },
  };
}

export function prepareGrokDelegateRequest(
  input: CodexDelegationInput & { repoId: string; work?: WorkContract },
): GrokDelegateRequestPacket {
  const pack = buildCodexContextPack({ ...input, target: 'grok' });
  return {
    schemaVersion: 1,
    requestId: `grok-req-${randomUUID().slice(0, 10)}`,
    target: 'grok',
    mode: 'bounded_handoff_request',
    repoId: pack.repoId,
    workId: pack.workId,
    objective: pack.objective,
    acceptanceCriteria: pack.acceptanceCriteria,
    constraints: pack.constraints,
    allowedPaths: pack.allowedPaths,
    forbiddenPaths: pack.forbiddenPaths,
    relevantFilesSummary: pack.relevantFilesSummary,
    policyBoundaries: pack.policyBoundaries,
    currentEvidenceRefs: pack.currentEvidenceRefs,
    requiredOutputFormat: pack.expectedOutputFormat,
    instructions: [
      'Act as a parallel small-brain reviewer/implementer for ChatGPT.',
      'Return only bounded evidence, patch proposal, and suggested next actions.',
      'Do not finalize work, push, or request secrets.',
      'ChatGPT remains the primary controller and must review before finalize.',
    ],
    directExecutionAvailable: false,
    returnPath: 'evidence_or_handoff_for_chatgpt_review',
  };
}

function handoffId(prefix: string): string {
  return `hnd-delegate-${prefix}-${randomUUID().slice(0, 8)}`;
}

function targetAvailable(input: CodexDelegationInput, target: DelegateTarget): boolean {
  if (typeof input.available === 'boolean') return input.available;
  if (typeof input.codexAvailable === 'boolean' && (target === 'codex' || target === 'claude')) {
    return input.codexAvailable;
  }
  // Grok has no direct execution path in-repo; direct availability defaults to false.
  if (target === 'grok') return false;
  return true;
}

/**
 * Safe Codex/Claude/Grok cerebellum delegation.
 * Never finalizes WorkContract; ChatGPT/rh_work must review before finalize.
 */
export function delegateToCodexCerebellum(
  ctx: CodexDelegationContext,
  input: CodexDelegationInput,
): FacadeResult {
  const target = normalizeTarget(input.target);
  const work = input.workId && ctx.workStore
    ? getWorkContract(ctx.workStore, input.workId)
    : undefined;

  const pack = buildCodexContextPack({
    ...input,
    target,
    repoId: ctx.repoId,
    work,
  });

  // Grok: always prepare bounded request packet (direct execution not assumed).
  if (target === 'grok') {
    const request = prepareGrokDelegateRequest({
      ...input,
      target: 'grok',
      repoId: ctx.repoId,
      work,
    });
    const evidence: EvidenceRef = {
      title: 'grok_delegate_request',
      summary: `Bounded Grok handoff/request packet ${request.requestId} prepared for ChatGPT-mediated review.`,
      detailLevel: 'summary',
    };
    const handoff = createHandoffItem(ctx.handoffStore, {
      id: handoffId('grok'),
      repoId: ctx.repoId,
      workId: work?.workId,
      title: 'Grok small-brain request prepared',
      severity: 'needs_review',
      creationReason: 'codex_worker_requires_review',
      reason: 'Grok direct execution is unavailable in-controller; a bounded request packet was prepared for external/parallel review.',
      summary: 'Grok is treated as a parallel reviewer. Output must return via evidence/handoff for ChatGPT, not bypass ChatGPT.',
      currentState: {
        repoId: ctx.repoId,
        workId: work?.workId,
        mode: work?.mode,
        statusSummary: 'waiting_for_review after grok request prepare',
      },
      attemptedActions: ['grok_delegate_request_prepare'],
      evidenceRefs: [evidence],
      blockingDecision: 'Route packet to Grok out-of-band if desired, then return bounded results to ChatGPT for finalize decision.',
      recommendedDecision: 'Keep ChatGPT as authority; ingest Grok results as evidence only.',
      recommendedPrompt: pack.objective,
      recommendedContinuationPrompt: work?.continuationPrompt ?? `Review Grok request ${request.requestId} for ${ctx.repoId}.`,
      suggestedNextActions: [
        {
          label: 'Continue after Grok review',
          tool: 'rh_work',
          operation: 'continue',
          payload: { work_id: work?.workId },
          risk: 'readonly',
          confidence: 'medium',
        },
        {
          label: 'List handoffs',
          tool: 'rh_inbox',
          operation: 'list',
          risk: 'readonly',
        },
      ],
    });

    if (work && ctx.workStore) {
      updateWorkContract(ctx.workStore, work.workId, { status: 'waiting_for_review' });
      appendWorkHandoffRef(ctx.workStore, work.workId, handoff.id);
      appendWorkEvidence(ctx.workStore, work.workId, evidence);
    }

    return buildFacadeResult({
      status: 'blocked',
      summary: `Grok delegate prepared bounded request ${request.requestId}; direct execution unavailable. Not an acceptance failure.`,
      data: {
        target: 'grok',
        available: false,
        directExecutionAvailable: false,
        isAcceptanceFailure: false,
        isInfrastructureIssue: false,
        canFinalize: false,
        handoffId: handoff.id,
        contextPack: pack,
        grokDelegateRequest: request,
        outputs: {
          evidenceArtifact: evidence,
          handoffItem: { id: handoff.id, status: handoff.status },
          patchProposal: { present: false, summary: 'Awaiting external Grok response.' },
        },
        finalizeBlockedReason: 'Grok cannot finalize; ChatGPT must call rh_work finalize after review.',
      },
      evidenceRefs: [evidence],
      suggestedNextActions: handoff.suggestedNextActions,
      rawAvailable: false,
    });
  }

  // Codex/Claude unavailable → recovery handoff, not acceptance failure.
  if (!targetAvailable(input, target)) {
    const handoff = createHandoffItem(ctx.handoffStore, {
      id: handoffId('unavailable'),
      repoId: ctx.repoId,
      workId: work?.workId,
      title: `${target} executor unavailable`,
      severity: 'needs_review',
      creationReason: 'repeated_infrastructure_failure',
      reason: `${target} small-brain is unavailable; this is an infrastructure/recovery issue, not acceptance failure.`,
      summary: 'Worker executor unavailable. Prefer self-healing diagnose or retry later.',
      currentState: {
        repoId: ctx.repoId,
        workId: work?.workId,
        mode: work?.mode,
        statusSummary: `${target} unavailable; waiting for recovery or alternate path`,
      },
      attemptedActions: [`${target}_delegate`],
      evidenceRefs: pack.currentEvidenceRefs.slice(0, 5),
      blockingDecision: `Retry when ${target} is available, use Direct Control for small fixes, or repair runtime.`,
      recommendedDecision: 'Run self-healing diagnose (dry-run) or reassign to ChatGPT direct control if scope is small.',
      recommendedPrompt: pack.objective,
      recommendedContinuationPrompt: `${target} unavailable for ${ctx.repoId}. Prefer rh_work repair diagnose or direct_control if small.`,
      suggestedNextActions: [
        {
          label: 'Diagnose runtime (dry-run)',
          tool: 'rh_work',
          operation: 'repair',
          payload: { repair_operation: 'diagnose', dry_run: true, work_id: work?.workId },
          risk: 'readonly',
          confidence: 'high',
        },
        {
          label: 'Review handoffs',
          tool: 'rh_inbox',
          operation: 'list',
          risk: 'readonly',
        },
      ],
    });

    if (work && ctx.workStore) {
      updateWorkContract(ctx.workStore, work.workId, { status: 'blocked' });
      appendWorkHandoffRef(ctx.workStore, work.workId, handoff.id);
      appendWorkEvidence(ctx.workStore, work.workId, {
        title: `${target} unavailable`,
        summary: 'Executor unavailable classified as infrastructure, not acceptance failure.',
        detailLevel: 'summary',
      });
    }

    return buildFacadeResult({
      status: 'blocked',
      summary: `${target} unavailable. Created recovery handoff; not an acceptance failure.`,
      data: {
        target,
        available: false,
        isAcceptanceFailure: false,
        isInfrastructureIssue: true,
        handoffId: handoff.id,
        contextPack: pack,
        canFinalize: false,
      },
      evidenceRefs: [{
        title: `${target} unavailable`,
        summary: 'Worker executor unavailable',
        detailLevel: 'summary',
      }],
      suggestedNextActions: handoff.suggestedNextActions,
    });
  }

  const uncertain = input.workerOutput?.uncertain === true;
  const evidence: EvidenceRef = {
    title: `${target} worker evidence`,
    summary: (input.workerOutput?.evidenceSummary || input.workerOutput?.summary || `${target} produced bounded output.`).slice(0, 500),
    detailLevel: 'summary',
  };

  const patchProposal = input.workerOutput?.patchProposal
    ? { present: true, summary: input.workerOutput.patchProposal.slice(0, 500) }
    : { present: false, summary: 'No patch proposal yet.' };

  if (uncertain) {
    const handoff = createHandoffItem(ctx.handoffStore, {
      id: handoffId('review'),
      repoId: ctx.repoId,
      workId: work?.workId,
      title: `${target} output needs ChatGPT review`,
      severity: 'needs_review',
      creationReason: 'codex_worker_requires_review',
      reason: `${target} output is uncertain and requires ChatGPT judgement before finalize.`,
      summary: (input.workerOutput?.summary || 'Worker output is uncertain.').slice(0, 500),
      currentState: {
        repoId: ctx.repoId,
        workId: work?.workId,
        mode: work?.mode,
        statusSummary: 'waiting_for_review after small-brain delegation',
      },
      attemptedActions: [`${target}_delegate`],
      evidenceRefs: [evidence],
      blockingDecision: 'Accept patch proposal, request revision, or stop.',
      recommendedDecision: 'Review evidence and patch proposal before finalize.',
      recommendedPrompt: pack.objective,
      recommendedContinuationPrompt: work?.continuationPrompt ?? `Review ${target} output for ${ctx.repoId}.`,
      suggestedNextActions: [
        {
          label: 'Continue work after review',
          tool: 'rh_work',
          operation: 'continue',
          payload: { work_id: work?.workId },
          risk: 'readonly',
          confidence: 'medium',
        },
        {
          label: 'Read handoff',
          tool: 'rh_inbox',
          operation: 'list',
          risk: 'readonly',
        },
      ],
    });

    if (work && ctx.workStore) {
      updateWorkContract(ctx.workStore, work.workId, { status: 'waiting_for_review' });
      appendWorkHandoffRef(ctx.workStore, work.workId, handoff.id);
      appendWorkEvidence(ctx.workStore, work.workId, evidence);
    }

    return buildFacadeResult({
      status: 'blocked',
      summary: `${target} output is uncertain; handoff created for ChatGPT review. Finalize is not allowed from cerebellum.`,
      data: {
        target,
        available: true,
        uncertain: true,
        canFinalize: false,
        handoffId: handoff.id,
        patchProposal,
        contextPack: pack,
        outputs: {
          evidenceArtifact: evidence,
          handoffItem: { id: handoff.id, status: handoff.status },
          patchProposal,
        },
      },
      evidenceRefs: [evidence],
      suggestedNextActions: handoff.suggestedNextActions,
    });
  }

  const suggested: SuggestedNextAction[] = validateSuggestedNextActions([
    {
      label: 'Review and continue work',
      tool: 'rh_work',
      operation: 'continue',
      payload: { work_id: work?.workId },
      risk: 'readonly',
      confidence: 'high',
      reason: 'ChatGPT must review cerebellum output before finalize.',
    },
    {
      label: 'Verify registered checks',
      tool: 'rh_work',
      operation: 'verify',
      payload: { work_id: work?.workId, check_id: work?.checks[0] },
      risk: 'workspace_write',
      confidence: work?.checks[0] ? 'high' : 'low',
    },
  ], { validCheckIds: work?.checks ?? [] }).actions;

  if (work && ctx.workStore) {
    appendWorkEvidence(ctx.workStore, work.workId, evidence);
    updateWorkContract(ctx.workStore, work.workId, {
      status: 'running',
      suggestedNextActions: suggested,
      workerRef: `${target}:${randomUUID().slice(0, 8)}`,
    });
  }

  return buildFacadeResult({
    status: 'ok',
    summary: `${target} cerebellum returned bounded outputs. ChatGPT/rh_work must review before finalize.`,
    data: {
      target,
      available: true,
      uncertain: false,
      canFinalize: false,
      contextPack: pack,
      outputs: {
        evidenceArtifact: evidence,
        handoffItem: null,
        patchProposal,
        suggestedNextActions: suggested,
      },
      finalizeBlockedReason: `${target} cannot finalize; ChatGPT must call rh_work finalize after review.`,
    },
    evidenceRefs: [evidence],
    suggestedNextActions: suggested,
    rawAvailable: false,
  });
}
