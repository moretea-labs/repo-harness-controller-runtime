import type { SupervisorOperation, SupervisorOperationKind, SupervisorState } from './types';

export interface RescueToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const RESCUE_MCP_TOOLS: readonly RescueToolDefinition[] = [
  { name: 'runtime_status', description: 'Read bounded Stable Supervisor and runtime status.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'runtime_operation_get', description: 'Read one durable Supervisor operation by operation ID.', inputSchema: { type: 'object', properties: { operation_id: { type: 'string' } }, required: ['operation_id'], additionalProperties: false } },
  ...(['controller', 'gateway', 'full'] as const).map((component) => ({
    name: `runtime_restart_${component}`,
    description: `Request a durable ${component} runtime restart.`,
    inputSchema: { type: 'object', properties: { request_id: { type: 'string' }, reason: { type: 'string' } }, required: ['request_id'], additionalProperties: false },
  })),
  { name: 'runtime_rollout', description: 'Request a durable blue/green rollout.', inputSchema: { type: 'object', properties: { request_id: { type: 'string' }, reason: { type: 'string' } }, required: ['request_id'], additionalProperties: false } },
  { name: 'runtime_rollback', description: 'Request a durable rollback to the previous healthy slot.', inputSchema: { type: 'object', properties: { request_id: { type: 'string' }, reason: { type: 'string' } }, required: ['request_id'], additionalProperties: false } },
  { name: 'runtime_unlock_and_recover', description: 'Clear one bounded restart lockout and request one recovery attempt.', inputSchema: { type: 'object', properties: { request_id: { type: 'string' }, reason: { type: 'string' } }, required: ['request_id'], additionalProperties: false } },
];

export interface RescueDispatchContext {
  getState(): SupervisorState | null;
  getOperation(operationId: string): SupervisorOperation | null;
  submitOperation(input: { requestId: string; kind: SupervisorOperationKind; actor: string; reason?: string }): { operation: SupervisorOperation; deduplicated: boolean };
}

export interface RescueToolResult {
  payload: Record<string, unknown>;
  isError?: boolean;
}

function objectArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = typeof args[name] === 'string' ? args[name].trim() : '';
  if (!value) throw new Error(`RESCUE_${name.toUpperCase()}_REQUIRED`);
  return value;
}

function operationResult(context: RescueDispatchContext, args: Record<string, unknown>, kind: SupervisorOperationKind): RescueToolResult {
  const requestId = requiredString(args, 'request_id');
  const reason = typeof args.reason === 'string' ? args.reason.slice(0, 500) : undefined;
  const accepted = context.submitOperation({ requestId, kind, actor: 'rescue-mcp', reason });
  return {
    payload: {
      accepted: true,
      deduplicated: accepted.deduplicated,
      operationId: accepted.operation.operationId,
      requestId: accepted.operation.requestId,
      phase: accepted.operation.phase,
      reconnectContract: accepted.operation.reconnectContract,
      mayDisconnect: true,
    },
  };
}

export function dispatchRescueTool(name: string, rawArgs: unknown, context: RescueDispatchContext): RescueToolResult {
  const args = objectArgs(rawArgs);
  switch (name) {
    case 'runtime_status': {
      const state = context.getState();
      return { payload: state ? { state } : { state: null, available: false } };
    }
    case 'runtime_operation_get': {
      const operationId = requiredString(args, 'operation_id');
      const operation = context.getOperation(operationId);
      return operation
        ? { payload: { operation } }
        : { payload: { error: { code: 'OPERATION_NOT_FOUND', operationId } }, isError: true };
    }
    case 'runtime_restart_controller': return operationResult(context, args, 'restart_controller');
    case 'runtime_restart_gateway': return operationResult(context, args, 'restart_gateway');
    case 'runtime_restart_full': return operationResult(context, args, 'restart_full');
    case 'runtime_rollout': return operationResult(context, args, 'rollout');
    case 'runtime_rollback': return operationResult(context, args, 'rollback');
    case 'runtime_unlock_and_recover': return operationResult(context, args, 'unlock_and_recover');
    default:
      return { payload: { error: { code: 'RESCUE_TOOL_NOT_FOUND', name } }, isError: true };
  }
}
