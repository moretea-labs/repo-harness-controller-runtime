import { createHash } from 'crypto';
import type { CallToolResult, McpToolDefinition } from '../../../cli/mcp/tools';
import {
  buildMultiRepositoryToolDefinitions,
  repositoryScopedToolArgs,
  type MultiRepositoryMcpToolContext,
} from '../../../cli/mcp/multi-repository';
import { repositoryToolDefinitions } from '../../../cli/mcp/repository-tools';
import { runtimeToolDefinitions } from './runtime-tools';
import { executionToolDefinitions } from './execution-tools';
import { resolveRepositorySelection } from '../../../cli/repositories/registry';
import { ensureRepositoryRuntimeStorage } from '../../../cli/repositories/runtime-storage';
import { createExecutionJob, getExecutionJob } from '../../execution/jobs/store';
import type { ExecutionJobPriority, ExecutionJobType, ExecutionOperationMetadata } from '../../execution/jobs/types';
import { waitForExecutionJob } from '../../execution/jobs/wait';
import { ensureControllerDaemon } from '../../control-plane/daemon-client';
import { buildAcceptedQueuedDigest, buildJobOperationDigest } from '../../control-plane/facade/operation-digest';
import { claimsForMcpOperation } from './resource-policy';
import { commandValue, normalizeRepositoryCommand } from '../../../cli/repositories/command-normalization';
import { classifyRepositoryCommand, classifyRepositoryCommandReplay } from '../../../cli/repositories/command-classifier';

const DIRECT_REPOSITORY_TOOLS = new Set(['repository_list', 'repository_get', 'repository_workbench', 'repository_command_preview']);

/** Blocking native host tools must never execute on the public MCP event loop. */
const GATEWAY_ISOLATED_TOOLS = new Set([
  // Native Apple tooling uses synchronous xcodebuild/simctl subprocesses.
  'ios_review_packet', 'ios_xcode_status', 'ios_simulators_list', 'ios_project_discover',
  'ios_schemes_list', 'ios_simulator_boot', 'ios_app_build', 'ios_app_install',
  'ios_app_launch', 'ios_simulator_screenshot', 'ios_simulator_log_tail', 'ios_ui_smoke_test',
  // Diagnostics and maintenance perform process-table and recursive filesystem scans.
  'workflow_watchdog_report', 'runtime_cleanup_preview', 'runtime_cleanup_apply',
  'runtime_maintenance_status', 'runtime_maintenance_apply',
  // Release and recovery operations may spawn Git/process checks or restart managed children.
  'release_gate', 'runtime_recovery', 'capability_recovery',
]);

export function isGatewayIsolatedTool(name: string): boolean {
  return GATEWAY_ISOLATED_TOOLS.has(name);
}

/** Tools that already own their direct-read versus durable-write boundary. */
const SELF_MANAGED_DURABLE_TOOLS = new Set(['plugin_action_execute']);

export function isSelfManagedDurableTool(name: string): boolean {
  return SELF_MANAGED_DURABLE_TOOLS.has(name);
}
/** High-frequency bounded reads execute in the current MCP request. */
const DIRECT_HOT_READ_TOOLS = new Set([
  'get_task_run', 'get_task_run_events', 'get_task_run_log',
  'get_job', 'list_jobs',
  'work_get', 'work_list', 'work_status_digest', 'work_result_summary',
  'controller_ready', 'repository_runtime_snapshot',
  'rh_status', 'rh_context', 'rh_inbox',
  'controller_context_pack',
  'repository_git_status', 'repository_git_diff', 'git_diff_paths',
]);

export function isDirectHotReadTool(name: string): boolean {
  return DIRECT_HOT_READ_TOOLS.has(name);
}
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
  // Recovery writes against an existing Run must remain available while legacy
  // Runs are the very thing preventing runtime-storage relocation. These tools
  // do not create new execution ownership or dispatch new work.
  'finish_task_run',
  'cancel_task_run',
]);
const P0_TOOLS = new Set(['run_check', 'verify_edit_session', 'repository_command_execute']);
const P2_TOOLS = new Set(['write_prd', 'write_sprint', 'write_plan', 'publish_issue_to_github']);

function wantsAsyncExecution(args: Record<string, unknown>): boolean {
  return args.apply_mode === 'async' || args.mode === 'async' || args.async === true;
}

export function runsAsInteractiveSyncWrite(
  name: string,
  args: Record<string, unknown> = {},
): boolean {
  return INTERACTIVE_SYNC_WRITE_TOOLS.has(name) && !wantsAsyncExecution(args);
}

export function wantsWaitForResult(args: Record<string, unknown>): boolean {
  return args.wait === true
    || args.await_result === true
    || args.wait_for_result === true;
}

export function waitTimeoutMs(args: Record<string, unknown>): number {
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
  return [...runtimeToolDefinitions, ...executionToolDefinitions, ...repositoryToolDefinitions, ...buildMultiRepositoryToolDefinitions(ctx)]
    .find((tool) => tool.name === name);
}

