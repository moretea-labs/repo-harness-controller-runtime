#!/usr/bin/env bun
/**
 * Independent Process Runner.
 *
 * Controller
 *    |
 *    | spawn once (detached)
 *    v
 * Process Runner  (this process — outlives Controller)
 *    |
 *    | spawn actual command once
 *    v
 * Actual Command
 *
 * Responsibilities:
 * - Execute the command exactly once from a structured descriptor.
 * - Capture exit code / signal / timeout / cancellation.
 * - Atomically write exit receipt (survives Controller crash).
 * - Bound stdout/stderr disk logs with hard quotas.
 * - Forward SIGTERM / SIGINT to the child.
 * - Never re-exec the command on Controller restart.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { spawn, type ChildProcess } from 'child_process';

export interface ProcessCommandDescriptor {
  schemaVersion: 1;
  processId: string;
  repoId: string;
  controllerHome: string;
  command: {
    kind: 'argv' | 'shell';
    executable?: string;
    args?: string[];
    shellCommand?: string;
    cwd: string;
    env?: Record<string, string | undefined>;
  };
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  stdoutPath: string;
  stderrPath: string;
  exitReceiptPath: string;
  startedAt: string;
}

export interface ProcessRunnerExitReceipt {
  schemaVersion: 1;
  processId: string;
  exitCode: number | null;
  signal?: string;
  finishedAt: string;
  startedAt: string;
  timedOut?: boolean;
  cancelled?: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutStoredBytes: number;
  stderrStoredBytes: number;
  logTruncated: boolean;
  runnerPid: number;
  commandExecutedOnce: true;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function loadDescriptor(path: string): ProcessCommandDescriptor {
  const value = JSON.parse(readFileSync(path, 'utf8')) as ProcessCommandDescriptor;
  if (value?.schemaVersion !== 1 || !value.processId || !value.command) {
    throw new Error(`PROCESS_RUNNER_BAD_DESCRIPTOR: ${path}`);
  }
  return value;
}

function spawnCommand(command: ProcessCommandDescriptor['command']): ChildProcess {
  const useProcessGroup = process.platform !== 'win32';
  if (command.kind === 'shell') {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
    const shellArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', command.shellCommand ?? '']
      : ['-lc', command.shellCommand ?? ''];
    return spawn(shell, shellArgs, {
      cwd: command.cwd,
      env: { ...process.env, ...(command.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: useProcessGroup,
    });
  }
  return spawn(command.executable ?? 'true', command.args ?? [], {
    cwd: command.cwd,
    env: { ...process.env, ...(command.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: useProcessGroup,
  });
}

class BoundedLogWriter {
  private fd: number | undefined;
  private storedBytes = 0;
  private totalBytes = 0;
  private truncated = false;

  constructor(
    private readonly path: string,
    private readonly maxBytes: number,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
    try {
      this.fd = openSync(path, 'a');
    } catch {
      this.fd = undefined;
    }
  }

  write(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    if (this.storedBytes >= this.maxBytes) {
      this.truncated = true;
      return;
    }
    const remaining = this.maxBytes - this.storedBytes;
    const toWrite = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    try {
      if (this.fd !== undefined) writeFileSync(this.fd, toWrite);
      else appendFileSync(this.path, toWrite);
      this.storedBytes += toWrite.length;
      if (toWrite.length < chunk.length) this.truncated = true;
    } catch {
      /* best-effort */
    }
  }

  close(): void {
    try {
      if (this.fd !== undefined) closeSync(this.fd);
    } catch {
      /* ignore */
    }
    this.fd = undefined;
  }

  stats(): { totalBytes: number; storedBytes: number; truncated: boolean } {
    return {
      totalBytes: this.totalBytes,
      storedBytes: this.storedBytes,
      truncated: this.truncated,
    };
  }
}

async function killTree(child: ChildProcess): Promise<void> {
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
  // Brief grace then SIGKILL.
  await new Promise((r) => setTimeout(r, 200));
  try {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* ignore */
  }
}

/**
 * Atomic "started" claim for exactly-once execution.
 * Two runners with the same descriptor must not both spawn the command:
 * the first to create `<exitReceiptPath>.started.json` wins; the second exits.
 */
export function startedClaimPath(exitReceiptPath: string): string {
  return `${exitReceiptPath}.started.json`;
}

