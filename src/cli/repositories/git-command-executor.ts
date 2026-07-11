import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { appendFileSync, mkdirSync, realpathSync } from 'fs';
import { dirname, join, relative } from 'path';
import { capProcessOutput, redactProcessOutput } from '../../effects/process-runner';
import { repositoryControllerRoot } from './controller-home';
import { classifyRepositoryCommand, type RepositoryCommandAuthorization, type RepositoryCommandClassification } from './command-classifier';
import { resolveRepositoryCommandCwd } from './command-scope';
import type { RepositoryRecord } from './types';
import { assertResolvedAuthorization, decideAuthorization, type AuthorizationDecision } from '../../runtime/control-plane/governance/authorization';
import { readRepositoryAccessPolicy } from '../../runtime/control-plane/governance/access-policy';

export interface ExecuteRepositoryGitCommandInput {
  args: string[];
  cwd?: string;
  authorization?: RepositoryCommandAuthorization;
  approvalToken?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  authorizationDecision?: AuthorizationDecision;
  approvalRequestId?: string;
  sessionId?: string;
  principalId?: string;
  workId?: string;
  goalId?: string;
}

export interface RepositoryGitSnapshot {
  head: string | null;
  branch: string | null;
  status: string;
  dirty: boolean;
  refsHash: string;
}

