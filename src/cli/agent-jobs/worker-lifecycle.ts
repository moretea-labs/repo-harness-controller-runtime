import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import type { AgentJobMeta } from "./types";

const CONTROLLER_EPOCH_PATH = ".ai/harness/controller/runtime-owner.json";
const CONTROLLER_EPOCH_LOCK_SUFFIX = ".lock";
const CONTROLLER_EPOCH_LOCK_TIMEOUT_MS = 5_000;
const CONTROLLER_EPOCH_STALE_LOCK_MS = 30_000;

export interface ControllerEpochRecord {
  schemaVersion: 1 | 2;
  pid: number;
  epoch: string;
  revision?: number;
  startedAt: string;
  updatedAt: string;
}

export interface AgentWorkerOwnershipConfig {
  controllerPid?: number;
  controllerEpoch?: string;
  controllerEpochPath?: string;
  parentPid?: number;
}

export interface AgentWorkerInvalidation {
  code:
    | "PARENT_DISCONNECTED"
    | "CONTROLLER_UNAVAILABLE"
    | "CONTROLLER_EPOCH_STALE"
    | "RUN_NOT_ACTIVE"
    | "WORKER_REPLACED";
  message: string;
}

const FINALIZATION_HANDOFF_INVALIDATIONS = new Set<AgentWorkerInvalidation["code"]>([
  "PARENT_DISCONNECTED",
  "CONTROLLER_UNAVAILABLE",
  "CONTROLLER_EPOCH_STALE",
]);

/**
 * The live Worker remains the only completion writer after its agent child
 * exits. A launcher or Controller restart may invalidate the old ancestry or
 * epoch, but the replacement Controller deliberately leaves this exact live
 * finalizer alone. Never tolerate a replaced Worker or a non-active Run.
 */
export function shouldTolerateOwnedFinalizationInvalidation(
  meta: AgentJobMeta,
  invalidation: AgentWorkerInvalidation | undefined,
  options: { workerPid: number; childExited: boolean },
): boolean {
  return options.childExited
    && meta.status === "running"
    && meta.autoIntegrate === true
    && meta.executionMode === "worktree"
    && meta.progress?.phase === "finalizing"
    && meta.workerPid === options.workerPid
    && Boolean(invalidation && FINALIZATION_HANDOFF_INVALIDATIONS.has(invalidation.code));
}

export function matchesAgentWorkerCommand(command: string, expectedConfigPath: string): boolean {
  const escapedConfig = expectedConfigPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|\\s)["']?(?!-)[^\\s"']*job-worker\\.(?:ts|js)["']?\\s+["']?${escapedConfig}["']?(?:\\s|$)`,
  ).test(command);
}

