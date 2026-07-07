import { createHash, randomUUID } from 'crypto';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { withControllerLock } from '../../../cli/repositories/locks';
import { readJsonFile, writeJsonAtomic } from '../../shared/json-files';
import { appendRuntimeEvent } from '../../evidence/event-ledger';
import type { RepositorySchedule, ScheduleDecision, ScheduleOccurrence } from './types';

interface OccurrenceIndex {
  schemaVersion: 1;
  updatedAt: string;
  active: Array<{ occurrenceId: string; scheduleId: string; status: ScheduleOccurrence['status']; updatedAt: string }>;
  recent: Array<{ occurrenceId: string; scheduleId: string; status: ScheduleOccurrence['status']; createdAt: string; updatedAt: string }>;
}
interface ScheduleRequestRecord {
  schemaVersion: 1;
  requestId: string;
  semanticKey: string;
  scheduleId: string;
  repoId: string;
  createdAt: string;
}
type CreateScheduleInput = Omit<RepositorySchedule, 'schemaVersion' | 'revision' | 'scheduleId' | 'createdAt' | 'updatedAt' | 'consecutiveFailures'>;

function schedulesRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'schedules');
}
function schedulePath(controllerHome: string, repoId: string, scheduleId: string): string {
  return join(schedulesRoot(controllerHome, repoId), 'records', `${scheduleId}.json`);
}
function occurrencePath(controllerHome: string, repoId: string, occurrenceId: string): string {
  return join(schedulesRoot(controllerHome, repoId), 'occurrences', `${occurrenceId}.json`);
}

function decisionPath(controllerHome: string, repoId: string, decisionId: string): string {
  return join(schedulesRoot(controllerHome, repoId), 'decisions', `${decisionId}.json`);
}
function occurrenceIndexPath(controllerHome: string, repoId: string): string {
  return join(schedulesRoot(controllerHome, repoId), 'indexes', 'occurrences.json');
}
function requestPath(controllerHome: string, repoId: string, requestId: string): string {
  return join(schedulesRoot(controllerHome, repoId), 'indexes', 'requests', `${createHash('sha256').update(requestId).digest('hex')}.json`);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
function scheduleSemanticKey(input: CreateScheduleInput): string {
  return createHash('sha256').update(JSON.stringify(canonical({
    repoId: input.repoId,
    name: input.name,
    trigger: input.trigger,
    policy: input.policy,
    action: input.action,
    stopConditions: input.stopConditions,
  }))).digest('hex');
}
function emptyIndex(): OccurrenceIndex {
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), active: [], recent: [] };
}
function readOccurrenceIndex(controllerHome: string, repoId: string): OccurrenceIndex {
  return readJsonFile<OccurrenceIndex>(occurrenceIndexPath(controllerHome, repoId), emptyIndex());
}
function upsertOccurrenceIndexUnlocked(controllerHome: string, occurrence: ScheduleOccurrence): void {
  const index = readOccurrenceIndex(controllerHome, occurrence.repoId);
  index.active = index.active.filter((entry) => entry.occurrenceId !== occurrence.occurrenceId);
  index.recent = index.recent.filter((entry) => entry.occurrenceId !== occurrence.occurrenceId);
  if (['created', 'queued', 'running'].includes(occurrence.status)) {
    index.active.push({ occurrenceId: occurrence.occurrenceId, scheduleId: occurrence.scheduleId, status: occurrence.status, updatedAt: occurrence.updatedAt });
  }
  index.recent.push({ occurrenceId: occurrence.occurrenceId, scheduleId: occurrence.scheduleId, status: occurrence.status, createdAt: occurrence.createdAt, updatedAt: occurrence.updatedAt });
  index.updatedAt = new Date().toISOString();
  index.active.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  index.recent.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  index.active = index.active.slice(-5000);
  index.recent = index.recent.slice(0, 5000);
  writeJsonAtomic(occurrenceIndexPath(controllerHome, occurrence.repoId), index);
}

