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

export interface CodexContextPack {
  schemaVersion: 1;
  workId?: string;
  repoId: string;
  objective: string;
  acceptanceCriteria: string[];
  constraints: WorkContract['constraints'];
  relevantFilesSummary: string[];
  policyBoundaries: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  currentEvidenceRefs: EvidenceRef[];
  expectedOutputFormat: {
    mustProduce: Array<'evidence_artifact' | 'handoff_item' | 'patch_proposal' | 'suggested_next_actions'>;
    mustNot: string[];
  };
}

export interface CodexDelegationInput {
  workId?: string;
  objective: string;
  acceptanceCriteria?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  constraints?: WorkContract['constraints'];
  relevantFilesSummary?: string[];
  policyBoundaries?: string[];
  evidenceRefs?: EvidenceRef[];
  /** When false/undefined, Codex is treated as unavailable. */
  codexAvailable?: boolean;
  /** Simulated or observed Codex worker output. */
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

export function buildCodexContextPack(input: CodexDelegationInput & { repoId: string; work?: WorkContract }): CodexContextPack {
  const work = input.work;
  return {
    schemaVersion: 1,
    workId: input.workId ?? work?.workId,
    repoId: input.repoId,
    objective: (input.objective || work?.objective || '').slice(0, 2_000),
    acceptanceCriteria: (input.acceptanceCriteria ?? work?.acceptanceCriteria ?? []).slice(0, 20),
    constraints: input.constraints ?? work?.constraints ?? { requireHandoffOnAmbiguity: true },
    relevantFilesSummary: (input.relevantFilesSummary ?? []).slice(0, 30).map((entry) => entry.slice(0, 200)),
    policyBoundaries: (input.policyBoundaries ?? [
      'Codex/Claude is a bounded executor, not the controller.',
      'Do not finalize WorkContract.',
      'Do not return raw secrets, tokens, or full runtime state.',
      'Output must be evidence / handoff / patch proposal / suggested_next_actions only.',
    ]).slice(0, 20),
    allowedPaths: (input.allowedPaths ?? work?.allowedPaths ?? []).slice(0, 50),
    forbiddenPaths: (input.forbiddenPaths ?? work?.forbiddenPaths ?? ['.env', '_ops/secrets', '**/*secret*']).slice(0, 50),
    currentEvidenceRefs: (input.evidenceRefs ?? work?.evidenceRefs ?? []).slice(0, 10),
    expectedOutputFormat: {
      mustProduce: ['evidence_artifact', 'handoff_item', 'patch_proposal', 'suggested_next_actions'],
      mustNot: [
        'finalize_work_contract',
        'mutate_mainline_state_directly',
        'return_raw_stdout_stderr',
        'return_secrets_or_tokens',
      ],
    },
  };
}

function handoffId(prefix: string): string {
  return `hnd-codex-${prefix}-${randomUUID().slice(0, 8)}`;
}

/**
 * Safe Codex/Claude cerebellum delegation.
 * Never finalizes WorkContract; ChatGPT/rh_work must review before finalize.
 */
export function delegateToCodexCerebellum(
  ctx: CodexDelegationContext,
  input: CodexDelegationInput,
): FacadeResult {
  const work = input.workId && ctx.workStore
    ? getWorkContract(ctx.workStore, input.workId)
    : undefined;

  const pack = buildCodexContextPack({
    ...input,
    repoId: ctx.repoId,
    work,
  });

  // Codex unavailable → self-healing / handoff, not acceptance failure.
  if (input.codexAvailable === false) {
    const handoff = createHandoffItem(ctx.handoffStore, {
      id: handoffId('unavailable'),
      repoId: ctx.repoId,
      workId: work?.workId,
      title: 'Codex/Claude executor unavailable',
      severity: 'needs_review',
      creationReason: 'repeated_infrastructure_failure',
      reason: 'Codex/Claude cerebellum is unavailable; this is an infrastructure/recovery issue, not acceptance failure.',
      summary: 'Worker executor unavailable. Prefer self-healing diagnose or retry later.',
      currentState: {
        repoId: ctx.repoId,
        workId: work?.workId,
        mode: work?.mode,
        statusSummary: 'codex unavailable; waiting for recovery or alternate path',
      },
      attemptedActions: ['codex_delegate'],
      evidenceRefs: pack.currentEvidenceRefs.slice(0, 5),
      blockingDecision: 'Retry when Codex is available, use Direct Control for small fixes, or repair runtime.',
      recommendedDecision: 'Run self-healing diagnose (dry-run) or reassign to ChatGPT direct control if scope is small.',
      recommendedPrompt: pack.objective,
      recommendedContinuationPrompt: `Codex unavailable for ${ctx.repoId}. Prefer rh_work repair diagnose or direct_control if small.`,
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
        title: 'codex unavailable',
        summary: 'Executor unavailable classified as infrastructure, not acceptance failure.',
        detailLevel: 'summary',
      });
    }

    return buildFacadeResult({
      status: 'blocked',
      summary: 'Codex/Claude unavailable. Created recovery handoff; not an acceptance failure.',
      data: {
        codexAvailable: false,
        isAcceptanceFailure: false,
        isInfrastructureIssue: true,
        handoffId: handoff.id,
        contextPack: pack,
        canFinalize: false,
      },
      evidenceRefs: [{
        title: 'codex unavailable',
        summary: 'Worker executor unavailable',
        detailLevel: 'summary',
      }],
      suggestedNextActions: handoff.suggestedNextActions,
    });
  }

