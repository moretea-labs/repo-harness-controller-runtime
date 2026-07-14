import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildCodexContextPack,
  delegateToCodexCerebellum,
} from '../../src/runtime/control-plane/facade/codex-delegation';
import { createWorkContract, getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { listHandoffItems } from '../../src/runtime/control-plane/facade/handoff-inbox-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-codex-deleg-'));
  roots.push(root);
  const workStore = { root: join(root, 'work') };
  const handoffStore = { root: join(root, 'handoff') };
  const work = createWorkContract(workStore, {
    workId: 'work_codex_1',
    repoId: 'repo_test',
    mode: 'goal_workloop',
    objective: 'Implement bounded facade workloop',
    acceptanceCriteria: ['typecheck passes'],
    constraints: { requireHandoffOnAmbiguity: true },
    allowedPaths: ['src/runtime/control-plane/facade/**'],
    forbiddenPaths: ['.env'],
    checks: ['package:check:type'],
    driver: { preferred: 'codex_worker', allowWorker: true, allowDirectEdit: false },
    worktreePolicy: { required: true },
    evidencePolicy: { defaultDetailLevel: 'summary', allowRawOptIn: true, maxEvidenceRefs: 20 },
    approvalPolicy: { required: false, reasons: [], confirmed: false },
    recoveryPolicy: { allowSelfHealing: true, maxInfrastructureRetries: 3, handoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
  });
  return {
    work,
    workStore,
    handoffStore,
    ctx: {
      repoId: 'repo_test',
      workStore,
      handoffStore,
    },
  };
}

describe('codex cerebellum delegation', () => {
  test('builds bounded context pack without secrets or finalize rights', () => {
    const pack = buildCodexContextPack({
      repoId: 'repo_test',
      workId: 'work_1',
      objective: 'Patch facade routing',
      acceptanceCriteria: ['tests pass'],
      allowedPaths: ['src/runtime/**'],
      forbiddenPaths: ['_ops/secrets'],
      relevantFilesSummary: ['src/runtime/control-plane/facade/types.ts'],
    });
    expect(pack.expectedOutputFormat.mustProduce).toContain('evidence_artifact');
    expect(pack.expectedOutputFormat.mustNot).toContain('finalize_work_contract');
    expect(pack.forbiddenPaths).toContain('_ops/secrets');
    expect(pack.target).toBe('codex');
  });

  test('grok target prepares bounded request packet without direct execution or finalize', () => {
    const { ctx, work } = fixture();
    const result = delegateToCodexCerebellum(ctx, {
      workId: work.workId,
      objective: work.objective,
      target: 'grok',
    });
    expect(result.status).toBe('blocked');
    expect((result.data as { target: string; directExecutionAvailable: boolean; canFinalize: boolean }).target).toBe('grok');
    expect((result.data as { directExecutionAvailable: boolean }).directExecutionAvailable).toBe(false);
    expect((result.data as { canFinalize: boolean }).canFinalize).toBe(false);
    expect((result.data as { isAcceptanceFailure: boolean }).isAcceptanceFailure).toBe(false);
    expect((result.data as { grokDelegateRequest: { requestId: string; mode: string } }).grokDelegateRequest.mode)
      .toBe('bounded_handoff_request');
    expect(listHandoffItems(ctx.handoffStore).length).toBe(1);
  });

  test('codex unavailable creates handoff/recovery suggestion and is not acceptance failure', () => {
    const { ctx, work } = fixture();
    const result = delegateToCodexCerebellum(ctx, {
      workId: work.workId,
      objective: work.objective,
      codexAvailable: false,
    });

    expect(result.status).toBe('blocked');
    expect((result.data as { isAcceptanceFailure: boolean; isInfrastructureIssue: boolean }).isAcceptanceFailure).toBe(false);
    expect((result.data as { isInfrastructureIssue: boolean }).isInfrastructureIssue).toBe(true);
    expect((result.data as { canFinalize: boolean }).canFinalize).toBe(false);
    expect(listHandoffItems(ctx.handoffStore).length).toBe(1);
    expect(getWorkContract(ctx.workStore, work.workId)?.status).toBe('blocked');
  });

  test('uncertain codex output creates waiting_for_review handoff and cannot finalize', () => {
    const { ctx, work } = fixture();
    const result = delegateToCodexCerebellum(ctx, {
      workId: work.workId,
      objective: work.objective,
      codexAvailable: true,
      workerOutput: {
        uncertain: true,
        summary: 'Possible two valid approaches',
        patchProposal: 'optional patch A or B',
        evidenceSummary: 'Worker left an ambiguous recommendation',
      },
    });

    expect(result.status).toBe('blocked');
    expect((result.data as { canFinalize: boolean; uncertain: boolean }).canFinalize).toBe(false);
    expect((result.data as { uncertain: boolean }).uncertain).toBe(true);
    expect(getWorkContract(ctx.workStore, work.workId)?.status).toBe('waiting_for_review');
    expect(listHandoffItems(ctx.handoffStore).length).toBe(1);
  });

  test('codex output without a patch remains waiting_for_review and does not create worker ownership', () => {
    const { ctx, work } = fixture();
    const result = delegateToCodexCerebellum(ctx, {
      workId: work.workId,
      objective: work.objective,
      codexAvailable: true,
      workerOutput: {
        summary: 'Investigation only',
        evidenceSummary: 'No implementation output was produced',
      },
    });

    expect(result.status).toBe('blocked');
    expect((result.data as { outputs: { patchProposal: { present: boolean } } }).outputs.patchProposal.present).toBe(false);
    expect(getWorkContract(ctx.workStore, work.workId)).toMatchObject({
      status: 'waiting_for_review',
      workerRef: undefined,
    });
  });

  test('successful codex output lands as evidence and suggested actions without finalize', () => {
    const { ctx, work } = fixture();
    const result = delegateToCodexCerebellum(ctx, {
      workId: work.workId,
      objective: work.objective,
      codexAvailable: true,
      workerOutput: {
        summary: 'Patch ready for review',
        patchProposal: 'diff --git a/src/foo.ts',
        evidenceSummary: 'Bounded patch proposal',
      },
    });

    expect(result.status).toBe('ok');
    expect((result.data as { canFinalize: boolean }).canFinalize).toBe(false);
    expect((result.data as { finalizeBlockedReason: string }).finalizeBlockedReason).toContain('cannot finalize');
    const outputs = (result.data as { outputs: { evidenceArtifact: unknown; patchProposal: { present: boolean } } }).outputs;
    expect(outputs.evidenceArtifact).toBeTruthy();
    expect(outputs.patchProposal.present).toBe(true);
    expect(result.suggestedNextActions.every((action) => action.operation !== 'finalize' || action.tool === 'rh_work')).toBe(true);
    expect(getWorkContract(ctx.workStore, work.workId)?.workerRef).toStartWith('codex:');
  });
});
