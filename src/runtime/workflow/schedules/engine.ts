import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getRepository } from '../../../cli/repositories/registry';
import { createExecutionJob, findExecutionJob, listActiveExecutionJobs, listExecutionJobs } from '../../execution/jobs/store';
import { rebuildRepositoryProjection } from '../../projections/materialized-view';
import { listCandidateFindings } from '../findings/store';
import {
  getOccurrence,
  listActiveOccurrences,
  listOccurrences,
  listSchedules,
  saveOccurrence,
  saveSchedule,
  saveScheduleDecision,
} from './store';
import type {
  RepositorySchedule,
  ScheduleDecisionType,
  ScheduleOccurrence,
  ScheduleTriggerContext,
} from './types';

const execFileAsync = promisify(execFile);

function normalizedWindow(minutes: number, at = Date.now()): string {
  return String(Math.floor(at / (Math.max(1, minutes) * 60_000)));
}

function triggerWindowKey(schedule: RepositorySchedule, context: ScheduleTriggerContext | undefined, at = Date.now()): string {
  switch (schedule.trigger.type) {
    case 'cron':
      return new Date(at).toISOString().slice(0, 16);
    case 'calendar':
      return schedule.trigger.calendarAt ?? new Date(at).toISOString().slice(0, 16);
    case 'repository-event':
      return context?.eventId?.trim() || `${context?.eventName ?? schedule.trigger.eventName ?? 'event'}:${normalizedWindow(1, at)}`;
    case 'dependency-checkpoint':
      return createHash('sha256').update(JSON.stringify(schedule.trigger.dependencyJobIds ?? [])).digest('hex').slice(0, 20);
    case 'manual':
      return context?.eventId?.trim() || normalizedWindow(1, at);
    case 'condition':
    case 'interval':
    default:
      return normalizedWindow(schedule.trigger.everyMinutes ?? 60, at);
  }
}

function cronFieldMatches(value: number, field: string, min: number, max: number): boolean {
  return field.split(',').some((part) => {
    const trimmed = part.trim();
    if (trimmed === '*') return true;
    const stepMatch = trimmed.match(/^\*\/(\d+)$/);
    if (stepMatch) return value % Math.max(1, Number(stepMatch[1])) === 0;
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      const start = Math.max(min, Number(rangeMatch[1]));
      const end = Math.min(max, Number(rangeMatch[2]));
      const step = Math.max(1, Number(rangeMatch[3] ?? 1));
      return value >= start && value <= end && (value - start) % step === 0;
    }
    const exact = Number(trimmed);
    return Number.isInteger(exact) && exact >= min && exact <= max && value === exact;
  });
}

function cronDue(expression: string | undefined, at = Date.now()): boolean {
  if (!expression) return false;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`SCHEDULE_CRON_INVALID: expected five fields, received ${fields.length}`);
  const date = new Date(at);
  return cronFieldMatches(date.getUTCMinutes(), fields[0], 0, 59)
    && cronFieldMatches(date.getUTCHours(), fields[1], 0, 23)
    && cronFieldMatches(date.getUTCDate(), fields[2], 1, 31)
    && cronFieldMatches(date.getUTCMonth() + 1, fields[3], 1, 12)
    && cronFieldMatches(date.getUTCDay(), fields[4], 0, 6);
}

async function workspaceDirty(controllerHome: string, repoId: string): Promise<boolean> {
  try {
    const repository = getRepository(repoId, controllerHome, { includeRemoved: true });
    const result = await execFileAsync('git', ['-C', repository.canonicalRoot, 'status', '--porcelain=v1'], {
      encoding: 'utf8', timeout: 1_500, maxBuffer: 256 * 1024,
    });
    return Boolean(result.stdout.trim());
  } catch {
    return true;
  }
}

