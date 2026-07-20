/**
 * Fast Path request ledger for mutation idempotency.
 * Atomic create-if-absent before any write; independent of receipt retention.
 * Completion is compare-and-set and never throws to mask mutation success.
 */
import { createHash, randomUUID } from 'crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';

export type FastRequestLedgerStatus = 'reserved' | 'executing' | 'succeeded' | 'failed' | 'unknown' | 'in_progress';

export interface FastRequestLedgerEntry {
  schemaVersion: 1;
  entryId: string;
  repoId: string;
  checkoutId: string;
  requestId: string;
  inputHash: string;
  operation: string;
  status: FastRequestLedgerStatus;
  owner: string;
  ownerPid: number;
  startedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  finishedAt?: string;
  resultRef?: string;
  resultSummary?: string;
  error?: string;
  receiptExecutionId?: string;
  baseSnapshot?: string;
}

export type LedgerBeginResult =
  | { kind: 'acquired'; entry: FastRequestLedgerEntry }
  | { kind: 'replay'; entry: FastRequestLedgerEntry }
  | { kind: 'in_progress'; entry: FastRequestLedgerEntry }
  | { kind: 'conflict'; entry: FastRequestLedgerEntry; message: string }
  | { kind: 'unknown'; entry: FastRequestLedgerEntry; message: string };

export interface LedgerCompleteResult {
  ok: boolean;
  entry?: FastRequestLedgerEntry;
  warning?: string;
  code?: 'LEDGER_STALE_OWNER' | 'LEDGER_WRITE_FAILED' | 'LEDGER_MISSING';
}

const DEFAULT_LEDGER_TTL_MS = 15 * 60_000;

function ledgerDir(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'fast-request-ledger');
}

function entryFileName(checkoutId: string, requestId: string): string {
  const key = createHash('sha256')
    .update(`${checkoutId}\0${requestId}`)
    .digest('hex')
    .slice(0, 40);
  return `${key}.json`;
}

function entryPath(controllerHome: string, repoId: string, checkoutId: string, requestId: string): string {
  return join(ledgerDir(controllerHome, repoId), entryFileName(checkoutId, requestId));
}

function readEntry(path: string): FastRequestLedgerEntry | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FastRequestLedgerEntry;
  } catch {
    return undefined;
  }
}

function writeEntryAtomic(path: string, entry: FastRequestLedgerEntry): void {
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function isActiveInProgress(entry: FastRequestLedgerEntry): boolean {
  if (entry.status !== 'in_progress' && entry.status !== 'reserved' && entry.status !== 'executing') {
    return false;
  }
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) return false;
  return true;
}

/**
 * Atomically claim a requestId for mutation work.
 * Uses O_EXCL create so concurrent callers cannot both acquire.
 */
