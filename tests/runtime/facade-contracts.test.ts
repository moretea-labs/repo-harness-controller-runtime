import { describe, expect, test } from 'bun:test';
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

  test('selects direct control for small supervised work', () => {
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
    ).toMatchObject({ mode: 'direct_control', missingContractFields: [] });
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
    ).toMatchObject({ mode: 'handoff_only' });
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
          operation: 'task',
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
});
