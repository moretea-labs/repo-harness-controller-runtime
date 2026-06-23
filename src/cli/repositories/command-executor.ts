import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { capProcessOutput, redactProcessOutput } from '../../effects/process-runner';
import { repositoryControllerRoot } from './controller-home';
import {
  classifyRepositoryCommand,
  type RepositoryCommandAuthorization,
  type RepositoryCommandClassification,
} from './command-classifier';
import {
  assertCommandPathOperandsStayInRepository,
  assertRepositoryCommandAllowed,
  resolveRepositoryCommandCwd,
} from './command-scope';
import type { RepositoryRecord } from './types';

export { classifyRepositoryCommand } from './command-classifier';
export type {
  RepositoryCommandAuthorization,
  RepositoryCommandClassification,
  RepositoryCommandConfirmation,
  RepositoryCommandRisk,
} from './command-classifier';

export interface ExecuteRepositoryCommandInput {
  command: string;
  cwd?: string;
  authorization?: RepositoryCommandAuthorization;
  approvalToken?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RepositoryCommandSnapshot {
  head: string | null;
  branch: string | null;
  status: string;
  dirty: boolean;
  refsHash: string;
}

export interface RepositoryCommandExecution {
  status: 'preview' | 'approval_required' | 'executed';
  repoId: string;
  checkoutId: string;
  cwd: string;
  command: string;
  classification: RepositoryCommandClassification;
  approvalToken: string;
  authorization?: RepositoryCommandAuthorization;
  ok?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  before: RepositoryCommandSnapshot;
  after?: RepositoryCommandSnapshot;
  repositoryChanged?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error('COMMAND_OPTION_INVALID: numeric command option must be finite');
  const normalized = Math.trunc(value);
  if (normalized < minimum || normalized > maximum) {
    throw new Error(`COMMAND_OPTION_INVALID: value must be between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'SHELL',
    'LANG', 'LC_ALL', 'TERM', 'SSH_AUTH_SOCK', 'GPG_TTY', 'XDG_CONFIG_HOME',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.GIT_TERMINAL_PROMPT = '0';
  env.CI = '1';
  return env;
}

function commandOutput(command: string, args: string[], cwd: string, maxOutputBytes: number): {
  ok: boolean;
  stdout: string;
} {
  const result = spawnSync(command, args, {
    cwd,
    env: commandEnvironment(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: Math.max(maxOutputBytes, 1024 * 1024),
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: capProcessOutput(
      redactProcessOutput(typeof result.stdout === 'string' ? result.stdout : ''),
      maxOutputBytes,
    ),
  };
}

function gitText(root: string, args: string[]): string {
  const output = commandOutput('git', ['-C', root, ...args], root, 256 * 1024);
  return output.ok ? output.stdout.trim() : '';
}

function repositorySnapshot(root: string): RepositoryCommandSnapshot {
  const head = gitText(root, ['rev-parse', '--verify', 'HEAD']) || null;
  const branch = gitText(root, ['branch', '--show-current']) || null;
  const status = gitText(root, ['status', '--porcelain=v1', '--branch']);
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
  command: string,
  classification: RepositoryCommandClassification,
  snapshot: RepositoryCommandSnapshot,
): string {
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    cwd: relativeCwd,
    command,
    classification,
    snapshot,
  })).digest('hex');
}

function snapshotChanged(before: RepositoryCommandSnapshot, after: RepositoryCommandSnapshot): boolean {
  return before.head !== after.head
    || before.branch !== after.branch
    || before.status !== after.status
    || before.refsHash !== after.refsHash;
}

function auditCommand(
  controllerHome: string,
  repository: RepositoryRecord,
  execution: RepositoryCommandExecution,
): void {
  const path = join(repositoryControllerRoot(controllerHome, repository.repoId), 'audit', 'commands.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...execution,
    stdout: execution.stdout ? `[${Buffer.byteLength(execution.stdout, 'utf8')} bytes returned]` : undefined,
    stderr: execution.stderr ? `[${Buffer.byteLength(execution.stderr, 'utf8')} bytes returned]` : undefined,
  })}\n`, 'utf-8');
}

export function executeRepositoryCommand(
  controllerHome: string,
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
): RepositoryCommandExecution {
  const { root, cwd, relativeCwd } = resolveRepositoryCommandCwd(repository, input.cwd);
  const command = assertRepositoryCommandAllowed(input.command);
  assertCommandPathOperandsStayInRepository(command, cwd, root);
  const classification = classifyRepositoryCommand(command, repository.defaultBranch);
  const before = repositorySnapshot(root);
  const token = approvalToken(repository, relativeCwd, command, classification, before);
  const base: RepositoryCommandExecution = {
    status: input.dryRun === true ? 'preview' : 'approval_required',
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    cwd: relativeCwd,
    command: redactProcessOutput(command),
    classification,
    approvalToken: token,
    authorization: input.authorization,
    before,
  };

  if (input.dryRun === true) {
    auditCommand(controllerHome, repository, base);
    return base;
  }

  const explicit = input.authorization === 'explicit_user_request';
  const confirmed = input.authorization === 'confirmed_plan' && input.approvalToken === token;
  const canExecute = classification.risk === 'readonly'
    || (classification.confirmation === 'authorization' && (explicit || confirmed))
    || (classification.confirmation === 'strong_confirmation' && confirmed);
  if (!canExecute) {
    auditCommand(controllerHome, repository, base);
    return base;
  }

  const timeoutMs = boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
  const maxOutputBytes = boundedInteger(input.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1_024, MAX_OUTPUT_BYTES);
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
  const result = spawnSync(shell, shellArgs, {
    cwd,
    env: commandEnvironment(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: Math.max(maxOutputBytes, 1024 * 1024),
  });
  const error = result.error instanceof Error ? result.error.message : '';
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const after = repositorySnapshot(root);
  const execution: RepositoryCommandExecution = {
    ...base,
    status: 'executed',
    ok: result.status === 0 && !result.error,
    exitCode: result.status ?? 1,
    timedOut,
    stdout: capProcessOutput(
      redactProcessOutput(typeof result.stdout === 'string' ? result.stdout : ''),
      maxOutputBytes,
    ),
    stderr: capProcessOutput(redactProcessOutput([
      typeof result.stderr === 'string' ? result.stderr : '',
      error,
    ].filter(Boolean).join('\n')), maxOutputBytes),
    after,
    repositoryChanged: snapshotChanged(before, after),
  };
  auditCommand(controllerHome, repository, execution);
  return execution;
}
