import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { capProcessOutput, redactProcessOutput } from '../../effects/process-runner';
import { buildPatchHandoffArtifact } from '../../runtime/recovery/patch-handoff';
import { executeRepositoryGitCommand, type RepositoryGitExecution } from './git-command-executor';
import type { RepositoryRecord } from './types';

const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_SELECTED_PATHS = 128;
const MAX_PATH_LENGTH = 4096;

export interface SelectedPathDiffResult {
  repoId: string;
  checkoutId: string;
  head: string | null;
  branch: string | null;
  paths: string[];
  staged: boolean;
  status: string;
  diffStat: string;
  diff: string;
}

export interface SelectedPathCommitResult {
  paths: string[];
  stage: RepositoryGitExecution;
  stagedPaths: string[];
  commit?: RepositoryGitExecution;
  error?: { code: string; message: string };
}

export interface HandoffArtifactPreview {
  path: string;
  exists: boolean;
  preview?: string;
}

export interface PreparedHandoffArtifacts {
  reason: string;
  usedScript: boolean;
  fallbackUsed: boolean;
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  artifacts: HandoffArtifactPreview[];
}

function boundedOutputBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isFinite(value)) throw new Error('SELECTED_PATH_OPTION_INVALID: max_bytes must be finite');
  const normalized = Math.trunc(value);
  if (normalized < 1024 || normalized > MAX_OUTPUT_BYTES) {
    throw new Error(`SELECTED_PATH_OPTION_INVALID: max_bytes must be between 1024 and ${MAX_OUTPUT_BYTES}`);
  }
  return normalized;
}

function normalizeSelectedPaths(repository: RepositoryRecord, input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('SELECTED_PATHS_REQUIRED: provide one or more repository-relative paths');
  }
  if (input.length > MAX_SELECTED_PATHS) {
    throw new Error(`SELECTED_PATHS_INVALID: at most ${MAX_SELECTED_PATHS} paths are allowed`);
  }
  const root = resolve(repository.canonicalRoot);
  const normalized = new Set<string>();
  for (const raw of input) {
    const value = String(raw ?? '').trim();
    if (!value || value === '.' || value === './') {
      throw new Error('SELECTED_PATHS_INVALID: explicit file or directory paths are required');
    }
    if (value.length > MAX_PATH_LENGTH || value.includes('\0')) {
      throw new Error('SELECTED_PATHS_INVALID: path is empty, too long, or contains a null byte');
    }
    const candidate = value.replace(/\\/g, '/').replace(/^\.\//, '');
    const resolved = resolve(root, candidate);
    const rel = relative(root, resolved).replace(/\\/g, '/');
    if (!rel || rel === '..' || rel.startsWith('../')) {
      throw new Error(`SELECTED_PATH_SCOPE_DENIED: ${value} escapes the selected repository`);
    }
    normalized.add(rel);
  }
  return [...normalized].sort();
}

function runGit(
  repository: RepositoryRecord,
  args: string[],
  maxOutputBytes: number,
): { ok: boolean; exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync('git', ['-C', repository.canonicalRoot, ...args], {
    cwd: repository.canonicalRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      CI: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: Math.max(maxOutputBytes, 1024 * 1024),
  });
  const stderr = [
    typeof result.stderr === 'string' ? result.stderr : '',
    result.error instanceof Error ? result.error.message : '',
  ].filter(Boolean).join('\n');
  return {
    ok: result.status === 0 && !result.error,
    exitCode: result.status ?? 1,
    stdout: capProcessOutput(redactProcessOutput(typeof result.stdout === 'string' ? result.stdout : ''), maxOutputBytes),
    stderr: capProcessOutput(redactProcessOutput(stderr), maxOutputBytes),
  };
}

function gitText(repository: RepositoryRecord, args: string[]): string {
  const result = runGit(repository, args, 64 * 1024);
  return result.ok ? result.stdout.trim() : '';
}

