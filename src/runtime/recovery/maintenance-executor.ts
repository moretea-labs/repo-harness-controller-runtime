import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative } from 'path';
import { ensureRepositoryRuntimeStorage, type RepositoryRuntimeStorageReport } from '../../cli/repositories/runtime-storage';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { rebuildRepositoryProjection } from '../projections/materialized-view';
import { classifyFailure, dominantRecoveryClass } from './classifier';
import type { RecoveryClass } from './types';

export type RuntimeMaintenanceActionId =
  | 'local_jobs_reconcile'
  | 'quarantine_unreadable_local_jobs'
  | 'runtime_storage_finalize_relocation'
  | 'rebuild_projection'
  | 'full_maintenance_pass';

export type RuntimeMaintenanceCandidateKind =
  | 'stale_active_local_job'
  | 'pending_approval_local_job'
  | 'unreadable_local_job'
  | 'missing_job_metadata'
  | 'runtime_storage_warning';

export interface RuntimeMaintenanceRepository {
  repoId: string;
  canonicalRoot: string;
}

export interface RuntimeMaintenanceOptions {
  minAgeMinutes?: number;
  maxCandidates?: number;
  cancelPendingApprovals?: boolean;
}

export interface RuntimeMaintenanceApplyOptions extends RuntimeMaintenanceOptions {
  actionId: RuntimeMaintenanceActionId;
  confirmMaintenance?: boolean;
}

export interface RuntimeMaintenanceCandidate {
  kind: RuntimeMaintenanceCandidateKind;
  id: string;
  path?: string;
  status?: string;
  safe: boolean;
  reason: string;
  ageMinutes?: number;
  workerPid?: number;
  deadlineAt?: string;
  suggestedAction: RuntimeMaintenanceActionId;
}

export interface RuntimeMaintenanceSummary {
  totalCandidates: number;
  safeCandidates: number;
  unsafeCandidates: number;
  staleActiveLocalJobs: number;
  pendingApprovalLocalJobs: number;
  unreadableLocalJobs: number;
  missingJobMetadata: number;
  runtimeStorageWarnings: number;
}

export interface RuntimeMaintenanceStatus {
  schemaVersion: 1;
  generatedAt: string;
  repoId: string;
  mode: 'status';
  readyForExecution: boolean;
  runtimeStorage?: RepositoryRuntimeStorageReport;
  runtimeStorageError?: string;
  candidates: RuntimeMaintenanceCandidate[];
  summary: RuntimeMaintenanceSummary;
  recommendedActions: RuntimeMaintenanceActionId[];
  restartEscalation: {
    recommended: boolean;
    reason: string;
    safeCommand: string;
  };
  continuation: {
    retryOriginalOperation: boolean;
    afterSuccess: string[];
  };
  advancedRepair: AdvancedRepairPlan;
  warnings: string[];
}

export interface RuntimeMaintenanceApplyResult extends Omit<RuntimeMaintenanceStatus, 'mode'> {
  mode: 'apply';
  actionId: RuntimeMaintenanceActionId;
  applied: Array<RuntimeMaintenanceCandidate & { applied: boolean; result?: string; error?: string }>;
  projection?: unknown;
}

export interface AdvancedRepairPlan {
  needed: boolean;
  preferredProducer: 'chatgpt_supervised' | 'local_codex_cli' | 'deepseek_backup_controller' | 'human_operator';
  reason: string;
  escalationOrder: string[];
  guardrails: string[];
}

export interface SelfHealingLoopPlanInput {
  objective?: string;
  recentErrors?: string[];
  platformBlocked?: boolean;
  sourceDefectSuspected?: boolean;
  chatgptAvailable?: boolean;
  codexCliAvailable?: boolean;
  deepseekAvailable?: boolean;
}

export interface SelfHealingLoopPlan {
  schemaVersion: 1;
  generatedAt: string;
  objective: string;
  failureClass: RecoveryClass;
  phases: Array<{
    id: string;
    owner: string;
    action: string;
    exitCriteria: string;
    fallback?: string;
  }>;
  modelRepairProducer: AdvancedRepairPlan;
  invariants: string[];
}