function shouldCreateDurableJob(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown> = {},
  opts: { allowReadOnly?: boolean; forceDurable?: boolean } = {},
): boolean {
  const definition = toolDefinition(ctx, name);
  if (!definition) return false;
  if (isSelfManagedDurableTool(name)) return false;
  if (opts.forceDurable === true || isGatewayIsolatedTool(name)) return true;
  if (name.startsWith('repository_') && DIRECT_REPOSITORY_TOOLS.has(name)) return false;
  if (definition.annotations?.readOnlyHint === true && opts.allowReadOnly !== true) return false;
  if (isDirectHotReadTool(name)) return false;
  // Interactive development path: sync by default unless caller opts into async queueing.
  if (runsAsInteractiveSyncWrite(name, args)) return false;
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

function validateDurableArguments(name: string, definition: McpToolDefinition, args: Record<string, unknown>): void {
  const schema = definition.inputSchema as { required?: unknown; properties?: Record<string, unknown>; additionalProperties?: unknown };
  const required = Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : [];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    throw new Error(`INVALID_ARGUMENT: ${name} is missing required argument(s): ${missing.join(', ')}`);
  }
  if (schema.additionalProperties === false && schema.properties) {
    const allowed = new Set(Object.keys(schema.properties));
    const unexpected = Object.keys(args).filter((key) => !allowed.has(key));
    if (unexpected.length > 0) {
      throw new Error(`INVALID_ARGUMENT: ${name} received unsupported argument(s): ${unexpected.join(', ')}`);
    }
  }
}

export function operationMetadataForTool(
  name: string,
  definition: McpToolDefinition,
  claims: ReturnType<typeof claimsForMcpOperation>,
  timeoutMs: number,
  args: Record<string, unknown> = {},
  defaultBranch?: string,
): ExecutionOperationMetadata {
  if (name === 'repository_command_execute' && args.command !== undefined) {
    const classification = classifyRepositoryCommand(args.command as string | string[], defaultBranch);
    const replay = classifyRepositoryCommandReplay(args.command as string | string[], defaultBranch);
    const mode = classification.risk === 'readonly'
      ? 'readonly'
      : classification.risk === 'remote_write'
        ? 'remote_write'
        : classification.risk === 'destructive'
          ? 'destructive'
          : 'mutating';
    return {
      mode,
      idempotent: replay.idempotent,
      replayable: replay.replayable,
      timeoutMs,
      retryPolicy: replay.retryPolicy,
      approvalPolicy: classification.risk === 'readonly'
        ? 'none'
        : classification.risk === 'destructive' ? 'required' : 'request',
      lockScope: claims.map((claim) => claim.resourceKey),
      resourceClaims: claims,
    };
  }
  const destructive = definition.annotations?.destructiveHint === true;
  const remoteWrite = claims.some((claim) => claim.resourceKey.startsWith('remote:'));
  const readOnly = definition.annotations?.readOnlyHint === true || claims.length === 0;
  const mode = destructive
    ? 'destructive'
    : remoteWrite
      ? 'remote_write'
      : readOnly
        ? 'readonly'
        : 'mutating';
  return {
    mode,
    idempotent: readOnly,
    replayable: readOnly,
    timeoutMs,
    retryPolicy: readOnly ? 'safe_retry' : 'idempotent_request',
    approvalPolicy: destructive ? 'required' : remoteWrite || !readOnly ? 'request' : 'none',
    lockScope: claims.map((claim) => claim.resourceKey),
    resourceClaims: claims,
  };
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
          description: 'Max wait for terminal job result. Only used when wait=true; never enables waiting by itself. Default 15000, max 120000.',
        },
      },
    },
  };
}

export async function routeDurableMcpCall(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
  opts: { allowReadOnly?: boolean; forceDurable?: boolean } = {},
): Promise<CallToolResult | undefined> {
  const definition = toolDefinition(ctx, name);
  if (!definition || !shouldCreateDurableJob(ctx, name, args, opts)) return undefined;

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
  validateDurableArguments(name, injectDurableCommandFields(definition), workerArgs);
  delete workerArgs.request_id;
  delete workerArgs.apply_mode;
  delete workerArgs.wait;
  delete workerArgs.wait_ms;
  delete workerArgs.await_result;
  delete workerArgs.wait_for_result;
  const semanticKey = `${isRepositoryTool ? 'repository-tool' : 'mcp-tool'}:${name}:${repoId}:${hashArguments(workerArgs)}`;
  const claims = claimsForMcpOperation(name, workerArgs, repoId, checkoutId);
  const agentDelegation = ['dispatch_task', 'launch_issue', 'dispatch_ready_tasks', 'retry_task_run', 'quick_agent_session'].includes(name);
  // Parent Agent-delegation Jobs only accept the child Run; child timeout stays on the Agent Run.
  const timeoutMs = agentDelegation
    ? Math.min(typeof args.timeout_ms === 'number' ? args.timeout_ms : 120_000, 120_000)
    : typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined;
  const operationMetadata = operationMetadataForTool(
    name,
    definition,
    claims,
    Math.max(1_000, Math.min(timeoutMs ?? (agentDelegation ? 120_000 : 15 * 60_000), 24 * 60 * 60_000)),
    workerArgs,
    repository?.defaultBranch,
  );
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
      toolset: ctx.toolset,
      enableChatgptBrowser: ctx.enableChatgptBrowser === true,
      enableDevRunner: ctx.policy.execution.agentRunner,
      allowedAgents: [...ctx.policy.execution.allowedAgents],
      runnerTimeoutMs: ctx.policy.execution.runnerTimeoutMs,
      runnerMaxTimeoutMs: ctx.policy.execution.runnerMaxTimeoutMs,
    },
    resourceClaims: claims,
    timeoutMs,
    maxAttempts: 2,
    operationMetadata,
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
        ? `Still ${waited.job.status}. Poll get_job/work_get without waiting; use work_wait only when blocking is explicitly required.`
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
    next: `Continue independent work, then poll get_job/work_get without waiting. Use work_wait only when blocking is explicitly required.`,
  });
}