export function createSchedule(controllerHome: string, input: CreateScheduleInput): RepositorySchedule {
  const requestId = input.requestId.trim();
  if (!requestId) throw new Error('SCHEDULE_REQUEST_ID_REQUIRED');
  const semanticKey = scheduleSemanticKey(input);
  return withControllerLock(controllerHome, { scope: 'task', repoId: input.repoId, taskId: `schedule-request-${createHash('sha256').update(requestId).digest('hex').slice(0, 16)}` }, `create-schedule:${requestId}`, () => {
    const requestRecordPath = requestPath(controllerHome, input.repoId, requestId);
    if (existsSync(requestRecordPath)) {
      const record = readJsonFile<ScheduleRequestRecord>(requestRecordPath);
      if (record.semanticKey !== semanticKey) throw new Error(`SCHEDULE_REQUEST_ID_CONFLICT: ${requestId}`);
      return getSchedule(controllerHome, input.repoId, record.scheduleId);
    }
    const timestamp = new Date().toISOString();
    const schedule: RepositorySchedule = {
      ...input,
      requestId,
      schemaVersion: 1,
      revision: 1,
      scheduleId: `SCH-${Date.now()}-${randomUUID().slice(0, 8)}`,
      createdAt: timestamp,
      updatedAt: timestamp,
      consecutiveFailures: 0,
    };
    writeJsonAtomic(schedulePath(controllerHome, schedule.repoId, schedule.scheduleId), schedule);
    writeJsonAtomic(requestRecordPath, { schemaVersion: 1, requestId, semanticKey, scheduleId: schedule.scheduleId, repoId: schedule.repoId, createdAt: timestamp } satisfies ScheduleRequestRecord);
    appendRuntimeEvent(controllerHome, { repoId: schedule.repoId, entityType: 'schedule', entityId: schedule.scheduleId, eventType: 'schedule_created', requestId, revision: schedule.revision, data: { name: schedule.name, shadowMode: schedule.policy.shadowMode } });
    return schedule;
  }, 10_000);
}

export function getSchedule(controllerHome: string, repoId: string, scheduleId: string): RepositorySchedule {
  const schedule = readJsonFile<RepositorySchedule>(schedulePath(controllerHome, repoId, scheduleId));
  // Hydrate schedules written before requestId/revision became mandatory.
  return {
    ...schedule,
    revision: Number.isFinite(schedule.revision) ? schedule.revision : 1,
    requestId: schedule.requestId || `legacy-schedule:${schedule.scheduleId}`,
    policy: {
      ...schedule.policy,
      backoffBaseMinutes: Math.max(1, schedule.policy.backoffBaseMinutes ?? schedule.policy.cooldownMinutes ?? 1),
      backoffMaxMinutes: Math.max(1, schedule.policy.backoffMaxMinutes ?? 24 * 60),
    },
    consecutiveNoops: Math.max(0, schedule.consecutiveNoops ?? 0),
  };
}

