import { getExecutionJob } from './store';
import { TERMINAL_JOB_STATUSES, type ExecutionJob } from './types';

export interface WaitForExecutionJobOptions {
  controllerHome: string;
  repoId: string;
  jobId: string;
  /** Defaults to 15s, capped at 120s for interactive waits. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTerminalExecutionJob(job: ExecutionJob): boolean {
  return TERMINAL_JOB_STATUSES.has(job.status);
}

export function isInteractiveExecutionStop(job: ExecutionJob): boolean {
  return isTerminalExecutionJob(job) || job.status === 'waiting_for_approval';
}

/**
 * Poll a durable ExecutionJob until terminal status, resumable approval wait, or timeout.
 * Intended for interactive development UX, not long agent runs.
 */
export async function waitForExecutionJob(options: WaitForExecutionJobOptions): Promise<{
  job: ExecutionJob;
  timedOut: boolean;
  waitedMs: number;
}> {
  const timeoutMs = Math.max(200, Math.min(Math.trunc(options.timeoutMs ?? 15_000), 120_000));
  const pollIntervalMs = Math.max(50, Math.min(Math.trunc(options.pollIntervalMs ?? 150), 2_000));
  const started = Date.now();
  let job = getExecutionJob(options.controllerHome, options.repoId, options.jobId);
  if (isInteractiveExecutionStop(job)) return { job, timedOut: false, waitedMs: Date.now() - started };
  while (Date.now() - started < timeoutMs) {
    await sleep(pollIntervalMs);
    job = getExecutionJob(options.controllerHome, options.repoId, options.jobId);
    if (isInteractiveExecutionStop(job)) return { job, timedOut: false, waitedMs: Date.now() - started };
  }
  return { job, timedOut: true, waitedMs: Date.now() - started };
}
