import type { ExecutionJob } from '../../execution/jobs/types';
import type { ScheduleDecisionType, ScheduleOccurrence } from './types';
import {
  getOccurrence,
  getSchedule,
  recordScheduleOccurrenceHandoff,
  saveOccurrence,
  saveSchedule,
  type ScheduleOccurrenceHandoffInput,
} from './store';

const TERMINAL_OCCURRENCE_STATUSES = new Set<ScheduleOccurrence['status']>(['succeeded', 'failed', 'shadowed', 'skipped']);

function computeScheduleFailureState(schedule: ReturnType<typeof getSchedule>, nextFailures: number): Pick<ReturnType<typeof getSchedule>, 'consecutiveFailures' | 'nextEligibleAt' | 'enabled' | 'pausedReason'> {
  const shouldPause = nextFailures >= schedule.policy.maxFailures;
  const backoffBase = Math.max(1, schedule.policy.backoffBaseMinutes ?? schedule.policy.cooldownMinutes ?? 1);
  const backoffMax = Math.max(backoffBase, schedule.policy.backoffMaxMinutes ?? 24 * 60);
  const backoffMinutes = Math.min(backoffMax, backoffBase * (2 ** Math.max(0, nextFailures - 1)));
  return {
    consecutiveFailures: nextFailures,
    nextEligibleAt: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
    enabled: shouldPause ? false : schedule.enabled,
    pausedReason: shouldPause ? 'Maximum consecutive failures reached.' : undefined,
  };
}

export function applyScheduleFailure(
  controllerHome: string,
  scheduleId: string,
  repoId: string,
  occurrenceId: string,
  options: {
    outcome: 'failed' | 'skipped';
    decision?: ScheduleDecisionType;
    reason: string;
    countFailure?: boolean;
    pauseReason?: string;
    handoff?: ScheduleOccurrenceHandoffInput;
  },
): { schedule: ReturnType<typeof getSchedule>; occurrence?: ScheduleOccurrence } {
  const schedule = getSchedule(controllerHome, repoId, scheduleId);
  const occurrence = getOccurrence(controllerHome, repoId, occurrenceId);
  let nextOccurrence = occurrence;
  if (occurrence && !TERMINAL_OCCURRENCE_STATUSES.has(occurrence.status)) {
    nextOccurrence = saveOccurrence(controllerHome, {
      ...occurrence,
      status: options.outcome,
      decision: options.decision ?? occurrence.decision,
      reason: options.reason,
    });
  }
  if (nextOccurrence && options.handoff) {
    nextOccurrence = recordScheduleOccurrenceHandoff(controllerHome, schedule, nextOccurrence, options.handoff);
  }

  const countFailure = options.countFailure !== false;
  const nextSchedule = options.pauseReason
    ? saveSchedule(controllerHome, {
      ...schedule,
      enabled: false,
      pausedReason: options.pauseReason,
      nextEligibleAt: undefined,
      consecutiveFailures: countFailure ? schedule.consecutiveFailures + 1 : schedule.consecutiveFailures,
    })
    : countFailure
      ? saveSchedule(controllerHome, { ...schedule, ...computeScheduleFailureState(schedule, schedule.consecutiveFailures + 1) })
      : schedule;
  return { schedule: nextSchedule, occurrence: nextOccurrence };
}

export function markScheduledExecutionRunning(controllerHome: string, job: ExecutionJob): void {
  if (job.type !== 'scheduled-occurrence') return;
  const occurrenceId = typeof job.payload.occurrenceId === 'string' ? job.payload.occurrenceId : undefined;
  if (!occurrenceId) return;
  try {
    const occurrence = getOccurrence(controllerHome, job.repoId, occurrenceId);
    if (occurrence && occurrence.status === 'queued') {
      saveOccurrence(controllerHome, { ...occurrence, status: 'running', decision: 'execute', reason: 'Scheduled Worker started.' });
    }
  } catch {
    // The durable Job remains authoritative if an old occurrence was removed.
  }
}

/**
 * Keep an occurrence and its owning schedule consistent with the terminal
 * state of the durable ExecutionJob that implements it. This is deliberately
 * idempotent so both the Worker and the Reconciler may call it safely.
 */
export function settleScheduledExecution(
  controllerHome: string,
  job: ExecutionJob,
  outcome: 'succeeded' | 'failed',
  reason: string,
): void {
  if (job.type !== 'scheduled-occurrence') return;
  const scheduleId = typeof job.payload.scheduleId === 'string' ? job.payload.scheduleId : undefined;
  const occurrenceId = typeof job.payload.occurrenceId === 'string' ? job.payload.occurrenceId : undefined;
  if (!scheduleId || !occurrenceId) return;
  try {
    const schedule = getSchedule(controllerHome, job.repoId, scheduleId);
    const occurrence = getOccurrence(controllerHome, job.repoId, occurrenceId);
    if (occurrence && !['succeeded', 'failed', 'shadowed', 'skipped'].includes(occurrence.status)) {
      saveOccurrence(controllerHome, {
        ...occurrence,
        status: outcome,
        decision: 'execute',
        reason,
      });
    }
    if (outcome === 'failed') {
      applyScheduleFailure(controllerHome, scheduleId, job.repoId, occurrenceId, {
        outcome,
        decision: 'execute',
        reason,
        handoff: {
          title: `Scheduled maintenance occurrence ${occurrenceId} failed`,
          summary: 'A bounded live maintenance occurrence failed and requires review before the schedule continues unattended.',
          reason,
          creationReason: 'repeated_infrastructure_failure',
          blockingDecision: 'Review the failed maintenance occurrence and decide whether the schedule should continue automatically.',
          recommendedDecision: 'Inspect the failed occurrence, fix the runtime blocker, then re-enable or retrigger the schedule intentionally.',
          recommendedPrompt: `Review schedule occurrence ${occurrenceId} for ${scheduleId}, inspect the failed runtime maintenance action, and decide whether to resume automatic maintenance.`,
          statusSummary: 'Scheduled maintenance execution failed.',
          blockedBy: ['scheduled_execution_failed'],
          attemptedActions: [
            `job:${job.jobId}`,
            `operation:${String(job.payload.operation ?? 'unknown')}`,
          ],
        },
      });
      return;
    }
    saveSchedule(controllerHome, {
      ...schedule,
      consecutiveFailures: 0,
      nextEligibleAt: undefined,
      pausedReason: undefined,
    });
  } catch {
    // Job terminal state remains authoritative even if an old schedule record
    // has already been removed. Reconciliation must not be blocked by it.
  }
}
