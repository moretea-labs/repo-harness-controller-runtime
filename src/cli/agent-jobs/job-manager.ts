import { createHash, randomBytes } from "crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "fs";
import { dirname, join, relative } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { runProcess } from "../../effects/process-runner";
import {
  getGitHubAgentSession,
  getGitHubAgentSessionLog,
  startGitHubAgentSession,
} from "../github/session";
import { getGitHubStatus } from "../github/github";
import { getIssue, inspectTaskReadiness, removeEphemeralIssue, updateTask } from "../controller/issue-store";
import { readTaskRunEvidence } from "../controller/run-evidence";
import { resolveEffectiveTaskState } from "../controller/task-status-resolver";
import type { ControllerAgent, ControllerTask } from "../controller/types";
import { tryAppendControllerWorklogEvent } from "../controller/worklog";
import { continueTaskAfterSuccessfulRun } from "../controller/execution-completion";
import { executionScopesConflict, taskExecutionPolicy } from "../controller/execution-policy";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_AGENT_TIMEOUT_MS,
  normalizeAgentTimeoutMs,
  repositoryIdentity,
} from "../controller/runtime-config";
import { normalizeRemoteUrl, stableCheckoutId, stableRemoteRepoId } from "../repositories/identity";
import {
  ensureControllerEpoch,
  hasControllerOwnershipMetadata,
  invalidateAgentWorker,
  isPidAlive,
} from "./worker-lifecycle";
import { terminateProcessTreeSync } from "../../runtime/shared/process-tree";
import type {
  AgentExecutionMode,
  AgentJobEvent,
  AgentJobMeta,
  AgentJobStatus,
  AgentJobWorkerConfig,
} from "./types";
import {
  classifyExecutorFailure,
  classifyGitHubCopilotPreflight,
  classifyLocalExecutorHealth,
  ExecutorHealthError,
  isExecutorHealthError,
  type LocalExecutorPolicy,
} from "./executor-health";

const JOB_ROOT = ".ai/harness/jobs";
const RUN_LAUNCH_LOCK = ".ai/harness/controller/run-launch.lock";
const RUN_REQUEST_INDEX_ROOT = ".ai/harness/controller/run-requests";
const RUN_INDEX_ROOT = ".ai/harness/controller/run-indexes";
const RUN_INDEX_LOCK = ".ai/harness/controller/run-index.lock";
const RUN_LAUNCH_LOCK_STALE_MS = 30_000;
const RUN_LAUNCH_LOCK_WAIT_MS = 500;
const RUN_LAUNCH_LOCK_POLL_MS = 10;

function shortId(): string {
  return randomBytes(4).toString("hex");
}

function sanitize(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "task"
  );
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function normalizeAgentMeta(
  repoRoot: string,
  runId: string,
  meta: AgentJobMeta,
): AgentJobMeta {
  meta.schemaVersion = meta.schemaVersion ?? 1;
  meta.provider = meta.provider ?? "local";
  meta.executionMode =
    meta.executionMode ??
    (meta.provider === "github"
      ? "github"
      : meta.worktree === repoRoot
        ? "workspace"
        : "worktree");
  meta.autoIntegrate = meta.autoIntegrate ?? meta.executionMode === "worktree";
  meta.eventsPath =
    meta.eventsPath ??
    relative(repoRoot, eventPath(repoRoot, runId)).replace(/\\/g, "/");
  return meta;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(temporaryPath, path);
}

function isAlive(pid: number | undefined): boolean {
  return isPidAlive(pid);
}

function atomicCreateJson(path: string, value: unknown): boolean {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function tryReadRepositoryIdentity(repoRoot: string): { repoId: string; checkoutId: string } {
  const path = join(repoRoot, ".ai/harness/repository.json");
  let repoId = "";
  try {
    if (existsSync(path)) {
      const parsed = readJson<{ repoId?: string }>(path);
      repoId = typeof parsed.repoId === "string" ? parsed.repoId.trim() : "";
    }
  } catch (_error) {
    repoId = "";
  }
  if (!repoId) {
    const remote = normalizeRemoteUrl(
      runProcess("git", ["config", "--get", "remote.origin.url"], {
        cwd: repoRoot,
        timeoutMs: 10_000,
        maxOutputBytes: 8 * 1024,
      }).stdout.trim(),
    );
    repoId = remote ? stableRemoteRepoId(remote) : repositoryIdentity(repoRoot);
  }
  return {
    repoId,
    checkoutId: stableCheckoutId(repoId, repoRoot),
  };
}

function withRunLaunchLock<T>(repoRoot: string, action: () => T): T {
  const path = join(repoRoot, RUN_LAUNCH_LOCK);
  mkdirSync(dirname(path), { recursive: true });
  const acquire = (): number => {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf-8");
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = true;
      try {
        const lock = readJson<{ pid?: number; createdAt?: string }>(path);
        const createdAt = Date.parse(lock.createdAt ?? "");
        stale =
          !Number.isFinite(createdAt) ||
          Date.now() - createdAt > RUN_LAUNCH_LOCK_STALE_MS ||
          !isAlive(lock.pid);
      } catch (_readError) {
        stale = true;
      }
      if (stale) {
        rmSync(path, { force: true });
        return acquire();
      }
      return -1;
    }
  };

  const deadline = Date.now() + RUN_LAUNCH_LOCK_WAIT_MS;
  let fd = acquire();
  while (fd < 0 && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RUN_LAUNCH_LOCK_POLL_MS);
    fd = acquire();
  }
  if (fd < 0)
    throw new Error("another Controller is preparing a local Task Run; retry after its workspace reservation is visible");
  try {
    return action();
  } finally {
    closeSync(fd);
    rmSync(path, { force: true });
  }
}

function jobDir(repoRoot: string, runId: string): string {
  return join(repoRoot, JOB_ROOT, runId);
}

function metaPath(repoRoot: string, runId: string): string {
  return join(jobDir(repoRoot, runId), "meta.json");
}

function eventPath(repoRoot: string, runId: string): string {
  return join(jobDir(repoRoot, runId), "events.jsonl");
}

function rawJobMetaPath(repoRoot: string, runId: string): string {
  return join(jobDir(repoRoot, runId), "meta.json");
}

function readRawAgentMeta(
  repoRoot: string,
  runId: string,
): AgentJobMeta | undefined {
  const path = rawJobMetaPath(repoRoot, runId);
  if (!existsSync(path)) return undefined;
  try {
    return normalizeAgentMeta(repoRoot, runId, readJson<AgentJobMeta>(path));
  } catch (_error) {
    return undefined;
  }
}

function requestIndexDir(repoRoot: string): string {
  return join(repoRoot, RUN_REQUEST_INDEX_ROOT);
}

function requestIndexPath(repoRoot: string, requestId: string): string {
  const digest = createHash("sha256").update(requestId).digest("hex");
  return join(requestIndexDir(repoRoot), `${digest}.json`);
}

interface AgentRunIndexEntry {
  runId: string;
  issueId: string;
  taskId: string;
  status: AgentJobStatus;
  createdAt: string;
  updatedAt: string;
  executionMode: AgentExecutionMode;
  integratedSessionId?: string;
}

interface AgentRunIndex {
  schemaVersion: 1;
  updatedAt: string;
  runs: AgentRunIndexEntry[];
}

function runIndexPath(repoRoot: string, name: 'active' | 'recent' | 'pending-integration'): string {
  return join(repoRoot, RUN_INDEX_ROOT, `${name}.json`);
}

function taskRunIndexPath(repoRoot: string, issueId: string, taskId: string): string {
  const digest = createHash('sha256').update(`${issueId}\0${taskId}`).digest('hex');
  return join(repoRoot, RUN_INDEX_ROOT, 'tasks', `${digest}.json`);
}

