import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
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
  /** User-owned workspace state. Harness runtime storage is intentionally excluded. */
  status: string;
  dirty: boolean;
  refsHash: string;
  paths: string[];
  pathFingerprints: Record<string, string>;
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
  changedPaths?: string[];
  policyDecision?: 'allowed' | 'approval_required' | 'rejected';
  infrastructureError?: { code: string; message: string };
}

export interface PreparedRepositoryCommandExecution {
  before: RepositoryCommandSnapshot;
  executable: boolean;
  execution: RepositoryCommandExecution;
}

interface SpawnCommandResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface RepositoryCommandAsyncHooks {
  onSpawn?: (pid: number) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
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

function truncatedOutput(chunks: Buffer[], truncated: boolean, maxOutputBytes: number): string {
  const text = Buffer.concat(chunks).toString('utf8');
  const redacted = redactProcessOutput(text);
  return truncated ? capProcessOutput(redacted, maxOutputBytes) : redacted;
}

function collectOutput(maxOutputBytes: number): {
  write(chunk: string | Buffer): void;
  complete(): string;
} {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let truncated = false;
  return {
    write(chunk: string | Buffer) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      if (buffer.length === 0) return;
      if (totalBytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - totalBytes;
      if (buffer.length <= remaining) {
        chunks.push(buffer);
        totalBytes += buffer.length;
        return;
      }
      chunks.push(buffer.subarray(0, remaining));
      totalBytes += remaining;
      truncated = true;
    },
    complete() {
      return truncatedOutput(chunks, truncated, maxOutputBytes);
    },
  };
}

async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  hooks: RepositoryCommandAsyncHooks = {},
): Promise<SpawnCommandResult> {
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
  const stdoutCollector = collectOutput(maxOutputBytes);
  const stderrCollector = collectOutput(maxOutputBytes);

  return await new Promise<SpawnCommandResult>((resolve) => {
    const child = spawn(shell, shellArgs, {
      cwd,
      env: commandEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) hooks.onSpawn?.(child.pid);
    let settled = false;
    let timedOut = false;
    let spawnError = '';
    let timeoutHandle: NodeJS.Timeout | undefined;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const stderrParts = [stderrCollector.complete()];
      if (timedOut) stderrParts.push(`process timed out after ${timeoutMs}ms: ${redactProcessOutput(command)}`);
      if (spawnError) stderrParts.push(redactProcessOutput(spawnError));
      resolve({
        ok: exitCode === 0 && !timedOut && !spawnError,
        exitCode,
        timedOut,
        stdout: stdoutCollector.complete(),
        stderr: capProcessOutput(stderrParts.filter(Boolean).join('\n'), maxOutputBytes),
      });
    };

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 1_000).unref();
    }, timeoutMs);
    timeoutHandle.unref();

    child.stdout?.on('data', (chunk) => {
      stdoutCollector.write(chunk);
      hooks.onStdout?.(chunk.toString());
    });
    child.stderr?.on('data', (chunk) => {
      stderrCollector.write(chunk);
      hooks.onStderr?.(chunk.toString());
    });
    child.on('error', (error) => {
      spawnError = error.message;
    });
    child.on('close', (code) => {
      finish(code ?? 1);
    });
  });
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

const REPOSITORY_SNAPSHOT_PATHS = [
  '.',
  ':(exclude).ai/harness/**',
  ':(exclude)_ops/controller-home/**',
];

function statusPath(line: string): string | undefined {
  if (!line.trim() || line.startsWith('##')) return undefined;
  const raw = line.length > 3 ? line.slice(3) : '';
  const path = raw.includes(' -> ') ? raw.split(' -> ').at(-1) : raw;
  return path?.replace(/^"|"$/g, '');
}

function repositoryPathFingerprint(root: string, relativePath: string, statusLines: string[]): string {
  const hash = createHash('sha256').update(statusLines.join('\n'));
  const absolute = resolve(root, relativePath);
  if (!existsSync(absolute)) return hash.update('\nmissing').digest('hex');
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) hash.update(`\nsymlink:${readlinkSync(absolute)}`);
    else if (stat.isFile()) hash.update('\nfile:').update(readFileSync(absolute));
    else hash.update(`\nmode:${stat.mode}:size:${stat.size}`);
  } catch (error) {
    hash.update(`\nunreadable:${error instanceof Error ? error.message : String(error)}`);
  }
  return hash.digest('hex');
}

