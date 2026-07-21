import { createHash, randomUUID } from 'crypto';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { ensureControllerHome, ensureRepositoryControllerLayout, repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { withControllerLock } from '../../../cli/repositories/locks';
import { appendJobEvent } from '../../evidence/event-ledger';
import { writeExecutionArtifact } from '../../evidence/artifact-store';
import { markRepositoryProjectionDirty } from '../../projections/invalidation';
import { touchSchedulerWakeSignal } from '../../control-plane/global-scheduler/wake-signal';
import { readJsonFile, removeFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import { terminateProcessTree } from '../../shared/process-tree';
import { releaseExecutionLeases } from '../../resources/leases/store';
import {
  ACTIVE_JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  type CreateExecutionJobInput,
  type ExecutionJob,
  type ExecutionJobStatus,
} from './types';

interface ActiveJobIndex {
  schemaVersion: 1;
  updatedAt: string;
  jobs: Array<{ jobId: string; repoId: string; status: ExecutionJobStatus; priority: string; queuedAt: string; updatedAt: string }>;
}

interface RecentJobIndex {
  schemaVersion: 1;
  updatedAt: string;
  jobs: Array<{ jobId: string; repoId: string; createdAt: string; updatedAt: string; status: ExecutionJobStatus }>;
}

interface RequestIndexRecord {
  schemaVersion: 1;
  requestId: string;
  semanticKey: string;
  jobId: string;
  repoId: string;
  createdAt: string;
}

function now(): string { return new Date().toISOString(); }
function safeRepoId(repoId: string): string { return sanitizeFileComponent(repoId); }

export function executionJobRoot(controllerHome: string, repoId: string): string {
  ensureRepositoryControllerLayout(controllerHome, repoId);
  return join(repositoryControllerRoot(controllerHome, safeRepoId(repoId)), 'execution-jobs');
}

function jobPath(controllerHome: string, repoId: string, jobId: string): string {
  return join(executionJobRoot(controllerHome, repoId), 'records', `${sanitizeFileComponent(jobId)}.json`);
}

function requestPath(controllerHome: string, requestId: string): string {
  const hash = createHash('sha256').update(requestId).digest('hex');
  return join(ensureControllerHome(controllerHome), 'indexes', 'execution-jobs', 'requests', `${hash}.json`);
}

function activeIndexPath(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'indexes', 'execution-jobs', 'active.json');
}

function recentIndexPath(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'indexes', 'execution-jobs', 'recent.json');
}

function readActiveIndex(controllerHome: string): ActiveJobIndex {
  return readJsonFile<ActiveJobIndex>(activeIndexPath(controllerHome), {
    schemaVersion: 1,
    updatedAt: now(),
    jobs: [],
  });
}

function readRecentIndex(controllerHome: string): RecentJobIndex {
  return readJsonFile<RecentJobIndex>(recentIndexPath(controllerHome), {
    schemaVersion: 1,
    updatedAt: now(),
    jobs: [],
  });
}

const MAX_INLINE_JOB_RESULT_BYTES = 64 * 1024;
const MAX_INLINE_ERROR_MESSAGE_CHARS = 2_000;

