import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { createSchedule, getSchedule, saveSchedule } from '../workflow/schedules/store';
import type { ScheduleTrigger } from '../workflow/schedules/types';
import { getAssistantRoutine, updateAssistantRoutineStatus } from './store';
import type { AssistantRoutine, AssistantRoutineStatus } from './types';

export interface AssistantRoutineScheduleBinding {
  schemaVersion: 1;
  routineId: string;
  scheduleId: string;
  repoId: string;
  timezone: string;
  normalizedSchedule: string;
  createdAt: string;
  updatedAt: string;
}

interface BindingStore {
  schemaVersion: 1;
  updatedAt: string;
  bindings: AssistantRoutineScheduleBinding[];
}

function now(): string { return new Date().toISOString(); }
function bindingPath(repoRoot: string): string { return join(repoRoot, '.repo-harness', 'assistant', 'routine-schedules.json'); }

function readBindings(repoRoot: string): BindingStore {
  const path = bindingPath(repoRoot);
  if (!existsSync(path)) return { schemaVersion: 1, updatedAt: now(), bindings: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<BindingStore>;
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now(),
      bindings: Array.isArray(parsed.bindings)
        ? parsed.bindings.filter((entry): entry is AssistantRoutineScheduleBinding => Boolean(
            entry && typeof entry === 'object'
            && typeof entry.routineId === 'string'
            && typeof entry.scheduleId === 'string'
            && typeof entry.repoId === 'string',
          ))
        : [],
    };
  } catch {
    return { schemaVersion: 1, updatedAt: now(), bindings: [] };
  }
}

function writeBindings(repoRoot: string, store: BindingStore): void {
  const path = bindingPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...store, schemaVersion: 1, updatedAt: now() }, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

const WEEKDAYS: Array<[RegExp, number]> = [
  [/(?:周|星期)(?:日|天)|sunday/i, 0],
  [/(?:周|星期)一|monday/i, 1],
  [/(?:周|星期)二|tuesday/i, 2],
  [/(?:周|星期)三|wednesday/i, 3],
  [/(?:周|星期)四|thursday/i, 4],
  [/(?:周|星期)五|friday/i, 5],
  [/(?:周|星期)六|saturday/i, 6],
];

export function parseAssistantScheduleText(
  scheduleText: string,
  timezone = 'UTC',
): { trigger: ScheduleTrigger; normalized: string; timezone: string } {
  const text = scheduleText.trim();
  const time = text.match(/(?:^|\D)([01]?\d|2[0-3])(?:\s*[:点时]\s*([0-5]?\d))?/);
  const hour = time ? Number(time[1]) : 9;
  const minute = time?.[2] ? Number(time[2]) : 0;
  const weekday = WEEKDAYS.find(([pattern]) => pattern.test(text))?.[1];
  const cronExpression = `${minute} ${hour} * * ${weekday ?? '*'}`;
  const normalized = `${weekday === undefined ? 'daily' : `weekly:${weekday}`} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${timezone}`;
  return {
    trigger: {
      type: 'cron',
      cronExpression,
      timezone,
      catchUpMinutes: 12 * 60,
    },
    normalized,
    timezone,
  };
}

export function getAssistantRoutineScheduleBinding(
  repoRoot: string,
  routineId: string,
): AssistantRoutineScheduleBinding | undefined {
  return readBindings(repoRoot).bindings.find((entry) => entry.routineId === routineId);
}

export function bindAssistantRoutineSchedule(
  controllerHome: string,
  repository: RepositoryRecord,
  routine: AssistantRoutine,
): AssistantRoutineScheduleBinding {
  const existing = getAssistantRoutineScheduleBinding(repository.canonicalRoot, routine.routineId);
  if (existing) return existing;
  const parsed = parseAssistantScheduleText(routine.scheduleText, routine.timezone || 'UTC');
  const schedule = createSchedule(controllerHome, {
    requestId: `assistant-routine:${repository.repoId}:${routine.routineId}`,
    repoId: repository.repoId,
    name: `Assistant Routine: ${routine.name}`,
    enabled: routine.status === 'enabled',
    trigger: parsed.trigger,
    policy: {
      maxActiveOccurrences: 1,
      maxFailures: 5,
      cooldownMinutes: 1,
      dailyBudgetMinutes: 30,
      shadowMode: false,
      backoffBaseMinutes: 5,
      backoffMaxMinutes: 12 * 60,
    },
    action: {
      operation: 'assistant_routine_execute',
      target: 'runtime',
      arguments: { routineId: routine.routineId },
      priority: 'P3',
      resourceClaims: [{ resourceKey: `assistant-routine:${repository.repoId}:${routine.routineId}`, mode: 'exclusive' }],
    },
    stopConditions: ['external_blocker'],
  });
  const at = now();
  const binding: AssistantRoutineScheduleBinding = {
    schemaVersion: 1,
    routineId: routine.routineId,
    scheduleId: schedule.scheduleId,
    repoId: repository.repoId,
    timezone: parsed.timezone,
    normalizedSchedule: parsed.normalized,
    createdAt: at,
    updatedAt: at,
  };
  const store = readBindings(repository.canonicalRoot);
  store.bindings.unshift(binding);
  writeBindings(repository.canonicalRoot, store);
  return binding;
}

export function updateAssistantRoutineLifecycle(
  controllerHome: string,
  repository: RepositoryRecord,
  routineId: string,
  status: AssistantRoutineStatus,
): { routine: AssistantRoutine; binding?: AssistantRoutineScheduleBinding } {
  const routine = updateAssistantRoutineStatus(repository.canonicalRoot, routineId, status);
  let binding = getAssistantRoutineScheduleBinding(repository.canonicalRoot, routineId);
  if (!binding && status === 'enabled') binding = bindAssistantRoutineSchedule(controllerHome, repository, routine);
  if (binding) {
    const schedule = getSchedule(controllerHome, repository.repoId, binding.scheduleId);
    const enabled = status === 'enabled';
    saveSchedule(controllerHome, {
      ...schedule,
      enabled,
      pausedReason: enabled ? undefined : `Assistant Routine ${status}: ${routineId}`,
    });
    binding = { ...binding, updatedAt: now() };
    const store = readBindings(repository.canonicalRoot);
    store.bindings = [binding, ...store.bindings.filter((entry) => entry.routineId !== routineId)];
    writeBindings(repository.canonicalRoot, store);
  }
  return { routine: getAssistantRoutine(repository.canonicalRoot, routineId), binding };
}
