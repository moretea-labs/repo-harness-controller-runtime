import { spawnSync } from 'child_process';
import { capProcessOutput, redactProcessOutput } from '../../effects/process-runner';
import { executeRepositoryGitCommand, type RepositoryGitExecution } from './git-command-executor';
import type { RepositoryRecord } from './types';
import type { AuthorizationDecision } from '../../runtime/control-plane/governance/authorization';

const MAX_GIT_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_GIT_OUTPUT_BYTES = 128 * 1024;
const MAX_COMMIT_MESSAGE_LENGTH = 4096;
const MAX_PATHS = 256;

export interface RepositoryGitStatusSnapshot {
  repoId: string;
  checkoutId: string;
  observedAt: string;
  staleAgeMs: number;
  sampleSource: 'live' | 'daemon-sample';
  branch: string | null;
  head: string | null;
  upstream: string | null;
  porcelain: string;
  shortStatus: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  clean: boolean;
}

export interface RepositoryGitDiffResult {
  repoId: string;
  checkoutId: string;
  branch: string | null;
  head: string | null;
  staged: boolean;
  paths: string[];
  nameOnly: string[];
  stat: string;
  patch: string;
  truncated: boolean;
}

export interface RepositoryGitCommitResult {
  repoId: string;
  checkoutId: string;
  before: RepositoryGitStatusSnapshot;
  stage?: RepositoryGitExecution;
  commit?: RepositoryGitExecution;
  after: RepositoryGitStatusSnapshot;
  committed: boolean;
  error?: { code: string; message: string };
}

export interface RepositoryGitFinishResult {
  repoId: string;
  checkoutId: string;
  featureBranch: string;
  targetBranch: string;
  before: RepositoryGitStatusSnapshot;
  steps: Array<{ name: string; execution: RepositoryGitExecution }>;
  after: RepositoryGitStatusSnapshot;
  completed: boolean;
  error?: { code: string; message: string };
}

function boundedOutputBytes(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : DEFAULT_GIT_OUTPUT_BYTES;
  if (!Number.isFinite(parsed)) return DEFAULT_GIT_OUTPUT_BYTES;
  return Math.max(1024, Math.min(Math.trunc(parsed), MAX_GIT_OUTPUT_BYTES));
}

function runGit(repository: RepositoryRecord, args: string[], maxOutputBytes = MAX_GIT_OUTPUT_BYTES): { ok: boolean; status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', ['-C', repository.canonicalRoot, ...args], {
    cwd: repository.canonicalRoot,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: Math.max(maxOutputBytes, 1024 * 1024),
  });
  const stdout = capProcessOutput(redactProcessOutput(typeof result.stdout === 'string' ? result.stdout : ''), maxOutputBytes);
  const stderr = capProcessOutput(redactProcessOutput([
    typeof result.stderr === 'string' ? result.stderr : '',
    result.error instanceof Error ? result.error.message : '',
  ].filter(Boolean).join('\n')), maxOutputBytes);
  return { ok: result.status === 0 && !result.error, status: result.status ?? 1, stdout, stderr };
}

function gitText(repository: RepositoryRecord, args: string[]): string | null {
  const result = runGit(repository, args, 64 * 1024);
  return result.ok && result.stdout.trim() ? result.stdout.trim() : null;
}

function assertSafeBranchName(raw: unknown): string {
  const branch = String(raw ?? '').trim();
  if (!branch) throw new Error('GIT_BRANCH_REQUIRED: branch name is required');
  if (branch.length > 200 || branch.startsWith('-') || branch.includes('..') || /[\s~^:?*[\\\]\0]/.test(branch) || branch.endsWith('/') || branch.endsWith('.lock')) {
    throw new Error(`GIT_BRANCH_INVALID: unsafe branch name: ${branch}`);
  }
  return branch;
}

function normalizeCommitMessage(raw: unknown): string {
  const message = String(raw ?? '').trim();
  if (!message) throw new Error('GIT_COMMIT_MESSAGE_REQUIRED: message is required');
  if (message.length > MAX_COMMIT_MESSAGE_LENGTH || message.includes('\0')) throw new Error('GIT_COMMIT_MESSAGE_INVALID: message is empty, too long, or contains a null byte');
  return message;
}

function normalizePaths(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('GIT_PATHS_INVALID: paths must be an array');
  if (input.length > MAX_PATHS) throw new Error(`GIT_PATHS_INVALID: at most ${MAX_PATHS} paths are allowed`);
  return [...new Set(input.map((entry) => String(entry ?? '').trim().replace(/\\/g, '/')).filter(Boolean))].sort();
}

function splitStatus(porcelain: string): { staged: string[]; unstaged: string[]; untracked: string[] } {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line || line.startsWith('## ')) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (code === '??') untracked.push(path);
    else {
      if (code[0] !== ' ' && code[0] !== '?') staged.push(path);
      if (code[1] !== ' ' && code[1] !== '?') unstaged.push(path);
    }
  }
  return { staged, unstaged, untracked };
}