function jsonByteLength(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function scrubErrorMessage(message: string): string {
  const scrubbed = message
    .replace(/\/Users\/[^\s"']+/g, '<abs-path>')
    .replace(/\/(?:private\/)?var\/folders\/[^\s"']+/g, '<abs-path>')
    .replace(/\/(?:private\/)?tmp\/[^\s"']+/g, '<abs-path>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<abs-path>');
  if (scrubbed.length <= MAX_INLINE_ERROR_MESSAGE_CHARS) return scrubbed;
  return `${scrubbed.slice(0, MAX_INLINE_ERROR_MESSAGE_CHARS)}...`;
}

function isArtifactPointer(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.artifactId === 'string' && typeof record.artifactKind === 'string';
}

function artifactPointerFor(job: ExecutionJob, artifact: ReturnType<typeof writeExecutionArtifact>, byteLength: number): Record<string, unknown> {
  return {
    externalized: true,
    byteLength,
    artifactId: artifact.artifactId,
    artifactKind: artifact.kind,
    detailPointer: {
      tool: 'get_artifact',
      repoId: job.repoId,
      artifactId: artifact.artifactId,
      maxBytes: 512 * 1024,
    },
    next: `Call get_artifact with repo_id=${job.repoId} and artifact_id=${artifact.artifactId}.`,
  };
}

function externalizeJobValue(
  controllerHome: string,
  job: ExecutionJob,
  kind: 'job-result' | 'job-error',
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (isArtifactPointer(value)) return value;
  const byteLength = jsonByteLength(value) ?? 0;
  const artifact = writeExecutionArtifact(controllerHome, job, kind, value);
  return artifactPointerFor(job, artifact, byteLength);
}

const INLINE_ERROR_DETAIL_KEYS = new Set([
  'workerLostReason',
  'heartbeatAgeMs',
  'attempt',
  'maxAttempts',
  'failureClass',
  'candidateId',
  'executionJobId',
  'executable',
  'cwd',
  'exitCode',
  'signal',
  'stderr',
  'stderrPath',
  'stderrTruncated',
  'processGroupId',
  'ownerPid',
  'ownerEpoch',
  'startupError',
]);

function inlineSafeErrorDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).filter(([key, value]) =>
    INLINE_ERROR_DETAIL_KEYS.has(key)
    && (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
  ));
}

function sanitizeJobForPersistence(controllerHome: string, job: ExecutionJob): ExecutionJob {
  const next: ExecutionJob = { ...job };
  if (next.error) {
    const error = { ...next.error, message: scrubErrorMessage(next.error.message) };
    if (error.details && !isArtifactPointer(error.details)) {
      const inlineDetails = inlineSafeErrorDetails(error.details);
      const pointer = externalizeJobValue(controllerHome, next, 'job-error', error.details);
      error.details = Object.keys(inlineDetails).length > 0
        ? { ...inlineDetails, ...pointer }
        : pointer;
    }
    next.error = error;
  }
  if (next.outcome?.infrastructureError?.message) {
    next.outcome = {
      ...next.outcome,
      infrastructureError: {
        ...next.outcome.infrastructureError,
        message: scrubErrorMessage(next.outcome.infrastructureError.message),
      },
    };
  }
  if (next.result && !isArtifactPointer(next.result)) {
    const resultBytes = jsonByteLength(next.result);
    if (resultBytes !== undefined && resultBytes > MAX_INLINE_JOB_RESULT_BYTES) {
      next.result = externalizeJobValue(controllerHome, next, 'job-result', next.result);
    }
  }
  return next;
}

function writeActiveIndex(controllerHome: string, index: ActiveJobIndex): void {
  const deduped = new Map(index.jobs.map((entry) => [entry.jobId, entry]));
  writeJsonAtomic(activeIndexPath(controllerHome), {
    schemaVersion: 1,
    updatedAt: now(),
    jobs: [...deduped.values()].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)).slice(-5000),
  } satisfies ActiveJobIndex);
}

function writeRecentIndex(controllerHome: string, index: RecentJobIndex): void {
  const deduped = new Map(index.jobs.map((entry) => [entry.jobId, entry]));
  writeJsonAtomic(recentIndexPath(controllerHome), {
    schemaVersion: 1,
    updatedAt: now(),
    jobs: [...deduped.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5000),
  } satisfies RecentJobIndex);
}

function upsertIndexesUnlocked(controllerHome: string, job: ExecutionJob): void {
  const index = readActiveIndex(controllerHome);
  index.jobs = index.jobs.filter((entry) => entry.jobId !== job.jobId);
  if (ACTIVE_JOB_STATUSES.has(job.status)) {
    index.jobs.push({
      jobId: job.jobId,
      repoId: job.repoId,
      status: job.status,
      priority: job.priority,
      queuedAt: job.queuedAt,
      updatedAt: job.updatedAt,
    });
  }
  writeActiveIndex(controllerHome, index);
  const recent = readRecentIndex(controllerHome);
  recent.jobs = recent.jobs.filter((entry) => entry.jobId !== job.jobId);
  recent.jobs.push({ jobId: job.jobId, repoId: job.repoId, createdAt: job.createdAt, updatedAt: job.updatedAt, status: job.status });
  writeRecentIndex(controllerHome, recent);
}

function upsertIndexes(controllerHome: string, job: ExecutionJob): void {
  withControllerLock(controllerHome, { scope: 'global', resource: 'execution-index' }, `execution-index:${job.jobId}`, () => {
    upsertIndexesUnlocked(controllerHome, job);
  }, 10_000);
}

/** Rebuild index entries from durable Job records during bounded startup recovery. */
export function rebuildExecutionJobIndexes(controllerHome: string, repoIds: string[] = []): void {
  withControllerLock(controllerHome, { scope: 'global', resource: 'execution-index' }, 'execution-index-rebuild', () => {
    const targetRepos = new Set(repoIds);
    const active = readActiveIndex(controllerHome);
    const recent = readRecentIndex(controllerHome);
    const activeEntries: ActiveJobIndex['jobs'] = [];
    const recentEntries: RecentJobIndex['jobs'] = [];
    for (const repoId of targetRepos) {
      const records = join(executionJobRoot(controllerHome, repoId), 'records');
      let names: string[] = [];
      try { names = readdirSync(records).filter((name) => name.endsWith('.json')).slice(0, 5000); } catch { continue; }
      for (const name of names) {
        try {
          const job = readJsonFile<ExecutionJob>(join(records, name));
          if (job.requestId) {
            writeJsonAtomic(requestPath(controllerHome, job.requestId), {
              schemaVersion: 1,
              requestId: job.requestId,
              semanticKey: job.semanticKey,
              jobId: job.jobId,
              repoId: job.repoId,
              createdAt: job.createdAt,
            } satisfies RequestIndexRecord);
          }
          recentEntries.push({ jobId: job.jobId, repoId: job.repoId, createdAt: job.createdAt, updatedAt: job.updatedAt, status: job.status });
          if (ACTIVE_JOB_STATUSES.has(job.status)) {
            activeEntries.push({ jobId: job.jobId, repoId: job.repoId, status: job.status, priority: job.priority, queuedAt: job.queuedAt, updatedAt: job.updatedAt });
          }
        } catch { /* malformed records are left for the existing repair surface */ }
      }
    }
    const activeRepoIds = targetRepos;
    active.jobs = active.jobs.filter((entry) => !activeRepoIds.has(entry.repoId)).concat(activeEntries);
    recent.jobs = recent.jobs.filter((entry) => !activeRepoIds.has(entry.repoId)).concat(recentEntries);
    writeActiveIndex(controllerHome, active);
    writeRecentIndex(controllerHome, recent);
  }, 10_000);
}

function persistJobRecord(controllerHome: string, job: ExecutionJob): ExecutionJob {
  const sanitized = sanitizeJobForPersistence(controllerHome, job);
  writeJsonAtomic(jobPath(controllerHome, sanitized.repoId, sanitized.jobId), sanitized);
  return sanitized;
}

function persistJob(controllerHome: string, job: ExecutionJob): ExecutionJob {
  const persisted = persistJobRecord(controllerHome, job);
  upsertIndexes(controllerHome, persisted);
  markRepositoryProjectionDirty(controllerHome, persisted.repoId, `job:${persisted.jobId}:${persisted.status}`);
  return persisted;
}

export function getExecutionJob(controllerHome: string, repoId: string, jobId: string): ExecutionJob {
  return readJsonFile<ExecutionJob>(jobPath(controllerHome, repoId, jobId));
}

export function getExecutionJobByRequestId(
  controllerHome: string,
  requestId: string,
  expectedRepoId?: string,
): ExecutionJob | undefined {
  const normalizedRequestId = requestId.trim();
  if (!normalizedRequestId) return undefined;
  const recordPath = requestPath(controllerHome, normalizedRequestId);
  if (!existsSync(recordPath)) return undefined;
  try {
    const record = readJsonFile<RequestIndexRecord>(recordPath);
    if (record.requestId !== normalizedRequestId) return undefined;
    if (expectedRepoId && record.repoId !== expectedRepoId) return undefined;
    return getExecutionJob(controllerHome, record.repoId, record.jobId);
  } catch {
    return undefined;
  }
}

export function findExecutionJob(controllerHome: string, jobId: string): ExecutionJob | undefined {
  const active = readActiveIndex(controllerHome).jobs.find((entry) => entry.jobId === jobId);
  if (active) {
    try { return getExecutionJob(controllerHome, active.repoId, jobId); } catch { /* continue */ }
  }
  const recent = readRecentIndex(controllerHome).jobs.find((entry) => entry.jobId === jobId);
  if (recent) {
    try { return getExecutionJob(controllerHome, recent.repoId, jobId); } catch { /* continue to legacy fallback */ }
  }
  const home = ensureControllerHome(controllerHome);
  const repositoriesRoot = join(home, 'repositories');
  try {
    for (const repoId of readdirSync(repositoriesRoot)) {
      const candidate = jobPath(home, repoId, jobId);
      if (existsSync(candidate)) return readJsonFile<ExecutionJob>(candidate);
    }
  } catch { /* no repositories */ }
  return undefined;
}

export function createExecutionJob(controllerHome: string, input: CreateExecutionJobInput): { job: ExecutionJob; deduplicated: boolean } {
  const home = ensureControllerHome(controllerHome);
  const normalizedRequestId = input.requestId.trim();
  if (!normalizedRequestId) throw new Error('REQUEST_ID_REQUIRED: every durable command must have a requestId');
  const normalizedSemanticKey = input.semanticKey.trim();
  if (!normalizedSemanticKey) throw new Error('SEMANTIC_KEY_REQUIRED: every durable command must have a semanticKey');

  const requestLockId = createHash('sha256').update(normalizedRequestId).digest('hex').slice(0, 24);
  return withControllerLock(home, { scope: 'global', resource: `execution-request-${requestLockId}` }, `create-job:${normalizedRequestId}`, () => {
    const requestRecordPath = requestPath(home, normalizedRequestId);
    if (existsSync(requestRecordPath)) {
      const record = readJsonFile<RequestIndexRecord>(requestRecordPath);
      const existing = getExecutionJob(home, record.repoId, record.jobId);
      if (record.semanticKey !== normalizedSemanticKey) {
        throw new Error(`REQUEST_ID_CONFLICT: ${normalizedRequestId} already belongs to ${record.semanticKey}`);
      }
      return { job: existing, deduplicated: true };
    }
    const createdAt = now();
    const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs ?? 15 * 60_000, 24 * 60 * 60_000));
    const job: ExecutionJob = {
      schemaVersion: 1,
      revision: 1,
      jobId: `EJOB-${Date.now()}-${randomUUID().slice(0, 8)}`,
      repoId: input.repoId,
      checkoutId: input.checkoutId,
      type: input.type,
      status: 'queued',
      priority: input.priority ?? 'P1',
      requestId: normalizedRequestId,
      semanticKey: normalizedSemanticKey,
      payload: input.payload,
      origin: input.origin,
      resourceClaims: input.resourceClaims ?? [],
      dependencies: input.dependencies ?? [],
      leaseRefs: [],
      createdAt,
      updatedAt: createdAt,
      queuedAt: createdAt,
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
      attempt: 0,
      maxAttempts: Math.max(1, Math.min(input.maxAttempts ?? 1, 10)),
      operationMetadata: input.operationMetadata,
      resources: input.resources,
      timings: {
        durablePersistedAt: createdAt,
        schedulerNotifiedAt: createdAt,
      },
      evidenceIds: [],
    };
    writeJsonAtomic(jobPath(home, job.repoId, job.jobId), job);
    writeJsonAtomic(requestRecordPath, {
      schemaVersion: 1,
      requestId: normalizedRequestId,
      semanticKey: normalizedSemanticKey,
      jobId: job.jobId,
      repoId: job.repoId,
      createdAt,
    } satisfies RequestIndexRecord);
    upsertIndexes(home, job);
    markRepositoryProjectionDirty(home, job.repoId, `job:${job.jobId}:created`);
    appendJobEvent(home, job, 'job_created', { type: job.type, priority: job.priority });
    touchSchedulerWakeSignal(home, `job-created:${job.jobId}`);
    return { job, deduplicated: false };
  }, 10_000);
}

export function updateExecutionJob(
  controllerHome: string,
  repoId: string,
  jobId: string,
  updater: (current: ExecutionJob) => ExecutionJob,
  eventType?: string,
  eventData?: Record<string, unknown>,
  notifyScheduler = false,
): ExecutionJob {
  return withControllerLock(controllerHome, { scope: 'task', repoId, taskId: `execution-job-${jobId}` }, `update-job:${jobId}`, () => {
    const current = getExecutionJob(controllerHome, repoId, jobId);
    const next = updater(structuredClone(current));
    if (next.jobId !== current.jobId || next.repoId !== current.repoId) throw new Error('JOB_IDENTITY_IMMUTABLE');
    next.revision = current.revision + 1;
    next.updatedAt = now();
    const persisted = persistJob(controllerHome, next);
    if (eventType) appendJobEvent(controllerHome, persisted, eventType, eventData);
    if (notifyScheduler) touchSchedulerWakeSignal(controllerHome, `job-updated:${jobId}`);
    return persisted;
  }, 10_000);
}

const WAITING_JOB_STATUSES = new Set<ExecutionJobStatus>([
  'queued', 'waiting_for_dependency', 'waiting_for_workspace', 'waiting_for_heavy_check',
  'waiting_for_integration', 'waiting_for_release_barrier', 'waiting_for_approval',
]);

function writeJobState(
  controllerHome: string,
  repoId: string,
  jobId: string,
  writer: (current: ExecutionJob) => { next: ExecutionJob; eventType?: string; eventData?: Record<string, unknown> } | undefined,
  reason: string,
): ExecutionJob | undefined {
  return withControllerLock(
    controllerHome,
    { scope: 'task', repoId, taskId: `execution-job-${jobId}` },
    reason,
    () => {
      const current = getExecutionJob(controllerHome, repoId, jobId);
      const written = writer(structuredClone(current));
      if (!written) return undefined;
      const { next, eventType, eventData } = written;
      if (next.jobId !== current.jobId || next.repoId !== current.repoId) throw new Error('JOB_IDENTITY_IMMUTABLE');
      next.revision = current.revision + 1;
      next.updatedAt = now();
      const persisted = persistJob(controllerHome, next);
      if (eventType) appendJobEvent(controllerHome, persisted, eventType, eventData);
      touchSchedulerWakeSignal(controllerHome, `job-state:${jobId}`);
      return persisted;
    },
    10_000,
  );
}

function transitionAllowed(from: ExecutionJobStatus, to: ExecutionJobStatus): boolean {
  if (from === to) return true;
  if (TERMINAL_JOB_STATUSES.has(from)) return false;
  if (WAITING_JOB_STATUSES.has(from)) {
    return WAITING_JOB_STATUSES.has(to)
      || ['running', 'cancelled', 'timed_out', 'human_attention_required'].includes(to);
  }
  if (from === 'running') {
    return ['queued', 'waiting_for_approval', 'succeeded', 'failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(to);
  }
  if (from === 'dispatched') {
    return ['queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(to);
  }
  return false;
}

export function transitionExecutionJob(
  controllerHome: string,
  repoId: string,
  jobId: string,
  status: ExecutionJobStatus,
  patch: Partial<ExecutionJob> = {},
  eventData?: Record<string, unknown>,
): ExecutionJob {
  // Terminal states require active writer fencing.
  const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'orphaned']);
  if (TERMINAL.has(status)) {
    try {
      const { assertThisRuntimeMayWriteOrThrow } = require('../../../cli/controller/stable-state/runtime-writer-context') as typeof import('../../../cli/controller/stable-state/runtime-writer-context');
      assertThisRuntimeMayWriteOrThrow('write_workflow_terminal', controllerHome);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('WRITER_FENCED:')) throw error;
    }
  }
  return updateExecutionJob(controllerHome, repoId, jobId, (current) => {
    if (!transitionAllowed(current.status, status)) {
      if (TERMINAL_JOB_STATUSES.has(current.status)) throw new Error(`JOB_ALREADY_TERMINAL: ${jobId} is ${current.status}`);
      throw new Error(`JOB_TRANSITION_INVALID: ${jobId} cannot move from ${current.status} to ${status}`);
    }
    const timestamp = now();
    const next: ExecutionJob = { ...current, ...patch, status };
    if (status === 'running' && !next.startedAt) next.startedAt = timestamp;
    if (TERMINAL_JOB_STATUSES.has(status)) {
      next.finishedAt = timestamp;
      next.workerPid = undefined;
    }
    return next;
  }, `job_${status}`, eventData, true);
}

