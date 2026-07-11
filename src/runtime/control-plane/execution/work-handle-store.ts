import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';

export const WORK_HANDLE_STATES = ['prepared', 'editing', 'validating', 'committed', 'merged', 'cleaned', 'failed'] as const;
export type WorkHandleStateName = (typeof WORK_HANDLE_STATES)[number];

export interface WorkFinalizationStages {
  validation: 'pending' | 'done' | 'failed';
  commit: 'pending' | 'done' | 'skipped' | 'failed';
  merge: 'pending' | 'done' | 'skipped' | 'failed';
  branchCleanup: 'pending' | 'done' | 'skipped' | 'failed';
  worktreeCleanup: 'pending' | 'done' | 'skipped' | 'failed';
  lastError?: string;
}

export interface WorkHandleState {
  schemaVersion: 1;
  workId: string;
  sessionId: string;
  principalId: string;
  repositoryId: string;
  checkoutId: string;
  worktreePath: string;
  branch: string;
  sourceCheckoutId?: string;
  goalId?: string;
  delegationVersion?: number;
  managedWorktree: boolean;
  workContractId?: string;
  baseCommit?: string;
  expectedHead?: string;
  permissionSnapshotVersion: number;
  state: WorkHandleStateName;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
  finalization: WorkFinalizationStages;
}

function workHandleRoot(controllerHome: string, repoId: string): string {
  const root = join(repositoryControllerRoot(controllerHome, repoId), 'work-handles');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function workHandlePath(controllerHome: string, handle: Pick<WorkHandleState, 'repositoryId' | 'workId'>): string {
  return join(workHandleRoot(controllerHome, handle.repositoryId), `${sanitizeFileComponent(handle.workId)}.json`);
}

function now(): string {
  return new Date().toISOString();
}

export function newWorkId(): string {
  return `work_${randomUUID().replace(/-/g, '')}`;
}

export function readWorkHandle(controllerHome: string, repositoryId: string, workId: string): WorkHandleState | undefined {
  const path = workHandlePath(controllerHome, { repositoryId, workId });
  if (!existsSync(path)) return undefined;
  const handle = readJsonFile<WorkHandleState>(path);
  if (handle.workId !== workId || handle.repositoryId !== repositoryId) throw new Error('WORK_HANDLE_IDENTITY_MISMATCH');
  return handle;
}

export function writeWorkHandle(controllerHome: string, handle: WorkHandleState): WorkHandleState {
  const updated = { ...handle, updatedAt: now() };
  writeJsonAtomic(workHandlePath(controllerHome, updated), updated);
  return updated;
}

const TRANSITIONS: Record<WorkHandleStateName, readonly WorkHandleStateName[]> = {
  prepared: ['editing', 'validating', 'committed', 'failed'],
  editing: ['validating', 'committed', 'failed'],
  validating: ['editing', 'committed', 'merged', 'failed'],
  committed: ['validating', 'merged', 'cleaned', 'failed'],
  merged: ['cleaned', 'failed'],
  cleaned: [],
  failed: ['validating', 'editing'],
};

export function transitionWorkHandle(
  controllerHome: string,
  handle: WorkHandleState,
  nextState: WorkHandleStateName,
  patch: Partial<Pick<WorkHandleState, 'failureReason' | 'expectedHead' | 'finalization'>> = {},
): WorkHandleState {
  if (handle.state !== nextState && !TRANSITIONS[handle.state].includes(nextState)) {
    throw new Error(`WORK_HANDLE_LIFECYCLE_INVALID: cannot transition ${handle.state} -> ${nextState}`);
  }
  return writeWorkHandle(controllerHome, {
    ...handle,
    ...patch,
    state: nextState,
    ...(nextState === 'failed' && !patch.failureReason ? { failureReason: handle.failureReason ?? 'work handle failed' } : {}),
  });
}

export function markWorkHandleFailed(controllerHome: string, handle: WorkHandleState, reason: string): WorkHandleState {
  return writeWorkHandle(controllerHome, {
    ...handle,
    state: 'failed',
    failureReason: reason.slice(0, 1_000),
  });
}
