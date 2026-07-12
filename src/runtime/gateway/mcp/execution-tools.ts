import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { basename, isAbsolute, relative, resolve } from 'path';
import type { McpToolDefinition, CallToolResult } from '../../../cli/mcp/tools';
import type { MultiRepositoryMcpToolContext } from '../../../cli/mcp/multi-repository';
import { getRepository, resolveRepositorySelection, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { withControllerLock } from '../../../cli/repositories/locks';
import { repositoryGitCommit, repositoryGitDeleteBranch, repositoryGitFinishWorkflow, repositoryGitStatus, repositoryGitDiff } from '../../../cli/repositories/structured-git';
import { executeRepositoryCommand, previewRepositoryCommandExecution } from '../../../cli/repositories/command-executor';
import { classifyRepositoryCommand } from '../../../cli/repositories/command-classifier';
import { ensureCampaignWorkspace } from '../../workflow/campaigns/workspace';
import { listControllerChecks, runControllerCheck } from '../../../cli/controller/check-runner';
import { readRepositoryAccessPolicy } from '../../control-plane/governance/access-policy';
import { createWorkContract, getWorkContract, updateWorkContract, appendVerificationRecord } from '../../control-plane/facade/work-contract-store';
import { currentControllerInstanceId, requireExecutionSession, startExecutionSession, updateExecutionSession, type ExecutionSessionContext, type SessionIdentity } from '../../control-plane/execution/session-store';
import { currentPermissionSnapshotVersion, validateWorkHandle, type ValidationLevel } from '../../control-plane/execution/validation';
import { markWorkHandleFailed, newWorkId, readWorkHandle, transitionWorkHandle, writeWorkHandle, type WorkFinalizationStages, type WorkHandleState } from '../../control-plane/execution/work-handle-store';
import { assertResolvedAuthorization, createGoalDelegation, decideAuthorization, resolveAuthorizationRequest, type AuthorizationDecision, type AuthorizationRiskClass } from '../../control-plane/governance/authorization';
import { readControllerResult, searchControllerResult, writeControllerResult } from '../../evidence/result-store';
import { recordMcpTiming, type McpTimingTrace } from '../../diagnostics/mcp-timing';
import { commandValue, normalizeRepositoryCommand, type RepositoryCommandValue } from '../../../cli/repositories/command-normalization';

const MAX_INLINE_RESULT_BYTES = 64 * 1024;

function definition(name: string, description: string, properties: Record<string, unknown>, required: string[] = [], readOnlyHint = false, destructiveHint = false): McpToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }, annotations: { readOnlyHint, openWorldHint: false, destructiveHint } };
}

const sessionId = { type: 'string', description: 'Controller-issued session id returned by session_start. Omit only when the MCP transport binds one.' };
const workId = { type: 'string', description: 'Controller-owned work handle id returned by work_prepare.' };
const repoId = { type: 'string', description: 'Stable repository id. Repository switching must be explicit through session_bind_repository.' };

export const executionToolDefinitions: McpToolDefinition[] = [
  definition('session_start', 'Start or resume a controller-owned MCP execution session. Identity comes from the authenticated/controller-issued transport context.', {}, [], false),
  definition('session_bind_repository', 'Explicitly bind the current session to one registered repository and checkout.', { session_id: sessionId, repo_id: repoId, checkout_id: { type: 'string' } }, ['repo_id'], false),
  definition('work_prepare', 'Prepare or reuse one controller-owned work handle and bind it to a WorkContract, checkout, branch, and permission snapshot.', {
    session_id: sessionId, repo_id: repoId, checkout_id: { type: 'string' }, work_id: workId,
    objective: { type: 'string' }, goal_id: { type: 'string' }, acceptance_criteria: { type: 'array', items: { type: 'string' } }, allowed_paths: { type: 'array', items: { type: 'string' } }, checks: { type: 'array', items: { type: 'string' } },
    isolation: { type: 'string', enum: ['reuse', 'new_worktree', 'auto'] }, base_ref: { type: 'string' },
  }, [], false),
  definition('work_inspect', 'Collect bounded Git, WorkContract, path, check, and readiness evidence through one work handle.', { session_id: sessionId, work_id: workId, detail: { type: 'string', enum: ['summary', 'detail'] } }, ['work_id'], true),
  definition('work_execute', 'Execute approved, repository-scoped commands against a validated work handle while preserving the existing command policy and audit path.', {
    session_id: sessionId, work_id: workId,
    command: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }] }, approval_token: { type: 'string' }, cwd: { type: 'string' }, timeout_ms: { type: 'number' }, max_output_bytes: { type: 'number' },
    commands: { type: 'array', items: { type: 'object' } }, approval_request_id: { type: 'string' },
  }, ['work_id'], false),
  definition('work_validate', 'Run targeted checks or read-only validation commands against a work handle with full current-state validation.', {
    session_id: sessionId, work_id: workId, check_ids: { type: 'array', items: { type: 'string' } }, commands: { type: 'array', items: { type: 'object' } },
  }, ['work_id'], false),
  definition('work_finalize', 'Idempotently validate, commit, merge, clean a managed worktree, and complete the existing WorkContract in independently recorded stages.', {
    session_id: sessionId, work_id: workId, commit: { type: 'boolean' }, message: { type: 'string' }, merge: { type: 'boolean' }, target_branch: { type: 'string' }, delete_branch: { type: 'boolean' }, cleanup: { type: 'boolean' }, no_ff: { type: 'boolean' }, approval_request_id: { type: 'string' },
  }, ['work_id'], false, true),
  definition('approval_resolve', 'Resolve a controller approval request from the current conversation; GUI approval is optional and not required for continuation.', { session_id: sessionId, repo_id: repoId, work_id: workId, approval_request_id: { type: 'string' }, confirm_authorization: { type: 'boolean' } }, ['approval_request_id', 'confirm_authorization'], false),
  definition('result_read', 'Read a session-scoped result reference with bounded pagination.', { session_id: sessionId, result_ref: { type: 'string' }, work_id: workId, cursor: { type: 'number' }, limit: { type: 'number' } }, ['result_ref'], true),
  definition('result_search', 'Search a session-scoped result reference without returning the full payload.', { session_id: sessionId, result_ref: { type: 'string' }, work_id: workId, query: { type: 'string' }, limit: { type: 'number' } }, ['result_ref', 'query'], true),
];