export function claimExecutionJobForDispatch(
  controllerHome: string,
  repoId: string,
  jobId: string,
  leaseRefs: ExecutionJob['leaseRefs'],
  eventData?: Record<string, unknown>,
): ExecutionJob | undefined {
  return writeJobState(controllerHome, repoId, jobId, (current) => {
    if (!WAITING_JOB_STATUSES.has(current.status)) return undefined;
    return {
      next: {
        ...current,
        status: 'dispatched',
        attempt: current.attempt + 1,
        workerPid: undefined,
        heartbeatAt: undefined,
        leaseRefs,
        timings: {
          ...current.timings,
          schedulerObservedAt: now(),
          leaseCreatedAt: leaseRefs.length > 0 ? now() : current.timings?.leaseCreatedAt,
        },
      },
      eventType: 'job_dispatched',
      eventData,
    };
  }, `claim-job:${jobId}`);
}

export function attachExecutionWorker(
  controllerHome: string,
  repoId: string,
  jobId: string,
  workerPid: number,
): ExecutionJob | undefined {
  return writeJobState(controllerHome, repoId, jobId, (current) => {
    const spawnable = current.status === 'dispatched' || (current.status === 'running' && current.workerPid === undefined);
    if (!spawnable) return current.workerPid === workerPid ? { next: current } : undefined;
    if (current.workerPid !== undefined && current.workerPid !== workerPid) return undefined;
    const timestamp = now();
    return {
      next: {
        ...current,
        status: 'running',
        workerPid,
        workerLifecycle: current.workerLifecycle
          ? {
              ...current.workerLifecycle,
              attachedAt: timestamp,
              processGroupId: process.platform !== 'win32' ? workerPid : undefined,
              workerPid,
              startupState: 'registered',
            }
          : current.workerLifecycle,
        heartbeatAt: timestamp,
        startedAt: current.startedAt ?? timestamp,
        timings: {
          ...current.timings,
          workerRunningAt: timestamp,
        },
      },
      eventType: 'job_running',
      eventData: { workerPid },
    };
  }, `attach-worker:${jobId}`);
}