function randomEpoch(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withEpochLock<T>(path: string, action: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}${CONTROLLER_EPOCH_LOCK_SUFFIX}`;
  const deadline = Date.now() + CONTROLLER_EPOCH_LOCK_TIMEOUT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > CONTROLLER_EPOCH_STALE_LOCK_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch (_readError) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`CONTROLLER_EPOCH_LOCK_TIMEOUT: ${lockPath}`);
      sleepSync(10);
    }
  }
  try {
    return action();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

function validEpochRecord(value: unknown): value is ControllerEpochRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ControllerEpochRecord>;
  return (record.schemaVersion === 1 || record.schemaVersion === 2)
    && Number.isInteger(record.pid)
    && Number(record.pid) > 0
    && typeof record.epoch === "string"
    && record.epoch.length > 0
    && typeof record.startedAt === "string"
    && typeof record.updatedAt === "string";
}

export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

export function controllerEpochPath(repoRoot: string): string {
  return join(repoRoot, CONTROLLER_EPOCH_PATH);
}

/**
 * Acquire or renew the repository controller owner without rotating the epoch
 * for ordinary sibling work. A live owner remains authoritative; only a real
 * takeover from a dead/malformed owner increments the fencing revision.
 */
export function ensureControllerEpoch(
  repoRoot: string,
  ownerPid = process.pid,
): ControllerEpochRecord & { path: string } {
  const path = controllerEpochPath(repoRoot);
  return withEpochLock(path, () => {
    const timestamp = new Date().toISOString();
    let current: ControllerEpochRecord | undefined;
    if (existsSync(path)) {
      try {
        const candidate = readJson<unknown>(path);
        if (validEpochRecord(candidate)) current = candidate;
      } catch (_error) {
        current = undefined;
      }
    }

    if (current && isPidAlive(current.pid)) {
      if (current.pid !== ownerPid) {
        // Parallel MCP/Controller requests are children of the same repository
        // controller lease. Reuse the live fencing token instead of stealing it.
        return { ...current, path };
      }
      const renewed: ControllerEpochRecord = {
        ...current,
        schemaVersion: 2,
        revision: Math.max(1, current.revision ?? 1),
        updatedAt: timestamp,
      };
      writeJsonAtomic(path, renewed);
      return { ...renewed, path };
    }

    const record: ControllerEpochRecord = {
      schemaVersion: 2,
      pid: ownerPid,
      epoch: randomEpoch(),
      revision: Math.max(1, (current?.revision ?? 0) + 1),
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    writeJsonAtomic(path, record);
    return { ...record, path };
  });
}

export function readControllerEpoch(path: string | undefined): ControllerEpochRecord | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const value = readJson<unknown>(path);
    return validEpochRecord(value) ? value : undefined;
  } catch (_error) {
    return undefined;
  }
}

export function hasControllerOwnershipMetadata(
  ownership: AgentWorkerOwnershipConfig,
): boolean {
  return Boolean(
    ownership.controllerPid &&
      ownership.controllerEpoch &&
      ownership.controllerEpochPath,
  );
}

export function invalidateAgentWorker(
  meta: AgentJobMeta,
  ownership: AgentWorkerOwnershipConfig,
  options: {
    currentParentPid?: number;
    workerPid?: number;
  } = {},
): AgentWorkerInvalidation | undefined {
  const currentParentPid = options.currentParentPid ?? process.ppid;
  const workerPid = options.workerPid ?? process.pid;
  if (
    ownership.parentPid !== undefined &&
    ownership.parentPid > 0 &&
    currentParentPid !== ownership.parentPid
  ) {
    return {
      code: "PARENT_DISCONNECTED",
      message:
        currentParentPid === 1
          ? `worker parent ${ownership.parentPid} disconnected and PPID became 1`
          : `worker parent changed from ${ownership.parentPid} to ${currentParentPid}`,
    };
  }
  if (ownership.controllerPid && !isPidAlive(ownership.controllerPid)) {
    return {
      code: "CONTROLLER_UNAVAILABLE",
      message: `Controller process ${ownership.controllerPid} is no longer running`,
    };
  }
  if (ownership.controllerEpochPath && ownership.controllerEpoch) {
    const epoch = readControllerEpoch(ownership.controllerEpochPath);
    if (!epoch) {
      return {
        code: "CONTROLLER_EPOCH_STALE",
        message: "Controller ownership epoch is missing",
      };
    }
    if (epoch.epoch !== ownership.controllerEpoch || epoch.pid !== ownership.controllerPid) {
      return {
        code: "CONTROLLER_EPOCH_STALE",
        message: `Controller ownership epoch changed from ${ownership.controllerEpoch} to ${epoch.epoch}`,
      };
    }
  }
  if (!["starting", "running"].includes(meta.status)) {
    return {
      code: "RUN_NOT_ACTIVE",
      message: `Run ${meta.runId} is no longer active (${meta.status})`,
    };
  }
  if (meta.workerPid !== undefined && meta.workerPid !== workerPid) {
    return {
      code: "WORKER_REPLACED",
      message: `Run ${meta.runId} belongs to worker PID ${meta.workerPid}`,
    };
  }
  return undefined;
}
