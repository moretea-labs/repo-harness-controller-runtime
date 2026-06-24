import { createHash, randomBytes } from "crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { cancelAgentJob, getAgentJob, startTaskJob } from "../agent-jobs/job-manager";
import { createIssue, getIssue, removeEphemeralIssue } from "../controller/issue-store";
import { runControllerCheckAsync } from "../controller/check-runner";
import { runProcess } from "../../effects/process-runner";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_AGENT_TIMEOUT_MS,
  normalizeAgentTimeoutMs,
} from "../controller/runtime-config";
import { loadMcpLocalConfig } from "../mcp/auth";
import type { ControllerAgent, ControllerTask } from "../controller/types";
import { taskExecutionPolicy } from "../controller/execution-policy";
import { tryAppendControllerWorklogEvent } from "../controller/worklog";
import type {
  LaunchTaskPayload,
  LocalBridgeApproval,
  LocalBridgeConfig,
  LocalBridgeJob,
  LocalBridgeJobAction,
  LocalBridgeJobEvent,
  LocalBridgeJobRequest,
  QuickAgentSessionPayload,
  RunCheckPayload,
} from "./types";

const JOB_ROOT = ".ai/harness/local-jobs";
const CONFIG_PATH = ".repo-harness/local-bridge.json";

function now(): string {
  return new Date().toISOString();
}

function shortId(): string {
  return randomBytes(4).toString("hex");
}

function jobDir(repoRoot: string, jobId: string): string {
  return join(repoRoot, JOB_ROOT, jobId);
}

function metaPath(repoRoot: string, jobId: string): string {
  return join(jobDir(repoRoot, jobId), "job.json");
}

function eventsPath(repoRoot: string, jobId: string): string {
  return join(jobDir(repoRoot, jobId), "events.jsonl");
}

function storedJobPaths(repoRoot: string, limit = 500): string[] {
  const root = join(repoRoot, JOB_ROOT);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "job.json")))
    .map((entry) => join(root, entry.name, "job.json"))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, Math.max(1, Math.min(limit, 5000)));
}

function readStoredJobs(repoRoot: string, limit = 500): LocalBridgeJob[] {
  return storedJobPaths(repoRoot, limit).flatMap((path) => {
    try {
      return [readJson<LocalBridgeJob>(path)];
    } catch (_error) {
      return [];
    }
  });
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function signalWorker(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (_error) {
      // Fall through to direct child signaling.
    }
  }
  try {
    process.kill(pid, signal);
  } catch (_error) {
    // The process may already be gone.
  }
}

function currentCheckRevision(repoRoot: string): string {
  const head = runProcess("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024,
  });
  const status = runProcess("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: repoRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 128 * 1024,
  });
  return createHash("sha256")
    .update(`${head.ok ? head.stdout.trim() : "unknown"}\n${status.ok ? status.stdout : "unknown"}`)
    .digest("hex")
    .slice(0, 24);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map((entry) => String(entry).trim()).filter(Boolean)),
  );
}

function appendEvent(
  repoRoot: string,
  jobId: string,
  event: Omit<LocalBridgeJobEvent, "at">,
): void {
  const path = eventsPath(repoRoot, jobId);
  mkdirSync(dirname(path), { recursive: true });
  const at = now();
  appendFileSync(path, `${JSON.stringify({ ...event, at })}\n`, "utf-8");
  let job: LocalBridgeJob | undefined;
  try {
    const stored = metaPath(repoRoot, jobId);
    if (existsSync(stored)) job = readJson<LocalBridgeJob>(stored);
  } catch (_error) {
    job = undefined;
  }
  tryAppendControllerWorklogEvent(repoRoot, {
    at,
    category: "local_job",
    action: event.type,
    summary: event.message || event.type,
    actor: job?.requestedBy || "local-controller",
    issueId: job?.issueId,
    taskId: job?.taskId,
    runId: job?.runId,
    jobId,
    details: event.data,
  });
}

