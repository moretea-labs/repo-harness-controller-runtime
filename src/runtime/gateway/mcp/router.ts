import { createHash } from 'crypto';
import type { CallToolResult, McpToolDefinition } from '../../../cli/mcp/tools';
import {
  buildMultiRepositoryToolDefinitions,
  repositoryScopedToolArgs,
  type MultiRepositoryMcpToolContext,
} from '../../../cli/mcp/multi-repository';
import { repositoryToolDefinitions } from '../../../cli/mcp/repository-tools';
import { resolveRepositorySelection } from '../../../cli/repositories/registry';
import { ensureRepositoryRuntimeStorage } from '../../../cli/repositories/runtime-storage';
import { createExecutionJob } from '../../execution/jobs/store';
import type { ExecutionJobPriority, ExecutionJobType } from '../../execution/jobs/types';
import { ensureControllerDaemon } from '../../control-plane/daemon-client';
import { claimsForMcpOperation } from './resource-policy';

const DIRECT_REPOSITORY_TOOLS = new Set(['repository_list', 'repository_get', 'repository_workbench', 'repository_command_preview']);
const DIRECT_HOT_READ_TOOLS = new Set([
  'get_task_run', 'get_task_run_events', 'get_task_run_log',
]);
const P0_TOOLS = new Set(['run_check', 'verify_edit_session', 'repository_command_execute']);
const P2_TOOLS = new Set(['write_prd', 'write_sprint', 'write_plan', 'publish_issue_to_github']);

function result(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function toolDefinition(ctx: MultiRepositoryMcpToolContext, name: string): McpToolDefinition | undefined {
  return [...repositoryToolDefinitions, ...buildMultiRepositoryToolDefinitions(ctx)].find((tool) => tool.name === name);
}

function shouldCreateDurableJob(ctx: MultiRepositoryMcpToolContext, name: string): boolean {
  const definition = toolDefinition(ctx, name);
  if (!definition) return false;
  if (name.startsWith('repository_') && DIRECT_REPOSITORY_TOOLS.has(name)) return false;
  if (definition.annotations?.readOnlyHint === true) return false;
  return !DIRECT_HOT_READ_TOOLS.has(name);
}

function jobType(name: string): ExecutionJobType {
  if (name === 'run_check') return 'check';
  if (name === 'verify_edit_session') return 'verify-edit';
  if (name === 'repository_command_execute' || name === 'repository_command_preview') return 'repository-command';
  if (name === 'integrate_task_run') return 'integration';
  if (['dispatch_task', 'launch_issue', 'dispatch_ready_tasks', 'retry_task_run'].includes(name)) return 'dispatch-task';
  if (['quick_agent_session', 'submit_local_job'].includes(name)) return 'agent-run';
  return 'mcp-tool';
}

function priority(name: string): ExecutionJobPriority {
  if (P0_TOOLS.has(name)) return 'P0';
  if (P2_TOOLS.has(name)) return 'P2';
  return 'P1';
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'request_id')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function hashArguments(args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonical(args))).digest('hex').slice(0, 20);
}

function automaticRequestId(name: string, repoId: string, args: Record<string, unknown>): string {
  const window = Math.floor(Date.now() / (5 * 60_000));
  return `mcp:auto:${name}:${repoId}:${hashArguments(args)}:${window}`;
}

export function injectDurableCommandFields(tool: McpToolDefinition): McpToolDefinition {
  const schema = tool.inputSchema as { type?: unknown; properties?: Record<string, unknown>; [key: string]: unknown };
  if (schema.type !== 'object') return tool;
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: {
        ...(schema.properties ?? {}),
        request_id: {
          type: 'string',
          description: 'Idempotency key. Retries with the same request_id return the original durable Job.',
        },
      },
    },
  };
}

export async function routeDurableMcpCall(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (!shouldCreateDurableJob(ctx, name)) return undefined;

  const restoringDisabledRepository = name === 'repository_update'
    && typeof args.repo_id === 'string'
    && args.enabled === true;
  const isRepositoryTool = name.startsWith('repository_');
  const controllerScopedRepositoryTool = name === 'repository_register'
    || (name === 'repository_workbench' && typeof args.repo_id !== 'string' && typeof args.checkout_id !== 'string');
  const repository = controllerScopedRepositoryTool
    ? undefined
    : resolveRepositorySelection({
      repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
      checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
      explicitPath: ctx.explicitRepository?.canonicalRoot,
      controllerHome: ctx.controllerHome,
      allowSoleRepository: true,
      ...(restoringDisabledRepository ? { allowDisabledReason: 'restore' as const } : {}),
    });
  const repoId = repository?.repoId ?? '__controller__';
  const checkoutId = repository?.activeCheckoutId;
  if (repository) {
    const storage = ensureRepositoryRuntimeStorage(repository, ctx.controllerHome);
    if (!storage.readyForExecution) throw new Error(`RUNTIME_STORAGE_NOT_READY: ${storage.warnings.join('; ')}`);
  }

  const requestId = typeof args.request_id === 'string' && args.request_id.trim()
    ? args.request_id.trim()
    : automaticRequestId(name, repoId, args);
  const workerArgs = isRepositoryTool
    ? { ...args }
    : repositoryScopedToolArgs(name, args, repository!);
  delete workerArgs.request_id;
  const semanticKey = `${isRepositoryTool ? 'repository-tool' : 'mcp-tool'}:${name}:${repoId}:${hashArguments(workerArgs)}`;
  const claims = claimsForMcpOperation(name, workerArgs, repoId, checkoutId);
  const created = createExecutionJob(ctx.controllerHome, {
    repoId,
    checkoutId,
    type: jobType(name),
    requestId,
    semanticKey,
    priority: priority(name),
    origin: { surface: 'mcp', actor: name, correlationId: requestId },
    payload: {
      operation: name,
      arguments: workerArgs,
      target: isRepositoryTool ? 'repository-tool' : 'mcp-tool',
      profile: ctx.policy.profile,
      enableChatgptBrowser: ctx.enableChatgptBrowser === true,
      enableDevRunner: ctx.policy.execution.agentRunner,
      allowedAgents: [...ctx.policy.execution.allowedAgents],
      runnerTimeoutMs: ctx.policy.execution.runnerTimeoutMs,
      runnerMaxTimeoutMs: ctx.policy.execution.runnerMaxTimeoutMs,
    },
    resourceClaims: claims,
    timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
    maxAttempts: 2,
  });
  const daemon = ensureControllerDaemon(ctx.controllerHome);
  return result({
    accepted: true,
    jobId: created.job.jobId,
    repoId,
    checkoutId,
    status: created.job.status,
    requestId: created.job.requestId,
    deduplicated: created.deduplicated,
    daemon: { status: daemon.status, pid: daemon.pid },
    next: `Call get_job with job_id ${created.job.jobId}.`,
  });
}