  const uncertain = input.workerOutput?.uncertain === true;
  const evidence: EvidenceRef = {
    title: 'codex worker evidence',
    summary: (input.workerOutput?.evidenceSummary || input.workerOutput?.summary || 'Codex produced bounded output.').slice(0, 500),
    detailLevel: 'summary',
  };

  const patchProposal = input.workerOutput?.patchProposal
    ? { present: true, summary: input.workerOutput.patchProposal.slice(0, 500) }
    : { present: false, summary: 'No patch proposal yet.' };

  // Uncertain output → handoff for ChatGPT review; never auto-finalize.
  if (uncertain) {
    const handoff = createHandoffItem(ctx.handoffStore, {
      id: handoffId('review'),
      repoId: ctx.repoId,
      workId: work?.workId,
      title: 'Codex output needs ChatGPT review',
      severity: 'needs_review',
      creationReason: 'codex_worker_requires_review',
      reason: 'Codex/Claude output is uncertain and requires ChatGPT judgement before finalize.',
      summary: (input.workerOutput?.summary || 'Worker output is uncertain.').slice(0, 500),
      currentState: {
        repoId: ctx.repoId,
        workId: work?.workId,
        mode: work?.mode,
        statusSummary: 'waiting_for_review after codex delegation',
      },
      attemptedActions: ['codex_delegate'],
      evidenceRefs: [evidence],
      blockingDecision: 'Accept patch proposal, request revision, or stop.',
      recommendedDecision: 'Review evidence and patch proposal before finalize.',
      recommendedPrompt: pack.objective,
      recommendedContinuationPrompt: work?.continuationPrompt ?? `Review codex output for ${ctx.repoId}.`,
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
      summary: 'Codex output is uncertain; handoff created for ChatGPT review. Finalize is not allowed from cerebellum.',
      data: {
        codexAvailable: true,
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
      workerRef: `codex:${randomUUID().slice(0, 8)}`,
    });
  }

  return buildFacadeResult({
    status: 'ok',
    summary: 'Codex cerebellum returned bounded outputs. ChatGPT/rh_work must review before finalize.',
    data: {
      codexAvailable: true,
      uncertain: false,
      canFinalize: false,
      contextPack: pack,
      outputs: {
        evidenceArtifact: evidence,
        handoffItem: null,
        patchProposal,
        suggestedNextActions: suggested,
      },
      // Explicit: cerebellum must not finalize.
      finalizeBlockedReason: 'Codex/Claude cannot finalize; ChatGPT must call rh_work finalize after review.',
    },
    evidenceRefs: [evidence],
    suggestedNextActions: suggested,
    rawAvailable: false,
  });
}