export function repositoryGitStatus(repository: RepositoryRecord): RepositoryGitStatusSnapshot {
  const observedAt = new Date().toISOString();
  const porcelain = runGit(repository, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '--', '.', ':(exclude).ai/harness/**']).stdout;
  const split = splitStatus(porcelain);
  return {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    observedAt,
    staleAgeMs: 0,
    sampleSource: 'live',
    branch: gitText(repository, ['branch', '--show-current']),
    head: gitText(repository, ['rev-parse', '--verify', 'HEAD']),
    upstream: gitText(repository, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    porcelain,
    shortStatus: runGit(repository, ['status', '--short', '--branch', '--untracked-files=all', '--', '.', ':(exclude).ai/harness/**']).stdout,
    ...split,
    clean: split.staged.length === 0 && split.unstaged.length === 0 && split.untracked.length === 0,
  };
}

export function repositoryGitDiff(repository: RepositoryRecord, input: { staged?: unknown; paths?: unknown; maxBytes?: unknown } = {}): RepositoryGitDiffResult {
  const maxBytes = boundedOutputBytes(input.maxBytes);
  const staged = input.staged === true;
  const paths = normalizePaths(input.paths);
  const argsPrefix = ['diff', ...(staged ? ['--cached'] : [])];
  const separator = paths.length > 0 ? ['--', ...paths] : [];
  const nameOnly = runGit(repository, [...argsPrefix, '--name-only', ...separator], maxBytes).stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const stat = runGit(repository, [...argsPrefix, '--stat', ...separator], maxBytes).stdout;
  const patch = runGit(repository, [...argsPrefix, ...separator], maxBytes).stdout;
  return {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    branch: gitText(repository, ['branch', '--show-current']),
    head: gitText(repository, ['rev-parse', '--verify', 'HEAD']),
    staged,
    paths,
    nameOnly,
    stat,
    patch,
    truncated: patch.length >= maxBytes,
  };
}

export function repositoryGitCreateBranch(controllerHome: string, repository: RepositoryRecord, input: { branch: unknown; startPoint?: unknown; switchTo?: unknown }): { branch: string; execution: RepositoryGitExecution } {
  const branch = assertSafeBranchName(input.branch);
  const startPoint = typeof input.startPoint === 'string' && input.startPoint.trim() ? input.startPoint.trim() : undefined;
  const args = [input.switchTo === false ? 'branch' : 'switch', ...(input.switchTo === false ? [] : ['-c']), branch, ...(startPoint ? [startPoint] : [])];
  return { branch, execution: executeRepositoryGitCommand(controllerHome, repository, { args, authorization: 'explicit_user_request' }) };
}

export function repositoryGitSwitchBranch(controllerHome: string, repository: RepositoryRecord, input: { branch: unknown }): { branch: string; execution: RepositoryGitExecution } {
  const branch = assertSafeBranchName(input.branch);
  return { branch, execution: executeRepositoryGitCommand(controllerHome, repository, { args: ['switch', branch], authorization: 'explicit_user_request' }) };
}

export function repositoryGitMergeBranch(controllerHome: string, repository: RepositoryRecord, input: { branch: unknown; noFf?: unknown }): { branch: string; before: RepositoryGitStatusSnapshot; execution: RepositoryGitExecution; after: RepositoryGitStatusSnapshot } {
  const branch = assertSafeBranchName(input.branch);
  const before = repositoryGitStatus(repository);
  const args = ['merge', ...(input.noFf === true ? ['--no-ff'] : ['--ff-only']), branch];
  const execution = executeRepositoryGitCommand(controllerHome, repository, { args, authorization: 'explicit_user_request' });
  return { branch, before, execution, after: repositoryGitStatus(repository) };
}

export function repositoryGitDeleteBranch(controllerHome: string, repository: RepositoryRecord, input: { branch: unknown; force?: unknown; authorizationDecision?: AuthorizationDecision; sessionId?: string; principalId?: string; workId?: string; goalId?: string }): { branch: string; execution: RepositoryGitExecution } {
  const branch = assertSafeBranchName(input.branch);
  const current = repositoryGitStatus(repository).branch;
  if (current === branch) throw new Error(`GIT_DELETE_CURRENT_BRANCH_DENIED: cannot delete the checked-out branch: ${branch}`);
  return { branch, execution: executeRepositoryGitCommand(controllerHome, repository, { args: ['branch', input.force === true ? '-D' : '-d', branch], authorization: 'explicit_user_request', ...input }) };
}

