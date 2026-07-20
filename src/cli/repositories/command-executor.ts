import { createHash } from 'crypto';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { capProcessOutput, redactProcessOutput } from '../../effects/process-runner';
import { terminateProcessTree } from '../../runtime/shared/process-tree';
import { MAX_AGENT_TIMEOUT_MS, MIN_AGENT_TIMEOUT_MS } from '../controller/runtime-config';
import { repositoryControllerRoot } from './controller-home';
import {
  classifyRepositoryCommand,
  type RepositoryCommandAuthorization,
  type RepositoryCommandClassification,
} from './command-classifier';
import {
  assertCommandPathOperandsStayInRepository,
  assertRepositoryCommandInputAllowed,
  type RepositoryCommandExternalPathUsage,
  resolveRepositoryCommandCwd,
} from './command-scope';
import { commandValue, type CanonicalRepositoryCommand, type RepositoryCommandValue } from './command-normalization';
import { loadExternalFilesystemGrants } from '../../runtime/safe-tooling/external-filesystem';
import type { RepositoryRecord } from './types';
import { readRepositoryAccessPolicy } from '../../runtime/control-plane/governance/access-policy';
import { assertResolvedAuthorization, decideAuthorization, type AuthorizationDecision } from '../../runtime/control-plane/governance/authorization';

export { classifyRepositoryCommand } from './command-classifier';
export type {
  RepositoryCommandAuthorization,
  RepositoryCommandClassification,
  RepositoryCommandConfirmation,
  RepositoryCommandRisk,
} from './command-classifier';

export interface ExecuteRepositoryCommandInput {
  command: string | readonly string[];
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
  /** When set, cancel spawn via process-tree kill. Async path only. */
  signal?: AbortSignal;
  /**
   * Reuse a precomputed snapshot (e.g. from preview) so Fast Path does not
   * re-run multiple sync/async git snapshots for the same command.
   */
  reuseSnapshot?: RepositoryCommandSnapshot;
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
  command: RepositoryCommandValue;
  classification: RepositoryCommandClassification;
  approvalToken: string;
  authorization?: RepositoryCommandAuthorization;
  ok?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  stdout?: string;
  stderr?: string;
  before: RepositoryCommandSnapshot;
  after?: RepositoryCommandSnapshot;
  repositoryChanged?: boolean;
  changedPaths?: string[];
  policyDecision?: 'allowed' | 'approval_required' | 'rejected';
  authorizationDecision?: AuthorizationDecision;
  approvalRequestId?: string;
  infrastructureError?: { code: string; message: string };
  externalPathUsages?: RepositoryCommandExternalPathUsage[];
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
  cancelled: boolean;
  stdout: string;
  stderr: string;
}

export interface RepositoryCommandAsyncHooks {
  onSpawn?: (pid: number) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

/** Sensible interactive default for ordinary repository commands. */
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Explicit repository-command timeouts share agent bounds so Local Job
 * deadline resolution and process kill agree (min 5s, max 12h, no silent clamp).
 */
const MIN_TIMEOUT_MS = MIN_AGENT_TIMEOUT_MS;
const MAX_TIMEOUT_MS = MAX_AGENT_TIMEOUT_MS;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export const REPOSITORY_COMMAND_DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
export const REPOSITORY_COMMAND_MIN_TIMEOUT_MS = MIN_TIMEOUT_MS;
export const REPOSITORY_COMMAND_MAX_TIMEOUT_MS = MAX_TIMEOUT_MS;

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

async function killCommandTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    } else {
      child.kill();
    }
  } catch {
    /* already exited */
  }
  await terminateProcessTree(pid, { gracePeriodMs: 200, killAfterMs: 1_000, pollIntervalMs: 25 });
}

