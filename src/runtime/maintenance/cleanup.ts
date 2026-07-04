import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { tmpdir } from 'os';

export interface RuntimeCleanupCandidate {
  kind: 'temp_dir' | 'local_job' | 'legacy_run' | 'attention_marker';
  path?: string;
  id?: string;
  reason: string;
  ageMinutes?: number;
  occupiedByPid?: number;
  safe: boolean;
}

export interface RuntimeCleanupPreview {
  schemaVersion: 1;
  generatedAt: string;
  repoRoot: string;
  mode: 'preview';
  candidates: RuntimeCleanupCandidate[];
  summary: {
    total: number;
    safe: number;
    unsafe: number;
    tempDirs: number;
    localJobs: number;
    legacyRuns: number;
    attentionMarkers: number;
  };
  warnings: string[];
}

export interface RuntimeCleanupApplyResult extends Omit<RuntimeCleanupPreview, 'mode'> {
  mode: 'apply';
  applied: Array<RuntimeCleanupCandidate & { applied: boolean; error?: string }>;
}

export interface RuntimeCleanupOptions {
  minAgeMinutes?: number;
  includeTempDirs?: boolean;
  includeTerminalLocalJobs?: boolean;
  includeLegacyRuns?: boolean;
  includeHistoricalAttention?: boolean;
  maxCandidates?: number;
  confirmCleanup?: boolean;
}

function now(): string { return new Date().toISOString(); }

function safeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function normalizeOptions(options: RuntimeCleanupOptions): Required<Omit<RuntimeCleanupOptions, 'confirmCleanup'>> & { confirmCleanup: boolean } {
  return {
    minAgeMinutes: safeNumber(options.minAgeMinutes, 60),
    includeTempDirs: options.includeTempDirs !== false,
    includeTerminalLocalJobs: options.includeTerminalLocalJobs === true,
    includeLegacyRuns: options.includeLegacyRuns === true,
    includeHistoricalAttention: options.includeHistoricalAttention === true,
    maxCandidates: Math.max(1, Math.min(safeNumber(options.maxCandidates, 200), 500)),
    confirmCleanup: options.confirmCleanup === true,
  };
}

function processCommands(): Array<{ pid: number; command: string }> {
  try {
    return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
      .split('\n')
      .flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
      });
  } catch {
    return [];
  }
}

function isSafeRepoHarnessTemp(path: string): boolean {
  const name = basename(path);
  if (!name.startsWith('repo-harness')) return false;
  const parent = dirname(path);
  const allowedParents = new Set([resolve(tmpdir()), '/private/tmp', '/tmp']);
  return allowedParents.has(resolve(parent));
}

function scanTempDirs(minAgeMinutes: number, limit: number): RuntimeCleanupCandidate[] {
  const roots = Array.from(new Set([tmpdir(), '/private/tmp', '/tmp'].filter((root) => existsSync(root)).map((root) => resolve(root))));
  const processes = processCommands();
  const at = Date.now();
  const candidates: RuntimeCleanupCandidate[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try { names = readdirSync(root).filter((name) => name.startsWith('repo-harness')); } catch { continue; }
    for (const name of names) {
      const path = join(root, name);
      if (!isSafeRepoHarnessTemp(path)) continue;
      try {
        const stat = lstatSync(path);
        if (!stat.isDirectory()) continue;
        const occupied = processes.find((process) => process.command.includes(path));
        const ageMinutes = Math.max(0, Math.round((at - stat.mtimeMs) / 60_000));
        const safe = !occupied && ageMinutes >= minAgeMinutes;
        candidates.push({
          kind: 'temp_dir',
          path,
          reason: safe
            ? `Repo-harness temp directory is older than ${minAgeMinutes} minutes and not referenced by a running process.`
            : 'Temp directory is too new or still referenced by a running process.',
          ageMinutes,
          occupiedByPid: occupied?.pid,
          safe,
        });
      } catch {
        // Ignore racing temp entries.
      }
    }
  }
  return candidates.sort((a, b) => (b.ageMinutes ?? 0) - (a.ageMinutes ?? 0)).slice(0, limit);
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function terminalStatus(status: unknown): boolean {
  return ['succeeded', 'failed', 'cancelled', 'timed_out', 'rejected'].includes(String(status));
}

function scanTerminalLocalJobs(repoRoot: string, minAgeMinutes: number, limit: number): RuntimeCleanupCandidate[] {
  const root = join(repoRoot, '.ai/harness/local-jobs');
  if (!existsSync(root)) return [];
  const at = Date.now();
  const candidates: RuntimeCleanupCandidate[] = [];
  for (const name of readdirSync(root).slice(0, limit * 3)) {
    const path = join(root, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory()) continue;
      const jobJson = readJson(join(path, 'job.json')) as Record<string, unknown> | undefined;
      const ageMinutes = Math.max(0, Math.round((at - stat.mtimeMs) / 60_000));
      const safe = ageMinutes >= minAgeMinutes && terminalStatus(jobJson?.status);
      candidates.push({
        kind: 'local_job',
        path,
        id: typeof jobJson?.jobId === 'string' ? jobJson.jobId : name,
        reason: safe ? 'Terminal local job is old enough to archive.' : 'Local job is not terminal or is too new.',
        ageMinutes,
        safe,
      });
    } catch {
      // Ignore malformed entries.
    }
  }
  return candidates.filter((candidate) => candidate.safe).slice(0, limit);
}