export function loadLocalBridgeConfig(repoRoot: string): LocalBridgeConfig {
  const path = join(repoRoot, CONFIG_PATH);
  if (!existsSync(path)) return { version: 1 };
  try {
    const parsed = readJson<LocalBridgeConfig>(path);
    return { ...parsed, version: 1 };
  } catch (_error) {
    return { version: 1 };
  }
}

export function localBridgeTimeoutPolicy(repoRoot: string): {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
} {
  const local = loadLocalBridgeConfig(repoRoot);
  const mcp = loadMcpLocalConfig(repoRoot);
  const maxTimeoutMs = normalizeAgentTimeoutMs(
    local.maxTimeoutMs ?? mcp?.devMode?.maxTimeoutMs,
    {
      defaultMs: MAX_AGENT_TIMEOUT_MS,
      maxMs: MAX_AGENT_TIMEOUT_MS,
      label: "local bridge max timeout",
    },
  );
  const defaultTimeoutMs = normalizeAgentTimeoutMs(
    local.defaultTimeoutMs ?? mcp?.devMode?.timeoutMs,
    {
      defaultMs: DEFAULT_AGENT_TIMEOUT_MS,
      maxMs: maxTimeoutMs,
      label: "local bridge default timeout",
    },
  );
  return { defaultTimeoutMs, maxTimeoutMs };
}

function resolvedJobTimeout(repoRoot: string, value: unknown): number {
  const policy = localBridgeTimeoutPolicy(repoRoot);
  return normalizeAgentTimeoutMs(value, {
    defaultMs: policy.defaultTimeoutMs,
    maxMs: policy.maxTimeoutMs,
  });
}

function taskApproval(task: ControllerTask): LocalBridgeApproval {
  return taskExecutionPolicy(task).approval;
}

function executionApproval(
  repoRoot: string,
  action: LocalBridgeJobAction,
  payload: LocalBridgeJobRequest["payload"],
): LocalBridgeApproval {
  if (action === "run-check") return "auto";
  if (action === "launch-task") {
    const input = payload as LaunchTaskPayload;
    const issue = getIssue(repoRoot, input.issueId);
    const task = issue.tasks.find((entry) => entry.id === input.taskId);
    if (!task)
      throw new Error(`task not found: ${input.issueId}/${input.taskId}`);
    return taskApproval(task);
  }
  const input = payload as QuickAgentSessionPayload;
  const synthetic: ControllerTask = {
    id: "QUICK",
    title: input.title || "Quick Agent",
    objective: input.objective || "Execute a quick agent session.",
    status: "ready",
    dependsOn: [],
    allowedPaths: normalizeStringList(input.allowedPaths),
    forbiddenPaths: normalizeStringList(input.forbiddenPaths),
    checks: normalizeStringList(input.checks),
    acceptanceCriteria: normalizeStringList(input.acceptanceCriteria),
    risk: input.risk ?? "low",
    recommendedAgent: input.agent,
    notes: [],
    runIds: [],
    createdAt: now(),
    updatedAt: now(),
  };
  return taskApproval(synthetic);
}