async function runCanonicalCommand(
  command: CanonicalRepositoryCommand,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  hooks: RepositoryCommandAsyncHooks = {},
): Promise<SpawnCommandResult> {
  if (hooks.signal?.aborted) {
    return {
      ok: false,
      exitCode: 1,
      timedOut: false,
      cancelled: true,
      stdout: '',
      stderr: 'cancelled before spawn',
    };
  }

  const executable = command.kind === 'argv'
    ? command.executable!
    : process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const args = command.kind === 'argv'
    ? [...(command.args ?? [])]
    : process.platform === 'win32' ? ['/d', '/s', '/c', command.shellCommand!] : ['-c', command.shellCommand!];
  const display = typeof command.value === 'string' ? command.value : JSON.stringify(command.value);
  const stdoutCollector = collectOutput(maxOutputBytes);
  const stderrCollector = collectOutput(maxOutputBytes);
  const useProcessGroup = process.platform !== 'win32';

  return await new Promise<SpawnCommandResult>((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env: commandEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: useProcessGroup,
    });
    if (child.pid) hooks.onSpawn?.(child.pid);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let spawnError = '';
    let timeoutHandle: NodeJS.Timeout | undefined;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      hooks.signal?.removeEventListener('abort', onAbort);
      const stderrParts = [stderrCollector.complete()];
      if (timedOut) stderrParts.push(`process timed out after ${timeoutMs}ms: ${redactProcessOutput(display)}`);
      if (cancelled) stderrParts.push('process cancelled');
      if (spawnError) stderrParts.push(redactProcessOutput(spawnError));
      resolve({
        ok: exitCode === 0 && !timedOut && !cancelled && !spawnError,
        exitCode,
        timedOut,
        cancelled,
        stdout: stdoutCollector.complete(),
        stderr: capProcessOutput(stderrParts.filter(Boolean).join('\n'), maxOutputBytes),
      });
    };

    const onAbort = () => {
      cancelled = true;
      void killCommandTree(child).finally(() => finish(1));
    };

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      void killCommandTree(child).finally(() => finish(1));
    }, timeoutMs);
    timeoutHandle.unref();

    hooks.signal?.addEventListener('abort', onAbort, { once: true });

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

function buildSnapshotFromGitTexts(
  root: string,
  head: string | null,
  branch: string | null,
  status: string,
  refs: string,
): RepositoryCommandSnapshot {
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

function repositorySnapshot(root: string): RepositoryCommandSnapshot {
  const head = gitText(root, ['rev-parse', '--verify', 'HEAD']) || null;
  const branch = gitText(root, ['branch', '--show-current']) || null;
  const status = gitText(root, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '--', ...REPOSITORY_SNAPSHOT_PATHS]);
  const refs = gitText(root, ['show-ref']);
  return buildSnapshotFromGitTexts(root, head, branch, status, refs);
}

interface GitTextAsyncResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

async function gitTextAsync(root: string, args: string[], signal?: AbortSignal): Promise<GitTextAsyncResult> {
  if (signal?.aborted) {
    return { ok: false, exitCode: 1, stdout: '', stderr: 'cancelled', timedOut: false, cancelled: true };
  }
  return await new Promise<GitTextAsyncResult>((resolve) => {
    const child = spawn('git', ['-C', root, ...args], {
      cwd: root,
      env: commandEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const stdout = collectOutput(256 * 1024);
    const stderr = collectOutput(64 * 1024);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void killCommandTree(child).finally(() => {
        if (!settled) {
          settled = true;
          resolve({
            ok: false,
            exitCode: 1,
            stdout: stdout.complete().trim(),
            stderr: `git ${args.join(' ')} timed out`,
            timedOut: true,
            cancelled: false,
          });
        }
      });
    }, 10_000);
    timeout.unref();
    const onAbort = () => {
      cancelled = true;
      void killCommandTree(child).finally(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({
            ok: false,
            exitCode: 1,
            stdout: '',
            stderr: 'cancelled',
            timedOut: false,
            cancelled: true,
          });
        }
      });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => stdout.write(chunk));
    child.stderr?.on('data', (chunk) => stderr.write(chunk));
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        resolve({
          ok: false,
          exitCode: 1,
          stdout: '',
          stderr: error.message,
          timedOut: false,
          cancelled: false,
        });
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      const exitCode = code ?? 1;
      resolve({
        ok: exitCode === 0 && !timedOut && !cancelled,
        exitCode,
        stdout: stdout.complete().trim(),
        stderr: stderr.complete(),
        timedOut,
        cancelled,
      });
    });
  });
}