const executionToolNames = new Set(executionToolDefinitions.map((tool) => tool.name));

function result(value: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

function failure(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.includes(':') ? message.slice(0, message.indexOf(':')) : 'EXECUTION_TOOL_FAILED';
  return result({ error: { code, message } }, true);
}

function principalFor(ctx: MultiRepositoryMcpToolContext): string {
  return ctx.principalId?.trim() || `controller-issued:${ctx.controllerInstanceId ?? currentControllerInstanceId()}`;
}

function identityFor(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): SessionIdentity {
  return {
    sessionId: typeof args.session_id === 'string' && args.session_id.trim() ? args.session_id.trim() : ctx.sessionId,
    principalId: principalFor(ctx),
    controllerInstanceId: ctx.controllerInstanceId ?? currentControllerInstanceId(),
  };
}

function startOrResumeSession(ctx: MultiRepositoryMcpToolContext): ExecutionSessionContext {
  const permissionVersion = ctx.explicitRepository ? currentPermissionSnapshotVersion(ctx.controllerHome, ctx.explicitRepository.repoId) : 0;
  return startExecutionSession(ctx.controllerHome, {
    sessionId: ctx.sessionId,
    principalId: principalFor(ctx),
    controllerInstanceId: ctx.controllerInstanceId ?? currentControllerInstanceId(),
    permissionSnapshotVersion: permissionVersion,
    capabilitySnapshotVersion: 1,
  });
}

function requireSession(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): ExecutionSessionContext {
  return requireExecutionSession(ctx.controllerHome, identityFor(ctx, args));
}

function requireExplicitRepoId(args: Record<string, unknown>): string {
  const value = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
  if (!value) throw new Error('REPOSITORY_ID_REQUIRED: repository selection must be explicit for session binding');
  return value;
}

function selectedRepository(ctx: MultiRepositoryMcpToolContext, session: ExecutionSessionContext, args: Record<string, unknown>, allowSession = true) {
  const requested = typeof args.repo_id === 'string' && args.repo_id.trim() ? args.repo_id.trim() : undefined;
  const selectedRepoId = requested ?? (allowSession ? session.activeRepositoryId : undefined);
  if (!selectedRepoId) throw new Error('SESSION_REPOSITORY_REQUIRED: bind a repository before using this work tool');
  if (session.activeRepositoryId && requested && session.activeRepositoryId !== requested) {
    throw new Error('SESSION_REPOSITORY_MISMATCH: call session_bind_repository before switching repositories');
  }
  return resolveRepositorySelection({ repoId: selectedRepoId, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : session.activeCheckoutId, controllerHome: ctx.controllerHome, allowSoleRepository: false });
}

function compactHandle(handle: WorkHandleState): Record<string, unknown> {
  return {
    workId: handle.workId, sessionId: handle.sessionId, repoId: handle.repositoryId, checkoutId: handle.checkoutId,
    worktreePath: handle.worktreePath, branch: handle.branch, sourceCheckoutId: handle.sourceCheckoutId, goalId: handle.goalId, delegationVersion: handle.delegationVersion,
    workContractId: handle.workContractId, baseCommit: handle.baseCommit, expectedHead: handle.expectedHead,
    permissionSnapshotVersion: handle.permissionSnapshotVersion, state: handle.state, managedWorktree: handle.managedWorktree,
    createdAt: handle.createdAt, updatedAt: handle.updatedAt, finalization: handle.finalization, ...(handle.failureReason ? { failureReason: handle.failureReason } : {}),
  };
}

function initialStage(): WorkFinalizationStages {
  return { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' };
}

function gitHead(root: string): string | undefined {
  const output = spawnSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
  return output.status === 0 && typeof output.stdout === 'string' ? output.stdout.trim() : undefined;
}

function makeBoundedResult(ctx: MultiRepositoryMcpToolContext, session: ExecutionSessionContext, repoId: string, workIdValue: string | undefined, kind: 'inspection' | 'command' | 'validation' | 'finalization' | 'generic', value: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_INLINE_RESULT_BYTES) return value;
  const started = performance.now();
  const stored = writeControllerResult({ controllerHome: ctx.controllerHome, repoId, sessionId: session.sessionId, principalId: session.principalId, workId: workIdValue, kind, value });
  return {
    summary: { itemCount: Array.isArray(value.items) ? value.items.length : undefined, truncated: true, warnings: ['Full result is available through the secure result reference.'] },
    items: Array.isArray(value.items) ? value.items.slice(0, 25) : { preview: serialized.slice(0, 16_384) },
    resultRef: stored.resultRef,
    resultId: stored.resultId,
    byteLength: stored.byteLength,
    _resultPersistenceMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

function contractFor(ctx: MultiRepositoryMcpToolContext, handle: WorkHandleState) {
  return handle.workContractId ? getWorkContract({ controllerHome: ctx.controllerHome, repoId: handle.repositoryId }, handle.workContractId) : undefined;
}

function workForSession(ctx: MultiRepositoryMcpToolContext, session: ExecutionSessionContext, args: Record<string, unknown>): WorkHandleState {
  const requested = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  const workIdValue = requested || session.activeWorkId || '';
  if (!workIdValue || !session.activeRepositoryId) throw new Error('WORK_ID_REQUIRED: call work_prepare first');
  if (session.activeWorkId && requested && requested !== session.activeWorkId) throw new Error('WORK_HANDLE_NOT_ACTIVE: requested work is not the active session work');
  const handle = readWorkHandle(ctx.controllerHome, session.activeRepositoryId, workIdValue);
  if (!handle) throw new Error(`WORK_HANDLE_NOT_FOUND: ${workIdValue}`);
  return handle;
}

function invalidateActiveWork(ctx: MultiRepositoryMcpToolContext, session: ExecutionSessionContext, reason: string): void {
  if (!session.activeRepositoryId || !session.activeWorkId) return;
  const handle = readWorkHandle(ctx.controllerHome, session.activeRepositoryId, session.activeWorkId);
  if (handle && handle.state !== 'cleaned') markWorkHandleFailed(ctx.controllerHome, handle, reason);
}

function bindSessionRepository(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Record<string, unknown> {
  const session = requireSession(ctx, args);
  const repository = resolveRepositorySelection({ repoId: requireExplicitRepoId(args), checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome: ctx.controllerHome, allowSoleRepository: false });
  const switching = session.activeRepositoryId !== undefined && (session.activeRepositoryId !== repository.repoId || session.activeCheckoutId !== repository.activeCheckoutId);
  if (switching) invalidateActiveWork(ctx, session, 'explicit repository or checkout switch invalidated the previous active work handle');
  const next = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
    activeRepositoryId: repository.repoId,
    activeCheckoutId: repository.activeCheckoutId,
    activeWorkId: undefined,
    goalDelegation: undefined,
    permissionSnapshotVersion: currentPermissionSnapshotVersion(ctx.controllerHome, repository.repoId),
    lastValidatedAt: new Date().toISOString(),
  });
  return { session: next, repository: { repoId: repository.repoId, checkoutId: repository.activeCheckoutId, canonicalRoot: repository.canonicalRoot, branch: repository.checkouts.find((entry) => entry.checkoutId === repository.activeCheckoutId)?.branch ?? null }, switched: switching };
}

function prepareWork(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Record<string, unknown> {
  const session = requireSession(ctx, args);
  const repository = selectedRepository(ctx, session, args, true);
  if (!session.activeRepositoryId) {
    updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: repository.repoId, activeCheckoutId: repository.activeCheckoutId, permissionSnapshotVersion: currentPermissionSnapshotVersion(ctx.controllerHome, repository.repoId) });
  }
  const existingId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  if (existingId) {
    const existing = readWorkHandle(ctx.controllerHome, repository.repoId, existingId);
    if (!existing) throw new Error(`WORK_HANDLE_NOT_FOUND: ${existingId}`);
    if (existing.sessionId !== session.sessionId || existing.principalId !== session.principalId) throw new Error('WORK_HANDLE_ACCESS_DENIED');
    validateWorkHandle(ctx.controllerHome, existing, identityFor(ctx, args), 'cheap', 'inspect');
    updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: existing.repositoryId, activeCheckoutId: existing.checkoutId, activeWorkId: existing.workId, permissionSnapshotVersion: existing.permissionSnapshotVersion });
    return { session: requireSession(ctx, args), work: compactHandle(existing), reused: true };
  }

  const isolation = args.isolation === 'reuse' || args.isolation === 'new_worktree' || args.isolation === 'auto' ? args.isolation : 'auto';
  const objective = String(args.objective ?? 'Controller-managed repository work').trim().slice(0, 2_000);
  const baseCheckoutId = repository.activeCheckoutId;
  const baseStatus = repositoryGitStatus(repository);
  if (isolation === 'reuse' && !baseStatus.clean) throw new Error('WORKTREE_DIRTY: reuse was requested but the selected checkout is dirty; choose new_worktree or auto');
  const useWorktree = isolation === 'new_worktree' || (isolation === 'auto' && !baseStatus.clean);
  const createdWorkId = newWorkId();
  const policy = readRepositoryAccessPolicy(ctx.controllerHome, repository.repoId);
  const contract = createWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, {
    workId: createdWorkId,
    repoId: repository.repoId,
    mode: useWorktree ? 'goal_workloop' : 'direct_control',
    objective,
    acceptanceCriteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String).slice(0, 20) : [],
    allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String).slice(0, 50) : [],
    forbiddenPaths: [],
    checks: Array.isArray(args.checks) ? args.checks.map(String).slice(0, 30) : [],
    constraints: { accessMode: policy.mode, workspaceMode: useWorktree ? 'isolated' : 'current', requireWorktree: useWorktree, allowCommit: true, allowMerge: true, allowCleanup: true },
    worktreePolicy: { required: useWorktree, reason: useWorktree ? 'work_prepare selected isolated worktree execution' : 'explicitly reused a registered checkout' },
    requestedBy: 'chatgpt',
  });
  const goalId = typeof args.goal_id === 'string' && args.goal_id.trim() ? args.goal_id.trim() : undefined;
  const delegation = createGoalDelegation({
    sessionId: session.sessionId,
    repositoryId: repository.repoId,
    workId: createdWorkId,
    goalId,
    allowedRiskClasses: ['readonly', 'local_repo_write', 'workspace_write', 'local_command', 'dependency_change', 'local_git'],
    deniedRiskClasses: ['remote_write', 'destructive', 'secret_access', 'outside_repository'],
    permissionSnapshotVersion: policy.revision,
    source: 'gpt_risk_delegate',
  });
  try {
    const workspace = useWorktree
      ? ensureCampaignWorkspace(ctx.controllerHome, repository, { requestId: createdWorkId, title: objective, baseRef: typeof args.base_ref === 'string' ? args.base_ref : undefined })
      : { mode: 'current' as const, checkoutId: baseCheckoutId, root: repository.canonicalRoot, branch: baseStatus.branch ?? 'detached', baseRevision: baseStatus.head ?? undefined, managed: false };
    const refreshed = getRepository(repository.repoId, ctx.controllerHome);
    const checkout = selectRepositoryCheckout(refreshed, workspace.checkoutId);
    const branch = workspace.branch || repositoryGitStatus(checkout).branch;
    if (!branch) throw new Error('WORKTREE_DETACHED: selected worktree has no branch');
    const head = gitHead(checkout.canonicalRoot);
    const handle: WorkHandleState = {
      schemaVersion: 1, workId: createdWorkId, sessionId: session.sessionId, principalId: session.principalId,
      repositoryId: repository.repoId, checkoutId: checkout.activeCheckoutId, worktreePath: checkout.canonicalRoot, branch,
      sourceCheckoutId: baseCheckoutId, managedWorktree: workspace.managed, workContractId: contract.workId, goalId, delegationVersion: delegation.version,
      baseCommit: workspace.baseRevision ?? head, expectedHead: head, permissionSnapshotVersion: policy.revision,
      state: 'prepared', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finalization: initialStage(),
    };
    writeWorkHandle(ctx.controllerHome, handle);
    updateWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, contract.workId, { status: 'running', worktreeRef: checkout.canonicalRoot });
    const nextSession = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: repository.repoId, activeCheckoutId: checkout.activeCheckoutId, activeWorkId: createdWorkId, permissionSnapshotVersion: policy.revision, goalDelegation: delegation, lastValidatedAt: new Date().toISOString() });
    return { session: nextSession, work: compactHandle(handle), reused: false, isolation: workspace.mode };
  } catch (error) {
    updateWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, contract.workId, { status: 'failed' });
    throw error;
  }
}

