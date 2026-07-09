import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acknowledgeHandoffItem,
  createHandoffItem,
  getHandoffItem,
  handoffInboxPath,
  listHandoffItems,
  resolveHandoffItem,
} from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import type { CreateHandoffInput } from '../../src/runtime/control-plane/facade/handoff-inbox-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-handoff-inbox-'));
  roots.push(root);
  let tick = 0;
  return {
    root,
    options: {
      root,
      now: () => `2026-07-09T00:00:0${tick++}.000Z`,
    },
  };
}

function handoff(id: string, overrides: Partial<CreateHandoffInput> = {}): CreateHandoffInput {
  return {
    id,
    repoId: 'repo_test',
    taskId: 'T1',
    title: 'Needs review',
    severity: 'needs_review',
    reason: 'A controller decision is needed.',
    summary: 'A bounded operation reached a review point.',
    currentState: {
      repoId: 'repo_test',
      taskId: 'T1',
      mode: 'goal_workloop',
      statusSummary: 'waiting for decision',
    },
    evidenceRefs: [{ evidenceId: 'ev_1', title: 'bounded evidence', detailLevel: 'summary' }],
    recommendedDecision: 'Decide whether to continue or stop.',
    recommendedPrompt: 'Continue from this handoff and inspect the bounded evidence.',
    suggestedNextActions: [
      {
        label: 'Read task context',
        tool: 'rh_context',
        operation: 'task',
        risk: 'readonly',
      },
    ],
    ...overrides,
  };
}

describe('handoff inbox store', () => {
  test('creates and reads a controller-home compatible inbox file', () => {
    const { options } = fixture();
    const item = createHandoffItem(options, handoff('hnd one'));

    expect(item.id).toBe('hnd-one');
    expect(item.status).toBe('pending');
    expect(handoffInboxPath(options)).toEndWith('index.json');
    expect(getHandoffItem(options, 'hnd-one')?.title).toBe('Needs review');
  });

  test('lists pending handoffs by default without resolved items', () => {
    const { options } = fixture();
    createHandoffItem(options, handoff('hnd_pending'));
    createHandoffItem(options, handoff('hnd_resolved', { status: 'resolved' }));

    expect(listHandoffItems(options).map((item) => item.id)).toEqual(['hnd_pending']);
    expect(listHandoffItems({ ...options, status: 'all' }).map((item) => item.id)).toEqual([
      'hnd_resolved',
      'hnd_pending',
    ]);
  });

  test('acknowledges and resolves handoffs', () => {
    const { options } = fixture();
    createHandoffItem(options, handoff('hnd_flow'));

    expect(acknowledgeHandoffItem(options, 'hnd_flow')).toMatchObject({
      id: 'hnd_flow',
      status: 'acknowledged',
    });
    expect(listHandoffItems({ ...options, status: 'active' }).map((item) => item.status)).toEqual([
      'acknowledged',
    ]);
    expect(resolveHandoffItem(options, 'hnd_flow')).toMatchObject({
      id: 'hnd_flow',
      status: 'resolved',
    });
    expect(listHandoffItems({ ...options, status: 'active' })).toEqual([]);
  });

  test('rejects duplicate handoff ids', () => {
    const { options } = fixture();
    createHandoffItem(options, handoff('hnd_duplicate'));
    expect(() => createHandoffItem(options, handoff('hnd_duplicate'))).toThrow('handoff already exists');
  });
});
