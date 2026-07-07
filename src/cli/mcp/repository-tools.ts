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
import type { CallToolResult, McpToolDefinition } from './tools';

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
  definition('repository_workbench', 'Return global or repository-filtered Workbench state.', {
    repo_id: repoId,
    include_removed: { type: 'boolean' },
  }, [], true),



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
  definition('repository_safe_patch_apply', 'Apply a deterministic chunked repository patch through edit sessions, refreshing missing file fingerprints before each chunk.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    session_id: { type: 'string', description: 'Existing edit session id. Omit to create one.' },
    purpose: { type: 'string', description: 'Purpose for a newly created edit session.' },
    operations: { type: 'array', items: { type: 'object' }, description: 'Edit operations using the same shape as apply_patch.' },
    chunk_size: { type: 'number', description: 'Maximum operations per deterministic chunk. Capped at 100.' },
    expected_revision: { type: 'number', description: 'Expected starting edit-session revision.' },
    allowed_paths: { type: 'array', items: { type: 'string' }, description: 'Optional allowed path globs for a newly created session.' },
    continue_on_error: { type: 'boolean', description: 'Continue applying later independent chunks after a failed chunk. Defaults to false.' },
    refresh_fingerprints: { type: 'boolean', description: 'Refresh file fingerprints before every chunk. Defaults to true.' },
    recover_stale_session: { type: 'boolean', description: 'For new sessions, recover stale edit-session fingerprints into a fresh session. Defaults to true.' },
  }, ['operations']),
  definition('repository_command_preview', 'Preview one repository-scoped local command with classification, approval token, and Git snapshots.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    command: { type: 'string', description: 'Repository-local shell command to classify and preview.' },
    cwd: { type: 'string', description: 'Optional repository-relative working directory.' },
  }, ['command'], true),
  definition('repository_command_execute', 'Execute one repository-scoped local command after replaying the exact approved preview token.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    command: { type: 'string', description: 'Repository-local shell command to execute.' },
    cwd: { type: 'string', description: 'Optional repository-relative working directory.' },
    approval_token: { type: 'string', description: 'Exact approval token returned by repository_command_preview.' },
    timeout_ms: { type: 'number', description: 'Optional execution timeout in milliseconds.' },
    max_output_bytes: { type: 'number', description: 'Optional cap for captured stdout/stderr.' },
  }, ['command', 'approval_token']),
];

export const repositoryToolNames = repositoryToolDefinitions.map((tool) => tool.name);

function result(value: Record<string, unknown>): RepositoryToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function failure(error: unknown): RepositoryToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.includes(':') ? message.slice(0, message.indexOf(':')) : 'REPOSITORY_TOOL_FAILED';
  const details = typeof error === 'object' && error !== null && 'details' in error ? (error as { details?: unknown }).details : undefined;
  return { ...result({ error: { code, message, ...(details ? { details } : {}) } }), isError: true };
}

function terminalLocalJobStatus(status: string): boolean {
  return ['succeeded', 'failed', 'timed_out', 'orphaned', 'stale', 'cancelled'].includes(status);
}

async function waitForRepositoryCommandHandoff(
  repoRoot: string,
  jobId: string,
  maxOutputBytes?: number,
): Promise<ReturnType<typeof buildLocalBridgeJobHandoff>> {
  const deadline = Date.now() + 400;
  while (Date.now() < deadline) {
    const snapshot = getLocalBridgeJobSnapshot(repoRoot, jobId);
    if (snapshot.status !== 'ok' || !snapshot.job || terminalLocalJobStatus(snapshot.job.status)) {
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
      case 'repository_workbench':
        return result({ workbench: buildControllerWorkbench(controllerHome, {
          repoId: repoIdValue || undefined,
          includeRemoved: args.include_removed === true,
        }) });



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
        return result({ status: repositoryGitStatus(repository) });
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
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, ...applied as unknown as Record<string, unknown> });
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
            command: String(args.command ?? ''),
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
        const preview = previewRepositoryCommandExecution(repository, {
          command: String(args.command ?? ''),
          cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
          authorization: 'confirmed_plan',
          approvalToken: typeof args.approval_token === 'string' ? args.approval_token : undefined,
          timeoutMs,
          maxOutputBytes,
        });
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
            command: String(args.command ?? ''),
            cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
            approvalToken: typeof args.approval_token === 'string' ? args.approval_token : undefined,
            timeoutMs,
            maxOutputBytes,
          },
        });
        const accepted = job.status === 'approved'
          ? executeLocalBridgeJob(repository.canonicalRoot, job.jobId)
          : job;
        const handoff = await waitForRepositoryCommandHandoff(repository.canonicalRoot, accepted.jobId, maxOutputBytes);
        return result({
          accepted: true,
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          jobId: accepted.jobId,
          status: handoff.status,
          localJob: handoff,
          next: handoff.nextLocalCommand ?? `Inspect Job ${accepted.jobId} with get_local_job.`,
        });
      }
      default:
        return failure(new Error(`UNKNOWN_REPOSITORY_TOOL: ${name}`));
    }
  } catch (error) {
    return failure(error);
  }
}
