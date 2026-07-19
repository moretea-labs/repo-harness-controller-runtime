import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { resolve, sep } from 'path';
import { writeJsonAtomic } from '../shared/json-files';
import { defaultProcessIdentityProbe, executableFingerprint, newProcessInstanceId, processIdentityMatches } from './identity';
import {
  ensureStableSupervisorLayout,
  supervisorOperationLockPath,
  supervisorOperationPath,
  supervisorOperationsRoot,
  supervisorReleasesRoot,
} from './paths';
import type { ProcessIdentity, SupervisorOperation, SupervisorOperationKind, SupervisorOperationPhase } from './types';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const MAX_ERROR_LENGTH = 1_000;
const MAX_RESULT_BYTES = 16 * 1024;

function safeRequestId(value: string): string {
  const result = value.trim();
  if (!REQUEST_ID_PATTERN.test(result)) throw new Error('SUPERVISOR_REQUEST_ID_INVALID');
  return result;
}

function boundedText(value: string | undefined): string | undefined {
  return value?.replace(/\s+/g, ' ').slice(0, MAX_ERROR_LENGTH);
}

function safeCandidateReleasePath(controllerHome: string, value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const candidate = resolve(value.trim());
  try {
    const rootReal = realpathSync(resolve(supervisorReleasesRoot(controllerHome)));
    const candidateReal = realpathSync(candidate);
    if (!candidateReal.startsWith(`${rootReal}${sep}`)) {
      throw new Error('SUPERVISOR_RELEASE_PATH_OUTSIDE_CONTROLLER_HOME');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'SUPERVISOR_RELEASE_PATH_OUTSIDE_CONTROLLER_HOME') throw error;
    throw new Error('SUPERVISOR_RELEASE_PATH_OUTSIDE_CONTROLLER_HOME');
  }
  return candidate;
}

function boundedResult(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= MAX_RESULT_BYTES) return value;
    return { summary: serialized.slice(0, MAX_RESULT_BYTES - 80), bounded: true };
  } catch {
    return { summary: 'operation result was not serializable', bounded: true };
  }
}

function readOperationPath(path: string): SupervisorOperation | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as SupervisorOperation;
    return value?.schemaVersion === 1 && typeof value.operationId === 'string' ? value : null;
  } catch {
    return null;
  }
}

export function readSupervisorOperation(controllerHome: string, operationId: string): SupervisorOperation | null {
  return readOperationPath(supervisorOperationPath(controllerHome, operationId));
}

