import { randomBytes } from "crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
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
import { getIssue, updateTask } from "../controller/issue-store";
import type { ControllerAgent, ControllerTask } from "../controller/types";
import { tryAppendControllerWorklogEvent } from "../controller/worklog";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_AGENT_TIMEOUT_MS,
  normalizeAgentTimeoutMs,
} from "../controller/runtime-config";
import type {
  AgentExecutionMode,
  AgentJobEvent,
  AgentJobMeta,
  AgentJobStatus,
  AgentJobWorkerConfig,
} from "./types";

const JOB_ROOT = ".ai/harness/jobs";

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

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
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

function activeLocalRuns(repoRoot: string): AgentJobMeta[] {
  const root = join(repoRoot, JOB_ROOT);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(root, entry.name, "meta.json")),
    )
    .map((entry) => {
      try {
        return readJson<AgentJobMeta>(join(root, entry.name, "meta.json"));
      } catch (_error) {
        return undefined;
      }
    })
    .filter((entry): entry is AgentJobMeta => Boolean(entry))
    .filter(
      (entry) =>
        entry.provider === "local" &&
        ["queued", "running"].includes(entry.status) &&
        (isAlive(entry.workerPid) || entry.status === "queued"),
    );
}

function resolveExecutionMode(
  repoRoot: string,
  provider: "local" | "github",
  isolate: boolean | undefined,
): AgentExecutionMode {
  if (provider === "github") return "github";
  if (isolate === true) return "worktree";
  if (isolate === false) {
    if (activeLocalRuns(repoRoot).length > 0)
      throw new Error(
        "cannot run directly in the current workspace while another local Task Run is active; use automatic or worktree isolation",
      );
    return "workspace";
  }
  return activeLocalRuns(repoRoot).length > 0 ? "worktree" : "workspace";
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
  const relativeWorktree = `.ai/harness/worktrees/${sanitize(issueId)}-${sanitize(task.id)}-${runId.slice(-8)}`;
  const absoluteWorktree = join(repoRoot, relativeWorktree);
  const branch = `controller/${sanitize(issueId)}-${sanitize(task.id)}-${runId.slice(-8)}`;
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
  return {
    schemaVersion: 2,
    runId,
    issueId: opts.issueId,
    taskId: opts.taskId,
    agent: opts.agent ?? task.recommendedAgent,
    provider,
    executionMode,
    status: "queued",
    repoRoot: opts.repoRoot,
    worktree: isolation.path,
    branch: isolation.branch,
    baseRevision: isolation.baseRevision,
    promptPath: relative(opts.repoRoot, paths.promptPath).replace(/\\/g, "/"),
    stdoutPath: relative(opts.repoRoot, paths.stdoutPath).replace(/\\/g, "/"),
    stderrPath: relative(opts.repoRoot, paths.stderrPath).replace(/\\/g, "/"),
    resultPath: relative(opts.repoRoot, paths.resultPath).replace(/\\/g, "/"),
    eventsPath: relative(opts.repoRoot, paths.eventsPath).replace(/\\/g, "/"),
    timeoutMs: opts.timeoutMs,
    autoIntegrate: executionMode === "worktree",
    progress: {
      phase: "queued",
      percent: 2,
      currentActivity: "等待本地 worker 启动",
      lastActivityAt: new Date().toISOString(),
      activityCount: 0,
    },
    createdAt: new Date().toISOString(),
  };
}

