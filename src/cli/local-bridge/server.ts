import { randomBytes } from "crypto";
import { spawn } from "child_process";
import { createServer, type Server } from "http";
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
  reconcileAgentJobs,
  retryAgentJob,
} from "../agent-jobs/job-manager";
import {
  cleanupIntegratedWorktree,
  integrateAgentJob,
  taskRunDiff,
} from "../agent-jobs/integration";
import { listControllerChecks, runControllerCheckAsync } from "../controller/check-runner";
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
  dispatchLocalBridgeJob,
  executeLocalBridgeJob,
  failLocalBridgeJob,
  getLocalBridgeJob,
  getLocalBridgeJobEvents,
  listLocalBridgeJobs,
  localBridgeTimeoutPolicy,
  reconcileLocalBridgeJobs,
  submitLocalBridgeJob,
} from "./job-store";
import {
  createEditSavepoint,
  finalizeEditSession,
  getEditSession,
  getEditSessionDiff,
  listEditSessions,
  rollbackEditSession,
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
import { applyCompletionDecision, completionDecisionQueues, finishCompletionBacklog, inspectCompletionBacklog } from "../controller/completion-backlog";
import { finishTaskRun } from "../controller/completion-orchestrator";
import { prepareCodexContinuation } from "../controller/codex-continuation";
import { applyStuckStateMigration, inspectStuckControllerStates } from "../controller/stuck-state-migration";
import { getMcpPolicy } from "../mcp/policy";
import { runtimePolicy } from "../mcp/multi-repository";
import { controllerExpectedToolNames } from "../mcp/tools";
import { loadMcpLocalConfig, loadMcpRuntimeState } from "../mcp/auth";
import { loadRepositoryRegistry, registerRepository } from "../repositories/registry";
import { resolveControllerHome } from "../repositories/controller-home";
import { ensureControllerDaemon, readControllerDaemonStatus } from "../../runtime/control-plane/daemon-client";
import { findExecutionJob, listExecutionJobs } from "../../runtime/execution/jobs/store";
import { rebuildRepositoryProjection, readRepositoryProjectionSnapshot } from "../../runtime/projections/materialized-view";
import { runtimeToolDefinitions } from "../../runtime/gateway/mcp/runtime-tools";
import { getAssistantPluginManifest, listAssistantPluginManifests, submitAssistantPluginAction } from "../../runtime/plugins/store";
import {
  createMobileIntentDevice,
  listMobileIntentDevices,
  mobileIntentHasScope,
  revokeMobileIntentDevice,
  verifyMobileIntentRequest,
} from "./mobile-intents";
import { CORE_CONTROLLER_TOOL_NAMES } from "../mcp/toolset";
import { submitAssistantIntent, runAssistantRoutineNow } from "../../runtime/assistant/intent";
import { assistantOpenApiSchema } from "../../runtime/assistant/openapi";
import { buildAssistantReadinessReport } from "../../runtime/assistant/readiness";
import { listWebTargets, previewBrowserDomainAccess, summarizePluginForLowInterception } from "../../runtime/safe-tooling";
import { buildModelClientSummary, buildModelControlPlaneSummary, deepSeekControllerManifest, deepSeekFunctionToolManifest, prepareDeepSeekControllerHandoff, prepareDeepSeekControllerRequest, prepareDeepSeekToolCall } from "../../runtime/model-clients";
import { applyRuntimeCleanup, previewRuntimeCleanup } from "../../runtime/maintenance/cleanup";
import { assertRecoveryAuthorized, buildCapabilityRecoverySnapshot, buildRecoveryAuditRecord, recoveryActionById, writeRecoveryAuditRecord } from "../../runtime/recovery";
import {
  listAssistantInbox,
  listAssistantMemory,
  listAssistantRoutines,
  updateAssistantInboxStatus,
  updateAssistantRoutineStatus,
  upsertAssistantMemory,
} from "../../runtime/assistant/store";

export interface LocalBridgeServerOptions {
  repoRoot: string;
  host?: string;
  port?: number;
  openBrowser?: boolean;
  token?: string;
  allowLanMobileIntents?: boolean;
}

export interface LocalBridgeServerHandle {
  host: string;
  port: number;
  url: string;
  token: string;
  server: Server;
  close(): Promise<void>;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(normalizeHostname(hostname));
}

function isWildcardBindHost(host: string): boolean {
  return ["0.0.0.0", "::", "[::]"].includes(normalizeHostname(host));
}

function assertAllowedBindHost(host: string, allowLanMobileIntents: boolean): void {
  if (isLoopbackHostname(host)) return;
  if (allowLanMobileIntents && isWildcardBindHost(host)) return;
  throw new Error(
    `local controller must bind to loopback unless --mobile-lan is enabled, received: ${host}`,
  );
}

function parsedRequestHost(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(`http://${value}`);
  } catch (_error) {
    return undefined;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(valueParts.join("="));
    } catch (_error) {
      return undefined;
    }
  }
  return undefined;
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
      dispatchLocalBridgeJob(repoRoot, jobId);
    } catch (error) {
      failLocalBridgeJob(
        repoRoot,
        jobId,
        `JOB_DISPATCH_FAILED: ${errorMessage(error)}`,
        { stage: "dispatch", retryable: false },
      );
    }
  }, 0);
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function controllerStateSignature(repoRoot: string): string {
  const board = projectBoard(repoRoot);
  const runs = listAgentJobs(repoRoot, 30);
  const jobs = listLocalBridgeJobs(repoRoot, 30);
  const latestWorklog = listControllerWorklogEvents(repoRoot, { limit: 1 })[0];
  const projectState = loadControllerProjectState(repoRoot);
  const edits = listEditSessions(repoRoot, 30);
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

const SNAPSHOT_CACHE_TTL_MS = 750;
const localSnapshotCache = new Map<string, { createdAt: number; value: ReturnType<typeof buildLocalControllerSnapshot> }>();

function cachedLocalControllerSnapshot(repoRoot: string): ReturnType<typeof buildLocalControllerSnapshot> {
  const now = Date.now();
  const cached = localSnapshotCache.get(repoRoot);
  if (cached && now - cached.createdAt <= SNAPSHOT_CACHE_TTL_MS) return cached.value;
  const value = buildLocalControllerSnapshot(repoRoot);
  localSnapshotCache.set(repoRoot, { createdAt: now, value });
  return value;
}

function runtimeControllerSnapshot(repoRoot: string) {
  const controllerHome = resolveControllerHome();
  const normalizedRoot = repoRoot.replace(/\\/g, '/');
  const repository = loadRepositoryRegistry(controllerHome).repositories.find((entry) => entry.canonicalRoot.replace(/\\/g, '/') === normalizedRoot);
  if (!repository) return { registered: false, daemon: readControllerDaemonStatus(controllerHome) };
  return {
    registered: true,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    daemon: readControllerDaemonStatus(controllerHome),
    projection: readRepositoryProjectionSnapshot(controllerHome, repository.repoId).projection,
    executionJobs: listExecutionJobs(controllerHome, repository.repoId, 30),
  };
}

export function buildLocalControllerSnapshot(repoRoot: string) {
  const runs = listAgentJobs(repoRoot, 30);
  const editSessions = listEditSessions(repoRoot, 30);
  const localJobs = listLocalBridgeJobs(repoRoot, 30);
  const board = projectBoard(repoRoot);
  const completionBacklog = inspectCompletionBacklog(repoRoot, { limit: 100 });
  const completionQueues = completionDecisionQueues(repoRoot, { limit: 100 });
  const stuckStates = inspectStuckControllerStates(repoRoot, { limit: 100 });
  const runtime = runtimeControllerSnapshot(repoRoot);
  const executionJobs = "executionJobs" in runtime ? (runtime.executionJobs ?? []) : [];
  const controllerHome = resolveControllerHome();
  const assistantRepository = registerRepository({ path: repoRoot, controllerHome });
  const assistantPlugins = listAssistantPluginManifests(controllerHome, assistantRepository).map((plugin) => ({
    pluginId: plugin.pluginId,
    provider: plugin.provider,
    displayName: plugin.displayName,
    enabled: plugin.enabled,
    revision: plugin.revision,
    lifecycle: plugin.lifecycle,
    health: plugin.health,
    permissions: plugin.permissions,
    actions: plugin.actions.map((action) => ({
      actionId: action.actionId,
      title: action.title,
      readOnly: action.readOnly,
      risk: action.risk,
      confirmation: action.confirmation,
      requiredConfirmationText: action.requiredConfirmationText,
      scopes: action.scopes,
    })),
  }));
  const mobileIntents = listMobileIntentDevices(repoRoot);
  const assistantInbox = listAssistantInbox(repoRoot, 20);
  const assistantRoutines = listAssistantRoutines(repoRoot);
  const assistantMemory = listAssistantMemory(repoRoot);
  const boardIssues = board.issues as Array<{
    id: string;
    tasks?: Array<{ id: string; title: string; effectiveStatus: string }>;
  }>;
  const reviewTasks = boardIssues.flatMap((issue) => (issue.tasks ?? [])
    .filter((task) => ["review", "verified", "changes_requested"].includes(task.effectiveStatus))
    .map((task) => ({ kind: "task", issueId: issue.id, taskId: task.id, title: task.title, status: task.effectiveStatus })));
  const decisionQueues = {
    needsAttention: [
      ...runs.filter((run) => ["failed", "waiting_for_user", "unknown"].includes(run.status))
        .map((run) => ({ kind: "run", id: run.runId, title: run.progress?.currentActivity ?? run.runId, status: run.status, updatedAt: run.lastHeartbeatAt })),
      ...editSessions.filter((session) => session.status === "check_failed")
        .map((session) => ({ kind: "edit", id: session.sessionId, title: session.purpose, status: session.status, updatedAt: session.updatedAt })),
      ...executionJobs.filter((job) => ["human_attention_required", "failed", "orphaned", "stale"].includes(job.status))
        .map((job) => ({ kind: "work", id: job.jobId, title: String(job.payload.operation ?? job.type), status: job.status, updatedAt: job.updatedAt })),
    ].slice(0, 12),
    runningNow: [
      ...runs.filter((run) => ["queued", "starting", "running"].includes(run.status))
        .map((run) => ({ kind: "run", id: run.runId, title: run.progress?.currentActivity ?? run.runId, status: run.status, updatedAt: run.lastHeartbeatAt })),
      ...editSessions.filter((session) => !["finalized", "rolled_back", "check_failed"].includes(session.status))
        .map((session) => ({ kind: "edit", id: session.sessionId, title: session.purpose, status: session.status, updatedAt: session.updatedAt })),
      ...executionJobs.filter((job) => ["queued", "dispatched", "running", "waiting_for_dependency", "waiting_for_workspace", "waiting_for_heavy_check", "waiting_for_integration"].includes(job.status))
        .map((job) => ({ kind: "work", id: job.jobId, title: String(job.payload.operation ?? job.type), status: job.status, updatedAt: job.updatedAt })),
    ].slice(0, 12),
    readyForReview: [
      ...completionQueues.autoFinish.map((item) => ({ kind: "completion", id: item.runId ?? `${item.issueId}/${item.taskId}`, runId: item.runId, issueId: item.issueId, taskId: item.taskId, title: item.title, status: item.action, updatedAt: undefined })),
      ...reviewTasks,
    ].slice(0, 12),
    pendingApprovals: [
      ...completionQueues.needsHumanReview.map((item) => ({ kind: "completion-review", id: item.runId ?? `${item.issueId}/${item.taskId}`, runId: item.runId, issueId: item.issueId, taskId: item.taskId, title: item.title, status: item.action, updatedAt: undefined })),
      ...localJobs.filter((job) => job.status === "pending_approval")
        .map((job) => ({ kind: "local-job", id: job.jobId, title: job.action, status: job.status, updatedAt: job.updatedAt })),
      ...executionJobs.filter((job) => job.status === "human_attention_required")
        .map((job) => ({ kind: "work", id: job.jobId, title: String(job.payload.operation ?? job.type), status: job.status, updatedAt: job.updatedAt })),
    ].slice(0, 12),
    recentlyCompleted: [
      ...runs.filter((run) => ["succeeded", "cancelled"].includes(run.status))
        .map((run) => ({ kind: "run", id: run.runId, title: run.progress?.currentActivity ?? run.runId, status: run.status, updatedAt: run.finishedAt ?? run.lastHeartbeatAt })),
      ...editSessions.filter((session) => ["finalized", "rolled_back"].includes(session.status))
        .map((session) => ({ kind: "edit", id: session.sessionId, title: session.purpose, status: session.status, updatedAt: session.updatedAt })),
      ...executionJobs.filter((job) => ["succeeded", "cancelled", "timed_out"].includes(job.status))
        .map((job) => ({ kind: "work", id: job.jobId, title: String(job.payload.operation ?? job.type), status: job.status, updatedAt: job.updatedAt })),
    ].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))).slice(0, 12),
  };
  const mcpConfig = loadMcpLocalConfig(repoRoot);
  const mcpRuntime = loadMcpRuntimeState(repoRoot);
  const expectedPolicy = runtimePolicy(repoRoot, { profile: "controller" });
  const expectedToolNames = controllerExpectedToolNames(expectedPolicy);
  const runtimeSurface = mcpRuntime?.server?.toolSurface;
  const runtimeSchemaVersion = mcpRuntime?.server?.schemaVersion;
  const runtimeSurfaceVersion = mcpRuntime?.server?.toolSurfaceVersion;
  const runtimeFingerprint = mcpRuntime?.server?.toolSurfaceFingerprint;
  const runtimeToolset = mcpRuntime?.server?.toolset;
  const configuredToolset = mcpConfig?.toolset === "full" ? "full" : "core";
  const runtimeToolFingerprint = mcpRuntime?.server?.runtimeToolSurfaceFingerprint;
  const expectedFingerprint = controllerToolSurfaceFingerprint(expectedToolNames);
  const expectedRuntimeNames = configuredToolset === "core"
    ? [...CORE_CONTROLLER_TOOL_NAMES]
    : [...expectedToolNames, ...runtimeToolDefinitions.map((tool) => tool.name)];
  const expectedRuntimeFingerprint = controllerToolSurfaceFingerprint(expectedRuntimeNames);
  const runtimeProfile = mcpRuntime?.server?.profile;
  const connectorHealthy =
    mcpRuntime?.server?.healthy === true &&
    runtimeSurface === CONTROLLER_TOOL_SURFACE &&
    runtimeSchemaVersion === CONTROLLER_SCHEMA_VERSION &&
    runtimeSurfaceVersion === CONTROLLER_TOOL_SURFACE_VERSION &&
    runtimeFingerprint === expectedFingerprint &&
    runtimeToolFingerprint === expectedRuntimeFingerprint &&
    runtimeToolset === configuredToolset &&
    runtimeProfile === "controller";
  const runtimeProjection = "projection" in runtime ? runtime.projection : undefined;
  const recovery = buildCapabilityRecoverySnapshot({
    daemonStatus: runtime.daemon.status,
    daemonError: runtime.daemon.error,
    schedulerStatus: runtimeProjection ? (runtimeProjection.queueDepth > 0 && runtimeProjection.runningWorkers === 0 ? "degraded" : "ready") : undefined,
    queueDepth: runtimeProjection?.queueDepth,
    runningWorkers: runtimeProjection?.runningWorkers,
    activeLeases: runtimeProjection?.activeLeases,
    localBridgeRunning: true,
    connectorHealthy,
    connectorMismatch: mcpRuntime?.server?.healthMismatch,
    runtimeProjectionStale: false,
    runtimeProjectionPersisted: Boolean(runtimeProjection),
    commandPreviewAvailable: connectorHealthy,
    commandExecuteAvailable: connectorHealthy,
    issueToolsAvailable: true,
    jobToolsAvailable: true,
    checksAvailable: listControllerChecks(repoRoot).length > 0,
    pluginStates: assistantPlugins.map((plugin) => ({
      pluginId: plugin.pluginId,
      enabled: plugin.enabled,
      healthState: plugin.health.state,
      ready: plugin.health.ready,
      errors: plugin.health.errors,
      warnings: plugin.health.warnings,
    })),
    recentErrors: [
      ...localJobs.flatMap((job) => job.error ? [job.error] : []),
      ...executionJobs.flatMap((job) => job.error?.message ? [job.error.message] : []),
    ],
    localJobs: localJobs.map((job) => ({ status: job.status, error: job.error, updatedAt: job.updatedAt })),
    executionJobs: executionJobs.map((job) => ({ status: job.status, error: job.error, updatedAt: job.updatedAt, operation: job.payload.operation })),
    assistant: {
      inboxCount: assistantInbox.items.length,
      routineCount: assistantRoutines.routines.length,
      memoryCount: assistantMemory.entries.length,
    },
  });
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
      runtimeToolset,
      configuredToolset,
      runtimeToolFingerprint,
      expectedRuntimeFingerprint,
      toolCount: mcpRuntime?.server?.toolCount,
      healthy: connectorHealthy,
      needsReconnect: mcpRuntime?.tunnel?.connectorNeedsReconnect === true,
      mismatch:
        mcpRuntime?.server?.healthMismatch ??
        (mcpRuntime && !connectorHealthy
          ? `expected controller / ${CONTROLLER_TOOL_SURFACE} / schema ${CONTROLLER_SCHEMA_VERSION} / surface ${CONTROLLER_TOOL_SURFACE_VERSION} / ${configuredToolset} / ${expectedRuntimeFingerprint}`
          : undefined),
    },
    timeoutPolicy: localBridgeTimeoutPolicy(repoRoot),
    runtime,
    decisionQueues,
    completion: {
      backlog: completionBacklog,
      queues: completionQueues,
      stuckStates,
    },
    execution: {
      defaultMode: "direct-edit",
      agentRunner: mcpConfig?.devMode?.agentRunner === true,
      allowedAgents: mcpConfig?.devMode?.allowedAgents ?? ["codex"],
      taskAgentBinding: false,
      localRiskApprovalGate: false,
    },
    board,
    projectState: loadControllerProjectState(repoRoot),
    governance: inspectProjectGovernance(repoRoot),
    recovery,
    progress: getProjectProgress(repoRoot),
    timeline: getControllerTimeline(repoRoot, { limit: 40 }),
    githubPlugin: getGitHubPluginStatus(repoRoot),
    assistantPlugins,
    assistant: {
      inbox: assistantInbox.items,
      routines: assistantRoutines.routines,
      memory: assistantMemory.entries,
    },
    mobileIntents,
    runs,
    runCounts: runs.reduce<Record<string, number>>((counts, run) => {
      counts[run.status] = (counts[run.status] ?? 0) + 1;
      return counts;
    }, {}),
    localJobs,
    editSessions,
    checks: listControllerChecks(repoRoot),
  };
}