const MAX_DIRTY_PATHS_FOR_FINGERPRINT = 200;
const MAX_FINGERPRINT_FILE_BYTES = 256 * 1024;
const MAX_FINGERPRINT_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FINGERPRINT_WORKER_MS = 5_000;

/**
 * Async repository snapshot for Fast Path — Git via async spawn, fail-closed.
 * Dirty path fingerprints run in a Worker Thread with hard budgets.
 * Over-budget / git errors → throw (caller may escalate to Durable).
 * Only unborn HEAD and empty refs are allowed non-zero exceptions.
 */
export async function repositorySnapshotAsync(
  root: string,
  signal?: AbortSignal,
): Promise<RepositoryCommandSnapshot> {
  const [headResult, branchResult, statusResult, refsResult] = await Promise.all([
    gitTextAsync(root, ['rev-parse', '--verify', 'HEAD'], signal),
    gitTextAsync(root, ['branch', '--show-current'], signal),
    gitTextAsync(root, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '--', ...REPOSITORY_SNAPSHOT_PATHS], signal),
    gitTextAsync(root, ['show-ref'], signal),
  ]);

  if (statusResult.cancelled || headResult.cancelled || branchResult.cancelled || refsResult.cancelled) {
    throw new Error('CANCELLED: repository snapshot aborted');
  }
  if (statusResult.timedOut || headResult.timedOut) {
    throw new Error('SNAPSHOT_TIMEOUT: git snapshot timed out');
  }
  // status is required — fail closed on any non-ok (empty porcelain is ok only when ok=true)
  if (!statusResult.ok) {
    throw new Error(`SNAPSHOT_FAILED: git status exit ${statusResult.exitCode}: ${statusResult.stderr}`);
  }

  // unborn HEAD: rev-parse exit 128 / known messages → null; other failures fail-closed
  let head: string | null = null;
  if (headResult.ok) {
    head = headResult.stdout || null;
  } else {
    const unborn = headResult.exitCode === 128
      || /unknown revision|bad revision|Needed a single revision|ambiguous argument|not a valid object name/i.test(headResult.stderr);
    if (!unborn) {
      throw new Error(`SNAPSHOT_FAILED: git rev-parse HEAD exit ${headResult.exitCode}: ${headResult.stderr}`);
    }
  }

  // show-ref: empty repo has exit 1 with empty stdout — allowed; other failures fail-closed
  let refs = '';
  if (refsResult.ok) {
    refs = refsResult.stdout;
  } else if (refsResult.exitCode === 1 && !refsResult.stderr.trim()) {
    refs = refsResult.stdout || '';
  } else if (refsResult.exitCode === 1 && /expected|no match|no references/i.test(refsResult.stderr)) {
    refs = refsResult.stdout || '';
  } else {
    throw new Error(`SNAPSHOT_FAILED: git show-ref exit ${refsResult.exitCode}: ${refsResult.stderr}`);
  }

  // branch --show-current may fail on detached/unborn — null is fine when status worked
  const branch = branchResult.ok ? (branchResult.stdout || null) : null;
  const status = statusResult.stdout;

  if (signal?.aborted) throw new Error('CANCELLED: repository snapshot aborted');

  const lines = status.split(/\r?\n/).filter((line) => line && !line.startsWith('##'));
  if (lines.length > MAX_DIRTY_PATHS_FOR_FINGERPRINT) {
    throw new Error(`SNAPSHOT_TOO_DIRTY: ${lines.length} dirty paths exceeds Fast Path cap ${MAX_DIRTY_PATHS_FOR_FINGERPRINT}`);
  }

  const statusByPath = new Map<string, string[]>();
  for (const line of lines) {
    const path = statusPath(line);
    if (!path) continue;
    const entries = statusByPath.get(path) ?? [];
    entries.push(line);
    statusByPath.set(path, entries);
  }
  const paths = [...statusByPath.keys()].sort();

  // Offload fingerprint I/O to Worker Thread (or bounded sync for tiny sets).
  const { computePathFingerprintsAsync } = await import(
    '../../runtime/execution/thin-harness/fingerprint-worker'
  );
  const fingerprintResult = await computePathFingerprintsAsync(
    {
      root,
      paths,
      statusByPath: Object.fromEntries(statusByPath),
      maxFileBytes: MAX_FINGERPRINT_FILE_BYTES,
      maxTotalBytes: MAX_FINGERPRINT_TOTAL_BYTES,
      maxPaths: MAX_DIRTY_PATHS_FOR_FINGERPRINT,
    },
    { signal, timeoutMs: MAX_FINGERPRINT_WORKER_MS },
  );

  return {
    head,
    branch,
    status,
    dirty: paths.length > 0,
    refsHash: createHash('sha256').update(refs).digest('hex'),
    paths,
    pathFingerprints: fingerprintResult.pathFingerprints,
  };
}

