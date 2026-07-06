import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { findExecutionJob } from '../execution/jobs/store';
import type { LocalBridgeJob } from '../../cli/local-bridge/types';

export type RuntimeStorageRepairCandidateKind =
  | 'missing_job_json'
  | 'unreadable_job_json'
  | 'unexpected_local_job_entry'
  | 'stale_active_local_job'
  | 'missing_projected_execution_job';

export interface RuntimeStorageRepairCandidate {
  candidateId: string;
  repoId: string;
  rootKind: 'repository' | 'controller';
  rootPath: string;
  jobId: string;
  jobDir: string;
  kind: RuntimeStorageRepairCandidateKind;
  status?: string;
  action: 'quarantine' | 'terminalize';
  safe: boolean;
  reason: string;
  ageMinutes?: number;
  executionJobId?: string;
  controllerHome?: string;
}

export interface RuntimeStorageRepairPreview {
  schemaVersion: 1;
  generatedAt: string;
  repoId: string;
  inspectedRoots: Array<{ kind: 'repository' | 'controller'; path: string; exists: boolean }>;
  candidates: RuntimeStorageRepairCandidate[];
  safeCandidateCount: number;
  unsafeCandidateCount: number;
  mutates: false;
  safety: {
    repoScoped: true;
    crossRepositoryCleanup: false;
    processKill: false;
    deletesSourceFiles: false;
  };
}

export type RuntimeStorageRepairApplyResult = Omit<RuntimeStorageRepairPreview, 'mutates'> & {
  mutates: true;
  applied: Array<{ candidateId: string; action: RuntimeStorageRepairCandidate['action']; path: string; status: 'applied' | 'skipped' | 'failed'; message: string }>;
  auditPath: string;
};

const ACTIVE_LOCAL_JOB_STATUSES = new Set(['pending_approval', 'approved', 'dispatched', 'running']);
const TERMINAL_LOCAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'orphaned', 'stale', 'cancelled']);
const DEFAULT_MIN_AGE_MINUTES = 0;

function now(): string { return new Date().toISOString(); }

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: 'utf-8', flag: 'a' });
}

function sanitizeComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function ageMinutesFrom(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.floor((Date.now() - parsed) / 60_000));
}

function safeContained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
}

function jobIdFromEntry(entry: string): string {
  return sanitizeComponent(entry);
}

function readJob(path: string): LocalBridgeJob {
  return JSON.parse(readFileSync(path, 'utf-8')) as LocalBridgeJob;
}

function projectedExecutionJobId(job: LocalBridgeJob): string | undefined {
  return typeof job.result?.executionJobId === 'string' && job.result.executionJobId.trim()
    ? job.result.executionJobId.trim()
    : undefined;
}

function projectedExecutionControllerHome(job: LocalBridgeJob, fallbackControllerHome: string): string {
  return typeof job.result?.controllerHome === 'string' && job.result.controllerHome.trim()
    ? job.result.controllerHome.trim()
    : fallbackControllerHome;
}

function shouldInspectJobDir(entryName: string): boolean {
  return entryName !== '.repo-harness-owner.json' && entryName !== 'active-index.json';
}

function buildCandidateId(rootKind: 'repository' | 'controller', jobId: string, kind: RuntimeStorageRepairCandidateKind): string {
  return `RSR-${rootKind}-${sanitizeComponent(jobId)}-${kind}`;
}