function textIncludesNoOpIntegrate(value: unknown): boolean {
  const text = JSON.stringify(value ?? '').toLowerCase();
  return text.includes('no changes to integrate')
    || text.includes('nothing to integrate')
    || text.includes('no diff')
    || text.includes('没有可集成')
    || text.includes('无变更');
}

function findRunState(path: string): Record<string, unknown> | undefined {
  const candidateFiles = ['run.json', 'task-run.json', 'state.json', 'metadata.json'];
  for (const file of candidateFiles) {
    const state = readJson(join(path, file));
    if (state && typeof state === 'object') return state as Record<string, unknown>;
  }
  for (const file of readdirSync(path).filter((entry) => entry.endsWith('.json')).slice(0, 10)) {
    const state = readJson(join(path, file));
    if (state && typeof state === 'object') return state as Record<string, unknown>;
  }
  return undefined;
}

function scanLegacyRuns(repoRoot: string, minAgeMinutes: number, limit: number): RuntimeCleanupCandidate[] {
  const root = join(repoRoot, '.ai/harness/jobs');
  if (!existsSync(root)) return [];
  const processes = processCommands();
  const at = Date.now();
  const candidates: RuntimeCleanupCandidate[] = [];
  for (const name of readdirSync(root).filter((entry) => entry.startsWith('RUN-')).slice(0, limit * 3)) {
    const path = join(root, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory()) continue;
      const state = findRunState(path);
      const occupied = processes.find((process) => process.command.includes(name) || process.command.includes(path));
      const status = String(state?.status ?? 'unknown');
      const ageMinutes = Math.max(0, Math.round((at - stat.mtimeMs) / 60_000));
      const safe = !occupied && ageMinutes >= minAgeMinutes && status === 'waiting_for_user' && textIncludesNoOpIntegrate(state);
      candidates.push({
        kind: 'legacy_run',
        path,
        id: typeof state?.runId === 'string' ? state.runId : name,
        reason: safe
          ? 'Legacy task run is waiting_for_user only because its worktree has no changes to integrate; it is safe to archive.'
          : `Legacy task run is not a proven no-op waiting_for_user run. status=${status}`,
        ageMinutes,
        occupiedByPid: occupied?.pid,
        safe,
      });
    } catch {
      candidates.push({
        kind: 'legacy_run',
        path,
        id: name,
        reason: 'Legacy task run directory is unreadable; review manually before archiving.',
        safe: false,
      });
    }
  }
  return candidates.sort((a, b) => (b.ageMinutes ?? 0) - (a.ageMinutes ?? 0)).slice(0, limit);
}

function scanHistoricalAttention(repoRoot: string): RuntimeCleanupCandidate[] {
  const projectionPath = join(repoRoot, '.ai/harness/controller/runtime-projection.json');
  const projection = readJson(projectionPath) as Record<string, unknown> | undefined;
  const attention = Array.isArray(projection?.attention) ? projection.attention : [];
  return attention.flatMap((entry): RuntimeCleanupCandidate[] => {
    if (!entry || typeof entry !== 'object') return [];
    const raw = entry as Record<string, unknown>;
    if (raw.status !== 'orphaned') return [];
    const jobId = typeof raw.jobId === 'string' ? raw.jobId : undefined;
    return [{
      kind: 'attention_marker',
      id: jobId,
      path: projectionPath,
      reason: 'Historical orphaned attention marker can be acknowledged when no matching worker process exists.',
      safe: true,
    }];
  });
}