function withRunIndexLock<T>(repoRoot: string, action: () => T): T {
  const path = join(repoRoot, RUN_INDEX_LOCK);
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + 2_000;
  let descriptor = -1;
  while (descriptor < 0) {
    try {
      descriptor = openSync(path, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const lock = readJson<{ pid?: number; createdAt?: string }>(path);
        stale = !lock.pid || !isAlive(lock.pid) || Date.now() - Date.parse(lock.createdAt ?? '') > 30_000;
      } catch { stale = true; }
      if (stale) rmSync(path, { force: true });
      else if (Date.now() >= deadline) throw new Error('agent run index is busy; retry');
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return action(); }
  finally { closeSync(descriptor); rmSync(path, { force: true }); }
}

function readRunIndex(repoRoot: string, name: 'active' | 'recent' | 'pending-integration'): AgentRunIndex {
  const path = runIndexPath(repoRoot, name);
  if (!existsSync(path)) return { schemaVersion: 1, updatedAt: new Date().toISOString(), runs: [] };
  try { return readJson<AgentRunIndex>(path); }
  catch { return { schemaVersion: 1, updatedAt: new Date().toISOString(), runs: [] }; }
}

function updateRunIndexes(repoRoot: string, meta: AgentJobMeta): void {
  withRunIndexLock(repoRoot, () => {
    const entry: AgentRunIndexEntry = {
      runId: meta.runId,
      issueId: meta.issueId,
      taskId: meta.taskId,
      status: meta.status,
      createdAt: meta.createdAt,
      updatedAt: meta.lastHeartbeatAt ?? meta.finishedAt ?? meta.startedAt ?? meta.createdAt,
      executionMode: meta.executionMode,
      integratedSessionId: meta.integratedSessionId,
    };
    const active = readRunIndex(repoRoot, 'active');
    active.runs = active.runs.filter((candidate) => candidate.runId !== meta.runId);
    if (['queued', 'starting', 'running'].includes(meta.status)) active.runs.push(entry);
    active.updatedAt = new Date().toISOString();
    active.runs = active.runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-5000);
    writeJson(runIndexPath(repoRoot, 'active'), active);

    const recent = readRunIndex(repoRoot, 'recent');
    recent.runs = recent.runs.filter((candidate) => candidate.runId !== meta.runId);
    recent.runs.unshift(entry);
    recent.updatedAt = new Date().toISOString();
    recent.runs = recent.runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5000);
    writeJson(runIndexPath(repoRoot, 'recent'), recent);

    const pendingIntegration = readRunIndex(repoRoot, 'pending-integration');
    pendingIntegration.runs = pendingIntegration.runs.filter((candidate) => candidate.runId !== meta.runId);
    if (meta.status === 'succeeded' && meta.executionMode === 'worktree' && !meta.integratedSessionId) pendingIntegration.runs.push(entry);
    pendingIntegration.updatedAt = new Date().toISOString();
    pendingIntegration.runs = pendingIntegration.runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-5000);
    writeJson(runIndexPath(repoRoot, 'pending-integration'), pendingIntegration);

    const taskPath = taskRunIndexPath(repoRoot, meta.issueId, meta.taskId);
    const taskIndex = existsSync(taskPath)
      ? readJson<{ schemaVersion: 1; issueId: string; taskId: string; runIds: string[]; activeRunId?: string; updatedAt: string }>(taskPath)
      : { schemaVersion: 1 as const, issueId: meta.issueId, taskId: meta.taskId, runIds: [], updatedAt: new Date().toISOString() };
    taskIndex.runIds = [meta.runId, ...taskIndex.runIds.filter((runId) => runId !== meta.runId)].slice(0, 500);
    taskIndex.activeRunId = ['queued', 'starting', 'running'].includes(meta.status) ? meta.runId : (taskIndex.activeRunId === meta.runId ? undefined : taskIndex.activeRunId);
    taskIndex.updatedAt = new Date().toISOString();
    writeJson(taskPath, taskIndex);
  });
}

function writeAgentMeta(repoRoot: string, path: string, meta: AgentJobMeta): void {
  writeJson(path, meta);
  updateRunIndexes(repoRoot, meta);
}

function terminateRunProcess(pid: number | undefined): void {
  if (!pid || pid === process.pid || !isAlive(pid)) return;
  terminateProcessTreeSync(pid, {
    gracePeriodMs: 100,
    killAfterMs: 2_000,
    pollIntervalMs: 25,
  });
}

function terminateRunProcesses(meta: Pick<AgentJobMeta, "agentPid" | "workerPid" | "launchPid">): void {
  for (const pid of [meta.agentPid, meta.workerPid, meta.launchPid]) {
    terminateRunProcess(pid);
  }
}

function cancellationCleanupClaimPath(repoRoot: string, runId: string): string {
  return join(jobDir(repoRoot, runId), "cancel-cleanup.lock.json");
}

function cancellationProcessIds(meta: Pick<AgentJobMeta, "agentPid" | "workerPid" | "launchPid" | "cancellationPids">): number[] {
  return [...new Set([
    ...(meta.cancellationPids ?? []),
    meta.agentPid,
    meta.workerPid,
    meta.launchPid,
  ].filter((pid): pid is number => Boolean(pid && pid > 0 && pid !== process.pid)))];
}

function claimCancellationCleanup(repoRoot: string, runId: string): boolean {
  const path = cancellationCleanupClaimPath(repoRoot, runId);
  const claim = () => atomicCreateJson(path, {
    pid: process.pid,
    runId,
    claimedAt: new Date().toISOString(),
  });
  if (claim()) return true;
  try {
    const existing = readJson<{ pid?: number }>(path);
    if (isAlive(existing.pid)) return false;
  } catch (_error) {
    /* malformed or partially written claims are stale */
  }
  rmSync(path, { force: true });
  return claim();
}

function requestCancellationCleanup(repoRoot: string, runId: string): void {
  try {
    const existingPath = cancellationCleanupClaimPath(repoRoot, runId);
    if (existsSync(existingPath)) {
      try {
        const existing = readJson<{ pid?: number }>(existingPath);
        if (isAlive(existing.pid)) return;
      } catch (_error) {
        /* the detached cleaner will repair a stale claim */
      }
    }
    const cleaner = spawn(
      process.execPath,
      [fileURLToPath(new URL("./job-manager.ts", import.meta.url)), "cancel-cleanup", repoRoot, runId],
      { cwd: repoRoot, detached: true, stdio: "ignore" },
    );
    cleaner.unref();
    cleaner.once("error", (error) => {
      try {
        const current = getAgentJob(repoRoot, runId);
        if (current.status !== "cancelled" || !current.cleanupPending) return;
        const { stdoutTail: _stdout, stderrTail: _stderr, ...meta } = current;
        meta.cleanupError = error.message;
        writeAgentMeta(repoRoot, metaPath(repoRoot, runId), meta);
      } catch (_nested) {
        /* cancellation intent is already durable; a later retry can restart cleanup */
      }
    });
  } catch (error) {
    const current = getAgentJob(repoRoot, runId);
    if (current.status !== "cancelled" || !current.cleanupPending) return;
    const { stdoutTail: _stdout, stderrTail: _stderr, ...meta } = current;
    meta.cleanupError = error instanceof Error ? error.message : String(error);
    writeAgentMeta(repoRoot, metaPath(repoRoot, runId), meta);
  }
}

export function completeAgentJobCancellation(repoRoot: string, runId: string): AgentJobMeta {
  const claimPath = cancellationCleanupClaimPath(repoRoot, runId);
  if (!claimCancellationCleanup(repoRoot, runId)) return getAgentJob(repoRoot, runId);
  try {
    const current = getAgentJob(repoRoot, runId);
    if (current.status !== "cancelled" || !current.cleanupPending) return current;
    const { stdoutTail: _stdout, stderrTail: _stderr, ...meta } = current;
    meta.cleanupStartedAt = meta.cleanupStartedAt ?? new Date().toISOString();
    meta.cleanupError = undefined;
    writeAgentMeta(repoRoot, metaPath(repoRoot, runId), meta);

    for (const pid of cancellationProcessIds(meta)) terminateRunProcess(pid);

    const latest = getAgentJob(repoRoot, runId);
    if (latest.status !== "cancelled") return latest;
    const { stdoutTail: _latestStdout, stderrTail: _latestStderr, ...cleaned } = latest;
    cleaned.agentPid = undefined;
    cleaned.workerPid = undefined;
    cleaned.launchPid = undefined;
    cleaned.cancellationPids = [];
    cleaned.cleanupPending = false;
    cleaned.cleanupFinishedAt = new Date().toISOString();
    cleaned.cleanupError = undefined;
    writeAgentMeta(repoRoot, metaPath(repoRoot, runId), cleaned);
    appendAgentJobEvent(repoRoot, runId, {
      type: "run_cleanup_completed",
      message: "Cancelled Run process cleanup completed.",
    });
    try {
      const issue = getIssue(repoRoot, cleaned.issueId);
      const task = issue.tasks.find((entry) => entry.id === cleaned.taskId);
      if (task) {
        const state = resolveEffectiveTaskState({ issue, task, runs: readTaskRunEvidence(repoRoot, task) });
        if (!state.terminal && !state.inactive && (task.supersededBy?.length ?? 0) === 0) {
          updateTask(repoRoot, cleaned.issueId, cleaned.taskId, {
            status: "blocked",
            transition: "run_sync",
            note: `${runId} cancelled; explicit retry is required before another Run can be created.`,
          });
        }
      }
    } catch (_error) {
      /* Run cancellation remains authoritative if Task state has moved or disappeared. */
    }
    return cleaned;
  } catch (error) {
    try {
      const current = getAgentJob(repoRoot, runId);
      if (current.status === "cancelled") {
        const { stdoutTail: _stdout, stderrTail: _stderr, ...meta } = current;
        meta.cleanupPending = true;
        meta.cleanupError = error instanceof Error ? error.message : String(error);
        writeAgentMeta(repoRoot, metaPath(repoRoot, runId), meta);
        appendAgentJobEvent(repoRoot, runId, {
          type: "run_cleanup_failed",
          message: meta.cleanupError,
        });
        return meta;
      }
      return current;
    } catch (_nested) {
      throw error;
    }
  } finally {
    rmSync(claimPath, { force: true });
  }
}

function markRunUnknown(
  repoRoot: string,
  path: string,
  meta: AgentJobMeta,
  reason: string,
): void {
  if (["succeeded", "failed", "cancelled", "unknown"].includes(meta.status)) return;
  meta.status = "unknown";
  meta.error = meta.error ?? reason;
  meta.finishedAt = meta.finishedAt ?? new Date().toISOString();
  meta.lastHeartbeatAt = meta.finishedAt;
  writeAgentMeta(repoRoot, path, meta);
  appendAgentJobEvent(repoRoot, meta.runId, {
    type: "run_failed",
    message: meta.error,
  });
  reconcileLatestTerminalRun(repoRoot, meta);
}