export async function startLocalBridgeServer(
  options: LocalBridgeServerOptions,
): Promise<LocalBridgeServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 8766;
  assertAllowedBindHost(host, options.allowLanMobileIntents === true);
  reconcileAgentJobs(options.repoRoot);
  reconcileLocalBridgeJobs(options.repoRoot);
  const token = options.token ?? randomBytes(32).toString("base64url");
  const app = express();
  const streamClients = new Set<Response>();
  let streamSignature = controllerStateSignature(options.repoRoot);
  let streamIdleTicks = 0;
  const sendStreamEvent = (response: Response, type: string): void => {
    response.write(`event: ${type}\n`);
    response.write(`data: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  };
  const streamInterval = setInterval(() => {
    if (streamClients.size === 0) return;
    const next = controllerStateSignature(options.repoRoot);
    if (next !== streamSignature) {
      streamSignature = next;
      streamIdleTicks = 0;
      for (const client of streamClients) sendStreamEvent(client, "refresh");
      return;
    }
    streamIdleTicks += 1;
    if (streamIdleTicks >= 8) {
      streamIdleTicks = 0;
      for (const client of streamClients) sendStreamEvent(client, "heartbeat");
    }
  }, 2_000);
  streamInterval.unref();
  const cookieName = "repo_harness_local_token";
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    const requestHost = parsedRequestHost(request.headers.host);
    const mobileIntentPath = request.path === "/mobile/intent" || request.path.startsWith("/mobile/");
    if (!requestHost) {
      response.status(403).json({ error: "invalid local controller host" });
      return;
    }
    if (!isLoopbackHostname(requestHost.hostname) && !(options.allowLanMobileIntents === true && mobileIntentPath)) {
      response.status(403).json({ error: "invalid local controller host" });
      return;
    }
    const origin = request.headers.origin;
    if (origin) {
      try {
        const parsedOrigin = new URL(origin);
        if (parsedOrigin.host !== requestHost.host || (!isLoopbackHostname(parsedOrigin.hostname) && !(options.allowLanMobileIntents === true && mobileIntentPath))) {
          response.status(403).json({ error: "invalid local controller origin" });
          return;
        }
      } catch (_error) {
        response.status(403).json({ error: "invalid local controller origin" });
        return;
      }
    }
    next();
  });
  app.use(express.json({
    limit: "512kb",
    verify: (request, _response, buffer) => {
      (request as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }));

  const requireToken = (
    request: Request,
    response: Response,
    next: NextFunction,
  ): void => {
    const supplied =
      request.header("x-repo-harness-local-token") ?? cookieValue(request, cookieName);
    if (supplied !== token) {
      response.status(403).json({ error: "invalid local controller token" });
      return;
    }
    next();
  };

  app.get("/", (_request, response) => {
    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("Expires", "0");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Set-Cookie",
      `${cookieName}=${encodeURIComponent(token)}; Path=/api; HttpOnly; SameSite=Strict`,
    );
    response.type("html").send(localBridgeDashboardHtml());
  });
  app.get("/health", (_request, response) => {
    const toolNames = controllerExpectedToolNames(runtimePolicy(options.repoRoot, { profile: "controller" }));
    const configuredToolset = loadMcpLocalConfig(options.repoRoot)?.toolset === "full" ? "full" : "core";
    const runtimeNames = configuredToolset === "core"
      ? [...CORE_CONTROLLER_TOOL_NAMES]
      : [...toolNames, ...runtimeToolDefinitions.map((tool) => tool.name)];
    response.json({
      status: "ok",
      localOnly: true,
      toolSurface: CONTROLLER_TOOL_SURFACE,
      schemaVersion: CONTROLLER_SCHEMA_VERSION,
      toolSurfaceVersion: CONTROLLER_TOOL_SURFACE_VERSION,
      toolSurfaceFingerprint: controllerToolSurfaceFingerprint(toolNames),
      runtimeToolSurfaceFingerprint: controllerToolSurfaceFingerprint(runtimeNames),
      toolset: configuredToolset,
      toolCount: runtimeNames.length,
    });
  });


  app.post("/mobile/intent", (request, response) => {
    try {
      const verified = verifyMobileIntentRequest(options.repoRoot, request);
      const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? request.body as Record<string, unknown>
        : {};
      const intent = queryString(body.intent) ?? "plugin_action";
      const controllerHome = resolveControllerHome();
      const repository = registerRepository({ path: options.repoRoot, controllerHome });
      if (intent === "list_plugins") {
        if (!mobileIntentHasScope(verified.principal.scopes, "plugins:read")) throw new Error("MOBILE_INTENT_SCOPE_DENIED: plugins:read is required");
        response.json({
          schemaVersion: 1,
          accepted: true,
          device: verified.principal.device,
          signatureVerified: verified.signatureVerified,
          plugins: listAssistantPluginManifests(controllerHome, repository).map((plugin) => ({
            pluginId: plugin.pluginId,
            displayName: plugin.displayName,
            enabled: plugin.enabled,
            lifecycle: plugin.lifecycle,
            health: plugin.health,
            actions: plugin.actions.map((action) => ({
              actionId: action.actionId,
              title: action.title,
              readOnly: action.readOnly,
              risk: action.risk,
              confirmation: action.confirmation,
              requiredConfirmationText: action.requiredConfirmationText,
            })),
          })),
        });
        return;
      }
      if (intent === "get_plugin") {
        if (!mobileIntentHasScope(verified.principal.scopes, "plugins:read")) throw new Error("MOBILE_INTENT_SCOPE_DENIED: plugins:read is required");
        const pluginId = queryString(body.pluginId);
        if (!pluginId) throw new Error("MOBILE_INTENT_PLUGIN_REQUIRED: pluginId is required");
        response.json({
          schemaVersion: 1,
          accepted: true,
          device: verified.principal.device,
          signatureVerified: verified.signatureVerified,
          plugin: getAssistantPluginManifest(controllerHome, repository, pluginId),
        });
        return;
      }
      if (intent === "poll_job") {
        if (!mobileIntentHasScope(verified.principal.scopes, "jobs:read")) throw new Error("MOBILE_INTENT_SCOPE_DENIED: jobs:read is required");
        const jobId = queryString(body.jobId);
        if (!jobId) throw new Error("MOBILE_INTENT_JOB_REQUIRED: jobId is required");
        const job = findExecutionJob(controllerHome, jobId);
        if (!job) {
          response.status(404).json({ error: `Execution Job not found: ${jobId}` });
          return;
        }
        response.json({ schemaVersion: 1, accepted: true, device: verified.principal.device, signatureVerified: verified.signatureVerified, job });
        return;
      }
      if (intent !== "plugin_action") throw new Error(`MOBILE_INTENT_UNSUPPORTED: ${intent}`);
      const pluginId = queryString(body.pluginId);
      const actionId = queryString(body.actionId);
      if (!pluginId || !actionId) throw new Error("MOBILE_INTENT_ACTION_REQUIRED: pluginId and actionId are required");
      if (!mobileIntentHasScope(verified.principal.scopes, `plugin:${pluginId}:${actionId}`)) {
        throw new Error(`MOBILE_INTENT_SCOPE_DENIED: plugin:${pluginId}:${actionId} is required`);
      }
      const manifest = getAssistantPluginManifest(controllerHome, repository, pluginId);
      const action = manifest.actions.find((entry) => entry.actionId === actionId);
      if (!action) throw new Error(`PLUGIN_ACTION_NOT_FOUND: ${pluginId}/${actionId}`);
      if (action.confirmation !== "none" && body.confirmAuthorization !== true) {
        response.status(409).json({
          schemaVersion: 1,
          accepted: false,
          approvalRequired: true,
          device: verified.principal.device,
          plugin: { pluginId, displayName: manifest.displayName, enabled: manifest.enabled, lifecycle: manifest.lifecycle, health: manifest.health },
          action: {
            actionId: action.actionId,
            risk: action.risk,
            confirmation: action.confirmation,
            requiredConfirmationText: action.requiredConfirmationText,
          },
          message: action.confirmation === "strong_confirmation"
            ? `Repeat the request with confirmAuthorization=true and confirmationText=${action.requiredConfirmationText}`
            : "Repeat the request with confirmAuthorization=true after human approval.",
        });
        return;
      }
      const submitted = submitAssistantPluginAction(controllerHome, repository, {
        pluginId,
        actionId,
        requestId: queryString(body.requestId) ?? `${verified.principal.deviceId}:${Date.now()}`,
        args: body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
          ? body.arguments as Record<string, unknown>
          : {},
        timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
        confirmAuthorization: body.confirmAuthorization === true,
        confirmationText: queryString(body.confirmationText),
        origin: { surface: "mobile-intent", actor: verified.principal.deviceId, correlationId: queryString(body.requestId) },
      });
      response.status(202).json({
        schemaVersion: 1,
        accepted: true,
        deduplicated: submitted.deduplicated,
        device: verified.principal.device,
        signatureVerified: verified.signatureVerified,
        pollAfterMs: 2_000,
        plugin: { pluginId: submitted.manifest.pluginId, displayName: submitted.manifest.displayName, lifecycle: submitted.manifest.lifecycle, health: submitted.manifest.health },
        action: { actionId: submitted.action.actionId, risk: submitted.action.risk, confirmation: submitted.action.confirmation, requiredConfirmationText: submitted.action.requiredConfirmationText },
        job: submitted.job,
      });
    } catch (error) {
      const message = errorMessage(error);
      const status = message.includes("RATE_LIMITED") ? 429
        : message.includes("SCOPE_DENIED") ? 403
          : message.includes("TOKEN") || message.includes("SIGNATURE") || message.includes("REPLAY") || message.includes("TIMESTAMP") || message.includes("NONCE") || message.includes("DEVICE") ? 401
            : 400;
      response.status(status).json({ error: message });
    }
  });

  app.use("/api", requireToken);
  app.get("/api/snapshot", (_request, response) => {
    response.json(cachedLocalControllerSnapshot(options.repoRoot));
  });
  app.get("/api/completion/backlog", (request, response) => {
    try {
      const limit = Number(request.query.limit);
      response.json(inspectCompletionBacklog(options.repoRoot, { limit: Number.isFinite(limit) ? limit : 100 }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/completion/queues", (request, response) => {
    try {
      const limit = Number(request.query.limit);
      response.json(completionDecisionQueues(options.repoRoot, { limit: Number.isFinite(limit) ? limit : 100 }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/completion/finish-ready-runs", (request, response) => {
    try {
      const result = finishCompletionBacklog(options.repoRoot, {
        dryRun: request.body?.apply !== true,
        limit: typeof request.body?.limit === "number" ? request.body.limit : undefined,
        commit: request.body?.commit === true,
        cleanup: request.body?.keepWorktree !== true,
        reviewer: queryString(request.body?.reviewer) ?? "local-bridge-completion",
      });
      localSnapshotCache.delete(options.repoRoot);
      response.json(result);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/completion/decision", (request, response) => {
    try {
      const result = applyCompletionDecision(options.repoRoot, {
        action: String(request.body?.action ?? "").replace(/-/g, "_") as never,
        runId: queryString(request.body?.runId) ?? queryString(request.body?.run_id),
        issueId: queryString(request.body?.issueId) ?? queryString(request.body?.issue_id),
        taskId: queryString(request.body?.taskId) ?? queryString(request.body?.task_id),
        reviewer: queryString(request.body?.reviewer) ?? "local-bridge-completion",
        note: queryString(request.body?.note),
        commit: request.body?.commit === true,
        cleanup: request.body?.keepWorktree !== true,
      });
      localSnapshotCache.delete(options.repoRoot);
      response.json(result);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/completion/stuck", (request, response) => {
    try {
      const limit = Number(request.query.limit);
      response.json(inspectStuckControllerStates(options.repoRoot, { limit: Number.isFinite(limit) ? limit : 100 }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/completion/stuck/migrate", (request, response) => {
    try {
      const result = applyStuckStateMigration(options.repoRoot, {
        dryRun: request.body?.apply !== true,
        limit: typeof request.body?.limit === "number" ? request.body.limit : undefined,
        reviewer: queryString(request.body?.reviewer) ?? "local-bridge-stuck-migration",
        markRetryRequired: request.body?.markRetryRequired === true,
        markNoRunEvidence: request.body?.markNoRunEvidence === true,
      });
      localSnapshotCache.delete(options.repoRoot);
      response.json(result);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/controller/codex-continuation", (request, response) => {
    try {
      response.json(prepareCodexContinuation(options.repoRoot, {
        objective: queryString(request.body?.objective),
        maxItems: typeof request.body?.maxItems === "number" ? request.body.maxItems : undefined,
        mode: request.body?.launch === true ? "launch" : "prepare",
      }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/stream", (request, response) => {
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    streamClients.add(response);
    sendStreamEvent(response, "connected");
    request.on("close", () => streamClients.delete(response));
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

  app.get("/api/assistant/openapi.json", (request, response) => {
    response.json(assistantOpenApiSchema(`${request.protocol}://${request.get("host") ?? "127.0.0.1:8766"}`));
  });

  app.post("/api/assistant/intent", (request, response) => {
    try {
      const controllerHome = resolveControllerHome();
      const repository = registerRepository({ path: options.repoRoot, controllerHome });
      response.json(submitAssistantIntent(controllerHome, repository, {
        ...(request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {}),
        source: request.body?.source === "mcp" || request.body?.source === "local-ui" || request.body?.source === "mobile" || request.body?.source === "system"
          ? request.body.source
          : "chatgpt",
      }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/assistant/readiness", (_request, response) => {
    try {
      const controllerHome = resolveControllerHome();
      const repository = registerRepository({ path: options.repoRoot, controllerHome });
      response.json(buildAssistantReadinessReport(controllerHome, repository));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/recovery/probe", (_request, response) => {
    try {
      response.json(cachedLocalControllerSnapshot(options.repoRoot).recovery);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/recovery/plan", (_request, response) => {
    try {
      const recovery = cachedLocalControllerSnapshot(options.repoRoot).recovery;
      response.json({
        generatedAt: recovery.generatedAt,
        overallState: recovery.overallState,
        fallbackRequired: recovery.fallbackRequired,
        recommendedActions: recovery.recommendedActions,
        blockingCapabilities: recovery.capabilities.filter((capability) => ["blocked", "unavailable", "degraded"].includes(capability.state)),
        notes: recovery.notes,
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/recovery/apply", (request, response) => {
    try {
      const controllerHome = resolveControllerHome();
      const repository = registerRepository({ path: options.repoRoot, controllerHome });
      const actionId = queryString(request.body?.actionId) ?? queryString(request.body?.action_id) ?? "";
      const action = recoveryActionById(actionId);
      if (!action) throw new Error(`RECOVERY_ACTION_UNKNOWN: ${actionId}`);
      assertRecoveryAuthorized(action, action.confirmation === "none" ? action.id : request.body?.confirmAuthorization === true ? queryString(request.body?.authorization) : undefined);
      const reason = queryString(request.body?.reason) ?? "local controller recovery action";
      let result: Record<string, unknown>;
      let affectedPaths: string[] = [];
      if (action.id === "recovery.probe_again") {
        result = cachedLocalControllerSnapshot(options.repoRoot).recovery as unknown as Record<string, unknown>;
      } else if (action.id === "recovery.rebuild_projection" || action.id === "recovery.refresh_repository") {
        result = { projection: rebuildRepositoryProjection(controllerHome, repository.repoId) };
        affectedPaths = [".ai/harness/controller/projections"];
      } else if (action.id === "recovery.cleanup_preview") {
        result = previewRuntimeCleanup(options.repoRoot, { includeTempDirs: true, includeTerminalLocalJobs: true, includeLegacyRuns: true, includeHistoricalAttention: true }) as unknown as Record<string, unknown>;
      } else if (action.id === "recovery.reconcile_jobs") {
        result = applyRuntimeCleanup(options.repoRoot, { includeTempDirs: true, includeTerminalLocalJobs: true, includeLegacyRuns: true, includeHistoricalAttention: true, confirmCleanup: true }) as unknown as Record<string, unknown>;
        affectedPaths = [".ai/harness/local-jobs", ".ai/harness/jobs"];
      } else if (action.id === "recovery.restart_controller") {
        result = { daemon: ensureControllerDaemon(controllerHome) };
        affectedPaths = ["_ops/controller-home/daemon"];
      } else {
        result = { skipped: true, reason: `${action.id} is planned but not executable from the Local Bridge HTTP process.` };
      }
      const audit = writeRecoveryAuditRecord(controllerHome, repository.repoId, buildRecoveryAuditRecord({
        actor: "local-bridge-gui",
        action,
        result: result.skipped === true ? "skipped" : "succeeded",
        reason,
        affectedPaths,
      }));
      localSnapshotCache.delete(options.repoRoot);
      response.json({ action, audit, result });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/assistant/self-test/gmail-read", (request, response) => {
    try {
      const controllerHome = resolveControllerHome();
      const repository = registerRepository({ path: options.repoRoot, controllerHome });
      const query = queryString(request.body?.query) ?? "newer_than:1d";
      const maxResults = typeof request.body?.maxResults === "number" ? Math.max(1, Math.min(Math.trunc(request.body.maxResults), 10)) : 3;
      response.status(202).json(submitAssistantIntent(controllerHome, repository, {
        utterance: `测试读取 Gmail：${query}`,
        source: "local-ui",
        mode: "execute",
        requestId: queryString(request.body?.requestId),
        context: { query, max_results: maxResults },
      }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/assistant/inbox", (request, response) => {
    try {
      const limit = Number(request.query.limit);
      response.json(listAssistantInbox(options.repoRoot, Number.isFinite(limit) ? limit : 50));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.patch("/api/assistant/inbox/:itemId", (request, response) => {
    try {
      const status = request.body?.status;
      if (!["unread", "read", "archived"].includes(status)) throw new Error("ASSISTANT_INBOX_STATUS_INVALID: status must be unread, read, or archived");
      response.json({ item: updateAssistantInboxStatus(options.repoRoot, request.params.itemId, status) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/assistant/routines", (_request, response) => {
    try {
      response.json(listAssistantRoutines(options.repoRoot));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/assistant/routines", (request, response) => {
    try {
      const controllerHome = resolveControllerHome();
      const repository = registerRepository({ path: options.repoRoot, controllerHome });
      const result = submitAssistantIntent(controllerHome, repository, {
        utterance: queryString(request.body?.naturalLanguageGoal) ?? queryString(request.body?.utterance) ?? queryString(request.body?.name) ?? "create routine",
        source: "chatgpt",
        mode: "plan_then_execute",
        confirmRoutine: request.body?.confirmRoutine === true,
        timezone: queryString(request.body?.timezone),
        routine: {
          name: queryString(request.body?.name),
          naturalLanguageGoal: queryString(request.body?.naturalLanguageGoal),
          scheduleText: queryString(request.body?.scheduleText),
          timezone: queryString(request.body?.timezone),
          dataSources: Array.isArray(request.body?.dataSources) ? request.body.dataSources : undefined,
          output: request.body?.output,
          allowedActions: Array.isArray(request.body?.allowedActions) ? request.body.allowedActions : undefined,
          forbiddenActions: Array.isArray(request.body?.forbiddenActions) ? request.body.forbiddenActions : undefined,
        },
      });
      response.status(result.routine ? 201 : 200).json(result);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/assistant/routines/:routineId/run", (request, response) => {
    try {
      const controllerHome = resolveControllerHome();
      const repository = registerRepository({ path: options.repoRoot, controllerHome });
      response.status(202).json(runAssistantRoutineNow(controllerHome, repository, request.params.routineId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/assistant/routines/:routineId/pause", (request, response) => {
    try {
      response.json({ routine: updateAssistantRoutineStatus(options.repoRoot, request.params.routineId, "paused") });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/assistant/routines/:routineId/resume", (request, response) => {
    try {
      response.json({ routine: updateAssistantRoutineStatus(options.repoRoot, request.params.routineId, "enabled") });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/assistant/routines/:routineId/delete", (request, response) => {
    try {
      response.json({ routine: updateAssistantRoutineStatus(options.repoRoot, request.params.routineId, "deleted") });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/assistant/maintenance/cleanup-preview", (request, response) => {
    try {
      response.json(previewRuntimeCleanup(options.repoRoot, {
        minAgeMinutes: typeof request.body?.minAgeMinutes === "number" ? request.body.minAgeMinutes : undefined,
        includeTempDirs: request.body?.includeTempDirs !== false,
        includeTerminalLocalJobs: request.body?.includeTerminalLocalJobs === true,
        includeLegacyRuns: request.body?.includeLegacyRuns === true,
        includeHistoricalAttention: request.body?.includeHistoricalAttention === true,
        maxCandidates: typeof request.body?.maxCandidates === "number" ? request.body.maxCandidates : undefined,
      }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/assistant/maintenance/cleanup-apply", (request, response) => {
    try {
      response.json(applyRuntimeCleanup(options.repoRoot, {
        minAgeMinutes: typeof request.body?.minAgeMinutes === "number" ? request.body.minAgeMinutes : undefined,
        includeTempDirs: request.body?.includeTempDirs !== false,
        includeTerminalLocalJobs: request.body?.includeTerminalLocalJobs === true,
        includeLegacyRuns: request.body?.includeLegacyRuns === true,
        includeHistoricalAttention: request.body?.includeHistoricalAttention === true,
        maxCandidates: typeof request.body?.maxCandidates === "number" ? request.body.maxCandidates : undefined,
        confirmCleanup: request.body?.confirmCleanup === true,
      }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/assistant/memory", (_request, response) => {
    try {
      response.json(listAssistantMemory(options.repoRoot));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/assistant/memory", (request, response) => {
    try {
      response.json({ entry: upsertAssistantMemory(options.repoRoot, {
        key: queryString(request.body?.key) ?? "",
        value: queryString(request.body?.value) ?? "",
        source: queryString(request.body?.source) ?? "chatgpt",
      }) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/mobile/devices", (_request, response) => {
    try {
      response.json(listMobileIntentDevices(options.repoRoot));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/mobile/devices", (request, response) => {
    try {
      response.status(201).json(createMobileIntentDevice(options.repoRoot, {
        name: queryString(request.body?.name),
        deviceId: queryString(request.body?.deviceId),
        scopes: request.body?.scopes,
        rateLimitPerMinute: request.body?.rateLimitPerMinute,
      }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/mobile/devices/:deviceId/revoke", (request, response) => {
    try {
      response.json(revokeMobileIntentDevice(options.repoRoot, request.params.deviceId));
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
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
  app.post("/api/issues/:issueId/tasks/:taskId/verify", async (request, response) => {
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
      const checkResults = await Promise.all(task.checks.map(async (checkId) => {
        try {
          const result = await runControllerCheckAsync(options.repoRoot, checkId);
          return {
            checkId,
            ok: result.ok,
            summary: `${result.ok ? "Passed" : "Failed"} with persisted evidence ${result.artifactPath}`,
          };
        } catch (error) {
          return { checkId, ok: false, summary: errorMessage(error) };
        }
      }));
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
      const session = getEditSession(options.repoRoot, request.params.sessionId);
      const job = submitLocalBridgeJob(options.repoRoot, {
        action: "verify-edit-session",
        requestedBy: "local-controller",
        payload: {
          sessionId: session.sessionId,
          revision: session.currentRevision,
          requestId: queryString(request.body?.requestId),
          checkIds: Array.isArray(request.body?.checkIds) ? request.body.checkIds.map(String) : undefined,
          reviewer: queryString(request.body?.reviewer) ?? "local-controller-human",
          note: queryString(request.body?.note),
        },
      });
      if (job.status === "approved") asyncExecute(options.repoRoot, job.jobId);
      response.status(202).json({
        accepted: true,
        jobId: job.jobId,
        status: job.status,
        sessionId: session.sessionId,
        revision: session.currentRevision,
      });
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
  app.get("/api/toolchain/plugins/:pluginId/summary", (request, response) => {
    try {
      const controllerHome = resolveControllerHome();
      const repository = registerRepository({ path: options.repoRoot, controllerHome });
      const manifest = getAssistantPluginManifest(controllerHome, repository, request.params.pluginId);
      response.json({ plugin: summarizePluginForLowInterception(manifest) });
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/toolchain/web-targets", (_request, response) => {
    try {
      const controllerHome = resolveControllerHome();
      const repository = registerRepository({ path: options.repoRoot, controllerHome });
      const manifest = getAssistantPluginManifest(controllerHome, repository, "browser");
      response.json({ targets: listWebTargets(options.repoRoot, manifest), arbitraryUrlAccepted: false });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/toolchain/web-domain-preview", (request, response) => {
    try {
      const controllerHome = resolveControllerHome();
      const repository = registerRepository({ path: options.repoRoot, controllerHome });
      const manifest = getAssistantPluginManifest(controllerHome, repository, "browser");
      response.json({ preview: previewBrowserDomainAccess(options.repoRoot, request.body?.domain, request.body?.reason, manifest) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/toolchain/model-clients", (_request, response) => {
    response.json({ clients: buildModelClientSummary(), policyOwner: "repo-harness" });
  });
  app.get("/api/toolchain/model-control-plane", (_request, response) => {
    response.json({ controlPlane: buildModelControlPlaneSummary(), transportEncryption: "not-configured-by-this-tool" });
  });
  app.get("/api/toolchain/deepseek/tools", (_request, response) => {
    response.json({ provider: "deepseek", tools: deepSeekFunctionToolManifest(), policyOwner: "repo-harness" });
  });
  app.get("/api/toolchain/deepseek/controller-manifest", (_request, response) => {
    response.json({ manifest: deepSeekControllerManifest() });
  });
  app.post("/api/toolchain/deepseek/prepare", (request, response) => {
    try {
      const args = request.body?.functionArguments && typeof request.body.functionArguments === "object" && !Array.isArray(request.body.functionArguments)
        ? request.body.functionArguments as Record<string, unknown>
        : {};
      response.json({ prepared: prepareDeepSeekToolCall(String(request.body?.functionName ?? "").trim(), args) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/toolchain/deepseek/handoff", (request, response) => {
    try {
      const controllerHome = resolveControllerHome();
      const repository = registerRepository({ path: options.repoRoot, controllerHome });
      response.json({ handoff: prepareDeepSeekControllerHandoff({
        reason: request.body?.reason,
        objective: request.body?.objective,
        repoId: repository.repoId,
        currentController: request.body?.currentController,
        blockedToolName: request.body?.blockedToolName,
        recentSafeError: request.body?.recentSafeError,
      }) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/toolchain/deepseek/controller-request", (request, response) => {
    try {
      const controllerHome = resolveControllerHome();
      const repository = registerRepository({ path: options.repoRoot, controllerHome });
      response.json({ preview: prepareDeepSeekControllerRequest({
        reason: request.body?.reason,
        objective: request.body?.objective,
        userMessage: request.body?.userMessage,
        repoId: repository.repoId,
        currentController: request.body?.currentController,
        blockedToolName: request.body?.blockedToolName,
        recentSafeError: request.body?.recentSafeError,
        model: request.body?.model,
      }) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/plugins", (_request, response) => {
    try {
      const controllerHome = resolveControllerHome();
      const repository = registerRepository({ path: options.repoRoot, controllerHome });
      response.json({ plugins: listAssistantPluginManifests(controllerHome, repository) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/plugins/:pluginId", (request, response) => {
    try {
      const controllerHome = resolveControllerHome();
      const repository = registerRepository({ path: options.repoRoot, controllerHome });
      response.json({ plugin: getAssistantPluginManifest(controllerHome, repository, request.params.pluginId) });
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/plugins/:pluginId/actions/:actionId", (request, response) => {
    try {
      const controllerHome = resolveControllerHome();
      const repository = registerRepository({ path: options.repoRoot, controllerHome });
      const submitted = submitAssistantPluginAction(controllerHome, repository, {
        pluginId: request.params.pluginId,
        actionId: request.params.actionId,
        requestId: queryString(request.body?.requestId) ?? '',
        args: request.body?.arguments && typeof request.body.arguments === "object" && !Array.isArray(request.body.arguments)
          ? request.body.arguments as Record<string, unknown>
          : {},
        timeoutMs: typeof request.body?.timeoutMs === "number" ? request.body.timeoutMs : undefined,
        confirmAuthorization: request.body?.confirmAuthorization === true,
        confirmationText: queryString(request.body?.confirmationText),
        origin: { surface: "local-ui", actor: "local-controller", correlationId: queryString(request.body?.requestId) },
      });
      response.status(202).json({
        accepted: true,
        deduplicated: submitted.deduplicated,
        plugin: submitted.manifest,
        action: {
          actionId: submitted.action.actionId,
          risk: submitted.action.risk,
          confirmation: submitted.action.confirmation,
          requiredConfirmationText: submitted.action.requiredConfirmationText,
        },
        job: submitted.job,
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
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
  app.post("/api/runs/:runId/finish", (request, response) => {
    try {
      const result = finishTaskRun(options.repoRoot, {
        runId: request.params.runId,
        decision: String(request.body?.decision ?? "auto").replace(/-/g, "_") as never,
        reviewer: queryString(request.body?.reviewer) ?? "local-bridge-completion",
        note: queryString(request.body?.note),
        cleanup: request.body?.keepWorktree !== true,
        commit: request.body?.commit === true,
      });
      localSnapshotCache.delete(options.repoRoot);
      response.json(result);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
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

  const server = createServer(app);
  server.listen(requestedPort, host);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 120_000;
  server.on("close", () => {
    clearInterval(streamInterval);
    for (const client of streamClients) client.end();
    streamClients.clear();
    localSnapshotCache.delete(options.repoRoot);
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
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
