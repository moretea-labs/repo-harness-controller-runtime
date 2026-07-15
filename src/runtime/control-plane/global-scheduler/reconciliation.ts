import { listActiveExecutionJobs, transitionExecutionJob } from '../../execution/jobs/store';
import type { ExecutionJob } from '../../execution/jobs/types';
import {
  childReferenceFromJob,
  childReferenceFromReceipt,
  hasDurableChildReference,
  isAgentDelegationOperation,
  mergeChildReferences,
  buildDelegatedExecutionResult,
} from '../../execution/jobs/child-reference';
import { readOperationReceipt } from '../../execution/jobs/receipt-store';
import { releaseExecutionLeases, renewExecutionLeases } from '../../resources/leases/store';
import { isProcessAlive, terminateProcessTree, terminateProcessTreeSync, type ProcessTreeTerminationResult } from '../../shared/process-tree';
import { settleScheduledExecution } from '../../workflow/schedules/settlement';

const WORKER_HEARTBEAT_STALE_MS = 45_000;

function hasPotentialSideEffects(job: ExecutionJob): boolean {
  return job.resourceClaims.some((claim) => claim.mode !== 'read');
}

function canAutomaticallyReplay(job: ExecutionJob): boolean {
  if (job.operationMetadata) {
    return job.operationMetadata.replayable && job.operationMetadata.retryPolicy !== 'none';
  }
  // Legacy Jobs predate explicit operation metadata. Preserve the old safe
  // fallback: read-only claims may replay, writes fail closed.
  return !hasPotentialSideEffects(job);
}

function recoverCompletedReceipt(controllerHome: string, job: ExecutionJob): ExecutionJob | undefined {
  const receipt = readOperationReceipt(controllerHome, job.repoId, job.jobId);
  if (!receipt || receipt.attempt !== job.attempt) return undefined;

  // Parent Agent-delegation Jobs that already persisted a child reference are
  // recovered as succeeded (delegation accepted), never as ambiguous.
  const childReference = mergeChildReferences(
    childReferenceFromReceipt(receipt),
    childReferenceFromJob(job),
  );
  if (
    (receipt.state === 'delegated' || hasDurableChildReference(childReference))
    && (isAgentDelegationOperation(job.payload.operation) || job.type === 'agent-run' || job.type === 'dispatch-task')
  ) {
    if (!hasDurableChildReference(childReference) || !childReference) return undefined;
    releaseExecutionLeases(controllerHome, job.repoId, job.jobId, job.leaseRefs);
    const result = receipt.result
      ?? buildDelegatedExecutionResult({ childReference });
    const recovered = transitionExecutionJob(controllerHome, job.repoId, job.jobId, 'succeeded', {
      result,
      error: undefined,
      evidenceIds: receipt.evidenceIds ?? job.evidenceIds,
      workerPid: undefined,
      leaseRefs: [],
    }, { recoveredFromReceipt: true, receiptAttempt: receipt.attempt, recoveredAs: 'delegated' });
    settleScheduledExecution(
      controllerHome,
      recovered,
      'succeeded',
      'Scheduled agent-delegation operation recovered from a durable child reference.',
    );
    return recovered;
  }

  if (receipt.state !== 'completed' || !receipt.outcome || receipt.outcome === 'delegated') return undefined;
  releaseExecutionLeases(controllerHome, job.repoId, job.jobId, job.leaseRefs);
  const recovered = transitionExecutionJob(controllerHome, job.repoId, job.jobId, receipt.outcome, {
    result: receipt.result,
    error: receipt.error,
    evidenceIds: receipt.evidenceIds ?? job.evidenceIds,
    workerPid: undefined,
    leaseRefs: [],
  }, { recoveredFromReceipt: true, receiptAttempt: receipt.attempt });
  settleScheduledExecution(
    controllerHome,
    recovered,
    receipt.outcome,
    receipt.outcome === 'succeeded' ? 'Scheduled operation recovered from a completed Worker receipt.' : 'Scheduled operation failed before Job terminal state was persisted.',
  );
  return recovered;
}

