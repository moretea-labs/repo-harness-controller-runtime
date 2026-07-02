import { describe, expect, test } from 'bun:test';
import { triggerWorkspaceAgent } from '../../src/runtime/workflow/campaigns/workspace-agent';

describe('Workspace Agent trigger transport', () => {
  test('posts one idempotent trigger without exposing the token', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const output = await triggerWorkspaceAgent({
      agentId: 'agtch_repo_supervisor_1',
      input: 'Review this checkpoint.',
      conversationKey: 'campaign-1',
      idempotencyKey: 'checkpoint-1',
    }, {
      token: 'secret-token',
      now: () => new Date('2026-07-02T12:00:00.000Z'),
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenInit = init;
        return new Response(null, { status: 202 });
      },
    });
    expect(seenUrl).toBe('https://api.chatgpt.com/v1/workspace_agents/agtch_repo_supervisor_1/trigger');
    expect((seenInit?.headers as Record<string, string>)['idempotency-key']).toBe('checkpoint-1');
    expect(JSON.parse(String(seenInit?.body))).toEqual({ input: 'Review this checkpoint.', conversation_key: 'campaign-1' });
    expect(output).toEqual({
      accepted: true,
      status: 202,
      agentId: 'agtch_repo_supervisor_1',
      conversationKey: 'campaign-1',
      idempotencyKey: 'checkpoint-1',
      transportAttempts: 1,
      triggeredAt: '2026-07-02T12:00:00.000Z',
    });
    expect(JSON.stringify(output)).not.toContain('secret-token');
  });

  test('rejects invalid configuration and bounded HTTP failures', async () => {
    await expect(triggerWorkspaceAgent({ agentId: 'wrong', input: 'Review' }, { token: 'token' }))
      .rejects.toThrow('WORKSPACE_AGENT_ID_INVALID');
    await expect(triggerWorkspaceAgent({ agentId: 'agtch_valid', input: 'Review' }, {
      token: 'token',
      fetchImpl: async () => new Response('not allowed', { status: 403 }),
    })).rejects.toThrow('WORKSPACE_AGENT_HTTP_403: not allowed');
  });

  test('retries uncertain transport with the same idempotency key', async () => {
    const keys: string[] = [];
    let calls = 0;
    const output = await triggerWorkspaceAgent({
      agentId: 'agtch_retry_supervisor',
      input: 'Review',
      idempotencyKey: 'checkpoint-2:1',
      timeoutMs: 5_000,
    }, {
      token: 'token',
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        calls += 1;
        keys.push((init?.headers as Record<string, string>)['idempotency-key']);
        if (calls === 1) throw new TypeError('connection reset');
        return new Response(null, { status: 202 });
      },
    });
    expect(output.transportAttempts).toBe(2);
    expect(keys).toEqual(['checkpoint-2:1', 'checkpoint-2:1']);
  });

});
