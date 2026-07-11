import {
  isAccessMode,
  normalizeAccessMode,
  readRepositoryAccessPolicy,
  withAccessMode,
  type AccessMode,
} from '../governance/access-policy';
import {
  routeWorkStart as routeWorkStartBase,
  runGoalWorkloop as runGoalWorkloopBase,
  type GoalWorkloopContext,
  type GoalWorkloopOperation,
  type GoalWorkloopStartInput,
} from './goal-workloop';
import type { CapabilityRisk, FacadeResult, WorkContractConstraints } from './types';

export {
  continueGoalWorkloop,
  finalizeGoalWorkloop,
  startGoalWorkloop,
  stopGoalWorkloop,
  verifyGoalWorkloop,
  type GoalWorkloopContext,
  type GoalWorkloopContinueInput,
  type GoalWorkloopFinalizeInput,
  type GoalWorkloopOperation,
  type GoalWorkloopStartInput,
  type GoalWorkloopStopInput,
  type GoalWorkloopVerifyInput,
} from './goal-workloop';

function booleanValue(record: Record<string, unknown>, camel: string, snake: string): boolean | undefined {
  const value = record[camel] ?? record[snake];
  return typeof value === 'boolean' ? value : undefined;
}

function numberValue(record: Record<string, unknown>, camel: string, snake: string): number | undefined {
  const value = record[camel] ?? record[snake];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function accessModeValue(value: unknown): AccessMode | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const candidate = record.accessMode ?? record.access_mode;
  return isAccessMode(candidate) ? candidate : undefined;
}

function constraintsValue(value: unknown): WorkContractConstraints | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const constraints: WorkContractConstraints = {
    maxChangedFiles: numberValue(record, 'maxChangedFiles', 'max_changed_files'),
    maxChangedLines: numberValue(record, 'maxChangedLines', 'max_changed_lines'),
    allowCommit: booleanValue(record, 'allowCommit', 'allow_commit'),
    allowMerge: booleanValue(record, 'allowMerge', 'allow_merge'),
    allowCleanup: booleanValue(record, 'allowCleanup', 'allow_cleanup'),
    allowDestructive: booleanValue(record, 'allowDestructive', 'allow_destructive'),
    requireHandoffOnAmbiguity: booleanValue(record, 'requireHandoffOnAmbiguity', 'require_handoff_on_ambiguity'),
    accessMode: accessModeValue(record),
  };
  return Object.fromEntries(
    Object.entries(constraints).filter(([, entry]) => entry !== undefined),
  ) as WorkContractConstraints;
}

function repositoryDefaultMode(ctx: GoalWorkloopContext): AccessMode {
  const controllerHome = ctx.workStore.controllerHome;
  if (!controllerHome) return 'request';
  return readRepositoryAccessPolicy(controllerHome, ctx.repoId).mode;
}

function resolveMode(ctx: GoalWorkloopContext, constraints?: WorkContractConstraints): AccessMode {
  return normalizeAccessMode(constraints?.accessMode, repositoryDefaultMode(ctx));
}

function normalizeStartInput(ctx: GoalWorkloopContext, input: GoalWorkloopStartInput): GoalWorkloopStartInput {
  const accessMode = resolveMode(ctx, input.constraints);
  return {
    ...input,
    constraints: {
      requireHandoffOnAmbiguity: true,
      ...input.constraints,
      accessMode,
    },
  };
}

export function routeWorkStart(ctx: GoalWorkloopContext, input: GoalWorkloopStartInput): FacadeResult {
  const normalized = normalizeStartInput(ctx, input);
  return withAccessMode(normalized.constraints?.accessMode ?? 'request', () => routeWorkStartBase(ctx, normalized));
}

export function runGoalWorkloop(
  ctx: GoalWorkloopContext,
  operation: GoalWorkloopOperation,
  args: Record<string, unknown>,
): FacadeResult {
  if (operation !== 'start') {
    return withAccessMode(repositoryDefaultMode(ctx), () => runGoalWorkloopBase(ctx, operation, args));
  }

  const constraints = constraintsValue(args.constraints);
  return routeWorkStart(ctx, {
    objective: String(args.objective ?? ''),
    acceptanceCriteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String) : undefined,
    allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
    forbiddenPaths: Array.isArray(args.forbidden_paths) ? args.forbidden_paths.map(String) : undefined,
    checks: Array.isArray(args.check_ids) ? args.check_ids.map(String) : undefined,
    constraints,
    modeInput: {
      objective: typeof args.objective === 'string' ? args.objective : undefined,
      expectedFiles: typeof args.expected_files === 'number' ? args.expected_files : undefined,
      expectedChangedLines: typeof args.expected_changed_lines === 'number' ? args.expected_changed_lines : undefined,
      scopeClear: args.scope_clear === undefined ? true : args.scope_clear === true,
      requiresInvestigation: args.requires_investigation === true,
      requiresLongRunningChecks: args.requires_long_running_checks === true,
      requiresParallelism: args.requires_parallelism === true,
      needsDependencies: args.needs_dependencies === true,
      requiresRecovery: args.requires_recovery === true,
      requiresWorker: args.requires_worker === true,
      requiresExternalEffect: args.requires_external_effect === true,
      requiresApproval: args.requires_approval === true,
      requiresUserApproval: args.requires_user_approval === true,
      destructive: args.destructive === true,
      remoteWrite: args.remote_write === true,
      secretAccess: args.secret_access === true,
      risk: typeof args.risk === 'string' ? args.risk as CapabilityRisk : undefined,
    },
    requestedBy: args.requested_by === 'user' || args.requested_by === 'system' || args.requested_by === 'scheduler'
      ? args.requested_by
      : 'chatgpt',
    taskId: typeof args.task_id === 'string' ? args.task_id : undefined,
    issueId: typeof args.issue_id === 'string' ? args.issue_id : undefined,
    approvalConfirmed: args.approval_confirmed === true,
    dryRun: args.dry_run === true,
    forceMode: args.force_mode === 'direct_control' || args.force_mode === 'goal_workloop' || args.force_mode === 'handoff_only'
      ? args.force_mode
      : undefined,
  });
}