function inspectWork(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Record<string, unknown> {
  const session = requireSession(ctx, args);
  const handle = workForSession(ctx, session, args);
  const started = performance.now();
  const validationStarted = performance.now();
  const validated = validateWorkHandle(ctx.controllerHome, handle, identityFor(ctx, args), 'cheap', 'inspect');
  const validationMs = performance.now() - validationStarted;
  const status = repositoryGitStatus(validated.worktreeRepository);
  const diff = repositoryGitDiff(validated.worktreeRepository, { maxBytes: 64 * 1024 });
  const contract = contractFor(ctx, handle);
  const checks = contract?.checks ?? [];
  const packageManifest = existsSync(`${validated.worktreeRepository.canonicalRoot}/package.json`)
    ? JSON.parse(readFileSync(`${validated.worktreeRepository.canonicalRoot}/package.json`, 'utf-8')) as Record<string, unknown>
    : undefined;
  const value = {
    session: { sessionId: session.sessionId, repoId: session.activeRepositoryId, checkoutId: session.activeCheckoutId },
    work: compactHandle(handle),
    readiness: { valid: true, warnings: validated.warnings, permissionSnapshotVersion: handle.permissionSnapshotVersion },
    git: { status, diff: { nameOnly: diff.nameOnly, stat: diff.stat, patch: diff.patch, truncated: diff.truncated } },
    workContract: contract ? { workId: contract.workId, status: contract.status, objective: contract.objective, checks: contract.checks, acceptanceCriteria: contract.acceptanceCriteria, allowedPaths: contract.allowedPaths } : undefined,
    paths: { allowed: handle.workContractId ? contract?.allowedPaths ?? [] : [], relevant: diff.nameOnly },
    checks: checks.map((checkId) => ({ checkId, registered: listControllerChecks(validated.worktreeRepository.canonicalRoot).some((check) => check.id === checkId) })),
    package: packageManifest ? { name: packageManifest.name, scripts: packageManifest.scripts } : undefined,
  };
  const response = makeBoundedResult(ctx, session, handle.repositoryId, handle.workId, 'inspection', value);
  const trace: McpTimingTrace = { tool: 'work_inspect', sessionResolutionMs: 0, repositoryResolutionMs: 0, workHandleValidationMs: Math.round(validationMs * 100) / 100, resultSerializationMs: 0, totalToolDurationMs: Math.round((performance.now() - started) * 100) / 100, sessionId: session.sessionId, repoId: handle.repositoryId, workId: handle.workId };
  recordMcpTiming(ctx.controllerHome, trace);
  return response;
}

function commandInputs(args: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(args.commands)) return args.commands.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value)));
  if (args.command !== undefined) return [{ command: args.command, cwd: args.cwd, approval_token: args.approval_token, timeout_ms: args.timeout_ms, max_output_bytes: args.max_output_bytes }];
  throw new Error('COMMAND_REQUIRED: provide command or commands');
}

