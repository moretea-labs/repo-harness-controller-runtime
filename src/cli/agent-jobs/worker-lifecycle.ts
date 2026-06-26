import type { ChildProcess } from "child_process";
import {
  closeSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import type { AgentJobMeta, AgentJobStatus } from "./types";

export interface WorkerLeaseRecord {
  schemaVersion: 1;
  pid: number;
  runId: string;
  startedAt: string;
}

export interface WorkerLeaseResult {
  acquired: boolean;
  ownerPid?: number;
  recoveredStale: boolean;
}

export interface ChildExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  forced: boolean;
  spawnError?: Error;
}

export interface ChildExitOptions {
  timeoutMs: number;
  drainGraceMs?: number;
  forceKillGraceMs?: number;
  terminate: (signal: NodeJS.Signals) => void;
  onTimeout?: () => void;
}

const ACTIVE_WORKER_STATUSES = new Set<AgentJobStatus>([
  "queued",
  "starting",
  "running",
]);

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

export function readWorkerLease(path: string): WorkerLeaseRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as Partial<WorkerLeaseRecord>;
    if (
      value.schemaVersion !== 1 ||
      !Number.isInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.runId !== "string" ||
      !value.runId ||
      typeof value.startedAt !== "string"
    ) {
      return undefined;
    }
    return value as WorkerLeaseRecord;
  } catch (_error) {
    return undefined;
  }
}

export function acquireWorkerLease(
  path: string,
  record: WorkerLeaseRecord,
  isAlive: (pid: number) => boolean = processIsAlive,
): WorkerLeaseResult {
  let recoveredStale = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
      } finally {
        closeSync(descriptor);
      }
      return { acquired: true, ownerPid: record.pid, recoveredStale };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readWorkerLease(path);
      if (existing?.pid === record.pid && existing.runId === record.runId) {
        return { acquired: true, ownerPid: record.pid, recoveredStale };
      }
      if (existing?.pid && isAlive(existing.pid)) {
        return {
          acquired: false,
          ownerPid: existing.pid,
          recoveredStale,
        };
      }
      rmSync(path, { force: true });
      recoveredStale = true;
    }
  }
  return { acquired: false, recoveredStale };
}

export function releaseWorkerLease(path: string, pid: number, runId: string): boolean {
  const existing = readWorkerLease(path);
  if (!existing || existing.pid !== pid || existing.runId !== runId) return false;
  rmSync(path, { force: true });
  return true;
}

export function workerLeaseOwnedBy(path: string, pid: number, runId: string): boolean {
  const existing = readWorkerLease(path);
  return existing?.pid === pid && existing.runId === runId;
}

export function workerRunStopReason(
  meta: Pick<AgentJobMeta, "status" | "deadlineAt">,
  now = Date.now(),
): string | undefined {
  if (!ACTIVE_WORKER_STATUSES.has(meta.status)) {
    return `Run entered terminal state ${meta.status}`;
  }
  const deadline = Date.parse(meta.deadlineAt ?? "");
  if (Number.isFinite(deadline) && now > deadline) {
    return `Run deadline ${meta.deadlineAt} has elapsed`;
  }
  return undefined;
}

export function waitForChildExit(
  child: ChildProcess,
  options: ChildExitOptions,
): Promise<ChildExitResult> {
  const drainGraceMs = Math.max(0, options.drainGraceMs ?? 250);
  const forceKillGraceMs = Math.max(0, options.forceKillGraceMs ?? 5_000);

  return new Promise<ChildExitResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let forced = false;
    let spawnError: Error | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (drainTimer) clearTimeout(drainTimer);
      if (forceTimer) clearTimeout(forceTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
    };

    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, signal, timedOut, forced, spawnError });
    };

    const onError = (error: Error): void => {
      spawnError = error;
      finish(null, null);
    };
    const onClose = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => finish(code, signal);
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled || drainTimer) return;
      drainTimer = setTimeout(() => finish(code, signal), drainGraceMs);
    };

    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);

    timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      options.onTimeout?.();
      options.terminate("SIGTERM");
      forceTimer = setTimeout(() => {
        if (settled) return;
        forced = true;
        options.terminate("SIGKILL");
        finish(null, "SIGKILL");
      }, forceKillGraceMs);
    }, Math.max(1, options.timeoutMs));
  });
}
