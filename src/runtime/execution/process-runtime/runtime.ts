/**
 * Unified Process Runtime.
 *
 * One spawn path serves Direct (wait briefly then return result) and Managed
 * (return handle when still running). Commands are never re-executed after spawn.
 * Controller restart re-attaches via PID + processStartTime identity.
 */

import { createHash, randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
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

interface LiveMonitor {
  processId: string;
  repoId: string;
  controllerHome: string;
  child: ChildProcess;
  fenceToken: number;
  stdoutBytes: number;
  stderrBytes: number;
  /** Bounded in-memory ring for waiters — not every chunk concatenates full history. */
  stdoutTail: Buffer;
  stderrTail: Buffer;
  maxTailBytes: number;
  logTruncated: boolean;
  settled: boolean;
  timeoutHandle?: NodeJS.Timeout;
  waiters: Array<(record: ManagedProcessRecord) => void>;
  stdoutPath: string;
  stderrPath: string;
  stdoutFd?: number;
  stderrFd?: number;
  exitReceiptPath: string;
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
  return redactProcessOutput(buffer.subarray(buffer.length - maxBytes).toString('utf8'));
}

function appendTail(current: Buffer, chunk: Buffer, maxBytes: number): Buffer {
  if (chunk.length >= maxBytes) return Buffer.from(chunk.subarray(chunk.length - maxBytes));
  const nextLen = current.length + chunk.length;
  if (nextLen <= maxBytes) return Buffer.concat([current, chunk]);
  const keep = maxBytes - chunk.length;
  return Buffer.concat([current.subarray(current.length - keep), chunk]);
}

function appendLogFd(fd: number | undefined, path: string, chunk: Buffer): void {
  try {
    if (fd !== undefined) {
      writeFileSync(fd, chunk);
      return;
    }
    appendFileSync(path, chunk);
  } catch {
    /* best-effort log append */
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
    // No start-time: store untrusted pid identity — NEVER use for kill/signals.
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
    // Untrusted identity: never claim a match strong enough for kill.
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
  timedOut?: boolean;
  cancelled?: boolean;
}

function receiptPathFor(controllerHome: string, repoId: string, processId: string): string {
  return join(processLogDir(controllerHome, repoId), `${processId}.exit.json`);
}

function writeExitReceipt(path: string, receipt: ProcessExitReceipt): void {
  try {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    // atomic rename
    const { renameSync } = require('fs') as typeof import('fs');
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

  // Passive / fenced runtimes must not write process terminal state.
  // Use captured process claim — never treat current authority as "mine".
  try {
    const { assertThisRuntimeMayWrite } = require('../../../cli/controller/stable-state/runtime-writer-context') as typeof import('../../../cli/controller/stable-state/runtime-writer-context');
    const fence = assertThisRuntimeMayWrite('write_process_terminal', monitor.controllerHome);
    if (!fence.allowed) {
      // Still persist exit receipt so active writer can complete later.
      liveMonitors.delete(monitor.processId);
      return getProcessRecord(monitor.controllerHome, monitor.repoId, monitor.processId);
    }
  } catch {
    /* writer authority is optional on legacy single-runtime homes */
  }

  // Always write exit receipt first so controller restart can recover true terminal state.
  writeExitReceipt(monitor.exitReceiptPath, {
    schemaVersion: 1,
    processId: monitor.processId,
    exitCode,
    finishedAt: nowIso(),
    timedOut,
    cancelled,
  });

  const stdoutBuf = monitor.stdoutTail;
  const stderrBuf = monitor.stderrTail;
  const stdout = capProcessOutput(redactProcessOutput(stdoutBuf.toString('utf8')), DEFAULT_MAX_OUTPUT_BYTES);
  const stderrParts = [
    redactProcessOutput(stderrBuf.toString('utf8')),
    timedOut ? `process timed out` : '',
    cancelled ? 'process cancelled' : '',
    errorMessage ? redactProcessOutput(errorMessage) : '',
  ].filter(Boolean);
  const stderr = capProcessOutput(stderrParts.join('\n'), DEFAULT_MAX_OUTPUT_BYTES);

  try {
    if (monitor.stdoutFd !== undefined) closeSync(monitor.stdoutFd);
    if (monitor.stderrFd !== undefined) closeSync(monitor.stderrFd);
  } catch { /* ignore */ }

  const completion = tryCompleteProcessRecord(
    monitor.controllerHome,
    monitor.repoId,
    monitor.processId,
    monitor.fenceToken,
    {
      status,
      exitCode,
      timedOut,
      cancelled,
      stdoutTail: tailText(stdoutBuf, PROCESS_LOG_TAIL_BYTES),
      stderrTail: tailText(Buffer.from(stderr, 'utf8'), PROCESS_LOG_TAIL_BYTES),
      stdoutBytes: monitor.stdoutBytes,
      stderrBytes: monitor.stderrBytes,
      finishedAt: nowIso(),
      exitReceiptPath: monitor.exitReceiptPath,
      logTruncated: monitor.logTruncated,
      ...(errorMessage ? { error: { code: status.toUpperCase(), message: errorMessage } } : {}),
    },
  );

  const record = completion.record
    ?? getProcessRecord(monitor.controllerHome, monitor.repoId, monitor.processId);

  // Attach full output on the in-memory handle path via waiters.
  if (record) {
    const enriched: ManagedProcessRecord = {
      ...record,
      stdoutTail: stdout.slice(-PROCESS_LOG_TAIL_BYTES),
      stderrTail: stderr.slice(-PROCESS_LOG_TAIL_BYTES),
    };
    for (const waiter of monitor.waiters.splice(0)) waiter(enriched);
  }
  liveMonitors.delete(monitor.processId);
  return record;
}

function attachMonitor(
  record: ManagedProcessRecord,
  child: ChildProcess,
  options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
): LiveMonitor {
  const logDir = processLogDir(record.controllerHome, record.repoId);
  mkdirSync(logDir, { recursive: true });
  const stdoutPath = join(logDir, `${record.processId}.stdout.log`);
  const stderrPath = join(logDir, `${record.processId}.stderr.log`);
  writeFileSync(stdoutPath, '');
  writeFileSync(stderrPath, '');

  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  try { stdoutFd = openSync(stdoutPath, 'a'); } catch { stdoutFd = undefined; }
  try { stderrFd = openSync(stderrPath, 'a'); } catch { stderrFd = undefined; }
  const exitReceiptPath = receiptPathFor(record.controllerHome, record.repoId, record.processId);

  const monitor: LiveMonitor = {
    processId: record.processId,
    repoId: record.repoId,
    controllerHome: record.controllerHome,
    child,
    fenceToken: record.terminalFenceToken,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTail: Buffer.alloc(0),
    stderrTail: Buffer.alloc(0),
    maxTailBytes: Math.min(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
    logTruncated: false,
    settled: false,
    waiters: [],
    stdoutPath,
    stderrPath,
    stdoutFd,
    stderrFd,
    exitReceiptPath,
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    monitor.stdoutBytes += chunk.length;
    if (monitor.stdoutBytes > options.maxOutputBytes) monitor.logTruncated = true;
    monitor.stdoutTail = appendTail(monitor.stdoutTail, chunk, monitor.maxTailBytes);
    appendLogFd(monitor.stdoutFd, stdoutPath, chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    monitor.stderrBytes += chunk.length;
    if (monitor.stderrBytes > options.maxOutputBytes) monitor.logTruncated = true;
    monitor.stderrTail = appendTail(monitor.stderrTail, chunk, monitor.maxTailBytes);
    appendLogFd(monitor.stderrFd, stderrPath, chunk);
  });

  const onAbort = () => {
    void killTree(child).finally(() => {
      finalizeMonitor(monitor, 'cancelled', 1, false, true, 'cancelled by signal');
    });
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  monitor.timeoutHandle = setTimeout(() => {
    void killTree(child).finally(() => {
      finalizeMonitor(monitor, 'timed_out', 1, true, false, `process timed out after ${options.timeoutMs}ms`);
    });
  }, Math.max(1, options.timeoutMs));
  monitor.timeoutHandle.unref?.();

  child.on('error', (error) => {
    finalizeMonitor(monitor, 'failed', 1, false, false, error.message);
    options.signal?.removeEventListener('abort', onAbort);
  });
  child.on('close', (code) => {
    options.signal?.removeEventListener('abort', onAbort);
    const exitCode = code ?? 1;
    const status = exitCode === 0 ? 'succeeded' : 'failed';
    finalizeMonitor(monitor, status, exitCode, false, false);
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

function spawnChild(command: ManagedProcessRecord['command']): ChildProcess {
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

/**
 * Spawn once. If the process finishes within interactiveWaitMs, return a completed
 * Direct handle. Otherwise return a Managed handle for the same process (no re-exec).
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
  };
  createProcessRecord(record);

  if (input.signal?.aborted) {
    tryCompleteProcessRecord(input.controllerHome, input.repoId, processId, fenceToken, {
      status: 'cancelled',
      exitCode: 1,
      cancelled: true,
      error: { code: 'CANCELLED', message: 'cancelled before spawn' },
    });
    const cancelled = getProcessRecord(input.controllerHome, input.repoId, processId)!;
    return recordToHandle(cancelled, { completed: true, stdout: '', stderr: 'cancelled before spawn' });
  }

  const child = spawnChild(input.command);
  const captured = captureIdentity(child.pid);
  const identity = captured.identity;
  updateProcessRecord(input.controllerHome, input.repoId, processId, {
    status: 'running',
    identity,
    identityUntrusted: captured.identityUntrusted === true,
    exitReceiptPath: join(processLogDir(input.controllerHome, input.repoId), `${processId}.exit.json`),
    logPath: join(processLogDir(input.controllerHome, input.repoId), `${processId}.stdout.log`),
    stdoutPath: join(processLogDir(input.controllerHome, input.repoId), `${processId}.stdout.log`),
    stderrPath: join(processLogDir(input.controllerHome, input.repoId), `${processId}.stderr.log`),
  });

  const monitor = attachMonitor(
    { ...record, status: 'running', identity },
    child,
    { timeoutMs, maxOutputBytes, signal: input.signal },
  );

  if (input.returnHandleImmediately || interactiveWaitMs === 0) {
    updateProcessRecord(input.controllerHome, input.repoId, processId, { route: 'managed' });
    const current = getProcessRecord(input.controllerHome, input.repoId, processId)!;
    return recordToHandle({ ...current, route: 'managed' }, { completed: false });
  }

  // Interactive wait: race completion vs wait window.
  const completed = await new Promise<ManagedProcessRecord | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), interactiveWaitMs);
    timer.unref?.();
    monitor.waiters.push((done) => {
      clearTimeout(timer);
      resolve(done);
    });
    // If already settled between spawn and waiter registration:
    if (monitor.settled) {
      const current = getProcessRecord(input.controllerHome, input.repoId, processId);
      if (current?.terminalWritten) {
        clearTimeout(timer);
        resolve(current);
      }
    }
  });

  if (completed === 'timeout') {
    // Same process continues under managed route — do not re-spawn.
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

export function getProcessHandle(
  controllerHome: string,
  repoId: string,
  processId: string,
): ProcessHandle | undefined {
  const record = getProcessRecord(controllerHome, repoId, processId);
  if (!record) return undefined;
  // Refresh status from OS if still marked running.
  if ((record.status === 'running' || record.status === 'starting' || record.status === 'running_recovered') && !liveMonitors.has(processId)) {
    const receipt = readExitReceipt(record.exitReceiptPath) ?? readExitReceipt(receiptPathFor(controllerHome, repoId, processId));
    if (receipt) {
      const code = receipt.exitCode ?? 1;
      const status: ManagedProcessRecord['status'] = receipt.cancelled ? 'cancelled' : receipt.timedOut ? 'timed_out' : code === 0 ? 'succeeded' : 'failed';
      tryCompleteProcessRecord(controllerHome, repoId, processId, record.terminalFenceToken, {
        status, exitCode: code, timedOut: receipt.timedOut, cancelled: receipt.cancelled, finishedAt: receipt.finishedAt,
      });
      const updated = getProcessRecord(controllerHome, repoId, processId);
      return updated ? recordToHandle(updated, { completed: true }) : undefined;
    }
    if (!identityStillMatches(record.identity, record.identityUntrusted)) {
      tryCompleteProcessRecord(controllerHome, repoId, processId, record.terminalFenceToken, {
        status: 'completed_unknown',
        error: { code: 'OUTCOME_UNKNOWN', message: 'process no longer matches stored identity; exit code unknown' },
      });
      const updated = getProcessRecord(controllerHome, repoId, processId);
      return updated ? recordToHandle(updated, { completed: true }) : undefined;
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

  // No live monitor — poll identity until dead or wait expires.
  const deadline = Date.now() + Math.max(1, options.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    const current = getProcessRecord(controllerHome, repoId, processId);
    if (!current) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
    if (current.terminalWritten) return recordToHandle(current, { completed: true });
    const receipt = readExitReceipt(current.exitReceiptPath) ?? readExitReceipt(receiptPathFor(controllerHome, repoId, processId));
    if (receipt) {
      const code = receipt.exitCode ?? 1;
      const status: ManagedProcessRecord['status'] = receipt.cancelled ? 'cancelled' : receipt.timedOut ? 'timed_out' : code === 0 ? 'succeeded' : 'failed';
      tryCompleteProcessRecord(controllerHome, repoId, processId, current.terminalFenceToken, {
        status, exitCode: code, timedOut: receipt.timedOut, cancelled: receipt.cancelled, finishedAt: receipt.finishedAt,
      });
      return recordToHandle(getProcessRecord(controllerHome, repoId, processId)!, { completed: true });
    }
    if (!identityStillMatches(current.identity, current.identityUntrusted)) {
      tryCompleteProcessRecord(controllerHome, repoId, processId, current.terminalFenceToken, {
        status: 'completed_unknown',
        error: { code: 'OUTCOME_UNKNOWN', message: 'process exited while controller was offline; exit code unknown' },
      });
      return recordToHandle(getProcessRecord(controllerHome, repoId, processId)!, { completed: true });
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
    // close handler finalizes; wait briefly
    await new Promise((r) => setTimeout(r, 50));
    const after = getProcessRecord(controllerHome, repoId, processId);
    if (after && !after.terminalWritten) {
      tryCompleteProcessRecord(controllerHome, repoId, processId, after.terminalFenceToken, {
        status: 'cancelled',
        exitCode: 1,
        cancelled: true,
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
    // Refuse to signal untrusted PIDs (PID reuse risk).
    tryCompleteProcessRecord(controllerHome, repoId, processId, record.terminalFenceToken, {
      status: 'completed_unknown',
      cancelled: true,
      error: { code: 'CANCEL_REFUSED_UNTRUSTED_IDENTITY', message: 'refusing to signal PID without verified start time' },
    });
    return recordToHandle(getProcessRecord(controllerHome, repoId, processId)!, { completed: true });
  }
  tryCompleteProcessRecord(controllerHome, repoId, processId, record.terminalFenceToken, {
    status: 'cancelled',
    exitCode: 1,
    cancelled: true,
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
  const readTail = (path: string | undefined): { text: string; bytes: number } => {
    if (!path || !existsSync(path)) return { text: '', bytes: 0 };
    const buf = readFileSync(path);
    if (buf.length <= maxBytes) return { text: redactProcessOutput(buf.toString('utf8')), bytes: buf.length };
    return {
      text: redactProcessOutput(buf.subarray(buf.length - maxBytes).toString('utf8')),
      bytes: buf.length,
    };
  };
  const stdout = readTail(record.stdoutPath);
  const stderr = readTail(record.stderrPath);
  return {
    processId,
    stdout: stdout.text || record.stdoutTail || '',
    stderr: stderr.text || record.stderrTail || '',
    stdoutBytes: stdout.bytes || record.stdoutBytes || 0,
    stderrBytes: stderr.bytes || record.stderrBytes || 0,
    truncated: stdout.bytes > maxBytes || stderr.bytes > maxBytes,
  };
}

/**
 * Re-discover running processes after Controller restart.
 * Does not re-spawn; only re-validates identity and marks orphans.
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

    // Prefer exit receipt written by the original monitor/wrapper.
    const receipt = readExitReceipt(record.exitReceiptPath)
      ?? readExitReceipt(receiptPathFor(controllerHome, repoId, processId));
    if (receipt) {
      const code = receipt.exitCode ?? 1;
      const status: ManagedProcessRecord['status'] = receipt.cancelled
        ? 'cancelled'
        : receipt.timedOut
          ? 'timed_out'
          : code === 0
            ? 'succeeded'
            : 'failed';
      tryCompleteProcessRecord(controllerHome, repoId, processId, record.terminalFenceToken, {
        status,
        exitCode: code,
        timedOut: receipt.timedOut,
        cancelled: receipt.cancelled,
        finishedAt: receipt.finishedAt,
        exitReceiptPath: record.exitReceiptPath ?? receiptPathFor(controllerHome, repoId, processId),
      });
      completedFromReceipt.push(processId);
      continue;
    }

    if (identityStillMatches(record.identity, record.identityUntrusted)) {
      // Process still alive but we lost the ChildProcess handle.
      updateProcessRecord(controllerHome, repoId, processId, {
        status: 'running_recovered',
        route: 'managed',
      }, { allowTerminal: false });
      recovered.push(processId);
      continue;
    }

    // Dead or untrusted identity and no receipt → outcome unknown (not orphaned success/fail).
    if (record.identityUntrusted || record.identity?.processStartTime?.startsWith('untrusted:') || record.identity?.processStartTime?.startsWith('fallback:')) {
      tryCompleteProcessRecord(controllerHome, repoId, processId, record.terminalFenceToken, {
        status: 'completed_unknown',
        exitCode: undefined,
        error: {
          code: 'OUTCOME_UNKNOWN',
          message: 'process identity was untrusted; exit code cannot be recovered after restart',
        },
      });
      completedUnknown.push(processId);
      continue;
    }

    // PID gone, no receipt: completed_unknown (not fake failed/orphaned).
    tryCompleteProcessRecord(controllerHome, repoId, processId, record.terminalFenceToken, {
      status: 'completed_unknown',
      exitCode: undefined,
      error: {
        code: 'OUTCOME_UNKNOWN',
        message: 'process no longer running and no exit receipt after controller restart',
      },
    });
    completedUnknown.push(processId);
  }
  return { recovered, orphaned, completedUnknown, completedFromReceipt };
}

export function listLiveMonitorIds(): string[] {
  return [...liveMonitors.keys()];
}

/** Test helper: drop in-memory monitors without killing OS processes. */
export function __resetLiveMonitorsForTests(): void {
  for (const monitor of liveMonitors.values()) {
    if (monitor.timeoutHandle) clearTimeout(monitor.timeoutHandle);
  }
  liveMonitors.clear();
}

// silence unused openSync import edge (reserved for future append fd pooling)
void openSync;
void closeSync;