function sameLeaseRefs(
  current: ExecutionJob['leaseRefs'],
  expected: Array<Pick<ExecutionJob['leaseRefs'][number], 'leaseId' | 'fencingToken'>>,
): boolean {
  if (current.length !== expected.length) return false;
  const tokens = new Map(current.map((ref) => [ref.leaseId, ref.fencingToken]));
  return expected.every((ref) => tokens.get(ref.leaseId) === ref.fencingToken);
}

export function heartbeatExecutionJob(
  controllerHome: string,
  repoId: string,
  jobId: string,
  workerPid: number,
  expectedAttempt?: number,
): ExecutionJob {
  return withControllerLock(controllerHome, { scope: 'task', repoId, taskId: `execution-job-${jobId}` }, `heartbeat-job:${jobId}`, () => {
    const current = getExecutionJob(controllerHome, repoId, jobId);
    if (current.status !== 'running') throw new Error(`WORKER_OWNERSHIP_LOST: ${jobId} is ${current.status}`);
    if (expectedAttempt !== undefined && current.attempt !== expectedAttempt) {
      throw new Error(`WORKER_OWNERSHIP_LOST: ${jobId} attempt ${expectedAttempt} was replaced by ${current.attempt}`);
    }
    if (current.workerPid !== undefined && current.workerPid !== workerPid) {
      throw new Error(`WORKER_OWNERSHIP_LOST: ${jobId} belongs to PID ${current.workerPid}`);
    }
    const next: ExecutionJob = {
      ...current,
      revision: current.revision + 1,
      updatedAt: now(),
      heartbeatAt: now(),
      workerPid,
    };
    // Heartbeats are intentionally record-only. They must not rewrite the global
    // active/recent indexes, dirty the repository projection, emit evidence, or
    // wake the scheduler every few seconds.
    return persistJobRecord(controllerHome, next);
  }, 10_000);
}

