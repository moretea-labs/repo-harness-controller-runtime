import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createSupervisorControlServer } from '../../src/runtime/supervisor/control-server';
import { createSupervisorOperation } from '../../src/runtime/supervisor/operation-store';
import { createSupervisorState } from '../../src/runtime/supervisor/state-store';
import { RESCUE_MCP_TOOLS } from '../../src/runtime/supervisor/rescue-mcp';
import type { SupervisorOperation, SupervisorState } from '../../src/runtime/supervisor/types';

function temporary(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function state(home: string): SupervisorState {
  return createSupervisorState(home, {
    pid: 1,
    instanceId: 'sup-test',
    processStartTime: 'start',
    executableFingerprint: 'fingerprint',
    controllerHome: home,
    ownerEpoch: 1,
  });
}

describe('stable Supervisor Rescue MCP', () => {
  test('exposes a fixed authenticated tool surface and durable operation acceptance', async () => {
    const home = temporary('repo-harness-rescue-');
    let current = state(home);
    const operations = new Map<string, SupervisorOperation>();
    const server = await createSupervisorControlServer({
      controllerHome: home,
      controlPort: 0,
      authToken: 'test-token',
      handlers: {
        getState: () => current,
        getOperation: (operationId) => operations.get(operationId) ?? null,
        submitOperation: (input) => {
          const accepted = createSupervisorOperation({ controllerHome: home, requestId: input.requestId, kind: input.kind, actor: input.actor, reason: input.reason });
          operations.set(accepted.operation.operationId, accepted.operation);
          current = { ...current, currentOperationId: accepted.operation.operationId };
          return accepted;
        },
        submitCommand: (input) => {
          const accepted = createSupervisorOperation({ controllerHome: home, requestId: input.requestId, kind: input.kind, actor: input.actor, reason: input.reason });
          operations.set(accepted.operation.operationId, accepted.operation);
          return accepted;
        },
        stop: async () => {},
      },
    });

    const endpoint = `http://${server.host}:${server.port}/rescue/mcp`;
    const list = await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const listed = await list.json() as { result?: { tools?: Array<{ name: string }> } };
    expect(list.status).toBe(200);
    expect(listed.result?.tools?.map((tool) => tool.name)).toEqual(RESCUE_MCP_TOOLS.map((tool) => tool.name));
    expect(listed.result?.tools?.some((tool) => tool.name === 'repository_command_execute')).toBe(false);

    const acceptedResponse = await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'runtime_restart_full', arguments: { request_id: 'rescue-1', reason: 'test' } } }) });
    const accepted = await acceptedResponse.json() as { result?: { structuredContent?: { accepted?: boolean; operationId?: string; mayDisconnect?: boolean } } };
    expect(accepted.result?.structuredContent?.accepted).toBe(true);
    expect(accepted.result?.structuredContent?.operationId).toMatch(/^sup-op-/);
    expect(accepted.result?.structuredContent?.mayDisconnect).toBe(true);

    const unauthorized = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) });
    expect(unauthorized.status).toBe(401);
    await server.close();
  });
});
