import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { AgentJobMeta } from "./types";

const CONTROLLER_EPOCH_PATH = ".ai/harness/controller/runtime-owner.json";

export interface ControllerEpochRecord {
  schemaVersion: 1;
  pid: number;
  epoch: string;
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

export function ensureControllerEpoch(repoRoot: string): ControllerEpochRecord & { path: string } {
  const path = controllerEpochPath(repoRoot);
  const now = new Date().toISOString();
  if (existsSync(path)) {
    try {
      const current = readJson<ControllerEpochRecord>(path);
      if (current.pid === process.pid && current.epoch) {
        const next: ControllerEpochRecord = { ...current, updatedAt: now };
        writeJsonAtomic(path, next);
        return { ...next, path };
      }
    } catch (_error) {
      // Fall through and replace malformed state.
    }
  }
  const record: ControllerEpochRecord = {
    schemaVersion: 1,
    pid: process.pid,
    epoch: randomEpoch(),
    startedAt: now,
    updatedAt: now,
  };
  writeJsonAtomic(path, record);
  return { ...record, path };
}

export function readControllerEpoch(path: string | undefined): ControllerEpochRecord | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return readJson<ControllerEpochRecord>(path);
  } catch (_error) {
    return undefined;
  }
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