async function triggerDue(
  controllerHome: string,
  schedule: RepositorySchedule,
  force: boolean,
  context?: ScheduleTriggerContext,
): Promise<{ due: boolean; reason?: string; evidence?: Record<string, unknown> }> {
  if (force && schedule.trigger.type !== 'repository-event') return { due: true };
  switch (schedule.trigger.type) {
    case 'manual':
      return { due: force, reason: force ? undefined : 'Manual Schedule requires an explicit trigger.' };
    case 'interval':
      return { due: true };
    case 'cron':
      return { due: cronDue(schedule.trigger.cronExpression), reason: 'Cron expression is not due in the current UTC minute.' };
    case 'calendar': {
      const at = Date.parse(schedule.trigger.calendarAt ?? '');
      if (!Number.isFinite(at)) throw new Error('SCHEDULE_CALENDAR_INVALID: calendarAt must be an ISO-8601 timestamp');
      return { due: Date.now() >= at, reason: 'Calendar trigger is not due yet.', evidence: { calendarAt: schedule.trigger.calendarAt } };
    }
    case 'repository-event': {
      const expected = schedule.trigger.eventName?.trim();
      const actual = context?.eventName?.trim();
      const due = context?.source === 'repository-event' && Boolean(actual) && (!expected || expected === actual);
      return { due, reason: due ? undefined : 'Repository event did not match this Schedule.', evidence: { expected, actual, eventId: context?.eventId } };
    }
    case 'dependency-checkpoint': {
      const dependencyJobIds = schedule.trigger.dependencyJobIds ?? [];
      if (dependencyJobIds.length === 0) throw new Error('SCHEDULE_DEPENDENCY_REQUIRED: dependency checkpoint has no Job ids');
      const jobs = dependencyJobIds.map((jobId) => findExecutionJob(controllerHome, jobId));
      const due = jobs.every((job) => job?.status === 'succeeded');
      return {
        due,
        reason: due ? undefined : 'Dependency checkpoint is not ready.',
        evidence: { dependencies: dependencyJobIds.map((jobId, index) => ({ jobId, status: jobs[index]?.status ?? 'missing' })) },
      };
    }
    case 'condition': {
      const condition = schedule.trigger.condition;
      if (!condition) throw new Error('SCHEDULE_CONDITION_REQUIRED');
      if (condition.kind === 'repository_clean') {
        const clean = !(await workspaceDirty(controllerHome, schedule.repoId));
        return { due: clean, reason: clean ? undefined : 'Repository is not clean.', evidence: { clean } };
      }
      if (condition.kind === 'job_succeeded' || condition.kind === 'job_terminal') {
        const job = condition.jobId ? findExecutionJob(controllerHome, condition.jobId) : undefined;
        const terminal = Boolean(job && ['succeeded', 'failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(job.status));
        const due = condition.kind === 'job_succeeded' ? job?.status === 'succeeded' : terminal;
        return { due, reason: due ? undefined : `Condition ${condition.kind} is not met.`, evidence: { jobId: condition.jobId, status: job?.status ?? 'missing' } };
      }
      const threshold = Math.max(1, condition.observationThreshold ?? 2);
      const finding = listCandidateFindings(controllerHome, schedule.repoId, { includeTerminal: true, limit: 1000 })
        .find((entry) => entry.semanticKey === condition.semanticKey);
      const due = Boolean(finding && finding.observationCount >= threshold);
      return { due, reason: due ? undefined : 'Candidate observation threshold is not met.', evidence: { semanticKey: condition.semanticKey, observations: finding?.observationCount ?? 0, threshold } };
    }
    default:
      return { due: false, reason: 'Unsupported Schedule trigger.' };
  }
}

async function stopReason(controllerHome: string, schedule: RepositorySchedule): Promise<string | undefined> {
  const projection = rebuildRepositoryProjection(controllerHome, schedule.repoId);
  if (schedule.stopConditions.includes('human_review_required') && projection.currentAttention.length > 0) return 'Repository has jobs requiring human attention.';
  if (schedule.stopConditions.includes('release_ready') && projection.releaseFrozen) return 'Repository is in release freeze.';
  if (schedule.stopConditions.includes('external_blocker')) {
    try {
      const repository = getRepository(schedule.repoId, controllerHome, { includeRemoved: true });
      if (!repository.enabled || repository.removedAt) return 'Repository is disabled or removed.';
    } catch {
      return 'Repository registry is unavailable.';
    }
    const recentInfrastructureFailure = listExecutionJobs(controllerHome, schedule.repoId, 20).find((job) => {
      if (!['failed', 'timed_out', 'orphaned'].includes(job.status) || !job.error) return false;
      if (job.error.retryable) return true;
      return /(?:network|connection|upstream|external|remote|github|tunnel|502|503|timeout)/i.test(`${job.error.code} ${job.error.message}`);
    });
    if (recentInfrastructureFailure) return `External or infrastructure blocker detected from Job ${recentInfrastructureFailure.jobId}.`;
  }
  if (projection.activeJobs.some((job) => job.status === 'waiting_for_release_barrier')) return 'Repository is waiting on a release barrier.';
  if (schedule.action.resourceClaims?.some((claim) => claim.mode !== 'read') && await workspaceDirty(controllerHome, schedule.repoId)) return 'Workspace is dirty; automatic write occurrence was suppressed.';
  return undefined;
}

function dailyRuntimeMinutes(controllerHome: string, occurrences: ScheduleOccurrence[]): number {
  const today = new Date().toISOString().slice(0, 10);
  return occurrences
    .filter((entry) => entry.createdAt.startsWith(today) && entry.jobId)
    .reduce((total, entry) => {
      const job = entry.jobId ? findExecutionJob(controllerHome, entry.jobId) : undefined;
      if (!job) return total;
      const started = Date.parse(job.startedAt ?? job.createdAt);
      const finished = Date.parse(job.finishedAt ?? new Date().toISOString());
      return total + Math.max(1, Math.ceil(Math.max(0, finished - started) / 60_000));
    }, 0);
}

function decideOccurrence(
  controllerHome: string,
  schedule: RepositorySchedule,
  occurrence: ScheduleOccurrence,
  decision: ScheduleDecisionType,
  status: ScheduleOccurrence['status'],
  reason?: string,
  evidence?: Record<string, unknown>,
): ScheduleOccurrence {
  const decisionId = `DEC-${occurrence.occurrenceId}`;
  saveScheduleDecision(controllerHome, {
    schemaVersion: 1,
    revision: 1,
    decisionId,
    occurrenceId: occurrence.occurrenceId,
    scheduleId: occurrence.scheduleId,
    repoId: occurrence.repoId,
    requestId: `${schedule.requestId}:${occurrence.windowKey}`,
    decision,
    reason,
    triggerContext: occurrence.triggerContext,
    evidence,
    createdAt: new Date().toISOString(),
  });
  return saveOccurrence(controllerHome, { ...occurrence, decision, decisionId, status, reason });
}

export async function evaluateSchedule(
  controllerHome: string,
  schedule: RepositorySchedule,
  force = false,
  triggerContext?: ScheduleTriggerContext,
): Promise<ScheduleOccurrence | undefined> {
  if (!schedule.enabled && !force) return undefined;
  const due = await triggerDue(controllerHome, schedule, force, triggerContext);
  if (!due.due) return undefined;

  const key = triggerWindowKey(schedule, triggerContext);
  const occurrenceId = `OCC-${schedule.scheduleId}-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
  const existing = getOccurrence(controllerHome, schedule.repoId, occurrenceId);
  if (existing) return existing;
  const timestamp = new Date().toISOString();
  const occurrence: ScheduleOccurrence = saveOccurrence(controllerHome, {
    schemaVersion: 1,
    revision: 0,
    occurrenceId,
    scheduleId: schedule.scheduleId,
    repoId: schedule.repoId,
    windowKey: key,
    status: 'created',
    decision: 'nothing_to_do',
    triggerContext: triggerContext ?? { source: force ? 'manual' : 'timer' },
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  const recent = listOccurrences(controllerHome, schedule.repoId, schedule.scheduleId, 1000);
  const stop = await stopReason(controllerHome, schedule);
  if (stop) return decideOccurrence(controllerHome, schedule, occurrence, 'stopped', 'skipped', stop);

  const active = listActiveOccurrences(controllerHome, schedule.repoId, schedule.scheduleId)
    .filter((entry) => entry.occurrenceId !== occurrence.occurrenceId);
  if (active.length >= schedule.policy.maxActiveOccurrences) {
    return decideOccurrence(controllerHome, schedule, occurrence, 'active_occurrence', 'skipped', 'Maximum active occurrences reached.');
  }
  if (schedule.consecutiveFailures >= schedule.policy.maxFailures) {
    saveSchedule(controllerHome, { ...schedule, enabled: false, pausedReason: 'Maximum consecutive failures reached.' });
    return decideOccurrence(controllerHome, schedule, occurrence, 'stopped', 'skipped', 'Schedule paused after repeated failures.');
  }
  if (schedule.nextEligibleAt && Date.parse(schedule.nextEligibleAt) > Date.now() && !force) {
    return decideOccurrence(controllerHome, schedule, occurrence, 'cooldown', 'skipped', `Schedule backoff remains active until ${schedule.nextEligibleAt}.`);
  }
  if (schedule.lastTriggeredAt && Date.now() - Date.parse(schedule.lastTriggeredAt) < schedule.policy.cooldownMinutes * 60_000 && !force) {
    return decideOccurrence(controllerHome, schedule, occurrence, 'cooldown', 'skipped', 'Schedule is cooling down.');
  }
  if (dailyRuntimeMinutes(controllerHome, recent) >= schedule.policy.dailyBudgetMinutes) {
    return decideOccurrence(controllerHome, schedule, occurrence, 'budget_exhausted', 'skipped', 'Daily schedule budget exhausted.');
  }
  if (schedule.policy.shadowMode) {
    saveSchedule(controllerHome, { ...schedule, lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId });
    return decideOccurrence(controllerHome, schedule, occurrence, 'would_execute', 'shadowed', 'Shadow mode records the decision without modifying the repository.', due.evidence);
  }

  const requestId = `${schedule.scheduleId}:${schedule.repoId}:${key}`;
  const decision = decideOccurrence(controllerHome, schedule, occurrence, 'execute', 'created', 'Bounded occurrence accepted for durable execution.', due.evidence);
  const created = createExecutionJob(controllerHome, {
    repoId: schedule.repoId,
    type: 'scheduled-occurrence',
    requestId,
    semanticKey: `schedule:${schedule.scheduleId}:${key}`,
    priority: schedule.action.priority ?? 'P3',
    origin: { surface: 'schedule', actor: schedule.scheduleId, correlationId: occurrenceId },
    payload: {
      operation: schedule.action.operation,
      arguments: schedule.action.arguments,
      scheduleId: schedule.scheduleId,
      occurrenceId,
      target: 'mcp-tool',
    },
    resourceClaims: schedule.action.resourceClaims,
    timeoutMs: Math.max(60_000, schedule.policy.dailyBudgetMinutes * 60_000),
  });
  saveSchedule(controllerHome, { ...schedule, lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId });
  return saveOccurrence(controllerHome, { ...decision, status: 'queued', jobId: created.job.jobId, reason: 'Durable Schedule Job queued.' });
}

export async function tickSchedules(controllerHome: string, repoIds: string[]): Promise<ScheduleOccurrence[]> {
  const occurrences: ScheduleOccurrence[] = [];
  for (const repoId of repoIds) {
    for (const schedule of listSchedules(controllerHome, repoId)) {
      const occurrence = await evaluateSchedule(controllerHome, schedule, false, { source: 'timer' });
      if (occurrence) occurrences.push(occurrence);
    }
  }
  return occurrences;
}

export function hasScheduledWriter(controllerHome: string, repoId: string): boolean {
  return listActiveExecutionJobs(controllerHome, repoId).some((job) => job.origin.surface === 'schedule' && job.resourceClaims.some((claim) => claim.mode !== 'read'));
}