function stagedPaths(repository: RepositoryRecord, paths: string[]): string[] {
  const result = runGit(repository, ['diff', '--cached', '--name-only', '--', ...paths], 64 * 1024);
  if (!result.ok) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function artifactPreview(repository: RepositoryRecord, path: string): HandoffArtifactPreview {
  const absolute = join(repository.canonicalRoot, path);
  if (!existsSync(absolute)) return { path, exists: false };
  const content = redactProcessOutput(readFileSync(absolute, 'utf-8'));
  return {
    path,
    exists: true,
    preview: content.split(/\r?\n/).slice(0, 24).join('\n'),
  };
}

function repositoryChangedPaths(repository: RepositoryRecord): string[] {
  const tracked = runGit(repository, ['diff', '--name-only'], 64 * 1024).stdout;
  const staged = runGit(repository, ['diff', '--cached', '--name-only'], 64 * 1024).stdout;
  const untracked = runGit(repository, ['ls-files', '--others', '--exclude-standard'], 64 * 1024).stdout;
  return [...new Set([tracked, staged, untracked].join('\n').split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))].sort();
}

function writePatchHandoffArtifact(repository: RepositoryRecord, handoffDir: string, reason: string): HandoffArtifactPreview {
  const diff = runGit(repository, ['diff', '--binary'], 512 * 1024).stdout;
  const stagedDiff = runGit(repository, ['diff', '--cached', '--binary'], 512 * 1024).stdout;
  const touchedPaths = repositoryChangedPaths(repository);
  const artifact = buildPatchHandoffArtifact({
    baseHead: gitText(repository, ['rev-parse', '--verify', 'HEAD']) || 'unknown',
    branch: gitText(repository, ['branch', '--show-current']) || 'detached',
    diff: [diff, stagedDiff].filter(Boolean).join('\n'),
    touchedPaths,
    checks: [],
    actor: 'repo-harness',
    source: `fallback-handoff:${reason}`,
    notes: [
      'Integration must use selected-path review gates.',
      'Do not overwrite unrelated dirty files; rerun conflict detection before applying this patch.',
    ],
  });
  const patchPath = join(handoffDir, 'patch.json');
  writeFileSync(patchPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
  return artifactPreview(repository, '.ai/harness/handoff/patch.json');
}

function ensureFallbackArtifact(repository: RepositoryRecord, reason: string): HandoffArtifactPreview {
  const handoffDir = join(repository.canonicalRoot, '.ai', 'harness', 'handoff');
  mkdirSync(handoffDir, { recursive: true });
  const patchArtifact = writePatchHandoffArtifact(repository, handoffDir, reason);
  const timestamp = new Date().toISOString();
  const currentPath = join(handoffDir, 'current.md');
  const resumePath = join(handoffDir, 'resume.md');
  if (!existsSync(currentPath)) {
    writeFileSync(currentPath, [
      '# Harness Handoff',
      '',
      `> **Generated**: ${timestamp}`,
      `> **Reason**: ${reason}`,
      '> **Mode**: selected-path fallback',
      '',
      '## Exact Next Step',
      '',
      '- Inspect the selected-path Git diff and continue from this repository state.',
      '- Review `.ai/harness/handoff/patch.json` before any integration attempt.',
      '',
    ].join('\n'), 'utf-8');
  }
  if (!existsSync(resumePath)) {
    writeFileSync(resumePath, [
      '# Codex Resume Packet',
      '',
      `- Repository: \`${repository.canonicalRoot}\``,
      `- Reason: \`${reason}\``,
      '- Patch artifact: `.ai/harness/handoff/patch.json`',
      '- Next: open `.ai/harness/handoff/current.md` and continue from the recorded state.',
      '',
    ].join('\n'), 'utf-8');
  }
  return patchArtifact;
}

export function selectedPathDiff(
  repository: RepositoryRecord,
  input: { paths: unknown; staged?: boolean; maxBytes?: number },
): SelectedPathDiffResult {
  const paths = normalizeSelectedPaths(repository, input.paths);
  const maxOutputBytes = boundedOutputBytes(input.maxBytes);
  const staged = input.staged === true;
  const status = runGit(repository, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '--', ...paths], maxOutputBytes);
  const diffStat = runGit(repository, ['diff', ...(staged ? ['--cached'] : []), '--stat', '--', ...paths], maxOutputBytes);
  const diff = runGit(repository, ['diff', ...(staged ? ['--cached'] : []), '--', ...paths], maxOutputBytes);
  return {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    head: gitText(repository, ['rev-parse', '--verify', 'HEAD']) || null,
    branch: gitText(repository, ['branch', '--show-current']) || null,
    paths,
    staged,
    status: status.stdout,
    diffStat: diffStat.stdout,
    diff: diff.stdout,
  };
}