export function submitLocalBridgeJob(
  repoRoot: string,
  request: LocalBridgeJobRequest,
): LocalBridgeJob {
  if (
    !["launch-task", "quick-agent-session", "run-check"].includes(
      request.action,
    )
  ) {
    throw new Error(
      `unsupported local bridge action: ${String(request.action)}`,
    );
  }
  let revision: string | undefined;
  if (request.action === "run-check") {
    const payload = request.payload as RunCheckPayload;
    revision = currentCheckRevision(repoRoot);
    const duplicate = readStoredJobs(repoRoot, 250)
      .map((entry) => refreshLocalBridgeJob(repoRoot, entry))
      .find((entry) =>
        entry.action === "run-check" &&
        ["approved", "running", "succeeded"].includes(entry.status) &&
        (entry.payload as RunCheckPayload).checkId === payload.checkId &&
        entry.revision === revision
      );
    if (duplicate) return duplicate;
  }
  const policyApproval = executionApproval(
    repoRoot,
    request.action,
    request.payload,
  );
  // V8 has no approval queue. Risk is metadata; only destructive work needs
  // an explicit authorization flag in the same request.
  const destructiveAuthorized = request.action === "launch-task"
    ? Boolean((request.payload as LaunchTaskPayload).approveDestructive)
    : request.action === "quick-agent-session"
      ? Boolean((request.payload as QuickAgentSessionPayload).approveDestructive)
      : true;
  if (policyApproval === "manual-only" && !destructiveAuthorized) {
    throw new Error("destructive execution requires approve_destructive in the same request");
  }
  const approval: LocalBridgeApproval = "auto";
  const createdAt = now();
  const job: LocalBridgeJob = {
    schemaVersion: 1,
    jobId: `JOB-${Date.now()}-${shortId()}`,
    action: request.action,
    payload: request.payload,
    requestedBy: request.requestedBy?.trim() || "local-user",
    approval,
    status: "approved",
    createdAt,
    updatedAt: createdAt,
    ...(revision ? { revision } : {}),
    ...(request.action === "quick-agent-session" && (request.payload as QuickAgentSessionPayload).ephemeral !== false ? { ephemeral: true } : {}),
    approvedAt: createdAt,
  };
  writeJson(metaPath(repoRoot, job.jobId), job);
  appendEvent(repoRoot, job.jobId, {
    type: "job_created",
    message: `${job.action} job created with ${approval} approval.`,
  });
  appendEvent(repoRoot, job.jobId, {
    type: "job_approved",
    message: "Accepted for immediate local execution; no approval queue is used.",
  });
  return job;
}

function readLocalBridgeJob(repoRoot: string, jobId: string): LocalBridgeJob {
  const path = metaPath(repoRoot, jobId);
  if (!existsSync(path)) throw new Error(`local bridge job not found: ${jobId}`);
  return readJson<LocalBridgeJob>(path);
}

function cleanupEphemeralJob(repoRoot: string, job: LocalBridgeJob): void {
  if (!job.ephemeral || !job.issueId || job.cleanupAt) return;
  try {
    removeEphemeralIssue(repoRoot, job.issueId);
  } catch (_error) {
    // Cleanup is best-effort and idempotent; Run evidence remains durable.
  }
  job.cleanupAt = now();
  appendEvent(repoRoot, job.jobId, {
    type: "job_cleaned",
    message: `Ephemeral Quick Agent metadata for ${job.issueId} was cleaned.`,
  });
}

