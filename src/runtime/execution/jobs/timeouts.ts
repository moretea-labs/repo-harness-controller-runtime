import type {
  ExecutionJob,
  ExecutionJobStatus,
  ExecutionTimeoutPolicy,
} from './types';

export const MIN_EXECUTION_TIMEOUT_MS = 1_000;
export const MAX_EXECUTION_TIMEOUT_MS = 24 * 60 * 60_000;
export const DEFAULT_EXECUTION_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_INTERACTIVE_WAIT_MS = 15_000;

function bounded(value: number | undefined, fallback: number): number {
  const candidate = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
  return Math.max(MIN_EXECUTION_TIMEOUT_MS, Math.min(candidate, MAX_EXECUTION_TIMEOUT_MS));
}

export function normalizeExecutionTimeoutPolicy(
  input: Partial<ExecutionTimeoutPolicy> | undefined,
  fallbackExecutionMs = DEFAULT_EXECUTION_TIMEOUT_MS,
): ExecutionTimeoutPolicy {
  const executionTimeoutMs = bounded(input?.executionTimeoutMs, bounded(fallbackExecutionMs, DEFAULT_EXECUTION_TIMEOUT_MS));
  return {
    admissionTimeoutMs: bounded(input?.admissionTimeoutMs, executionTimeoutMs),
    queueTimeoutMs: bounded(input?.queueTimeoutMs, executionTimeoutMs),
    executionTimeoutMs,
    interactiveWaitMs: bounded(input?.interactiveWaitMs, DEFAULT_INTERACTIVE_WAIT_MS),
  };
}

export function deadlineAfter(startedAt: string, timeoutMs: number): string {
  return new Date(Date.parse(startedAt) + timeoutMs).toISOString();
}

export type ExecutionTimeoutPhase = 'admission' | 'queue' | 'execution' | 'legacy';

export interface ExecutionTimeoutDecision {
  phase: ExecutionTimeoutPhase;
  deadlineAt: string;
  code: 'ADMISSION_TIMEOUT' | 'QUEUE_TIMEOUT' | 'EXECUTION_TIMEOUT' | 'DEADLINE_EXCEEDED';
  message: string;
}

const WAITING_STATUSES = new Set<ExecutionJobStatus>([
  'queued',
  'waiting_for_dependency',
  'waiting_for_workspace',
  'waiting_for_heavy_check',
  'waiting_for_integration',
  'waiting_for_release_barrier',
  'waiting_for_approval',
  'dispatched',
]);

function expired(deadlineAt: string | undefined, nowMs: number): deadlineAt is string {
  if (!deadlineAt) return false;
  const parsed = Date.parse(deadlineAt);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

export function executionTimeoutDecision(
  job: ExecutionJob,
  nowMs = Date.now(),
): ExecutionTimeoutDecision | undefined {
  if (!job.timeoutPolicy) {
    if (!expired(job.deadlineAt, nowMs)) return undefined;
    return {
      phase: 'legacy',
      deadlineAt: job.deadlineAt,
      code: 'DEADLINE_EXCEEDED',
      message: job.status === 'running'
        ? 'Execution deadline elapsed while the Worker was running.'
        : 'Execution deadline elapsed before dispatch.',
    };
  }

  if (job.status === 'running') {
    const deadlineAt = job.executionDeadlineAt ?? job.deadlineAt;
    if (!expired(deadlineAt, nowMs)) return undefined;
    return {
      phase: 'execution',
      deadlineAt,
      code: 'EXECUTION_TIMEOUT',
      message: 'Execution timeout elapsed after the Worker started.',
    };
  }

  if (!WAITING_STATUSES.has(job.status)) return undefined;
  if (!job.timings?.schedulerObservedAt) {
    const deadlineAt = job.admissionDeadlineAt ?? job.deadlineAt;
    if (!expired(deadlineAt, nowMs)) return undefined;
    return {
      phase: 'admission',
      deadlineAt,
      code: 'ADMISSION_TIMEOUT',
      message: 'Admission timeout elapsed before the Scheduler observed the Job.',
    };
  }

  const deadlineAt = job.queueDeadlineAt ?? job.deadlineAt;
  if (!expired(deadlineAt, nowMs)) return undefined;
  return {
    phase: 'queue',
    deadlineAt,
    code: 'QUEUE_TIMEOUT',
    message: 'Queue timeout elapsed after Scheduler admission and before Worker start.',
  };
}