export function repositoryGitCommit(controllerHome: string, repository: RepositoryRecord, input: { message: unknown; paths?: unknown; allowEmpty?: unknown; authorizationDecision?: AuthorizationDecision; sessionId?: string; principalId?: string; workId?: string; goalId?: string }): RepositoryGitCommitResult {
  const before = repositoryGitStatus(repository);
  const message = normalizeCommitMessage(input.message);
  const paths = normalizePaths(input.paths);
  let stage: RepositoryGitExecution | undefined;
  if (paths.length > 0) {
    stage = executeRepositoryGitCommand(controllerHome, repository, { args: ['add', '--all', '--', ...paths], authorization: 'explicit_user_request', ...input });
    if (stage.status !== 'executed' || stage.ok !== true) {
      return { repoId: repository.repoId, checkoutId: repository.activeCheckoutId, before, stage, after: repositoryGitStatus(repository), committed: false, error: { code: 'GIT_STAGE_FAILED', message: stage.stderr || 'git add failed' } };
    }
  }
  const diffCheck = runGit(repository, ['diff', '--cached', '--quiet'], 64 * 1024);
  if (diffCheck.status === 0 && input.allowEmpty !== true) {
    return { repoId: repository.repoId, checkoutId: repository.activeCheckoutId, before, stage, after: repositoryGitStatus(repository), committed: false, error: { code: 'GIT_NOTHING_STAGED', message: 'No staged changes to commit. Pass paths to stage, or allow_empty=true for an empty commit.' } };
  }
  const commitArgs = ['commit', '-m', message, ...(input.allowEmpty === true ? ['--allow-empty'] : []), ...(paths.length > 0 ? ['--only', '--', ...paths] : [])];
  const commit = executeRepositoryGitCommand(controllerHome, repository, { args: commitArgs, authorization: 'explicit_user_request', ...input });
  const ok = commit.status === 'executed' && commit.ok === true;
  return {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    before,
    ...(stage ? { stage } : {}),
    commit,
    after: repositoryGitStatus(repository),
    committed: ok,
    ...(ok ? {} : { error: { code: 'GIT_COMMIT_FAILED', message: commit.stderr || 'git commit failed' } }),
  };
}

export function repositoryGitFinishWorkflow(controllerHome: string, repository: RepositoryRecord, input: { targetBranch?: unknown; featureBranch?: unknown; deleteBranch?: unknown; noFf?: unknown; authorizationDecision?: AuthorizationDecision; sessionId?: string; principalId?: string; workId?: string; goalId?: string }): RepositoryGitFinishResult {
  const before = repositoryGitStatus(repository);
  const featureBranch = assertSafeBranchName(input.featureBranch ?? before.branch);
  const targetBranch = assertSafeBranchName(input.targetBranch ?? repository.defaultBranch ?? 'main');
  const steps: RepositoryGitFinishResult['steps'] = [];
  if (!before.clean) {
    return { repoId: repository.repoId, checkoutId: repository.activeCheckoutId, featureBranch, targetBranch, before, steps, after: before, completed: false, error: { code: 'GIT_WORKTREE_NOT_CLEAN', message: 'Commit or revert all changes before finishing a workflow.' } };
  }
  if (featureBranch === targetBranch) {
    return { repoId: repository.repoId, checkoutId: repository.activeCheckoutId, featureBranch, targetBranch, before, steps, after: before, completed: false, error: { code: 'GIT_ALREADY_ON_TARGET', message: 'Current/feature branch equals target branch; nothing to merge or delete.' } };
  }
  const switchTarget = executeRepositoryGitCommand(controllerHome, repository, { args: ['switch', targetBranch], authorization: 'explicit_user_request', ...input });
  steps.push({ name: 'switch_target', execution: switchTarget });
  if (switchTarget.status !== 'executed' || switchTarget.ok !== true) return { repoId: repository.repoId, checkoutId: repository.activeCheckoutId, featureBranch, targetBranch, before, steps, after: repositoryGitStatus(repository), completed: false, error: { code: 'GIT_SWITCH_TARGET_FAILED', message: switchTarget.stderr || 'git switch failed' } };
  const merge = executeRepositoryGitCommand(controllerHome, repository, { args: ['merge', ...(input.noFf === true ? ['--no-ff'] : ['--ff-only']), featureBranch], authorization: 'explicit_user_request', ...input });
  steps.push({ name: 'merge_feature', execution: merge });
  if (merge.status !== 'executed' || merge.ok !== true) return { repoId: repository.repoId, checkoutId: repository.activeCheckoutId, featureBranch, targetBranch, before, steps, after: repositoryGitStatus(repository), completed: false, error: { code: 'GIT_MERGE_FAILED', message: merge.stderr || 'git merge failed' } };
  if (input.deleteBranch !== false) {
    const del = executeRepositoryGitCommand(controllerHome, repository, { args: ['branch', '-d', featureBranch], authorization: 'explicit_user_request', ...input });
    steps.push({ name: 'delete_feature_branch', execution: del });
    if (del.status !== 'executed' || del.ok !== true) return { repoId: repository.repoId, checkoutId: repository.activeCheckoutId, featureBranch, targetBranch, before, steps, after: repositoryGitStatus(repository), completed: false, error: { code: 'GIT_DELETE_FEATURE_FAILED', message: del.stderr || 'git branch -d failed' } };
  }
  return { repoId: repository.repoId, checkoutId: repository.activeCheckoutId, featureBranch, targetBranch, before, steps, after: repositoryGitStatus(repository), completed: true };
}