function repositorySnapshot(root: string): RepositoryCommandSnapshot {
  const head = gitText(root, ['rev-parse', '--verify', 'HEAD']) || null;
  const branch = gitText(root, ['branch', '--show-current']) || null;
  const status = gitText(root, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '--', ...REPOSITORY_SNAPSHOT_PATHS]);
  const refs = gitText(root, ['show-ref']);
  const lines = status.split(/\r?\n/).filter((line) => line && !line.startsWith('##'));
  const statusByPath = new Map<string, string[]>();
  for (const line of lines) {
    const path = statusPath(line);
    if (!path) continue;
    const entries = statusByPath.get(path) ?? [];
    entries.push(line);
    statusByPath.set(path, entries);
  }
  const paths = [...statusByPath.keys()].sort();
  const pathFingerprints = Object.fromEntries(paths.map((path) => [
    path,
    repositoryPathFingerprint(root, path, statusByPath.get(path) ?? []),
  ]));
  return {
    head,
    branch,
    status,
    dirty: paths.length > 0,
    refsHash: createHash('sha256').update(refs).digest('hex'),
    paths,
    pathFingerprints,
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

function changedSnapshotPaths(before: RepositoryCommandSnapshot, after: RepositoryCommandSnapshot): string[] {
  const paths = new Set([...before.paths, ...after.paths]);
  return [...paths].filter((path) =>
    before.pathFingerprints[path] !== after.pathFingerprints[path]
  ).sort();
}

function snapshotChanged(before: RepositoryCommandSnapshot, after: RepositoryCommandSnapshot): boolean {
  return before.head !== after.head
    || before.branch !== after.branch
    || before.refsHash !== after.refsHash
    || changedSnapshotPaths(before, after).length > 0;
}

function prepareRepositoryCommandExecution(
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
): { root: string; cwd: string; command: string; timeoutMs: number; maxOutputBytes: number; before: RepositoryCommandSnapshot; execution: RepositoryCommandExecution; executable: boolean } {
  const { root, cwd, relativeCwd } = resolveRepositoryCommandCwd(repository, input.cwd);
  const command = assertRepositoryCommandAllowed(input.command);
  assertCommandPathOperandsStayInRepository(command, cwd, root);
  const classification = classifyRepositoryCommand(command, repository.defaultBranch);
  const before = repositorySnapshot(root);
  const token = approvalToken(repository, relativeCwd, command, classification, before);
  const execution: RepositoryCommandExecution = {
    status: input.dryRun === true ? 'preview' : 'approval_required',
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    cwd: relativeCwd,
    command: redactProcessOutput(command),
    classification,
    approvalToken: token,
    authorization: input.authorization,
    before,
    policyDecision: input.dryRun === true || classification.risk === 'readonly'
      ? 'allowed'
      : 'approval_required',
  };
  const confirmed = input.authorization === 'confirmed_plan' && input.approvalToken === token;
  const executable = input.dryRun === true || classification.risk === 'readonly' || confirmed;
  execution.policyDecision = executable ? 'allowed' : 'approval_required';
  return {
    root,
    cwd,
    command,
    timeoutMs: boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS),
    maxOutputBytes: boundedInteger(input.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1_024, MAX_OUTPUT_BYTES),
    before,
    execution,
    executable,
  };
}

export function previewRepositoryCommandExecution(
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
): PreparedRepositoryCommandExecution {
  const prepared = prepareRepositoryCommandExecution(repository, input);
  return {
    before: prepared.before,
    executable: prepared.executable,
    execution: prepared.execution,
  };
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
  const prepared = prepareRepositoryCommandExecution(repository, input);
  const { root, cwd, command, timeoutMs, maxOutputBytes, before, execution: base, executable } = prepared;

  if (input.dryRun === true) {
    auditCommand(controllerHome, repository, base);
    return base;
  }

  if (!executable) {
    auditCommand(controllerHome, repository, base);
    return base;
  }
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
    changedPaths: changedSnapshotPaths(before, after),
    policyDecision: 'allowed',
    infrastructureError: result.error ? {
      code: timedOut ? 'COMMAND_TIMED_OUT' : 'COMMAND_SPAWN_FAILED',
      message: error || `repository command failed with exit ${String(result.status ?? 1)}`,
    } : undefined,
  };
  auditCommand(controllerHome, repository, execution);
  return execution;
}

export async function executeRepositoryCommandAsync(
  controllerHome: string,
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
  hooks: RepositoryCommandAsyncHooks = {},
): Promise<RepositoryCommandExecution> {
  const prepared = prepareRepositoryCommandExecution(repository, input);
  const { root, cwd, command, timeoutMs, maxOutputBytes, before, execution: base, executable } = prepared;

  if (input.dryRun === true) {
    auditCommand(controllerHome, repository, base);
    return base;
  }

  if (!executable) {
    auditCommand(controllerHome, repository, base);
    return base;
  }
  const result = await runShellCommand(command, cwd, timeoutMs, maxOutputBytes, hooks);
  const after = repositorySnapshot(root);
  const execution: RepositoryCommandExecution = {
    ...base,
    status: 'executed',
    ok: result.ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    after,
    repositoryChanged: snapshotChanged(before, after),
    changedPaths: changedSnapshotPaths(before, after),
    policyDecision: 'allowed',
    infrastructureError: result.timedOut ? {
      code: 'COMMAND_TIMED_OUT',
      message: result.stderr || `repository command timed out after ${timeoutMs}ms`,
    } : undefined,
  };
  auditCommand(controllerHome, repository, execution);
  return execution;
}
