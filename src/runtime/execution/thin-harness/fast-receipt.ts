import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import {
  FAST_RECEIPT_MAX_SUMMARY_BYTES,
  FAST_RECEIPT_RETENTION,
  type FastExecutionReceipt,
  type FastOutcome,
  type LatencyBreakdown,
} from './types';

export interface CreateFastReceiptInput {
  repoId: string;
  checkoutId: string;
  operation: string;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  outcome: FastOutcome;
  changedPaths?: string[];
  repositoryChanged?: boolean;
  authorizationDecision?: string;
  policyDecision?: string;
  outputSummary?: string;
  artifactRefs?: string[];
  latency?: LatencyBreakdown;
  stepCount?: number;
  laneCount?: number;
  reasons?: string[];
  executionId?: string;
}

function receiptsDir(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'fast-receipts');
}

function receiptPath(controllerHome: string, repoId: string, executionId: string): string {
  const safe = executionId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120);
  return join(receiptsDir(controllerHome, repoId), `${safe}.json`);
}

function boundSummary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= FAST_RECEIPT_MAX_SUMMARY_BYTES) return value;
  return `${value.slice(0, FAST_RECEIPT_MAX_SUMMARY_BYTES)}…[truncated ${bytes} bytes]`;
}

/**
 * Persist one bounded Fast Path receipt.
 * Does not dirty projections, create Jobs, or enter Issue/Task completion models.
 */
export function writeFastReceipt(controllerHome: string, input: CreateFastReceiptInput): FastExecutionReceipt {
  const executionId = input.executionId ?? `fast_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const finishedAt = input.finishedAt ?? new Date().toISOString();
  const receipt: FastExecutionReceipt = {
    schemaVersion: 1,
    executionId,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    mode: 'fast',
    operation: input.operation,
    startedAt: input.startedAt,
    finishedAt,
    durationMs: Math.max(0, Math.round(input.durationMs * 100) / 100),
    outcome: input.outcome,
    changedPaths: [...new Set(input.changedPaths ?? [])].slice(0, 200),
    repositoryChanged: input.repositoryChanged === true,
    authorizationDecision: input.authorizationDecision ?? 'session_or_policy',
    policyDecision: input.policyDecision ?? 'allowed',
    outputSummary: boundSummary(input.outputSummary),
    artifactRefs: input.artifactRefs?.slice(0, 20),
    latency: input.latency,
    stepCount: input.stepCount,
    laneCount: input.laneCount,
    reasons: input.reasons?.slice(0, 20),
  };

  const dir = receiptsDir(controllerHome, input.repoId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = receiptPath(controllerHome, input.repoId, executionId);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  renameSync(temporary, target);
  pruneFastReceipts(controllerHome, input.repoId);
  return receipt;
}

export function readFastReceipt(
  controllerHome: string,
  repoId: string,
  executionId: string,
): FastExecutionReceipt | undefined {
  const path = receiptPath(controllerHome, repoId, executionId);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FastExecutionReceipt;
  } catch {
    return undefined;
  }
}

export function listFastReceipts(
  controllerHome: string,
  repoId: string,
  limit = 20,
): FastExecutionReceipt[] {
  const dir = receiptsDir(controllerHome, repoId);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const path = join(dir, name);
      try {
        const receipt = JSON.parse(readFileSync(path, 'utf8')) as FastExecutionReceipt;
        return { path, receipt, mtime: receipt.finishedAt ?? '' };
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is { path: string; receipt: FastExecutionReceipt; mtime: string } => Boolean(entry))
    .sort((left, right) => right.mtime.localeCompare(left.mtime));
  return files.slice(0, Math.max(1, Math.min(limit, 100))).map((entry) => entry.receipt);
}

function pruneFastReceipts(controllerHome: string, repoId: string): void {
  const dir = receiptsDir(controllerHome, repoId);
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(dir, name))
    .sort()
    .reverse();
  for (const path of files.slice(FAST_RECEIPT_RETENTION)) {
    try {
      rmSync(path, { force: true });
    } catch {
      // best-effort retention
    }
  }
}

/** In-memory counters for benchmarks / tests (process-local). */
export interface FastPathMetrics {
  executionJobCount: number;
  localJobCount: number;
  workerSpawnCount: number;
  projectionUpdateCount: number;
  receiptCount: number;
}

const metrics: FastPathMetrics = {
  executionJobCount: 0,
  localJobCount: 0,
  workerSpawnCount: 0,
  projectionUpdateCount: 0,
  receiptCount: 0,
};

export function resetFastPathMetrics(): void {
  metrics.executionJobCount = 0;
  metrics.localJobCount = 0;
  metrics.workerSpawnCount = 0;
  metrics.projectionUpdateCount = 0;
  metrics.receiptCount = 0;
}

export function noteFastReceiptWritten(): void {
  metrics.receiptCount += 1;
}

export function getFastPathMetrics(): FastPathMetrics {
  return { ...metrics };
}

export function recordFastReceiptMetric(receipt: FastExecutionReceipt): FastExecutionReceipt {
  noteFastReceiptWritten();
  return receipt;
}
