#!/usr/bin/env bun
import { ensureControllerHome } from '../../../cli/repositories/controller-home';
import { getExecutionJob, heartbeatExecutionJob, transitionExecutionJobFromWorker } from '../jobs/store';
import { assertFencingToken, releaseExecutionLeases, renewExecutionLeases } from '../../resources/leases/store';
import { recordExecutionEvidence } from '../../evidence/evidence-store';
import { boundExecutionResult } from '../../evidence/artifact-store';
import { executeExecutionJob } from './executor';
import { markOperationCompleted, markOperationStarted } from '../jobs/receipt-store';
import { markScheduledExecutionRunning } from '../../workflow/schedules/settlement';
import { invalidateExecutionWorker } from './ownership';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const controllerHome = ensureControllerHome(option('--controller-home'));
const repoIdOption = option('--repo-id');
const jobIdOption = option('--job-id');
const controllerPid = Number(option('--controller-pid') ?? 0) || undefined;
const controllerStartedAt = option('--controller-started-at');
if (!repoIdOption || !jobIdOption) {
  throw new Error('worker-entry requires --repo-id and --job-id');
}
const repoId: string = repoIdOption;
const jobId: string = jobIdOption;

let heartbeat: NodeJS.Timeout | undefined;
let claimedAttempt: number | undefined;
let claimedLeaseRefs: Array<{ leaseId: string; fencingToken: number }> = [];
let exitingForOwnershipLoss = false;

function exitForOwnershipLoss(message: string): never {
  if (heartbeat) clearInterval(heartbeat);
  if (!exitingForOwnershipLoss) {
    exitingForOwnershipLoss = true;
    try {
      const current = getExecutionJob(controllerHome, repoId, jobId);
      const mutating = current.resourceClaims.some((claim) => claim.mode !== 'read');
      if (current.status === 'running' && current.workerPid === process.pid) {
        transitionExecutionJobFromWorker(
          controllerHome,
          repoId,
          jobId,
          { workerPid: process.pid, attempt: current.attempt, leaseRefs: current.leaseRefs },
          mutating ? 'human_attention_required' : 'failed',
          {
            error: {
              code: mutating ? 'WORKER_OUTCOME_AMBIGUOUS' : 'WORKER_OWNERSHIP_LOST',
              message,
              retryable: !mutating,
            },
            leaseRefs: [],
          },
        );
      }
    } catch {
      // Ownership already moved or the Job is terminal.
    }
    try { releaseExecutionLeases(controllerHome, repoId, jobId, claimedLeaseRefs); }
    catch { /* the lease expired or ownership moved */ }
  }
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  let job = getExecutionJob(controllerHome, repoId, jobId);
  if (job.status !== 'running') throw new Error(`JOB_NOT_RUNNING: ${job.status}`);
  const startupInvalidation = invalidateExecutionWorker(controllerHome, repoId, jobId, {
    workerPid: process.pid,
    attempt: job.attempt,
    controllerPid,
    controllerStartedAt,
    job,
  });
  if (startupInvalidation) exitForOwnershipLoss(startupInvalidation.message);
  claimedAttempt = job.attempt;
  claimedLeaseRefs = job.leaseRefs.map((ref) => ({ leaseId: ref.leaseId, fencingToken: ref.fencingToken }));
  job = heartbeatExecutionJob(controllerHome, repoId, jobId, process.pid, claimedAttempt);
  const owner = { workerPid: process.pid, attempt: claimedAttempt, leaseRefs: claimedLeaseRefs };
  markScheduledExecutionRunning(controllerHome, job);
  markOperationStarted(controllerHome, job, process.pid);
  heartbeat = setInterval(() => {
    try {
      const invalidation = invalidateExecutionWorker(controllerHome, repoId, jobId, {
        workerPid: process.pid,
        attempt: claimedAttempt,
        controllerPid,
        controllerStartedAt,
      });
      if (invalidation) exitForOwnershipLoss(invalidation.message);
      heartbeatExecutionJob(controllerHome, repoId, jobId, process.pid, claimedAttempt);
      renewExecutionLeases(controllerHome, repoId, jobId, 30_000, claimedLeaseRefs);
    } catch (error) {
      exitForOwnershipLoss(error instanceof Error ? error.message : String(error));
    }
  }, 5_000);
  heartbeat.unref();

  const execution = await executeExecutionJob(controllerHome, job);
  const current = getExecutionJob(controllerHome, repoId, jobId);
  const completionInvalidation = invalidateExecutionWorker(controllerHome, repoId, jobId, {
    workerPid: process.pid,
    attempt: claimedAttempt,
    controllerPid,
    controllerStartedAt,
    job: current,
  });
  if (completionInvalidation) exitForOwnershipLoss(completionInvalidation.message);
  for (const ref of claimedLeaseRefs) assertFencingToken(controllerHome, repoId, ref.leaseId, ref.fencingToken);
  const bounded = execution.ok
    ? boundExecutionResult(controllerHome, current, execution.result ?? {})
    : execution.error?.details
      ? boundExecutionResult(controllerHome, current, execution.error.details, 'job-error')
      : undefined;
  const evidence = recordExecutionEvidence(
    controllerHome,
    execution.repoRoot,
    current,
    execution.ok ? 'succeeded' : 'failed',
    bounded?.result,
  );
  const evidenceIds = [...current.evidenceIds, evidence.evidenceId];
  const terminalError = execution.error ? { ...execution.error, details: bounded?.result } : undefined;
  markOperationCompleted(controllerHome, current, process.pid, {
    outcome: execution.ok ? 'succeeded' : 'failed',
    result: execution.ok ? bounded?.result : undefined,
    error: terminalError,
    evidenceIds,
  });
  if (execution.ok) {
    transitionExecutionJobFromWorker(controllerHome, repoId, jobId, owner, 'succeeded', {
      result: bounded?.result,
      outcome: execution.outcome,
      evidenceIds,
      leaseRefs: [],
    }, { evidenceId: evidence.evidenceId });
  } else {
    transitionExecutionJobFromWorker(controllerHome, repoId, jobId, owner, 'failed', {
      error: terminalError,
      outcome: execution.outcome ?? (terminalError ? { infrastructureError: { code: terminalError.code, message: terminalError.message } } : undefined),
      evidenceIds,
      leaseRefs: [],
    }, { evidenceId: evidence.evidenceId, error: execution.error });
  }
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const current = getExecutionJob(controllerHome, repoId, jobId);
      const mutating = current.resourceClaims.some((claim) => claim.mode !== 'read');
      if (current.status === 'running' && current.workerPid === process.pid) {
        transitionExecutionJobFromWorker(
          controllerHome,
          repoId,
          jobId,
          { workerPid: process.pid, attempt: current.attempt, leaseRefs: current.leaseRefs },
          mutating ? 'human_attention_required' : 'failed',
          {
            error: {
              code: mutating ? 'WORKER_OUTCOME_AMBIGUOUS' : 'WORKER_CRASH',
              message: mutating
                ? `Worker failed after acquiring write ownership; automatic replay is blocked: ${message}`
                : message,
              retryable: !mutating,
            },
            leaseRefs: [],
          },
        );
      }
    } catch { /* a replacement Worker owns the Job; stale Worker must not write */ }
    console.error(message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (heartbeat) clearInterval(heartbeat);
    try { releaseExecutionLeases(controllerHome, repoId, jobId, claimedLeaseRefs); }
    catch { /* the lease expired or ownership moved */ }
  });