function isAgentDelegationJob(job: ExecutionJob): boolean {
  return isAgentDelegationOperation(job.payload.operation)
    || job.type === 'agent-run'
    || job.type === 'dispatch-task'
    || job.payload.arguments?.agentDelegation === true
    || (job.payload.operation === 'legacy-local-job'
      && typeof job.payload.arguments?.localAction === 'string'
      && ['launch-task', 'quick-agent-session'].includes(String(job.payload.arguments.localAction)));
}

function ambiguousStartedOperation(controllerHome: string, job: ExecutionJob): boolean {
  const receipt = readOperationReceipt(controllerHome, job.repoId, job.jobId);
  if (!receipt || receipt.attempt !== job.attempt) return false;
  // Delegated or completed receipts are never ambiguous.
  if (receipt.state === 'delegated' || receipt.state === 'completed') return false;
  if (hasDurableChildReference(childReferenceFromReceipt(receipt)) || hasDurableChildReference(childReferenceFromJob(job))) {
    return false;
  }
  // Agent-delegation parents are requestId-idempotent. A started receipt without a
  // durable child pointer means the Worker died before accept; safe retry is allowed.
  if (isAgentDelegationJob(job)) return false;
  return receipt.state === 'started';
}

type ReconcileSummary = { inspected: number; requeued: number; terminal: number; recovered: number };

function heartbeatAgeMs(heartbeatAt: string | undefined): number {
  if (!heartbeatAt) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(heartbeatAt);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return Date.now() - parsed;
}

function workerLossContext(job: ExecutionJob): {
  workerLost: boolean;
  heartbeatAgeMs: number;
  reason: 'missing_worker' | 'stale_heartbeat' | 'process_missing';
} {
  const ageMs = heartbeatAgeMs(job.heartbeatAt);
  if (job.workerPid === undefined) {
    return { workerLost: true, heartbeatAgeMs: ageMs, reason: 'missing_worker' };
  }
  if (!isProcessAlive(job.workerPid)) {
    return { workerLost: true, heartbeatAgeMs: ageMs, reason: 'process_missing' };
  }
  if (ageMs >= WORKER_HEARTBEAT_STALE_MS) {
    // Some bounded tool implementations (notably xcodebuild via spawnSync)
    // legitimately block the Worker's JavaScript timer while the OS process is
    // still alive. A stale heartbeat is therefore degraded observability, not
    // proof of worker loss. The durable Job deadline remains the hard bound.
    return { workerLost: false, heartbeatAgeMs: ageMs, reason: 'stale_heartbeat' };
  }
  return { workerLost: false, heartbeatAgeMs: ageMs, reason: 'process_missing' };
}

type WorkerLossReason = 'missing_worker' | 'stale_heartbeat' | 'process_missing' | 'lease_lost';

function workerLostMessage(
  reason: WorkerLossReason,
  heartbeatAge: number,
  terminal: boolean,
): string {
  const staleHeartbeat = Number.isFinite(heartbeatAge)
    ? `Worker heartbeat became stale after ${Math.max(0, Math.trunc(heartbeatAge))}ms.`
    : 'Worker heartbeat was missing.';
  const processMissing = reason === 'missing_worker'
    ? 'Worker PID was missing.'
    : reason === 'lease_lost'
      ? 'Worker no longer owned the expected fenced lease set.'
      : 'Worker process was no longer alive.';
  if (reason === 'stale_heartbeat') {
    return terminal
      ? `${staleHeartbeat} The job reached its final retry and was marked failed.`
      : `${staleHeartbeat} The job was safely requeued before its outcome became ambiguous.`;
  }
  return terminal
    ? `${processMissing} The job reached its final retry and was marked failed.`
    : `${processMissing} The job was safely requeued before its outcome became ambiguous.`;
}

export function reconcileExecutionJobs(controllerHome: string, repoId?: string): ReconcileSummary {
  return reconcileExecutionJobsWith(controllerHome, (pid) => terminateProcessTreeSync(pid), repoId);
}

export async function reconcileExecutionJobsAsync(controllerHome: string, repoId?: string): Promise<ReconcileSummary> {
  return reconcileExecutionJobsAsyncWith(controllerHome, (pid) => terminateProcessTree(pid), repoId);
}