function refreshLocalBridgeJob(repoRoot: string, job: LocalBridgeJob): LocalBridgeJob {
  if (job.action === "run-check" && job.status === "running") {
    const startedAt = Date.parse(job.startedAt ?? job.updatedAt);
    const configuredTimeout = resolvedJobTimeout(repoRoot, (job.payload as RunCheckPayload).timeoutMs);
    const deadlineAt = job.deadlineAt ? Date.parse(job.deadlineAt) : startedAt + configuredTimeout + 30_000;
    const timedOut = Number.isFinite(deadlineAt) && deadlineAt <= Date.now();
    const ownerOrphaned = job.ownerPid !== undefined && job.ownerPid !== process.pid && !isPidAlive(job.ownerPid);
    const legacyOrphaned = job.ownerPid === undefined && Number.isFinite(startedAt) && startedAt + configuredTimeout + 30_000 <= Date.now();
    const revisionChanged = job.revision !== undefined && job.revision !== currentCheckRevision(repoRoot);
    if (timedOut || ownerOrphaned || legacyOrphaned || revisionChanged) {
      job.status = timedOut || legacyOrphaned
        ? "timed_out"
        : revisionChanged
          ? "stale"
          : "orphaned";
      job.finishedAt = now();
      job.error = timedOut || legacyOrphaned
        ? `Check ${(job.payload as RunCheckPayload).checkId} exceeded its persisted execution deadline.`
        : revisionChanged
          ? `Check ${(job.payload as RunCheckPayload).checkId} became stale after the repository revision changed.`
        : `Check ${(job.payload as RunCheckPayload).checkId} was orphaned when Controller process ${String(job.ownerPid)} exited.`;
      signalWorker(job.workerPid, "SIGTERM");
      appendEvent(repoRoot, job.jobId, {
        type: "job_failed",
        message: job.error,
        data: {
          timedOut: timedOut || legacyOrphaned,
          orphaned: ownerOrphaned,
          stale: revisionChanged,
        },
      });
      return saveJob(repoRoot, job);
    }
    return job;
  }
  if (!job.runId || !["dispatched", "running"].includes(job.status)) return job;
  try {
    const run = getAgentJob(repoRoot, job.runId);
    const previous = job.status;
    if (["queued", "running", "waiting_for_user"].includes(run.status)) {
      job.status = run.status === "queued" ? "dispatched" : "running";
      delete job.finishedAt;
    } else {
      job.status = run.status === "succeeded"
        ? "succeeded"
        : run.status === "cancelled"
          ? "cancelled"
          : "failed";
      job.finishedAt = run.finishedAt ?? now();
      job.error = run.status === "succeeded" ? undefined : run.error ?? `Run ended as ${run.status}`;
      job.result = {
        ...(job.result ?? {}),
        runId: run.runId,
        runStatus: run.status,
        exitCode: run.exitCode,
        integratedSessionId: run.integratedSessionId,
      };
      cleanupEphemeralJob(repoRoot, job);
    }
    if (previous !== job.status) {
      appendEvent(repoRoot, job.jobId, {
        type: job.status === "succeeded" ? "job_succeeded" : job.status === "cancelled" ? "job_cancelled" : job.status === "failed" ? "job_failed" : "job_started",
        message: `Linked Run ${run.runId} moved Local Job to ${job.status}.`,
        data: { runStatus: run.status },
      });
    }
    return saveJob(repoRoot, job);
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.finishedAt = now();
    cleanupEphemeralJob(repoRoot, job);
    return saveJob(repoRoot, job);
  }
}

export function getLocalBridgeJob(repoRoot: string, jobId: string): LocalBridgeJob {
  return refreshLocalBridgeJob(repoRoot, readLocalBridgeJob(repoRoot, jobId));
}