function summarize(candidates: RuntimeCleanupCandidate[]): RuntimeCleanupPreview['summary'] {
  return {
    total: candidates.length,
    safe: candidates.filter((candidate) => candidate.safe).length,
    unsafe: candidates.filter((candidate) => !candidate.safe).length,
    tempDirs: candidates.filter((candidate) => candidate.kind === 'temp_dir').length,
    localJobs: candidates.filter((candidate) => candidate.kind === 'local_job').length,
    legacyRuns: candidates.filter((candidate) => candidate.kind === 'legacy_run').length,
    attentionMarkers: candidates.filter((candidate) => candidate.kind === 'attention_marker').length,
  };
}

export function previewRuntimeCleanup(repoRoot: string, options: RuntimeCleanupOptions = {}): RuntimeCleanupPreview {
  const normalized = normalizeOptions(options);
  const candidates = [
    ...(normalized.includeTempDirs ? scanTempDirs(normalized.minAgeMinutes, normalized.maxCandidates) : []),
    ...(normalized.includeTerminalLocalJobs ? scanTerminalLocalJobs(repoRoot, normalized.minAgeMinutes, normalized.maxCandidates) : []),
    ...(normalized.includeLegacyRuns ? scanLegacyRuns(repoRoot, normalized.minAgeMinutes, normalized.maxCandidates) : []),
    ...(normalized.includeHistoricalAttention ? scanHistoricalAttention(repoRoot) : []),
  ].slice(0, normalized.maxCandidates);
  return {
    schemaVersion: 1,
    generatedAt: now(),
    repoRoot,
    mode: 'preview',
    candidates,
    summary: summarize(candidates),
    warnings: [
      'Preview is non-destructive. Apply requires confirmCleanup=true.',
      'Legacy run cleanup only archives directories proven to be old no-op waiting_for_user runs with no matching process.',
      'Historical attention cleanup is intentionally represented as acknowledgement guidance unless an explicit reconciler is added.',
    ],
  };
}

function archiveLocalJob(path: string, repoRoot: string): void {
  const archiveRoot = join(repoRoot, '.ai/harness/local-jobs-archive');
  mkdirSync(archiveRoot, { recursive: true });
  renameSync(path, join(archiveRoot, basename(path)));
}

function archiveLegacyRun(path: string, repoRoot: string): void {
  const archiveRoot = join(repoRoot, '.ai/harness/jobs-archive/legacy-noop');
  mkdirSync(archiveRoot, { recursive: true });
  renameSync(path, join(archiveRoot, basename(path)));
}

export function applyRuntimeCleanup(repoRoot: string, options: RuntimeCleanupOptions = {}): RuntimeCleanupApplyResult {
  const normalized = normalizeOptions(options);
  if (!normalized.confirmCleanup) throw new Error('RUNTIME_CLEANUP_CONFIRMATION_REQUIRED: confirmCleanup=true is required.');
  const preview = previewRuntimeCleanup(repoRoot, normalized);
  const applied = preview.candidates.filter((candidate) => candidate.safe).map((candidate) => {
    try {
      if (candidate.kind === 'temp_dir' && candidate.path && isSafeRepoHarnessTemp(candidate.path)) {
        rmSync(candidate.path, { recursive: true, force: true });
        return { ...candidate, applied: true };
      }
      if (candidate.kind === 'local_job' && candidate.path) {
        const relativePath = relative(join(repoRoot, '.ai/harness/local-jobs'), candidate.path);
        if (relativePath && !relativePath.startsWith('..')) {
          archiveLocalJob(candidate.path, repoRoot);
          return { ...candidate, applied: true };
        }
      }
      if (candidate.kind === 'legacy_run' && candidate.path) {
        const relativePath = relative(join(repoRoot, '.ai/harness/jobs'), candidate.path);
        if (relativePath && !relativePath.startsWith('..') && basename(candidate.path).startsWith('RUN-')) {
          archiveLegacyRun(candidate.path, repoRoot);
          return { ...candidate, applied: true };
        }
      }
      if (candidate.kind === 'attention_marker') {
        const notePath = join(repoRoot, '.ai/harness/controller/acknowledged-attention.jsonl');
        mkdirSync(dirname(notePath), { recursive: true });
        writeFileSync(notePath, `${JSON.stringify({ acknowledgedAt: now(), candidate })}\n`, { encoding: 'utf8', flag: 'a' });
        return { ...candidate, applied: true };
      }
      return { ...candidate, applied: false, error: 'Unsupported or unsafe cleanup candidate.' };
    } catch (error) {
      return { ...candidate, applied: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  return {
    ...preview,
    mode: 'apply',
    applied,
  };
}
