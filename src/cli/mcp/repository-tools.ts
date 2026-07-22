import { bindRepositoryEntities } from '../repositories/entity-migration';
import { bootstrapLocalProject, diagnoseLatestLocalProjectSource } from '../repositories/local-project-onboarding';
import { executeRepositoryCommand, previewRepositoryCommandExecution } from '../repositories/command-executor';
import { withControllerLock } from '../repositories/locks';
import {
  disableRepository,
  getRepository,
  listRepositories,
  refreshRepository,
  registerRepository,
  removeRepository,
  repositorySummary,
  resolveRepositorySelection,
  updateRepository,
  validateRepository,
} from '../repositories/registry';
import { buildControllerWorkbench } from '../repositories/workbench';
import { buildLocalBridgeJobHandoff, executeLocalBridgeJob, getLocalBridgeJobSnapshot, submitLocalBridgeJob } from '../local-bridge/job-store';
import { applySafePatch, buildSafePatchPlan } from '../repositories/safe-patch';
import { buildSyncOperationDigest, classifyUserFacingError } from '../../runtime/control-plane/facade/operation-digest';
import { diagnoseRepositoryStuckState, listRepositoryGoalRuns, readRepositoryGoalRegistry, runRepositoryGoal, upsertRepositoryGoal } from '../repositories/goal-registry';
import {
  repositoryGitCommit,
  repositoryGitCreateBranch,
  repositoryGitDeleteBranch,
  repositoryGitDiff,
  repositoryGitFinishWorkflow,
  repositoryGitMergeBranch,
  repositoryGitStatus,
  repositoryGitSwitchBranch,
} from '../repositories/structured-git';
import {
  readRepositoryGitStatusSample,
  writeRepositoryGitStatusSample,
} from '../../runtime/projections/git-status-sampler';
import {
  executeFast,
  executeLightweightLanes,
  executeRepositoryBatch,
  integratePatchProposals,
  isFastEligibleTool,
  listFastReceipts,
  readFastReceipt,
  routeExecution,
} from '../../runtime/execution/thin-harness';
import {
  classifyRepositoryCommandRoute,
  executeRepositoryCommandViaProcessRuntime,
} from '../../runtime/execution/process-runtime/command-facade';
import { assessWorkMode } from '../controller/work-mode';
import type { CallToolResult, McpToolDefinition } from './tools';
import {
  compactCommandOutput,
  compactErrorMessage,
  compactRoutingSummary,
  RESPONSE_BUDGET,
} from '../../runtime/shared/response-budget';

export type RepositoryToolResult = CallToolResult;

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
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    annotations: { readOnlyHint, openWorldHint: false, destructiveHint },
  };
}

const repoId = { type: 'string', description: 'Stable Repository Registry repoId.' };