export function stageSelectedPaths(
  controllerHome: string,
  repository: RepositoryRecord,
  input: { paths: unknown },
): { paths: string[]; execution: RepositoryGitExecution } {
  const paths = normalizeSelectedPaths(repository, input.paths);
  return {
    paths,
    execution: executeRepositoryGitCommand(controllerHome, repository, {
      args: ['add', '--all', '--', ...paths],
      authorization: 'explicit_user_request',
    }),
  };
}

export function commitSelectedPaths(
  controllerHome: string,
  repository: RepositoryRecord,
  input: { paths: unknown; message: unknown },
): SelectedPathCommitResult {
  const paths = normalizeSelectedPaths(repository, input.paths);
  const message = String(input.message ?? '').trim();
  if (!message) throw new Error('COMMIT_MESSAGE_REQUIRED: message is required');

  const stage = executeRepositoryGitCommand(controllerHome, repository, {
    args: ['add', '--all', '--', ...paths],
    authorization: 'explicit_user_request',
  });
  if (stage.status !== 'executed' || stage.ok !== true) {
    return {
      paths,
      stage,
      stagedPaths: [],
      error: { code: 'SELECTED_PATH_STAGE_FAILED', message: stage.stderr || 'git add failed for selected paths' },
    };
  }

  const staged = stagedPaths(repository, paths);
  if (staged.length === 0) {
    return {
      paths,
      stage,
      stagedPaths: staged,
      error: { code: 'NO_SELECTED_CHANGES', message: 'No staged changes remain for the selected paths.' },
    };
  }

  const commit = executeRepositoryGitCommand(controllerHome, repository, {
    args: ['commit', '--only', '-m', message, '--', ...paths],
    authorization: 'explicit_user_request',
  });
  return {
    paths,
    stage,
    stagedPaths: staged,
    commit,
    ...(commit.status !== 'executed' || commit.ok !== true
      ? { error: { code: 'SELECTED_PATH_COMMIT_FAILED', message: commit.stderr || 'git commit failed for selected paths' } }
      : {}),
  };
}

export function prepareFallbackHandoffArtifacts(
  repository: RepositoryRecord,
  input: { reason?: unknown },
): PreparedHandoffArtifacts {
  const reason = String(input.reason ?? 'manual').trim() || 'manual';
  const script = join(repository.canonicalRoot, 'scripts', 'prepare-handoff.sh');
  const usedScript = existsSync(script);
  let ok = true;
  let exitCode: number | undefined;
  let stdout = '';
  let stderr = '';

  if (usedScript) {
    const result = spawnSync('bash', ['scripts/prepare-handoff.sh', '--reason', reason], {
      cwd: repository.canonicalRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        CI: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 512 * 1024,
    });
    exitCode = result.status ?? 1;
    stdout = capProcessOutput(redactProcessOutput(typeof result.stdout === 'string' ? result.stdout : ''), 64 * 1024);
    stderr = capProcessOutput(redactProcessOutput(typeof result.stderr === 'string' ? result.stderr : ''), 64 * 1024);
    ok = exitCode === 0 && !result.error;
  }

  const beforeCurrent = existsSync(join(repository.canonicalRoot, '.ai', 'harness', 'handoff', 'current.md'));
  const beforeResume = existsSync(join(repository.canonicalRoot, '.ai', 'harness', 'handoff', 'resume.md'));
  const patchArtifact = ensureFallbackArtifact(repository, reason);
  const fallbackUsed = !usedScript || !ok || !beforeCurrent || !beforeResume;

  return {
    reason,
    usedScript,
    fallbackUsed,
    ok: usedScript ? ok : true,
    ...(usedScript ? { exitCode, stdout, stderr } : {}),
    artifacts: [
      artifactPreview(repository, '.ai/harness/handoff/current.md'),
      artifactPreview(repository, '.ai/harness/handoff/resume.md'),
      patchArtifact,
    ],
  };
}