export function transitionExecutionJobFromWorker(
  controllerHome: string,
  repoId: string,
  jobId: string,
  owner: {
    workerPid: number;
    attempt: number;
    leaseRefs: Array<Pick<ExecutionJob['leaseRefs'][number], 'leaseId' | 'fencingToken'>>;
  },
  status: Extract<ExecutionJobStatus, 'waiting_for_approval' | 'succeeded' | 'failed' | 'human_attention_required'>,
  patch: Partial<ExecutionJob> = {},
  eventData?: Record<string, unknown>,
): ExecutionJob {
  return updateExecutionJob(controllerHome, repoId, jobId, (current) => {
    if (current.status !== 'running'
      || current.workerPid !== owner.workerPid
      || current.attempt !== owner.attempt
      || !sameLeaseRefs(current.leaseRefs, owner.leaseRefs)) {
      throw new Error(`WORKER_OWNERSHIP_LOST: ${jobId} attempt ${owner.attempt} may not publish a terminal state`);
    }
    const timestamp = now();
    return {
      ...current,
      ...patch,
      status,
      ...(status === 'waiting_for_approval' ? { finishedAt: undefined } : { finishedAt: timestamp }),
      workerPid: undefined,
    };
  }, `job_${status}`, eventData, true);
}

export function listActiveExecutionJobs(controllerHome: string, repoId?: string): ExecutionJob[] {
  const index = readActiveIndex(controllerHome);
  const output: ExecutionJob[] = [];
  for (const entry of index.jobs) {
    if (repoId && entry.repoId !== repoId) continue;
    try {
      const job = getExecutionJob(controllerHome, entry.repoId, entry.jobId);
      if (ACTIVE_JOB_STATUSES.has(job.status)) output.push(job);
    } catch { /* stale index repaired below */ }
  }
  return output;
}