export const repositoryToolDefinitions: McpToolDefinition[] = [
  definition('repository_register', 'Register a Git repository with the Controller.', {
    path: { type: 'string' },
    display_name: { type: 'string' },
    remote_url: { type: 'string' },
    default_branch: { type: 'string' },
  }, ['path']),
  definition('repository_latest_source_diagnose', 'Read-only diagnosis that compares sibling project directories and recommends the latest usable source tree.', {
    path: { type: 'string', description: 'Absolute local project path.' },
    repo_id: repoId,
  }, [], true),
  definition('repository_bootstrap_local_project', 'Safely initialize and optionally register a trusted non-Git local project directory.', {
    path: { type: 'string', description: 'Absolute local project path.' },
    display_name: { type: 'string' },
    default_branch: { type: 'string' },
    mode: { type: 'string', enum: ['init_git_only', 'init_git_and_register', 'replace_registration'] },
    replace_registered_repo_id: repoId,
    confirm_authorization: { type: 'boolean', description: 'Must be true to authorize Git initialization and registration.' },
  }, ['path', 'confirm_authorization'], false, true),
  definition('repository_list', 'List registered repositories.', {
    include_removed: { type: 'boolean' },
  }, [], true),
  definition('repository_get', 'Inspect one registered repository.', {
    repo_id: repoId,
    include_removed: { type: 'boolean' },
  }, ['repo_id'], true),
  definition('repository_validate', 'Validate repository identity and migrate legacy ownership.', {
    repo_id: repoId,
  }, ['repo_id']),
  definition('repository_refresh', 'Refresh repository Git and checkout metadata.', {
    repo_id: repoId,
  }, ['repo_id']),
  definition('repository_update', 'Update mutable repository metadata.', {
    repo_id: repoId,
    display_name: { type: 'string' },
    default_branch: { type: 'string' },
    enabled: { type: 'boolean' },
  }, ['repo_id']),
  definition('repository_disable', 'Disable new execution while retaining audit history.', {
    repo_id: repoId,
  }, ['repo_id']),
  definition('repository_remove', 'Soft-remove a repository while retaining audit history.', {
    repo_id: repoId,
  }, ['repo_id'], true),
  definition('repository_workbench', 'Return Workbench state or invoke one bounded Thin Harness operation without adding top-level MCP tools. Prefer batch_execute for multi-step status→search→read→diff or read→patch→check flows so ChatGPT pays one routing/receipt ownership cycle.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repository-scoped operations.' },
    include_removed: { type: 'boolean' },
    operation: {
      type: 'string',
      enum: ['summary', 'batch_execute', 'lanes_execute', 'lanes_integrate', 'fast_receipt_get', 'fast_receipt_list', 'execution_route', 'assess_work_mode'],
      description: 'Defaults to summary. Use batch_execute for multi-step Fast Path (one parent receipt). Use lanes_execute for limited parallel reads. Use assess_work_mode for Fast/Durable/Campaign routing advice.',
    },
    payload: {
      type: 'object',
      description: 'Operation-specific bounded arguments. Batch write operations should include request_id. For batch_execute: { steps:[{id?, kind, input}], stop_on_error?, allowed_paths?, timeout_ms?, request_id?, purpose? }. For assess_work_mode: { description, known_paths?, expected_files?, requires_parallelism?, independent_task_count?, agent_requested? }. Agent routing is opt-in only.',
      additionalProperties: true,
    },
  }),



  definition('repository_goal_list', 'List durable repository goals stored inside the checkout.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
  }, [], true),
  definition('repository_goal_upsert', 'Create or update one durable repository goal for repeated assistant workflows.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    id: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string', enum: ['active', 'paused', 'done'] },
    checks: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  }, []),
  definition('repository_stuck_diagnose', 'Diagnose likely repository workflow blockers from Git state and registered goals.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
  }, [], true),
  definition('repository_goal_run', 'Run one durable repository goal iteration, optionally executing its configured checks and recording a goal-run artifact.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    goal_id: { type: 'string', description: 'Goal id. Defaults to the first active goal.' },
    run_checks: { type: 'boolean', description: 'When true, execute configured checks. Defaults to diagnosis-only.' },
  }, []),
  definition('repository_goal_runs', 'List recent repository goal-run artifacts.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    limit: { type: 'number' },
  }, [], true),

  definition('repository_git_status', 'Return a structured Git status snapshot for the selected repository checkout.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    refresh: { type: 'boolean', description: 'When true, explicitly refresh the Git status sample. The default public hot path only reads the latest daemon sample.' },
  }, [], true),

  definition('repository_git_diff', 'Return a bounded structured git diff for the selected repository, optionally staged and path-scoped.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    staged: { type: 'boolean' },
    paths: { type: 'array', items: { type: 'string' } },
    max_bytes: { type: 'number' },
  }, [], true),
  definition('repository_git_create_branch', 'Create a safe local Git branch, optionally switching to it.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    branch: { type: 'string' },
    start_point: { type: 'string' },
    switch_to: { type: 'boolean', description: 'Defaults to true. False creates the branch without switching.' },
  }, ['branch']),
  definition('repository_git_switch_branch', 'Switch to a safe local Git branch name.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    branch: { type: 'string' },
  }, ['branch']),
  definition('repository_git_merge_branch', 'Merge a branch into the current branch using --ff-only by default.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    branch: { type: 'string' },
    no_ff: { type: 'boolean', description: 'Use --no-ff instead of the default --ff-only.' },
  }, ['branch']),
  definition('repository_git_delete_branch', 'Delete a safe local Git branch after it has been merged or intentionally discarded.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    branch: { type: 'string' },
    force: { type: 'boolean' },
  }, ['branch']),

  definition('repository_git_commit', 'Stage optional explicit paths and commit through a structured Git action.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    message: { type: 'string' },
    paths: { type: 'array', items: { type: 'string' } },
    allow_empty: { type: 'boolean' },
  }, ['message']),
  definition('repository_git_finish_workflow', 'Finish the current feature workflow: require clean tree, switch to target, merge feature branch, and delete it by default.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    feature_branch: { type: 'string', description: 'Defaults to the current branch.' },
    target_branch: { type: 'string', description: 'Defaults to repository defaultBranch or main.' },
    delete_branch: { type: 'boolean', description: 'Defaults to true.' },
    no_ff: { type: 'boolean', description: 'Use --no-ff instead of the default --ff-only.' },
  }, []),
  definition('repository_safe_patch_plan', 'Plan a deterministic chunked repository patch with fresh file fingerprints before applying.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    operations: { type: 'array', items: { type: 'object' }, description: 'Edit operations using the same shape as apply_patch.' },
    chunk_size: { type: 'number', description: 'Maximum operations per deterministic chunk. Capped at 100.' },
  }, ['operations'], true),
  definition('repository_safe_patch_apply', 'Apply a deterministic chunked repository patch through edit sessions, refreshing missing file fingerprints before each chunk. Defaults to synchronous interactive apply.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    session_id: { type: 'string', description: 'Existing edit session id. Omit to create one.' },
    purpose: { type: 'string', description: 'Purpose for a newly created edit session.' },
    operations: { type: 'array', items: { type: 'object' }, description: 'Edit operations using the same shape as apply_patch. create/write create parent dirs as needed.' },
    chunk_size: { type: 'number', description: 'Maximum operations per deterministic chunk. Capped at 100.' },
    expected_revision: { type: 'number', description: 'Expected starting edit-session revision.' },
    allowed_paths: { type: 'array', items: { type: 'string' }, description: 'Optional allowed path globs for a newly created session.' },
    continue_on_error: { type: 'boolean', description: 'Continue applying later independent chunks after a failed chunk. Defaults to false.' },
    refresh_fingerprints: { type: 'boolean', description: 'Refresh file fingerprints before every chunk. Defaults to true.' },
    recover_stale_session: { type: 'boolean', description: 'For new sessions, recover stale edit-session fingerprints into a fresh session. Defaults to true.' },
    apply_mode: { type: 'string', enum: ['sync', 'async'], description: 'Defaults to sync for interactive development. Set async to queue a durable Job.' },
  }, ['operations']),
  definition('repository_command_preview', 'Preview one repository-scoped local command with classification, approval token, and Git snapshots.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    command: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Legacy shell string or typed argv array. Typed argv executes without a shell.' },
    cwd: { type: 'string', description: 'Optional repository-relative working directory.' },
  }, ['command'], true),
  definition('repository_command_execute', 'Execute one repository-scoped local command through Full Access, Goal delegation, or a resumable approval request. Legacy preview-token callers remain compatible.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    command: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Legacy shell string or typed argv array. Typed argv executes without a shell.' },
    cwd: { type: 'string', description: 'Optional repository-relative working directory.' },
    approval_token: { type: 'string', description: 'Exact approval token returned by repository_command_preview.' },
    approval_request_id: { type: 'string', description: 'Resolved approvalRequestId returned by approval_resolve.' },
    timeout_ms: { type: 'number', description: 'Optional execution timeout in milliseconds.' },
    max_output_bytes: { type: 'number', description: 'Optional cap for captured stdout/stderr.' },
  }, ['command']),

  // Thin Harness V1 is exposed through repository_workbench operations to keep the stable tool surface bounded.
];

