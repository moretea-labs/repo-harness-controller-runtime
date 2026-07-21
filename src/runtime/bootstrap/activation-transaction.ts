/**
 * Atomic activation authority transaction.
 *
 * Single source of truth:
 *   bootstrap/activation-authority.json
 *
 * Compatibility projections (written only after commit):
 *   bootstrap/active-runtime.json
 *   bootstrap/writer-authority.json
 *   active-slot.json
 *
 * Protocol:
 *   1. Write prepare journal (activation-authority.prepare.json)
 *   2. Write full authority record to temporary path
 *   3. Atomic rename → activation-authority.json (commit)
 *   4. Update compatibility projections
 *   5. Clear prepare journal
 *
 * Crash recovery:
 *   - prepare only → incomplete (not succeeded)
 *   - authority committed, projections partial → recover projections from authority
 *   - incomplete must never be reported as succeeded
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import type { RuntimeSlotId } from '../../cli/controller/runtime-slots';
import type { WriterAuthority } from '../../cli/controller/stable-state/writer-authority';
import type { ActiveRuntimePointer } from './stable-bootstrap';

export type ActivationTxStatus =
  | 'committed'
  | 'prepared'
  | 'incomplete'
  | 'missing';

export interface ActivationAuthorityRecord {
  schemaVersion: 1;
  status: 'committed';
  activeSlot: RuntimeSlotId;
  generation?: string;
  releaseRevision?: string;
  releasePath?: string;
  writerEpoch: string;
  fencingToken: string;
  daemonPort?: number;
  gatewayPort?: number;
  reason?: string;
  previousEpoch?: string;
  previousSlot?: RuntimeSlotId;
  rollbackUntil?: string;
  committedAt: string;
  transactionId: string;
}

export interface ActivationPrepareJournal {
  schemaVersion: 1;
  status: 'prepared';
  transactionId: string;
  preparedAt: string;
  intended: Omit<ActivationAuthorityRecord, 'schemaVersion' | 'status' | 'committedAt'>;
}

export interface ActivationTransactionResult {
  ok: boolean;
  status: ActivationTxStatus;
  authority?: ActivationAuthorityRecord;
  recovered?: boolean;
  error?: string;
}

function root(controllerHome: string): string {
  return ensureControllerHome(controllerHome);
}

export function activationAuthorityPath(controllerHome: string): string {
  return join(root(controllerHome), 'bootstrap', 'activation-authority.json');
}

export function activationPreparePath(controllerHome: string): string {
  return join(root(controllerHome), 'bootstrap', 'activation-authority.prepare.json');
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`;
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

function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best-effort */
  }
}

export function readActivationAuthority(controllerHome: string): ActivationAuthorityRecord | undefined {
  const value = readJson<ActivationAuthorityRecord>(activationAuthorityPath(controllerHome));
  if (!value || value.schemaVersion !== 1 || value.status !== 'committed') return undefined;
  if (value.activeSlot !== 'blue' && value.activeSlot !== 'green') return undefined;
  if (!value.writerEpoch || !value.fencingToken) return undefined;
  return value;
}

export function readActivationPrepare(controllerHome: string): ActivationPrepareJournal | undefined {
  const value = readJson<ActivationPrepareJournal>(activationPreparePath(controllerHome));
  if (!value || value.schemaVersion !== 1 || value.status !== 'prepared') return undefined;
  return value;
}

/**
 * Inspect activation state for operators and recovery.
 * incomplete = prepare present without a committed record matching transactionId.
 */
export function inspectActivationTransaction(controllerHome: string): ActivationTransactionResult {
  const authority = readActivationAuthority(controllerHome);
  const prepare = readActivationPrepare(controllerHome);
  if (prepare && (!authority || authority.transactionId !== prepare.transactionId)) {
    return {
      ok: false,
      status: prepare && !authority ? 'prepared' : 'incomplete',
      authority: authority,
      error: 'activation_prepare_without_matching_commit',
    };
  }
  if (authority) return { ok: true, status: 'committed', authority };
  if (prepare) return { ok: false, status: 'prepared', error: 'prepared_not_committed' };
  return { ok: false, status: 'missing' };
}