interface LocalJobState {
  schemaVersion?: number;
  jobId?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  deadlineAt?: string;
  heartbeatAt?: string;
  workerPid?: number;
  ownerPid?: number;
  error?: string;
  outcome?: unknown;
}

const VALID_MAINTENANCE_ACTIONS = new Set<RuntimeMaintenanceActionId>(['local_jobs_reconcile', 'quarantine_unreadable_local_jobs', 'runtime_storage_finalize_relocation', 'rebuild_projection', 'full_maintenance_pass']);
const ACTIVE_LOCAL_JOB_STATUSES = new Set(['pending_approval', 'approved', 'dispatched', 'running']);
const TERMINAL_LOCAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'orphaned', 'stale', 'rejected']);
const DEFAULT_MIN_AGE_MINUTES = 10;
const MAX_CANDIDATES = 200;

function now(): string { return new Date().toISOString(); }

function clampNumber(value: number | undefined, fallback: number, min = 0, max = 24 * 60): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.trunc(value), max));
}

function localJobsRoot(repoRoot: string): string {
  return join(repoRoot, '.ai', 'harness', 'local-jobs');
}

function activeIndexPath(repoRoot: string): string {
  return join(localJobsRoot(repoRoot), 'active-index.json');
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function ageMinutesFrom(value: string | undefined, fallbackPath?: string): number | undefined {
  const parsed = parseTime(value);
  const timestamp = parsed ?? (fallbackPath && existsSync(fallbackPath) ? lstatSync(fallbackPath).mtimeMs : undefined);
  return timestamp === undefined ? undefined : Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !rel.includes('../');
}

function summarize(candidates: RuntimeMaintenanceCandidate[]): RuntimeMaintenanceSummary {
  return {
    totalCandidates: candidates.length,
    safeCandidates: candidates.filter((candidate) => candidate.safe).length,
    unsafeCandidates: candidates.filter((candidate) => !candidate.safe).length,
    staleActiveLocalJobs: candidates.filter((candidate) => candidate.kind === 'stale_active_local_job').length,
    pendingApprovalLocalJobs: candidates.filter((candidate) => candidate.kind === 'pending_approval_local_job').length,
    unreadableLocalJobs: candidates.filter((candidate) => candidate.kind === 'unreadable_local_job').length,
    missingJobMetadata: candidates.filter((candidate) => candidate.kind === 'missing_job_metadata').length,
    runtimeStorageWarnings: candidates.filter((candidate) => candidate.kind === 'runtime_storage_warning').length,
  };
}

function uniqueActions(candidates: RuntimeMaintenanceCandidate[], storageReady: boolean): RuntimeMaintenanceActionId[] {
  const actions = candidates
    .filter((candidate) => candidate.safe || candidate.kind === 'pending_approval_local_job' || candidate.kind === 'runtime_storage_warning')
    .map((candidate) => candidate.suggestedAction);
  if (!storageReady) actions.push('runtime_storage_finalize_relocation');
  actions.push('full_maintenance_pass');
  return Array.from(new Set(actions));
}

function runtimeStorageCandidates(report: RepositoryRuntimeStorageReport | undefined): RuntimeMaintenanceCandidate[] {
  if (!report) return [];
  return report.warnings.map((warning, index) => {
    const lower = warning.toLowerCase();
    let suggestedAction: RuntimeMaintenanceActionId = 'runtime_storage_finalize_relocation';
    if (lower.includes('local-jobs') || lower.includes('local jobs')) suggestedAction = 'local_jobs_reconcile';
    return {
      kind: 'runtime_storage_warning',
      id: `runtime-storage-${index + 1}`,
      safe: true,
      reason: warning,
      suggestedAction,
    } satisfies RuntimeMaintenanceCandidate;
  });
}

function scanLocalJobCandidates(repoRoot: string, options: Required<RuntimeMaintenanceOptions>): RuntimeMaintenanceCandidate[] {
  const root = localJobsRoot(repoRoot);
  if (!existsSync(root)) return [];
  const candidates: RuntimeMaintenanceCandidate[] = [];
  const entries = readdirSync(root, { withFileTypes: true }).slice(0, options.maxCandidates * 3);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (!isWithin(root, path)) continue;
    const jobPath = join(path, 'job.json');
    if (!existsSync(jobPath)) {
      candidates.push({
        kind: 'missing_job_metadata',
        id: entry.name,
        path,
        safe: true,
        reason: 'Local Job directory has no job.json and cannot be reconciled by the normal Local Bridge index.',
        suggestedAction: 'quarantine_unreadable_local_jobs',
      });
      continue;
    }
    let job: LocalJobState;
    try {
      job = readJson(jobPath) as LocalJobState;
    } catch (error) {
      candidates.push({
        kind: 'unreadable_local_job',
        id: entry.name,
        path,
        safe: true,
        reason: `Local Job metadata is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        suggestedAction: 'quarantine_unreadable_local_jobs',
      });
      continue;
    }
    const status = String(job.status ?? 'unknown');
    if (TERMINAL_LOCAL_JOB_STATUSES.has(status)) continue;
    if (!ACTIVE_LOCAL_JOB_STATUSES.has(status)) continue;
    const ageSource = job.heartbeatAt ?? job.updatedAt ?? job.startedAt ?? job.createdAt;
    const ageMinutes = ageMinutesFrom(ageSource, path) ?? 0;
    const deadlineMs = parseTime(job.deadlineAt);
    const deadlineExpired = deadlineMs !== undefined && deadlineMs < Date.now();
    const workerAlive = isPidAlive(job.workerPid ?? job.ownerPid);
    if (status === 'pending_approval') {
      candidates.push({
        kind: 'pending_approval_local_job',
        id: typeof job.jobId === 'string' ? job.jobId : entry.name,
        path,
        status,
        safe: options.cancelPendingApprovals && ageMinutes >= options.minAgeMinutes,
        reason: options.cancelPendingApprovals
          ? `Pending approval is ${ageMinutes} minute(s) old; authorized maintenance may cancel it to unblock runtime storage.`
          : 'Pending approval may still represent a user decision. Maintenance will not cancel it unless cancel_pending_approvals is explicitly enabled.',
        ageMinutes,
        workerPid: job.workerPid ?? job.ownerPid,
        deadlineAt: job.deadlineAt,
        suggestedAction: 'local_jobs_reconcile',
      });
      continue;
    }
    const safe = (deadlineExpired || !workerAlive) && ageMinutes >= options.minAgeMinutes;
    candidates.push({
      kind: 'stale_active_local_job',
      id: typeof job.jobId === 'string' ? job.jobId : entry.name,
      path,
      status,
      safe,
      reason: safe
        ? `Active Local Job has no live worker or has expired deadline and is ${ageMinutes} minute(s) old.`
        : 'Active Local Job may still be owned by a live worker or is too recent for automatic terminalization.',
      ageMinutes,
      workerPid: job.workerPid ?? job.ownerPid,
      deadlineAt: job.deadlineAt,
      suggestedAction: 'local_jobs_reconcile',
    });
  }
  return candidates.slice(0, options.maxCandidates);
}

function normalizedOptions(options: RuntimeMaintenanceOptions = {}): Required<RuntimeMaintenanceOptions> {
  return {
    minAgeMinutes: clampNumber(options.minAgeMinutes, DEFAULT_MIN_AGE_MINUTES, 0, 7 * 24 * 60),
    maxCandidates: clampNumber(options.maxCandidates, MAX_CANDIDATES, 1, 500),
    cancelPendingApprovals: options.cancelPendingApprovals === true,
  };
}

function coerceRepository(repository: RuntimeMaintenanceRepository): RepositoryRecord {
  return repository as RepositoryRecord;
}

function safeRuntimeStorage(repository: RuntimeMaintenanceRepository, controllerHome: string): { report?: RepositoryRuntimeStorageReport; error?: string } {
  try {
    return { report: ensureRepositoryRuntimeStorage(coerceRepository(repository), controllerHome) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function advancedRepairPlan(input: { recentErrors?: string[]; platformBlocked?: boolean; sourceDefectSuspected?: boolean; chatgptAvailable?: boolean; codexCliAvailable?: boolean; deepseekAvailable?: boolean } = {}): AdvancedRepairPlan {
  const classes = (input.recentErrors ?? []).map(classifyFailure);
  const failureClass = dominantRecoveryClass(classes);
  const sourceDefect = input.sourceDefectSuspected === true || failureClass === 'source_defect_suspected';
  if (!sourceDefect && failureClass !== 'unknown' && failureClass !== 'platform_blocked') {
    return {
      needed: false,
      preferredProducer: 'chatgpt_supervised',
      reason: 'Evidence points to bounded runtime maintenance, configuration, or authorization rather than a source repair.',
      escalationOrder: ['runtime_maintenance_apply', 'capability_recovery_probe'],
      guardrails: ['Do not spawn a model repair agent for state-only failures.', 'Prefer local metadata repair before source modification.'],
    };
  }
  const chatgptAvailable = input.chatgptAvailable !== false && input.platformBlocked !== true;
  const codexAvailable = input.codexCliAvailable === true;
  const deepseekAvailable = input.deepseekAvailable === true;
  const preferredProducer = chatgptAvailable
    ? 'chatgpt_supervised'
    : codexAvailable
      ? 'local_codex_cli'
      : deepseekAvailable
        ? 'deepseek_backup_controller'
        : 'human_operator';
  return {
    needed: sourceDefect || input.platformBlocked === true,
    preferredProducer,
    reason: sourceDefect
      ? 'Source defect is suspected; generate a patch in an isolated worktree after local maintenance is exhausted.'
      : 'Primary controller may be blocked; prepare a bounded handoff rather than bypassing repo-harness policy.',
    escalationOrder: ['chatgpt_supervised', 'local_codex_cli', 'deepseek_backup_controller', 'human_operator'],
    guardrails: [
      'Model repair agents produce plans or patches only; repo-harness remains the policy, approval, lease, and audit authority.',
      'Use isolated worktrees for source repair and keep runtime metadata maintenance separate from code changes.',
      'Require checks and human approval before merging or pushing model-produced source changes.',
    ],
  };
}

export function buildRuntimeMaintenanceStatus(
  repository: RuntimeMaintenanceRepository,
  controllerHome: string,
  options: RuntimeMaintenanceOptions & { recentErrors?: string[] } = {},
): RuntimeMaintenanceStatus {
  const normalized = normalizedOptions(options);
  const storage = safeRuntimeStorage(repository, controllerHome);
  const localJobCandidates = scanLocalJobCandidates(repository.canonicalRoot, normalized);
  const storageCandidates = runtimeStorageCandidates(storage.report);
  const candidates = [...localJobCandidates, ...storageCandidates].slice(0, normalized.maxCandidates);
  const summary = summarize(candidates);
  const readyForExecution = storage.report?.readyForExecution === true && summary.safeCandidates === 0 && summary.unsafeCandidates === 0;
  return {
    schemaVersion: 1,
    generatedAt: now(),
    repoId: repository.repoId,
    mode: 'status',
    readyForExecution,
    runtimeStorage: storage.report,
    runtimeStorageError: storage.error,
    candidates,
    summary,
    recommendedActions: uniqueActions(candidates, storage.report?.readyForExecution === true),
    restartEscalation: {
      recommended: storage.error !== undefined || (storage.report?.readyForExecution === false && candidates.length === 0),
      reason: storage.error
        ? 'Runtime storage inspection failed; restart can refresh daemon state after local metadata repair has been attempted.'
        : storage.report?.readyForExecution === false && candidates.length === 0
          ? 'Storage remains blocked but no safe metadata candidate was found; restart or manual review is the next bounded fallback.'
          : 'Restart is not the first-line action; use runtime maintenance first.',
      safeCommand: 'npm run controller:restart',
    },
    continuation: {
      retryOriginalOperation: true,
      afterSuccess: [
        'run capability_recovery_probe',
        'retry the originally blocked operation with the same request intent',
        'only escalate to restart or model repair if runtime maintenance cannot produce a ready projection',
      ],
    },
    advancedRepair: advancedRepairPlan({ recentErrors: options.recentErrors }),
    warnings: [
      'Runtime maintenance only edits repo-harness metadata under .ai/harness and controller-home for the selected repository.',
      'Pending approvals are not cancelled unless cancel_pending_approvals is explicitly enabled.',
      'Source repair should be delegated to ChatGPT/Codex/DeepSeek only after local maintenance and restart fallbacks fail.',
    ],
  };
}

function quarantinePath(repoRoot: string, id: string): string {
  const stamp = now().replace(/[:.]/g, '-');
  return join(repoRoot, '.ai', 'harness', 'local-jobs-quarantine', `${stamp}-${safeId(id)}`);
}

function terminalizeLocalJob(candidate: RuntimeMaintenanceCandidate, status: 'orphaned' | 'cancelled' = 'orphaned'): string {
  if (!candidate.path) throw new Error('LOCAL_JOB_PATH_MISSING');
  const jobPath = join(candidate.path, 'job.json');
  const job = readJson(jobPath) as LocalJobState;
  const updated = {
    ...job,
    status,
    updatedAt: now(),
    finishedAt: now(),
    error: job.error ?? `Terminalized by repo-harness runtime maintenance: ${candidate.reason}`,
    outcome: job.outcome ?? { infrastructureError: { code: 'MAINTENANCE_TERMINALIZED', message: candidate.reason } },
  };
  writeJsonAtomic(jobPath, updated);
  return status;
}

function quarantineLocalJob(repoRoot: string, candidate: RuntimeMaintenanceCandidate): string {
  if (!candidate.path) throw new Error('LOCAL_JOB_PATH_MISSING');
  const root = localJobsRoot(repoRoot);
  if (!isWithin(root, candidate.path)) throw new Error('LOCAL_JOB_PATH_OUTSIDE_ROOT');
  const destination = quarantinePath(repoRoot, candidate.id);
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(candidate.path, destination);
  return destination;
}

function rebuildActiveIndex(repoRoot: string): void {
  const root = localJobsRoot(repoRoot);
  if (!existsSync(root)) return;
  const activeIds: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const job = readJson(join(root, entry.name, 'job.json')) as LocalJobState;
      if (job.jobId && job.status && ACTIVE_LOCAL_JOB_STATUSES.has(job.status)) activeIds.push(job.jobId);
    } catch {
      // Unreadable entries are handled by quarantine actions; do not keep them in the active index.
    }
  }
  writeJsonAtomic(activeIndexPath(repoRoot), {
    schemaVersion: 1,
    ownerPid: process.pid,
    updatedAt: now(),
    jobIds: Array.from(new Set(activeIds)).sort((a, b) => b.localeCompare(a)),
  });
}

function shouldApply(actionId: RuntimeMaintenanceActionId, candidate: RuntimeMaintenanceCandidate): boolean {
  if (!candidate.safe) return false;
  if (actionId === 'full_maintenance_pass') return candidate.kind !== 'runtime_storage_warning';
  if (actionId === 'local_jobs_reconcile') return candidate.kind === 'stale_active_local_job' || candidate.kind === 'pending_approval_local_job';
  if (actionId === 'quarantine_unreadable_local_jobs') return candidate.kind === 'unreadable_local_job' || candidate.kind === 'missing_job_metadata';
  return false;
}

export function applyRuntimeMaintenance(
  repository: RuntimeMaintenanceRepository,
  controllerHome: string,
  options: RuntimeMaintenanceApplyOptions,
): RuntimeMaintenanceApplyResult {
  if (options.confirmMaintenance !== true) throw new Error('RUNTIME_MAINTENANCE_CONFIRMATION_REQUIRED: confirmMaintenance=true is required.');
  if (!VALID_MAINTENANCE_ACTIONS.has(options.actionId)) throw new Error(`RUNTIME_MAINTENANCE_ACTION_UNKNOWN: ${options.actionId}`);
  const before = buildRuntimeMaintenanceStatus(repository, controllerHome, options);
  const applied = before.candidates.map((candidate) => {
    if (!shouldApply(options.actionId, candidate)) return { ...candidate, applied: false, result: 'not_selected' };
    try {
      if (candidate.kind === 'stale_active_local_job') {
        return { ...candidate, applied: true, result: terminalizeLocalJob(candidate, 'orphaned') };
      }
      if (candidate.kind === 'pending_approval_local_job') {
        return { ...candidate, applied: true, result: terminalizeLocalJob(candidate, 'cancelled') };
      }
      if (candidate.kind === 'unreadable_local_job' || candidate.kind === 'missing_job_metadata') {
        return { ...candidate, applied: true, result: quarantineLocalJob(repository.canonicalRoot, candidate) };
      }
      return { ...candidate, applied: false, result: 'unsupported_candidate' };
    } catch (error) {
      return { ...candidate, applied: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  if (options.actionId === 'runtime_storage_finalize_relocation' || options.actionId === 'full_maintenance_pass' || applied.some((candidate) => candidate.applied)) {
    rebuildActiveIndex(repository.canonicalRoot);
  }
  const storage = safeRuntimeStorage(repository, controllerHome);
  let projection: unknown;
  try { projection = rebuildRepositoryProjection(controllerHome, repository.repoId); } catch (error) { projection = { error: error instanceof Error ? error.message : String(error) }; }
  const after = buildRuntimeMaintenanceStatus(repository, controllerHome, options);
  return {
    ...after,
    mode: 'apply',
    actionId: options.actionId,
    runtimeStorage: after.runtimeStorage ?? storage.report,
    runtimeStorageError: after.runtimeStorageError ?? storage.error,
    applied,
    projection,
  };
}

export function buildSelfHealingLoopPlan(input: SelfHealingLoopPlanInput = {}): SelfHealingLoopPlan {
  const generatedAt = now();
  const objective = input.objective?.trim() || 'Restore repo-harness execution and continue the blocked user task safely.';
  const classes = (input.recentErrors ?? []).map(classifyFailure);
  const failureClass = input.platformBlocked === true
    ? 'platform_blocked'
    : input.sourceDefectSuspected === true
      ? 'source_defect_suspected'
      : dominantRecoveryClass(classes);
  const producer = advancedRepairPlan({
    recentErrors: input.recentErrors,
    platformBlocked: input.platformBlocked,
    sourceDefectSuspected: input.sourceDefectSuspected,
    chatgptAvailable: input.chatgptAvailable,
    codexCliAvailable: input.codexCliAvailable,
    deepseekAvailable: input.deepseekAvailable,
  });
  return {
    schemaVersion: 1,
    generatedAt,
    objective,
    failureClass,
    phases: [
      {
        id: 'observe',
        owner: 'repo-harness supervisor',
        action: 'Collect capability, runtime storage, local-job, scheduler, bridge, plugin, and recent-error evidence using read-only probes.',
        exitCriteria: 'Failure class and first safe recovery action are deterministic.',
      },
      {
        id: 'local-maintenance',
        owner: 'maintenance executor',
        action: 'Apply bounded runtime metadata repair without repository_command_execute or Local Job tickets.',
        exitCriteria: 'Runtime storage is ready and projection is fresh, or no safe local candidate remains.',
        fallback: 'Restart controller/local bridge once if runtime metadata repair cannot refresh readiness.',
      },
      {
        id: 'restart-fallback',
        owner: 'local supervisor or user',
        action: 'Restart only repo-harness controller services after local maintenance is exhausted.',
        exitCriteria: 'Daemon, bridge, scheduler, and projection become ready.',
        fallback: 'Escalate to model-assisted source repair if the same failure repeats after restart.',
      },
      {
        id: 'model-repair-generation',
        owner: producer.preferredProducer,
        action: 'Generate a bounded source repair plan or patch in an isolated worktree when evidence points to a source defect.',
        exitCriteria: 'Patch passes configured checks and is reviewed by a human or supervising controller.',
        fallback: 'Use the next producer in the escalation order without bypassing repo-harness policy.',
      },
      {
        id: 'continuation',
        owner: 'repo-harness scheduler',
        action: 'Retry the original blocked operation from its durable intent or ask for confirmation when the operation has external effects.',
        exitCriteria: 'Original task completes, is safely paused, or is escalated with evidence.',
      },
    ],
    modelRepairProducer: producer,
    invariants: [
      'State-only recovery must not modify source files.',
      'Model-generated source repair must not directly mutate runtime metadata.',
      'All destructive or external effects remain behind repo-harness approval and audit.',
      'Every recovery pass must be idempotent and bounded to one registered repository.',
    ],
  };
}