export function listSupervisorOperations(controllerHome: string, limit = 100): SupervisorOperation[] {
  ensureStableSupervisorLayout(controllerHome);
  const max = Math.max(1, Math.min(Math.trunc(limit), 100));
  return readdirSync(supervisorOperationsRoot(controllerHome), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .slice(0, 500)
    .map((entry) => readOperationPath(supervisorOperationPath(controllerHome, entry.name.slice(0, -5))))
    .filter((value): value is SupervisorOperation => value !== null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, max);
}

export function findSupervisorOperationByRequestId(controllerHome: string, requestId: string): SupervisorOperation | null {
  const safe = safeRequestId(requestId);
  return listSupervisorOperations(controllerHome, 500).find((operation) => operation.requestId === safe) ?? null;
}

interface OperationScheduleLock extends ProcessIdentity {
  acquiredAt: string;
}

function readScheduleLock(path: string): OperationScheduleLock | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as OperationScheduleLock;
    return value && typeof value.pid === 'number' && typeof value.instanceId === 'string' && typeof value.processStartTime === 'string'
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function withOperationScheduleLock<T>(controllerHome: string, action: () => T): T {
  ensureStableSupervisorLayout(controllerHome);
  const lockPath = supervisorOperationLockPath(controllerHome);
  const metadata: OperationScheduleLock = {
    pid: process.pid,
    instanceId: newProcessInstanceId('op-lock'),
    processStartTime: defaultProcessIdentityProbe.startTime(process.pid) ?? new Date().toISOString(),
    executableFingerprint: executableFingerprint(defaultProcessIdentityProbe.command(process.pid) ?? process.argv.join(' ')),
    controllerHome,
    ownerEpoch: 0,
    acquiredAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | undefined;
    let acquired = false;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(metadata)}\n`, 'utf8');
      acquired = true;
      return action();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = readScheduleLock(lockPath);
      if (!existing) throw new Error('SUPERVISOR_OPERATION_LOCK_UNCERTAIN: lock metadata cannot prove that the owner is dead');
      const match = processIdentityMatches(existing, existing.pid, defaultProcessIdentityProbe);
      if (match.matches) throw new Error('SUPERVISOR_OPERATION_LOCK_BUSY');
      // Re-read immediately before reclaiming a dead owner. This keeps a stale
      // recovery from deleting a lock that has already been replaced.
      const latest = readScheduleLock(lockPath);
      if (!latest || latest.instanceId !== existing.instanceId) {
        if (attempt === 1) throw new Error('SUPERVISOR_OPERATION_LOCK_BUSY');
        continue;
      }
      const latestMatch = processIdentityMatches(latest, latest.pid, defaultProcessIdentityProbe);
      if (latestMatch.matches) throw new Error('SUPERVISOR_OPERATION_LOCK_BUSY');
      rmSync(lockPath, { force: true });
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (acquired) {
        const current = readScheduleLock(lockPath);
        if (current?.instanceId === metadata.instanceId) rmSync(lockPath, { force: true });
      }
    }
  }
  throw new Error('SUPERVISOR_OPERATION_LOCK_BUSY');
}

export function createSupervisorOperation(input: {
  controllerHome: string;
  repoRoot?: string;
  requestId: string;
  kind: SupervisorOperationKind;
  requestedBy?: string;
  actor?: string;
  reason?: string;
  candidateReleasePath?: string;
}): { operation: SupervisorOperation; deduplicated: boolean } {
  const requestId = safeRequestId(input.requestId);
  const candidateReleasePath = safeCandidateReleasePath(input.controllerHome, input.candidateReleasePath);
  if (candidateReleasePath && input.kind !== 'rollout') {
    throw new Error('SUPERVISOR_RELEASE_PATH_ONLY_VALID_FOR_ROLLOUT');
  }
  return withOperationScheduleLock(input.controllerHome, () => {
    const existing = findSupervisorOperationByRequestId(input.controllerHome, requestId);
    if (existing) return { operation: existing, deduplicated: true };
    const acceptedAt = new Date().toISOString();
    const operation: SupervisorOperation = {
      schemaVersion: 1,
      operationId: `sup-op-${Date.now()}-${randomUUID().slice(0, 10)}`,
      requestId,
      kind: input.kind,
      controllerHome: input.controllerHome,
      ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
      requestedBy: boundedText(input.requestedBy) ?? 'unknown',
      actor: boundedText(input.actor) ?? boundedText(input.requestedBy) ?? 'unknown',
      ...(input.reason ? { reason: boundedText(input.reason) } : {}),
      ...(candidateReleasePath ? { candidateReleasePath } : {}),
      phase: 'accepted',
      acceptedAt,
      updatedAt: acceptedAt,
      reconnectContract: 'stable_domain_retry',
    };
    writeJsonAtomic(supervisorOperationPath(input.controllerHome, operation.operationId), operation);
    return { operation, deduplicated: false };
  });
}

export function updateSupervisorOperation(
  controllerHome: string,
  operationId: string,
  patch: Partial<SupervisorOperation> & { phase: SupervisorOperationPhase },
): SupervisorOperation {
  const current = readSupervisorOperation(controllerHome, operationId);
  if (!current) throw new Error(`SUPERVISOR_OPERATION_NOT_FOUND: ${operationId}`);
  const updated: SupervisorOperation = {
    ...current,
    ...patch,
    ...(patch.error ? { error: boundedText(patch.error) } : {}),
    ...(patch.result ? { result: boundedResult(patch.result) } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(supervisorOperationPath(controllerHome, operationId), updated);
  return updated;
}