export function claimRunnerStarted(exitReceiptPath: string, processId: string): {
  claimed: boolean;
  path: string;
  reason?: string;
} {
  const path = startedClaimPath(exitReceiptPath);
  mkdirSync(dirname(path), { recursive: true });
  // O_EXCL-style create: write exclusive tmp then rename only if dest missing is racy;
  // use openSync with 'wx' for true atomic create on POSIX.
  try {
    const fd = openSync(path, 'wx');
    try {
      writeFileSync(fd, `${JSON.stringify({
        schemaVersion: 1,
        processId,
        runnerPid: process.pid,
        claimedAt: new Date().toISOString(),
      }, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    return { claimed: true, path };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: string }).code)
      : '';
    if (code === 'EEXIST' || existsSync(path)) {
      return { claimed: false, path, reason: 'started_claim_held' };
    }
    throw error;
  }
}

export async function runProcessRunnerFromDescriptor(
  descriptor: ProcessCommandDescriptor,
): Promise<ProcessRunnerExitReceipt> {
  if (existsSync(descriptor.exitReceiptPath)) {
    // Idempotent: once any terminal receipt exists, never re-execute. A corrupt
    // receipt is an outcome-recovery problem, not permission to run again.
    try {
      return JSON.parse(readFileSync(descriptor.exitReceiptPath, 'utf8')) as ProcessRunnerExitReceipt;
    } catch {
      throw new Error(`PROCESS_RUNNER_RECEIPT_CORRUPT: ${descriptor.exitReceiptPath}`);
    }
  }

  // Atomic started claim before spawn — second runner for same descriptor must not re-exec.
  const claim = claimRunnerStarted(descriptor.exitReceiptPath, descriptor.processId);
  if (!claim.claimed) {
    // Another runner already started (or completed and left claim). Prefer reading
    // receipt if it appeared; otherwise report completed_unknown without re-exec.
    if (existsSync(descriptor.exitReceiptPath)) {
      try {
        return JSON.parse(readFileSync(descriptor.exitReceiptPath, 'utf8')) as ProcessRunnerExitReceipt;
      } catch {
        throw new Error(`PROCESS_RUNNER_RECEIPT_CORRUPT: ${descriptor.exitReceiptPath}`);
      }
    }
    throw new Error(
      `PROCESS_RUNNER_ALREADY_STARTED: ${descriptor.processId} claim held at ${claim.path}`,
    );
  }

  const stdout = new BoundedLogWriter(descriptor.stdoutPath, descriptor.maxStdoutBytes);
  const stderr = new BoundedLogWriter(descriptor.stderrPath, descriptor.maxStderrBytes);
  const child = spawnCommand(descriptor.command);
  let timedOut = false;
  let cancelled = false;
  let settled = false;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    void killTree(child);
  }, Math.max(1, descriptor.timeoutMs));
  timeoutHandle.unref?.();

  const onSignal = (signal: NodeJS.Signals) => {
    cancelled = true;
    void killTree(child).finally(() => {
      // After forwarding, allow natural close path to write receipt.
      if (signal === 'SIGTERM' || signal === 'SIGINT') {
        /* child close handler writes receipt */
      }
    });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk));

  const closeResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      stderr.write(Buffer.from(`\n[process-runner] spawn error: ${error.message}\n`));
      resolve({ code: 1, signal: null });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({ code, signal });
    });
  });

  stdout.close();
  stderr.close();
  const outStats = stdout.stats();
  const errStats = stderr.stats();
  const finishedAt = new Date().toISOString();
  const exitCode = closeResult.code ?? (closeResult.signal ? 1 : 1);
  const receipt: ProcessRunnerExitReceipt = {
    schemaVersion: 1,
    processId: descriptor.processId,
    exitCode,
    signal: closeResult.signal ?? undefined,
    finishedAt,
    startedAt: descriptor.startedAt,
    timedOut: timedOut || undefined,
    cancelled: cancelled || undefined,
    stdoutBytes: outStats.totalBytes,
    stderrBytes: errStats.totalBytes,
    stdoutStoredBytes: outStats.storedBytes,
    stderrStoredBytes: errStats.storedBytes,
    logTruncated: outStats.truncated || errStats.truncated,
    runnerPid: process.pid,
    commandExecutedOnce: true,
  };
  atomicWrite(descriptor.exitReceiptPath, receipt);
  return receipt;
}

async function main(): Promise<void> {
  const descriptorPath = option('--descriptor') ?? option('--command-json');
  if (!descriptorPath) {
    console.error('process-runner-entry requires --descriptor <path-to-command.json>');
    process.exit(2);
  }
  if (!existsSync(descriptorPath)) {
    console.error(`process-runner-entry: descriptor not found: ${descriptorPath}`);
    process.exit(2);
  }
  const descriptor = loadDescriptor(descriptorPath);
  // Detach from controlling terminal / parent death signals as much as possible.
  try {
    process.chdir(descriptor.command.cwd);
  } catch {
    /* keep runner cwd */
  }
  try {
    const receipt = await runProcessRunnerFromDescriptor(descriptor);
    process.exit(receipt.exitCode === 0 && !receipt.timedOut && !receipt.cancelled ? 0 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Duplicate start is not a re-exec failure of the command — exit with a
    // distinct code so the controller can treat it as completed_unknown.
    if (message.startsWith('PROCESS_RUNNER_ALREADY_STARTED:')) {
      console.error('[process-runner]', message);
      process.exit(75);
    }
    if (message.startsWith('PROCESS_RUNNER_RECEIPT_CORRUPT:')) {
      console.error('[process-runner]', message);
      process.exit(74);
    }
    throw error;
  }
}

const isDirectRun = typeof process.argv[1] === 'string'
  && (
    process.argv[1].includes('process-runner-entry')
    || process.argv[1].includes('process-runner.js')
    || process.env.REPO_HARNESS_PROCESS_RUNNER === '1'
  );

if (isDirectRun) {
  void main().catch((error) => {
    console.error('[process-runner]', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