export function listLocalBridgeJobs(repoRoot: string, limit = 100): LocalBridgeJob[] {
  const boundedLimit = Math.max(1, Math.min(limit, 500));
  return readStoredJobs(repoRoot, boundedLimit)
    .map((entry) => refreshLocalBridgeJob(repoRoot, entry))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function reconcileLocalBridgeJobs(repoRoot: string): {
  scanned: number;
  active: number;
  terminalized: number;
} {
  const jobs = readStoredJobs(repoRoot, 5000);
  let active = 0;
  let terminalized = 0;
  for (const job of jobs) {
    if (!["approved", "running", "dispatched"].includes(job.status)) continue;
    active += 1;
    const previous = job.status;
    const refreshed = refreshLocalBridgeJob(repoRoot, job);
    if (previous !== refreshed.status && ["succeeded", "failed", "timed_out", "orphaned", "stale", "cancelled"].includes(refreshed.status)) terminalized += 1;
  }
  return { scanned: jobs.length, active, terminalized };
}
export function getLocalBridgeJobEvents(
  repoRoot: string,
  jobId: string,
): LocalBridgeJobEvent[] {
  getLocalBridgeJob(repoRoot, jobId);
  const path = eventsPath(repoRoot, jobId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LocalBridgeJobEvent);
}

function saveJob(repoRoot: string, job: LocalBridgeJob): LocalBridgeJob {
  job.updatedAt = now();
  writeJson(metaPath(repoRoot, job.jobId), job);
  return job;
}

export function cancelLocalBridgeJob(
  repoRoot: string,
  jobId: string,
): LocalBridgeJob {
  const job = getLocalBridgeJob(repoRoot, jobId);
  if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
  if (job.runId) {
    try { cancelAgentJob(repoRoot, job.runId); } catch (_error) { /* remote sessions may require provider UI */ }
  }
  if (job.workerPid) signalWorker(job.workerPid, "SIGTERM");
  job.status = "cancelled";
  job.finishedAt = now();
  cleanupEphemeralJob(repoRoot, job);
  appendEvent(repoRoot, job.jobId, {
    type: "job_cancelled",
    message: job.runId ? `Cancelled linked Run ${job.runId}.` : "Cancelled before execution.",
  });
  return saveJob(repoRoot, job);
}

function resolveExecutionAgent(
  repoRoot: string,
  value: ControllerAgent | undefined,
): ControllerAgent {
  if (value) return value;
  const configured = loadMcpLocalConfig(repoRoot)?.devMode?.allowedAgents ?? [];
  const local = configured.find((entry) => entry === "codex" || entry === "claude");
  if (local === "codex" || local === "claude") return local;
  throw new Error("no local Agent is configured; select an Agent explicitly or enable one in MCP settings");
}

function resolvedIsolation(payload: {
  executionMode?: "auto" | "workspace" | "worktree";
  isolate?: boolean;
}): boolean | undefined {
  if (payload.executionMode === "worktree") return true;
  if (payload.executionMode === "workspace") return false;
  if (payload.executionMode === "auto") return undefined;
  return payload.isolate;
}

function executeLaunchTask(
  repoRoot: string,
  job: LocalBridgeJob,
  payload: LaunchTaskPayload,
): void {
  const run = startTaskJob({
    repoRoot,
    issueId: payload.issueId,
    taskId: payload.taskId,
    agent: resolveExecutionAgent(repoRoot, payload.agent),
    timeoutMs: resolvedJobTimeout(repoRoot, payload.timeoutMs),
    isolate: resolvedIsolation(payload),
    githubRepo: payload.githubRepo,
    baseRef: payload.baseRef,
    model: payload.model,
    createPullRequest: payload.createPullRequest,
    approveDestructive: payload.approveDestructive === true,
  });
  job.runId = run.runId;
  job.issueId = payload.issueId;
  job.taskId = payload.taskId;
  job.status = "dispatched";
  delete job.finishedAt;
  job.result = {
    runId: run.runId,
    provider: run.provider,
    status: run.status,
    worktree: run.worktree,
    github: run.github,
  };
  appendEvent(repoRoot, job.jobId, {
    type: "job_dispatched",
    message: `Task dispatched as ${run.runId}.`,
    data: { runId: run.runId },
  });
}

function executeQuickSession(
  repoRoot: string,
  job: LocalBridgeJob,
  payload: QuickAgentSessionPayload,
): void {
  const title = payload.title?.trim();
  const objective = payload.objective?.trim();
  if (!title || !objective)
    throw new Error("quick-agent-session requires title and objective");
  const acceptance = normalizeStringList(payload.acceptanceCriteria);
  const issue = createIssue(repoRoot, {
    title,
    kind: "investigation",
    allowWhileFocused: true,
    ephemeral: payload.ephemeral !== false,
    ephemeralOwnerJobId: job.jobId,
    summary: payload.summary?.trim() || objective,
    goals: [objective],
    nonGoals: [
      "Do not make unrelated changes outside the declared Task scope.",
    ],
    acceptanceCriteria: acceptance.length
      ? acceptance
      : [`Complete: ${objective}`],
    tasks: [
      {
        title,
        objective,
        allowedPaths: normalizeStringList(payload.allowedPaths),
        forbiddenPaths: normalizeStringList(payload.forbiddenPaths),
        checks: normalizeStringList(payload.checks),
        acceptanceCriteria: acceptance.length
          ? acceptance
          : [`Complete: ${objective}`],
        risk: payload.risk ?? "low",
        recommendedAgent: payload.agent,
      },
    ],
  });
  const task = issue.tasks[0];
  if (!task) throw new Error("quick session issue was created without a Task");
  const run = startTaskJob({
    repoRoot,
    issueId: issue.id,
    taskId: task.id,
    agent: resolveExecutionAgent(repoRoot, payload.agent),
    timeoutMs: resolvedJobTimeout(repoRoot, payload.timeoutMs),
    isolate: resolvedIsolation(payload),
    approveDestructive: payload.approveDestructive === true,
  });
  job.runId = run.runId;
  job.issueId = issue.id;
  job.taskId = task.id;
  job.status = "dispatched";
  delete job.finishedAt;
  job.result = {
    issueId: issue.id,
    taskId: task.id,
    runId: run.runId,
    provider: run.provider,
    worktree: run.worktree,
  };
  appendEvent(repoRoot, job.jobId, {
    type: "job_dispatched",
    message: `Quick session dispatched as ${run.runId}.`,
    data: { issueId: issue.id, taskId: task.id, runId: run.runId },
  });
}

async function executeRunCheck(
  repoRoot: string,
  jobId: string,
  payload: RunCheckPayload,
): Promise<void> {
  let job = readLocalBridgeJob(repoRoot, jobId);
  if (job.status !== "running") return;
  job.ownerPid = process.pid;
  saveJob(repoRoot, job);
  try {
    const timeoutMs = resolvedJobTimeout(repoRoot, payload.timeoutMs);
    const result = await runControllerCheckAsync(repoRoot, payload.checkId, {
      requestedTimeoutMs: timeoutMs,
      onSpawn: (pid) => {
        const current = readLocalBridgeJob(repoRoot, jobId);
        if (current.status !== "running") {
          signalWorker(pid, "SIGTERM");
          return;
        }
        current.workerPid = pid;
        current.ownerPid = process.pid;
        current.deadlineAt = new Date(Date.now() + timeoutMs + 5_000).toISOString();
        saveJob(repoRoot, current);
      },
    });
    job = readLocalBridgeJob(repoRoot, jobId);
    if (job.status !== "running") return;
    job.status = result.ok ? "succeeded" : "failed";
    job.finishedAt = now();
    job.result = result as unknown as Record<string, unknown>;
    job.workerPid = undefined;
    if (!result.ok) job.error = result.stderr || `check failed: ${payload.checkId}`;
    appendEvent(repoRoot, job.jobId, {
      type: result.ok ? "job_succeeded" : "job_failed",
      message: result.ok
        ? `Check ${payload.checkId} passed.`
        : `Check ${payload.checkId} failed.`,
      data: { timedOut: result.timedOut, artifactPath: result.artifactPath },
    });
    saveJob(repoRoot, job);
  } catch (error) {
    job = readLocalBridgeJob(repoRoot, jobId);
    if (job.status !== "running") return;
    job.status = "failed";
    job.finishedAt = now();
    job.workerPid = undefined;
    job.error = error instanceof Error ? error.message : String(error);
    appendEvent(repoRoot, job.jobId, {
      type: "job_failed",
      message: job.error,
    });
    saveJob(repoRoot, job);
  }
}

export function executeLocalBridgeJob(
  repoRoot: string,
  jobId: string,
): LocalBridgeJob {
  const job = getLocalBridgeJob(repoRoot, jobId);
  if (job.status === "pending_approval")
    throw new Error("legacy pending-approval jobs cannot execute in V8; cancel and resubmit the work");
  if (job.approval === "manual-only" && !job.approvedAt)
    throw new Error("legacy manual-only jobs cannot execute in V8; cancel and resubmit with same-request destructive authorization");
  if (!["approved"].includes(job.status)) return job;
  job.status = "running";
  job.startedAt = now();
  saveJob(repoRoot, job);
  appendEvent(repoRoot, job.jobId, {
    type: "job_started",
    message: `${job.action} execution started.`,
  });
  try {
    if (job.action === "launch-task")
      executeLaunchTask(repoRoot, job, job.payload as LaunchTaskPayload);
    else if (job.action === "quick-agent-session")
      executeQuickSession(
        repoRoot,
        job,
        job.payload as QuickAgentSessionPayload,
      );
    else void executeRunCheck(repoRoot, job.jobId, job.payload as RunCheckPayload);
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.finishedAt = now();
    cleanupEphemeralJob(repoRoot, job);
    appendEvent(repoRoot, job.jobId, {
      type: "job_failed",
      message: job.error,
    });
  }
  return job.action === "run-check"
    ? getLocalBridgeJob(repoRoot, job.jobId)
    : saveJob(repoRoot, job);
}
