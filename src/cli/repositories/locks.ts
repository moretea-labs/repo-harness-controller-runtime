import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { ensureControllerHome, repositoryControllerRoot } from './controller-home';

export type ControllerLockScope = 'global' | 'repository' | 'task' | 'run' | 'worktree';

export interface ControllerLockKey {
  scope: ControllerLockScope;
  repoId?: string;
  taskId?: string;
  runId?: string;
  worktreeId?: string;
  resource?: string;
}

export interface ControllerLockRecord extends ControllerLockKey {
  lockId: string;
  owner: string;
  pid: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt?: string;
  path: string;
}

const DEFAULT_LOCK_WAIT_MS = 500;
const LOCK_POLL_INTERVAL_MS = 10;
const CORRUPT_LOCK_GRACE_MS = 1_000;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function sleepSync(milliseconds: number): void {
  if (milliseconds > 0) Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, milliseconds);
}

function requireValue(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`LOCK_KEY_INVALID: ${name} is required`);
  return value.trim();
}

export function controllerLockPath(controllerHome: string, key: ControllerLockKey): string {
  const home = ensureControllerHome(controllerHome);
  if (key.scope === 'global') {
    const resource = key.resource?.trim();
    return resource
      ? join(home, 'locks', 'global', `${safe(resource)}.lock.json`)
      : join(home, 'locks', 'controller.lock.json');
  }
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

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

export function readControllerLock(controllerHome: string, key: ControllerLockKey): ControllerLockRecord | undefined {
  const path = controllerLockPath(controllerHome, key);
  try {
    const record = JSON.parse(readFileSync(path, 'utf-8')) as ControllerLockRecord;
    if (isExpired(record) || !isPidAlive(record.pid)) {
      rmSync(path, { force: true });
      return undefined;
    }
    return record;
  } catch (_error) {
    try {
      if (Date.now() - statSync(path).mtimeMs >= CORRUPT_LOCK_GRACE_MS) rmSync(path, { force: true });
    } catch {
      /* a concurrent owner may still be creating or releasing the lock */
    }
    return undefined;
  }
}

function lockHeldError(existing: ControllerLockRecord | undefined, path: string, owner: string): Error {
  if (!existing) return new Error(`LOCK_HELD: ${path}; requestedBy=${owner}`);
  const expiry = existing.expiresAt ? ` expiresAt=${existing.expiresAt}` : '';
  return new Error(
    `LOCK_HELD: ${existing.lockId} by ${existing.owner} pid=${existing.pid} acquiredAt=${existing.acquiredAt}${expiry}; requestedBy=${owner}`,
  );
}

export function acquireControllerLock(
  controllerHome: string,
  key: ControllerLockKey,
  owner: string,
  ttlMs?: number,
  waitMs = DEFAULT_LOCK_WAIT_MS,
): ControllerLockRecord {
  const path = controllerLockPath(controllerHome, key);
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + Math.max(0, waitMs);

  while (true) {
    const existing = readControllerLock(controllerHome, key);
    if (existing) {
      if (existing.pid === process.pid || Date.now() >= deadline) {
        throw lockHeldError(existing, path, owner);
      }
      sleepSync(Math.min(LOCK_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
      continue;
    }

    const acquiredAt = new Date().toISOString();
    const record: ControllerLockRecord = {
      ...key,
      lockId: `${key.scope}:${key.repoId ?? key.resource ?? 'controller'}:${Date.now()}:${process.pid}`,
      owner,
      pid: process.pid,
      acquiredAt,
      heartbeatAt: acquiredAt,
      expiresAt: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined,
      path,
    };
    let fd: number | undefined;
    try {
      fd = openSync(path, 'wx');
      writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
      return record;
    } catch (_error) {
      const current = readControllerLock(controllerHome, key);
      if (current?.pid === process.pid || Date.now() >= deadline) {
        throw lockHeldError(current, path, owner);
      }
      sleepSync(Math.min(LOCK_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
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

export async function withControllerLockAsync<T>(
  controllerHome: string,
  key: ControllerLockKey,
  owner: string,
  operation: () => Promise<T>,
  ttlMs?: number,
): Promise<T> {
  const lock = acquireControllerLock(controllerHome, key, owner, ttlMs);
  try {
    return await operation();
  } finally {
    releaseControllerLock(controllerHome, key, lock.lockId);
  }
}