function reconcileLocalRunOwnership(
  repoRoot: string,
  path: string,
  meta: AgentJobMeta,
): void {
  if (!["queued", "starting", "running"].includes(meta.status)) return;
  const hasOwnershipMetadata = hasControllerOwnershipMetadata({
    controllerPid: meta.controllerPid,
    controllerEpoch: meta.controllerEpoch,
    controllerEpochPath: meta.controllerEpochPath,
  });
  if (!hasOwnershipMetadata && meta.status !== "running") return;
  if (!hasOwnershipMetadata) {
    terminateRunProcesses(meta);
    meta.agentPid = undefined;
    meta.workerPid = undefined;
    meta.launchPid = undefined;
    markRunUnknown(repoRoot, path, meta, "Run ownership metadata is missing");
    return;
  }
  const invalidation = invalidateAgentWorker(meta, {
    controllerPid: meta.controllerPid,
    controllerEpoch: meta.controllerEpoch,
    controllerEpochPath: meta.controllerEpochPath
      ? join(repoRoot, meta.controllerEpochPath)
      : undefined,
  }, {
    workerPid: meta.workerPid,
  });
  if (!invalidation) return;
  terminateRunProcesses(meta);
  meta.agentPid = undefined;
  meta.workerPid = undefined;
  meta.launchPid = undefined;
  markRunUnknown(repoRoot, path, meta, invalidation.message);
}

export function appendAgentJobEvent(
  repoRoot: string,
  runId: string,
  event: Omit<AgentJobEvent, "at"> & { at?: string },
): void {
  const path = eventPath(repoRoot, runId);
  mkdirSync(dirname(path), { recursive: true });
  const at = event.at ?? new Date().toISOString();
  appendFileSync(
    path,
    `${JSON.stringify({ ...event, at })}\n`,
    "utf-8",
  );
  try {
    const metaFile = metaPath(repoRoot, runId);
    const meta = existsSync(metaFile) ? readJson<AgentJobMeta>(metaFile) : undefined;
    tryAppendControllerWorklogEvent(repoRoot, {
      at,
      category: "run",
      action: event.type,
      summary: event.message || event.type,
      actor: meta?.agent ?? "agent-runner",
      issueId: meta?.issueId,
      taskId: meta?.taskId,
      runId,
      details: event.data,
    });
  } catch (_error) {
    // The Run event remains authoritative even when the aggregate worklog is unavailable.
  }
}


function activeRunIndexEntries(repoRoot: string): AgentRunIndexEntry[] {
  let active = readRunIndex(repoRoot, 'active').runs;
  if (active.length === 0 && existsSync(join(repoRoot, JOB_ROOT))) {
    for (const meta of scanLegacyJobMeta(repoRoot, 5000)) updateRunIndexes(repoRoot, meta);
    active = readRunIndex(repoRoot, 'active').runs;
  }
  return active;
}

function activeLocalRuns(repoRoot: string, options: { excludeRunId?: string } = {}): AgentJobMeta[] {
  return activeRunIndexEntries(repoRoot).flatMap((entry) => {
    try { return [getAgentJob(repoRoot, entry.runId)]; }
    catch (_error) { return []; }
  }).filter(
    (entry) =>
      entry.provider === "local" &&
      ["queued", "starting", "running"].includes(entry.status) &&
      entry.runId !== options.excludeRunId &&
      (isAlive(entry.workerPid) || isAlive(entry.launchPid) || ["queued", "starting"].includes(entry.status)),
  );
}

function activeRuns(repoRoot: string): AgentJobMeta[] {
  return activeRunIndexEntries(repoRoot).flatMap((entry) => {
    try { return [readJson<AgentJobMeta>(metaPath(repoRoot, entry.runId))]; }
    catch (_error) { return []; }
  }).filter((entry) => ["queued", "starting", "running"].includes(entry.status));
}

function assertNoTaskScopeConflict(
  repoRoot: string,
  issueId: string,
  task: ControllerTask,
): void {
  const policy = taskExecutionPolicy(task);
  if (policy.executionClass === "read_only" || task.allowedPaths.length === 0) return;
  for (const run of activeRuns(repoRoot)) {
    if (run.issueId === issueId && run.taskId === task.id) continue;
    let otherScope = run.executionClass && run.allowedPaths
      ? { executionClass: run.executionClass, allowedPaths: run.allowedPaths }
      : undefined;
    if (!otherScope) {
      try {
        const otherTask = getIssue(repoRoot, run.issueId).tasks.find((entry) => entry.id === run.taskId);
        if (otherTask) {
          otherScope = {
            executionClass: taskExecutionPolicy(otherTask).executionClass,
            allowedPaths: otherTask.allowedPaths,
          };
        }
      } catch (_error) {
        continue;
      }
    }
    if (!otherScope || !executionScopesConflict(
      { executionClass: policy.executionClass, allowedPaths: task.allowedPaths },
      otherScope,
    )) continue;
    throw new Error(
      `task-local launch blocked by concurrent path conflict with ${run.issueId}/${run.taskId} (${run.runId})`,
    );
  }
}

function cleanupEphemeralIssueAfterRun(repoRoot: string, issueId: string): void {
  try {
    const issue = getIssue(repoRoot, issueId);
    if (issue.ephemeral) removeEphemeralIssue(repoRoot, issue.id);
  } catch (_error) {
    // Ephemeral cleanup is idempotent. Durable Run evidence is retained.
  }
}

function reconcileLatestTerminalRun(repoRoot: string, meta: AgentJobMeta): void {
  if (!["succeeded", "failed", "cancelled", "unknown"].includes(meta.status)) return;
  try {
    const issue = getIssue(repoRoot, meta.issueId);
    const task = issue.tasks.find((entry) => entry.id === meta.taskId);
    if (!task) return;
    const state = resolveEffectiveTaskState({ issue, task, runs: readTaskRunEvidence(repoRoot, task) });
    if (state.latestRunId !== meta.runId) return;
    if (["done", "cancelled", "superseded"].includes(task.status)) return;

    if (meta.status === "succeeded") {
      if (!["review", "integrated", "verifying", "verified"].includes(task.status)) {
        updateTask(repoRoot, issue.id, task.id, {
          status: "review",
          runId: meta.runId,
          transition: "run_sync",
          note: `${meta.runId} succeeded and entered task-local continuation.`,
        });
      }
      const continuation = continueTaskAfterSuccessfulRun(repoRoot, meta);
      if (continuation.status === "done") cleanupEphemeralIssueAfterRun(repoRoot, issue.id);
      return;
    }

    updateTask(repoRoot, issue.id, task.id, {
      status: "blocked",
      runId: meta.runId,
      transition: "run_sync",
      note: `${meta.runId} ended as ${meta.status}; explicit retry is required.${meta.error ? ` ${meta.error}` : ""}`,
    });
    cleanupEphemeralIssueAfterRun(repoRoot, issue.id);
  } catch (_error) {
    // Run evidence remains authoritative if Issue metadata changed concurrently.
  }
}

function reconcileIncompleteAutoIntegration(
  repoRoot: string,
  path: string,
  meta: AgentJobMeta,
): void {
  const message = meta.autoIntegrationError?.trim() || "automatic worktree integration did not finish after the worker exited; the isolated worktree was preserved for manual integration";
  const progressedAt = new Date().toISOString();
  meta.status = "waiting_for_user";
  meta.autoIntegrationError = message;
  meta.lastHeartbeatAt = progressedAt;
  delete meta.finishedAt;
  meta.progress = {
    phase: "waiting",
    percent: 96,
    currentActivity: `实现完成，但自动集成需要处理：${message}`,
    lastActivityAt: progressedAt,
    activityCount: (meta.progress?.activityCount ?? 0) + 1,
  };
  writeAgentMeta(repoRoot, path, meta);
  appendAgentJobEvent(repoRoot, meta.runId, {
    type: "run_waiting",
    message: "Automatic worktree integration did not finish; the worktree was preserved for manual integration.",
    data: { error: message, recovered: true },
  });
  try {
    updateTask(repoRoot, meta.issueId, meta.taskId, {
      status: "review",
      runId: meta.runId,
      transition: "run_sync",
      note: `Automatic integration did not finish for ${meta.runId}: ${message}`,
    });
  } catch (_error) {
    // Run evidence remains authoritative if task metadata changed concurrently.
  }
}

function resolveExecutionMode(
  repoRoot: string,
  provider: "local" | "github",
  isolate: boolean | undefined,
  options: { excludeRunId?: string } = {},
): AgentExecutionMode {
  if (provider === "github") return "github";
  if (isolate === true) return "worktree";
  if (isolate === false) {
    if (activeLocalRuns(repoRoot, options).length > 0)
      throw new Error(
        "cannot run directly in the current workspace while another local Task Run is active; use automatic or worktree isolation",
      );
    return "workspace";
  }
  return activeLocalRuns(repoRoot, options).length > 0 ? "worktree" : "workspace";
}

