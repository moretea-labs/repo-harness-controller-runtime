/**
 * Fast Path request ledger for mutation idempotency + crash recovery.
 * Atomic create-if-absent before any write; CAS completion; stale reconcile.
 * Ledger write failure must never mask an already-successful mutation.
 */
import { createHash, randomUUID } from 'crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { withControllerLock } from '../../../cli/repositories/locks';

export type FastRequestLedgerStatus =
  | 'reserved'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  /** @deprecated alias of reserved/executing for older readers */
  | 'in_progress';

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
  ownerSessionId?: string;
  startedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  finishedAt?: string;
  resultRef?: string;
  resultSummary?: string;
  error?: string;
  receiptExecutionId?: string;
  baseSnapshot?: string;
  resultSnapshot?: string;
  reconcileNotes?: string;
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
  code?: 'LEDGER_STALE_OWNER' | 'LEDGER_WRITE_FAILED' | 'LEDGER_MISSING' | 'LEDGER_CAS_FAILED';
}

export type LedgerReconcileVerdict =
  | 'succeeded'
  | 'not_started'
  | 'unknown';

export interface LedgerReconcileResult {
  entry: FastRequestLedgerEntry;
  verdict: LedgerReconcileVerdict;
  notes: string;
  autoRetriable: boolean;
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

function withLedgerLock<T>(
  controllerHome: string,
  repoId: string,
  owner: string,
  operation: () => T,
): T {
  return withControllerLock(
    controllerHome,
    { scope: 'global', resource: `fast-request-ledger-${repoId}` },
    `fast-request-ledger:${owner}`,
    operation,
    10_000,
  );
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

function isActiveStatus(status: FastRequestLedgerStatus): boolean {
  return status === 'in_progress' || status === 'reserved' || status === 'executing';
}

function isActiveInProgress(entry: FastRequestLedgerEntry): boolean {
  if (!isActiveStatus(entry.status)) return false;
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) return false;
  // Owner process dead + heartbeat stale → not active (caller should reconcile).
  if (entry.ownerPid && entry.ownerPid !== process.pid) {
    try {
      process.kill(entry.ownerPid, 0);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Atomically claim a requestId for mutation work (status=reserved then mark executing).
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
  ownerSessionId?: string;
  ttlMs?: number;
  baseSnapshot?: string;
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
    // Stale reserved/executing/in_progress: mark unknown — never auto-delete if mutation may have run.
    if (isActiveStatus(existing.status)) {
      const unknown: FastRequestLedgerEntry = {
        ...existing,
        status: 'unknown',
        finishedAt: new Date().toISOString(),
        error: 'stale_in_progress_expired_requires_reconcile',
        reconcileNotes: 'auto-marked unknown on re-begin of expired/stale active entry',
      };
      try {
        writeEntryAtomic(path, unknown);
      } catch {
        /* best effort */
      }
      return {
        kind: 'unknown',
        entry: unknown,
        message: 'LEDGER_STALE: prior request left active after expiry/crash; reconcile required',
      };
    }
    // failed: allow re-acquire by removing terminal failed entry
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
    status: 'reserved',
    owner: input.owner,
    ownerPid: process.pid,
    ownerSessionId: input.ownerSessionId,
    startedAt: now,
    heartbeatAt: now,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    baseSnapshot: input.baseSnapshot,
  };

  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    } finally {
      closeSync(fd);
    }
    // Immediately transition reserved → executing (same owner).
    const executing: FastRequestLedgerEntry = {
      ...entry,
      status: 'executing',
      heartbeatAt: new Date().toISOString(),
    };
    writeEntryAtomic(path, executing);
    return { kind: 'acquired', entry: executing };
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
 * Bind the lease-owned base snapshot before the first mutation.
 * The update is serialized with heartbeat/completion so stale writers cannot
 * overwrite a terminal ledger state.
 */
export function bindFastRequestBaseSnapshot(
  controllerHome: string,
  expected: FastRequestLedgerEntry,
  baseSnapshot: string,
): LedgerCompleteResult {
  return withLedgerLock(controllerHome, expected.repoId, `${expected.requestId}:bind`, () => {
    try {
      const path = entryPath(controllerHome, expected.repoId, expected.checkoutId, expected.requestId);
      const current = readEntry(path);
      if (!current) {
        return { ok: false, code: 'LEDGER_MISSING', warning: 'ledger entry missing while binding base snapshot' };
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
          warning: 'LEDGER_STALE_OWNER: base snapshot refused for non-matching entry',
        };
      }
      if (!isActiveStatus(current.status)) {
        return { ok: false, code: 'LEDGER_CAS_FAILED', entry: current, warning: 'ledger is already terminal' };
      }
      if (current.baseSnapshot && current.baseSnapshot !== baseSnapshot) {
        return {
          ok: false,
          code: 'LEDGER_CAS_FAILED',
          entry: current,
          warning: 'ledger base snapshot is already bound to a different workspace state',
        };
      }
      const next: FastRequestLedgerEntry = {
        ...current,
        status: 'executing',
        baseSnapshot,
        heartbeatAt: new Date().toISOString(),
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
  });
}

/**
 * Heartbeat ledger entry — aligned with mutation ownership TTL.
 * The read/check/write sequence is protected by a dedicated ledger lock.
 */
export function heartbeatFastRequest(
  controllerHome: string,
  expected: FastRequestLedgerEntry,
  ttlMs?: number,
): LedgerCompleteResult {
  return withLedgerLock(controllerHome, expected.repoId, `${expected.requestId}:heartbeat`, () => {
    try {
      const path = entryPath(controllerHome, expected.repoId, expected.checkoutId, expected.requestId);
      const current = readEntry(path);
      if (!current) {
        return { ok: false, code: 'LEDGER_MISSING', warning: 'ledger entry missing at heartbeat' };
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
          warning: 'LEDGER_STALE_OWNER: heartbeat refused for non-matching entry',
        };
      }
      if (!isActiveStatus(current.status)) {
        return { ok: true, entry: current };
      }
      const extendMs = Math.max(30_000, ttlMs ?? DEFAULT_LEDGER_TTL_MS);
      const next: FastRequestLedgerEntry = {
        ...current,
        status: current.status === 'reserved' ? 'executing' : current.status,
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + extendMs).toISOString(),
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
  });
}

/**
 * Compare-and-set completion. Never throws — returns structured result so callers
 * can isolate ledger failures from mutation success.
 * Requires entryId + owner + inputHash + active status.
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
    resultSnapshot?: string;
  },
): LedgerCompleteResult {
  return withLedgerLock(controllerHome, expected.repoId, `${expected.requestId}:complete`, () => {
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
      if (!isActiveStatus(current.status)) {
        // Already terminal — do not overwrite succeeded with failed from a late caller.
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
        resultSnapshot: update.resultSnapshot,
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
  });
}

/**
 * Reconcile a stale active/unknown entry using workspace evidence.
 * Never auto-retries when execution cannot be proven incomplete.
 */
function reconcileFastRequestUnlocked(input: {
  controllerHome: string;
  entry: FastRequestLedgerEntry;
  currentSnapshot?: string;
  commitHash?: string | null;
  receiptExecutionId?: string;
  changedPaths?: string[];
  evidence?: {
    /** Explicit proof mutation completed (receipt, commit, result snapshot match). */
    provenSucceeded?: boolean;
    /** Explicit proof mutation never started (identical base snapshot, no changed paths, no receipt). */
    provenNotStarted?: boolean;
  };
}): LedgerReconcileResult {
  const path = entryPath(
    input.controllerHome,
    input.entry.repoId,
    input.entry.checkoutId,
    input.entry.requestId,
  );
  const current = readEntry(path) ?? input.entry;

  if (current.status === 'succeeded') {
    return { entry: current, verdict: 'succeeded', notes: 'already_succeeded', autoRetriable: false };
  }
  if (current.status === 'failed') {
    return { entry: current, verdict: 'not_started', notes: 'terminal_failed_may_retry', autoRetriable: true };
  }

  let verdict: LedgerReconcileVerdict = 'unknown';
  let notes = 'insufficient_evidence';
  let autoRetriable = false;

  if (input.evidence?.provenSucceeded || current.receiptExecutionId || input.receiptExecutionId) {
    verdict = 'succeeded';
    notes = 'receipt_or_explicit_success_evidence';
    autoRetriable = false;
  } else if (
    input.evidence?.provenNotStarted
    || (
      current.baseSnapshot
      && input.currentSnapshot
      && current.baseSnapshot === input.currentSnapshot
      && (!input.changedPaths || input.changedPaths.length === 0)
      && !current.receiptExecutionId
    )
  ) {
    verdict = 'not_started';
    notes = 'base_snapshot_unchanged_no_receipt';
    autoRetriable = true;
  } else if (input.commitHash && current.baseSnapshot && input.commitHash !== current.baseSnapshot) {
    // HEAD moved but we cannot prove this request caused it → unknown
    verdict = 'unknown';
    notes = 'head_moved_without_request_proof';
    autoRetriable = false;
  } else {
    verdict = 'unknown';
    notes = 'cannot_prove_not_started_or_succeeded';
    autoRetriable = false;
  }

  const nextStatus: FastRequestLedgerStatus =
    verdict === 'succeeded' ? 'succeeded' : verdict === 'not_started' ? 'failed' : 'unknown';

  const next: FastRequestLedgerEntry = {
    ...current,
    status: nextStatus,
    finishedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    resultSnapshot: input.currentSnapshot ?? current.resultSnapshot,
    receiptExecutionId: input.receiptExecutionId ?? current.receiptExecutionId,
    reconcileNotes: notes,
    error: verdict === 'unknown'
      ? (current.error ?? 'reconcile_unknown')
      : verdict === 'not_started'
        ? 'reconciled_not_started'
        : current.error,
  };

  try {
    writeEntryAtomic(path, next);
  } catch {
    /* best effort persist */
  }

  return { entry: next, verdict, notes, autoRetriable };
}

export function reconcileFastRequest(
  input: Parameters<typeof reconcileFastRequestUnlocked>[0],
): LedgerReconcileResult {
  return withLedgerLock(
    input.controllerHome,
    input.entry.repoId,
    `${input.entry.requestId}:reconcile`,
    () => reconcileFastRequestUnlocked(input),
  );
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
