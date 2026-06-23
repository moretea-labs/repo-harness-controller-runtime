import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { ensureControllerHome, repositoryControllerRoot } from './controller-home';

export type ControllerLockScope = 'global' | 'repository' | 'task' | 'run' | 'worktree';

export interface ControllerLockKey {
  scope: ControllerLockScope;
  repoId?: string;
  taskId?: string;
  runId?: string;
  worktreeId?: string;
}

export interface ControllerLockRecord extends ControllerLockKey {
  lockId: string;
  owner: string;
  pid: number;
  acquiredAt: string;
  expiresAt?: string;
  path: string;
}

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function requireValue(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`LOCK_KEY_INVALID: ${name} is required`);
  return value.trim();
}

export function controllerLockPath(controllerHome: string, key: ControllerLockKey): string {
  const home = ensureControllerHome(controllerHome);
  if (key.scope === 'global') return join(home, 'locks', 'controller.lock.json');
  const repoId = safe(requireValue(key.repoId, 'repoId'));
  const base = join(repositoryControllerRoot(home, repoId), 'locks');
  if (key.scope === 'repository') return join(base, 'repository.lock.json');
  if (key.scope === 'task') return join(base, 'tasks', `${safe(requireValue(key.taskId, 'taskId'))}.lock.json`);
  if (key.scope === 'run') return join(base, 'runs', `${safe(requireValue(key.runId, 'runId'))}.lock.json`);
  return join(base, 'worktrees', `${safe(requireValue(key.worktreeId, 'worktreeId'))}.lock.json`);
}

function isExpired(record: ControllerLockRecord): boolean {
  return Boolean(record.expiresAt && Date.parse(record.expiresAt) <= Date.now());
}

export function readControllerLock(controllerHome: string, key: ControllerLockKey): ControllerLockRecord | undefined {
  const path = controllerLockPath(controllerHome, key);
  try {
    const record = JSON.parse(readFileSync(path, 'utf-8')) as ControllerLockRecord;
    if (isExpired(record)) {
      rmSync(path, { force: true });
      return undefined;
    }
    return record;
  } catch (_error) {
    return undefined;
  }
}

export function acquireControllerLock(
  controllerHome: string,
  key: ControllerLockKey,
  owner: string,
  ttlMs?: number,
): ControllerLockRecord {
  const path = controllerLockPath(controllerHome, key);
  mkdirSync(dirname(path), { recursive: true });
  const existing = readControllerLock(controllerHome, key);
  if (existing) throw new Error(`LOCK_HELD: ${existing.lockId} by ${existing.owner}`);
  const acquiredAt = new Date().toISOString();
  const record: ControllerLockRecord = {
    ...key,
    lockId: `${key.scope}:${key.repoId ?? 'controller'}:${Date.now()}:${process.pid}`,
    owner,
    pid: process.pid,
    acquiredAt,
    expiresAt: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined,
    path,
  };
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx');
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  } catch (error) {
    const current = readControllerLock(controllerHome, key);
    throw new Error(`LOCK_HELD: ${current?.lockId ?? path}; ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return record;
}

export function releaseControllerLock(controllerHome: string, key: ControllerLockKey, lockId?: string): void {
  const current = readControllerLock(controllerHome, key);
  if (!current) return;
  if (lockId && current.lockId !== lockId) throw new Error(`LOCK_OWNERSHIP_MISMATCH: ${current.lockId}`);
  rmSync(controllerLockPath(controllerHome, key), { force: true });
}

export function withControllerLock<T>(
  controllerHome: string,
  key: ControllerLockKey,
  owner: string,
  operation: () => T,
  ttlMs?: number,
): T {
  const lock = acquireControllerLock(controllerHome, key, owner, ttlMs);
  try {
    return operation();
  } finally {
    releaseControllerLock(controllerHome, key, lock.lockId);
  }
}
