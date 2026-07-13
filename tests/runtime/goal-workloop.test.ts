import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  continueGoalWorkloop,
  finalizeGoalWorkloop,
  routeWorkStart,
  startGoalWorkloop,
  stopGoalWorkloop,
  verifyGoalWorkloop,
} from '../../src/runtime/control-plane/facade/goal-workloop';
import { getWorkContract, listWorkContracts } from '../../src/runtime/control-plane/facade/work-contract-store';
import { listHandoffItems } from '../../src/runtime/control-plane/facade/handoff-inbox-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-goal-workloop-'));
  roots.push(root);
  const workRoot = join(root, 'work');
  const handoffRoot = join(root, 'handoff');
  let tick = 0;
  const now = () => `2026-07-09T01:${String(Math.floor(tick / 60)).padStart(2, '0')}:${String(tick++ % 60).padStart(2, '0')}.000Z`;
  return {
    ctx: {
      workStore: { root: workRoot, now },
      handoffStore: { root: handoffRoot, now },
      repoId: 'repo_test',
      availableChecks: [{ id: 'package:check:type' }, { id: 'package:test' }],
      now,
    },
  };
}

describe('goal workloop engine', () => {
  test('small tasks select direct_control and do not create WorkContract', () => {
    const { ctx } = fixture();
    const result = routeWorkStart(ctx, {
      objective: 'Fix typo in README',
      checks: ['typecheck'],
      modeInput: {
        scopeClear: true,
        expectedFiles: 1,
        expectedChangedLines: 5,
      },
    });

    expect(result.data).toMatchObject({
      workContractCreated: false,
      directControlPreserved: true,
    });
    expect((result.data as { mode: { mode: string } }).mode.mode).toBe('direct_control');
    expect(listWorkContracts({ ...ctx.workStore, status: 'all' })).toEqual([]);
    expect(result.suggestedNextActions.some((action) => action.tool === 'rh_work')).toBe(true);
  });

  test('long tasks select goal_workloop and create WorkContract', () => {
    const { ctx } = fixture();
    const result = routeWorkStart(ctx, {
      objective: 'Refactor control plane facade routing and recovery',
      acceptanceCriteria: ['typecheck passes', 'targeted tests pass'],
      checks: ['typecheck', 'package:test'],
      allowedPaths: ['src/runtime/control-plane/facade/**'],
      modeInput: {
        scopeClear: true,
        expectedFiles: 10,
        expectedChangedLines: 500,
        requiresLongRunningChecks: true,
      },
    });

    expect(result.status).toBe('ok');
    expect((result.data as { workContractCreated: boolean }).workContractCreated).toBe(true);
    const contracts = listWorkContracts({ ...ctx.workStore, status: 'all' });
    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({
      mode: 'goal_workloop',
      status: 'running',
      repoId: 'repo_test',
    });
    expect(contracts[0]!.checks).toContain('package:check:type');
    expect(contracts[0]!.evidenceRefs.length).toBeGreaterThan(0);
    expect(contracts[0]!.worktreePolicy.required).toBe(false);
    expect(contracts[0]!.driver.preferred).toBe('direct_edit');
  });

  test('high-risk missing-authorization tasks create handoff_only without WorkContract', () => {
    const { ctx } = fixture();
    const result = routeWorkStart(ctx, {
      objective: 'Force push main and rotate secrets',
      modeInput: {
        scopeClear: true,
        destructive: true,
        secretAccess: true,
        requiresApproval: true,
        requiresUserApproval: true,
      },
    });

    expect((result.data as { workContractCreated: boolean }).workContractCreated).toBe(false);
    expect((result.data as { mode: { mode: string } }).mode.mode).toBe('handoff_only');
    expect(listWorkContracts({ ...ctx.workStore, status: 'all' })).toEqual([]);
    expect(listHandoffItems({ ...ctx.handoffStore, status: 'pending' }).length).toBe(1);
    expect(result.status === 'blocked' || result.status === 'approval_required').toBe(true);
  });

  test('underspecified objective creates handoff and does not continue execution', () => {
    const { ctx } = fixture();
    const result = routeWorkStart(ctx, {
      objective: '',
      modeInput: {
        scopeClear: false,
      },
    });
    expect((result.data as { mode: { mode: string } }).mode.mode).toBe('handoff_only');
    expect(listWorkContracts({ ...ctx.workStore, status: 'all' })).toEqual([]);
    expect(listHandoffItems(ctx.handoffStore).length).toBe(1);
  });

  test('verify invalid check id is not acceptance failure; valid pass can supersede', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Implement workloop verify path',
      checks: ['package:check:type'],
      modeInput: { scopeClear: true, expectedFiles: 8, expectedChangedLines: 300 },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;

    const invalid = verifyGoalWorkloop(ctx, { workId, checkId: 'docs' });
    expect(invalid.status).toBe('ok');
    expect((invalid.data as { verification: { outcome: string; isAcceptanceFailure: boolean } }).verification).toMatchObject({
      outcome: 'invalid_check_id',
      isAcceptanceFailure: false,
    });

    const infra = verifyGoalWorkloop(ctx, {
      workId,
      checkId: 'package:check:type',
      infrastructureFailed: true,
    });
    expect((infra.data as { verification: { outcome: string; isAcceptanceFailure: boolean } }).verification).toMatchObject({
      outcome: 'infrastructure_failure',
      isAcceptanceFailure: false,
    });

    const pass = verifyGoalWorkloop(ctx, { workId, checkId: 'typecheck' });
    expect((pass.data as { verification: { outcome: string } }).verification.outcome).toBe('valid_pass');

    const work = getWorkContract(ctx.workStore, workId)!;
    expect(work.checkRefs.some((record) => record.outcome === 'superseded')).toBe(true);
    expect(work.checkRefs.some((record) => record.outcome === 'valid_pass')).toBe(true);
  });

  test('continue after acceptance failure creates handoff and does not pretend background completion', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Failing path review',
      checks: ['package:test'],
      modeInput: { scopeClear: true, expectedFiles: 6, expectedChangedLines: 250 },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;
    verifyGoalWorkloop(ctx, { workId, checkId: 'package:test', checkFailed: true });
    const cont = continueGoalWorkloop(ctx, { workId });
    expect(cont.status).toBe('blocked');
    expect((cont.data as { backgroundCompleted: boolean }).backgroundCompleted).toBe(false);
    expect(listHandoffItems(ctx.handoffStore).length).toBe(1);
    expect(getWorkContract(ctx.workStore, workId)?.status).toBe('waiting_for_review');
  });

  test('finalize succeeds when checks pass; stop retains evidence', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Happy path finalize',
      checks: ['package:check:type'],
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 220 },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;
    verifyGoalWorkloop(ctx, { workId, checkId: 'package:check:type' });
    const finalized = finalizeGoalWorkloop(ctx, { workId });
    expect((finalized.data as { finalStatus: string }).finalStatus).toBe('succeeded');
    expect(getWorkContract(ctx.workStore, workId)?.status).toBe('succeeded');

    const started2 = startGoalWorkloop(ctx, {
      objective: 'Stop path',
      checks: ['package:test'],
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 220 },
    });
    const workId2 = (started2.data as { work: { workId: string } }).work.workId;
    const stopped = stopGoalWorkloop(ctx, { workId: workId2, reason: 'user cancelled' });
    expect((stopped.data as { finalStatus: string; evidenceRetained: boolean }).finalStatus).toBe('cancelled');
    expect((stopped.data as { evidenceRetained: boolean }).evidenceRetained).toBe(true);
    expect((stopped.data as { worktreeDeleted: boolean }).worktreeDeleted).toBe(false);
    expect(getWorkContract(ctx.workStore, workId2)?.evidenceRefs.length).toBeGreaterThan(0);
  });
  test('work contract alone cannot continue or finalize as successful execution', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Create orchestration state only',
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250 },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;

    const continued = continueGoalWorkloop(ctx, { workId });
    expect(continued.status).toBe('blocked');
    expect((continued.data as { executionEvidencePresent: boolean }).executionEvidencePresent).toBe(false);

    const finalized = finalizeGoalWorkloop(ctx, { workId });
    expect(finalized.status).toBe('blocked');
    expect((finalized.data as { finalStatus: string }).finalStatus).toBe('waiting_for_review');
    expect(getWorkContract(ctx.workStore, workId)?.status).toBe('waiting_for_review');
  });

  test('isolated worktree is opt-in or selected only for parallel work', () => {
    const { ctx } = fixture();
    const isolated = startGoalWorkloop(ctx, {
      objective: 'Explicit isolated task',
      constraints: { workspaceMode: 'isolated' },
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250 },
    });
    const isolatedId = (isolated.data as { work: { workId: string } }).work.workId;
    expect(getWorkContract(ctx.workStore, isolatedId)?.worktreePolicy.required).toBe(true);

    const parallel = startGoalWorkloop(ctx, {
      objective: 'Parallel task',
      constraints: { workspaceMode: 'auto' },
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250, requiresParallelism: true },
    });
    const parallelId = (parallel.data as { work: { workId: string } }).work.workId;
    expect(getWorkContract(ctx.workStore, parallelId)?.worktreePolicy.required).toBe(true);
  });

});
