import { listActiveExecutionJobs, transitionExecutionJob } from '../../execution/jobs/store';
import type { ExecutionJob } from '../../execution/jobs/types';
import { readOperationReceipt } from '../../execution/jobs/receipt-store';
import { releaseExecutionLeases } from '../../resources/leases/store';
import { isProcessAlive, terminateProcessTree, terminateProcessTreeSync, type ProcessTreeTerminationResult } from '../../shared/process-tree';
import { settleScheduledExecution } from '../../workflow/schedules/settlement';

function hasPotentialSideEffects(job: ExecutionJob): boolean {
  return job.resourceClaims.some((claim) => claim.mode !== 'read');
}

function recoverCompletedReceipt(controllerHome: string, job: ExecutionJob): ExecutionJob | undefined {
  const receipt = readOperationReceipt(controllerHome, job.repoId, job.jobId);
  if (!receipt || receipt.attempt !== job.attempt || receipt.state !== 'completed' || !receipt.outcome) return undefined;
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

function ambiguousStartedOperation(controllerHome: string, job: ExecutionJob): boolean {
  const receipt = readOperationReceipt(controllerHome, job.repoId, job.jobId);
  return Boolean(receipt && receipt.attempt === job.attempt && receipt.state === 'started');
}

type ReconcileSummary = { inspected: number; requeued: number; terminal: number; recovered: number };

export function reconcileExecutionJobs(controllerHome: string): ReconcileSummary {
  return reconcileExecutionJobsWith(controllerHome, (pid) => terminateProcessTreeSync(pid));
}

export async function reconcileExecutionJobsAsync(controllerHome: string): Promise<ReconcileSummary> {
  return reconcileExecutionJobsAsyncWith(controllerHome, (pid) => terminateProcessTree(pid));
}

function reconcileExecutionJobsWith(
  controllerHome: string,
  terminateWorker: (pid: number | undefined) => ProcessTreeTerminationResult,
): ReconcileSummary {
  const jobs = listActiveExecutionJobs(controllerHome);
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

    const heartbeatAge = job.heartbeatAt ? Date.now() - Date.parse(job.heartbeatAt) : Number.POSITIVE_INFINITY;
    const deadlineElapsed = Boolean(job.deadlineAt && Date.parse(job.deadlineAt) <= Date.now());
    const workerLost = !isProcessAlive(job.workerPid) || heartbeatAge >= 45_000;
    if (!deadlineElapsed && !workerLost) continue;

    const termination = terminateWorker(job.workerPid);
    const outcome = finalizeRunningJob(controllerHome, job, deadlineElapsed, termination);
    requeued += outcome.requeued;
    terminal += outcome.terminal;
    recovered += outcome.recovered;
  }
  return { inspected: jobs.length, requeued, terminal, recovered };
}

async function reconcileExecutionJobsAsyncWith(
  controllerHome: string,
  terminateWorker: (pid: number | undefined) => Promise<ProcessTreeTerminationResult>,
): Promise<ReconcileSummary> {
  const jobs = listActiveExecutionJobs(controllerHome);
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

    const heartbeatAge = job.heartbeatAt ? Date.now() - Date.parse(job.heartbeatAt) : Number.POSITIVE_INFINITY;
    const deadlineElapsed = Boolean(job.deadlineAt && Date.parse(job.deadlineAt) <= Date.now());
    const workerLost = !isProcessAlive(job.workerPid) || heartbeatAge >= 45_000;
    if (!deadlineElapsed && !workerLost) continue;

    const termination = await terminateWorker(job.workerPid);
    const outcome = finalizeRunningJob(controllerHome, job, deadlineElapsed, termination);
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
): { requeued: number; terminal: number; recovered: number } {
  const receiptRecovery = recoverCompletedReceipt(controllerHome, job);
  if (receiptRecovery) {
    return { requeued: 0, terminal: 1, recovered: 1 };
  }

  releaseExecutionLeases(controllerHome, job.repoId, job.jobId, job.leaseRefs);
  const ambiguousMutation = hasPotentialSideEffects(job) && ambiguousStartedOperation(controllerHome, job);
  if (ambiguousMutation) {
    const terminalJob = transitionExecutionJob(controllerHome, job.repoId, job.jobId, 'human_attention_required', {
      workerPid: undefined,
      leaseRefs: [],
      error: {
        code: 'OPERATION_OUTCOME_AMBIGUOUS',
        message: deadlineElapsed
          ? 'A mutating Worker exceeded its deadline after execution started. It was stopped and will not be replayed automatically.'
          : 'A mutating Worker disappeared after execution started. Automatic replay is blocked to prevent duplicate side effects.',
        retryable: false,
      },
    });
    settleScheduledExecution(controllerHome, terminalJob, 'failed', 'Scheduled mutating operation ended with an ambiguous outcome and requires human review.');
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
      error: { code: 'WORKER_LOST', message: 'Worker disappeared before a side effect became ambiguous; job was safely requeued.', retryable: true },
    });
    return { requeued: 1, terminal: 0, recovered: 0 };
  }
  const status = deadlineElapsed ? 'timed_out' : 'orphaned';
  const terminalJob = transitionExecutionJob(controllerHome, job.repoId, job.jobId, status, {
    workerPid: undefined,
    leaseRefs: [],
    error: deadlineElapsed
      ? { code: 'DEADLINE_EXCEEDED', message: 'Execution deadline elapsed.', retryable: false }
      : { code: 'WORKER_LOST', message: 'Worker disappeared after maximum attempts.', retryable: false },
  });
  settleScheduledExecution(
    controllerHome,
    terminalJob,
    'failed',
    deadlineElapsed ? 'Scheduled operation exceeded its execution deadline.' : 'Scheduled worker disappeared after maximum attempts.',
  );
  return { requeued: 0, terminal: 1, recovered: 0 };
}
