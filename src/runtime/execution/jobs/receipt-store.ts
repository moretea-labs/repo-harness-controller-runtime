import { existsSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import type { ExecutionChildReference } from './child-reference';
import type { ExecutionJob } from './types';

export interface OperationReceipt {
  schemaVersion: 1;
  jobId: string;
  repoId: string;
  attempt: number;
  state: 'started' | 'completed' | 'delegated';
  workerPid: number;
  startedAt: string;
  completedAt?: string;
  outcome?: 'succeeded' | 'failed' | 'delegated';
  result?: Record<string, unknown>;
  error?: ExecutionJob['error'];
  evidenceIds?: string[];
  /** Durable child Agent Run / Local Job pointer for parent delegation Jobs. */
  childReference?: ExecutionChildReference;
}

function receiptPath(controllerHome: string, repoId: string, jobId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'execution-jobs', 'receipts', `${sanitizeFileComponent(jobId)}.json`);
}

export function readOperationReceipt(controllerHome: string, repoId: string, jobId: string): OperationReceipt | undefined {
  const path = receiptPath(controllerHome, repoId, jobId);
  if (!existsSync(path)) return undefined;
  try { return readJsonFile<OperationReceipt>(path); } catch { return undefined; }
}

export function markOperationStarted(controllerHome: string, job: ExecutionJob, workerPid: number): OperationReceipt {
  const current = readOperationReceipt(controllerHome, job.repoId, job.jobId);
  if (current?.state === 'completed' && current.attempt === job.attempt) return current;
  const receipt: OperationReceipt = {
    schemaVersion: 1,
    jobId: job.jobId,
    repoId: job.repoId,
    attempt: job.attempt,
    state: 'started',
    workerPid,
    startedAt: new Date().toISOString(),
  };
  writeJsonAtomic(receiptPath(controllerHome, job.repoId, job.jobId), receipt);
  return receipt;
}

export function markOperationCompleted(
  controllerHome: string,
  job: ExecutionJob,
  workerPid: number,
  terminal: Pick<OperationReceipt, 'outcome' | 'result' | 'error' | 'evidenceIds' | 'childReference'>,
): OperationReceipt {
  const current = readOperationReceipt(controllerHome, job.repoId, job.jobId);
  const childReference = terminal.childReference ?? current?.childReference;
  const receipt: OperationReceipt = {
    schemaVersion: 1,
    jobId: job.jobId,
    repoId: job.repoId,
    attempt: job.attempt,
    state: 'completed',
    workerPid,
    startedAt: current?.attempt === job.attempt ? current.startedAt : new Date().toISOString(),
    completedAt: new Date().toISOString(),
    outcome: terminal.outcome,
    result: terminal.result,
    error: terminal.error,
    evidenceIds: terminal.evidenceIds,
    ...(childReference ? { childReference } : {}),
  };
  writeJsonAtomic(receiptPath(controllerHome, job.repoId, job.jobId), receipt);
  return receipt;
}

/**
 * Persist a durable child reference as soon as the parent Worker has accepted
 * a Local Job / Agent Run. This closes the crash window between child creation
 * and the parent Job terminal transition.
 */
export function markOperationDelegated(
  controllerHome: string,
  job: ExecutionJob,
  workerPid: number,
  childReference: ExecutionChildReference,
  result?: Record<string, unknown>,
): OperationReceipt {
  const current = readOperationReceipt(controllerHome, job.repoId, job.jobId);
  if (current?.state === 'completed' && current.attempt === job.attempt) {
    if (!current.childReference) {
      const patched: OperationReceipt = {
        ...current,
        childReference,
        result: result ?? current.result,
      };
      writeJsonAtomic(receiptPath(controllerHome, job.repoId, job.jobId), patched);
      return patched;
    }
    return current;
  }
  const receipt: OperationReceipt = {
    schemaVersion: 1,
    jobId: job.jobId,
    repoId: job.repoId,
    attempt: job.attempt,
    state: 'delegated',
    workerPid,
    startedAt: current?.attempt === job.attempt ? current.startedAt : new Date().toISOString(),
    outcome: 'delegated',
    result,
    childReference: {
      ...childReference,
      delegatedAt: childReference.delegatedAt ?? new Date().toISOString(),
      requestId: childReference.requestId ?? job.requestId,
    },
  };
  writeJsonAtomic(receiptPath(controllerHome, job.repoId, job.jobId), receipt);
  return receipt;
}
