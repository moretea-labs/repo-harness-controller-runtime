import { randomBytes } from "crypto";
import { spawn } from "child_process";
import type { Server } from "http";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  cancelAgentJob,
  getAgentJob,
  getAgentJobEvents,
  getAgentJobLog,
  listAgentJobs,
  retryAgentJob,
} from "../agent-jobs/job-manager";
import {
  cleanupIntegratedWorktree,
  integrateAgentJob,
  taskRunDiff,
} from "../agent-jobs/integration";
import { listControllerChecks, runControllerCheck } from "../controller/check-runner";
import {
  acceptVerifiedTask,
  archiveIssue,
  getIssue,
  inspectIssueReadiness,
  inspectTaskReadiness,
  projectBoard,
  restoreIssue,
  recordTaskVerification,
  setTaskDependencies,
  updateTask,
} from "../controller/issue-store";
import { readTaskRunEvidence } from "../controller/run-evidence";
import { resolveEffectiveTaskState } from "../controller/task-status-resolver";
import {
  getControllerTimeline,
  getProjectProgress,
  getTaskProgressDetail,
} from "../controller/progress";
import { exportControllerWorklog, listControllerWorklogEvents, parseWorklogCategory } from "../controller/worklog";
import { inspectProjectGovernance, reconcileProjectGovernance } from "../controller/governance";
import { clearCurrentIssue, loadControllerProjectState, saveControllerProjectState } from "../controller/project-state";
import {
  closeIssueWithGitHubPlugin,
  getGitHubPluginStatus,
  publishIssueWithGitHubPlugin,
  refreshIssueWithGitHubPlugin,
  saveGitHubPluginConfig,
} from "../github/plugin";
import {
  cancelLocalBridgeJob,
  executeLocalBridgeJob,
  getLocalBridgeJob,
  getLocalBridgeJobEvents,
  listLocalBridgeJobs,
  localBridgeTimeoutPolicy,
  submitLocalBridgeJob,
} from "./job-store";
import {
  createEditSavepoint,
  finalizeEditSession,
  getEditSession,
  getEditSessionDiff,
  listEditSessions,
  rollbackEditSession,
  verifyEditSession,
} from "../editing/edit-session";
import { localBridgeDashboardHtml } from "./dashboard";
import type { LocalBridgeJobRequest } from "./types";
import {
  CONTROLLER_SCHEMA_VERSION,
  CONTROLLER_TOOL_SURFACE,
  CONTROLLER_TOOL_SURFACE_VERSION,
  controllerToolSurfaceFingerprint,
} from "../controller/runtime-config";
import { taskExecutionPolicy, taskWriteScopesConflict } from "../controller/execution-policy";
import { continueTaskAfterSuccessfulRun } from "../controller/execution-completion";
import { getMcpPolicy } from "../mcp/policy";
import { loadMcpLocalConfig, loadMcpRuntimeState } from "../mcp/auth";

export interface LocalBridgeServerOptions {
  repoRoot: string;
  host?: string;
  port?: number;
  openBrowser?: boolean;
  token?: string;
}

export interface LocalBridgeServerHandle {
  host: string;
  port: number;
  url: string;
  token: string;
  server: Server;
  close(): Promise<void>;
}

function assertLoopback(host: string): void {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(
      `local controller must bind to a loopback address, received: ${host}`,
    );
  }
}