export const repositoryToolNames = repositoryToolDefinitions.map((tool) => tool.name);

function result(value: Record<string, unknown>): RepositoryToolResult {
  // Compact text channel by default; structuredContent remains the machine view.
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function failure(error: unknown): RepositoryToolResult {
  const message = compactErrorMessage(error);
  const code = message.includes(':') ? message.slice(0, message.indexOf(':')) : 'REPOSITORY_TOOL_FAILED';
  const details = typeof error === 'object' && error !== null && 'details' in error ? (error as { details?: unknown }).details : undefined;
  const compactDetails = details !== undefined && Buffer.byteLength(JSON.stringify(details) ?? '', 'utf8') > RESPONSE_BUDGET.previewBytes
    ? { omitted: true, message: 'Error details exceeded budget; inspect job/artifact/result refs.' }
    : details;
  return { ...result({ error: { code, message, ...(compactDetails !== undefined ? { details: compactDetails } : {}) } }), isError: true };
}

function compactProcessCommandPayload(input: {
  accepted?: boolean;
  mode: string;
  path: string;
  route?: string;
  reasons: string[];
  decision?: unknown;
  repoId: string;
  checkoutId?: string;
  processId?: string;
  process?: unknown;
  ok?: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durableSideEffects?: Record<string, number>;
  next: string;
  /** summary (default) omits nested process / routing dumps; detail restores diagnostics. */
  detailLevel?: 'summary' | 'detail';
  includeFullProcess?: boolean;
}): Record<string, unknown> {
  const output = compactCommandOutput(input.stdout, input.stderr, { ok: input.ok === true });
  const detail = input.detailLevel === 'detail' || input.includeFullProcess === true;
  const effects = input.durableSideEffects ?? {
    executionJobCount: 0,
    localJobCount: 0,
    workerSpawnCount: 0,
    projectionUpdateCount: 0,
  };
  const reason = input.reasons[0] ?? 'readonly_fast_path';

  // Default success/failure: one authoritative stdout/stderr pair, no nested process dump.
  if (!detail) {
    const ok = input.ok === true;
    const payload: Record<string, unknown> = {
      ok,
      accepted: ok,
      mode: input.mode,
      path: input.path,
      route: input.route ?? input.path,
      reason,
      repoId: input.repoId,
      ...(input.checkoutId ? { checkoutId: input.checkoutId } : {}),
      ...(input.processId ? { processId: input.processId } : {}),
      exitCode: input.exitCode ?? (ok ? 0 : 1),
      stdout: output.stdout ?? '',
      stderr: output.stderr ?? '',
      ...(output.stdoutTruncated ? { stdoutTruncated: true, stdoutBytes: output.stdoutBytes } : {}),
      ...(output.stderrTruncated ? { stderrTruncated: true, stderrBytes: output.stderrBytes } : {}),
    };
    if (!ok) {
      payload.error = {
        code: 'PROCESS_COMMAND_FAILED',
        message: (output.stderr || 'process_direct command failed').slice(0, 800),
        retryable: false,
        exitCode: input.exitCode ?? 1,
      };
    }
    // Zero side-effects are implicit for process_direct summary; only surface non-zero.
    const nonZeroEffects = Object.fromEntries(
      Object.entries(effects).filter(([, value]) => typeof value === 'number' && value > 0),
    );
    if (Object.keys(nonZeroEffects).length > 0) payload.durableSideEffects = nonZeroEffects;
    return payload;
  }

  return {
    accepted: input.accepted ?? true,
    mode: input.mode,
    path: input.path,
    route: input.route ?? input.path,
    routing: {
      ...compactRoutingSummary({ path: input.path, mode: input.mode, reasons: input.reasons }),
      ...(input.decision ? { decision: input.decision } : {}),
    },
    reason,
    repoId: input.repoId,
    ...(input.checkoutId ? { checkoutId: input.checkoutId } : {}),
    ...(input.processId ? { processId: input.processId } : {}),
    ok: input.ok,
    exitCode: input.exitCode,
    ...output,
    // Nested process only in detail mode; never duplicate stdout/stderr there.
    ...(input.process && typeof input.process === 'object'
      ? {
        process: (() => {
          const record = { ...(input.process as Record<string, unknown>) };
          delete record.stdout;
          delete record.stderr;
          delete record.durableSideEffects;
          return record;
        })(),
      }
      : {}),
    durableSideEffects: effects,
    next: input.next,
    detailLevel: 'detail',
  };
}

function settledLocalJobStatus(status: string): boolean {
  return ['pending_approval', 'succeeded', 'failed', 'timed_out', 'orphaned', 'stale', 'cancelled'].includes(status);
}

async function waitForRepositoryCommandHandoff(
  repoRoot: string,
  jobId: string,
  maxOutputBytes?: number,
): Promise<ReturnType<typeof buildLocalBridgeJobHandoff>> {
  const deadline = Date.now() + 400;
  while (Date.now() < deadline) {
    const snapshot = getLocalBridgeJobSnapshot(repoRoot, jobId);
    if (snapshot.status !== 'ok' || !snapshot.job || settledLocalJobStatus(snapshot.job.status)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return buildLocalBridgeJobHandoff(repoRoot, jobId, { maxBytes: maxOutputBytes });
}

export async function callRepositoryTool(
  controllerHome: string,
  name: string,
  args: Record<string, unknown>,
): Promise<RepositoryToolResult | undefined> {
  if (!name.startsWith('repository_')) return undefined;
  try {
    const repoIdValue = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
    switch (name) {
      case 'repository_register': {
        const repository = registerRepository({
          path: String(args.path ?? ''),
          controllerHome,
          displayName: typeof args.display_name === 'string' ? args.display_name : undefined,
          remoteUrl: typeof args.remote_url === 'string' ? args.remote_url : undefined,
          defaultBranch: typeof args.default_branch === 'string' ? args.default_branch : undefined,
        });
        return result({ repository, migration: bindRepositoryEntities(repository) });
      }
      case 'repository_latest_source_diagnose':
        return result({
          diagnosis: diagnoseLatestLocalProjectSource({
            path: typeof args.path === 'string' ? args.path : undefined,
            repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
            controllerHome,
          }),
        });
      case 'repository_bootstrap_local_project':
        return result({
          bootstrap: bootstrapLocalProject({
            path: String(args.path ?? ''),
            controllerHome,
            displayName: typeof args.display_name === 'string' ? args.display_name : undefined,
            defaultBranch: typeof args.default_branch === 'string' ? args.default_branch : undefined,
            mode: typeof args.mode === 'string' ? args.mode as 'init_git_only' | 'init_git_and_register' | 'replace_registration' : undefined,
            replaceRegisteredRepoId: typeof args.replace_registered_repo_id === 'string' ? args.replace_registered_repo_id : undefined,
            confirmAuthorization: args.confirm_authorization === true,
          }),
        });
      case 'repository_list':
        return result({ repositories: listRepositories(controllerHome, { includeRemoved: args.include_removed === true }).map(repositorySummary) });
      case 'repository_get':
        return result({ repository: getRepository(repoIdValue, controllerHome, { includeRemoved: args.include_removed === true }) });
      case 'repository_validate': {
        const repository = getRepository(repoIdValue, controllerHome, { includeRemoved: true });
        return result({ validation: validateRepository(repoIdValue, controllerHome), migration: bindRepositoryEntities(repository) });
      }
      case 'repository_refresh': {
        const repository = refreshRepository(repoIdValue, controllerHome);
        return result({ repository, migration: bindRepositoryEntities(repository) });
      }
      case 'repository_update':
        return result({ repository: updateRepository(repoIdValue, {
          displayName: typeof args.display_name === 'string' ? args.display_name : undefined,
          defaultBranch: typeof args.default_branch === 'string' ? args.default_branch : undefined,
          enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
        }, controllerHome) });
      case 'repository_disable':
        return result({ repository: disableRepository(repoIdValue, controllerHome) });
      case 'repository_remove':
        return result({ repository: removeRepository(repoIdValue, controllerHome) });
      case 'repository_workbench': {
        const operation = typeof args.operation === 'string' ? args.operation : 'summary';
        if (operation === 'summary') {
          return result({ workbench: buildControllerWorkbench(controllerHome, {
            repoId: repoIdValue || undefined,
            includeRemoved: args.include_removed === true,
          }) });
        }
        const payload = typeof args.payload === 'object' && args.payload !== null
          ? args.payload as Record<string, unknown>
          : {};
        if (operation === 'assess_work_mode') {
          const description = typeof payload.description === 'string'
            ? payload.description
            : typeof args.description === 'string' ? args.description : '';
          const assessment = assessWorkMode({
            description,
            knownPaths: Array.isArray(payload.known_paths) ? payload.known_paths.map(String) : undefined,
            expectedFiles: typeof payload.expected_files === 'number' ? payload.expected_files : undefined,
            expectedChangedLines: typeof payload.expected_changed_lines === 'number' ? payload.expected_changed_lines : undefined,
            requiresInvestigation: payload.requires_investigation === true,
            requiresParallelism: payload.requires_parallelism === true,
            requiresLongRunningChecks: payload.requires_long_running_checks === true,
            needsDependencies: payload.needs_dependencies === true,
            requiresIndependentDeliverables: payload.requires_independent_deliverables === true,
            independentTaskCount: typeof payload.independent_task_count === 'number' ? payload.independent_task_count : undefined,
            requiresRemoteWrite: payload.requires_remote_write === true || payload.remote_write === true,
            requiresRecovery: payload.requires_recovery === true,
            agentRequested: payload.agent_requested === true || payload.requires_worker === true,
            requiresWorkerIsolation: payload.requires_worker_isolation === true,
            risk: typeof payload.risk === 'string' ? payload.risk as 'low' | 'medium' | 'high' | 'destructive' : undefined,
          });
          return result({
            assessment,
            routing: {
              path: assessment.executionPath,
              reasons: assessment.reasons,
              recommendedMode: assessment.recommendedMode,
              issueRequired: assessment.issueRequired,
              campaignRequired: assessment.campaignRequired,
            },
            nextTools: assessment.nextTools,
          });
        }
        const internalTool = {
          batch_execute: 'repository_batch_execute',
          lanes_execute: 'repository_lanes_execute',
          lanes_integrate: 'repository_lanes_integrate',
          fast_receipt_get: 'repository_fast_receipt_get',
          fast_receipt_list: 'repository_fast_receipt_list',
          execution_route: 'repository_execution_route',
        }[operation];
        if (!internalTool) {
          return failure(new Error(`REPOSITORY_WORKBENCH_OPERATION_INVALID: ${operation}`));
        }
        return callRepositoryTool(controllerHome, internalTool, {
          ...payload,
          repo_id: repoIdValue || payload.repo_id,
          checkout_id: typeof args.checkout_id === 'string' ? args.checkout_id : payload.checkout_id,
        });
      }



      case 'repository_goal_list': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, registry: readRepositoryGoalRegistry(repository) });
      }
      case 'repository_goal_upsert': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, ...upsertRepositoryGoal(repository, { id: args.id, title: args.title, status: args.status, checks: args.checks, notes: args.notes }) as unknown as Record<string, unknown> });
      }
      case 'repository_stuck_diagnose': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ diagnosis: diagnoseRepositoryStuckState(repository) });
      }

      case 'repository_goal_run': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        const ran = withControllerLock(
          controllerHome,
          { scope: 'repository', repoId: repository.repoId },
          'mcp:repository_goal_run',
          () => runRepositoryGoal(repository, { goalId: args.goal_id, runChecks: args.run_checks }),
          60_000,
        );
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, ...ran as unknown as Record<string, unknown> });
      }
      case 'repository_goal_runs': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        const limit = typeof args.limit === 'number' ? args.limit : typeof args.limit === 'string' ? Number(args.limit) : undefined;
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, runs: listRepositoryGoalRuns(repository, limit) });
      }
      case 'repository_git_status': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        const status = args.refresh === true
          ? writeRepositoryGitStatusSample(controllerHome, repository)
          : readRepositoryGitStatusSample(controllerHome, repository.repoId, repository.activeCheckoutId);
        return result({
          status: status ?? {
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
            sampleSource: 'daemon-sample',
            sampled: false,
            observedAt: null,
            staleAgeMs: null,
            message: 'Git status has not been sampled by the Controller daemon yet. Retry after scheduler heartbeat or call with refresh=true for an explicit live refresh.',
          },
        });
      }

      case 'repository_git_diff': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ diff: repositoryGitDiff(repository, { staged: args.staged, paths: args.paths, maxBytes: args.max_bytes }) });
      }
      case 'repository_git_create_branch': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, ...repositoryGitCreateBranch(controllerHome, repository, { branch: args.branch, startPoint: args.start_point, switchTo: args.switch_to }) as unknown as Record<string, unknown> });
      }
      case 'repository_git_switch_branch': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, ...repositoryGitSwitchBranch(controllerHome, repository, { branch: args.branch }) as unknown as Record<string, unknown> });
      }
      case 'repository_git_merge_branch': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, ...repositoryGitMergeBranch(controllerHome, repository, { branch: args.branch, noFf: args.no_ff }) as unknown as Record<string, unknown> });
      }
      case 'repository_git_delete_branch': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, ...repositoryGitDeleteBranch(controllerHome, repository, { branch: args.branch, force: args.force }) as unknown as Record<string, unknown> });
      }

      case 'repository_git_commit': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ commit: repositoryGitCommit(controllerHome, repository, { message: args.message, paths: args.paths, allowEmpty: args.allow_empty }) });
      }
      case 'repository_git_finish_workflow': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ finish: repositoryGitFinishWorkflow(controllerHome, repository, { featureBranch: args.feature_branch, targetBranch: args.target_branch, deleteBranch: args.delete_branch, noFf: args.no_ff }) });
      }
      case 'repository_safe_patch_plan': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        return result({
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          plan: buildSafePatchPlan(repository, { operations: args.operations, chunkSize: args.chunk_size }),
        });
      }
      case 'repository_safe_patch_apply': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const applied = withControllerLock(
          controllerHome,
          { scope: 'repository', repoId: repository.repoId },
          'mcp:repository_safe_patch_apply',
          () => applySafePatch(repository, {
            sessionId: args.session_id,
            purpose: args.purpose,
            operations: args.operations,
            chunkSize: args.chunk_size,
            expectedRevision: args.expected_revision,
            allowedPaths: args.allowed_paths,
            continueOnError: args.continue_on_error,
            refreshFingerprints: args.refresh_fingerprints,
            recoverStaleSession: args.recover_stale_session,
          }),
          60_000,
        );
        const changedFiles = [
          ...new Set(
            (applied.appliedChunks ?? []).flatMap((chunk) => chunk.paths ?? []),
          ),
        ];
        const ok = applied.status === 'applied';
        const firstFailure = applied.failures?.[0];
        const digest = buildSyncOperationDigest({
          ok,
          operation: 'repository_safe_patch_apply',
          summary: ok
            ? `补丁已同步应用，涉及 ${changedFiles.length} 个文件。`
            : applied.status === 'partial'
              ? `补丁部分应用：${changedFiles.length} 个文件成功，存在失败 chunk。`
              : `补丁应用失败：${firstFailure?.message || '请检查 failures 摘要'}`,
          changedFiles,
          errorClass: ok ? undefined : classifyUserFacingError({
            code: firstFailure?.code,
            message: firstFailure?.message,
            infrastructure: firstFailure?.code === 'APPLY_FAILED',
          }),
          errorMessage: firstFailure?.message,
        });
        const payload = {
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          ...applied as unknown as Record<string, unknown>,
          phase: digest.phase,
          statusLabel: digest.statusLabel,
          summary: digest.summary,
          terminal: true,
          applyMode: 'sync',
          digest,
          suggestedNextActions: digest.suggestedNextActions,
        };
        return ok ? result(payload) : { ...result(payload), isError: true };
      }
      case 'repository_command_preview': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const execution = withControllerLock(
          controllerHome,
          { scope: 'repository', repoId: repository.repoId },
          'mcp:repository_command_preview',
          () => executeRepositoryCommand(controllerHome, repository, {
            command: args.command as string | string[],
            cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
            dryRun: true,
          }),
          60_000,
        );
        return result(execution as unknown as Record<string, unknown>);
      }
      case 'repository_command_execute': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const timeoutMs = typeof args.timeout_ms === 'number'
          ? args.timeout_ms
          : typeof args.timeout_ms === 'string'
            ? Number(args.timeout_ms)
            : undefined;
        const maxOutputBytes = typeof args.max_output_bytes === 'number'
          ? args.max_output_bytes
          : typeof args.max_output_bytes === 'string'
            ? Number(args.max_output_bytes)
            : undefined;
        // Worker-owned durable executions must not re-enter Fast Path or create a
        // nested ExecutionJob. Local Job remains the worker settlement surface.
        const fromDurableWorker = args.__from_durable_worker === true
          || typeof args.__execution_job_id === 'string';
        // Thin Harness: short readonly / focused-check commands skip Local Job when eligible.
        const forceDurable = fromDurableWorker
          || args.apply_mode === 'async'
          || args.mode === 'durable'
          || args.async === true
          || args.background === true;
        const routingDecision = routeExecution({
          operation: 'repository_command_execute',
          mode: forceDurable ? 'durable' : args.mode === 'fast' ? 'fast' : 'auto',
          command: args.command as string | string[] | undefined,
          timeoutMs,
          background: args.background === true || args.async === true,
          defaultBranch: repository.defaultBranch,
          approvalContinuation: typeof args.approval_request_id === 'string'
            || typeof args.approval_token === 'string',
        });
        // Unified Process Runtime for local commands (Direct/Managed) when not forced durable.
        if (!forceDurable && !fromDurableWorker) {
          try {
            const routeClass = classifyRepositoryCommandRoute(args.command as string | string[], {
              forceDurable: false,
              defaultBranch: repository.defaultBranch,
              timeoutMs,
            });
            // Only short readonly commands skip Local Job. Workspace mutations and
            // managed long builds keep the durable settlement surface (jobId/localJob).
            if (routeClass.route === 'process_direct') {
              const processResult = await executeRepositoryCommandViaProcessRuntime({
                controllerHome,
                repository,
                command: args.command as string | string[],
                cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
                timeoutMs,
                maxOutputBytes,
                requestId: typeof args.request_id === 'string' ? args.request_id : undefined,
              });
              if (processResult.route === 'process_direct') {
                const handle = processResult.process;
                const detailLevel = args.detail_level === 'detail' || args.detail === true
                  ? 'detail'
                  : 'summary';
                const payload = compactProcessCommandPayload({
                  accepted: processResult.ok === true,
                  mode: processResult.route,
                  path: processResult.route,
                  route: processResult.route,
                  reasons: [processResult.reason ?? routeClass.reason, ...routingDecision.reasons],
                  decision: detailLevel === 'detail' ? routingDecision : undefined,
                  repoId: repository.repoId,
                  checkoutId: repository.activeCheckoutId,
                  processId: handle?.processId,
                  process: detailLevel === 'detail' ? handle : undefined,
                  ok: processResult.ok,
                  exitCode: processResult.exitCode,
                  stdout: processResult.stdout,
                  stderr: processResult.stderr,
                  durableSideEffects: processResult.durableSideEffects,
                  next: 'Process Runtime Direct completed without Local Job / ExecutionJob / Worker.',
                  detailLevel,
                });
                return processResult.ok === true
                  ? result(payload)
                  : { ...result(payload), isError: true };
              }
            }
          } catch (error) {
            // Fall through to existing Fast/Durable paths on unexpected errors.
            if (process.env.REPO_HARNESS_DEBUG_PROCESS_RUNTIME === '1') {
              console.error('[repository_command_execute] process runtime error', error);
            }
          }
        }
        if (!forceDurable && routingDecision.mode === 'fast' && isFastEligibleTool('repository_command_execute', {
          command: args.command,
          timeout_ms: timeoutMs,
          mode: typeof args.mode === 'string' ? args.mode : 'auto',
        })) {
          const fast = await executeFast(
            { controllerHome, repository, includeLatencyBreakdown: args.include_latency_breakdown === true },
            {
              operation: 'repository_command_execute',
              mode: 'fast',
              input: {
                command: args.command,
                cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
                approval_token: typeof args.approval_token === 'string' ? args.approval_token : undefined,
                approval_request_id: typeof args.approval_request_id === 'string' ? args.approval_request_id : undefined,
                timeout_ms: timeoutMs,
              },
              timeoutMs,
            },
          );
          if (fast.escalation) {
            return result({
              mode: 'durable',
              path: 'durable',
              routing: {
                path: 'durable',
                reasons: fast.decision.reasons,
                decision: fast.decision,
              },
              reason: fast.escalation.reason,
              suggestedOperation: fast.escalation.suggestedOperation,
              decision: fast.decision,
              message: 'Fast Path declined before execution. Re-issue via Durable Work / Local Job explicitly.',
              latency: { totalMs: fast.latency.totalMs },
            });
          }
          const fastExecution = fast.result && typeof fast.result === 'object'
            ? fast.result as Record<string, unknown>
            : {};
          const fastOutput = compactCommandOutput(
            typeof fastExecution.stdout === 'string' ? fastExecution.stdout : undefined,
            typeof fastExecution.stderr === 'string' ? fastExecution.stderr : undefined,
            { ok: fast.ok },
          );
          const fastPayload = {
            accepted: fast.ok,
            mode: 'fast',
            path: 'fast',
            routing: compactRoutingSummary({ path: 'fast', mode: 'fast', reasons: fast.decision.reasons }),
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
            receiptId: (() => {
              const receipt = fast.receipt as unknown as Record<string, unknown> | undefined;
              return typeof receipt?.receiptId === 'string'
                ? receipt.receiptId
                : typeof receipt?.id === 'string'
                  ? receipt.id
                  : undefined;
            })(),
            ok: fast.ok,
            exitCode: typeof fastExecution.exitCode === 'number' ? fastExecution.exitCode : undefined,
            status: typeof fastExecution.status === 'string' ? fastExecution.status : undefined,
            ...fastOutput,
            durableSideEffects: fast.durableSideEffects,
            latency: args.include_latency_breakdown === true ? fast.latency : { totalMs: fast.latency.totalMs },
            next: 'Fast Path completed without Local Job / ExecutionJob / Worker.',
          };
          return fast.ok ? result(fastPayload) : { ...result(fastPayload), isError: true };
        }
        // Durable Worker calls skip Process/Fast above, then use the Local Bridge
        // compatibility projection below for writes/long commands so the worker
        // can settle the legacy child without creating a nested ExecutionJob.
        // Short readonly commands keep the zero-Local-Job direct path.
        if (fromDurableWorker) {
          try {
            const routeClass = classifyRepositoryCommandRoute(args.command as string | string[], {
              forceDurable: false,
              defaultBranch: repository.defaultBranch,
              timeoutMs,
            });
            if (routeClass.route === 'process_direct') {
              const processResult = await executeRepositoryCommandViaProcessRuntime({
                controllerHome,
                repository,
                command: args.command as string | string[],
                cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
                timeoutMs,
                maxOutputBytes,
                requestId: typeof args.request_id === 'string' ? args.request_id : undefined,
              });
              if (processResult.route === 'process_direct') {
                const execRecord = processResult.process as unknown as Record<string, unknown> | undefined;
                const ok = processResult.ok === true;
                const inlinePayload = {
                  accepted: ok,
                  mode: 'durable',
                  path: 'durable_worker_inline',
                  routing: compactRoutingSummary({
                    path: 'durable',
                    mode: 'durable',
                    reasons: ['durable_worker_inline_process_direct', routeClass.reason, ...routingDecision.reasons],
                  }),
                  repoId: repository.repoId,
                  checkoutId: repository.activeCheckoutId,
                  ok,
                  processId: typeof execRecord?.processId === 'string' ? execRecord.processId : undefined,
                  status: typeof execRecord?.status === 'string' ? execRecord.status : undefined,
                  exitCode: typeof processResult.exitCode === 'number' ? processResult.exitCode : undefined,
                  ...compactCommandOutput(
                    typeof processResult.stdout === 'string' ? processResult.stdout : undefined,
                    typeof processResult.stderr === 'string' ? processResult.stderr : undefined,
                    { ok },
                  ),
                  durableSideEffects: processResult.durableSideEffects,
                  next: 'Durable Worker executed a short readonly repository command inline without a Local Job.',
                };
                return ok ? result(inlinePayload) : { ...result(inlinePayload), isError: true };
              }
            }
          } catch (error) {
            if (process.env.REPO_HARNESS_DEBUG_PROCESS_RUNTIME === '1') {
              console.error('[repository_command_execute] durable worker inline process runtime error', error);
            }
          }
        }
        const preview = previewRepositoryCommandExecution(repository, {
          command: args.command as string | string[],
          cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
          authorization: 'confirmed_plan',
          approvalToken: typeof args.approval_token === 'string' ? args.approval_token : undefined,
          approvalRequestId: typeof args.approval_request_id === 'string' ? args.approval_request_id : undefined,
          timeoutMs,
          maxOutputBytes,
        }, controllerHome);
        if (!preview.executable) {
          return result(preview.execution as unknown as Record<string, unknown>);
        }
        const job = submitLocalBridgeJob(repository.canonicalRoot, {
          action: 'repository-command',
          requestedBy: 'mcp:repository_command_execute',
          payload: {
            controllerHome,
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
            requestId: typeof args.request_id === 'string' ? args.request_id.trim() || undefined : undefined,
            command: args.command as string | string[],
            cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
            approvalToken: typeof args.approval_token === 'string' ? args.approval_token : undefined,
            approvalRequestId: typeof args.approval_request_id === 'string' ? args.approval_request_id : undefined,
            timeoutMs,
            maxOutputBytes,
          },
        });
        const accepted = job.status === 'approved'
          ? executeLocalBridgeJob(repository.canonicalRoot, job.jobId)
          : job;
        const handoff = await waitForRepositoryCommandHandoff(repository.canonicalRoot, accepted.jobId, maxOutputBytes);
        const handoffOutput = compactCommandOutput(handoff.stdout, handoff.stderr, {
          ok: handoff.status === 'succeeded',
          maxInlineBytes: typeof maxOutputBytes === 'number' ? Math.min(maxOutputBytes, RESPONSE_BUDGET.inlineOutputBytes) : undefined,
        });
        // Compact localJob keeps legacy fields without nesting full job/repo state.
        const localJob = {
          jobId: handoff.jobId ?? accepted.jobId,
          status: handoff.status,
          stdout: handoffOutput.stdout,
          stderr: handoffOutput.stderr,
          stdoutBytes: handoffOutput.stdoutBytes,
          stderrBytes: handoffOutput.stderrBytes,
          stdoutTruncated: handoffOutput.stdoutTruncated,
          stderrTruncated: handoffOutput.stderrTruncated,
          stdoutPath: handoff.stdoutPath,
          stderrPath: handoff.stderrPath,
          outputStatus: handoff.outputStatus,
          nextLocalCommand: handoff.nextLocalCommand,
        };
        return result({
          accepted: true,
          mode: 'durable',
          path: 'durable',
          routing: compactRoutingSummary({
            path: 'durable',
            mode: 'durable',
            reasons: routingDecision.reasons.length > 0 ? routingDecision.reasons : ['policy_requires_durable'],
          }),
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          jobId: accepted.jobId,
          status: handoff.status,
          ...handoffOutput,
          localJob,
          outputStatus: handoff.outputStatus,
          next: handoff.nextLocalCommand ?? `Inspect Job ${accepted.jobId} with get_local_job or get_job.`,
        });
      }
      case 'repository_batch_execute': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const steps = Array.isArray(args.steps)
          ? args.steps
            .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
            .map((entry) => ({
              id: typeof entry.id === 'string' ? entry.id : undefined,
              kind: String(entry.kind ?? '') as
                | 'read_file'
                | 'search'
                | 'git_status'
                | 'git_diff'
                | 'apply_patch'
                | 'run_short_command'
                | 'run_focused_check'
                | 'stage_paths'
                | 'commit_paths',
              input: (typeof entry.input === 'object' && entry.input !== null
                ? entry.input
                : {}) as Record<string, unknown>,
            }))
          : [];
        const batch = await executeRepositoryBatch(
          { controllerHome, repository },
          {
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
            mode: args.mode === 'fast' || args.mode === 'durable' || args.mode === 'auto' ? args.mode : 'auto',
            steps,
            stopOnError: args.stop_on_error !== false,
            allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
            timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
            includeLatencyBreakdown: args.include_latency_breakdown === true,
            purpose: typeof args.purpose === 'string' ? args.purpose : undefined,
            requestId: typeof args.request_id === 'string' ? args.request_id.trim() || undefined : undefined,
          },
        );
        const payload = batch as unknown as Record<string, unknown>;
        return batch.ok ? result(payload) : { ...result(payload), isError: true };
      }
      case 'repository_lanes_execute': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const lanes = await executeLightweightLanes(
          { controllerHome, repository },
          {
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
            readLanes: Array.isArray(args.read_lanes)
              ? args.read_lanes
                .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
                .map((entry) => ({
                  id: typeof entry.id === 'string' ? entry.id : undefined,
                  kind: String(entry.kind ?? 'search') as 'search' | 'read_file' | 'git_status' | 'git_diff' | 'run_short_command',
                  input: (typeof entry.input === 'object' && entry.input !== null
                    ? entry.input
                    : {}) as Record<string, unknown>,
                }))
              : undefined,
            patchProposalLanes: Array.isArray(args.patch_proposal_lanes)
              ? args.patch_proposal_lanes
                .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
                .map((entry) => ({
                  id: typeof entry.id === 'string' ? entry.id : undefined,
                  readPaths: Array.isArray(entry.read_paths) ? entry.read_paths.map(String) : [],
                  writePaths: Array.isArray(entry.write_paths) ? entry.write_paths.map(String) : [],
                  proposedOperations: Array.isArray(entry.proposed_operations) ? entry.proposed_operations : [],
                  assumptions: Array.isArray(entry.assumptions) ? entry.assumptions.map(String) : undefined,
                  riskNotes: Array.isArray(entry.risk_notes) ? entry.risk_notes.map(String) : undefined,
                  suggestedFocusedCheck: entry.suggested_focused_check as string | string[] | undefined,
                }))
              : undefined,
            failFast: args.fail_fast === true,
            maxConcurrency: typeof args.max_concurrency === 'number' ? args.max_concurrency : undefined,
            includeLatencyBreakdown: args.include_latency_breakdown === true,
          },
        );
        const payload = lanes as unknown as Record<string, unknown>;
        return lanes.ok ? result(payload) : { ...result(payload), isError: true };
      }
      case 'repository_lanes_integrate': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const proposals = Array.isArray(args.proposals)
          ? args.proposals
            .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
            .map((entry) => ({
              id: String(entry.id ?? 'proposal'),
              ok: entry.ok !== false,
              durationMs: 0,
              readPaths: Array.isArray(entry.read_paths) ? entry.read_paths.map(String) : [],
              writePaths: Array.isArray(entry.write_paths) ? entry.write_paths.map(String) : [],
              proposedOperations: Array.isArray(entry.proposed_operations) ? entry.proposed_operations : [],
              analysisOnly: entry.analysis_only === true,
              proposalId: typeof entry.proposal_id === 'string'
                ? entry.proposal_id
                : typeof entry.proposalId === 'string'
                  ? entry.proposalId
                  : undefined,
            }))
          : [];
        const integrated = await integratePatchProposals(
          { controllerHome, repository },
          proposals,
          {
            sessionId: typeof args.session_id === 'string' ? args.session_id : undefined,
            allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
            purpose: typeof args.purpose === 'string' ? args.purpose : undefined,
            requestId: typeof args.request_id === 'string' ? args.request_id.trim() || undefined : undefined,
            continueOnError: args.continue_on_error === true,
          },
        );
        const payload = integrated as unknown as Record<string, unknown>;
        return integrated.ok ? result(payload) : { ...result(payload), isError: true };
      }
      case 'repository_fast_receipt_get': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const receipt = readFastReceipt(controllerHome, repository.repoId, String(args.execution_id ?? ''));
        if (!receipt) return failure(new Error(`FAST_RECEIPT_NOT_FOUND: ${String(args.execution_id ?? '')}`));
        return result({ receipt });
      }
      case 'repository_fast_receipt_list': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const limit = typeof args.limit === 'number' ? args.limit : undefined;
        return result({ receipts: listFastReceipts(controllerHome, repository.repoId, limit) });
      }
      case 'repository_execution_route': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const decision = routeExecution({
          operation: String(args.operation ?? ''),
          mode: args.mode === 'fast' || args.mode === 'durable' || args.mode === 'auto' ? args.mode : 'auto',
          command: args.command as string | string[] | undefined,
          timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
          background: args.background === true,
          paths: Array.isArray(args.paths) ? args.paths.map(String) : undefined,
          allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
          defaultBranch: repository.defaultBranch,
        });
        return result({ decision, repoId: repository.repoId, checkoutId: repository.activeCheckoutId });
      }
      default:
        return failure(new Error(`UNKNOWN_REPOSITORY_TOOL: ${name}`));
    }
  } catch (error) {
    return failure(error);
  }
}
