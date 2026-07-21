/**
 * Unified Process Runtime.
 *
 * One spawn path serves Direct (wait briefly then return result) and Managed
 * (return handle when still running). Commands are never re-executed after spawn.
 *
 * Architecture:
 *   Controller → Process Runner (independent) → Actual Command
 *
 * Exit receipts are written by the Process Runner, so Controller crash/SIGKILL
 * does not lose the true exit code. Controller only attaches / polls / reads
 * receipt after restart — never re-spawns the command.
 */

import { createHash, randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { capProcessOutput, redactProcessOutput } from '../../../effects/process-runner';
import { isProcessAlive, terminateProcessTree } from '../../shared/process-tree';
import { defaultProcessIdentityProbe, executableFingerprint } from '../../supervisor/identity';
import {
  createProcessRecord,
  getProcessRecord,
  listActiveProcessIds,
  processLogDir,
  tryCompleteProcessRecord,
  updateProcessRecord,
} from './store';
import {
  DEFAULT_INTERACTIVE_WAIT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_PROCESS_TIMEOUT_MS,
  PROCESS_LOG_TAIL_BYTES,
  type ManagedProcessRecord,
  type ProcessHandle,
  type ProcessLogSlice,
  type SpawnManagedProcessInput,
  type WaitProcessOptions,
} from './types';
import type {
  ProcessCommandDescriptor,
  ProcessRunnerExitReceipt,
} from './process-runner-entry';

interface LiveMonitor {
  processId: string;
  repoId: string;
  controllerHome: string;
  /** Runner process (not the actual command). */
  child: ChildProcess;
  fenceToken: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutStoredBytes: number;
  stderrStoredBytes: number;
  stdoutTail: Buffer;
  stderrTail: Buffer;
  maxTailBytes: number;
  maxDiskBytes: number;
  logTruncated: boolean;
  settled: boolean;
  timeoutHandle?: NodeJS.Timeout;
  waiters: Array<(record: ManagedProcessRecord) => void>;
  stdoutPath: string;
  stderrPath: string;
  exitReceiptPath: string;
  descriptorPath: string;
  commandFingerprint: string;
}

const liveMonitors = new Map<string, LiveMonitor>();

function nowIso(): string {
  return new Date().toISOString();
}

function newProcessId(): string {
  return `proc_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function tailText(buffer: Buffer, maxBytes: number): string {
  if (buffer.length <= maxBytes) return redactProcessOutput(buffer.toString('utf8'));
  // Drop incomplete leading UTF-8 sequence after offset cut.
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return redactProcessOutput(buffer.subarray(start).toString('utf8'));
}

function appendTail(current: Buffer, chunk: Buffer, maxBytes: number): Buffer {
  if (chunk.length >= maxBytes) return Buffer.from(chunk.subarray(chunk.length - maxBytes));
  const nextLen = current.length + chunk.length;
  if (nextLen <= maxBytes) return Buffer.concat([current, chunk]);
  const keep = maxBytes - chunk.length;
  return Buffer.concat([current.subarray(current.length - keep), chunk]);
}

/**
 * Read only the last maxBytes of a file without loading the whole file.
 * Tolerates incomplete leading UTF-8 sequences.
 */
export function readFileTailBytes(path: string, maxBytes: number): { text: string; fileBytes: number } {
  if (!path || !existsSync(path)) return { text: '', fileBytes: 0 };
  const size = statSync(path).size;
  if (size <= 0) return { text: '', fileBytes: 0 };
  const readSize = Math.min(size, Math.max(1, maxBytes));
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(readSize);
    const offset = size - readSize;
    const bytesRead = require('fs').readSync(fd, buf, 0, readSize, offset) as number;
    let start = 0;
    // Skip incomplete leading UTF-8 continuation bytes when we started mid-sequence.
    if (offset > 0) {
      while (start < bytesRead && (buf[start]! & 0xc0) === 0x80) start += 1;
    }
    const text = redactProcessOutput(buf.subarray(start, bytesRead).toString('utf8'));
    return { text, fileBytes: size };
  } finally {
    closeSync(fd);
  }
}

function captureIdentity(pid: number | undefined): {
  identity?: ManagedProcessRecord['identity'];
  identityUntrusted?: boolean;
} {
  if (!pid || pid <= 0) return {};
  const probe = defaultProcessIdentityProbe;
  if (!probe.isAlive(pid)) return {};
  const command = probe.command(pid);
  const startTime = probe.startTime(pid);
  if (!command || !startTime) {
    return {
      identity: {
        pid,
        processStartTime: `untrusted:${Date.now()}`,
        executableFingerprint: createHash('sha256').update(`pid:${pid}`).digest('hex').slice(0, 24),
        processGroupId: process.platform !== 'win32' ? pid : undefined,
      },
      identityUntrusted: true,
    };
  }
  return {
    identity: {
      pid,
      processStartTime: startTime,
      executableFingerprint: executableFingerprint(command),
      processGroupId: process.platform !== 'win32' ? pid : undefined,
    },
    identityUntrusted: false,
  };
}

function identityStillMatches(identity: ManagedProcessRecord['identity'] | undefined, untrusted?: boolean): boolean {
  if (!identity) return false;
  if (untrusted || identity.processStartTime.startsWith('untrusted:') || identity.processStartTime.startsWith('fallback:')) {
    return false;
  }
  if (!isProcessAlive(identity.pid)) return false;
  const probe = defaultProcessIdentityProbe;
  const startTime = probe.startTime(identity.pid);
  const command = probe.command(identity.pid);
  if (!startTime || !command) return false;
  if (startTime !== identity.processStartTime) return false;
  if (executableFingerprint(command) !== identity.executableFingerprint) return false;
  return true;
}

export interface ProcessExitReceipt {
  schemaVersion: 1;
  processId: string;
  exitCode: number | null;
  signal?: string;
  finishedAt: string;
  startedAt?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutStoredBytes?: number;
  stderrStoredBytes?: number;
  logTruncated?: boolean;
  runnerPid?: number;
  commandExecutedOnce?: boolean;
}

function receiptPathFor(controllerHome: string, repoId: string, processId: string): string {
  return join(processLogDir(controllerHome, repoId), `${processId}.exit.json`);
}

function descriptorPathFor(controllerHome: string, repoId: string, processId: string): string {
  return join(processLogDir(controllerHome, repoId), `${processId}.command.json`);
}

function writeExitReceipt(path: string, receipt: ProcessExitReceipt): void {
  try {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
  } catch {
    /* best-effort receipt */
  }
}

function readExitReceipt(path: string | undefined): ProcessExitReceipt | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ProcessExitReceipt;
    if (value?.schemaVersion !== 1) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function statusFromReceipt(receipt: ProcessExitReceipt): ManagedProcessRecord['status'] {
  if (receipt.cancelled) return 'cancelled';
  if (receipt.timedOut) return 'timed_out';
  const code = receipt.exitCode ?? 1;
  return code === 0 ? 'succeeded' : 'failed';
}

/**
 * Central terminal completion path used by finalizeMonitor, getProcessHandle,
 * waitForProcess, recoverManagedProcesses, and cancelProcess.
 * Durable terminal record writes require active writer fencing.
 * Receipt itself is independent evidence and is never blocked by fencing.
 */
export function completeProcessFromEvidence(
  controllerHome: string,
  repoId: string,
  processId: string,
  fenceToken: number,
  evidence: {
    status: ManagedProcessRecord['status'];
    exitCode?: number | null;
    timedOut?: boolean;
    cancelled?: boolean;
    finishedAt?: string;
    errorMessage?: string;
    stdoutBytes?: number;
    stderrBytes?: number;
    stdoutStoredBytes?: number;
    stderrStoredBytes?: number;
    logTruncated?: boolean;
    exitReceiptPath?: string;
    stdoutTail?: string;
    stderrTail?: string;
  },
): ManagedProcessRecord | undefined {
  // Passive / fenced runtimes may observe exit but must not write shared durable terminal state.
  let mayWriteTerminal = true;
  try {
    const { assertThisRuntimeMayWrite } = require('../../../cli/controller/stable-state/runtime-writer-context') as typeof import('../../../cli/controller/stable-state/runtime-writer-context');
    const fence = assertThisRuntimeMayWrite('write_process_terminal', controllerHome);
    if (!fence.allowed) mayWriteTerminal = false;
  } catch {
    // Unbound: only allow when no stable authority exists (legacy single-runtime).
    try {
      const { readWriterAuthority } = require('../../../cli/controller/stable-state/writer-authority') as typeof import('../../../cli/controller/stable-state/writer-authority');
      const { resolveStableControllerHome } = require('../../../cli/controller/stable-state/stable-home') as typeof import('../../../cli/controller/stable-state/stable-home');
      const authority = readWriterAuthority(resolveStableControllerHome(controllerHome));
      if (authority) mayWriteTerminal = false;
    } catch {
      /* legacy allow */
    }
  }

  if (!mayWriteTerminal) {
    return getProcessRecord(controllerHome, repoId, processId);
  }

  const completion = tryCompleteProcessRecord(
    controllerHome,
    repoId,
    processId,
    fenceToken,
    {
      status: evidence.status,
      exitCode: evidence.exitCode ?? undefined,
      timedOut: evidence.timedOut,
      cancelled: evidence.cancelled,
      finishedAt: evidence.finishedAt ?? nowIso(),
      exitReceiptPath: evidence.exitReceiptPath,
      stdoutBytes: evidence.stdoutBytes,
      stderrBytes: evidence.stderrBytes,
      stdoutStoredBytes: evidence.stdoutStoredBytes,
      stderrStoredBytes: evidence.stderrStoredBytes,
      logTruncated: evidence.logTruncated,
      stdoutTail: evidence.stdoutTail,
      stderrTail: evidence.stderrTail,
      ...(evidence.errorMessage
        ? { error: { code: evidence.status.toUpperCase(), message: evidence.errorMessage } }
        : {}),
    },
  );
  return completion.record ?? getProcessRecord(controllerHome, repoId, processId);
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
  await terminateProcessTree(pid, { gracePeriodMs: 200, killAfterMs: 1_500, pollIntervalMs: 25 });
}

function runnerEntryPath(): string {
  // Resolve relative to this module so tests and installed releases both work.
  try {
    const here = typeof __dirname !== 'undefined'
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
    return join(here, 'process-runner-entry.ts');
  } catch {
    return join(process.cwd(), 'src/runtime/execution/process-runtime/process-runner-entry.ts');
  }
}

function commandFingerprint(command: ManagedProcessRecord['command']): string {
  return createHash('sha256')
    .update(JSON.stringify({
      kind: command.kind,
      executable: command.executable,
      args: command.args,
      shellCommand: command.shellCommand,
      cwd: command.cwd,
    }))
    .digest('hex')
    .slice(0, 24);
}

/**
 * finalizeMonitor order (required):
 * 1. close log fds (runner owns disk logs; controller may only have tails)
 * 2. write/read independent exit receipt
 * 3. update in-memory waiters
 * 4. clear live monitor
 * 5. attempt durable terminal record (writer-fenced)
 */
function finalizeMonitor(
  monitor: LiveMonitor,
  status: ManagedProcessRecord['status'],
  exitCode: number,
  timedOut: boolean,
  cancelled: boolean,
  errorMessage?: string,
): ManagedProcessRecord | undefined {
  if (monitor.settled) {
    return getProcessRecord(monitor.controllerHome, monitor.repoId, monitor.processId);
  }
  monitor.settled = true;
  if (monitor.timeoutHandle) clearTimeout(monitor.timeoutHandle);

  // Prefer runner-written receipt; fall back to controller-written receipt only
  // when runner died without writing one (legacy / crash of both).
  let receipt = readExitReceipt(monitor.exitReceiptPath);
  if (!receipt) {
    // Controller-side receipt only when runner did not produce one.
    writeExitReceipt(monitor.exitReceiptPath, {
      schemaVersion: 1,
      processId: monitor.processId,
      exitCode,
      finishedAt: nowIso(),
      timedOut,
      cancelled,
      stdoutBytes: monitor.stdoutBytes,
      stderrBytes: monitor.stderrBytes,
      stdoutStoredBytes: monitor.stdoutStoredBytes,
      stderrStoredBytes: monitor.stderrStoredBytes,
      logTruncated: monitor.logTruncated,
    });
    receipt = readExitReceipt(monitor.exitReceiptPath);
  }

  const finalStatus = receipt ? statusFromReceipt(receipt) : status;
  const finalExit = receipt?.exitCode ?? exitCode;
  const finalTimedOut = receipt?.timedOut ?? timedOut;
  const finalCancelled = receipt?.cancelled ?? cancelled;

  const stdoutBuf = monitor.stdoutTail;
  const stderrBuf = monitor.stderrTail;
  const stdout = capProcessOutput(redactProcessOutput(stdoutBuf.toString('utf8')), DEFAULT_MAX_OUTPUT_BYTES);
  const stderrParts = [
    redactProcessOutput(stderrBuf.toString('utf8')),
    finalTimedOut ? 'process timed out' : '',
    finalCancelled ? 'process cancelled' : '',
    errorMessage ? redactProcessOutput(errorMessage) : '',
  ].filter(Boolean);
  const stderr = capProcessOutput(stderrParts.join('\n'), DEFAULT_MAX_OUTPUT_BYTES);

  const enrichedPatch = {
    status: finalStatus,
    exitCode: finalExit ?? undefined,
    timedOut: finalTimedOut,
    cancelled: finalCancelled,
    finishedAt: receipt?.finishedAt ?? nowIso(),
    exitReceiptPath: monitor.exitReceiptPath,
    stdoutBytes: receipt?.stdoutBytes ?? monitor.stdoutBytes,
    stderrBytes: receipt?.stderrBytes ?? monitor.stderrBytes,
    stdoutStoredBytes: receipt?.stdoutStoredBytes ?? monitor.stdoutStoredBytes,
    stderrStoredBytes: receipt?.stderrStoredBytes ?? monitor.stderrStoredBytes,
    logTruncated: receipt?.logTruncated ?? monitor.logTruncated,
    stdoutTail: tailText(stdoutBuf, PROCESS_LOG_TAIL_BYTES),
    stderrTail: tailText(Buffer.from(stderr, 'utf8'), PROCESS_LOG_TAIL_BYTES),
    errorMessage,
  };

  // Durable terminal write is fenced; waiters still get local outcome.
  const record = completeProcessFromEvidence(
    monitor.controllerHome,
    monitor.repoId,
    monitor.processId,
    monitor.fenceToken,
    enrichedPatch,
  );

  const forWaiters: ManagedProcessRecord = {
    ...(record ?? getProcessRecord(monitor.controllerHome, monitor.repoId, monitor.processId)!),
    status: finalStatus,
    exitCode: finalExit ?? undefined,
    timedOut: finalTimedOut,
    cancelled: finalCancelled,
    stdoutTail: stdout.slice(-PROCESS_LOG_TAIL_BYTES),
    stderrTail: stderr.slice(-PROCESS_LOG_TAIL_BYTES),
    terminalWritten: record?.terminalWritten === true,
  };
  for (const waiter of monitor.waiters.splice(0)) waiter(forWaiters);
  liveMonitors.delete(monitor.processId);
  return record ?? forWaiters;
}

function attachRunnerMonitor(
  record: ManagedProcessRecord,
  runner: ChildProcess,
  options: {
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
    stdoutPath: string;
    stderrPath: string;
    exitReceiptPath: string;
    descriptorPath: string;
  },
): LiveMonitor {
  const maxDisk = options.maxOutputBytes;
  const monitor: LiveMonitor = {
    processId: record.processId,
    repoId: record.repoId,
    controllerHome: record.controllerHome,
    child: runner,
    fenceToken: record.terminalFenceToken,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutStoredBytes: 0,
    stderrStoredBytes: 0,
    stdoutTail: Buffer.alloc(0),
    stderrTail: Buffer.alloc(0),
    maxTailBytes: Math.min(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
    maxDiskBytes: maxDisk,
    logTruncated: false,
    settled: false,
    waiters: [],
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
    exitReceiptPath: options.exitReceiptPath,
    descriptorPath: options.descriptorPath,
    commandFingerprint: commandFingerprint(record.command),
  };

  // Poll disk logs for in-memory tail (runner writes files; controller does not re-append unbounded).
  const pollLogs = () => {
    if (monitor.settled) return;
    try {
      if (existsSync(options.stdoutPath)) {
        const st = statSync(options.stdoutPath);
        monitor.stdoutStoredBytes = st.size;
        monitor.stdoutBytes = Math.max(monitor.stdoutBytes, st.size);
        if (st.size >= maxDisk) monitor.logTruncated = true;
        const tail = readFileTailBytes(options.stdoutPath, monitor.maxTailBytes);
        monitor.stdoutTail = Buffer.from(tail.text, 'utf8');
      }
      if (existsSync(options.stderrPath)) {
        const st = statSync(options.stderrPath);
        monitor.stderrStoredBytes = st.size;
        monitor.stderrBytes = Math.max(monitor.stderrBytes, st.size);
        if (st.size >= maxDisk) monitor.logTruncated = true;
        const tail = readFileTailBytes(options.stderrPath, monitor.maxTailBytes);
        monitor.stderrTail = Buffer.from(tail.text, 'utf8');
      }
    } catch {
      /* best-effort */
    }
  };
  const pollTimer = setInterval(pollLogs, 100);
  pollTimer.unref?.();

  const onAbort = () => {
    void killTree(runner).finally(() => {
      clearInterval(pollTimer);
      finalizeMonitor(monitor, 'cancelled', 1, false, true, 'cancelled by signal');
    });
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  // Controller-side timeout is a safety net; runner also enforces timeout.
  monitor.timeoutHandle = setTimeout(() => {
    void killTree(runner).finally(() => {
      clearInterval(pollTimer);
      finalizeMonitor(monitor, 'timed_out', 1, true, false, `process timed out after ${options.timeoutMs}ms`);
    });
  }, Math.max(1, options.timeoutMs + 2_000));
  monitor.timeoutHandle.unref?.();

  runner.on('error', (error) => {
    clearInterval(pollTimer);
    finalizeMonitor(monitor, 'failed', 1, false, false, error.message);
    options.signal?.removeEventListener('abort', onAbort);
  });
  runner.on('close', () => {
    options.signal?.removeEventListener('abort', onAbort);
    clearInterval(pollTimer);
    pollLogs();
    const receipt = readExitReceipt(options.exitReceiptPath);
    if (receipt) {
      finalizeMonitor(
        monitor,
        statusFromReceipt(receipt),
        receipt.exitCode ?? 1,
        receipt.timedOut === true,
        receipt.cancelled === true,
      );
      return;
    }
    // Runner exited without receipt — unknown / failed.
    finalizeMonitor(monitor, 'failed', 1, false, false, 'process runner exited without receipt');
  });

  liveMonitors.set(record.processId, monitor);
  return monitor;
}

function recordToHandle(
  record: ManagedProcessRecord,
  extras?: { stdout?: string; stderr?: string; completed?: boolean },
): ProcessHandle {
  const completed = extras?.completed
    ?? ['succeeded', 'failed', 'timed_out', 'cancelled', 'orphaned', 'completed_unknown'].includes(record.status);
  return {
    processId: record.processId,
    status: record.status,
    route: record.route,
    pid: record.identity?.pid,
    startedAt: record.startedAt,
    interactiveWaitMs: record.interactiveWaitMs,
    timeoutMs: record.timeoutMs,
    completed,
    ok: completed ? record.status === 'succeeded' : undefined,
    exitCode: record.exitCode,
    timedOut: record.timedOut,
    cancelled: record.cancelled,
    stdout: extras?.stdout ?? (completed ? record.stdoutTail : undefined),
    stderr: extras?.stderr ?? (completed ? record.stderrTail : undefined),
    stdoutTail: record.stdoutTail,
    stderrTail: record.stderrTail,
    durableSideEffects: {
      executionJobCount: 0,
      localJobCount: 0,
      workerSpawnCount: 0,
      projectionUpdateCount: 0,
    },
  };
}

function spawnProcessRunner(descriptor: ProcessCommandDescriptor, descriptorPath: string): ChildProcess {
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');

  const entry = runnerEntryPath();
  const bun = Boolean(process.versions.bun);
  const useProcessGroup = process.platform !== 'win32';
  const args = bun
    ? [entry, '--descriptor', descriptorPath]
    : ['--loader', join(process.cwd(), 'src/runtime/shared/node-ts-loader.mjs'), entry, '--descriptor', descriptorPath];

  // Detached so Controller crash does not kill the runner.
  return spawn(process.execPath, args, {
    cwd: descriptor.command.cwd,
    env: {
      ...process.env,
      REPO_HARNESS_PROCESS_RUNNER: '1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: useProcessGroup,
  });
}

/**
 * Spawn once via independent Process Runner.
 * If the process finishes within interactiveWaitMs, return a completed Direct handle.
 * Otherwise return a Managed handle for the same process (no re-exec).
 */
export async function spawnManagedProcess(input: SpawnManagedProcessInput): Promise<ProcessHandle> {
  const interactiveWaitMs = Math.max(
    0,
    Math.min(input.interactiveWaitMs ?? DEFAULT_INTERACTIVE_WAIT_MS, 120_000),
  );
  const timeoutMs = Math.max(
    interactiveWaitMs + 1,
    Math.min(input.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS, 24 * 60 * 60_000),
  );
  const maxOutputBytes = Math.max(4_096, Math.min(input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 8 * 1024 * 1024));
  const processId = newProcessId();
  const fenceToken = 1;
  const startedAt = nowIso();
  const logDir = processLogDir(input.controllerHome, input.repoId);
  mkdirSync(logDir, { recursive: true });
  const stdoutPath = join(logDir, `${processId}.stdout.log`);
  const stderrPath = join(logDir, `${processId}.stderr.log`);
  const exitReceiptPath = receiptPathFor(input.controllerHome, input.repoId, processId);
  const descriptorPath = descriptorPathFor(input.controllerHome, input.repoId, processId);

  const record: ManagedProcessRecord = {
    schemaVersion: 1,
    processId,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    controllerHome: input.controllerHome,
    status: 'starting',
    route: input.returnHandleImmediately || interactiveWaitMs === 0 ? 'managed' : 'direct',
    command: input.command,
    resourceClaims: input.resourceClaims ?? [],
    interactiveWaitMs,
    timeoutMs,
    maxOutputBytes,
    startedAt,
    updatedAt: startedAt,
    terminalFenceToken: fenceToken,
    writerAuthorityEpoch: input.writerAuthorityEpoch,
    origin: input.origin,
    exitReceiptPath,
    stdoutPath,
    stderrPath,
    logPath: stdoutPath,
  };
  createProcessRecord(record);

  if (input.signal?.aborted) {
    completeProcessFromEvidence(input.controllerHome, input.repoId, processId, fenceToken, {
      status: 'cancelled',
      exitCode: 1,
      cancelled: true,
      errorMessage: 'cancelled before spawn',
      exitReceiptPath,
    });
    const cancelled = getProcessRecord(input.controllerHome, input.repoId, processId)!;
    return recordToHandle(cancelled, { completed: true, stdout: '', stderr: 'cancelled before spawn' });
  }

  // Refuse to re-exec if receipt already exists (exactly-once).
  if (existsSync(exitReceiptPath)) {
    const receipt = readExitReceipt(exitReceiptPath);
    if (receipt) {
      const completed = completeProcessFromEvidence(input.controllerHome, input.repoId, processId, fenceToken, {
        status: statusFromReceipt(receipt),
        exitCode: receipt.exitCode,
        timedOut: receipt.timedOut,
        cancelled: receipt.cancelled,
        finishedAt: receipt.finishedAt,
        exitReceiptPath,
        stdoutBytes: receipt.stdoutBytes,
        stderrBytes: receipt.stderrBytes,
        logTruncated: receipt.logTruncated,
      });
      return recordToHandle(completed!, { completed: true });
    }
  }

  const descriptor: ProcessCommandDescriptor = {
    schemaVersion: 1,
    processId,
    repoId: input.repoId,
    controllerHome: input.controllerHome,
    command: input.command,
    timeoutMs,
    maxStdoutBytes: maxOutputBytes,
    maxStderrBytes: maxOutputBytes,
    stdoutPath,
    stderrPath,
    exitReceiptPath,
    startedAt,
  };

  const runner = spawnProcessRunner(descriptor, descriptorPath);
  // Unref so controller event loop can exit independently of long-lived runners
  // only after we have identity — keep ref while monitoring.
  try {
    runner.unref?.();
  } catch {
    /* ignore */
  }

  const captured = captureIdentity(runner.pid);
  updateProcessRecord(input.controllerHome, input.repoId, processId, {
    status: 'running',
    identity: captured.identity,
    identityUntrusted: captured.identityUntrusted === true,
    exitReceiptPath,
    logPath: stdoutPath,
    stdoutPath,
    stderrPath,
  });

  const monitor = attachRunnerMonitor(
    { ...record, status: 'running', identity: captured.identity },
    runner,
    {
      timeoutMs,
      maxOutputBytes,
      signal: input.signal,
      stdoutPath,
      stderrPath,
      exitReceiptPath,
      descriptorPath,
    },
  );

  if (input.returnHandleImmediately || interactiveWaitMs === 0) {
    updateProcessRecord(input.controllerHome, input.repoId, processId, { route: 'managed' });
    const current = getProcessRecord(input.controllerHome, input.repoId, processId)!;
    return recordToHandle({ ...current, route: 'managed' }, { completed: false });
  }

  const completed = await new Promise<ManagedProcessRecord | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), interactiveWaitMs);
    timer.unref?.();
    monitor.waiters.push((done) => {
      clearTimeout(timer);
      resolve(done);
    });
    if (monitor.settled) {
      const current = getProcessRecord(input.controllerHome, input.repoId, processId);
      if (current?.terminalWritten) {
        clearTimeout(timer);
        resolve(current);
      }
    }
  });

  if (completed === 'timeout') {
    updateProcessRecord(input.controllerHome, input.repoId, processId, { route: 'managed' });
    const current = getProcessRecord(input.controllerHome, input.repoId, processId)!;
    return recordToHandle({ ...current, route: 'managed' }, { completed: false });
  }

  const stdout = monitor.stdoutTail.length
    ? capProcessOutput(redactProcessOutput(monitor.stdoutTail.toString('utf8')), maxOutputBytes)
    : completed.stdoutTail ?? '';
  const stderr = monitor.stderrTail.length
    ? capProcessOutput(redactProcessOutput(monitor.stderrTail.toString('utf8')), maxOutputBytes)
    : completed.stderrTail ?? '';
  return recordToHandle(completed, { completed: true, stdout, stderr });
}

function applyReceiptIfPresent(
  controllerHome: string,
  repoId: string,
  processId: string,
  record: ManagedProcessRecord,
): ManagedProcessRecord | undefined {
  const receipt = readExitReceipt(record.exitReceiptPath) ?? readExitReceipt(receiptPathFor(controllerHome, repoId, processId));
  if (!receipt) return undefined;
  return completeProcessFromEvidence(controllerHome, repoId, processId, record.terminalFenceToken, {
    status: statusFromReceipt(receipt),
    exitCode: receipt.exitCode,
    timedOut: receipt.timedOut,
    cancelled: receipt.cancelled,
    finishedAt: receipt.finishedAt,
    exitReceiptPath: record.exitReceiptPath ?? receiptPathFor(controllerHome, repoId, processId),
    stdoutBytes: receipt.stdoutBytes,
    stderrBytes: receipt.stderrBytes,
    stdoutStoredBytes: receipt.stdoutStoredBytes,
    stderrStoredBytes: receipt.stderrStoredBytes,
    logTruncated: receipt.logTruncated,
  });
}

export function getProcessHandle(
  controllerHome: string,
  repoId: string,
  processId: string,
): ProcessHandle | undefined {
  const record = getProcessRecord(controllerHome, repoId, processId);
  if (!record) return undefined;
  if ((record.status === 'running' || record.status === 'starting' || record.status === 'running_recovered') && !liveMonitors.has(processId)) {
    const fromReceipt = applyReceiptIfPresent(controllerHome, repoId, processId, record);
    if (fromReceipt) return recordToHandle(fromReceipt, { completed: true });
    if (!identityStillMatches(record.identity, record.identityUntrusted)) {
      const completed = completeProcessFromEvidence(controllerHome, repoId, processId, record.terminalFenceToken, {
        status: 'completed_unknown',
        errorMessage: 'process no longer matches stored identity; exit code unknown',
      });
      return completed ? recordToHandle(completed, { completed: true }) : undefined;
    }
  }
  return recordToHandle(getProcessRecord(controllerHome, repoId, processId)!);
}

export async function waitForProcess(
  controllerHome: string,
  repoId: string,
  processId: string,
  options: WaitProcessOptions = {},
): Promise<ProcessHandle> {
  const existing = getProcessRecord(controllerHome, repoId, processId);
  if (!existing) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
  if (existing.terminalWritten) return recordToHandle(existing, { completed: true });

  const monitor = liveMonitors.get(processId);
  if (monitor) {
    const waitMs = options.timeoutMs ?? existing.timeoutMs;
    const done = await new Promise<ManagedProcessRecord | 'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), Math.max(1, waitMs));
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        void cancelProcess(controllerHome, repoId, processId).then(() => {
          const current = getProcessRecord(controllerHome, repoId, processId);
          if (current) resolve(current);
          else resolve('timeout');
        });
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      monitor.waiters.push((record) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(record);
      });
      if (monitor.settled) {
        const current = getProcessRecord(controllerHome, repoId, processId);
        if (current?.terminalWritten) {
          clearTimeout(timer);
          resolve(current);
        }
      }
    });
    if (done === 'timeout') {
      return recordToHandle(getProcessRecord(controllerHome, repoId, processId)!, { completed: false });
    }
    return recordToHandle(done, { completed: true });
  }

  // No live monitor — poll receipt / identity (Controller restart attach path).
  const deadline = Date.now() + Math.max(1, options.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    const current = getProcessRecord(controllerHome, repoId, processId);
    if (!current) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
    if (current.terminalWritten) return recordToHandle(current, { completed: true });
    const fromReceipt = applyReceiptIfPresent(controllerHome, repoId, processId, current);
    if (fromReceipt) return recordToHandle(fromReceipt, { completed: true });
    if (!identityStillMatches(current.identity, current.identityUntrusted)) {
      // PID gone and no receipt → completed_unknown.
      const completed = completeProcessFromEvidence(controllerHome, repoId, processId, current.terminalFenceToken, {
        status: 'completed_unknown',
        errorMessage: 'process exited while controller was offline and no exit receipt was found',
      });
      return recordToHandle(completed!, { completed: true });
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return recordToHandle(getProcessRecord(controllerHome, repoId, processId)!, { completed: false });
}

export async function cancelProcess(
  controllerHome: string,
  repoId: string,
  processId: string,
): Promise<ProcessHandle> {
  const record = getProcessRecord(controllerHome, repoId, processId);
  if (!record) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
  if (record.terminalWritten) return recordToHandle(record, { completed: true });

  const monitor = liveMonitors.get(processId);
  if (monitor) {
    await killTree(monitor.child);
    await new Promise((r) => setTimeout(r, 100));
    const after = getProcessRecord(controllerHome, repoId, processId);
    if (after && !after.terminalWritten) {
      // Write controller-side cancel receipt if runner did not.
      const path = after.exitReceiptPath ?? receiptPathFor(controllerHome, repoId, processId);
      if (!existsSync(path)) {
        writeExitReceipt(path, {
          schemaVersion: 1,
          processId,
          exitCode: 1,
          finishedAt: nowIso(),
          cancelled: true,
        });
      }
      completeProcessFromEvidence(controllerHome, repoId, processId, after.terminalFenceToken, {
        status: 'cancelled',
        exitCode: 1,
        cancelled: true,
        exitReceiptPath: path,
      });
    }
    return recordToHandle(getProcessRecord(controllerHome, repoId, processId)!, { completed: true });
  }

  if (record.identity && !record.identityUntrusted && identityStillMatches(record.identity, false)) {
    await terminateProcessTree(record.identity.pid, {
      gracePeriodMs: 200,
      killAfterMs: 1_500,
      pollIntervalMs: 25,
    });
  } else if (record.identityUntrusted || record.identity?.processStartTime?.startsWith('untrusted:')) {
    completeProcessFromEvidence(controllerHome, repoId, processId, record.terminalFenceToken, {
      status: 'completed_unknown',
      cancelled: true,
      errorMessage: 'refusing to signal PID without verified start time',
    });
    return recordToHandle(getProcessRecord(controllerHome, repoId, processId)!, { completed: true });
  }

  const path = record.exitReceiptPath ?? receiptPathFor(controllerHome, repoId, processId);
  if (!existsSync(path)) {
    writeExitReceipt(path, {
      schemaVersion: 1,
      processId,
      exitCode: 1,
      finishedAt: nowIso(),
      cancelled: true,
    });
  }
  completeProcessFromEvidence(controllerHome, repoId, processId, record.terminalFenceToken, {
    status: 'cancelled',
    exitCode: 1,
    cancelled: true,
    exitReceiptPath: path,
  });
  return recordToHandle(getProcessRecord(controllerHome, repoId, processId)!, { completed: true });
}

export function readProcessLogs(
  controllerHome: string,
  repoId: string,
  processId: string,
  maxBytes = PROCESS_LOG_TAIL_BYTES,
): ProcessLogSlice | undefined {
  const record = getProcessRecord(controllerHome, repoId, processId);
  if (!record) return undefined;
  const stdout = readFileTailBytes(record.stdoutPath ?? '', maxBytes);
  const stderr = readFileTailBytes(record.stderrPath ?? '', maxBytes);
  return {
    processId,
    stdout: stdout.text || record.stdoutTail || '',
    stderr: stderr.text || record.stderrTail || '',
    stdoutBytes: stdout.fileBytes || record.stdoutBytes || 0,
    stderrBytes: stderr.fileBytes || record.stderrBytes || 0,
    truncated: stdout.fileBytes > maxBytes || stderr.fileBytes > maxBytes || record.logTruncated === true,
  };
}

/**
 * Re-discover running processes after Controller restart.
 * Does not re-spawn; only re-validates identity and applies runner receipts.
 */
export function recoverManagedProcesses(
  controllerHome: string,
  repoId: string,
): { recovered: string[]; orphaned: string[]; completedUnknown: string[]; completedFromReceipt: string[] } {
  const recovered: string[] = [];
  const orphaned: string[] = [];
  const completedUnknown: string[] = [];
  const completedFromReceipt: string[] = [];
  for (const processId of listActiveProcessIds(controllerHome, repoId)) {
    if (liveMonitors.has(processId)) {
      recovered.push(processId);
      continue;
    }
    const record = getProcessRecord(controllerHome, repoId, processId);
    if (!record) continue;
    if (record.terminalWritten) continue;

    const fromReceipt = applyReceiptIfPresent(controllerHome, repoId, processId, record);
    if (fromReceipt) {
      completedFromReceipt.push(processId);
      continue;
    }

    if (identityStillMatches(record.identity, record.identityUntrusted)) {
      updateProcessRecord(controllerHome, repoId, processId, {
        status: 'running_recovered',
        route: 'managed',
      }, { allowTerminal: false });
      recovered.push(processId);
      continue;
    }

    if (record.identityUntrusted || record.identity?.processStartTime?.startsWith('untrusted:') || record.identity?.processStartTime?.startsWith('fallback:')) {
      completeProcessFromEvidence(controllerHome, repoId, processId, record.terminalFenceToken, {
        status: 'completed_unknown',
        errorMessage: 'process identity was untrusted; exit code cannot be recovered after restart',
      });
      completedUnknown.push(processId);
      continue;
    }

    // PID gone, no receipt → completed_unknown.
    completeProcessFromEvidence(controllerHome, repoId, processId, record.terminalFenceToken, {
      status: 'completed_unknown',
      errorMessage: 'process no longer running and no exit receipt after controller restart',
    });
    completedUnknown.push(processId);
  }
  return { recovered, orphaned, completedUnknown, completedFromReceipt };
}

export function listLiveMonitorIds(): string[] {
  return [...liveMonitors.keys()];
}

/** Test helper: drop in-memory monitors without killing OS processes / runners. */
export function __resetLiveMonitorsForTests(): void {
  for (const monitor of liveMonitors.values()) {
    if (monitor.timeoutHandle) clearTimeout(monitor.timeoutHandle);
  }
  liveMonitors.clear();
}

/** Test helper: simulate controller crash by dropping monitors while runners keep running. */
export function __detachMonitorsKeepRunnersForTests(): string[] {
  const ids = [...liveMonitors.keys()];
  for (const monitor of liveMonitors.values()) {
    if (monitor.timeoutHandle) clearTimeout(monitor.timeoutHandle);
    // Detach close listeners so this controller process no longer finalizes.
    try {
      monitor.child.removeAllListeners('close');
      monitor.child.removeAllListeners('error');
      monitor.child.unref?.();
    } catch {
      /* ignore */
    }
  }
  liveMonitors.clear();
  return ids;
}

// silence unused helpers retained for local tail buffering paths
void openSync;
void appendTail;
type _RunnerReceipt = ProcessRunnerExitReceipt;