function openUrl(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch (_error) {
    // The URL is still printed by the caller when a desktop opener is unavailable.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asyncExecute(repoRoot: string, jobId: string): void {
  setTimeout(() => {
    try {
      executeLocalBridgeJob(repoRoot, jobId);
    } catch (_error) {
      /* persisted by the job executor */
    }
  }, 0);
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function controllerStateSignature(repoRoot: string): string {
  const board = projectBoard(repoRoot);
  const runs = listAgentJobs(repoRoot, 100);
  const jobs = listLocalBridgeJobs(repoRoot, 100);
  const latestWorklog = listControllerWorklogEvents(repoRoot, { limit: 1 })[0];
  const projectState = loadControllerProjectState(repoRoot);
  const edits = listEditSessions(repoRoot, 100);
  return JSON.stringify({
    issues: board.issues.map((issue) => ({
      id: issue.id,
      status: issue.status,
      updatedAt: issue.updatedAt,
      tasks: (Array.isArray(issue.tasks) ? issue.tasks : []).map((task) => {
        const value = task as { id?: unknown; status?: unknown; updatedAt?: unknown; runIds?: unknown[] };
        return [value.id, value.status, value.updatedAt, Array.isArray(value.runIds) ? value.runIds.at(-1) : undefined];
      }),
    })),
    runs: runs.map((run) => [
      run.runId,
      run.status,
      run.lastHeartbeatAt,
      run.progress?.lastActivityAt,
      run.integratedAt,
      run.autoIntegrationError,
    ]),
    jobs: jobs.map((job) => [job.jobId, job.status, job.updatedAt, job.runId]),
    worklog: latestWorklog?.id,
    projectState,
    edits: edits.map((edit) => [edit.sessionId, edit.status, edit.updatedAt, edit.changedFiles, edit.checksPassed, edit.checksTotal]),
  });
}

export function buildLocalControllerSnapshot(repoRoot: string) {
  const runs = listAgentJobs(repoRoot, 100);
  const mcpConfig = loadMcpLocalConfig(repoRoot);
  const mcpRuntime = loadMcpRuntimeState(repoRoot);
  const runtimeSurface = mcpRuntime?.server?.toolSurface;
  const runtimeSchemaVersion = mcpRuntime?.server?.schemaVersion;
  const runtimeSurfaceVersion = mcpRuntime?.server?.toolSurfaceVersion;
  const runtimeFingerprint = mcpRuntime?.server?.toolSurfaceFingerprint;
  const expectedFingerprint = controllerToolSurfaceFingerprint();
  const runtimeProfile = mcpRuntime?.server?.profile;
  const connectorHealthy =
    mcpRuntime?.server?.healthy === true &&
    runtimeSurface === CONTROLLER_TOOL_SURFACE &&
    runtimeSchemaVersion === CONTROLLER_SCHEMA_VERSION &&
    runtimeSurfaceVersion === CONTROLLER_TOOL_SURFACE_VERSION &&
    runtimeFingerprint === expectedFingerprint &&
    runtimeProfile === "controller";
  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    toolSurface: CONTROLLER_TOOL_SURFACE,
    schemaVersion: CONTROLLER_SCHEMA_VERSION,
    toolSurfaceVersion: CONTROLLER_TOOL_SURFACE_VERSION,
    toolSurfaceFingerprint: expectedFingerprint,
    connector: {
      configuredServerName: mcpConfig?.chatgpt?.serverName,
      publicEndpoint:
        mcpConfig?.chatgpt?.endpoint ?? mcpRuntime?.tunnel?.publicEndpoint,
      runtimeStatus: mcpRuntime?.status ?? "not_started",
      runtimeProfile,
      runtimeSurface,
      runtimeSchemaVersion,
      runtimeSurfaceVersion,
      runtimeFingerprint,
      expectedFingerprint,
      toolCount: mcpRuntime?.server?.toolCount,
      healthy: connectorHealthy,
      needsReconnect: mcpRuntime?.tunnel?.connectorNeedsReconnect === true,
      mismatch:
        mcpRuntime?.server?.healthMismatch ??
        (mcpRuntime && !connectorHealthy
          ? `expected controller / ${CONTROLLER_TOOL_SURFACE} / schema ${CONTROLLER_SCHEMA_VERSION} / surface ${CONTROLLER_TOOL_SURFACE_VERSION} / ${expectedFingerprint}`
          : undefined),
    },
    timeoutPolicy: localBridgeTimeoutPolicy(repoRoot),
    execution: {
      defaultMode: "direct-edit",
      agentRunner: mcpConfig?.devMode?.agentRunner === true,
      allowedAgents: mcpConfig?.devMode?.allowedAgents ?? ["codex"],
      taskAgentBinding: false,
      localRiskApprovalGate: false,
    },
    board: projectBoard(repoRoot),
    projectState: loadControllerProjectState(repoRoot),
    governance: inspectProjectGovernance(repoRoot),
    progress: getProjectProgress(repoRoot),
    timeline: getControllerTimeline(repoRoot, { limit: 120 }),
    githubPlugin: getGitHubPluginStatus(repoRoot),
    runs,
    runCounts: runs.reduce<Record<string, number>>((counts, run) => {
      counts[run.status] = (counts[run.status] ?? 0) + 1;
      return counts;
    }, {}),
    localJobs: listLocalBridgeJobs(repoRoot, 100),
    editSessions: listEditSessions(repoRoot, 200),
    checks: listControllerChecks(repoRoot),
  };
}

export async function startLocalBridgeServer(
  options: LocalBridgeServerOptions,
): Promise<LocalBridgeServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 8766;
  assertLoopback(host);
  const token = options.token ?? randomBytes(32).toString("base64url");
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));

  const requireToken = (
    request: Request,
    response: Response,
    next: NextFunction,
  ): void => {
    const supplied = request.header("x-repo-harness-local-token") ?? queryString(request.query.token);
    if (supplied !== token) {
      response.status(403).json({ error: "invalid local controller token" });
      return;
    }
    next();
  };

  app.get("/", (_request, response) => {
    response.type("html").send(localBridgeDashboardHtml(token));
  });
  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      repoRoot: options.repoRoot,
      localOnly: true,
      toolSurface: CONTROLLER_TOOL_SURFACE,
      schemaVersion: CONTROLLER_SCHEMA_VERSION,
      toolSurfaceVersion: CONTROLLER_TOOL_SURFACE_VERSION,
      toolSurfaceFingerprint: controllerToolSurfaceFingerprint(),
      timeoutPolicy: localBridgeTimeoutPolicy(options.repoRoot),
      features: [
        "project-progress",
        "task-history",
        "worklog-ledger",
        "server-sent-events",
        "github-plugin",
        "execution-focus",
        "governance-reconciliation",
        "direct-task-actions",
        "direct-edit-first",
        "edit-session-diffs",
        "edit-session-verification",
        "multi-revision-direct-edit",
        "runtime-agent-selection",
        "hierarchical-work-ui",
      ],
    });
  });

  app.use("/api", requireToken);
  app.get("/api/snapshot", (_request, response) => {
    response.json(buildLocalControllerSnapshot(options.repoRoot));
  });
  app.get("/api/stream", (request, response) => {
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    const send = (type: string) => {
      response.write(`event: ${type}\n`);
      response.write(`data: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    };
    send("connected");
    let signature = controllerStateSignature(options.repoRoot);
    let idleTicks = 0;
    const interval = setInterval(() => {
      const next = controllerStateSignature(options.repoRoot);
      if (next !== signature) {
        signature = next;
        idleTicks = 0;
        send("refresh");
        return;
      }
      idleTicks += 1;
      if (idleTicks >= 8) {
        idleTicks = 0;
        send("heartbeat");
      }
    }, 2_000);
    request.on("close", () => clearInterval(interval));
  });
  app.get("/api/progress", (_request, response) => {
    response.json(getProjectProgress(options.repoRoot));
  });
  app.get("/api/governance", (_request, response) => {
    response.json(inspectProjectGovernance(options.repoRoot));
  });
  app.post("/api/governance/reconcile", (_request, response) => {
    try {
      response.json(reconcileProjectGovernance(options.repoRoot));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/project-state", (_request, response) => {
    response.json(loadControllerProjectState(options.repoRoot));
  });
  app.patch("/api/project-state", (request, response) => {
    try {
      const body = request.body ?? {};
      if (body.currentIssueId === null || body.currentIssueId === "") {
        response.json(clearCurrentIssue(options.repoRoot, "local-ui"));
        return;
      }
      if (typeof body.currentIssueId === "string") {
        const issue = getIssue(options.repoRoot, body.currentIssueId);
        if (issue.archivedAt || ["done", "cancelled"].includes(issue.status)) throw new Error("only an active, non-archived Issue can become the execution focus");
      }
      response.json(saveControllerProjectState(options.repoRoot, {
        currentIssueId: typeof body.currentIssueId === "string" ? body.currentIssueId : undefined,
        issueCreationMode: ["open", "focus_only", "paused"].includes(body.issueCreationMode) ? body.issueCreationMode : undefined,
        showArchivedByDefault: typeof body.showArchivedByDefault === "boolean" ? body.showArchivedByDefault : undefined,
      }, "local-ui"));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/issues/:issueId/focus", (request, response) => {
    try {
      const issue = getIssue(options.repoRoot, request.params.issueId);
      if (issue.archivedAt || ["done", "cancelled"].includes(issue.status)) throw new Error("only an active, non-archived Issue can become the execution focus");
      response.json(saveControllerProjectState(options.repoRoot, { currentIssueId: issue.id }, "local-ui"));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/tasks/launch-ready", (request, response) => {
    try {
      const board = projectBoard(options.repoRoot);
      const maxParallel = Math.max(1, Math.min(Number(request.body?.maxParallel ?? 2), 4));
      const selected: Array<{ issueId: string; taskId: string }> = [];
      const selectedTasks: Array<ReturnType<typeof getIssue>["tasks"][number]> = [];
      const skipped: Array<{ issueId: string; taskId: string; reason: string }> = [];
      for (const candidate of board.queueableTasks) {
        if (selected.length >= maxParallel) break;
        const issueId = String(candidate.issueId ?? "");
        const taskId = String(candidate.taskId ?? "");
        const issue = getIssue(options.repoRoot, issueId);
        const task = issue.tasks.find((entry) => entry.id === taskId);
        if (!task) continue;
        if (selectedTasks.some((entry) => taskWriteScopesConflict(entry, task))) {
          skipped.push({ issueId, taskId, reason: "allowed path scope overlaps another selected Task" });
          continue;
        }
        selected.push({ issueId, taskId });
        selectedTasks.push(task);
      }
      const jobs = selected.map(({ issueId, taskId }) => {
        const job = submitLocalBridgeJob(options.repoRoot, {
          action: "launch-task",
          requestedBy: "local-ui",
          payload: {
            issueId,
            taskId,
            timeoutMs: typeof request.body?.timeoutMs === "number" ? request.body.timeoutMs : undefined,
            isolate: typeof request.body?.isolate === "boolean" ? request.body.isolate : undefined,
          },
        });
        if (job.status === "approved") asyncExecute(options.repoRoot, job.jobId);
        return job;
      });
      response.status(202).json({
        jobs,
        skipped,
        currentFocus: loadControllerProjectState(options.repoRoot).currentIssueId,
        focusIsInformational: true,
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/issues/:issueId/launch", (request, response) => {
    try {
      const readiness = inspectIssueReadiness(options.repoRoot, request.params.issueId);
      if (!readiness.queueable) {
        response.status(409).json({ error: "Issue has no queueable Tasks.", readiness });
        return;
      }
      saveControllerProjectState(options.repoRoot, { currentIssueId: request.params.issueId }, "local-ui");
      const issue = getIssue(options.repoRoot, request.params.issueId);
      const maxParallel = Math.max(1, Math.min(Number(request.body?.maxParallel ?? readiness.suggestedMaxParallel), readiness.queueableTaskIds.length));
      const selected = [] as typeof issue.tasks;
      const skipped: Array<{ taskId: string; reason: string }> = [];
      for (const taskId of readiness.queueableTaskIds) {
        if (selected.length >= maxParallel) break;
        const task = issue.tasks.find((entry) => entry.id === taskId);
        if (!task) continue;
        if (selected.some((entry) => taskWriteScopesConflict(entry, task))) {
          skipped.push({ taskId, reason: "allowed path scope overlaps another selected Task" });
          continue;
        }
        selected.push(task);
      }
      const jobs = selected.map((task) => {
        const job = submitLocalBridgeJob(options.repoRoot, {
          action: "launch-task",
          requestedBy: "local-ui",
          payload: {
            issueId: request.params.issueId,
            taskId: task.id,
            agent: ["codex", "claude", "github-copilot"].includes(String(request.body?.agent)) ? request.body.agent : undefined,
            timeoutMs: typeof request.body?.timeoutMs === "number" ? request.body.timeoutMs : undefined,
            isolate: typeof request.body?.isolate === "boolean" ? request.body.isolate : undefined,
          },
        });
        if (job.status === "approved") asyncExecute(options.repoRoot, job.jobId);
        return job;
      });
      response.status(202).json({ readiness, jobs, skipped });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/issues/:issueId/archive", (request, response) => {
    try {
      response.json(archiveIssue(options.repoRoot, request.params.issueId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/issues/:issueId/restore", (request, response) => {
    try {
      response.json(restoreIssue(options.repoRoot, request.params.issueId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/issues/:issueId/tasks/:taskId/launch", (request, response) => {
    try {
      const readiness = inspectTaskReadiness(options.repoRoot, request.params.issueId, request.params.taskId);
      if (!readiness.queueable) {
        response.status(409).json({ error: "Task has launch blockers.", readiness });
        return;
      }
      saveControllerProjectState(options.repoRoot, { currentIssueId: request.params.issueId }, "local-ui");
      const job = submitLocalBridgeJob(options.repoRoot, {
        action: "launch-task",
        requestedBy: "local-ui",
        payload: {
          issueId: request.params.issueId,
          taskId: request.params.taskId,
          agent: ["codex", "claude", "github-copilot"].includes(String(request.body?.agent)) ? request.body.agent : undefined,
          timeoutMs: typeof request.body?.timeoutMs === "number" ? request.body.timeoutMs : undefined,
          isolate: typeof request.body?.isolate === "boolean" ? request.body.isolate : undefined,
        },
      });
      if (job.status === "approved") asyncExecute(options.repoRoot, job.jobId);
      response.status(202).json(job);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/issues/:issueId/tasks/:taskId/verify", (request, response) => {
    try {
      const issue = getIssue(options.repoRoot, request.params.issueId);
      const task = issue.tasks.find((entry) => entry.id === request.params.taskId);
      if (!task) throw new Error("task not found");
      if (task.status === "done" || task.status === "verified") {
        response.json(issue);
        return;
      }
      const policy = taskExecutionPolicy(task);
      const latestRunId = task.runIds.at(-1);
      if (latestRunId) {
        const run = getAgentJob(options.repoRoot, latestRunId);
        if (run.status !== "succeeded") throw new Error(`verification requires a succeeded Run (current: ${run.status})`);
        if (run.provider === "local" && run.worktree !== options.repoRoot && !run.integratedSessionId) throw new Error("integrate the isolated local Run before verification");
        if (run.provider === "github" && run.github?.createPullRequest !== false && !run.github?.pullRequestUrl) throw new Error("GitHub verification requires the linked pull request");
        continueTaskAfterSuccessfulRun(options.repoRoot, run);
        response.json(getIssue(options.repoRoot, issue.id));
        return;
      }

      // Manual evidence-only verification remains available for Tasks that do not
      // require a Run or Diff. Missing named checks never block launch or this path.
      const checkResults = task.checks.map((checkId) => {
        try {
          const result = runControllerCheck(options.repoRoot, checkId);
          return {
            checkId,
            ok: result.ok,
            summary: `${result.ok ? "Passed" : "Failed"} with persisted evidence ${result.artifactPath}`,
          };
        } catch (error) {
          return { checkId, ok: false, summary: errorMessage(error) };
        }
      });
      const confirmAcceptance = request.body?.confirmAcceptance === true;
      if (policy.requiresAcceptanceEvidence && !confirmAcceptance) {
        throw new Error(`${policy.executionClass} requires explicit acceptance evidence when no successful Run is linked`);
      }
      const at = new Date().toISOString();
      response.json(recordTaskVerification(options.repoRoot, issue.id, task.id, {
        reviewedDiffHash: typeof request.body?.reviewedDiffHash === "string" ? request.body.reviewedDiffHash : undefined,
        reviewer: queryString(request.body?.reviewer) ?? "local-controller-human",
        checkResults,
        commandEvidence: [],
        acceptanceResults: confirmAcceptance
          ? task.acceptanceCriteria.map((criterion) => ({ criterion, ok: true, evidence: `Explicitly confirmed in the local Controller at ${at}.` }))
          : [],
        verifiedAt: at,
      }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/issues/:issueId/tasks/:taskId/accept", (request, response) => {
    try {
      const issue = getIssue(options.repoRoot, request.params.issueId);
      const task = issue.tasks.find((entry) => entry.id === request.params.taskId);
      if (!task) throw new Error("task not found");
      const latestRunId = task.runIds.at(-1);
      if (latestRunId) {
        const run = getAgentJob(options.repoRoot, latestRunId);
        if (run.status !== "succeeded") throw new Error(`latest Run must succeed before acceptance (current: ${run.status})`);
        if (run.provider === "local" && run.worktree !== options.repoRoot && !run.integratedSessionId) {
          throw new Error("integrate the isolated local Task Run before accepting it");
        }
      }
      response.json(acceptVerifiedTask(options.repoRoot, request.params.issueId, request.params.taskId, queryString(request.body?.note) ?? "Accepted from the local Controller."));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/issues/:issueId/tasks/:taskId/request-changes", (request, response) => {
    try {
      const issue = getIssue(options.repoRoot, request.params.issueId);
      const task = issue.tasks.find((entry) => entry.id === request.params.taskId);
      if (!task) throw new Error("task not found");
      if (!["review", "integrated", "verifying", "verified"].includes(task.status)) throw new Error(`Task is not reviewable from ${task.status}`);
      response.json(updateTask(options.repoRoot, issue.id, task.id, { status: "changes_requested", note: queryString(request.body?.note) ?? "Changes requested from the local Controller." }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/issues/:issueId/tasks/:taskId/cancel", (request, response) => {
    try {
      const issue = getIssue(options.repoRoot, request.params.issueId);
      const task = issue.tasks.find((entry) => entry.id === request.params.taskId);
      if (!task) throw new Error("task not found");
      const state = resolveEffectiveTaskState({ issue, task, runs: readTaskRunEvidence(options.repoRoot, task) });
      if (state.activeRunIds.length > 0) throw new Error(`cancel active Run(s) ${state.activeRunIds.join(", ")} before cancelling the Task`);
      response.json(updateTask(options.repoRoot, request.params.issueId, request.params.taskId, { status: "cancelled", note: queryString(request.body?.note) ?? "Task cancelled from the local Controller." }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/issues/:issueId/tasks/:taskId/dependencies", (request, response) => {
    try {
      if (!Array.isArray(request.body?.dependsOn)) throw new Error("dependsOn must be an array");
      response.json(setTaskDependencies(options.repoRoot, request.params.issueId, request.params.taskId, request.body.dependsOn.map(String)));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/timeline", (request, response) => {
    try {
      response.json({
        events: getControllerTimeline(options.repoRoot, {
          category: parseWorklogCategory(queryString(request.query.category)),
          issueId: queryString(request.query.issueId),
          taskId: queryString(request.query.taskId),
          runId: queryString(request.query.runId),
          editSessionId: queryString(request.query.editSessionId),
          since: queryString(request.query.since),
          until: queryString(request.query.until),
          limit: request.query.limit ? Number(request.query.limit) : 300,
        }),
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/issues/:issueId/tasks/:taskId", (request, response) => {
    try {
      response.json(
        getTaskProgressDetail(
          options.repoRoot,
          request.params.issueId,
          request.params.taskId,
        ),
      );
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/worklog/export", (request, response) => {
    try {
      response.json(
        exportControllerWorklog(options.repoRoot, {
          format: request.body?.format === "json" ? "json" : "markdown",
          outputPath: queryString(request.body?.outputPath),
          filter: {
            issueId: queryString(request.body?.issueId),
            taskId: queryString(request.body?.taskId),
            runId: queryString(request.body?.runId),
            editSessionId: queryString(request.body?.editSessionId),
          },
        }),
      );
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/edit-sessions", (request, response) => {
    try {
      const limit = request.query.limit ? Number(request.query.limit) : 200;
      response.json({ sessions: listEditSessions(options.repoRoot, limit) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/edit-sessions/:sessionId", (request, response) => {
    try {
      response.json(getEditSession(options.repoRoot, request.params.sessionId));
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/edit-sessions/:sessionId/diff", (request, response) => {
    try {
      response.json(getEditSessionDiff(options.repoRoot, request.params.sessionId));
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/edit-sessions/:sessionId/savepoints", (request, response) => {
    try {
      response.json(createEditSavepoint(options.repoRoot, request.params.sessionId, String(request.body?.name ?? "")));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/edit-sessions/:sessionId/verify", (request, response) => {
    try {
      response.json(verifyEditSession(options.repoRoot, request.params.sessionId, {
        checkIds: Array.isArray(request.body?.checkIds) ? request.body.checkIds.map(String) : undefined,
        reviewer: queryString(request.body?.reviewer) ?? "local-controller-human",
        note: queryString(request.body?.note),
      }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/edit-sessions/:sessionId/finalize", (request, response) => {
    try {
      response.json(finalizeEditSession(options.repoRoot, request.params.sessionId, {
        reviewer: queryString(request.body?.reviewer) ?? "local-controller-human",
        note: queryString(request.body?.note),
      }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/edit-sessions/:sessionId/rollback", (request, response) => {
    try {
      response.json(rollbackEditSession(options.repoRoot, request.params.sessionId, {
        toRevision: typeof request.body?.toRevision === "number" ? Math.trunc(request.body.toRevision) : undefined,
        savepoint: queryString(request.body?.savepoint),
      }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/github/plugin", (_request, response) => {
    response.json(getGitHubPluginStatus(options.repoRoot));
  });
  app.patch("/api/github/plugin", (request, response) => {
    try {
      const body = request.body ?? {};
      response.json(
        saveGitHubPluginConfig(options.repoRoot, {
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
          repository: typeof body.repository === "string" ? body.repository : undefined,
          syncMode: body.syncMode === "checkpoint" ? "checkpoint" : body.syncMode === "manual" ? "manual" : undefined,
          includeTasks: typeof body.includeTasks === "boolean" ? body.includeTasks : undefined,
          projectOwner: typeof body.projectOwner === "string" ? body.projectOwner : undefined,
          projectNumber: body.projectNumber === null ? null : typeof body.projectNumber === "number" ? body.projectNumber : undefined,
        }),
      );
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/issues/:issueId/github/publish", (request, response) => {
    try {
      response.json(publishIssueWithGitHubPlugin(options.repoRoot, request.params.issueId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/issues/:issueId/github/refresh", (request, response) => {
    try {
      response.json(refreshIssueWithGitHubPlugin(options.repoRoot, request.params.issueId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/issues/:issueId/github/close", (request, response) => {
    try {
      response.json(closeIssueWithGitHubPlugin(options.repoRoot, request.params.issueId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/jobs/:jobId", (request, response) => {
    try {
      response.json({
        job: getLocalBridgeJob(options.repoRoot, request.params.jobId),
        events: getLocalBridgeJobEvents(options.repoRoot, request.params.jobId),
      });
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/jobs", (request, response) => {
    try {
      const job = submitLocalBridgeJob(
        options.repoRoot,
        request.body as LocalBridgeJobRequest,
      );
      if (job.status === "approved") asyncExecute(options.repoRoot, job.jobId);
      response.status(202).json(job);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/jobs/:jobId/cancel", (request, response) => {
    try {
      response.json(
        cancelLocalBridgeJob(options.repoRoot, request.params.jobId),
      );
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/runs/:runId", (request, response) => {
    try {
      response.json(getAgentJob(options.repoRoot, request.params.runId));
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/runs/:runId/log", (request, response) => {
    try {
      const run = getAgentJob(options.repoRoot, request.params.runId);
      const result = getAgentJobLog(
        options.repoRoot,
        request.params.runId,
        false,
      );
      response.json({ ...result, status: run.status, agent: run.agent });
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/runs/:runId/events", (request, response) => {
    try {
      response.json({
        events: getAgentJobEvents(options.repoRoot, request.params.runId, 500),
      });
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/runs/:runId/diff", (request, response) => {
    try {
      response.json(taskRunDiff(options.repoRoot, request.params.runId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/runs/:runId/integrate", (request, response) => {
    try {
      const integrated = integrateAgentJob(
        options.repoRoot,
        getMcpPolicy("controller", { repoRoot: options.repoRoot }),
        request.params.runId,
      );
      const cleanup = cleanupIntegratedWorktree(
        options.repoRoot,
        request.params.runId,
      );
      response.json({
        integrated,
        cleanup,
        run: getAgentJob(options.repoRoot, request.params.runId),
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/runs/:runId/cancel", (request, response) => {
    try {
      response.json(cancelAgentJob(options.repoRoot, request.params.runId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/runs/:runId/retry", (request, response) => {
    try {
      const timeoutMs =
        typeof request.body?.timeoutMs === "number"
          ? request.body.timeoutMs
          : undefined;
      response.status(202).json(
        retryAgentJob(options.repoRoot, request.params.runId, {
          timeoutMs,
          isolate:
            typeof request.body?.isolate === "boolean"
              ? request.body.isolate
              : undefined,
        }),
      );
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(requestedPort, host, () => resolve(instance));
    instance.once("error", reject);
  });
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : requestedPort;
  const url = `http://${host === "::1" ? "[::1]" : host}:${port}/`;
  if (options.openBrowser) openUrl(url);
  return {
    host,
    port,
    url,
    token,
    server,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