export function startTaskJob(opts: StartTaskJobOptions): AgentJobMeta {
  const timeoutMs = normalizeAgentTimeoutMs(opts.timeoutMs, {
    defaultMs: DEFAULT_AGENT_TIMEOUT_MS,
    maxMs: MAX_AGENT_TIMEOUT_MS,
  });
  opts = { ...opts, timeoutMs };
  const issue = getIssue(opts.repoRoot, opts.issueId);
  const task = issue.tasks.find((entry) => entry.id === opts.taskId);
  if (!task) throw new Error(`task not found: ${opts.issueId}/${opts.taskId}`);
  if (task.status !== "ready" && task.status !== "changes_requested")
    throw new Error(`task is not dispatchable from status ${task.status}`);
  const agent = opts.agent ?? task.recommendedAgent;
  const provider = agent === "github-copilot" ? "github" : "local";
  const runId = `RUN-${sanitize(opts.issueId)}-${sanitize(opts.taskId)}-${Date.now()}-${shortId()}`;
  let executionMode = resolveExecutionMode(
    opts.repoRoot,
    provider,
    opts.isolate,
  );
  const dir = jobDir(opts.repoRoot, runId);
  mkdirSync(dir, { recursive: true });
  const isolation =
    executionMode === "worktree"
      ? createWorktree(opts.repoRoot, opts.issueId, task, runId)
      : {
          path: opts.repoRoot,
          branch: null,
          baseRevision:
            provider === "local"
              ? runProcess("git", ["rev-parse", "HEAD"], {
                  cwd: opts.repoRoot,
                  timeoutMs: 10_000,
                  maxOutputBytes: 8 * 1024,
                }).stdout.trim() || null
              : null,
        };
  if (executionMode === "worktree" && isolation.path === opts.repoRoot)
    executionMode = "workspace";
  const paths = {
    promptPath: join(dir, "prompt.md"),
    stdoutPath: join(dir, "stdout.log"),
    stderrPath: join(dir, "stderr.log"),
    resultPath: join(dir, "result.json"),
    eventsPath: join(dir, "events.jsonl"),
  };
  const prompt = taskPrompt(
    issue.title,
    issue.summary,
    task,
    opts.repoRoot,
    isolation.path,
    provider,
    executionMode,
  );
  writeFileSync(paths.promptPath, prompt, "utf-8");
  writeFileSync(paths.stdoutPath, "", "utf-8");
  writeFileSync(paths.stderrPath, "", "utf-8");
  writeFileSync(paths.eventsPath, "", "utf-8");
  const meta = baseMeta(
    opts,
    task,
    runId,
    paths,
    isolation,
    provider,
    executionMode,
  );
  const absoluteMetaPath = metaPath(opts.repoRoot, runId);
  writeJson(absoluteMetaPath, meta);
  appendAgentJobEvent(opts.repoRoot, runId, {
    type: "run_created",
    message: `${agent} Run created in ${executionMode} mode.`,
    data: { executionMode, autoIntegrate: executionMode === "worktree" },
  });

  if (provider === "github") {
    try {
      const session = startGitHubAgentSession(opts.repoRoot, {
        prompt,
        repo:
          opts.githubRepo ??
          (issue.github
            ? `${issue.github.owner}/${issue.github.repo}`
            : undefined),
        baseRef: opts.baseRef,
        model: opts.model,
        createPullRequest: opts.createPullRequest,
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
        baseRef: opts.baseRef ?? session.repository.defaultBranch,
        model: opts.model,
        createPullRequest: opts.createPullRequest !== false,
        raw: session.raw,
      };
      writeFileSync(
        paths.stdoutPath,
        `${JSON.stringify(session.raw, null, 2)}\n`,
        "utf-8",
      );
      if (["succeeded", "failed", "cancelled"].includes(meta.status))
        meta.finishedAt = new Date().toISOString();
      writeJson(absoluteMetaPath, meta);
      appendAgentJobEvent(opts.repoRoot, runId, {
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
      updateTask(opts.repoRoot, issue.id, task.id, {
        status:
          meta.status === "succeeded"
            ? "review"
            : ["failed", "cancelled", "unknown"].includes(meta.status)
              ? "ready"
              : meta.status === "waiting_for_user"
                ? "blocked"
                : "running",
        runId,
        note: `Dispatched ${runId} to GitHub Copilot cloud session ${session.id}.`,
      });
      return meta;
    } catch (error) {
      meta.status = "failed";
      meta.error = error instanceof Error ? error.message : String(error);
      meta.finishedAt = new Date().toISOString();
      writeFileSync(paths.stderrPath, meta.error, "utf-8");
      writeJson(absoluteMetaPath, meta);
      appendAgentJobEvent(opts.repoRoot, runId, {
        type: "run_failed",
        message: meta.error,
      });
      updateTask(opts.repoRoot, issue.id, task.id, {
        status: "ready",
        runId,
        note: `${runId} failed to start and remains recorded as an attempt; Task returned to ready: ${meta.error}`,
      });
      return meta;
    }
  }

  const configPath = join(dir, "worker-config.json");
  const workerConfig: AgentJobWorkerConfig = {
    metaPath: absoluteMetaPath,
    agent: agent as Exclude<ControllerAgent, "github-copilot">,
    worktree: meta.worktree,
    promptPath: paths.promptPath,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    resultPath: paths.resultPath,
    eventsPath: paths.eventsPath,
    timeoutMs: opts.timeoutMs,
    autoIntegrate: executionMode === "worktree",
  };
  writeJson(configPath, workerConfig);
  const workerEntry = fileURLToPath(
    new URL("./job-worker.ts", import.meta.url),
  );
  const outFd = openSync(join(dir, "worker.log"), "a");
  const errFd = openSync(join(dir, "worker-error.log"), "a");
  const child = spawn(process.execPath, [workerEntry, configPath], {
    cwd: opts.repoRoot,
    detached: true,
    stdio: ["ignore", outFd, errFd],
  });
  closeSync(outFd);
  closeSync(errFd);
  child.unref();
  meta.workerPid = child.pid;
  meta.status = "running";
  meta.progress = {
    phase: "starting",
    percent: 5,
    currentActivity: `正在启动 ${agent}`,
    lastActivityAt: new Date().toISOString(),
    activityCount: 0,
  };
  meta.startedAt = new Date().toISOString();
  meta.deadlineAt = new Date(
    Date.parse(meta.startedAt) + timeoutMs,
  ).toISOString();
  meta.lastHeartbeatAt = meta.startedAt;
  writeJson(absoluteMetaPath, meta);
  appendAgentJobEvent(opts.repoRoot, runId, {
    type: "run_started",
    message: `Local ${agent} worker started in ${executionMode} mode.`,
    data: { executionMode, worktree: meta.worktree },
  });
  updateTask(opts.repoRoot, issue.id, task.id, {
    status: "running",
    runId,
    note: `Dispatched ${runId} to ${meta.agent}.`,
  });
  return meta;
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

function syncTaskStatus(repoRoot: string, meta: AgentJobMeta): void {
  try {
    const issue = getIssue(repoRoot, meta.issueId);
    const task = issue.tasks.find((entry) => entry.id === meta.taskId);
    const targetStatus =
      meta.status === "succeeded"
        ? "review"
        : ["failed", "unknown", "cancelled"].includes(meta.status)
          ? "ready"
          : meta.status === "waiting_for_user"
            ? "blocked"
            : undefined;
    const terminalReviewStates = [
      "integrated",
      "verifying",
      "verified",
      "done",
    ];
    const mayAdvanceToReview =
      task &&
      targetStatus === "review" &&
      !terminalReviewStates.includes(task.status);
    const mayMarkAttention =
      task &&
      targetStatus !== "review" &&
      !["verified", "done"].includes(task.status);
    if (
      task &&
      targetStatus &&
      task.status !== targetStatus &&
      (mayAdvanceToReview || mayMarkAttention)
    ) {
      updateTask(repoRoot, meta.issueId, meta.taskId, {
        status: targetStatus,
        note:
          targetStatus === "review"
            ? `${meta.runId} finished and is ready for review.`
            : targetStatus === "ready"
              ? `${meta.runId} ended as ${meta.status}; the attempt remains in history and the Task returned to ready.`
              : `${meta.runId} requires attention: ${meta.error ?? meta.status}`,
      });
    }
  } catch (_error) {
    // Keep Run inspection available even if Issue state was manually changed or removed.
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
  const meta = readJson<AgentJobMeta>(path);
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

  if (
    meta.provider === "github" &&
    meta.github &&
    ["queued", "running", "waiting_for_user", "unknown"].includes(meta.status)
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
      writeJson(path, meta);
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
      }
    } catch (error) {
      meta.error = error instanceof Error ? error.message : String(error);
      writeJson(path, meta);
    }
  } else if (meta.provider === "local") {
    const resultAbsolute = join(repoRoot, meta.resultPath);
    if (
      ["queued", "running"].includes(meta.status) &&
      existsSync(resultAbsolute)
    ) {
      const result = readJson<{
        ok: boolean;
        exitCode: number | null;
        error?: string;
        finishedAt: string;
      }>(resultAbsolute);
      const previous = meta.status;
      meta.status = result.ok ? "succeeded" : "failed";
      meta.exitCode = result.exitCode;
      meta.error = result.error;
      meta.finishedAt = result.finishedAt;
      writeJson(path, meta);
      if (previous !== meta.status)
        appendAgentJobEvent(repoRoot, runId, {
          type: result.ok ? "run_succeeded" : "run_failed",
          message: result.ok
            ? "Local worker finished."
            : (result.error ?? `exit ${result.exitCode}`),
        });
    } else if (meta.status === "running" && !isAlive(meta.workerPid)) {
      meta.status = "unknown";
      meta.error =
        meta.error ??
        "worker process is no longer running and no result file was produced";
      writeJson(path, meta);
    }
  }
  syncTaskStatus(repoRoot, meta);
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

export function listAgentJobs(repoRoot: string, limit = 50): AgentJobMeta[] {
  const root = join(repoRoot, JOB_ROOT);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(root, entry.name, "meta.json")),
    )
    .map((entry) => getAgentJob(repoRoot, entry.name))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.min(Math.max(limit, 1), 200))
    .map(({ stdoutTail: _stdout, stderrTail: _stderr, ...meta }) => meta);
}

export function getAgentJobEvents(
  repoRoot: string,
  runId: string,
  limit = 200,
): AgentJobEvent[] {
  getAgentJob(repoRoot, runId);
  const path = eventPath(repoRoot, runId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => readJsonLine<AgentJobEvent>(line))
    .slice(-Math.min(Math.max(limit, 1), 1000));
}

function readJsonLine<T>(line: string): T {
  return JSON.parse(line) as T;
}

export function getAgentJobLog(
  repoRoot: string,
  runId: string,
  follow = false,
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
    return readFileSync(absolute, "utf-8").slice(-4 * 1024 * 1024);
  };
  return {
    runId,
    provider: "local",
    log: [readLog(run.stdoutPath), readLog(run.stderrPath)]
      .filter(Boolean)
      .join("\n"),
  };
}

