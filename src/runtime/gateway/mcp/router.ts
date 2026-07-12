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
import { createExecutionJob, getExecutionJob } from '../../execution/jobs/store';
import type { ExecutionJobPriority, ExecutionJobType } from '../../execution/jobs/types';
import { waitForExecutionJob } from '../../execution/jobs/wait';
import { ensureControllerDaemon } from '../../control-plane/daemon-client';
import { buildAcceptedQueuedDigest, buildJobOperationDigest } from '../../control-plane/facade/operation-digest';
import { claimsForMcpOperation } from './resource-policy';
import { commandValue, normalizeRepositoryCommand } from '../../../cli/repositories/command-normalization';

const DIRECT_REPOSITORY_TOOLS = new Set(['repository_list', 'repository_get', 'repository_workbench', 'repository_command_preview']);
const DIRECT_HOT_READ_TOOLS = new Set([
  'get_task_run', 'get_task_run_events', 'get_task_run_log',
]);
/** Small interactive development writes: run synchronously by default so ChatGPT/GUI get immediate results. */
const INTERACTIVE_SYNC_WRITE_TOOLS = new Set([
  'repository_safe_patch_apply',
  'repository_git_create_branch',
  'repository_git_switch_branch',
  'repository_git_commit',
  'begin_edit_session',
  'apply_patch',
  'apply_edit_operations',
  'create_edit_savepoint',
  'git_stage_paths',
  'git_commit_paths',
]);
const P0_TOOLS = new Set(['run_check', 'verify_edit_session', 'repository_command_execute']);
const P2_TOOLS = new Set(['write_prd', 'write_sprint', 'write_plan', 'publish_issue_to_github']);

function wantsAsyncExecution(args: Record<string, unknown>): boolean {
  return args.apply_mode === 'async' || args.mode === 'async' || args.async === true;
}

function wantsWaitForResult(args: Record<string, unknown>): boolean {
  return args.wait === true
    || args.await_result === true
    || args.wait_for_result === true
    || typeof args.wait_ms === 'number';
}

function waitTimeoutMs(args: Record<string, unknown>): number {
  if (typeof args.wait_ms === 'number' && Number.isFinite(args.wait_ms)) {
    return Math.max(200, Math.min(Math.trunc(args.wait_ms), 120_000));
  }
  if (typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms) && wantsWaitForResult(args)) {
    return Math.max(200, Math.min(Math.trunc(args.timeout_ms), 120_000));
  }
  return 15_000;
}

function result(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function toolDefinition(ctx: MultiRepositoryMcpToolContext, name: string): McpToolDefinition | undefined {
  return [...repositoryToolDefinitions, ...buildMultiRepositoryToolDefinitions(ctx)].find((tool) => tool.name === name);
}

function shouldCreateDurableJob(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown> = {},
): boolean {
  const definition = toolDefinition(ctx, name);
  if (!definition) return false;
  if (name.startsWith('repository_') && DIRECT_REPOSITORY_TOOLS.has(name)) return false;
  if (definition.annotations?.readOnlyHint === true) return false;
  if (DIRECT_HOT_READ_TOOLS.has(name)) return false;
  // Interactive development path: sync by default unless caller opts into async queueing.
  if (INTERACTIVE_SYNC_WRITE_TOOLS.has(name) && !wantsAsyncExecution(args)) return false;
  return true;
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
        apply_mode: {
          type: 'string',
          enum: ['sync', 'async'],
          description: 'Interactive development tools default to sync. Set async to queue a durable Job instead.',
        },
        wait: {
          type: 'boolean',
          description: 'When true for durable operations, wait up to wait_ms for a terminal result digest.',
        },
        wait_ms: {
          type: 'number',
          description: 'Max wait for terminal job result when wait=true. Default 15000, max 120000.',
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
  if (!shouldCreateDurableJob(ctx, name, args)) return undefined;

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
  if (name === 'repository_command_execute' || name === 'repository_command_preview') {
    workerArgs.command = commandValue(normalizeRepositoryCommand(workerArgs.command));
  }
  delete workerArgs.request_id;
  const semanticKey = `${isRepositoryTool ? 'repository-tool' : 'mcp-tool'}:${name}:${repoId}:${hashArguments(workerArgs)}`;
  const claims = claimsForMcpOperation(name, workerArgs, repoId, checkoutId);
  // Refresh and fence the daemon before persisting work. Creating the Job first
  // can leave a newly submitted operation associated with a stale Controller
  // epoch when the long-lived Gateway survives a daemon restart.
  const daemon = ensureControllerDaemon(ctx.controllerHome);
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
  if (wantsWaitForResult(args)) {
    const waited = await waitForExecutionJob({
      controllerHome: ctx.controllerHome,
      repoId,
      jobId: created.job.jobId,
      timeoutMs: waitTimeoutMs(args),
    });
    const digest = buildJobOperationDigest(waited.job, {
      waited: true,
      stillRunning: waited.timedOut,
    });
    return result({
      accepted: true,
      waited: true,
      timedOut: waited.timedOut,
      waitedMs: waited.waitedMs,
      jobId: waited.job.jobId,
      repoId,
      checkoutId,
      status: waited.job.status,
      requestId: waited.job.requestId,
      deduplicated: created.deduplicated,
      daemon: { status: daemon.status, pid: daemon.pid },
      digest,
      summary: digest.summary,
      phase: digest.phase,
      statusLabel: digest.statusLabel,
      errorClass: digest.errorClass,
      errorMessage: digest.errorMessage,
      changedFiles: digest.changedFiles,
      suggestedNextActions: digest.suggestedNextActions,
      next: waited.timedOut
        ? `Still ${waited.job.status}. Call get_job/work_get with wait=true again, or inspect job_id ${waited.job.jobId}.`
        : digest.summary,
    });
  }

  const queued = getExecutionJob(ctx.controllerHome, repoId, created.job.jobId);
  const digest = buildAcceptedQueuedDigest({
    jobId: queued.jobId,
    requestId: queued.requestId,
    operation: name,
    status: queued.status,
    deduplicated: created.deduplicated,
  });
  return result({
    accepted: true,
    jobId: created.job.jobId,
    repoId,
    checkoutId,
    status: created.job.status,
    requestId: created.job.requestId,
    deduplicated: created.deduplicated,
    daemon: { status: daemon.status, pid: daemon.pid },
    digest,
    summary: digest.summary,
    phase: digest.phase,
    statusLabel: digest.statusLabel,
    suggestedNextActions: digest.suggestedNextActions,
    next: `Call get_job with job_id ${created.job.jobId} and wait=true for a terminal result digest.`,
  });
}