function approvalToken(
  repository: RepositoryRecord,
  relativeCwd: string,
  command: RepositoryCommandValue,
  classification: RepositoryCommandClassification,
  snapshot: RepositoryCommandSnapshot,
  externalPathUsages: RepositoryCommandExternalPathUsage[],
): string {
  return createHash('sha256').update(JSON.stringify({
    version: 2,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    cwd: relativeCwd,
    command,
    classification,
    snapshot,
    externalPathUsages,
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

function finalizePreparedExecution(
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
  controllerHome: string | undefined,
  root: string,
  cwd: string,
  relativeCwd: string,
  command: CanonicalRepositoryCommand,
  externalPathUsages: RepositoryCommandExternalPathUsage[],
  classification: RepositoryCommandClassification,
  before: RepositoryCommandSnapshot,
): {
  root: string;
  cwd: string;
  command: CanonicalRepositoryCommand;
  timeoutMs: number;
  maxOutputBytes: number;
  before: RepositoryCommandSnapshot;
  execution: RepositoryCommandExecution;
  executable: boolean;
  externalPathUsages: RepositoryCommandExternalPathUsage[];
} {
  const commandForPersistence = commandValue(command);
  const token = approvalToken(repository, relativeCwd, commandForPersistence, classification, before, externalPathUsages);
  const permission = controllerHome ? readRepositoryAccessPolicy(controllerHome, repository.repoId) : undefined;
  const isGit = command.kind === 'argv'
    ? command.executable?.split(/[\\/]/).at(-1)?.toLowerCase() === 'git'
    : /^\s*git\s+/i.test(command.shellCommand!);
  const risk = classification.risk === 'readonly' ? 'readonly' : classification.risk === 'remote_write' ? 'remote_write' : classification.risk === 'destructive' ? 'destructive' : isGit ? 'local_git' : 'workspace_write';
  const delegated = input.authorizationDecision ?? (controllerHome ? decideAuthorization({
    controllerHome,
    accessMode: permission?.mode ?? 'request',
    risk,
    repositoryId: repository.repoId,
    currentRepositoryId: repository.repoId,
    permissionSnapshotVersion: permission?.revision ?? 1,
    approvalToken: token,
    command: commandForPersistence,
    cwd: relativeCwd,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.principalId ? { principalId: input.principalId } : {}),
    ...(input.workId ? { workId: input.workId, boundWorkId: input.workId } : {}),
  }) : undefined);
  const resolved = controllerHome && input.approvalRequestId
    ? assertResolvedAuthorization({ controllerHome, repositoryId: repository.repoId, approvalRequestId: input.approvalRequestId, sessionId: input.sessionId, principalId: input.principalId, workId: input.workId, permissionSnapshotVersion: permission?.revision ?? 1, command: commandForPersistence })
    : undefined;
  const effectiveDecision: AuthorizationDecision | undefined = resolved
    ? { decision: 'allow', source: 'user_confirmation', reason: 'Resolved approval request matches the exact command and current permission snapshot.' }
    : delegated;
  const execution: RepositoryCommandExecution = {
    status: input.dryRun === true ? 'preview' : 'approval_required',
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    cwd: relativeCwd,
    command: commandForPersistence,
    classification,
    approvalToken: token,
    authorization: input.authorization,
    before,
    policyDecision: input.dryRun === true || classification.risk === 'readonly'
      ? 'allowed'
      : effectiveDecision?.decision === 'allow' ? 'allowed' : 'approval_required',
    ...(effectiveDecision ? { authorizationDecision: effectiveDecision } : {}),
    ...(effectiveDecision?.decision === 'user_confirmation_required' ? { approvalRequestId: effectiveDecision.approvalRequestId } : {}),
    externalPathUsages: externalPathUsages.length > 0 ? externalPathUsages : undefined,
  };
  const confirmed = input.authorization === 'confirmed_plan' && input.approvalToken === token;
  const delegatedAllowed = effectiveDecision?.decision === 'allow';
  const executable = input.dryRun === true || classification.risk === 'readonly' || confirmed || delegatedAllowed;
  execution.policyDecision = executable ? 'allowed' : 'approval_required';
  return {
    root,
    cwd,
    command,
    timeoutMs: boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxOutputBytes: boundedInteger(input.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1_024, MAX_OUTPUT_BYTES),
    before,
    execution,
    executable,
    externalPathUsages,
  };
}

function prepareRepositoryCommandExecution(
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
  controllerHome?: string,
): {
  root: string;
  cwd: string;
  command: CanonicalRepositoryCommand;
  timeoutMs: number;
  maxOutputBytes: number;
  before: RepositoryCommandSnapshot;
  execution: RepositoryCommandExecution;
  executable: boolean;
  externalPathUsages: RepositoryCommandExternalPathUsage[];
} {
  const { root, cwd, relativeCwd } = resolveRepositoryCommandCwd(repository, input.cwd);
  const command = assertRepositoryCommandInputAllowed(input.command);
  const externalGrants = loadExternalFilesystemGrants(root).grants;
  const externalPathUsages = assertCommandPathOperandsStayInRepository(command, cwd, root, externalGrants);
  const classification = classifyRepositoryCommand(command, repository.defaultBranch);
  const before = input.reuseSnapshot ?? repositorySnapshot(root);
  return finalizePreparedExecution(
    repository,
    input,
    controllerHome,
    root,
    cwd,
    relativeCwd,
    command,
    externalPathUsages,
    classification,
    before,
  );
}

async function prepareRepositoryCommandExecutionAsync(
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
  controllerHome?: string,
): Promise<{
  root: string;
  cwd: string;
  command: CanonicalRepositoryCommand;
  timeoutMs: number;
  maxOutputBytes: number;
  before: RepositoryCommandSnapshot;
  execution: RepositoryCommandExecution;
  executable: boolean;
  externalPathUsages: RepositoryCommandExternalPathUsage[];
}> {
  const { root, cwd, relativeCwd } = resolveRepositoryCommandCwd(repository, input.cwd);
  const command = assertRepositoryCommandInputAllowed(input.command);
  const externalGrants = loadExternalFilesystemGrants(root).grants;
  const externalPathUsages = assertCommandPathOperandsStayInRepository(command, cwd, root, externalGrants);
  const classification = classifyRepositoryCommand(command, repository.defaultBranch);
  const before = input.reuseSnapshot ?? await repositorySnapshotAsync(root, input.signal);
  return finalizePreparedExecution(
    repository,
    input,
    controllerHome,
    root,
    cwd,
    relativeCwd,
    command,
    externalPathUsages,
    classification,
    before,
  );
}

export function previewRepositoryCommandExecution(
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
  controllerHome?: string,
): PreparedRepositoryCommandExecution {
  const prepared = prepareRepositoryCommandExecution(repository, input, controllerHome);
  return {
    before: prepared.before,
    executable: prepared.executable,
    execution: prepared.execution,
  };
}

/** Async preview — preferred on Fast Path to avoid blocking Gateway with sync git snapshots. */
export async function previewRepositoryCommandExecutionAsync(
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
  controllerHome?: string,
): Promise<PreparedRepositoryCommandExecution> {
  const prepared = await prepareRepositoryCommandExecutionAsync(repository, input, controllerHome);
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
  const prepared = prepareRepositoryCommandExecution(repository, input, controllerHome);
  const { root, cwd, command, timeoutMs, maxOutputBytes, before, execution: base, executable, externalPathUsages } = prepared;

  if (input.dryRun === true) {
    auditCommand(controllerHome, repository, base);
    return base;
  }

  if (!executable) {
    auditCommand(controllerHome, repository, base);
    return base;
  }
  const executableName = command.kind === 'argv'
    ? command.executable!
    : process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const commandArgs = command.kind === 'argv'
    ? [...(command.args ?? [])]
    : process.platform === 'win32' ? ['/d', '/s', '/c', command.shellCommand!] : ['-c', command.shellCommand!];
  const result = spawnSync(executableName, commandArgs, {
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
    externalPathUsages: externalPathUsages.length > 0 ? externalPathUsages : undefined,
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
  const signal = hooks.signal ?? input.signal;
  const prepared = await prepareRepositoryCommandExecutionAsync(
    repository,
    { ...input, signal },
    controllerHome,
  );
  const { root, cwd, command, timeoutMs, maxOutputBytes, before, execution: base, executable, externalPathUsages } = prepared;

  if (input.dryRun === true) {
    auditCommand(controllerHome, repository, base);
    return base;
  }

  if (!executable) {
    auditCommand(controllerHome, repository, base);
    return base;
  }
  if (signal?.aborted) {
    const cancelled: RepositoryCommandExecution = {
      ...base,
      status: 'executed',
      ok: false,
      exitCode: 1,
      timedOut: false,
      cancelled: true,
      stdout: '',
      stderr: 'cancelled before spawn',
      after: before,
      repositoryChanged: false,
      changedPaths: [],
      policyDecision: 'allowed',
      infrastructureError: { code: 'COMMAND_CANCELLED', message: 'cancelled before spawn' },
    };
    auditCommand(controllerHome, repository, cancelled);
    return cancelled;
  }

  const result = await runCanonicalCommand(command, cwd, timeoutMs, maxOutputBytes, {
    ...hooks,
    signal,
  });
  const after = await repositorySnapshotAsync(root, signal?.aborted ? undefined : signal);
  const execution: RepositoryCommandExecution = {
    ...base,
    status: 'executed',
    ok: result.ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    stdout: result.stdout,
    stderr: result.stderr,
    after,
    repositoryChanged: snapshotChanged(before, after),
    changedPaths: changedSnapshotPaths(before, after),
    policyDecision: 'allowed',
    externalPathUsages: externalPathUsages.length > 0 ? externalPathUsages : undefined,
    infrastructureError: result.timedOut
      ? {
        code: 'COMMAND_TIMED_OUT',
        message: result.stderr || `repository command timed out after ${timeoutMs}ms`,
      }
      : result.cancelled
        ? {
          code: 'COMMAND_CANCELLED',
          message: result.stderr || 'repository command cancelled',
        }
        : undefined,
  };
  auditCommand(controllerHome, repository, execution);
  return execution;
}