function reconcileExecutionJobsWith(
  controllerHome: string,
  terminateWorker: (pid: number | undefined) => ProcessTreeTerminationResult,
  repoId?: string,
): ReconcileSummary {
  const jobs = listActiveExecutionJobs(controllerHome, repoId);
  let requeued = 0;
  let terminal = 0;
  let recovered = 0;
  for (const job of jobs) {
    if (job.status !== 'running') {
      if (job.deadlineAt && Date.parse(job.deadlineAt) <= Date.now()) {
        releaseExecutionLeases(controllerHome, job.repoId, job.jobId, job.leaseRefs);
        const terminalJob = transitionExecutionJob(controllerHome, job.repoId, job.jobId, 'timed_out', {
          error: { code: 'DEADLINE_EXCEEDED', message: 'Execution deadline elapsed before dispatch.', retryable: false },
          leaseRefs: [],
        });
        settleScheduledExecution(controllerHome, terminalJob, 'failed', 'Scheduled operation exceeded its execution deadline before dispatch.');
        terminal += 1;
      }
      continue;
    }

    const deadlineElapsed = Boolean(job.deadlineAt && Date.parse(job.deadlineAt) <= Date.now());
    const loss = workerLossContext(job);
    let lossReason: WorkerLossReason = loss.reason;
    if (!deadlineElapsed && !loss.workerLost) {
      try {
        if (job.leaseRefs.length > 0) {
          renewExecutionLeases(controllerHome, job.repoId, job.jobId, 30_000, job.leaseRefs);
        }
        continue;
      } catch {
        lossReason = 'lease_lost';
      }
    }

    const termination = terminateWorker(job.workerPid);
    const outcome = finalizeRunningJob(controllerHome, job, deadlineElapsed, termination, lossReason, loss.heartbeatAgeMs);
    requeued += outcome.requeued;
    terminal += outcome.terminal;
    recovered += outcome.recovered;
  }
  return { inspected: jobs.length, requeued, terminal, recovered };
}

async function reconcileExecutionJobsAsyncWith(
  controllerHome: string,
  terminateWorker: (pid: number | undefined) => Promise<ProcessTreeTerminationResult>,
  repoId?: string,
): Promise<ReconcileSummary> {
  const jobs = listActiveExecutionJobs(controllerHome, repoId);
  let requeued = 0;
  let terminal = 0;
  let recovered = 0;
  for (const job of jobs) {
    if (job.status !== 'running') {
      if (job.deadlineAt && Date.parse(job.deadlineAt) <= Date.now()) {
        releaseExecutionLeases(controllerHome, job.repoId, job.jobId, job.leaseRefs);
        const terminalJob = transitionExecutionJob(controllerHome, job.repoId, job.jobId, 'timed_out', {
          error: { code: 'DEADLINE_EXCEEDED', message: 'Execution deadline elapsed before dispatch.', retryable: false },
          leaseRefs: [],
        });
        settleScheduledExecution(controllerHome, terminalJob, 'failed', 'Scheduled operation exceeded its execution deadline before dispatch.');
        terminal += 1;
      }
      continue;
    }

    const deadlineElapsed = Boolean(job.deadlineAt && Date.parse(job.deadlineAt) <= Date.now());
    const loss = workerLossContext(job);
    let lossReason: WorkerLossReason = loss.reason;
    if (!deadlineElapsed && !loss.workerLost) {
      try {
        if (job.leaseRefs.length > 0) {
          renewExecutionLeases(controllerHome, job.repoId, job.jobId, 30_000, job.leaseRefs);
        }
        continue;
      } catch {
        lossReason = 'lease_lost';
      }
    }

    const termination = await terminateWorker(job.workerPid);
    const outcome = finalizeRunningJob(controllerHome, job, deadlineElapsed, termination, lossReason, loss.heartbeatAgeMs);
    requeued += outcome.requeued;
    terminal += outcome.terminal;
    recovered += outcome.recovered;
  }
  return { inspected: jobs.length, requeued, terminal, recovered };
}

