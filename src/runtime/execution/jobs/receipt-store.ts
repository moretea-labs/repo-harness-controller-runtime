import { existsSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import { assertFencingToken } from '../../resources/leases/store';
import type { ExecutionChildReference } from './child-reference';
import { getExecutionJob } from './store';
import type { ExecutionJob } from './types';

export interface OperationReceiptLeaseRef {
  leaseId: string;
  fencingToken: number;
}

export interface OperationReceipt {
  schemaVersion: 1;
  jobId: string;
  repoId: string;
  attempt: number;
  state: 'started' | 'completed' | 'delegated';
  workerPid: number;
  /** Additive ownership snapshot; absent on legacy receipts. */
  leaseRefs?: OperationReceiptLeaseRef[];
  ownerEpoch?: string;
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

function leaseOwnership(job: ExecutionJob): OperationReceiptLeaseRef[] {
  return job.leaseRefs.map((ref) => ({ leaseId: ref.leaseId, fencingToken: ref.fencingToken }));
}

function sameLeaseOwnership(receipt: OperationReceipt, job: ExecutionJob): boolean {
  if (!receipt.leaseRefs) return true;
  const expected = leaseOwnership(job);
  if (receipt.leaseRefs.length !== expected.length) return false;
  const byId = new Map(expected.map((ref) => [ref.leaseId, ref.fencingToken]));
  return receipt.leaseRefs.every((ref) => byId.get(ref.leaseId) === ref.fencingToken);
}

export function operationReceiptMatchesJobOwnership(receipt: OperationReceipt, job: ExecutionJob): boolean {
  if (receipt.repoId !== job.repoId || receipt.jobId !== job.jobId || receipt.attempt !== job.attempt) return false;
  const currentWorkerPid = job.workerPid ?? job.workerLifecycle?.workerPid;
  if (currentWorkerPid !== undefined && receipt.workerPid !== currentWorkerPid) return false;
  if (receipt.ownerEpoch && job.workerLifecycle?.ownerEpoch && receipt.ownerEpoch !== job.workerLifecycle.ownerEpoch) return false;
  return sameLeaseOwnership(receipt, job);
}

function assertOperationReceiptOwnership(
  controllerHome: string,
  job: ExecutionJob,
  workerPid: number,
): ExecutionJob {
  const current = getExecutionJob(controllerHome, job.repoId, job.jobId);
  const ownerMatches = current.status === 'running'
    && current.attempt === job.attempt
    && current.workerPid === workerPid
    && (job.workerPid === undefined || job.workerPid === workerPid);
  if (!ownerMatches) {
    throw new Error(`OPERATION_RECEIPT_OWNERSHIP_STALE: ${job.jobId} attempt=${job.attempt} workerPid=${workerPid}`);
  }
  for (const ref of current.leaseRefs) {
    assertFencingToken(controllerHome, current.repoId, ref.leaseId, ref.fencingToken);
  }
  return current;
}

function receiptOwnership(job: ExecutionJob): Pick<OperationReceipt, 'attempt' | 'workerPid' | 'leaseRefs' | 'ownerEpoch'> {
  return {
    attempt: job.attempt,
    workerPid: job.workerPid!,
    leaseRefs: leaseOwnership(job),
    ...(job.workerLifecycle?.ownerEpoch ? { ownerEpoch: job.workerLifecycle.ownerEpoch } : {}),
  };
}

export function markOperationStarted(controllerHome: string, job: ExecutionJob, workerPid: number): OperationReceipt {
  const ownedJob = assertOperationReceiptOwnership(controllerHome, job, workerPid);
  const current = readOperationReceipt(controllerHome, job.repoId, job.jobId);
  if (current?.state === 'completed' && operationReceiptMatchesJobOwnership(current, ownedJob)) return current;
  const receipt: OperationReceipt = {
    schemaVersion: 1,
    jobId: ownedJob.jobId,
    repoId: ownedJob.repoId,
    ...receiptOwnership(ownedJob),
    state: 'started',
    startedAt: new Date().toISOString(),
  };
  writeJsonAtomic(receiptPath(controllerHome, ownedJob.repoId, ownedJob.jobId), receipt);
  return receipt;
}

export function markOperationCompleted(
  controllerHome: string,
  job: ExecutionJob,
  workerPid: number,
  terminal: Pick<OperationReceipt, 'outcome' | 'result' | 'error' | 'evidenceIds' | 'childReference'>,
): OperationReceipt {
  const ownedJob = assertOperationReceiptOwnership(controllerHome, job, workerPid);
  const current = readOperationReceipt(controllerHome, job.repoId, job.jobId);
  const trustedCurrent = current && operationReceiptMatchesJobOwnership(current, ownedJob) ? current : undefined;
  const childReference = terminal.childReference ?? trustedCurrent?.childReference;
  const receipt: OperationReceipt = {
    schemaVersion: 1,
    jobId: ownedJob.jobId,
    repoId: ownedJob.repoId,
    ...receiptOwnership(ownedJob),
    state: 'completed',
    startedAt: trustedCurrent?.startedAt ?? new Date().toISOString(),
    completedAt: new Date().toISOString(),
    outcome: terminal.outcome,
    result: terminal.result,
    error: terminal.error,
    evidenceIds: terminal.evidenceIds,
    ...(childReference ? { childReference } : {}),
  };
  writeJsonAtomic(receiptPath(controllerHome, ownedJob.repoId, ownedJob.jobId), receipt);
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
  const ownedJob = assertOperationReceiptOwnership(controllerHome, job, workerPid);
  const current = readOperationReceipt(controllerHome, job.repoId, job.jobId);
  const trustedCurrent = current && operationReceiptMatchesJobOwnership(current, ownedJob) ? current : undefined;
  if (trustedCurrent?.state === 'completed') {
    if (!trustedCurrent.childReference) {
      const patched: OperationReceipt = {
        ...trustedCurrent,
        childReference,
        result: result ?? trustedCurrent.result,
      };
      writeJsonAtomic(receiptPath(controllerHome, ownedJob.repoId, ownedJob.jobId), patched);
      return patched;
    }
    return trustedCurrent;
  }
  const receipt: OperationReceipt = {
    schemaVersion: 1,
    jobId: ownedJob.jobId,
    repoId: ownedJob.repoId,
    ...receiptOwnership(ownedJob),
    state: 'delegated',
    startedAt: trustedCurrent?.startedAt ?? new Date().toISOString(),
    outcome: 'delegated',
    result,
    childReference: {
      ...childReference,
      delegatedAt: childReference.delegatedAt ?? new Date().toISOString(),
      requestId: childReference.requestId ?? ownedJob.requestId,
    },
  };
  writeJsonAtomic(receiptPath(controllerHome, ownedJob.repoId, ownedJob.jobId), receipt);
  return receipt;
}
