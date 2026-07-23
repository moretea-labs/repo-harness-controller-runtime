import { readControllerRestartState, type ControllerRestartState } from '../../../cli/controller/restart-coordinator';
import { withControllerLock } from '../../../cli/repositories/locks';
import { controllerRestartRequestIdForExecutionJob } from '../../execution/jobs/restart-resume';
import { claimExecutionJobForDispatch, findExecutionJob, listActiveExecutionJobs, transitionExecutionJob, updateExecutionJob } from '../../execution/jobs/store';
import type { ExecutionJob, ExecutionJobStatus } from '../../execution/jobs/types';
import { executionTimeoutDecision } from '../../execution/jobs/timeouts';
import { normalizeClaims } from '../../resources/claims/conflicts';
import { acquireExecutionLeases, releaseExecutionLeases } from '../../resources/leases/store';
import { rebuildRepositoryProjection } from '../../projections/materialized-view';

export type ControllerRestartStateReader = (
  controllerHome: string,
  requestId: string,
) => ControllerRestartState | null | undefined;

export interface RepoActorConfig {
  maxConcurrentWorkers: number;
  leaseTtlMs: number;
  controllerPid: number;
  controllerStartedAt?: string;
  restartStateReader: ControllerRestartStateReader;
}

export interface RepoActorDispatch {
  job: ExecutionJob;
  fencingTokens: Array<{ leaseId: string; resourceKey: string; fencingToken: number }>;
}

const PRIORITY_WEIGHT: Record<ExecutionJob['priority'], number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };

const AUTO_ISOLATABLE_OPERATIONS = new Set(['dispatch_task', 'launch_issue', 'dispatch_ready_tasks', 'retry_task_run', 'quick_agent_session', 'submit_local_job']);

function canAutoIsolate(job: ExecutionJob): boolean {
  const args = job.payload.arguments ?? {};
  return AUTO_ISOLATABLE_OPERATIONS.has(job.payload.operation)
    && args.isolate === undefined
    && args.agent !== 'github-copilot'
    && job.resourceClaims.some((claim) => claim.resourceKey.startsWith('workspace:'));
}

function autoIsolatedClaim(job: ExecutionJob): string {
  const args = job.payload.arguments ?? {};
  const identity = String(args.task_id ?? args.issue_id ?? job.jobId).replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `worktree:${identity || job.jobId}`;
}

function waitingStatusForResource(resourceKey: string): ExecutionJobStatus {
  if (resourceKey.startsWith('workspace:') || resourceKey.startsWith('path:') || resourceKey === 'repo-content:*') return 'waiting_for_workspace';
  if (resourceKey.startsWith('heavy-check:')) return 'waiting_for_heavy_check';
  if (resourceKey.startsWith('integration:') || resourceKey.startsWith('git-refs:')) return 'waiting_for_integration';
  if (resourceKey.startsWith('release:')) return 'waiting_for_release_barrier';
  return 'queued';
}