export function saveSchedule(controllerHome: string, schedule: RepositorySchedule): RepositorySchedule {
  return withControllerLock(controllerHome, { scope: 'task', repoId: schedule.repoId, taskId: `schedule-${schedule.scheduleId}` }, `save-schedule:${schedule.scheduleId}`, () => {
    const current = getSchedule(controllerHome, schedule.repoId, schedule.scheduleId);
    const next = { ...schedule, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    writeJsonAtomic(schedulePath(controllerHome, next.repoId, next.scheduleId), next);
    appendRuntimeEvent(controllerHome, { repoId: next.repoId, entityType: 'schedule', entityId: next.scheduleId, eventType: 'schedule_updated', requestId: next.requestId, revision: next.revision, data: { enabled: next.enabled, pausedReason: next.pausedReason } });
    return next;
  }, 10_000);
}

export function listSchedules(controllerHome: string, repoId: string): RepositorySchedule[] {
  const root = join(schedulesRoot(controllerHome, repoId), 'records');
  try {
    return readdirSync(root).filter((name) => name.endsWith('.json'))
      .map((name) => getSchedule(controllerHome, repoId, name.slice(0, -'.json'.length)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch { return []; }
}

export function saveOccurrence(controllerHome: string, occurrence: ScheduleOccurrence): ScheduleOccurrence {
  return withControllerLock(controllerHome, { scope: 'task', repoId: occurrence.repoId, taskId: `schedule-${occurrence.scheduleId}` }, `save-occurrence:${occurrence.occurrenceId}`, () => {
    const existingPath = occurrencePath(controllerHome, occurrence.repoId, occurrence.occurrenceId);
    const previous = existsSync(existingPath) ? readJsonFile<ScheduleOccurrence>(existingPath) : undefined;
    const next = { ...occurrence, revision: (previous?.revision ?? occurrence.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    writeJsonAtomic(existingPath, next);
    upsertOccurrenceIndexUnlocked(controllerHome, next);
    const schedule = getSchedule(controllerHome, next.repoId, next.scheduleId);
    appendRuntimeEvent(controllerHome, { repoId: next.repoId, entityType: 'occurrence', entityId: next.occurrenceId, eventType: `occurrence_${next.status}`, requestId: `${schedule.requestId}:${next.windowKey}`, revision: next.revision, correlationId: next.scheduleId, data: { decision: next.decision, jobId: next.jobId, reason: next.reason } });
    return next;
  }, 10_000);
}

export function getOccurrence(controllerHome: string, repoId: string, occurrenceId: string): ScheduleOccurrence | undefined {
  const path = occurrencePath(controllerHome, repoId, occurrenceId);
  return existsSync(path) ? readJsonFile<ScheduleOccurrence>(path) : undefined;
}

export function listActiveOccurrences(controllerHome: string, repoId: string, scheduleId?: string): ScheduleOccurrence[] {
  const index = readOccurrenceIndex(controllerHome, repoId);
  return index.active
    .filter((entry) => !scheduleId || entry.scheduleId === scheduleId)
    .flatMap((entry) => {
      const occurrence = getOccurrence(controllerHome, repoId, entry.occurrenceId);
      return occurrence ? [occurrence] : [];
    });
}

export function listOccurrences(controllerHome: string, repoId: string, scheduleId?: string, limit = 100): ScheduleOccurrence[] {
  const bounded = Math.max(1, Math.min(limit, 1000));
  const index = readOccurrenceIndex(controllerHome, repoId);
  const indexed = index.recent
    .filter((entry) => !scheduleId || entry.scheduleId === scheduleId)
    .slice(0, bounded)
    .flatMap((entry) => {
      const occurrence = getOccurrence(controllerHome, repoId, entry.occurrenceId);
      return occurrence ? [occurrence] : [];
    });
  if (indexed.length > 0) return indexed;

  const root = join(schedulesRoot(controllerHome, repoId), 'occurrences');
  try {
    const legacy = readdirSync(root).filter((name) => name.endsWith('.json'))
      .map((name) => readJsonFile<ScheduleOccurrence>(join(root, name)))
      .filter((entry) => !scheduleId || entry.scheduleId === scheduleId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, bounded);
    if (legacy.length > 0) {
      withControllerLock(controllerHome, { scope: 'repository', repoId }, `schedule-index-backfill:${repoId}`, () => {
        for (const occurrence of legacy) upsertOccurrenceIndexUnlocked(controllerHome, occurrence);
      }, 10_000);
    }
    return legacy;
  } catch { return []; }
}


export function saveScheduleDecision(controllerHome: string, decision: ScheduleDecision): ScheduleDecision {
  return withControllerLock(controllerHome, { scope: 'task', repoId: decision.repoId, taskId: `schedule-${decision.scheduleId}` }, `save-schedule-decision:${decision.decisionId}`, () => {
    const path = decisionPath(controllerHome, decision.repoId, decision.decisionId);
    if (existsSync(path)) return readJsonFile<ScheduleDecision>(path);
    writeJsonAtomic(path, decision);
    appendRuntimeEvent(controllerHome, {
      repoId: decision.repoId,
      entityType: 'schedule-decision',
      entityId: decision.decisionId,
      eventType: `schedule_decision_${decision.decision}`,
      requestId: decision.requestId,
      revision: decision.revision,
      correlationId: decision.occurrenceId,
      data: { scheduleId: decision.scheduleId, reason: decision.reason, evidence: decision.evidence },
    });
    return decision;
  }, 10_000);
}

export function getScheduleDecision(controllerHome: string, repoId: string, decisionId: string): ScheduleDecision | undefined {
  const path = decisionPath(controllerHome, repoId, decisionId);
  return existsSync(path) ? readJsonFile<ScheduleDecision>(path) : undefined;
}


export interface ScheduleDuplicateMember {
  scheduleId: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  keep: boolean;
  reason: string;
}

export interface ScheduleDuplicateGroup {
  semanticKey: string;
  scheduleIds: string[];
  names: string[];
  enabledCount: number;
  keepScheduleId: string;
  members: ScheduleDuplicateMember[];
  recommendation: string;
}

export interface ScheduleDedupeReport {
  repoId: string;
  generatedAt: string;
  totalSchedules: number;
  duplicateGroups: ScheduleDuplicateGroup[];
  proposedDisableCount: number;
}

export interface ScheduleDedupeApplyResult {
  repoId: string;
  appliedAt: string;
  dryRun: boolean;
  report: ScheduleDedupeReport;
  disabled: Array<{ scheduleId: string; previousEnabled: boolean; pausedReason?: string }>;
}

function scheduleDedupeKey(schedule: RepositorySchedule): string {
  return createHash('sha256').update(JSON.stringify(canonical({
    repoId: schedule.repoId,
    name: schedule.name.trim().toLowerCase(),
    trigger: schedule.trigger,
    policy: schedule.policy,
    action: schedule.action,
    stopConditions: schedule.stopConditions,
  }))).digest('hex');
}

function chooseScheduleToKeep(entries: RepositorySchedule[]): RepositorySchedule {
  const enabled = entries.filter((entry) => entry.enabled);
  const pool = enabled.length > 0 ? enabled : entries;
  return [...pool].sort((left, right) => {
    const triggered = String(right.lastTriggeredAt ?? '').localeCompare(String(left.lastTriggeredAt ?? ''));
    if (triggered !== 0) return triggered;
    return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt);
  })[0]!;
}

function duplicateGroup(semanticKey: string, entries: RepositorySchedule[]): ScheduleDuplicateGroup {
  const keep = chooseScheduleToKeep(entries);
  const members = [...entries]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((entry) => ({
      scheduleId: entry.scheduleId,
      name: entry.name,
      enabled: entry.enabled,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      keep: entry.scheduleId === keep.scheduleId,
      reason: entry.scheduleId === keep.scheduleId
        ? 'newest enabled duplicate selected as canonical schedule'
        : entry.enabled ? 'enabled duplicate should be paused to prevent repeated execution' : 'already disabled duplicate',
    }));
  return {
    semanticKey,
    scheduleIds: entries.map((entry) => entry.scheduleId),
    names: [...new Set(entries.map((entry) => entry.name))],
    enabledCount: entries.filter((entry) => entry.enabled).length,
    keepScheduleId: keep.scheduleId,
    members,
    recommendation: 'Keep one canonical schedule enabled and pause older enabled duplicates with a dedupe reason.',
  };
}

export function buildScheduleDedupeReport(controllerHome: string, repoId: string): ScheduleDedupeReport {
  const schedules = listSchedules(controllerHome, repoId);
  const groups = new Map<string, RepositorySchedule[]>();
  for (const schedule of schedules) {
    const key = scheduleDedupeKey(schedule);
    groups.set(key, [...(groups.get(key) ?? []), schedule]);
  }
  const duplicateGroups = [...groups.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([semanticKey, entries]) => duplicateGroup(semanticKey, entries))
    .sort((left, right) => right.scheduleIds.length - left.scheduleIds.length);
  const proposedDisableCount = duplicateGroups.reduce((sum, group) => sum + group.members.filter((member) => member.enabled && !member.keep).length, 0);
  return { repoId, generatedAt: new Date().toISOString(), totalSchedules: schedules.length, duplicateGroups, proposedDisableCount };
}

export function applyScheduleDedupe(controllerHome: string, repoId: string, input: { dryRun?: unknown; confirmAuthorization?: unknown } = {}): ScheduleDedupeApplyResult {
  const dryRun = input.dryRun === true;
  if (!dryRun && input.confirmAuthorization !== true) throw new Error('SCHEDULE_DEDUPE_AUTHORIZATION_REQUIRED: confirm_authorization must be true to pause duplicate schedules');
  return withControllerLock(controllerHome, { scope: 'task', repoId, taskId: 'schedule-dedupe' }, `schedule-dedupe:${repoId}`, () => {
    const report = buildScheduleDedupeReport(controllerHome, repoId);
    const disabled: ScheduleDedupeApplyResult['disabled'] = [];
    if (!dryRun) {
      for (const group of report.duplicateGroups) {
        for (const member of group.members) {
          if (member.keep || !member.enabled) continue;
          const current = getSchedule(controllerHome, repoId, member.scheduleId);
          const previousEnabled = current.enabled;
          const pausedReason = `duplicate schedule paused by schedule_dedupe_apply; kept ${group.keepScheduleId}`;
          saveSchedule(controllerHome, { ...current, enabled: false, pausedReason });
          disabled.push({ scheduleId: current.scheduleId, previousEnabled, pausedReason });
        }
      }
    }
    return { repoId, appliedAt: new Date().toISOString(), dryRun, report, disabled };
  }, 10_000);
}
