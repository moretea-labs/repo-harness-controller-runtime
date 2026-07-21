/**
 * Durable Managed Process records under controller-home repositories.
 * Layout: repositories/<repoId>/processes/<processId>.json
 * Index: repositories/<repoId>/processes/active-index.json
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { ensureRepositoryControllerLayout, repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import type { ManagedProcessRecord, ProcessRuntimeStatus } from './types';

const ACTIVE_STATUSES = new Set<ProcessRuntimeStatus>(['starting', 'running', 'running_recovered']);

function processesRoot(controllerHome: string, repoId: string): string {
  const root = ensureRepositoryControllerLayout(controllerHome, repoId);
  const dir = join(root, 'processes');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function processPath(controllerHome: string, repoId: string, processId: string): string {
  return join(processesRoot(controllerHome, repoId), `${processId}.json`);
}

function indexPath(controllerHome: string, repoId: string): string {
  return join(processesRoot(controllerHome, repoId), 'active-index.json');
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function rebuildActiveIndex(controllerHome: string, repoId: string): string[] {
  const root = processesRoot(controllerHome, repoId);
  const active: string[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith('.json') || entry === 'active-index.json') continue;
    const record = readJson<ManagedProcessRecord>(join(root, entry));
    if (record && ACTIVE_STATUSES.has(record.status)) active.push(record.processId);
  }
  active.sort();
  atomicWrite(indexPath(controllerHome, repoId), {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    processIds: active,
  });
  return active;
}

export function processLogDir(controllerHome: string, repoId: string): string {
  return join(processesRoot(controllerHome, repoId), 'logs');
}

export function createProcessRecord(record: ManagedProcessRecord): ManagedProcessRecord {
  const path = processPath(record.controllerHome, record.repoId, record.processId);
  if (existsSync(path)) {
    throw new Error(`PROCESS_ALREADY_EXISTS: ${record.processId}`);
  }
  atomicWrite(path, record);
  rebuildActiveIndex(record.controllerHome, record.repoId);
  return record;
}

export function getProcessRecord(
  controllerHome: string,
  repoId: string,
  processId: string,
): ManagedProcessRecord | undefined {
  const record = readJson<ManagedProcessRecord>(processPath(controllerHome, repoId, processId));
  if (!record || record.schemaVersion !== 1) return undefined;
  return record;
}

/**
 * CAS-style terminal write: only succeeds when terminalFenceToken matches and
 * terminalWritten is not already true. Prevents dual-monitor completion races.
 */
export function tryCompleteProcessRecord(
  controllerHome: string,
  repoId: string,
  processId: string,
  fenceToken: number,
  patch: Partial<ManagedProcessRecord> & {
    status: ProcessRuntimeStatus;
  },
): { ok: boolean; record?: ManagedProcessRecord; reason?: string } {
  const path = processPath(controllerHome, repoId, processId);
  const current = readJson<ManagedProcessRecord>(path);
  if (!current) return { ok: false, reason: 'missing' };
  if (current.terminalWritten) return { ok: false, reason: 'already_terminal', record: current };
  if (current.terminalFenceToken !== fenceToken) {
    return { ok: false, reason: 'fence_mismatch', record: current };
  }
  const next: ManagedProcessRecord = {
    ...current,
    ...patch,
    terminalWritten: true,
    finishedAt: patch.finishedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  atomicWrite(path, next);
  rebuildActiveIndex(controllerHome, repoId);
  return { ok: true, record: next };
}

export function updateProcessRecord(
  controllerHome: string,
  repoId: string,
  processId: string,
  patch: Partial<ManagedProcessRecord>,
  options: { requireFence?: number; allowTerminal?: boolean } = {},
): ManagedProcessRecord | undefined {
  const path = processPath(controllerHome, repoId, processId);
  const current = readJson<ManagedProcessRecord>(path);
  if (!current) return undefined;
  if (current.terminalWritten && !options.allowTerminal) return current;
  if (options.requireFence !== undefined && current.terminalFenceToken !== options.requireFence) {
    return current;
  }
  const next: ManagedProcessRecord = {
    ...current,
    ...patch,
    // Never allow patch to clear terminal fencing once set.
    terminalFenceToken: current.terminalFenceToken,
    terminalWritten: current.terminalWritten || patch.terminalWritten === true,
    updatedAt: new Date().toISOString(),
  };
  atomicWrite(path, next);
  if (ACTIVE_STATUSES.has(current.status) !== ACTIVE_STATUSES.has(next.status)) {
    rebuildActiveIndex(controllerHome, repoId);
  }
  return next;
}

export function listActiveProcessIds(controllerHome: string, repoId: string): string[] {
  const index = readJson<{ processIds?: string[] }>(indexPath(controllerHome, repoId));
  if (Array.isArray(index?.processIds)) return index.processIds;
  return rebuildActiveIndex(controllerHome, repoId);
}

export function listProcessRecords(
  controllerHome: string,
  repoId: string,
  limit = 100,
): ManagedProcessRecord[] {
  const root = processesRoot(controllerHome, repoId);
  if (!existsSync(root)) return [];
  const records: ManagedProcessRecord[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith('.json') || entry === 'active-index.json') continue;
    const record = readJson<ManagedProcessRecord>(join(root, entry));
    if (record?.schemaVersion === 1) records.push(record);
  }
  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return records.slice(0, Math.max(1, limit));
}

export function deleteProcessRecord(
  controllerHome: string,
  repoId: string,
  processId: string,
): boolean {
  const path = processPath(controllerHome, repoId, processId);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  rebuildActiveIndex(controllerHome, repoId);
  return true;
}

export function repositoryProcessesRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'processes');
}
