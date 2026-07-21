import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { tmpdir } from 'os';
import type { CleanupCycleSummary } from '../control-plane/runtime-cleanup';

export interface RuntimeCleanupCandidate {
  kind: 'temp_dir' | 'local_job' | 'legacy_run' | 'attention_marker';
  path?: string;
  id?: string;
  reason: string;
  ageMinutes?: number;
  occupiedByPid?: number;
  safe: boolean;
  ownershipStatus?: 'explicit' | 'unknown';
}

export interface RuntimeCleanupPreview {
  schemaVersion: 1;
  generatedAt: string;
  repoRoot: string;
  mode: 'preview';
  candidates: RuntimeCleanupCandidate[];
  truncated: { candidates: boolean };
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
  cycle: CleanupCycleSummary;
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
  maxRemovals?: number;
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
    maxCandidates: Math.max(1, Math.min(safeNumber(options.maxCandidates, 200), 200)),
    maxRemovals: Math.max(1, Math.min(safeNumber(options.maxRemovals, 50), 50)),
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
  const scanLimit = Math.min(normalized.maxCandidates * 3, 600);
  const allCandidates = [
    ...(normalized.includeTempDirs ? scanTempDirs(normalized.minAgeMinutes, scanLimit) : []),
    ...(normalized.includeTerminalLocalJobs ? scanTerminalLocalJobs(repoRoot, normalized.minAgeMinutes, scanLimit) : []),
    ...(normalized.includeLegacyRuns ? scanLegacyRuns(repoRoot, normalized.minAgeMinutes, scanLimit) : []),
    ...(normalized.includeHistoricalAttention ? scanHistoricalAttention(repoRoot) : []),
  ];
  const candidates = allCandidates.slice(0, normalized.maxCandidates);
  const generatedAt = now();
  const skippedByReason = candidates.reduce<Record<string, number>>((counts, candidate) => {
    if (!candidate.safe) {
      const reason = candidate.ownershipStatus === 'unknown' ? 'unknown_ownership' : candidate.occupiedByPid ? 'process_occupied' : 'retained';
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
    return counts;
  }, {});
  return {
    schemaVersion: 1,
    generatedAt,
    repoRoot,
    mode: 'preview',
    candidates,
    truncated: { candidates: allCandidates.length > candidates.length },
    summary: summarize(candidates),
    warnings: [
      'Preview is non-destructive. Apply requires confirmCleanup=true.',
      'Legacy run cleanup only archives directories proven to be old no-op waiting_for_user runs with no matching process.',
      'Historical attention cleanup is intentionally represented as acknowledgement guidance unless an explicit reconciler is added.',
    ],
    cycle: {
      scanned: allCandidates.length,
      eligible: candidates.filter((candidate) => candidate.safe).length,
      attempted: 0,
      removed: 0,
      retained: candidates.filter((candidate) => !candidate.safe).length,
      skipped: Math.max(0, allCandidates.length - candidates.length),
      failed: 0,
      truncated: allCandidates.length > candidates.length,
      budgetExhausted: allCandidates.length > candidates.length,
      skippedByReason,
      failedByType: {},
      startedAt: generatedAt,
      finishedAt: generatedAt,
      durationMs: 0,
    },
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
  // Passive / fenced runtimes must not run cleanup.
  try {
    const controllerHome = process.env.REPO_HARNESS_CONTROLLER_HOME?.trim();
    if (controllerHome) {
      const { assertThisRuntimeMayWrite } = require('../../cli/controller/stable-state/runtime-writer-context') as typeof import('../../cli/controller/stable-state/runtime-writer-context');
      const fence = assertThisRuntimeMayWrite('cleanup', controllerHome);
      if (!fence.allowed) {
        const generatedAt = now();
        return {
          schemaVersion: 1,
          generatedAt,
          repoRoot: resolve(repoRoot),
          mode: 'apply',
          candidates: [],
          applied: [],
          truncated: { candidates: false },
          summary: {
            total: 0, safe: 0, unsafe: 0, tempDirs: 0, localJobs: 0, legacyRuns: 0, attentionMarkers: 0,
          },
          warnings: [`writer_fenced:${fence.reason ?? 'denied'}`],
          cycle: {
            scanned: 0, eligible: 0, attempted: 0, removed: 0, retained: 0, skipped: 0, failed: 0,
            truncated: false, budgetExhausted: false, skippedByReason: { writer_fenced: 1 }, failedByType: {},
            startedAt: generatedAt, finishedAt: generatedAt, durationMs: 0,
          },
        } as RuntimeCleanupApplyResult;
      }
    }
  } catch {
    /* legacy / shape mismatch — proceed */
  }
  const normalized = normalizeOptions(options);
  if (!normalized.confirmCleanup) throw new Error('RUNTIME_CLEANUP_CONFIRMATION_REQUIRED: confirmCleanup=true is required.');
  const preview = previewRuntimeCleanup(repoRoot, normalized);
  const eligible = preview.candidates.filter((candidate) => candidate.safe);
  const applied: Array<RuntimeCleanupCandidate & { applied: boolean; error?: string }> = eligible.slice(0, normalized.maxRemovals).map((candidate) => {
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
  const finishedAt = now();
  const attempted = applied.length;
  const removed = applied.filter((candidate) => candidate.applied).length;
  const failed = applied.filter((candidate) => !candidate.applied && candidate.error).length;
  const cycle: CleanupCycleSummary = {
    ...preview.cycle,
    attempted,
    removed,
    failed,
    skipped: preview.cycle.skipped
      + applied.filter((candidate) => !candidate.applied && !candidate.error).length
      + Math.max(0, eligible.length - applied.length),
    truncated: preview.cycle.truncated || eligible.length > applied.length,
    budgetExhausted: preview.cycle.budgetExhausted || eligible.length > applied.length,
    skippedByReason: {
      ...preview.cycle.skippedByReason,
      ...(eligible.length > applied.length ? { cleanup_budget_exhausted: Math.max(0, eligible.length - applied.length) } : {}),
    },
    failedByType: applied.reduce<Record<string, number>>((counts, candidate) => {
      if (!candidate.error) return counts;
      counts[candidate.kind] = (counts[candidate.kind] ?? 0) + 1;
      return counts;
    }, {}),
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(preview.generatedAt)),
  };
  return {
    ...preview,
    mode: 'apply',
    applied,
    cycle,
  };
}
