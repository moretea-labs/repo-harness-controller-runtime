/**
 * Repository-scoped Managed Process lifecycle MCP tools.
 *
 * process_get / process_wait / process_logs / process_cancel
 *
 * These tools attach to an existing Process Runtime handle — they never
 * re-execute the original command.
 */

import type { McpToolDefinition, CallToolResult } from '../../../cli/mcp/tools';
import type { MultiRepositoryMcpToolContext } from '../../../cli/mcp/multi-repository';
import { getRepository } from '../../../cli/repositories/registry';
import {
  cancelProcess,
  getProcessHandle,
  readProcessLogs,
  waitForProcess,
} from '../../execution/process-runtime';
import { getProcessRecord } from '../../execution/process-runtime/store';

function definition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
  readOnlyHint = false,
  destructiveHint = false,
): McpToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    annotations: { readOnlyHint, openWorldHint: false, destructiveHint },
  };
}

const repoIdProp = {
  type: 'string',
  description: 'Stable repository id. Process must belong to this repository.',
};
const processIdProp = {
  type: 'string',
  description: 'Managed process id returned by Process Runtime (e.g. from run_check / repository_command).',
};

export const processToolDefinitions: McpToolDefinition[] = [
  definition(
    'process_get',
    'Get the current status of a managed process without re-executing the command. Readonly.',
    {
      repo_id: repoIdProp,
      process_id: processIdProp,
    },
    ['repo_id', 'process_id'],
    true,
  ),
  definition(
    'process_wait',
    'Wait for a managed process to complete or until timeout_ms. Does not re-execute the command. Readonly attach/poll.',
    {
      repo_id: repoIdProp,
      process_id: processIdProp,
      timeout_ms: { type: 'number', description: 'Max wait milliseconds (default 15000).' },
    },
    ['repo_id', 'process_id'],
    true,
  ),
  definition(
    'process_logs',
    'Read a bounded tail of managed process stdout/stderr. Never loads unbounded logs. Readonly.',
    {
      repo_id: repoIdProp,
      process_id: processIdProp,
      max_bytes: { type: 'number', description: 'Max tail bytes per stream (default 32KiB).' },
    },
    ['repo_id', 'process_id'],
    true,
  ),
  definition(
    'process_cancel',
    'Cancel a managed process. Requires verified PID identity (start time + executable fingerprint). Untrusted PIDs are refused. Classified as workspace-write / process-control.',
    {
      repo_id: repoIdProp,
      process_id: processIdProp,
    },
    ['repo_id', 'process_id'],
    false,
    true,
  ),
];

const processToolNames = new Set(processToolDefinitions.map((tool) => tool.name));

function result(value: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function failure(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.includes(':') ? message.slice(0, message.indexOf(':')) : 'PROCESS_TOOL_FAILED';
  return result({ error: { code, message } }, true);
}

function requireRepoAndProcess(
  ctx: MultiRepositoryMcpToolContext,
  args: Record<string, unknown>,
): { repoId: string; processId: string } {
  const repoId = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
  const processId = typeof args.process_id === 'string' ? args.process_id.trim() : '';
  if (!repoId) throw new Error('REPOSITORY_ID_REQUIRED: repo_id is required for process tools');
  if (!processId) throw new Error('PROCESS_ID_REQUIRED: process_id is required for process tools');

  // Force repo scope: repository must exist under this controller home.
  const repository = getRepository(repoId, ctx.controllerHome);
  if (!repository) {
    throw new Error(`REPOSITORY_NOT_FOUND: ${repoId}`);
  }

  // Process must belong to the requested repo.
  const record = getProcessRecord(ctx.controllerHome, repoId, processId);
  if (!record) {
    throw new Error(`PROCESS_NOT_FOUND: process ${processId} is not registered under repo ${repoId}`);
  }
  if (record.repoId !== repoId) {
    throw new Error(`PROCESS_REPO_MISMATCH: process ${processId} belongs to ${record.repoId}, not ${repoId}`);
  }
  return { repoId, processId };
}

function handleToPayload(handle: NonNullable<ReturnType<typeof getProcessHandle>>): Record<string, unknown> {
  return {
    processId: handle.processId,
    status: handle.status,
    route: handle.route,
    pid: handle.pid,
    startedAt: handle.startedAt,
    interactiveWaitMs: handle.interactiveWaitMs,
    timeoutMs: handle.timeoutMs,
    completed: handle.completed === true,
    ok: handle.ok,
    exitCode: handle.exitCode,
    timedOut: handle.timedOut,
    cancelled: handle.cancelled,
    stdout: handle.stdout,
    stderr: handle.stderr,
    stdoutTail: handle.stdoutTail,
    stderrTail: handle.stderrTail,
    durableSideEffects: handle.durableSideEffects,
  };
}

export async function callProcessTool(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (!processToolNames.has(name)) return undefined;
  try {
    const { repoId, processId } = requireRepoAndProcess(ctx, args);
    switch (name) {
      case 'process_get': {
        const handle = getProcessHandle(ctx.controllerHome, repoId, processId);
        if (!handle) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
        return result({
          repoId,
          process: handleToPayload(handle),
        });
      }
      case 'process_wait': {
        const timeoutMs = typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms)
          ? Math.max(1, Math.trunc(args.timeout_ms))
          : 15_000;
        const handle = await waitForProcess(ctx.controllerHome, repoId, processId, { timeoutMs });
        return result({
          repoId,
          process: handleToPayload(handle),
          waitedMs: timeoutMs,
          reExecuted: false,
        });
      }
      case 'process_logs': {
        const maxBytes = typeof args.max_bytes === 'number' && Number.isFinite(args.max_bytes)
          ? Math.max(256, Math.trunc(args.max_bytes))
          : 32 * 1024;
        const logs = readProcessLogs(ctx.controllerHome, repoId, processId, maxBytes);
        if (!logs) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
        return result({
          repoId,
          processId,
          stdout: logs.stdout,
          stderr: logs.stderr,
          stdoutBytes: logs.stdoutBytes,
          stderrBytes: logs.stderrBytes,
          truncated: logs.truncated,
          maxBytes,
        });
      }
      case 'process_cancel': {
        const handle = await cancelProcess(ctx.controllerHome, repoId, processId);
        return result({
          repoId,
          process: handleToPayload(handle),
          cancelled: handle.cancelled === true || handle.status === 'cancelled' || handle.status === 'completed_unknown',
        });
      }
      default:
        return undefined;
    }
  } catch (error) {
    return failure(error);
  }
}

export function isProcessTool(name: string): boolean {
  return processToolNames.has(name);
}