function authorizationRisk(command: RepositoryCommandValue, classification: ReturnType<typeof classifyRepositoryCommand>): AuthorizationRiskClass {
  if (classification.risk === 'readonly') return 'readonly';
  if (classification.risk === 'remote_write') return 'remote_write';
  if (classification.risk === 'destructive') return 'destructive';
  const executable = typeof command === 'string' ? command : command[0] ?? '';
  if (typeof command === 'string' && /\b(?:npm|bun|pnpm|yarn)\s+(?:install|add|remove|update)\b/i.test(command)) return 'dependency_change';
  if (/^\s*(?:git|.*[\\/]git)(?:\s|$)/i.test(executable)) return 'local_git';
  return 'workspace_write';
}

async function executeWork(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const session = requireSession(ctx, args);
  const handle = workForSession(ctx, session, args);
  const commands = commandInputs(args);
  if (commands.length > 16) throw new Error('COMMAND_BATCH_TOO_LARGE: at most 16 commands per work_execute');
  const cheap = validateWorkHandle(ctx.controllerHome, handle, identityFor(ctx, args), 'cheap', 'execute');
  const inputs = commands.map((entry) => ({
    command: commandValue(normalizeRepositoryCommand(entry.command)),
    cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
    approvalToken: typeof entry.approval_token === 'string' ? entry.approval_token : undefined,
  }));
  const classifications = inputs.map((entry) => classifyRepositoryCommand(entry.command, cheap.repository.defaultBranch));
  const requiresFull = classifications.some((classification) => classification.risk !== 'readonly');
  if (requiresFull) validateWorkHandle(ctx.controllerHome, handle, identityFor(ctx, args), 'full', 'execute');
  const decisions: AuthorizationDecision[] = [];
  const approvalRequestId = typeof args.approval_request_id === 'string' ? args.approval_request_id.trim() : '';
  const resolvedRequest = approvalRequestId
    ? assertResolvedAuthorization({ controllerHome: ctx.controllerHome, repositoryId: handle.repositoryId, approvalRequestId, sessionId: session.sessionId, principalId: session.principalId, workId: handle.workId, permissionSnapshotVersion: handle.permissionSnapshotVersion, command: inputs[0]?.command })
    : undefined;
  for (const [index, entry] of inputs.entries()) {
    const classification = classifications[index]!;
    const outsideCwd = Boolean(entry.cwd && (isAbsolute(entry.cwd) || (() => {
      const rel = relative(resolve(handle.worktreePath), resolve(handle.worktreePath, entry.cwd));
      return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\');
    })()));
    const risk = outsideCwd ? 'outside_repository' : authorizationRisk(entry.command, classification);
    const decision = resolvedRequest
      ? { decision: 'allow', source: 'user_confirmation', reason: 'The user resolved the exact approval request for this command.' } as const
      : decideAuthorization({
        controllerHome: ctx.controllerHome,
        accessMode: readRepositoryAccessPolicy(ctx.controllerHome, handle.repositoryId).mode,
        risk,
        repositoryId: handle.repositoryId,
        currentRepositoryId: handle.repositoryId,
        workId: handle.workId,
        boundWorkId: handle.workId,
        goalId: handle.goalId,
        boundGoalId: handle.goalId,
        sessionId: session.sessionId,
        principalId: session.principalId,
        permissionSnapshotVersion: handle.permissionSnapshotVersion,
        delegation: session.goalDelegation,
        worktreePath: handle.worktreePath,
        cwd: entry.cwd,
        command: entry.command,
        approvedByUser: Boolean(resolvedRequest),
      });
    decisions.push(decision);
    if (decision.decision !== 'allow') return { authorization: decision, work: compactHandle(handle), command: entry.command };
  }
  const run = (entry: typeof inputs[number], index: number) => executeRepositoryCommand(ctx.controllerHome, cheap.worktreeRepository, {
    command: entry.command,
    cwd: entry.cwd,
    approvalToken: resolvedRequest?.approvalToken ?? entry.approvalToken,
    authorization: resolvedRequest
      ? 'confirmed_plan'
      : decisions[index]?.decision === 'allow' ? decisions[index].source : 'explicit_user_request',
    authorizationDecision: decisions[index],
    approvalRequestId: resolvedRequest?.approvalRequestId,
    sessionId: session.sessionId,
    principalId: session.principalId,
    workId: handle.workId,
    timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
    maxOutputBytes: typeof args.max_output_bytes === 'number' ? args.max_output_bytes : undefined,
  });
  const started = performance.now();
  const executions = classifications.every((classification) => classification.risk === 'readonly') ? await Promise.all(inputs.map(async (entry, index) => run(entry, index))) : inputs.map(run);
  const branch = repositoryGitStatus(cheap.worktreeRepository).branch;
  const head = gitHead(cheap.worktreeRepository.canonicalRoot);
  let nextHandle = handle;
  if (branch !== handle.branch) nextHandle = markWorkHandleFailed(ctx.controllerHome, handle, `command changed the bound branch to ${branch ?? 'detached'}`);
  else nextHandle = transitionWorkHandle(ctx.controllerHome, handle, 'editing', { expectedHead: head, failureReason: undefined });
  const value = { work: compactHandle(nextHandle), commands: executions, executedCount: executions.filter((entry) => entry.status === 'executed' && entry.ok === true).length };
  const response = makeBoundedResult(ctx, session, handle.repositoryId, handle.workId, 'command', value);
  recordMcpTiming(ctx.controllerHome, { tool: 'work_execute', workHandleValidationMs: 0, commandExecutionMs: Math.round((performance.now() - started) * 100) / 100, totalToolDurationMs: Math.round((performance.now() - started) * 100) / 100, sessionId: session.sessionId, repoId: handle.repositoryId, workId: handle.workId });
  return response;
}

