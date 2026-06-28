import { execFileSync } from 'child_process';

export interface TerminateProcessTreeOptions {
  gracePeriodMs?: number;
  killAfterMs?: number;
  pollIntervalMs?: number;
}

export interface ProcessTreeTerminationResult {
  pid?: number;
  signaled: boolean;
  escalated: boolean;
  exited: boolean;
  remainingPids: number[];
}

const DEFAULT_GRACE_PERIOD_MS = 1_500;
const DEFAULT_KILL_AFTER_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isProcessStatAlive(stat: string | undefined): boolean {
  const normalized = stat?.trim().toUpperCase();
  return Boolean(normalized && !normalized.startsWith('Z'));
}

function readProcessStatPosix(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 8 * 1024,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  return isProcessStatAlive(readProcessStatPosix(pid));
}

function listProcessGroupMembersPosix(processGroupId: number): number[] {
  try {
    const output = execFileSync('ps', ['-o', 'pid=', '-o', 'stat=', '-g', String(processGroupId)], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 256 * 1024,
    });
    return output
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(\S+)/.exec(line))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .filter((match) => isProcessStatAlive(match[2]))
      .map((match) => Number.parseInt(match[1], 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

export function listProcessTreeMembers(pid: number | undefined): number[] {
  if (!pid || pid <= 0) return [];
  if (process.platform === 'win32') return isProcessAlive(pid) ? [pid] : [];
  const members = listProcessGroupMembersPosix(pid);
  if (members.length > 0) return members;
  return isProcessAlive(pid) ? [pid] : [];
}

export function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pid || pid <= 0 || pid === process.pid) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Fall back to the direct PID when the process group is already gone.
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function terminateProcessTree(
  pid: number | undefined,
  options: TerminateProcessTreeOptions = {},
): Promise<ProcessTreeTerminationResult> {
  const state = startTermination(pid, options);
  if (!state) {
    return {
      pid,
      signaled: false,
      escalated: false,
      exited: true,
      remainingPids: [],
    };
  }
  while (true) {
    const result = pollTermination(state);
    if (result) return result;
    await sleep(state.pollIntervalMs);
  }
}

export function terminateProcessTreeSync(
  pid: number | undefined,
  options: TerminateProcessTreeOptions = {},
): ProcessTreeTerminationResult {
  const state = startTermination(pid, options);
  if (!state) {
    return {
      pid,
      signaled: false,
      escalated: false,
      exited: true,
      remainingPids: [],
    };
  }
  while (true) {
    const result = pollTermination(state);
    if (result) return result;
    sleepSync(state.pollIntervalMs);
  }
}

function startTermination(
  pid: number | undefined,
  options: TerminateProcessTreeOptions,
): {
  pid: number;
  signaled: boolean;
  escalated: boolean;
  escalateAt: number;
  deadline: number;
  pollIntervalMs: number;
} | undefined {
  if (!pid || pid <= 0 || pid === process.pid) return undefined;
  const gracePeriodMs = Math.max(0, options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS);
  const killAfterMs = Math.max(gracePeriodMs, options.killAfterMs ?? DEFAULT_KILL_AFTER_MS);
  const startedAt = Date.now();
  return {
    pid,
    signaled: signalProcessTree(pid, 'SIGTERM'),
    escalated: false,
    escalateAt: startedAt + gracePeriodMs,
    deadline: startedAt + killAfterMs,
    pollIntervalMs: Math.max(10, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
  };
}

function pollTermination(state: {
  pid: number;
  signaled: boolean;
  escalated: boolean;
  escalateAt: number;
  deadline: number;
  pollIntervalMs: number;
}): ProcessTreeTerminationResult | undefined {
  const remainingPids = listProcessTreeMembers(state.pid);
  if (remainingPids.length === 0) {
    return {
      pid: state.pid,
      signaled: state.signaled,
      escalated: state.escalated,
      exited: true,
      remainingPids: [],
    };
  }
  const now = Date.now();
  if (!state.escalated && now >= state.escalateAt) {
    signalProcessTree(state.pid, 'SIGKILL');
    state.escalated = true;
  }
  if (now >= state.deadline) {
    return {
      pid: state.pid,
      signaled: state.signaled,
      escalated: state.escalated,
      exited: false,
      remainingPids,
    };
  }
  return undefined;
}