function dependencyState(controllerHome: string, job: ExecutionJob): 'ready' | 'waiting' | 'blocked' {
  for (const dependencyId of job.dependencies) {
    const dependency = findExecutionJob(controllerHome, dependencyId);
    if (!dependency) return 'blocked';
    if (dependency.status === 'succeeded') continue;
    if (['failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(dependency.status)) return 'blocked';
    return 'waiting';
  }
  return 'ready';
}

const PRIORITY_AGING_WINDOW_MS = 30 * 60_000;

function effectivePriority(job: ExecutionJob, now = Date.now()): number {
  const age = Math.max(0, now - Date.parse(job.queuedAt));
  const promotions = Math.floor(age / PRIORITY_AGING_WINDOW_MS);
  return Math.max(0, PRIORITY_WEIGHT[job.priority] - promotions);
}

function candidateSort(left: ExecutionJob, right: ExecutionJob): number {
  const now = Date.now();
  const priority = effectivePriority(left, now) - effectivePriority(right, now);
  if (priority !== 0) return priority;
  return left.queuedAt.localeCompare(right.queuedAt) || left.jobId.localeCompare(right.jobId);
}

function sameControllerProcess(
  lifecycle: ExecutionJob['workerLifecycle'],
  controllerPid: number,
  controllerStartedAt?: string,
): boolean {
  if (!lifecycle || lifecycle.ownerPid !== controllerPid) return false;
  if (!lifecycle.ownerStartedAt || !controllerStartedAt) return true;
  return lifecycle.ownerStartedAt === controllerStartedAt;
}

export function shouldDeferControllerRestartRetry(
  controllerHome: string,
  job: ExecutionJob,
  controllerPid: number,
  controllerStartedAt?: string,
  readState: ControllerRestartStateReader = readControllerRestartState,
): boolean {
  if (job.payload.operation !== 'controller_restart_verify') return false;
  if (!sameControllerProcess(job.workerLifecycle, controllerPid, controllerStartedAt)) return false;

  try {
    const state = readState(controllerHome, controllerRestartRequestIdForExecutionJob(job));
    return Boolean(state && state.phase !== 'succeeded' && state.phase !== 'failed');
  } catch {
    // A partially-written coordinator state must not let the initiating Daemon
    // redispatch the retry into the same shutdown window.
    return true;
  }
}

export class RepoActor {
  readonly repoId: string;
  readonly controllerHome: string;
  readonly config: RepoActorConfig;

  constructor(controllerHome: string, repoId: string, config: Partial<RepoActorConfig> = {}) {
    this.controllerHome = controllerHome;
    this.repoId = repoId;
    this.config = {
      maxConcurrentWorkers: Math.max(1, config.maxConcurrentWorkers ?? 2),
      leaseTtlMs: Math.max(10_000, config.leaseTtlMs ?? 30_000),
      controllerPid: config.controllerPid ?? process.pid,
      controllerStartedAt: config.controllerStartedAt,
      restartStateReader: config.restartStateReader ?? readControllerRestartState,
    };
  }

  tryClaimNext(): RepoActorDispatch | undefined {
    const dispatch = withControllerLock(
      this.controllerHome,
      { scope: 'worktree', repoId: this.repoId, worktreeId: 'repo-actor-mailbox' },
      `repo-actor:${this.repoId}`,
      () => {
        const active = listActiveExecutionJobs(this.controllerHome, this.repoId);
        const running = active.filter((job) => job.status === 'running' || job.status === 'dispatched');
        if (running.length >= this.config.maxConcurrentWorkers) return undefined;

        const candidates = active
          .filter((job) => ['queued', 'waiting_for_dependency', 'waiting_for_workspace', 'waiting_for_heavy_check', 'waiting_for_integration', 'waiting_for_release_barrier'].includes(job.status))
          .sort(candidateSort);

        for (const job of candidates) {
          if (shouldDeferControllerRestartRetry(
            this.controllerHome,
            job,
            this.config.controllerPid,
            this.config.controllerStartedAt,
            this.config.restartStateReader,
          )) return undefined;

          const timeout = executionTimeoutDecision(job);
          if (timeout) {
            transitionExecutionJob(this.controllerHome, job.repoId, job.jobId, 'timed_out', {
              error: {
                code: timeout.code,
                message: timeout.message,
                retryable: false,
                details: { timeoutPhase: timeout.phase, deadlineAt: timeout.deadlineAt },
              },
            });
            continue;
          }
          const dependencies = dependencyState(this.controllerHome, job);
          if (dependencies === 'waiting') {
            if (job.status !== 'waiting_for_dependency') transitionExecutionJob(this.controllerHome, job.repoId, job.jobId, 'waiting_for_dependency');
            continue;
          }
          if (dependencies === 'blocked') {
            transitionExecutionJob(this.controllerHome, job.repoId, job.jobId, 'human_attention_required', {
              error: { code: 'DEPENDENCY_BLOCKED', message: 'A dependency is missing or terminal without success.', retryable: false },
            });
            continue;
          }

          let dispatchJob = job;
          let claims = normalizeClaims(dispatchJob.resourceClaims, { readOnly: dispatchJob.resourceClaims.length === 0 });
          let acquisition = acquireExecutionLeases(this.controllerHome, this.repoId, dispatchJob.jobId, claims, this.config.leaseTtlMs);
          if (!acquisition.acquired && canAutoIsolate(dispatchJob)) {
            const worktreeClaim = autoIsolatedClaim(dispatchJob);
            dispatchJob = updateExecutionJob(this.controllerHome, dispatchJob.repoId, dispatchJob.jobId, (current) => ({
              ...current,
              payload: { ...current.payload, arguments: { ...(current.payload.arguments ?? {}), isolate: true } },
              resourceClaims: [{ resourceKey: worktreeClaim, mode: 'write' }],
            }), 'job_auto_isolated', { previousBlockers: acquisition.blockers, resourceKey: worktreeClaim });
            claims = normalizeClaims(dispatchJob.resourceClaims, { readOnly: false });
            acquisition = acquireExecutionLeases(this.controllerHome, this.repoId, dispatchJob.jobId, claims, this.config.leaseTtlMs);
          }
          if (!acquisition.acquired) {
            const nextStatus = waitingStatusForResource(acquisition.blockers[0]?.resourceKey ?? 'repo-content:*');
            if (dispatchJob.status !== nextStatus) transitionExecutionJob(this.controllerHome, dispatchJob.repoId, dispatchJob.jobId, nextStatus, {}, { blockers: acquisition.blockers });
            continue;
          }

          const dispatchedJob = claimExecutionJobForDispatch(
            this.controllerHome,
            dispatchJob.repoId,
            dispatchJob.jobId,
            acquisition.leases.map((lease) => ({
              leaseId: lease.leaseId,
              resourceKey: lease.resourceKey,
              fencingToken: lease.fencingToken,
              expiresAt: lease.expiresAt,
            })),
            { leaseIds: acquisition.leases.map((lease) => lease.leaseId) },
          );
          if (!dispatchedJob) {
            releaseExecutionLeases(this.controllerHome, dispatchJob.repoId, dispatchJob.jobId, acquisition.leases);
            continue;
          }
          return {
            job: dispatchedJob,
            fencingTokens: dispatchedJob.leaseRefs.map(({ leaseId, resourceKey, fencingToken }) => ({ leaseId, resourceKey, fencingToken })),
          };
        }
        return undefined;
      },
      10_000,
    );
    // Projection materialization performs filesystem scans and must never extend
    // the Repo Actor mailbox critical section. Durable mutations above already
    // leave a dirty marker, so a failed refresh remains recoverable.
    try {
      rebuildRepositoryProjection(this.controllerHome, this.repoId);
    } catch {
      // Startup recovery, scheduler reconciliation, or the next status read can retry.
    }
    return dispatch;
  }
}