function writeCompatibilityProjections(
  controllerHome: string,
  authority: ActivationAuthorityRecord,
): void {
  const home = root(controllerHome);
  const bootstrap = join(home, 'bootstrap');
  mkdirSync(bootstrap, { recursive: true });

  // writer-authority.json projection
  const writer: WriterAuthority = {
    schemaVersion: 1,
    epoch: authority.writerEpoch,
    activeSlot: authority.activeSlot,
    fencingToken: authority.fencingToken,
    generation: authority.generation,
    releaseRevision: authority.releaseRevision,
    releasePath: authority.releasePath,
    updatedAt: authority.committedAt,
    reason: authority.reason,
  };
  atomicWrite(join(bootstrap, 'writer-authority.json'), writer);

  // active-runtime.json projection
  const pointer: ActiveRuntimePointer = {
    schemaVersion: 1,
    activeSlot: authority.activeSlot,
    generation: authority.generation,
    releaseRevision: authority.releaseRevision,
    releasePath: authority.releasePath,
    writerEpoch: authority.writerEpoch,
    fencingToken: authority.fencingToken,
    daemonPort: authority.daemonPort,
    gatewayPort: authority.gatewayPort,
    updatedAt: authority.committedAt,
  };
  atomicWrite(join(bootstrap, 'active-runtime.json'), pointer);

  // active-slot.json projection (root)
  const activeSlot = {
    schemaVersion: 1,
    activeSlot: authority.activeSlot,
    previousSlot: authority.previousSlot,
    generation: authority.generation,
    reason: authority.reason,
    rollbackUntil: authority.rollbackUntil,
    updatedAt: authority.committedAt,
  };
  atomicWrite(join(home, 'active-slot.json'), activeSlot);
}

/**
 * Commit a new activation authority in one transaction.
 * Throws on CAS failure or IO failure — never silently ignores.
 */
export function commitActivationTransaction(
  controllerHome: string,
  input: {
    activeSlot: RuntimeSlotId;
    generation?: string;
    releaseRevision?: string;
    releasePath?: string;
    daemonPort?: number;
    gatewayPort?: number;
    reason?: string;
    previousEpoch?: string;
    previousSlot?: RuntimeSlotId;
    rollbackUntil?: string;
    /** Test hook: stop after prepare journal is written. */
    crashAfterPrepare?: boolean;
    /** Test hook: stop after authority commit, before projections. */
    crashAfterCommitBeforeProjections?: boolean;
  },
): ActivationAuthorityRecord {
  const home = root(controllerHome);
  mkdirSync(join(home, 'bootstrap'), { recursive: true });

  const existing = readActivationAuthority(home);
  if (input.previousEpoch) {
    const currentEpoch = existing?.writerEpoch
      ?? readJson<WriterAuthority>(join(home, 'bootstrap', 'writer-authority.json'))?.epoch;
    if (currentEpoch && currentEpoch !== input.previousEpoch) {
      throw new Error(
        `ACTIVATION_CAS_FAILED: expected previous epoch ${input.previousEpoch}, found ${currentEpoch}`,
      );
    }
  }

  const transactionId = `atx-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const writerEpoch = `wa-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const fencingToken = randomUUID();
  const intended: ActivationPrepareJournal['intended'] = {
    transactionId,
    activeSlot: input.activeSlot,
    generation: input.generation,
    releaseRevision: input.releaseRevision,
    releasePath: input.releasePath,
    writerEpoch,
    fencingToken,
    daemonPort: input.daemonPort,
    gatewayPort: input.gatewayPort,
    reason: input.reason,
    previousEpoch: input.previousEpoch ?? existing?.writerEpoch,
    previousSlot: input.previousSlot ?? existing?.activeSlot,
    rollbackUntil: input.rollbackUntil,
  };

  const prepare: ActivationPrepareJournal = {
    schemaVersion: 1,
    status: 'prepared',
    transactionId,
    preparedAt: new Date().toISOString(),
    intended,
  };
  atomicWrite(activationPreparePath(home), prepare);

  if (input.crashAfterPrepare) {
    throw new Error('ACTIVATION_INJECTED_CRASH:after_prepare');
  }

  const committedAt = new Date().toISOString();
  const authority: ActivationAuthorityRecord = {
    schemaVersion: 1,
    status: 'committed',
    ...intended,
    committedAt,
  };

  // Commit authority record (atomic rename).
  atomicWrite(activationAuthorityPath(home), authority);

  if (input.crashAfterCommitBeforeProjections) {
    throw new Error('ACTIVATION_INJECTED_CRASH:after_commit_before_projections');
  }

  // Projections — if this fails, recoverActivationTransaction can rebuild them.
  writeCompatibilityProjections(home, authority);
  safeUnlink(activationPreparePath(home));
  return authority;
}

