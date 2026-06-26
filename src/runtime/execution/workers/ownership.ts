import { readControllerDaemonStatus } from "../../control-plane/daemon-client";
import { getExecutionJob } from "../jobs/store";
import { assertFencingToken } from "../../resources/leases/store";
import type { ExecutionJob } from "../jobs/types";

export interface ExecutionWorkerInvalidation {
  code:
    | "PARENT_DISCONNECTED"
    | "CONTROLLER_UNAVAILABLE"
    | "CONTROLLER_EPOCH_STALE"
    | "JOB_NOT_RUNNING"
    | "WORKER_REPLACED"
    | "ATTEMPT_REPLACED"
    | "LEASE_INVALID";
  message: string;
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function invalidateExecutionWorker(
  controllerHome: string,
  repoId: string,
  jobId: string,
  options: {
    workerPid: number;
    attempt?: number;
    controllerPid?: number;
    controllerStartedAt?: string;
    currentParentPid?: number;
    job?: ExecutionJob;
  },
): ExecutionWorkerInvalidation | undefined {
  const currentParentPid = options.currentParentPid ?? process.ppid;
  if (options.controllerPid && currentParentPid !== options.controllerPid) {
    return {
      code: "PARENT_DISCONNECTED",
      message:
        currentParentPid === 1
          ? `execution worker parent ${options.controllerPid} disconnected and PPID became 1`
          : `execution worker parent changed from ${options.controllerPid} to ${currentParentPid}`,
    };
  }
  if (options.controllerPid && !pidAlive(options.controllerPid)) {
    return {
      code: "CONTROLLER_UNAVAILABLE",
      message: `Controller process ${options.controllerPid} is no longer running`,
    };
  }
  if (options.controllerStartedAt) {
    const daemon = readControllerDaemonStatus(controllerHome);
    if (!["ready", "starting"].includes(daemon.status)) {
      return {
        code: "CONTROLLER_UNAVAILABLE",
        message: `Controller daemon is ${daemon.status}`,
      };
    }
    if (
      daemon.startedAt &&
      daemon.startedAt !== options.controllerStartedAt
    ) {
      return {
        code: "CONTROLLER_EPOCH_STALE",
        message: `Controller daemon epoch changed from ${options.controllerStartedAt} to ${daemon.startedAt}`,
      };
    }
  }
  const job = options.job ?? getExecutionJob(controllerHome, repoId, jobId);
  if (job.status !== "running") {
    return {
      code: "JOB_NOT_RUNNING",
      message: `Execution Job ${jobId} is ${job.status}`,
    };
  }
  if (job.workerPid !== undefined && job.workerPid !== options.workerPid) {
    return {
      code: "WORKER_REPLACED",
      message: `Execution Job ${jobId} belongs to worker PID ${job.workerPid}`,
    };
  }
  if (options.attempt !== undefined && job.attempt !== options.attempt) {
    return {
      code: "ATTEMPT_REPLACED",
      message: `Execution Job ${jobId} attempt ${options.attempt} was replaced by ${job.attempt}`,
    };
  }
  try {
    for (const ref of job.leaseRefs) {
      assertFencingToken(controllerHome, repoId, ref.leaseId, ref.fencingToken);
    }
  } catch (error) {
    return {
      code: "LEASE_INVALID",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return undefined;
}