function validateWork(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Record<string, unknown> {
  const session = requireSession(ctx, args);
  const handle = workForSession(ctx, session, args);
  const validated = validateWorkHandle(ctx.controllerHome, handle, identityFor(ctx, args), 'full', 'validate');
  const current = transitionWorkHandle(ctx.controllerHome, handle, 'validating', { finalization: { ...handle.finalization, validation: 'pending' } });
  const contract = contractFor(ctx, current);
  const requestedChecks = Array.isArray(args.check_ids) ? args.check_ids.map(String).filter(Boolean) : contract?.checks ?? [];
  const available = new Set(listControllerChecks(validated.worktreeRepository.canonicalRoot).map((check) => check.id));
  const checks = requestedChecks.map((checkId) => {
    if (!available.has(checkId)) return { checkId, ok: false, status: 'missing', summary: `Check not found: ${checkId}` };
    const executed = runControllerCheck(validated.worktreeRepository.canonicalRoot, checkId);
    appendVerificationRecord({ controllerHome: ctx.controllerHome, repoId: handle.repositoryId }, handle.workId, { checkId, outcome: executed.ok ? 'valid_pass' : executed.timedOut ? 'infrastructure_failure' : 'valid_fail', summary: executed.ok ? 'passed' : executed.timedOut ? 'timed out' : 'failed', recordedAt: new Date().toISOString(), evidenceRef: executed.artifactPath ? { title: checkId, summary: executed.artifactPath, detailLevel: 'summary' } : undefined });
    return { checkId, ok: executed.ok, status: executed.ok ? 'passed' : executed.timedOut ? 'infrastructure_failure' : 'failed', summary: executed.ok ? 'passed' : executed.timedOut ? 'timed out' : 'failed', artifactPath: executed.artifactPath };
  });
  const passed = checks.every((check) => check.ok === true);
  const nextState = passed ? (handle.state === 'committed' ? 'committed' : handle.state === 'merged' ? 'merged' : 'editing') : 'failed';
  const next = transitionWorkHandle(ctx.controllerHome, current, nextState, { finalization: { ...current.finalization, validation: passed ? 'done' : 'failed', ...(passed ? {} : { lastError: 'targeted validation failed' }) } });
  if (contract) updateWorkContract({ controllerHome: ctx.controllerHome, repoId: handle.repositoryId }, handle.workId, { status: passed ? 'running' : 'failed' });
  const value = { work: compactHandle(next), validation: { passed, checks, targeted: true } };
  return makeBoundedResult(ctx, session, handle.repositoryId, handle.workId, 'validation', value);
}

function runCleanup(targetRoot: string, worktreePath: string): { ok: boolean; message?: string } {
  if (targetRoot === worktreePath) return { ok: true };
  const status = repositoryGitStatus({ repoId: 'cleanup', activeCheckoutId: 'cleanup', canonicalRoot: worktreePath, localRoot: worktreePath, checkouts: [], schemaVersion: 1, displayName: basename(worktreePath), repositoryType: 'git', enabled: true, createdAt: '', updatedAt: '', lastSeenAt: '', configurationPath: '', stateStorageStrategy: 'controller-home' });
  if (!status.clean) return { ok: false, message: 'managed worktree is dirty; cleanup preserved it' };
  const process = spawnSync('git', ['-C', targetRoot, 'worktree', 'remove', worktreePath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  return process.status === 0 ? { ok: true } : { ok: false, message: String(process.stderr ?? 'git worktree remove failed').trim() };
}

function finalizeWork(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Record<string, unknown> {
  const session = requireSession(ctx, args);
  const handle = workForSession(ctx, session, args);
  if (handle.state === 'cleaned') {
    validateWorkHandle(ctx.controllerHome, handle, identityFor(ctx, args), 'none', 'finalize');
    return { idempotent: true, work: compactHandle(handle) };
  }
  return withControllerLock(ctx.controllerHome, { scope: 'worktree', repoId: handle.repositoryId, worktreeId: handle.checkoutId }, `work-finalize:${handle.workId}`, () => {
    let current = readWorkHandle(ctx.controllerHome, handle.repositoryId, handle.workId) ?? handle;
    const identity = identityFor(ctx, args);
    const validated = validateWorkHandle(ctx.controllerHome, current, identity, 'full', 'finalize');
    const approvalRequestId = typeof args.approval_request_id === 'string' ? args.approval_request_id.trim() : '';
    const resolvedAuthorization = approvalRequestId
      ? assertResolvedAuthorization({ controllerHome: ctx.controllerHome, repositoryId: current.repositoryId, approvalRequestId, sessionId: session.sessionId, principalId: session.principalId, workId: current.workId, permissionSnapshotVersion: current.permissionSnapshotVersion, command: 'work_finalize' })
      : undefined;
    const gitAuthorization = resolvedAuthorization
      ? { decision: 'allow', source: 'user_confirmation', reason: 'The user resolved the exact finalization approval request.' } as const
      : decideAuthorization({
        controllerHome: ctx.controllerHome,
        accessMode: readRepositoryAccessPolicy(ctx.controllerHome, current.repositoryId).mode,
        risk: 'local_git',
        repositoryId: current.repositoryId,
        currentRepositoryId: current.repositoryId,
        workId: current.workId,
        boundWorkId: current.workId,
        goalId: current.goalId,
        boundGoalId: current.goalId,
        sessionId: session.sessionId,
        principalId: session.principalId,
        permissionSnapshotVersion: current.permissionSnapshotVersion,
        delegation: session.goalDelegation,
        command: 'work_finalize',
      });
    if (gitAuthorization.decision !== 'allow') return { authorization: gitAuthorization, work: compactHandle(current), stages: current.finalization };
    let stages = { ...current.finalization, validation: 'done' as const };
    current = writeWorkHandle(ctx.controllerHome, { ...current, finalization: stages });
    const wantsCommit = args.commit === true;
    const wantsMerge = args.merge === true;
    const wantsCleanup = args.cleanup === true;
    if (wantsCommit && stages.commit === 'pending') {
      const contract = contractFor(ctx, current);
      if (contract?.constraints.allowCommit === false) throw new Error('WORK_COMMIT_NOT_ALLOWED: WorkContract disallows commit');
      const committed = repositoryGitCommit(ctx.controllerHome, validated.worktreeRepository, { message: String(args.message ?? `Complete ${current.workId}`), allowEmpty: false, authorizationDecision: gitAuthorization, sessionId: session.sessionId, principalId: session.principalId, workId: current.workId, goalId: current.goalId });
      const pendingAuthorization = [committed.stage, committed.commit].find((execution) => execution?.authorizationDecision?.decision === 'user_confirmation_required')?.authorizationDecision;
      if (pendingAuthorization) return { authorization: pendingAuthorization, work: compactHandle(current), stages: current.finalization };
      if (!committed.committed) {
        const reason = committed.error?.message ?? 'commit failed';
        stages = { ...stages, commit: 'failed', lastError: reason };
        current = markWorkHandleFailed(ctx.controllerHome, { ...current, finalization: stages }, reason);
        return { work: compactHandle(current), stages, completed: false };
      }
      stages = { ...stages, commit: 'done' };
      current = transitionWorkHandle(ctx.controllerHome, current, 'committed', { expectedHead: gitHead(validated.worktreeRepository.canonicalRoot), finalization: stages });
    } else if (!wantsCommit && stages.commit === 'pending') {
      stages = { ...stages, commit: 'skipped' };
      current = writeWorkHandle(ctx.controllerHome, { ...current, finalization: stages });
    }
    if (wantsMerge && stages.merge === 'pending') {
      const contract = contractFor(ctx, current);
      if (contract?.constraints.allowMerge === false) throw new Error('WORK_MERGE_NOT_ALLOWED: WorkContract disallows merge');
      const target = selectRepositoryCheckout(getRepository(current.repositoryId, ctx.controllerHome), current.sourceCheckoutId ?? current.checkoutId);
      const deleteAfterWorktreeCleanup = current.managedWorktree && args.delete_branch !== false;
      const merged = repositoryGitFinishWorkflow(ctx.controllerHome, target, { featureBranch: current.branch, targetBranch: typeof args.target_branch === 'string' ? args.target_branch : undefined, deleteBranch: !deleteAfterWorktreeCleanup && args.delete_branch !== false, noFf: args.no_ff === true, authorizationDecision: gitAuthorization, sessionId: session.sessionId, principalId: session.principalId, workId: current.workId, goalId: current.goalId });
      const pendingAuthorization = merged.steps.find((step) => step.execution.authorizationDecision?.decision === 'user_confirmation_required')?.execution.authorizationDecision;
      if (pendingAuthorization) return { authorization: pendingAuthorization, work: compactHandle(current), stages: current.finalization };
      if (!merged.completed) {
        const reason = merged.error?.message ?? 'merge failed';
        stages = { ...stages, merge: 'failed', lastError: reason };
        current = markWorkHandleFailed(ctx.controllerHome, { ...current, finalization: stages }, reason);
        return { work: compactHandle(current), stages, completed: false, merge: merged };
      }
      stages = { ...stages, merge: 'done', branchCleanup: args.delete_branch === false ? 'skipped' : deleteAfterWorktreeCleanup ? 'pending' : 'done' };
      current = transitionWorkHandle(ctx.controllerHome, current, 'merged', { finalization: stages });
    } else if (!wantsMerge && stages.merge === 'pending') {
      stages = { ...stages, merge: 'skipped', branchCleanup: 'skipped' };
      current = writeWorkHandle(ctx.controllerHome, { ...current, finalization: stages });
    }
    if (wantsCleanup && stages.worktreeCleanup === 'pending') {
      const contract = contractFor(ctx, current);
      if (contract?.constraints.allowCleanup === false) throw new Error('WORK_CLEANUP_NOT_ALLOWED: WorkContract disallows cleanup');
      if (!current.managedWorktree) {
        stages = { ...stages, worktreeCleanup: 'skipped' };
      } else {
        const target = selectRepositoryCheckout(getRepository(current.repositoryId, ctx.controllerHome), current.sourceCheckoutId ?? current.checkoutId);
        const cleanup = runCleanup(target.canonicalRoot, current.worktreePath);
        stages = { ...stages, worktreeCleanup: cleanup.ok ? 'done' : 'failed', ...(cleanup.message ? { lastError: cleanup.message } : {}) };
        if (!cleanup.ok) {
          current = markWorkHandleFailed(ctx.controllerHome, { ...current, finalization: stages }, cleanup.message ?? 'worktree cleanup failed');
          return { work: compactHandle(current), stages, completed: false };
        }
      }
      current = writeWorkHandle(ctx.controllerHome, { ...current, finalization: stages });
      if (stages.branchCleanup === 'pending' && stages.merge === 'done') {
        const target = selectRepositoryCheckout(getRepository(current.repositoryId, ctx.controllerHome), current.sourceCheckoutId ?? current.checkoutId);
        const deleted = repositoryGitDeleteBranch(ctx.controllerHome, target, { branch: current.branch, force: false, authorizationDecision: gitAuthorization, sessionId: session.sessionId, principalId: session.principalId, workId: current.workId, goalId: current.goalId });
        if (deleted.execution.authorizationDecision?.decision === 'user_confirmation_required') return { authorization: deleted.execution.authorizationDecision, work: compactHandle(current), stages: current.finalization };
        if (deleted.execution.status !== 'executed' || deleted.execution.ok !== true) {
          const reason = deleted.execution.stderr || 'feature branch cleanup failed';
          stages = { ...stages, branchCleanup: 'failed', lastError: reason };
          current = markWorkHandleFailed(ctx.controllerHome, { ...current, finalization: stages }, reason);
          return { work: compactHandle(current), stages, completed: false };
        }
        stages = { ...stages, branchCleanup: 'done' };
        current = writeWorkHandle(ctx.controllerHome, { ...current, finalization: stages });
      }
    } else if (!wantsCleanup && stages.worktreeCleanup === 'pending') {
      stages = { ...stages, worktreeCleanup: 'skipped' };
      current = writeWorkHandle(ctx.controllerHome, { ...current, finalization: stages });
    }
    const complete = stages.validation === 'done' && stages.commit !== 'pending' && stages.merge !== 'pending' && stages.branchCleanup !== 'pending' && stages.worktreeCleanup !== 'pending' && !stages.lastError;
    if (complete) {
      const finalState = stages.worktreeCleanup === 'done' ? 'cleaned' : stages.merge === 'done' ? 'merged' : stages.commit === 'done' ? 'committed' : current.state === 'prepared' ? 'prepared' : 'editing';
      current = transitionWorkHandle(ctx.controllerHome, current, finalState, { finalization: stages });
      updateWorkContract({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, current.workContractId ?? current.workId, { status: 'succeeded' });
      if (finalState === 'cleaned') updateExecutionSession(ctx.controllerHome, identity, { activeWorkId: undefined, activeCheckoutId: current.sourceCheckoutId ?? session.activeCheckoutId });
    }
    return { work: compactHandle(current), stages, completed: complete, idempotent: !wantsCommit && !wantsMerge && !wantsCleanup && current.finalization.validation === 'done' };
  });
}

export async function callExecutionTool(ctx: MultiRepositoryMcpToolContext, name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
  if (!executionToolNames.has(name)) return undefined;
  try {
    switch (name) {
      case 'session_start': {
        const session = startOrResumeSession(ctx);
        return result({ session: { sessionId: session.sessionId, principalId: session.principalId, activeRepositoryId: session.activeRepositoryId, activeCheckoutId: session.activeCheckoutId, activeWorkId: session.activeWorkId, permissionSnapshotVersion: session.permissionSnapshotVersion, capabilitySnapshotVersion: session.capabilitySnapshotVersion, controllerInstanceId: session.controllerInstanceId, createdAt: session.createdAt, updatedAt: session.updatedAt } });
      }
      case 'session_bind_repository': return result(bindSessionRepository(ctx, args));
      case 'work_prepare': return result(prepareWork(ctx, args));
      case 'work_inspect': return result(inspectWork(ctx, args));
      case 'work_execute': return result(await executeWork(ctx, args));
      case 'work_validate': return result(validateWork(ctx, args));
      case 'work_finalize': return result(finalizeWork(ctx, args));
      case 'approval_resolve': {
        const session = requireSession(ctx, args);
        const repositoryId = typeof args.repo_id === 'string' && args.repo_id.trim() ? args.repo_id.trim() : session.activeRepositoryId;
        if (!repositoryId) throw new Error('SESSION_REPOSITORY_REQUIRED: bind a repository before resolving approval');
        const resolved = resolveAuthorizationRequest({
          controllerHome: ctx.controllerHome,
          repositoryId,
          approvalRequestId: String(args.approval_request_id ?? ''),
          sessionId: session.sessionId,
          principalId: session.principalId,
          workId: typeof args.work_id === 'string' ? args.work_id : session.activeWorkId,
          permissionSnapshotVersion: currentPermissionSnapshotVersion(ctx.controllerHome, repositoryId),
          confirm: args.confirm_authorization === true,
        });
        return result({ authorization: { decision: 'allow', source: 'user_confirmation', reason: 'User confirmation was recorded for the exact pending operation.' }, approval: resolved, continuation: `Retry the original operation with approval_request_id=${resolved.approvalRequestId}.` });
      }
      case 'result_read': {
        const session = requireSession(ctx, args);
        return result(readControllerResult({ controllerHome: ctx.controllerHome, resultRef: String(args.result_ref ?? ''), sessionId: session.sessionId, principalId: session.principalId, workId: typeof args.work_id === 'string' ? args.work_id : undefined, cursor: typeof args.cursor === 'number' ? args.cursor : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined }));
      }
      case 'result_search': {
        const session = requireSession(ctx, args);
        return result(searchControllerResult({ controllerHome: ctx.controllerHome, resultRef: String(args.result_ref ?? ''), sessionId: session.sessionId, principalId: session.principalId, workId: typeof args.work_id === 'string' ? args.work_id : undefined, query: String(args.query ?? ''), limit: typeof args.limit === 'number' ? args.limit : undefined }));
      }
      default: return undefined;
    }
  } catch (error) {
    return failure(error);
  }
}