export interface RepositoryGitExecution {
  status: 'preview' | 'approval_required' | 'executed';
  repoId: string;
  checkoutId: string;
  cwd: string;
  command: string;
  args: string[];
  classification: RepositoryCommandClassification;
  approvalToken: string;
  authorization?: RepositoryCommandAuthorization;
  authorizationDecision?: AuthorizationDecision;
  approvalRequestId?: string;
  ok?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  before: RepositoryGitSnapshot;
  after?: RepositoryGitSnapshot;
  repositoryChanged?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ARGS = 256;
const MAX_ARG_LENGTH = 8192;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error('GIT_COMMAND_OPTION_INVALID: numeric option must be finite');
  const normalized = Math.trunc(value);
  if (normalized < minimum || normalized > maximum) {
    throw new Error(`GIT_COMMAND_OPTION_INVALID: value must be between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'SHELL',
    'LANG', 'LC_ALL', 'TERM', 'SSH_AUTH_SOCK', 'GPG_TTY', 'XDG_CONFIG_HOME',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.CI = '1';
  return env;
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function validateArgs(args: string[]): string[] {
  if (!Array.isArray(args) || args.length === 0) throw new Error('GIT_COMMAND_INVALID: args are required');
  if (args.length > MAX_ARGS) throw new Error(`GIT_COMMAND_INVALID: args exceed ${MAX_ARGS} entries`);
  const normalized = args.map((entry) => String(entry));
  for (const value of normalized) {
    if (!value || value.length > MAX_ARG_LENGTH || value.includes('\0') || /[\r\n]/.test(value)) {
      throw new Error('GIT_COMMAND_INVALID: args must be non-empty single-line strings within the size limit');
    }
  }
  const lower = normalized.map((value) => value.toLowerCase());
  // Git reuses `-c` both as a global config override (`git -c key=value status`)
  // and as a normal subcommand option (`git switch -c feature/name`). Only the
  // leading global-option form is forbidden. Short options are case-sensitive:
  // `-C` changes the working directory while `-c` injects configuration.
  for (let index = 0; index < normalized.length; index += 1) {
    const raw = normalized[index]!;
    const value = lower[index]!;
    if (raw === '--') break;
    if (!raw.startsWith('-')) break;
    if (raw === '-c' || raw.startsWith('-c=') || value === '--config-env' || value.startsWith('--config-env=')) {
      throw new Error('GIT_COMMAND_POLICY_DENIED: per-command Git configuration overrides are not allowed');
    }
    if (
      raw === '-C'
      || raw.startsWith('-C=')
      || value === '--git-dir'
      || value.startsWith('--git-dir=')
      || value === '--work-tree'
      || value.startsWith('--work-tree=')
    ) {
      throw new Error('GIT_COMMAND_SCOPE_DENIED: Git repository scope overrides are not allowed');
    }
    if (value === '--exec-path' || value.startsWith('--exec-path=')) {
      throw new Error('GIT_COMMAND_POLICY_DENIED: Git executable-path overrides are not allowed');
    }
  }
  if (lower.some((value) => value === '--git-dir' || value.startsWith('--git-dir=') || value === '--work-tree' || value.startsWith('--work-tree='))) {
    throw new Error('GIT_COMMAND_SCOPE_DENIED: Git repository scope overrides are not allowed');
  }
  if (lower[0] === 'config' && lower.some((value) => value === '--global' || value === '--system')) {
    throw new Error('GIT_COMMAND_POLICY_DENIED: global and system Git configuration are not allowed');
  }
  if (lower[0] === 'credential' || lower[0].startsWith('credential-')) {
    throw new Error('GIT_COMMAND_POLICY_DENIED: credential helper access is not allowed');
  }
  if (lower[0] === 'upload-archive' || lower[0] === 'upload-pack' || lower[0] === 'receive-pack' || lower[0] === 'daemon') {
    throw new Error('GIT_COMMAND_POLICY_DENIED: Git transport server commands are not allowed');
  }
  return normalized;
}

function runGit(root: string, args: string[], timeoutMs: number, maxOutputBytes: number) {
  const result = spawnSync('git', ['-C', root, ...args], {
    cwd: root,
    env: gitEnvironment(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: Math.max(maxOutputBytes, 1024 * 1024),
  });
  const error = result.error instanceof Error ? result.error.message : '';
  return {
    ok: result.status === 0 && !result.error,
    exitCode: result.status ?? 1,
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
    stdout: capProcessOutput(redactProcessOutput(typeof result.stdout === 'string' ? result.stdout : ''), maxOutputBytes),
    stderr: capProcessOutput(redactProcessOutput([
      typeof result.stderr === 'string' ? result.stderr : '',
      error,
    ].filter(Boolean).join('\n')), maxOutputBytes),
  };
}

function gitText(root: string, args: string[]): string {
  const result = runGit(root, args, 10_000, 256 * 1024);
  return result.ok ? result.stdout.trim() : '';
}

function repositorySnapshot(root: string): RepositoryGitSnapshot {
  const head = gitText(root, ['rev-parse', '--verify', 'HEAD']) || null;
  const branch = gitText(root, ['branch', '--show-current']) || null;
  const status = gitText(root, ['status', '--porcelain=v1', '--branch', '--', '.', ':(exclude).ai/harness/**']);
  const refs = gitText(root, ['show-ref', '--heads', '--tags']);
  return {
    head,
    branch,
    status,
    dirty: status.split(/\r?\n/).some((line) => line.trim() && !line.startsWith('##')),
    refsHash: createHash('sha256').update(refs).digest('hex'),
  };
}

function approvalToken(
  repository: RepositoryRecord,
  relativeCwd: string,
  args: string[],
  classification: RepositoryCommandClassification,
  snapshot: RepositoryGitSnapshot,
): string {
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    cwd: relativeCwd,
    args,
    classification,
    snapshot,
  })).digest('hex');
}

function snapshotChanged(before: RepositoryGitSnapshot, after: RepositoryGitSnapshot): boolean {
  return before.head !== after.head
    || before.branch !== after.branch
    || before.status !== after.status
    || before.refsHash !== after.refsHash;
}

function auditExecution(controllerHome: string, repository: RepositoryRecord, execution: RepositoryGitExecution): void {
  const path = join(repositoryControllerRoot(controllerHome, repository.repoId), 'audit', 'git-commands.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...execution,
    stdout: execution.stdout ? `[${Buffer.byteLength(execution.stdout, 'utf8')} bytes returned]` : undefined,
    stderr: execution.stderr ? `[${Buffer.byteLength(execution.stderr, 'utf8')} bytes returned]` : undefined,
  })}\n`, 'utf-8');
}

export function executeRepositoryGitCommand(
  controllerHome: string,
  repository: RepositoryRecord,
  input: ExecuteRepositoryGitCommandInput,
): RepositoryGitExecution {
  const { root, cwd, relativeCwd } = resolveRepositoryCommandCwd(repository, input.cwd);
  if (realpathSync(root) !== realpathSync(repository.canonicalRoot)) {
    throw new Error('GIT_COMMAND_SCOPE_DENIED: selected checkout does not match the registered repository');
  }
  const args = validateArgs(input.args);
  const command = `git ${args.map(quoteArg).join(' ')}`;
  const classification = classifyRepositoryCommand(command, repository.defaultBranch);
  const before = repositorySnapshot(root);
  const token = approvalToken(repository, relativeCwd, args, classification, before);
  const permission = readRepositoryAccessPolicy(controllerHome, repository.repoId);
  const safeMergedBranchDelete = classification.risk === 'destructive'
    && /^git\s+branch\s+-d(?:\s|$)/i.test(command);
  const risk = classification.risk === 'readonly'
    ? 'readonly'
    : classification.risk === 'remote_write'
      ? 'remote_write'
      : classification.risk === 'destructive' && !safeMergedBranchDelete ? 'destructive' : 'local_git';
  const authorizationDecision = input.authorizationDecision ?? decideAuthorization({
    controllerHome,
    accessMode: permission.mode,
    risk,
    repositoryId: repository.repoId,
    currentRepositoryId: repository.repoId,
    permissionSnapshotVersion: permission.revision,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.principalId ? { principalId: input.principalId } : {}),
    ...(input.workId ? { workId: input.workId, boundWorkId: input.workId } : {}),
    ...(input.goalId ? { goalId: input.goalId, boundGoalId: input.goalId } : {}),
    command,
  });
  const resolved = input.approvalRequestId
    ? assertResolvedAuthorization({ controllerHome, repositoryId: repository.repoId, approvalRequestId: input.approvalRequestId, sessionId: input.sessionId, principalId: input.principalId, workId: input.workId, permissionSnapshotVersion: permission.revision, command })
    : undefined;
  const effectiveDecision = resolved
    ? { decision: 'allow', source: 'user_confirmation', reason: 'Resolved approval request matches the exact Git operation and current permission snapshot.' } as const
    : authorizationDecision;
  const base: RepositoryGitExecution = {
    status: input.dryRun === true ? 'preview' : 'approval_required',
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    cwd: relative(root, cwd) || relativeCwd,
    command: redactProcessOutput(command),
    args: args.map((value) => redactProcessOutput(value)),
    classification,
    approvalToken: token,
    authorization: input.authorization,
    authorizationDecision: effectiveDecision,
    ...(effectiveDecision.decision === 'user_confirmation_required' ? { approvalRequestId: effectiveDecision.approvalRequestId } : {}),
    before,
  };
  if (input.dryRun === true) {
    auditExecution(controllerHome, repository, base);
    return base;
  }
  const confirmed = input.authorization === 'confirmed_plan' && input.approvalToken === token;
  const canExecute = classification.risk === 'readonly'
    || effectiveDecision.decision === 'allow'
    || confirmed;
  if (!canExecute) {
    auditExecution(controllerHome, repository, base);
    return base;
  }
  const timeoutMs = boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
  const maxOutputBytes = boundedInteger(input.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1_024, MAX_OUTPUT_BYTES);
  const processResult = runGit(cwd, args, timeoutMs, maxOutputBytes);
  const after = repositorySnapshot(root);
  const execution: RepositoryGitExecution = {
    ...base,
    status: 'executed',
    ...processResult,
    after,
    repositoryChanged: snapshotChanged(before, after),
  };
  auditExecution(controllerHome, repository, execution);
  return execution;
}
