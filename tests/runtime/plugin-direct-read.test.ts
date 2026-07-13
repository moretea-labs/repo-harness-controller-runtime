import { describe, expect, test } from 'bun:test';
import { isDirectPluginReadAction } from '../../src/runtime/plugins/store';
import type { AssistantPluginActionDescriptor } from '../../src/runtime/plugins/types';

function action(overrides: Partial<AssistantPluginActionDescriptor> = {}): AssistantPluginActionDescriptor {
  return {
    actionId: 'read_text',
    title: 'Read text',
    description: 'Read bounded text',
    readOnly: true,
    risk: 'readonly',
    confirmation: 'none',
    defaultTimeoutMs: 5_000,
    cancellable: false,
    idempotent: true,
    scopes: [],
    resourceClaims: [{ resource: 'repo-state', mode: 'read' }],
    argumentsSchema: { type: 'object' },
    ...overrides,
  };
}

describe('plugin direct read eligibility', () => {
  test('allows only bounded idempotent unconfirmed reads', () => {
    expect(isDirectPluginReadAction(action())).toBe(true);
    expect(isDirectPluginReadAction(action({ readOnly: false, risk: 'workspace_write' }))).toBe(false);
    expect(isDirectPluginReadAction(action({ confirmation: 'authorization' }))).toBe(false);
    expect(isDirectPluginReadAction(action({ idempotent: false }))).toBe(false);
  });
});
