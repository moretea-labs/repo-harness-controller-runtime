import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type {
  AssistantInboxItem,
  AssistantInboxStore,
  AssistantMemoryEntry,
  AssistantMemoryStore,
  AssistantRoutine,
  AssistantRoutineDraft,
  AssistantRoutineStatus,
  AssistantRoutinesStore,
} from './types';

function now(): string { return new Date().toISOString(); }
function assistantRoot(repoRoot: string): string { return join(repoRoot, '.repo-harness', 'assistant'); }
function routinesPath(repoRoot: string): string { return join(assistantRoot(repoRoot), 'routines.json'); }
function inboxPath(repoRoot: string): string { return join(assistantRoot(repoRoot), 'inbox.json'); }
function memoryPath(repoRoot: string): string { return join(assistantRoot(repoRoot), 'memory.json'); }
function safeId(prefix: string): string { return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`; }

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T; } catch { return fallback; }
}

function normalizeStrings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map((entry) => String(entry).trim()).filter(Boolean))] : [];
}

function normalizeRoutine(value: unknown): AssistantRoutine | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const routineId = typeof raw.routineId === 'string' && raw.routineId.trim() ? raw.routineId.trim() : undefined;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined;
  const naturalLanguageGoal = typeof raw.naturalLanguageGoal === 'string' && raw.naturalLanguageGoal.trim() ? raw.naturalLanguageGoal.trim() : undefined;
  const scheduleText = typeof raw.scheduleText === 'string' && raw.scheduleText.trim() ? raw.scheduleText.trim() : undefined;
  if (!routineId || !name || !naturalLanguageGoal || !scheduleText) return undefined;
  const status = raw.status === 'paused' || raw.status === 'deleted' ? raw.status : 'enabled';
  const output = raw.output === 'gmail_draft' || raw.output === 'none' ? raw.output : 'assistant_inbox';
  return {
    schemaVersion: 1,
    routineId,
    name,
    naturalLanguageGoal,
    scheduleText,
    timezone: typeof raw.timezone === 'string' ? raw.timezone : undefined,
    dataSources: normalizeStrings(raw.dataSources),
    output,
    allowedActions: normalizeStrings(raw.allowedActions),
    forbiddenActions: normalizeStrings(raw.forbiddenActions),
    status,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now(),
    lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : undefined,
    nextRunHint: typeof raw.nextRunHint === 'string' ? raw.nextRunHint : undefined,
  };
}

function normalizeInboxItem(value: unknown): AssistantInboxItem | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const itemId = typeof raw.itemId === 'string' && raw.itemId.trim() ? raw.itemId.trim() : undefined;
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined;
  const summary = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : undefined;
  if (!itemId || !title || !summary) return undefined;
  const kind = raw.kind === 'routine_result' || raw.kind === 'approval_request' || raw.kind === 'system_note' ? raw.kind : 'intent_result';
  const status = raw.status === 'read' || raw.status === 'archived' ? raw.status : 'unread';
  return {
    schemaVersion: 1,
    itemId,
    kind,
    status,
    title,
    summary,
    body: typeof raw.body === 'string' ? raw.body : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now(),
    source: raw.source === 'chatgpt' || raw.source === 'mcp' || raw.source === 'local-ui' || raw.source === 'mobile' || raw.source === 'routine' ? raw.source : 'system',
    relatedRoutineId: typeof raw.relatedRoutineId === 'string' ? raw.relatedRoutineId : undefined,
    relatedRequestId: typeof raw.relatedRequestId === 'string' ? raw.relatedRequestId : undefined,
    jobIds: normalizeStrings(raw.jobIds),
    recommendations: normalizeStrings(raw.recommendations),
    data: raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data as Record<string, unknown> : undefined,
  };
}

function readRoutines(repoRoot: string): AssistantRoutinesStore {
  const parsed = readJson<Partial<AssistantRoutinesStore>>(routinesPath(repoRoot), { schemaVersion: 1, updatedAt: now(), routines: [] });
  return {
    schemaVersion: 1,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now(),
    routines: Array.isArray(parsed.routines) ? parsed.routines.flatMap((entry) => normalizeRoutine(entry) ?? []) : [],
  };
}

function writeRoutines(repoRoot: string, store: AssistantRoutinesStore): AssistantRoutinesStore {
  const next = { schemaVersion: 1 as const, updatedAt: now(), routines: store.routines };
  writeJson(routinesPath(repoRoot), next);
  return next;
}

function readInbox(repoRoot: string): AssistantInboxStore {
  const parsed = readJson<Partial<AssistantInboxStore>>(inboxPath(repoRoot), { schemaVersion: 1, updatedAt: now(), items: [] });
  return {
    schemaVersion: 1,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now(),
    items: Array.isArray(parsed.items) ? parsed.items.flatMap((entry) => normalizeInboxItem(entry) ?? []) : [],
  };
}

function writeInbox(repoRoot: string, store: AssistantInboxStore): AssistantInboxStore {
  const next = { schemaVersion: 1 as const, updatedAt: now(), items: store.items.slice(0, 500) };
  writeJson(inboxPath(repoRoot), next);
  return next;
}

export function listAssistantRoutines(repoRoot: string, includeDeleted = false): { routines: AssistantRoutine[] } {
  const store = readRoutines(repoRoot);
  return { routines: store.routines.filter((routine) => includeDeleted || routine.status !== 'deleted').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
}

export function createAssistantRoutine(repoRoot: string, draft: AssistantRoutineDraft): AssistantRoutine {
  const store = readRoutines(repoRoot);
  const at = now();
  const routine: AssistantRoutine = {
    schemaVersion: 1,
    routineId: safeId('routine'),
    name: draft.name,
    naturalLanguageGoal: draft.naturalLanguageGoal,
    scheduleText: draft.scheduleText,
    timezone: draft.timezone,
    dataSources: [...new Set(draft.dataSources)],
    output: draft.output,
    allowedActions: [...new Set(draft.allowedActions)],
    forbiddenActions: [...new Set(draft.forbiddenActions)],
    status: 'enabled',
    createdAt: at,
    updatedAt: at,
    nextRunHint: draft.scheduleText,
  };
  store.routines.unshift(routine);
  writeRoutines(repoRoot, store);
  return routine;
}

export function updateAssistantRoutineStatus(repoRoot: string, routineId: string, status: AssistantRoutineStatus): AssistantRoutine {
  const store = readRoutines(repoRoot);
  const routine = store.routines.find((entry) => entry.routineId === routineId);
  if (!routine) throw new Error(`ASSISTANT_ROUTINE_NOT_FOUND: ${routineId}`);
  routine.status = status;
  routine.updatedAt = now();
  writeRoutines(repoRoot, store);
  return routine;
}

export function touchAssistantRoutineRun(repoRoot: string, routineId: string): AssistantRoutine {
  const store = readRoutines(repoRoot);
  const routine = store.routines.find((entry) => entry.routineId === routineId && entry.status !== 'deleted');
  if (!routine) throw new Error(`ASSISTANT_ROUTINE_NOT_FOUND: ${routineId}`);
  routine.lastRunAt = now();
  routine.updatedAt = routine.lastRunAt;
  writeRoutines(repoRoot, store);
  return routine;
}

export function getAssistantRoutine(repoRoot: string, routineId: string): AssistantRoutine {
  const routine = readRoutines(repoRoot).routines.find((entry) => entry.routineId === routineId && entry.status !== 'deleted');
  if (!routine) throw new Error(`ASSISTANT_ROUTINE_NOT_FOUND: ${routineId}`);
  return routine;
}

export function listAssistantInbox(repoRoot: string, limit = 50): { items: AssistantInboxItem[] } {
  const store = readInbox(repoRoot);
  return { items: store.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, Math.min(limit, 200))) };
}

export function addAssistantInboxItem(repoRoot: string, input: Omit<AssistantInboxItem, 'schemaVersion' | 'itemId' | 'createdAt' | 'updatedAt' | 'status'> & { status?: AssistantInboxItem['status'] }): AssistantInboxItem {
  const store = readInbox(repoRoot);
  const at = now();
  const item: AssistantInboxItem = {
    schemaVersion: 1,
    itemId: safeId('inbox'),
    createdAt: at,
    updatedAt: at,
    status: input.status ?? 'unread',
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    body: input.body,
    source: input.source,
    relatedRoutineId: input.relatedRoutineId,
    relatedRequestId: input.relatedRequestId,
    jobIds: input.jobIds,
    recommendations: input.recommendations,
    data: input.data,
  };
  store.items.unshift(item);
  writeInbox(repoRoot, store);
  return item;
}

export function updateAssistantInboxStatus(repoRoot: string, itemId: string, status: AssistantInboxItem['status']): AssistantInboxItem {
  const store = readInbox(repoRoot);
  const item = store.items.find((entry) => entry.itemId === itemId);
  if (!item) throw new Error(`ASSISTANT_INBOX_ITEM_NOT_FOUND: ${itemId}`);
  item.status = status;
  item.updatedAt = now();
  writeInbox(repoRoot, store);
  return item;
}

export function listAssistantMemory(repoRoot: string): { entries: AssistantMemoryEntry[] } {
  const parsed = readJson<Partial<AssistantMemoryStore>>(memoryPath(repoRoot), { schemaVersion: 1, updatedAt: now(), entries: [] });
  const entries = Array.isArray(parsed.entries)
    ? parsed.entries.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const raw = entry as unknown as Record<string, unknown>;
      const key = typeof raw.key === 'string' && raw.key.trim() ? raw.key.trim() : undefined;
      const value = typeof raw.value === 'string' && raw.value.trim() ? raw.value.trim() : undefined;
      if (!key || !value) return [];
      return [{ key, value, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now(), source: typeof raw.source === 'string' ? raw.source : undefined }];
    })
    : [];
  return { entries };
}

export function upsertAssistantMemory(repoRoot: string, entry: { key: string; value: string; source?: string }): AssistantMemoryEntry {
  const current = listAssistantMemory(repoRoot).entries;
  const at = now();
  const normalized: AssistantMemoryEntry = { key: entry.key.trim(), value: entry.value.trim(), source: entry.source, updatedAt: at };
  if (!normalized.key || !normalized.value) throw new Error('ASSISTANT_MEMORY_INVALID: key and value are required');
  const next = [normalized, ...current.filter((item) => item.key !== normalized.key)];
  writeJson(memoryPath(repoRoot), { schemaVersion: 1, updatedAt: at, entries: next } satisfies AssistantMemoryStore);
  return normalized;
}
