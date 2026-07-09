import { describe, expect, test } from 'bun:test';
import { normalizeCheckIds, classifyVerificationOutcome } from '../../src/runtime/control-plane/facade/check-normalization';
import { listCapabilityDescriptors } from '../../src/runtime/control-plane/facade/capability-registry';
import { evaluatePolicyGate } from '../../src/runtime/control-plane/facade/policy-gate';
import { buildFacadeResult } from '../../src/runtime/control-plane/facade/facade-result';
import { validateSuggestedNextActions } from '../../src/runtime/control-plane/facade/suggested-actions';
import {
  FACADE_TOOLS,
  HANDOFF_STATUSES,
  type FacadeResult,
  type HandoffItem,
  isTerminalHandoffStatus,
  selectExecutionMode,
} from '../../src/runtime/control-plane/facade/types';

describe('handoff and facade contracts', () => {
  test('keeps the ChatGPT-facing facade small and stable', () => {
    expect(FACADE_TOOLS).toEqual(['rh_status', 'rh_inbox', 'rh_context', 'rh_work']);
  });

  test('classifies terminal handoff statuses', () => {
    expect(HANDOFF_STATUSES).toContain('pending');
    expect(isTerminalHandoffStatus('pending')).toBe(false);
    expect(isTerminalHandoffStatus('resolved')).toBe(true);
    expect(isTerminalHandoffStatus('expired')).toBe(true);
  });

  test('selects direct control for small supervised work without WorkContract', () => {
    expect(
      selectExecutionMode({
        expectedFiles: 2,
        expectedChangedLines: 80,
        scopeClear: true,
        requiresRecovery: false,
        requiresWorker: false,
        requiresExternalEffect: false,
        requiresApproval: false,
      }),
    ).toMatchObject({ mode: 'direct_control', missingContractFields: [], createWorkContract: false });
  });

  test('selects handoff only when the request is underspecified', () => {
    expect(
      selectExecutionMode({
        scopeClear: false,
        requiresRecovery: false,
        requiresWorker: false,
        requiresExternalEffect: false,
        requiresApproval: false,
      }),
    ).toMatchObject({ mode: 'handoff_only', createHandoff: true, createWorkContract: false });
  });

  test('selects goal workloop for long-running or complex work', () => {
    expect(
      selectExecutionMode({
        scopeClear: true,
        expectedFiles: 12,
        expectedChangedLines: 800,
        requiresLongRunningChecks: true,
        requiresRecovery: false,
        requiresWorker: false,
        requiresExternalEffect: false,
        requiresApproval: false,
      }),
    ).toMatchObject({ mode: 'goal_workloop', createWorkContract: true });
  });

  test('selects handoff only for high-risk work needing approval', () => {
    expect(
      selectExecutionMode({
        scopeClear: true,
        destructive: true,
        requiresUserApproval: true,
        requiresApproval: true,
      }),
    ).toMatchObject({ mode: 'handoff_only', createHandoff: true });
  });

  test('supports bounded facade results with evidence refs and suggested actions', () => {
    const result: FacadeResult<{ pendingHandoffs: number }> = {
      schemaVersion: 1,
      status: 'ok',
      summary: 'Controller is ready.',
      data: { pendingHandoffs: 1 },
      evidenceRefs: [{ title: 'status projection', detailLevel: 'summary' }],
      warnings: [],
      suggestedNextActions: [
        {
          label: 'List pending handoffs',
          tool: 'rh_inbox',
          operation: 'list',
          risk: 'readonly',
          confidence: 'high',
        },
      ],
      rawAvailable: false,
      detailLevel: 'summary',
    };

    expect(result.suggestedNextActions[0]?.tool).toBe('rh_inbox');
  });

  test('facade result defaults to bounded data without raw stdout/stderr/secrets', () => {
    const facade = buildFacadeResult({
      summary: 'ok',
      data: {
        stdout: 'x'.repeat(10_000),
        secret: 'should-be-bounded-as-string',
        nested: { deep: { log: 'y'.repeat(5_000) } },
      },
    });
    expect(facade.rawAvailable).toBe(false);
    expect(facade.detailLevel).toBe('summary');
    expect(String((facade.data as { stdout: string }).stdout).length).toBeLessThan(5_000);
    expect(JSON.stringify(facade)).not.toContain('Bearer ');
  });

  test('suggested_next_actions cannot reference nonexistent check or tool', () => {
    const validation = validateSuggestedNextActions(
      [
        {
          label: 'Bad tool',
          tool: 'not_a_tool' as 'rh_work',
          operation: 'start',
          risk: 'readonly',
        },
        {
          label: 'Bad check',
          tool: 'rh_work',
          operation: 'verify',
          payload: { check_id: 'package:does-not-exist' },
          risk: 'workspace_write',
        },
        {
          label: 'Good check',
          tool: 'rh_work',
          operation: 'verify',
          payload: { check_id: 'package:check:type' },
          risk: 'workspace_write',
        },
      ],
      { validCheckIds: ['package:check:type'] },
    );
    expect(validation.actions.map((action) => action.label)).toEqual(['Good check']);
    expect(validation.warnings.length).toBeGreaterThanOrEqual(2);
  });

  test('represents a handoff item without raw logs', () => {
    const handoff: HandoffItem = {
      schemaVersion: 1,
      id: 'hnd_test',
      repoId: 'repo_test',
      taskId: 'T1',
      title: 'Verification needs review',
      severity: 'needs_review',
      status: 'pending',
      reason: 'The failure may require a product decision.',
      summary: 'A targeted check failed after a bounded change.',
      currentState: {
        repoId: 'repo_test',
        taskId: 'T1',
        mode: 'goal_workloop',
        statusSummary: 'waiting for ChatGPT decision',
        checks: [{ checkId: 'package:check:type', ok: false }],
      },
      evidenceRefs: [{ evidenceId: 'ev_test', title: 'typecheck summary', detailLevel: 'summary' }],
      recommendedDecision: 'Decide whether to repair code or adjust the contract.',
      recommendedPrompt: 'Continue from handoff hnd_test and inspect evidence ev_test.',
      suggestedNextActions: [
        {
          label: 'Read task context',
          tool: 'rh_context',
          operation: 'get',
          payload: { task_id: 'T1' },
          risk: 'readonly',
        },
      ],
      createdAt: '2026-07-09T00:00:00.000Z',
      updatedAt: '2026-07-09T00:00:00.000Z',
    };

    expect(handoff.evidenceRefs[0]?.detailLevel).toBe('summary');
    expect(handoff.suggestedNextActions[0]?.tool).toBe('rh_context');
  });

  test('registers parallel internal capabilities without expanding facade tools', () => {
    const capabilities = listCapabilityDescriptors([]);
    expect(capabilities.map((entry) => entry.capabilityId)).toContain('repository.direct_edit');
    expect(capabilities.map((entry) => entry.capabilityId)).toContain('controller.goal_workloop');
    expect(capabilities.map((entry) => entry.capabilityId)).toContain('controller.self_healing');
    expect(capabilities.map((entry) => entry.capabilityId)).toContain('controller.codex_delegation');
    expect(new Set(capabilities.map((entry) => entry.exposedVia))).toEqual(new Set(['rh_context', 'rh_inbox', 'rh_status', 'rh_work']));
  });

  test('policy gate preserves bounded direct edit and blocks raw secret access', () => {
    expect(evaluatePolicyGate({
      risk: 'local_repo_write',
      directEditBoundary: { scopeClear: true, pathsExplicit: true, maxChangedFiles: 2, maxChangedLines: 80 },
    })).toMatchObject({ decision: 'allowed' });
    expect(evaluatePolicyGate({ risk: 'raw_secret_config' })).toMatchObject({ decision: 'denied' });
    expect(evaluatePolicyGate({ risk: 'remote_write' })).toMatchObject({ decision: 'approval_required' });
  });

  test('normalizes check aliases without treating invalid ids as check failures', () => {
    const normalized = normalizeCheckIds(['typecheck', 'docs', 'package:test'], [
      { id: 'package:check:type' },
      { id: 'package:test' },
    ]);
    expect(normalized.validCheckIds).toEqual(['package:check:type', 'package:test']);
    expect(normalized.invalidCheckIds).toEqual(['docs']);
    expect(normalized.warnings[0]).toContain('invalid_check_id');
  });

  test('classifies invalid check id as non-acceptance failure', () => {
    const classified = classifyVerificationOutcome({
      checkId: 'docs',
      available: [{ id: 'package:check:type' }],
    });
    expect(classified.outcome).toBe('invalid_check_id');
    expect(classified.isAcceptanceFailure).toBe(false);
  });
});