export function beginFastRequest(input: {
  controllerHome: string;
  repoId: string;
  checkoutId: string;
  requestId: string;
  inputHash: string;
  operation: string;
  owner: string;
  ttlMs?: number;
}): LedgerBeginResult {
  const requestId = input.requestId.trim();
  if (!requestId) {
    throw new Error('REQUEST_ID_REQUIRED: mutation ledger requires non-empty requestId');
  }
  const dir = ledgerDir(input.controllerHome, input.repoId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = entryPath(input.controllerHome, input.repoId, input.checkoutId, requestId);
  const ttlMs = Math.max(30_000, input.ttlMs ?? DEFAULT_LEDGER_TTL_MS);

  const existing = readEntry(path);
  if (existing) {
    if (existing.checkoutId !== input.checkoutId) {
      return {
        kind: 'conflict',
        entry: existing,
        message: `IDEMPOTENCY_CONFLICT: requestId bound to checkout ${existing.checkoutId}, not ${input.checkoutId}`,
      };
    }
    if (existing.inputHash !== input.inputHash) {
      return {
        kind: 'conflict',
        entry: existing,
        message: `IDEMPOTENCY_CONFLICT: requestId ${requestId} reused with different inputHash`,
      };
    }
    if (existing.status === 'succeeded') return { kind: 'replay', entry: existing };
    if (existing.status === 'unknown') {
      return {
        kind: 'unknown',
        entry: existing,
        message: 'LEDGER_UNKNOWN: prior request outcome is unknown; reconcile before retry',
      };
    }
    if (isActiveInProgress(existing)) {
      return { kind: 'in_progress', entry: existing };
    }
    // Stale in_progress / failed / expired: do not auto-delete if we cannot prove no mutation.
    // Mark unknown if status was in_progress and expired (crash window).
    if (existing.status === 'in_progress' || existing.status === 'reserved' || existing.status === 'executing') {
      const unknown: FastRequestLedgerEntry = {
        ...existing,
        status: 'unknown',
        finishedAt: new Date().toISOString(),
        error: 'stale_in_progress_expired_requires_reconcile',
      };
      try {
        writeEntryAtomic(path, unknown);
      } catch {
        /* best effort */
      }
      return {
        kind: 'unknown',
        entry: unknown,
        message: 'LEDGER_STALE: prior request left in_progress after expiry; reconcile required',
      };
    }
    // failed: allow re-acquire
    try {
      rmSync(path, { force: true });
    } catch {
      /* race */
    }
  }

  const now = new Date().toISOString();
  const entry: FastRequestLedgerEntry = {
    schemaVersion: 1,
    entryId: `frl_${Date.now()}_${randomUUID().slice(0, 8)}`,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    requestId,
    inputHash: input.inputHash,
    operation: input.operation,
    status: 'in_progress',
    owner: input.owner,
    ownerPid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };

  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    } finally {
      closeSync(fd);
    }
    return { kind: 'acquired', entry };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      const raced = readEntry(path);
      if (!raced) {
        return {
          kind: 'conflict',
          entry,
          message: 'IDEMPOTENCY_CONFLICT: concurrent create race',
        };
      }
      if (raced.inputHash !== input.inputHash || raced.checkoutId !== input.checkoutId) {
        return {
          kind: 'conflict',
          entry: raced,
          message: `IDEMPOTENCY_CONFLICT: requestId ${requestId} conflict after race`,
        };
      }
      if (raced.status === 'succeeded') return { kind: 'replay', entry: raced };
      if (raced.status === 'unknown') {
        return {
          kind: 'unknown',
          entry: raced,
          message: 'LEDGER_UNKNOWN: prior request outcome is unknown',
        };
      }
      return { kind: 'in_progress', entry: raced };
    }
    throw error;
  }
}

/**
 * Compare-and-set completion. Never throws — returns structured result so callers
 * can isolate ledger failures from mutation success.
 */
export function completeFastRequest(
  controllerHome: string,
  expected: FastRequestLedgerEntry,
  update: {
    status: 'succeeded' | 'failed' | 'unknown';
    resultRef?: string;
    resultSummary?: string;
    error?: string;
    receiptExecutionId?: string;
  },
): LedgerCompleteResult {
  try {
    const path = entryPath(controllerHome, expected.repoId, expected.checkoutId, expected.requestId);
    const current = readEntry(path);
    if (!current) {
      return { ok: false, code: 'LEDGER_MISSING', warning: 'ledger entry missing at completion' };
    }
    if (
      current.entryId !== expected.entryId
      || current.owner !== expected.owner
      || current.inputHash !== expected.inputHash
    ) {
      return {
        ok: false,
        code: 'LEDGER_STALE_OWNER',
        entry: current,
        warning: 'LEDGER_STALE_OWNER: current entry does not match expected owner/entryId/inputHash',
      };
    }
    if (current.status !== 'in_progress' && current.status !== 'reserved' && current.status !== 'executing') {
      // Already terminal — do not overwrite succeeded with failed from late caller.
      if (current.status === 'succeeded' && update.status !== 'succeeded') {
        return {
          ok: false,
          code: 'LEDGER_STALE_OWNER',
          entry: current,
          warning: 'LEDGER_STALE_OWNER: refusing to overwrite terminal succeeded entry',
        };
      }
      return { ok: true, entry: current };
    }

    const next: FastRequestLedgerEntry = {
      ...current,
      status: update.status,
      finishedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      resultRef: update.resultRef,
      resultSummary: update.resultSummary?.slice(0, 2_048),
      error: update.error?.slice(0, 1_024),
      receiptExecutionId: update.receiptExecutionId,
    };
    writeEntryAtomic(path, next);
    return { ok: true, entry: next };
  } catch (error) {
    return {
      ok: false,
      code: 'LEDGER_WRITE_FAILED',
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

export function readFastRequest(
  controllerHome: string,
  repoId: string,
  checkoutId: string,
  requestId: string,
): FastRequestLedgerEntry | undefined {
  return readEntry(entryPath(controllerHome, repoId, checkoutId, requestId));
}

export function listFastRequests(controllerHome: string, repoId: string, limit = 50): FastRequestLedgerEntry[] {
  const dir = ledgerDir(controllerHome, repoId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readEntry(join(dir, name)))
    .filter((entry): entry is FastRequestLedgerEntry => Boolean(entry))
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
    .slice(0, Math.max(1, Math.min(limit, 200)));
}