function executionJobApprovalRequestId(job: ExecutionJob): string | undefined {
  if (typeof job.result?.approvalRequestId === 'string') return job.result.approvalRequestId;
  const authorization = job.result?.authorization;
  return authorization && typeof authorization === 'object' && typeof (authorization as Record<string, unknown>).approvalRequestId === 'string'
    ? String((authorization as Record<string, unknown>).approvalRequestId)
    : undefined;
}

export function resumeExecutionJobAfterApproval(
  controllerHome: string,
  repoId: string,
  approvalRequestId: string,
): ExecutionJob | undefined {
  const waiting = listActiveExecutionJobs(controllerHome, repoId).find((job) =>
    job.status === 'waiting_for_approval' && executionJobApprovalRequestId(job) === approvalRequestId,
  );
  if (!waiting) return undefined;
  const args = waiting.payload.arguments ?? {};
  return transitionExecutionJob(controllerHome, repoId, waiting.jobId, 'queued', {
    payload: {
      ...waiting.payload,
      arguments: { ...args, approval_request_id: approvalRequestId },
    },
    result: undefined,
    error: undefined,
    outcome: undefined,
    workerPid: undefined,
    leaseRefs: [],
    startedAt: undefined,
    heartbeatAt: undefined,
    finishedAt: undefined,
  }, { approvalRequestId, resumed: true });
}