function createWorktree(
  repoRoot: string,
  issueId: string,
  task: ControllerTask,
  runId: string,
): { path: string; branch: string | null; baseRevision: string | null } {
  const gitCheck = runProcess("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: repoRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 8 * 1024,
  });
  if (!gitCheck.ok || gitCheck.stdout.trim() !== "true")
    return { path: repoRoot, branch: null, baseRevision: null };
  const revision = runProcess("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 8 * 1024,
  });
  if (!revision.ok)
    throw new Error(
      `failed to resolve task base revision: ${revision.error || revision.stderr}`,
    );
  const baseRevision = revision.stdout.trim();
  const planned = plannedWorktreeLocation(repoRoot, issueId, task.id, runId);
  const absoluteWorktree = planned.path;
  const branch = planned.branch;
  mkdirSync(dirname(absoluteWorktree), { recursive: true });
  const result = runProcess(
    "git",
    ["worktree", "add", "-b", branch, absoluteWorktree, "HEAD"],
    {
      cwd: repoRoot,
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024,
    },
  );
  if (!result.ok)
    throw new Error(
      `failed to create task worktree: ${result.error || result.stderr}`,
    );
  return { path: absoluteWorktree, branch, baseRevision };
}

function currentBaseRevision(repoRoot: string): string | null {
  const revision = runProcess("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 8 * 1024,
  });
  return revision.ok ? revision.stdout.trim() || null : null;
}

function plannedWorktreeLocation(
  repoRoot: string,
  issueId: string,
  taskId: string,
  runId: string,
): { path: string; branch: string } {
  const suffix = runId.slice(-8);
  return {
    path: join(
      repoRoot,
      `.ai/harness/worktrees/${sanitize(issueId)}-${sanitize(taskId)}-${suffix}`,
    ),
    branch: `controller/${sanitize(issueId)}-${sanitize(taskId)}-${suffix}`,
  };
}