/**
 * After crash: if authority is committed, rebuild projections; clear stale prepare.
 * Never reports incomplete as succeeded.
 */
export function recoverActivationTransaction(controllerHome: string): ActivationTransactionResult {
  const home = root(controllerHome);
  const inspect = inspectActivationTransaction(home);
  const authority = readActivationAuthority(home);
  const prepare = readActivationPrepare(home);

  if (authority) {
    // Authority committed — ensure projections match, clear prepare if same tx or stale.
    writeCompatibilityProjections(home, authority);
    if (prepare) safeUnlink(activationPreparePath(home));
    return { ok: true, status: 'committed', authority, recovered: true };
  }

  if (prepare) {
    // Prepared but never committed — leave prepare for operator visibility; do not invent authority.
    return {
      ok: false,
      status: 'prepared',
      recovered: false,
      error: 'incomplete_activation_prepare_only; re-run activation',
    };
  }

  // Fall back: if only projections exist (pre-transaction layout), synthesize authority once.
  const writer = readJson<WriterAuthority>(join(home, 'bootstrap', 'writer-authority.json'));
  const pointer = readJson<ActiveRuntimePointer>(join(home, 'bootstrap', 'active-runtime.json'));
  if (writer && pointer && writer.activeSlot === pointer.activeSlot) {
    const synthesized: ActivationAuthorityRecord = {
      schemaVersion: 1,
      status: 'committed',
      activeSlot: writer.activeSlot,
      generation: writer.generation ?? pointer.generation,
      releaseRevision: writer.releaseRevision ?? pointer.releaseRevision,
      releasePath: writer.releasePath ?? pointer.releasePath,
      writerEpoch: writer.epoch,
      fencingToken: writer.fencingToken,
      daemonPort: pointer.daemonPort,
      gatewayPort: pointer.gatewayPort,
      reason: writer.reason ?? 'recovered_from_projections',
      committedAt: writer.updatedAt ?? new Date().toISOString(),
      transactionId: `atx-recover-${Date.now()}`,
    };
    atomicWrite(activationAuthorityPath(home), synthesized);
    writeCompatibilityProjections(home, synthesized);
    return { ok: true, status: 'committed', authority: synthesized, recovered: true };
  }

  return inspect;
}

/**
 * Rollback activation: swap to previous slot with a new epoch in one transaction.
 */
export function rollbackActivationTransaction(
  controllerHome: string,
  input: {
    generation?: string;
    reason?: string;
    crashMidway?: boolean;
  } = {},
): ActivationAuthorityRecord {
  const current = readActivationAuthority(controllerHome)
    ?? recoverActivationTransaction(controllerHome).authority;
  if (!current) {
    throw new Error('ACTIVATION_ROLLBACK_FAILED: no committed authority to roll back');
  }
  const previous = current.previousSlot ?? (current.activeSlot === 'blue' ? 'green' : 'blue');
  if (input.crashMidway) {
    // Prepare only then crash — incomplete.
    return commitActivationTransaction(controllerHome, {
      activeSlot: previous,
      previousSlot: current.activeSlot,
      generation: input.generation ?? current.generation,
      reason: input.reason ?? 'rollback',
      previousEpoch: current.writerEpoch,
      crashAfterPrepare: true,
    });
  }
  return commitActivationTransaction(controllerHome, {
    activeSlot: previous,
    previousSlot: current.activeSlot,
    generation: input.generation ?? current.generation,
    releaseRevision: current.releaseRevision,
    releasePath: current.releasePath,
    reason: input.reason ?? 'rollback',
    previousEpoch: current.writerEpoch,
  });
}