export function listExecutionJobs(controllerHome: string, repoId: string, limit = 100): ExecutionJob[] {
  const boundedLimit = Math.max(1, Math.min(limit, 1000));
  const output: ExecutionJob[] = [];
  for (const entry of readRecentIndex(controllerHome).jobs) {
    if (entry.repoId !== repoId) continue;
    try { output.push(getExecutionJob(controllerHome, repoId, entry.jobId)); } catch { /* stale index entry */ }
    if (output.length >= boundedLimit) break;
  }
  if (output.length > 0) return output;

  // Backward-compatible one-time fallback for state created before the recent index existed.
  const records = join(executionJobRoot(controllerHome, repoId), 'records');
  try {
    const legacy = readdirSync(records)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJsonFile<ExecutionJob>(join(records, name)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, boundedLimit);
    // Keep this fallback read-only. Index migration belongs to an explicit
    // maintenance path; a status/read request must never acquire the global
    // execution-index lock or rewrite thousands of entries.
    return legacy;
  } catch { return []; }
}

export async function cancelExecutionJob(controllerHome: string, repoId: string, jobId: string, reason = 'Cancelled by user'): Promise<ExecutionJob> {
  const current = getExecutionJob(controllerHome, repoId, jobId);
  if (TERMINAL_JOB_STATUSES.has(current.status)) return current;
  const cancelled = transitionExecutionJob(controllerHome, repoId, jobId, 'cancelled', {
    error: { code: 'CANCELLED', message: reason, retryable: false },
    leaseRefs: [],
  }, { reason });
  releaseExecutionLeases(controllerHome, repoId, jobId, current.leaseRefs);
  await terminateProcessTree(current.workerPid);
  return cancelled;
}

export function removeExecutionJobFromActiveIndex(controllerHome: string, job: ExecutionJob): void {
  withControllerLock(controllerHome, { scope: 'global', resource: 'execution-index' }, `execution-index-remove:${job.jobId}`, () => {
    const active = readActiveIndex(controllerHome);
    active.jobs = active.jobs.filter((entry) => entry.jobId !== job.jobId);
    writeActiveIndex(controllerHome, active);
  }, 10_000);
}

export function removeRequestIndex(controllerHome: string, requestId: string): void {
  removeFile(requestPath(controllerHome, requestId));
}