export function taskPrompt(
  issueTitle: string,
  issueSummary: string,
  task: ControllerTask,
  repoRoot: string,
  worktree: string,
  provider: "local" | "github" = "local",
  executionMode: AgentExecutionMode = provider === "github"
    ? "github"
    : "workspace",
): string {
  const executionRules =
    provider === "github"
      ? [
          "- Work in a dedicated branch and open or update a draft pull request.",
          "- Do not merge the pull request or close the parent issue.",
          "- Keep the change limited to this Task and surface any missing product decision as a blocker.",
          "- Finish with a concise PR summary: changed files, checks, residual risks, and blockers.",
        ]
      : [
          "- Keep the change limited to this task. Do not broaden the requirement.",
          executionMode === "worktree"
            ? "- Work only inside the isolated worktree. repo-harness will integrate and clean it automatically after a successful Run."
            : "- Work directly in the current repository workspace. Do not create another worktree, commit, merge, or push.",
          "- Finish with a concise report: changed files, checks, residual risks, and any blocker.",
        ];
  return [
    "# repo-harness Controller Task",
    "",
    `Issue: ${issueTitle}`,
    issueSummary ? `Issue summary: ${issueSummary}` : "",
    `Task: ${task.id} — ${task.title}`,
    `Objective: ${task.objective}`,
    task.github ? `GitHub task: ${task.github.url}` : "",
    "",
    "## Scope contract",
    "",
    `- Repository: ${repoRoot}`,
    provider === "local"
      ? `- Execution mode: ${executionMode === "worktree" ? `isolated worktree (${worktree})` : `current workspace (${worktree})`}`
      : "- Execution: GitHub Copilot cloud agent session",
    `- Allowed paths: ${task.allowedPaths.length ? task.allowedPaths.join(", ") : "derive the smallest safe scope; do not make unrelated changes"}`,
    `- Forbidden paths: ${task.forbiddenPaths.length ? task.forbiddenPaths.join(", ") : "secrets, credentials, auth state, and unrelated files"}`,
    `- Risk: ${task.risk}`,
    "",
    "## Acceptance criteria",
    "",
    ...(task.acceptanceCriteria.length
      ? task.acceptanceCriteria.map((item) => `- ${item}`)
      : ["- Complete the stated objective without unrelated changes."]),
    "",
    "## Required checks",
    "",
    ...(task.checks.length
      ? task.checks.map((item) => `- ${item}`)
      : [
          "- Run the smallest relevant verification available in the repository.",
        ]),
    "",
    "## Execution rules",
    "",
    "- Inspect repository instructions and the affected implementation before editing.",
    ...executionRules,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface StartTaskJobOptions {
  repoRoot: string;
  issueId: string;
  taskId: string;
  agent?: ControllerAgent;
  timeoutMs: number;
  isolate?: boolean;
  githubRepo?: string;
  baseRef?: string;
  model?: string;
  createPullRequest?: boolean;
  retryFromRunId?: string;
  supervisorInstructions?: string;
  requestId?: string;
  approveRisk?: boolean;
  approveDestructive?: boolean;
  executorPolicy?: LocalExecutorPolicy;
}

export interface DispatchTaskAcceptance {
  accepted: true;
  reused: boolean;
  runId: string;
  issueId: string;
  taskId: string;
  agent: ControllerAgent;
  provider: "local" | "github";
  executionMode: AgentExecutionMode;
  status: AgentJobStatus;
  timeoutMs?: number;
  requestId?: string;
  statusTool: "get_task_run";
}

function persistRequestIndex(
  repoRoot: string,
  requestId: string,
  value: { requestId: string; runId: string; issueId: string; taskId: string; createdAt: string },
): void {
  const path = requestIndexPath(repoRoot, requestId);
  if (!existsSync(path)) writeJson(path, value);
}

function readRequestIndex(
  repoRoot: string,
  requestId: string,
): { requestId?: string; runId?: string; issueId?: string; taskId?: string } | undefined {
  const path = requestIndexPath(repoRoot, requestId);
  if (!existsSync(path)) return undefined;
  try {
    return readJson(path);
  } catch (_error) {
    return undefined;
  }
}

function acceptedSummary(meta: AgentJobMeta, reused = false): DispatchTaskAcceptance {
  return {
    accepted: true,
    reused,
    runId: meta.runId,
    issueId: meta.issueId,
    taskId: meta.taskId,
    agent: meta.agent,
    provider: meta.provider,
    executionMode: meta.executionMode,
    status: meta.status,
    timeoutMs: meta.timeoutMs,
    requestId: meta.requestId,
    statusTool: "get_task_run",
  };
}

function executorFailureMessage(meta: Pick<AgentJobMeta, "agent" | "error">, stdoutTail?: string, stderrTail?: string): string {
  return [meta.error, stderrTail, stdoutTail].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n");
}

function attachExecutorFailureHealth(meta: AgentJobMeta, stdoutTail?: string, stderrTail?: string): AgentJobMeta {
  if (meta.executorHealth || meta.status === "succeeded") return meta;
  const message = executorFailureMessage(meta, stdoutTail, stderrTail);
  const health = classifyExecutorFailure(meta.agent, message, { allowedPaths: meta.allowedPaths ?? [] });
  if (health) meta.executorHealth = health;
  return meta;
}

function failAcceptedTaskJob(
  repoRoot: string,
  runId: string,
  reason: unknown,
): AgentJobMeta {
  const current = getAgentJob(repoRoot, runId);
  if (!["starting", "queued", "running"].includes(current.status)) return current;
  const { stdoutTail: _stdout, stderrTail: _stderr, ...meta } = current;
  meta.status = "failed";
  meta.error = reason instanceof Error ? reason.message : String(reason);
  meta.finishedAt = new Date().toISOString();
  meta.lastHeartbeatAt = meta.finishedAt;
  meta.terminationReason = "spawn_error";
  attachExecutorFailureHealth(meta);
  writeAgentMeta(repoRoot, metaPath(repoRoot, runId), meta);
  appendAgentJobEvent(repoRoot, runId, {
    type: "run_failed",
    message: meta.error,
  });
  try {
    updateTask(repoRoot, meta.issueId, meta.taskId, {
      status: "blocked",
      runId: meta.runId,
      transition: "run_sync",
      note: `${meta.runId} failed before startup completed; explicit retry is required: ${meta.error}`,
    });
  } catch (_error) {
    /* Run metadata remains authoritative when task sync also fails. */
  }
  return meta;
}

function acceptancePaths(repoRoot: string, runId: string) {
  const dir = jobDir(repoRoot, runId);
  return {
    dir,
    promptPath: join(dir, "prompt.md"),
    stdoutPath: join(dir, "stdout.log"),
    stderrPath: join(dir, "stderr.log"),
    resultPath: join(dir, "result.json"),
    eventsPath: join(dir, "events.jsonl"),
  };
}

function scanLegacyJobMeta(repoRoot: string, limit = 50): AgentJobMeta[] {
  const boundedLimit = Math.min(Math.max(limit, 1), 5000);
  const root = join(repoRoot, JOB_ROOT);
  if (!existsSync(root)) return [];
  const createdAtFromRunId = (runId: string): number => {
    const match = runId.match(/-(\d{13})-[a-f0-9]+$/i);
    return match ? Number(match[1]) : 0;
  };
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "meta.json")))
    .sort((a, b) => createdAtFromRunId(b.name) - createdAtFromRunId(a.name))
    .slice(0, boundedLimit)
    .flatMap((entry) => {
      const meta = readRawAgentMeta(repoRoot, entry.name);
      return meta ? [meta] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function findActiveTaskRun(repoRoot: string, issueId: string, taskId: string): AgentJobMeta | undefined {
  const indexPath = taskRunIndexPath(repoRoot, issueId, taskId);
  if (existsSync(indexPath)) {
    try {
      const index = readJson<{ activeRunId?: string }>(indexPath);
      if (index.activeRunId) {
        const active = getAgentJob(repoRoot, index.activeRunId);
        if (["queued", "starting", "running"].includes(active.status)) return active;
      }
    } catch (_error) {
      // Fall through to compatibility backfill.
    }
  }
  const active = scanLegacyJobMeta(repoRoot, 5000)
    .filter((entry) => entry.issueId === issueId && entry.taskId === taskId)
    .find((entry) => ["queued", "starting", "running"].includes(entry.status));
  if (active) updateRunIndexes(repoRoot, active);
  return active;
}

function baseMeta(
  opts: StartTaskJobOptions,
  task: ControllerTask,
  runId: string,
  paths: {
    promptPath: string;
    stdoutPath: string;
    stderrPath: string;
    resultPath: string;
    eventsPath: string;
  },
  isolation: {
    path: string;
    branch: string | null;
    baseRevision: string | null;
  },
  provider: "local" | "github",
  executionMode: AgentExecutionMode,
): AgentJobMeta {
  const identity = tryReadRepositoryIdentity(opts.repoRoot);
  const plannedWorktree = provider === "local" && executionMode === "worktree"
    ? plannedWorktreeLocation(opts.repoRoot, opts.issueId, task.id, runId)
    : undefined;
  const executionRoot = plannedWorktree?.path ?? isolation.path;
  const branch = plannedWorktree?.branch ?? isolation.branch;
  return {
    schemaVersion: 3,
    repoId: identity.repoId,
    checkoutId: identity.checkoutId,
    requestId: opts.requestId,
    supervisorInstructions: opts.supervisorInstructions?.trim() || undefined,
    runId,
    issueId: opts.issueId,
    taskId: opts.taskId,
    agent: opts.agent!,
    provider,
    executionMode,
    executionClass: taskExecutionPolicy(task).executionClass,
    allowedPaths: [...task.allowedPaths],
    status: "starting",
    repoRoot: opts.repoRoot,
    executionRoot,
    worktree: executionRoot,
    worktreePath: executionRoot,
    branch,
    baseRevision: isolation.baseRevision,
    promptPath: relative(opts.repoRoot, paths.promptPath).replace(/\\/g, "/"),
    stdoutPath: relative(opts.repoRoot, paths.stdoutPath).replace(/\\/g, "/"),
    stderrPath: relative(opts.repoRoot, paths.stderrPath).replace(/\\/g, "/"),
    resultPath: relative(opts.repoRoot, paths.resultPath).replace(/\\/g, "/"),
    eventsPath: relative(opts.repoRoot, paths.eventsPath).replace(/\\/g, "/"),
    timeoutMs: opts.timeoutMs,
    startupDeadlineAt: new Date(Date.now() + 30_000).toISOString(),
    autoIntegrate: executionMode === "worktree",
    progress: {
      phase: "starting",
      percent: 2,
      currentActivity: "已受理，等待异步启动",
      lastActivityAt: new Date().toISOString(),
      activityCount: 0,
    },
    createdAt: new Date().toISOString(),
  };
}

export function acceptTaskJob(opts: StartTaskJobOptions): DispatchTaskAcceptance {
  const timeoutMs = normalizeAgentTimeoutMs(opts.timeoutMs, {
    defaultMs: DEFAULT_AGENT_TIMEOUT_MS,
    maxMs: MAX_AGENT_TIMEOUT_MS,
  });
  opts = { ...opts, timeoutMs };
  if (opts.requestId) {
    const indexed = readRequestIndex(opts.repoRoot, opts.requestId);
    if (indexed?.runId) return acceptedSummary(getAgentJob(opts.repoRoot, indexed.runId), true);
  }
  const existing = findActiveTaskRun(opts.repoRoot, opts.issueId, opts.taskId);
  if (!opts.requestId && existing) return acceptedSummary(existing, true);
  const issue = getIssue(opts.repoRoot, opts.issueId);
  const task = issue.tasks.find((entry) => entry.id === opts.taskId);
  if (!task) throw new Error(`task not found: ${opts.issueId}/${opts.taskId}`);
  const selectedAgent = opts.agent ?? task.recommendedAgent;
  if (!selectedAgent) throw new Error("agent must be selected at dispatch time");
  opts = { ...opts, agent: selectedAgent };
  if (selectedAgent === "github-copilot") {
    const health = classifyGitHubCopilotPreflight(
      getGitHubStatus(opts.repoRoot, opts.githubRepo),
      task,
    );
    if (health) throw new ExecutorHealthError("EXECUTOR_HEALTH", health);
  }
  if (selectedAgent !== "github-copilot" && opts.executorPolicy) {
    const health = classifyLocalExecutorHealth(selectedAgent, opts.executorPolicy, task);
    if (health) throw new ExecutorHealthError("EXECUTOR_HEALTH", health);
  }
  const readiness = inspectTaskReadiness(opts.repoRoot, opts.issueId, opts.taskId, {
    approveRisk: opts.approveRisk,
    approveDestructive: opts.approveDestructive,
    retryFromRunId: opts.retryFromRunId,
  });
  if (!readiness.ready) {
    throw new Error(`task-local launch blocked: ${readiness.blockers.map((entry) => `${entry.code}: ${entry.message}`).join("; ")}`);
  }
  const agent = opts.agent!;
  const provider = agent === "github-copilot" ? "github" : "local";
  return withRunLaunchLock(opts.repoRoot, () => {
    if (opts.requestId) {
      const indexed = readRequestIndex(opts.repoRoot, opts.requestId);
      if (indexed?.runId) return acceptedSummary(getAgentJob(opts.repoRoot, indexed.runId), true);
    }
    const existingWithinLock = findActiveTaskRun(opts.repoRoot, opts.issueId, opts.taskId);
    if (!opts.requestId && existingWithinLock) return acceptedSummary(existingWithinLock, true);
    assertNoTaskScopeConflict(opts.repoRoot, opts.issueId, task);
    const runId = `RUN-${sanitize(opts.issueId)}-${sanitize(opts.taskId)}-${Date.now()}-${shortId()}`;
    const executionMode = provider === "github"
      ? "github"
      : opts.isolate === true
        ? "worktree"
        : opts.isolate === false
          ? "workspace"
          : activeLocalRuns(opts.repoRoot).length > 0
            ? "worktree"
            : "workspace";
    const paths = acceptancePaths(opts.repoRoot, runId);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.promptPath, "", "utf-8");
    writeFileSync(paths.stdoutPath, "", "utf-8");
    writeFileSync(paths.stderrPath, "", "utf-8");
    writeFileSync(paths.eventsPath, "", "utf-8");
    const meta = baseMeta(opts, task, runId, paths, {
      path: opts.repoRoot,
      branch: null,
      baseRevision: currentBaseRevision(opts.repoRoot),
    }, provider, executionMode);
    writeAgentMeta(opts.repoRoot, metaPath(opts.repoRoot, runId), meta);
    appendAgentJobEvent(opts.repoRoot, runId, {
      type: "run_created",
      message: `${agent} Run accepted in ${executionMode} mode.`,
      data: { executionMode, autoIntegrate: executionMode === "worktree" },
    });
    updateTask(opts.repoRoot, issue.id, task.id, {
      status: "ready",
      runId,
      transition: "run_sync",
      note: `Accepted ${runId} for asynchronous launch.`,
    });
    if (opts.requestId) {
      persistRequestIndex(opts.repoRoot, opts.requestId, {
        requestId: opts.requestId,
        runId,
        issueId: opts.issueId,
        taskId: opts.taskId,
        createdAt: meta.createdAt,
      });
    }
    return acceptedSummary(meta);
  });
}

export function launchAcceptedTaskJob(
  repoRoot: string,
  runId: string,
): AgentJobMeta {
  const absoluteMetaPath = metaPath(repoRoot, runId);
  if (!existsSync(absoluteMetaPath)) throw new Error(`agent job not found: ${runId}`);
  const meta = readJson<AgentJobMeta>(absoluteMetaPath);
  if (!["starting", "queued"].includes(meta.status)) return getAgentJob(repoRoot, runId);
  const issue = getIssue(repoRoot, meta.issueId);
  const task = issue.tasks.find((entry) => entry.id === meta.taskId);
  if (!task) throw new Error(`task not found: ${meta.issueId}/${meta.taskId}`);
  const provider = meta.agent === "github-copilot" ? "github" : "local";
  let executionMode = resolveExecutionMode(
    repoRoot,
    provider,
    meta.executionMode === "worktree" ? true : meta.executionMode === "workspace" ? false : undefined,
    { excludeRunId: runId },
  );
  const paths = acceptancePaths(repoRoot, runId);
  const isolation = executionMode === "worktree"
    ? createWorktree(repoRoot, meta.issueId, task, runId)
    : {
        path: repoRoot,
        branch: null,
        baseRevision: currentBaseRevision(repoRoot),
      };
  if (executionMode === "worktree" && isolation.path === repoRoot) executionMode = "workspace";
  meta.executionMode = executionMode;
  meta.executionRoot = isolation.path;
  meta.worktree = isolation.path;
  meta.worktreePath = isolation.path;
  meta.branch = isolation.branch;
  meta.baseRevision = isolation.baseRevision;
  const basePrompt = taskPrompt(issue.title, issue.summary, task, repoRoot, isolation.path, provider, executionMode);
  const prompt = meta.supervisorInstructions
    ? `${basePrompt}

## Supervisor follow-up

${meta.supervisorInstructions}
`
    : basePrompt;
  writeFileSync(paths.promptPath, prompt, "utf-8");
  writeAgentMeta(repoRoot, absoluteMetaPath, meta);

  if (provider === "github") {
    try {
      const session = startGitHubAgentSession(repoRoot, {
        prompt,
        repo: issue.github ? `${issue.github.owner}/${issue.github.repo}` : undefined,
        baseRef: meta.github?.baseRef,
        model: meta.github?.model,
        createPullRequest: meta.github?.createPullRequest,
      });
      meta.status = mapGitHubState(session.state);
      meta.startedAt = new Date().toISOString();
      meta.github = {
        owner: session.repository.owner,
        repo: session.repository.repo,
        taskId: session.id,
        state: session.state,
        url: session.url,
        pullRequestUrl: session.pullRequestUrl,
        baseRef: meta.github?.baseRef ?? session.repository.defaultBranch,
        model: meta.github?.model,
        createPullRequest: meta.github?.createPullRequest,
        raw: session.raw,
      };
      writeFileSync(paths.stdoutPath, `${JSON.stringify(session.raw, null, 2)}\n`, "utf-8");
      if (["succeeded", "failed", "cancelled"].includes(meta.status)) meta.finishedAt = new Date().toISOString();
      writeAgentMeta(repoRoot, absoluteMetaPath, meta);
      appendAgentJobEvent(repoRoot, runId, {
        type:
          meta.status === "succeeded"
            ? "run_succeeded"
            : meta.status === "failed"
              ? "run_failed"
              : meta.status === "waiting_for_user"
                ? "run_waiting"
                : "run_started",
        message: `GitHub cloud session ${session.id} entered ${session.state}.`,
        data: { url: session.url, pullRequestUrl: session.pullRequestUrl },
      });
      updateTask(repoRoot, issue.id, task.id, {
        status:
          meta.status === "succeeded"
            ? "review"
            : ["failed", "cancelled", "unknown"].includes(meta.status)
              ? "blocked"
              : meta.status === "waiting_for_user"
                ? "blocked"
                : "running",
        runId,
        transition: "run_sync",
        note: `Dispatched ${runId} to GitHub Copilot cloud session ${session.id}.`,
      });
      if (meta.status === "succeeded") continueTaskAfterSuccessfulRun(repoRoot, meta);
      return meta;
    } catch (error) {
      meta.status = "failed";
      if (isExecutorHealthError(error)) meta.executorHealth = error.executorHealth;
      meta.error = error instanceof Error ? error.message : String(error);
      meta.finishedAt = new Date().toISOString();
      meta.terminationReason = "spawn_error";
      writeFileSync(paths.stderrPath, meta.error, "utf-8");
      attachExecutorFailureHealth(meta);
      writeAgentMeta(repoRoot, absoluteMetaPath, meta);
      appendAgentJobEvent(repoRoot, runId, {
        type: "run_failed",
        message: meta.error,
      });
      updateTask(repoRoot, issue.id, task.id, {
        status: "blocked",
        runId,
        transition: "run_sync",
        note: `${runId} failed to start and remains recorded as an attempt; explicit retry is required: ${meta.error}`,
      });
      return meta;
    }
  }

  const configPath = join(paths.dir, "worker-config.json");
  const controllerEpoch = ensureControllerEpoch(repoRoot);
  meta.controllerPid = controllerEpoch.pid;
  meta.controllerEpoch = controllerEpoch.epoch;
  meta.controllerEpochPath = relative(repoRoot, controllerEpoch.path).replace(/\\/g, "/");
  meta.launchPid = process.pid;
  const workerConfig: AgentJobWorkerConfig = {
    metaPath: absoluteMetaPath,
    agent: meta.agent as Exclude<ControllerAgent, "github-copilot">,
    worktree: meta.worktree,
    promptPath: paths.promptPath,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    resultPath: paths.resultPath,
    eventsPath: paths.eventsPath,
    timeoutMs: meta.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    autoIntegrate: executionMode === "worktree",
    controllerPid: meta.controllerPid,
    controllerEpoch: meta.controllerEpoch,
    controllerEpochPath: controllerEpoch.path,
    parentPid: process.pid,
  };
  writeJson(configPath, workerConfig);
  const workerEntry = fileURLToPath(
    new URL("./job-worker.ts", import.meta.url),
  );
  const outFd = openSync(join(paths.dir, "worker.log"), "a");
  const errFd = openSync(join(paths.dir, "worker-error.log"), "a");
  try {
    const child = spawn(process.execPath, [workerEntry, configPath], {
      cwd: repoRoot,
      detached: false,
      stdio: ["ignore", outFd, errFd],
    });
    meta.workerPid = child.pid;
    meta.status = "running";
    meta.progress = {
      phase: "starting",
      percent: 5,
      currentActivity: `正在启动 ${meta.agent}`,
      lastActivityAt: new Date().toISOString(),
      activityCount: 0,
    };
    meta.startedAt = new Date().toISOString();
    meta.deadlineAt = new Date(
      Date.parse(meta.startedAt) + (meta.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS),
    ).toISOString();
    meta.lastHeartbeatAt = meta.startedAt;
    writeAgentMeta(repoRoot, absoluteMetaPath, meta);
    appendAgentJobEvent(repoRoot, runId, {
      type: "run_started",
      message: `Local ${meta.agent} worker started in ${executionMode} mode.`,
      data: { executionMode, worktree: meta.worktree },
    });
    updateTask(repoRoot, issue.id, task.id, {
      status: "running",
      runId,
      transition: "run_sync",
      note: `Dispatched ${runId} to ${meta.agent}.`,
    });
    return meta;
  } catch (error) {
    meta.status = "failed";
    meta.error = error instanceof Error ? error.message : String(error);
    meta.finishedAt = new Date().toISOString();
    meta.terminationReason = "spawn_error";
    attachExecutorFailureHealth(meta);
    writeAgentMeta(repoRoot, absoluteMetaPath, meta);
    appendAgentJobEvent(repoRoot, runId, {
      type: "run_failed",
      message: meta.error,
    });
    updateTask(repoRoot, issue.id, task.id, {
      status: "blocked",
      runId,
      transition: "run_sync",
      note: `${runId} failed to start and remains recorded as an attempt; explicit retry is required: ${meta.error}`,
    });
    return meta;
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

export function startAcceptedTaskJob(repoRoot: string, runId: string): AgentJobMeta {
  return withRunLaunchLock(repoRoot, () => launchAcceptedTaskJob(repoRoot, runId));
}

export function startTaskJob(opts: StartTaskJobOptions): AgentJobMeta {
  const accepted = acceptTaskJob(opts);
  return startAcceptedTaskJob(opts.repoRoot, accepted.runId);
}

function mapGitHubState(state: string): AgentJobStatus {
  switch (state) {
    case "completed":
      return "succeeded";
    case "failed":
    case "timed_out":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "idle":
    case "waiting_for_user":
      return "waiting_for_user";
    case "queued":
      return "queued";
    case "in_progress":
      return "running";
    default:
      return "unknown";
  }
}

export function getAgentJob(
  repoRoot: string,
  runId: string,
): AgentJobMeta & {
  stdoutTail: string;
  stderrTail: string;
  timing: { elapsedMs: number; remainingMs: number | null; overdue: boolean };
} {
  const path = metaPath(repoRoot, runId);
  if (!existsSync(path)) throw new Error(`agent job not found: ${runId}`);
  const meta = normalizeAgentMeta(repoRoot, runId, readJson<AgentJobMeta>(path));
  let metaMutated = false;

  if (
    meta.provider === "github" &&
    meta.github &&
    ["queued", "starting", "running", "waiting_for_user", "unknown"].includes(meta.status)
  ) {
    try {
      const session = getGitHubAgentSession(
        repoRoot,
        meta.github.owner,
        meta.github.repo,
        meta.github.taskId,
      );
      const previous = meta.status;
      meta.status = mapGitHubState(session.state);
      meta.github = {
        ...meta.github,
        state: session.state,
        url: session.url ?? meta.github.url,
        pullRequestUrl: session.pullRequestUrl ?? meta.github.pullRequestUrl,
        raw: session.raw,
      };
      if (
        meta.status === "succeeded" ||
        meta.status === "failed" ||
        meta.status === "cancelled"
      )
        meta.finishedAt = meta.finishedAt ?? new Date().toISOString();
      writeAgentMeta(repoRoot, path, meta);
      if (previous !== meta.status) {
        const eventType =
          meta.status === "succeeded"
            ? "run_succeeded"
            : meta.status === "failed"
              ? "run_failed"
              : meta.status === "waiting_for_user"
                ? "run_waiting"
                : meta.status === "cancelled"
                  ? "run_cancelled"
                  : "log_updated";
        appendAgentJobEvent(repoRoot, runId, {
          type: eventType,
          message: `GitHub session state changed to ${session.state}.`,
          data: {
            url: meta.github.url,
            pullRequestUrl: meta.github.pullRequestUrl,
          },
        });
        if (["succeeded", "failed", "cancelled", "unknown"].includes(meta.status)) {
          reconcileLatestTerminalRun(repoRoot, meta);
        } else {
          try {
            updateTask(repoRoot, meta.issueId, meta.taskId, {
              status: meta.status === "waiting_for_user" ? "blocked" : "running",
              runId: meta.runId,
              transition: "run_sync",
              note: `GitHub Run ${meta.runId} synchronized to ${meta.status}.`,
            });
          } catch (_error) {
            /* Run evidence remains authoritative if task metadata changed concurrently. */
          }
        }
      }
    } catch (error) {
      meta.error = error instanceof Error ? error.message : String(error);
      const beforeReason = meta.executorHealth?.reason;
      attachExecutorFailureHealth(meta);
      metaMutated = metaMutated || beforeReason !== meta.executorHealth?.reason;
      writeAgentMeta(repoRoot, path, meta);
    }
  } else if (meta.provider === "local") {
    const resultAbsolute = join(repoRoot, meta.resultPath);
    const autoIntegrationInFlight = meta.status === "running" &&
      meta.autoIntegrate === true &&
      meta.executionMode === "worktree" &&
      isAlive(meta.workerPid);
    if (
      ["queued", "starting", "running"].includes(meta.status) &&
      existsSync(resultAbsolute) &&
      !autoIntegrationInFlight
    ) {
      const result = readJson<{
        ok: boolean;
        exitCode: number | null;
        error?: string;
        finishedAt: string;
      }>(resultAbsolute);
      const previous = meta.status;
      meta.exitCode = result.exitCode;
      meta.error = result.error;
      if (
        result.ok &&
        meta.autoIntegrate === true &&
        meta.executionMode === "worktree" &&
        !meta.integratedSessionId
      ) {
        reconcileIncompleteAutoIntegration(repoRoot, path, meta);
      } else {
        meta.status = result.ok ? "succeeded" : "failed";
        meta.finishedAt = result.finishedAt;
        if (!result.ok) attachExecutorFailureHealth(meta);
        writeAgentMeta(repoRoot, path, meta);
        if (previous !== meta.status) {
          appendAgentJobEvent(repoRoot, runId, {
            type: result.ok ? "run_succeeded" : "run_failed",
            message: result.ok
              ? "Local worker finished."
              : (result.error ?? `exit ${result.exitCode}`),
          });
          reconcileLatestTerminalRun(repoRoot, meta);
        }
      }
    } else {
      reconcileLocalRunOwnership(repoRoot, path, meta);
    }
    if (
      ["queued", "starting"].includes(meta.status) &&
      meta.startupDeadlineAt &&
      Date.now() > Date.parse(meta.startupDeadlineAt) &&
      !isAlive(meta.workerPid) &&
      !isAlive(meta.launchPid)
    ) {
      meta.status = "unknown";
      meta.error = meta.error ?? "worker did not start before the startup deadline";
      meta.finishedAt = meta.finishedAt ?? new Date().toISOString();
      attachExecutorFailureHealth(meta);
      writeAgentMeta(repoRoot, path, meta);
      appendAgentJobEvent(repoRoot, runId, { type: "run_failed", message: meta.error });
      reconcileLatestTerminalRun(repoRoot, meta);
    } else if (meta.status === "running" && !isAlive(meta.workerPid)) {
      meta.status = "unknown";
      meta.error =
        meta.error ??
        "worker process is no longer running and no result file was produced";
      meta.finishedAt = meta.finishedAt ?? new Date().toISOString();
      attachExecutorFailureHealth(meta);
      writeAgentMeta(repoRoot, path, meta);
      appendAgentJobEvent(repoRoot, runId, { type: "run_failed", message: meta.error });
      reconcileLatestTerminalRun(repoRoot, meta);
    }
  }
  const tail = (relativePath: string): string => {
    const absolute = join(repoRoot, relativePath);
    if (!existsSync(absolute)) return "";
    const content = readFileSync(absolute, "utf-8");
    return content.slice(-32 * 1024);
  };
  const startMs = meta.startedAt
    ? Date.parse(meta.startedAt)
    : Date.parse(meta.createdAt);
  const endMs = meta.finishedAt ? Date.parse(meta.finishedAt) : Date.now();
  const deadlineMs = meta.deadlineAt
    ? Date.parse(meta.deadlineAt)
    : meta.timeoutMs
      ? startMs + meta.timeoutMs
      : NaN;
  const remainingMs =
    Number.isFinite(deadlineMs) && !meta.finishedAt
      ? Math.max(0, deadlineMs - Date.now())
      : null;
  const beforeReason = meta.executorHealth?.reason;
  attachExecutorFailureHealth(meta, tail(meta.stdoutPath), tail(meta.stderrPath));
  if (beforeReason !== meta.executorHealth?.reason) metaMutated = true;
  if (metaMutated) writeAgentMeta(repoRoot, path, meta);
  return {
    ...meta,
    stdoutTail: tail(meta.stdoutPath),
    stderrTail: tail(meta.stderrPath),
    timing: {
      elapsedMs: Math.max(0, endMs - startMs),
      remainingMs,
      overdue:
        Number.isFinite(deadlineMs) &&
        !meta.finishedAt &&
        Date.now() > deadlineMs,
    },
  };
}

export function reconcileAgentJobs(repoRoot: string): {
  scanned: number;
  terminalized: number;
} {
  const runs = activeRunIndexEntries(repoRoot);
  let terminalized = 0;
  for (const entry of runs) {
    try {
      const path = metaPath(repoRoot, entry.runId);
      const before = readJson<AgentJobMeta>(path);
      if (before.provider !== "local") continue;
      const previous = before.status;
      getAgentJob(repoRoot, entry.runId);
      const after = readJson<AgentJobMeta>(path);
      if (
        previous !== after.status &&
        ["succeeded", "failed", "cancelled", "unknown"].includes(after.status)
      ) {
        terminalized += 1;
      }
    } catch (_error) {
      // Missing state is pruned lazily by index rebuilds.
    }
  }
  return { scanned: runs.length, terminalized };
}

export function listPendingIntegrationRuns(repoRoot: string, limit = 500): AgentJobMeta[] {
  const bounded = Math.max(1, Math.min(limit, 5000));
  return readRunIndex(repoRoot, 'pending-integration').runs.slice(0, bounded).flatMap((entry) => {
    try {
      const { stdoutTail: _stdout, stderrTail: _stderr, ...meta } = getAgentJob(repoRoot, entry.runId);
      if (meta.status === 'succeeded' && meta.executionMode === 'worktree' && !meta.integratedSessionId) return [meta];
      return [];
    } catch (_error) { return []; }
  });
}

export function listAgentJobs(repoRoot: string, limit = 50): AgentJobMeta[] {
  const boundedLimit = Math.min(Math.max(limit, 1), 5000);
  const recentIndex = readRunIndex(repoRoot, 'recent');
  if (recentIndex.runs.length > 0) {
    return recentIndex.runs.slice(0, boundedLimit).flatMap((entry) => {
      const meta = readRawAgentMeta(repoRoot, entry.runId);
      return meta ? [meta] : [];
    });
  }

  // Backward-compatible one-time scan for repositories created before run indexes.
  const legacy = scanLegacyJobMeta(repoRoot, boundedLimit);
  for (const meta of legacy) updateRunIndexes(repoRoot, meta);
  return legacy;
}

export function listActiveAgentJobSnapshots(repoRoot: string, limit = 50): AgentJobMeta[] {
  const boundedLimit = Math.min(Math.max(limit, 1), 500);
  return readRunIndex(repoRoot, 'active').runs.slice(0, boundedLimit).flatMap((entry) => {
    const meta = readRawAgentMeta(repoRoot, entry.runId);
    return meta ? [meta] : [];
  });
}

export function getAgentJobEvents(
  repoRoot: string,
  runId: string,
  limit = 200,
  options: {
    sinceIndex?: number;
    includeHeartbeats?: boolean;
  } = {},
): AgentJobEvent[] {
  getAgentJob(repoRoot, runId);
  const path = eventPath(repoRoot, runId);
  if (!existsSync(path)) return [];
  const events = readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => readJsonLine<AgentJobEvent>(line))
    .map((event, index) => ({ ...event, data: { ...(event.data ?? {}), eventIndex: index } }))
    .filter((event) => options.sinceIndex === undefined || Number(event.data?.eventIndex) > options.sinceIndex);

  const filtered = options.includeHeartbeats === true
    ? events
    : events.filter((event, index, list) => {
      if (!["run_heartbeat", "log_updated"].includes(event.type)) return true;
      for (let cursor = index + 1; cursor < list.length; cursor += 1) {
        if (["run_heartbeat", "log_updated"].includes(list[cursor].type)) continue;
        return false;
      }
      return true;
    });

  return filtered.slice(-Math.min(Math.max(limit, 1), 1000));
}

function readJsonLine<T>(line: string): T {
  return JSON.parse(line) as T;
}

export function getAgentJobLog(
  repoRoot: string,
  runId: string,
  follow = false,
  maxBytes = 256 * 1024,
): {
  runId: string;
  provider: string;
  log: string;
  url?: string;
  pullRequestUrl?: string;
} {
  const run = getAgentJob(repoRoot, runId);
  if (run.provider === "github" && run.github) {
    const log = getGitHubAgentSessionLog(
      repoRoot,
      run.github.owner,
      run.github.repo,
      run.github.taskId,
      follow,
    );
    return {
      runId,
      provider: "github",
      log,
      url: run.github.url,
      pullRequestUrl: run.github.pullRequestUrl,
    };
  }
  const readLog = (relativePath: string): string => {
    const absolute = join(repoRoot, relativePath);
    if (!existsSync(absolute)) return "";
    const bounded = Math.max(4 * 1024, Math.min(maxBytes, 1024 * 1024));
    return readFileSync(absolute, "utf-8").slice(-bounded);
  };
  return {
    runId,
    provider: "local",
    log: [readLog(run.stdoutPath), readLog(run.stderrPath)]
      .filter(Boolean)
      .join("\n"),
  };
}

export function dispatchAcceptedTaskJob(
  repoRoot: string,
  runId: string,
): void {
  try {
    withRunLaunchLock(repoRoot, () => {
      const meta = getAgentJob(repoRoot, runId);
      if (!["starting", "queued"].includes(meta.status)) return;
      if (meta.launchPid && isAlive(meta.launchPid)) return;
      const launcher = spawn(process.execPath, [fileURLToPath(new URL("./job-manager.ts", import.meta.url)), "launch", repoRoot, runId], {
        cwd: repoRoot,
        detached: true,
        stdio: "ignore",
      });
      launcher.unref();
      const current = readJson<AgentJobMeta>(metaPath(repoRoot, runId));
      current.launchPid = launcher.pid;
      writeAgentMeta(repoRoot, metaPath(repoRoot, runId), current);
    });
  } catch (error) {
    failAcceptedTaskJob(repoRoot, runId, error);
  }
}

export function cancelAgentJob(repoRoot: string, runId: string): AgentJobMeta {
  const current = getAgentJob(repoRoot, runId);
  if (current.provider === "github")
    throw new Error(
      "GitHub cloud sessions must currently be cancelled from the GitHub Agents UI; the public agent-task API does not expose a stable cancellation contract here.",
    );
  if (current.status === "cancelled") {
    if (current.cleanupPending) requestCancellationCleanup(repoRoot, runId);
    return current;
  }
  if (!["queued", "starting", "running", "unknown", "waiting_for_user"].includes(current.status))
    return current;

  const { stdoutTail: _stdout, stderrTail: _stderr, ...meta } = current;
  const requestedAt = new Date().toISOString();
  meta.status = "cancelled";
  meta.terminationReason = "cancelled";
  meta.cancellationRequestedAt = requestedAt;
  meta.cancellationPids = cancellationProcessIds(current);
  meta.cleanupPending = true;
  meta.cleanupStartedAt = undefined;
  meta.cleanupFinishedAt = undefined;
  meta.cleanupError = undefined;
  meta.agentPid = undefined;
  meta.workerPid = undefined;
  meta.launchPid = undefined;
  meta.finishedAt = requestedAt;
  meta.lastHeartbeatAt = requestedAt;
  meta.progress = {
    phase: "finalizing",
    percent: 100,
    currentActivity: "Cancellation persisted; process cleanup continues independently.",
    lastActivityAt: requestedAt,
    activityCount: (meta.progress?.activityCount ?? 0) + 1,
  };
  writeAgentMeta(repoRoot, metaPath(repoRoot, runId), meta);
  appendAgentJobEvent(repoRoot, runId, {
    type: "run_cancelled",
    message: "Local Run cancellation persisted; process cleanup scheduled.",
    data: { cleanupPending: true, processCount: meta.cancellationPids.length },
  });
  requestCancellationCleanup(repoRoot, runId);
  return meta;
}

export function retryAgentJob(
  repoRoot: string,
  runId: string,
  options: { timeoutMs?: number; isolate?: boolean; supervisorInstructions?: string; executorPolicy?: LocalExecutorPolicy } = {},
): AgentJobMeta {
  const previous = getAgentJob(repoRoot, runId);
  if (
    !["failed", "cancelled", "unknown", "waiting_for_user"].includes(
      previous.status,
    )
  ) {
    throw new Error(`run status is not retryable: ${previous.status}`);
  }
  const issue = getIssue(repoRoot, previous.issueId);
  const task = issue.tasks.find((entry) => entry.id === previous.taskId);
  if (!task) throw new Error(`task not found: ${previous.issueId}/${previous.taskId}`);
  const state = resolveEffectiveTaskState({ issue, task, runs: readTaskRunEvidence(repoRoot, task) });
  if (state.terminal || state.inactive || (task.supersededBy?.length ?? 0) > 0) {
    throw new Error(`Task cannot be retried from effective state ${state.effectiveStatus}`);
  }
  if (state.activeRunIds.length > 0) {
    throw new Error(`Task still has active Run evidence ${state.activeRunIds.join(", ")}; cancel or resolve it before retry`);
  }
  if (state.latestRunId !== previous.runId) {
    throw new Error(`Run ${previous.runId} is historical evidence and is not the current retry source`);
  }
  updateTask(repoRoot, previous.issueId, previous.taskId, {
    status: "ready",
    transition: "retry",
    note: `Explicit retry requested from ${previous.runId}.`,
  });
  const timeoutMs = normalizeAgentTimeoutMs(options.timeoutMs, {
    defaultMs: Math.max(previous.timeoutMs ?? 0, DEFAULT_AGENT_TIMEOUT_MS),
    maxMs: MAX_AGENT_TIMEOUT_MS,
  });
  return startTaskJob({
    repoRoot,
    issueId: previous.issueId,
    taskId: previous.taskId,
    agent: previous.agent,
    timeoutMs,
    retryFromRunId: previous.runId,
    supervisorInstructions: options.supervisorInstructions,
    approveRisk: true,
    approveDestructive: previous.status === "cancelled" ? false : undefined,
    executorPolicy: options.executorPolicy,
    isolate: options.isolate,
    githubRepo: previous.github
      ? `${previous.github.owner}/${previous.github.repo}`
      : undefined,
    baseRef: previous.github?.baseRef,
    model: previous.github?.model,
    createPullRequest: previous.github?.createPullRequest,
  });
}


export function markAgentJobReviewedCompletion(
  repoRoot: string,
  runId: string,
  options: {
    changeOutcome?: AgentJobMeta["changeOutcome"];
    changedFiles?: string[];
    worktreeCleaned?: boolean;
  } = {},
): AgentJobMeta {
  const current = getAgentJob(repoRoot, runId);
  if (current.provider !== "local") return current;
  const { stdoutTail: _stdout, stderrTail: _stderr, ...meta } = current;
  const completedAt = new Date().toISOString();
  meta.status = "succeeded";
  meta.finishedAt = meta.finishedAt ?? completedAt;
  meta.lastHeartbeatAt = completedAt;
  if (options.changeOutcome) meta.changeOutcome = options.changeOutcome;
  if (options.changedFiles) meta.changedFiles = options.changedFiles;
  if (options.worktreeCleaned) meta.worktreeCleanedAt = meta.worktreeCleanedAt ?? completedAt;
  meta.progress = {
    phase: "completed",
    percent: 100,
    currentActivity: "Run review, integration, and completion orchestration finished",
    lastActivityAt: completedAt,
    activityCount: (meta.progress?.activityCount ?? 0) + 1,
  };
  delete meta.autoIntegrationError;
  writeAgentMeta(repoRoot, metaPath(repoRoot, runId), meta);
  appendAgentJobEvent(repoRoot, runId, {
    type: "run_succeeded",
    message: "Run completion was finalized by the completion orchestrator.",
    data: { changeOutcome: meta.changeOutcome, changedFiles: meta.changedFiles, worktreeCleanedAt: meta.worktreeCleanedAt },
  });
  return meta;
}

export function markAgentJobIntegrated(
  repoRoot: string,
  runId: string,
  sessionId: string,
): AgentJobMeta {
  const current = getAgentJob(repoRoot, runId);
  if (current.provider !== "local")
    throw new Error(
      "GitHub cloud session changes are reviewed and merged through their pull request, not local edit-session integration.",
    );
  const { stdoutTail: _stdout, stderrTail: _stderr, ...meta } = current;
  meta.integratedSessionId = sessionId;
  meta.integratedAt = new Date().toISOString();
  writeAgentMeta(repoRoot, metaPath(repoRoot, runId), meta);
  appendAgentJobEvent(repoRoot, runId, {
    type: "run_integrated",
    message: `Integrated through edit session ${sessionId}.`,
  });
  return meta;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  const repoRoot = process.argv[3];
  const runId = process.argv[4];
  if ((command === "launch" || command === "cancel-cleanup") && (!repoRoot || !runId)) process.exit(1);

  if (command === "cancel-cleanup" && repoRoot && runId) {
    try {
      completeAgentJobCancellation(repoRoot, runId);
      process.exit(0);
    } catch (_error) {
      process.exit(1);
    }
  }

  if (command === "launch" && repoRoot && runId) {
    void (async () => {
      try {
        startAcceptedTaskJob(repoRoot, runId);
        while (true) {
          const current = getAgentJob(repoRoot, runId);
          if (
            !["queued", "starting", "running"].includes(current.status) ||
            !isAlive(current.workerPid)
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        process.exit(0);
      } catch (error) {
        try {
          failAcceptedTaskJob(repoRoot, runId, error);
        } catch (_nested) {
          /* Best effort launcher failure persistence. */
        }
        process.exit(1);
      }
    })();
  }
}