function finalizeRunningJob(
  controllerHome: string,
  job: ExecutionJob,
  deadlineElapsed: boolean,
  termination: ProcessTreeTerminationResult,
  workerLostReason: WorkerLossReason,
  heartbeatAge: number,
): { requeued: number; terminal: number; recovered: number } {
  const receiptRecovery = recoverCompletedReceipt(controllerHome, job);
  if (receiptRecovery) {
    return { requeued: 0, terminal: 1, recovered: 1 };
  }

  releaseExecutionLeases(controllerHome, job.repoId, job.jobId, job.leaseRefs);
  // Prefer durable child recovery even when the Worker exited uncleanly.
  const liveChild = mergeChildReferences(
    childReferenceFromReceipt(readOperationReceipt(controllerHome, job.repoId, job.jobId)),
    childReferenceFromJob(job),
  );
  if (isAgentDelegationJob(job) && hasDurableChildReference(liveChild) && liveChild) {
    const recovered = transitionExecutionJob(controllerHome, job.repoId, job.jobId, 'succeeded', {
      result: buildDelegatedExecutionResult({ childReference: liveChild }),
      error: undefined,
      workerPid: undefined,
      leaseRefs: [],
    }, { recoveredDelegatedChild: true });
    settleScheduledExecution(
      controllerHome,
      recovered,
      'succeeded',
      'Agent-delegation parent recovered from durable child reference after Worker loss.',
    );
    return { requeued: 0, terminal: 1, recovered: 1 };
  }

  const ambiguousOutcome = ambiguousStartedOperation(controllerHome, job) && !canAutomaticallyReplay(job);
  if (ambiguousOutcome) {
    const terminalJob = transitionExecutionJob(controllerHome, job.repoId, job.jobId, 'human_attention_required', {
      workerPid: undefined,
      leaseRefs: [],
      error: {
        code: 'OPERATION_OUTCOME_AMBIGUOUS',
        message: deadlineElapsed
          ? 'A non-replayable Worker exceeded its deadline after execution started. It was stopped and will not be replayed automatically.'
          : 'A non-replayable Worker disappeared after execution started. Automatic replay is blocked to prevent duplicate side effects.',
        retryable: false,
      },
    });
    settleScheduledExecution(controllerHome, terminalJob, 'failed', 'Scheduled non-replayable operation ended with an ambiguous outcome and requires human review.');
    return { requeued: 0, terminal: 1, recovered: 0 };
  }

  if (!termination.exited) {
    const terminalJob = transitionExecutionJob(controllerHome, job.repoId, job.jobId, 'orphaned', {
      workerPid: undefined,
      leaseRefs: [],
      error: {
        code: 'WORKER_TERMINATION_INCOMPLETE',
        message: `The previous Worker process tree is still alive after termination was requested: ${termination.remainingPids.join(', ')}`,
        retryable: false,
      },
    });
    settleScheduledExecution(controllerHome, terminalJob, 'failed', 'Scheduled worker did not exit after termination was requested.');
    return { requeued: 0, terminal: 1, recovered: 0 };
  }

  if (!deadlineElapsed && job.attempt < job.maxAttempts) {
    transitionExecutionJob(controllerHome, job.repoId, job.jobId, 'queued', {
      workerPid: undefined,
      heartbeatAt: undefined,
      leaseRefs: [],
      error: {
        code: 'WORKER_LOST',
        message: workerLostMessage(workerLostReason, heartbeatAge, false),
        retryable: true,
        details: { workerLostReason, heartbeatAgeMs: heartbeatAge, attempt: job.attempt, maxAttempts: job.maxAttempts },
      },
    });
    return { requeued: 1, terminal: 0, recovered: 0 };
  }
  const status = deadlineElapsed ? 'timed_out' : 'failed';
  const terminalJob = transitionExecutionJob(controllerHome, job.repoId, job.jobId, status, {
    workerPid: undefined,
    heartbeatAt: undefined,
    leaseRefs: [],
    error: deadlineElapsed
      ? { code: 'DEADLINE_EXCEEDED', message: 'Execution deadline elapsed.', retryable: false }
      : {
          code: 'WORKER_LOST',
          message: workerLostMessage(workerLostReason, heartbeatAge, true),
          retryable: false,
          details: { workerLostReason, heartbeatAgeMs: heartbeatAge, attempt: job.attempt, maxAttempts: job.maxAttempts },
        },
  });
  settleScheduledExecution(
    controllerHome,
    terminalJob,
    'failed',
    deadlineElapsed ? 'Scheduled operation exceeded its execution deadline.' : 'Scheduled worker was lost after retries were exhausted.',
  );
  return { requeued: 0, terminal: 1, recovered: 0 };
}
