/**
 * Fast Path request ledger for mutation idempotency.
 * Atomic create-if-absent before any write; independent of receipt retention.
 */
import { createHash, randomUUID } from 'crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';

export type FastRequestLedgerStatus = 'in_progress' | 'succeeded' | 'failed';

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
  startedAt: string;
  finishedAt?: string;
  resultRef?: string;
  resultSummary?: string;
  error?: string;
  receiptExecutionId?: string;
}

export type LedgerBeginResult =
  | { kind: 'acquired'; entry: FastRequestLedgerEntry }
  | { kind: 'replay'; entry: FastRequestLedgerEntry }
  | { kind: 'in_progress'; entry: FastRequestLedgerEntry }
  | { kind: 'conflict'; entry: FastRequestLedgerEntry; message: string };

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
}): LedgerBeginResult {
  const requestId = input.requestId.trim();
  if (!requestId) {
    throw new Error('REQUEST_ID_REQUIRED: mutation ledger requires non-empty requestId');
  }
  const dir = ledgerDir(input.controllerHome, input.repoId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = entryPath(input.controllerHome, input.repoId, input.checkoutId, requestId);

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
    if (existing.status === 'in_progress') return { kind: 'in_progress', entry: existing };
    // failed: allow re-acquire by overwriting only if we can exclusive-create after delete
    try {
      rmSync(path, { force: true });
    } catch {
      /* race: another writer may recreate */
    }
  }

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
    startedAt: new Date().toISOString(),
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
          entry: entry,
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
      return { kind: 'in_progress', entry: raced };
    }
    throw error;
  }
}

export function completeFastRequest(
  controllerHome: string,
  entry: FastRequestLedgerEntry,
  update: {
    status: 'succeeded' | 'failed';
    resultRef?: string;
    resultSummary?: string;
    error?: string;
    receiptExecutionId?: string;
  },
): FastRequestLedgerEntry {
  const path = entryPath(controllerHome, entry.repoId, entry.checkoutId, entry.requestId);
  const next: FastRequestLedgerEntry = {
    ...entry,
    status: update.status,
    finishedAt: new Date().toISOString(),
    resultRef: update.resultRef,
    resultSummary: update.resultSummary?.slice(0, 2_048),
    error: update.error?.slice(0, 1_024),
    receiptExecutionId: update.receiptExecutionId,
  };
  writeEntryAtomic(path, next);
  return next;
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