export function cancelAgentJob(repoRoot: string, runId: string): AgentJobMeta {
  const current = getAgentJob(repoRoot, runId);
  if (current.provider === "github")
    throw new Error(
      "GitHub cloud sessions must currently be cancelled from the GitHub Agents UI; the public agent-task API does not expose a stable cancellation contract here.",
    );
  if (!["queued", "running", "unknown"].includes(current.status))
    return current;
  const terminate = (pid: number | undefined): void => {
    if (!pid || !isAlive(pid)) return;
    try {
      if (process.platform === "win32") process.kill(pid, "SIGTERM");
      else process.kill(-pid, "SIGTERM");
    } catch (_error) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (_nested) {
        /* already exited */
      }
    }
  };
  terminate(current.agentPid);
  terminate(current.workerPid);
  const { stdoutTail: _stdout, stderrTail: _stderr, ...meta } = current;
  meta.status = "cancelled";
  meta.terminationReason = "cancelled";
  meta.finishedAt = new Date().toISOString();
  writeJson(metaPath(repoRoot, runId), meta);
  appendAgentJobEvent(repoRoot, runId, {
    type: "run_cancelled",
    message: "Local Run cancelled.",
  });
  try {
    updateTask(repoRoot, meta.issueId, meta.taskId, {
      status: "ready",
      note: `${runId} cancelled; the Task itself remains open and returned to ready.`,
    });
  } catch (_error) {
    /* ignore */
  }
  return meta;
}

export function retryAgentJob(
  repoRoot: string,
  runId: string,
  options: { timeoutMs?: number; isolate?: boolean } = {},
): AgentJobMeta {
  const previous = getAgentJob(repoRoot, runId);
  if (
    !["failed", "cancelled", "unknown", "waiting_for_user"].includes(
      previous.status,
    )
  ) {
    throw new Error(`run status is not retryable: ${previous.status}`);
  }
  updateTask(repoRoot, previous.issueId, previous.taskId, {
    status: "ready",
    note: `Retry requested from ${previous.runId}.`,
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
    isolate: options.isolate,
    githubRepo: previous.github
      ? `${previous.github.owner}/${previous.github.repo}`
      : undefined,
    baseRef: previous.github?.baseRef,
    model: previous.github?.model,
    createPullRequest: previous.github?.createPullRequest,
  });
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
  writeJson(metaPath(repoRoot, runId), meta);
  appendAgentJobEvent(repoRoot, runId, {
    type: "run_integrated",
    message: `Integrated through edit session ${sessionId}.`,
  });
  return meta;
}