function collectRoot(
  repository: RepositoryRecord,
  rootKind: 'repository' | 'controller',
  rootPath: string,
  fallbackControllerHome: string,
  minAgeMinutes: number,
): RuntimeStorageRepairCandidate[] {
  if (!existsSync(rootPath)) return [];
  const candidates: RuntimeStorageRepairCandidate[] = [];
  let entries;
  try {
    entries = readdirSync(rootPath, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
  for (const entry of entries) {
    const entryName = String(entry.name);
    if (!shouldInspectJobDir(entryName)) continue;
    const entryPath = join(rootPath, entryName);
    const jobId = jobIdFromEntry(entryName);
    if (!entry.isDirectory()) {
      candidates.push({
        candidateId: buildCandidateId(rootKind, jobId, 'unexpected_local_job_entry'),
        repoId: repository.repoId,
        rootKind,
        rootPath,
        jobId,
        jobDir: entryPath,
        kind: 'unexpected_local_job_entry',
        action: 'quarantine',
        safe: safeContained(rootPath, entryPath),
        reason: 'Local job storage contains a non-directory entry. Quarantine is reversible and repo-scoped.',
      });
      continue;
    }
    const jobPath = join(entryPath, 'job.json');
    if (!existsSync(jobPath)) {
      candidates.push({
        candidateId: buildCandidateId(rootKind, jobId, 'missing_job_json'),
        repoId: repository.repoId,
        rootKind,
        rootPath,
        jobId,
        jobDir: entryPath,
        kind: 'missing_job_json',
        action: 'quarantine',
        safe: safeContained(rootPath, entryPath),
        reason: 'Local job directory is missing job.json, so it cannot represent a live job safely.',
      });
      continue;
    }
    let job: LocalBridgeJob;
    try {
      job = readJob(jobPath);
    } catch (_error) {
      candidates.push({
        candidateId: buildCandidateId(rootKind, jobId, 'unreadable_job_json'),
        repoId: repository.repoId,
        rootKind,
        rootPath,
        jobId,
        jobDir: entryPath,
        kind: 'unreadable_job_json',
        action: 'quarantine',
        safe: safeContained(rootPath, entryPath),
        reason: 'Local job metadata is unreadable and blocks runtime storage readiness.',
      });
      continue;
    }
    if (!ACTIVE_LOCAL_JOB_STATUSES.has(job.status)) continue;
    const age = ageMinutesFrom(job.updatedAt ?? job.createdAt);
    const oldEnough = age === undefined || age >= minAgeMinutes;
    const executionJobId = projectedExecutionJobId(job);
    if (executionJobId) {
      const controllerHome = projectedExecutionControllerHome(job, fallbackControllerHome);
      const projected = findExecutionJob(controllerHome, executionJobId);
      if (!projected && oldEnough) {
        candidates.push({
          candidateId: buildCandidateId(rootKind, job.jobId || jobId, 'missing_projected_execution_job'),
          repoId: repository.repoId,
          rootKind,
          rootPath,
          jobId: job.jobId || jobId,
          jobDir: entryPath,
          kind: 'missing_projected_execution_job',
          status: job.status,
          action: 'terminalize',
          safe: true,
          reason: 'Local Job was projected to a durable Execution Job, but the durable record is missing. Terminalizing prevents a permanent runtime-storage deadlock.',
          ageMinutes: age,
          executionJobId,
          controllerHome,
        });
      }
      continue;
    }
    if (oldEnough) {
      candidates.push({
        candidateId: buildCandidateId(rootKind, job.jobId || jobId, 'stale_active_local_job'),
        repoId: repository.repoId,
        rootKind,
        rootPath,
        jobId: job.jobId || jobId,
        jobDir: entryPath,
        kind: 'stale_active_local_job',
        status: job.status,
        action: 'terminalize',
        safe: job.status !== 'running' || job.ownerPid === undefined,
        reason: 'Local Job remains active without a durable projection. Terminalization is safe when no worker ownership is present.',
        ageMinutes: age,
      });
    }
  }
  return candidates;
}

function roots(repository: RepositoryRecord, controllerHome: string): RuntimeStorageRepairPreview['inspectedRoots'] {
  return [
    { kind: 'repository', path: join(repository.canonicalRoot, '.ai', 'harness', 'local-jobs'), exists: existsSync(join(repository.canonicalRoot, '.ai', 'harness', 'local-jobs')) },
    { kind: 'controller', path: join(repositoryControllerRoot(controllerHome, repository.repoId), 'local-jobs'), exists: existsSync(join(repositoryControllerRoot(controllerHome, repository.repoId), 'local-jobs')) },
  ];
}

export function previewRuntimeStorageRepair(
  repository: RepositoryRecord,
  controllerHome: string,
  input: { minAgeMinutes?: number; maxCandidates?: number } = {},
): RuntimeStorageRepairPreview {
  const minAgeMinutes = Math.max(0, Math.floor(input.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES));
  const maxCandidates = Math.max(1, Math.min(Math.floor(input.maxCandidates ?? 100), 500));
  const inspectedRoots = roots(repository, controllerHome);
  const candidates = inspectedRoots.flatMap((root) => root.exists
    ? collectRoot(repository, root.kind, root.path, controllerHome, minAgeMinutes)
    : []).slice(0, maxCandidates);
  return {
    schemaVersion: 1,
    generatedAt: now(),
    repoId: repository.repoId,
    inspectedRoots,
    candidates,
    safeCandidateCount: candidates.filter((candidate) => candidate.safe).length,
    unsafeCandidateCount: candidates.filter((candidate) => !candidate.safe).length,
    mutates: false,
    safety: {
      repoScoped: true,
      crossRepositoryCleanup: false,
      processKill: false,
      deletesSourceFiles: false,
    },
  };
}

function quarantinePath(repository: RepositoryRecord, candidate: RuntimeStorageRepairCandidate): string {
  const stamp = now().replace(/[:.]/g, '-');
  return join(repository.canonicalRoot, '.ai', 'harness', 'quarantine', 'local-jobs', `${stamp}-${candidate.rootKind}-${basename(candidate.jobDir)}`);
}

function terminalize(candidate: RuntimeStorageRepairCandidate): string {
  const jobPath = join(candidate.jobDir, 'job.json');
  const job = readJob(jobPath);
  if (TERMINAL_LOCAL_JOB_STATUSES.has(job.status)) return 'already terminal';
  job.status = 'failed';
  job.finishedAt = now();
  job.workerPid = undefined;
  job.error = candidate.kind === 'missing_projected_execution_job'
    ? `Runtime storage repair terminalized ${job.jobId}: projected Execution Job ${candidate.executionJobId} is missing.`
    : `Runtime storage repair terminalized ${job.jobId}: ${candidate.reason}`;
  job.outcome = {
    ...(job.outcome ?? {}),
    infrastructureError: {
      code: candidate.kind === 'missing_projected_execution_job'
        ? 'MISSING_PROJECTED_EXECUTION_JOB'
        : 'RUNTIME_STORAGE_REPAIR_TERMINALIZED',
      message: job.error,
    },
  };
  atomicWriteJson(jobPath, job);
  appendJsonLine(join(candidate.jobDir, 'events.jsonl'), {
    at: now(),
    type: 'job_failed',
    message: job.error,
    data: {
      repairedBy: 'runtime_storage_repair_apply',
      candidateId: candidate.candidateId,
      executionJobId: candidate.executionJobId,
    },
  });
  return job.error;
}

function quarantine(repository: RepositoryRecord, candidate: RuntimeStorageRepairCandidate): string {
  const target = quarantinePath(repository, candidate);
  mkdirSync(dirname(target), { recursive: true });
  if (!safeContained(candidate.rootPath, candidate.jobDir)) throw new Error('candidate path escapes local-jobs root');
  const stat = lstatSync(candidate.jobDir);
  if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) throw new Error('unsupported local job entry type');
  renameSync(candidate.jobDir, target);
  return target;
}

function rebuildActiveIndex(rootPath: string): void {
  if (!existsSync(rootPath)) return;
  const jobIds: string[] = [];
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const entryName = String(entry.name);
    if (!entry.isDirectory()) continue;
    const jobPath = join(rootPath, entryName, 'job.json');
    if (!existsSync(jobPath)) continue;
    try {
      const job = readJob(jobPath);
      if (ACTIVE_LOCAL_JOB_STATUSES.has(job.status)) jobIds.push(job.jobId || entryName);
    } catch (_error) {
      // Unreadable jobs are handled by quarantine candidates.
    }
  }
  atomicWriteJson(join(rootPath, 'active-index.json'), {
    schemaVersion: 1,
    ownerPid: process.pid,
    updatedAt: now(),
    jobIds: Array.from(new Set(jobIds)).sort((a, b) => b.localeCompare(a)),
  });
}

export function applyRuntimeStorageRepair(
  repository: RepositoryRecord,
  controllerHome: string,
  input: { confirmRepair?: boolean; candidateIds?: string[]; minAgeMinutes?: number; maxCandidates?: number } = {},
): RuntimeStorageRepairApplyResult {
  if (input.confirmRepair !== true) throw new Error('RUNTIME_STORAGE_REPAIR_CONFIRMATION_REQUIRED: confirm_repair must be true');
  const preview = previewRuntimeStorageRepair(repository, controllerHome, input);
  const selected = new Set(input.candidateIds ?? preview.candidates.filter((candidate) => candidate.safe).map((candidate) => candidate.candidateId));
  const applied: RuntimeStorageRepairApplyResult['applied'] = [];
  for (const candidate of preview.candidates) {
    if (!selected.has(candidate.candidateId)) continue;
    if (!candidate.safe) {
      applied.push({ candidateId: candidate.candidateId, action: candidate.action, path: candidate.jobDir, status: 'skipped', message: 'candidate is not marked safe' });
      continue;
    }
    try {
      const message = candidate.action === 'terminalize'
        ? terminalize(candidate)
        : quarantine(repository, candidate);
      applied.push({ candidateId: candidate.candidateId, action: candidate.action, path: candidate.jobDir, status: 'applied', message });
    } catch (error) {
      applied.push({ candidateId: candidate.candidateId, action: candidate.action, path: candidate.jobDir, status: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const root of preview.inspectedRoots) {
    if (root.exists) rebuildActiveIndex(root.path);
  }
  const auditPath = join(repository.canonicalRoot, '.ai', 'harness', 'controller', 'runtime-storage-repair.jsonl');
  appendJsonLine(auditPath, {
    schemaVersion: 1,
    at: now(),
    actor: 'runtime_storage_repair_apply',
    repoId: repository.repoId,
    inspectedRoots: preview.inspectedRoots,
    applied,
  });
  return {
    ...preview,
    generatedAt: now(),
    mutates: true,
    applied,
    auditPath: relative(repository.canonicalRoot, auditPath),
  };
}
