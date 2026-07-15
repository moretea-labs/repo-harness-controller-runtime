import type { CallToolResult as SdkCallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import { runProcess } from "../../effects/process-runner";
import {
  beginEditSession,
  applyEditOperations,
  createEditSavepoint,
  EditSessionPatchError,
  finalizeEditSession,
  getEditSession,
  getEditSessionDiff,
  listEditSessions,
  PREFERRED_EDIT_PATCH_BATCH_OPERATIONS,
  rollbackEditSession,
  verifyEditSession,
  type EditOperation,
} from "../editing/edit-session";
import {
  acceptTaskJob,
  dispatchAcceptedTaskJob,
  cancelAgentJob,
  getAgentJob,
  getAgentJobEvents,
  getAgentJobLog,
  listAgentJobs,
  retryAgentJob,
  startTaskJob,
} from "../agent-jobs/job-manager";
import {
  classifyGitHubCopilotPreflight,
  classifyLocalExecutorHealth,
  executorHealthCode,
  isExecutorHealthError,
  type ExecutorHealth,
} from "../agent-jobs/executor-health";
import { integrateAgentJob, taskRunDiff } from "../agent-jobs/integration";
import {
  appendTask,
  archiveIssue,
  createIssue,
  getIssue,
  getIssueEffectiveView,
  getIssueReadView,
  inspectIssueReadiness,
  inspectTaskReadiness,
  acceptVerifiedTask,
  listIssueEffectiveViews,
  listIssues,
  projectIssueEffectiveView,
  planIssue,
  projectBoard,
  recordTaskVerification,
  restoreIssue,
  setTaskDependencies,
  splitTask,
  supersedeTask,
  updateIssue,
  updateTask,
} from "../controller/issue-store";
import {
  listControllerChecks,
  runControllerCheckAsync,
} from "../controller/check-runner";
import { normalizeCheckIds } from '../../runtime/control-plane/facade/check-normalization';
import { listCapabilityDescriptors, summarizeCapabilityGroups } from '../../runtime/control-plane/facade/capability-registry';
import {
  getControllerTimeline,
  getProjectProgress,
  getTaskProgressDetail,
  getTaskProgressReadView,
} from "../controller/progress";
import { exportControllerWorklog, parseWorklogCategory } from "../controller/worklog";
import { inspectProjectGovernance, reconcileProjectGovernance } from "../controller/governance";
import { assessWorkMode } from "../controller/work-mode";
import { taskExecutionPolicy, taskWriteScopesConflict } from "../controller/execution-policy";
import { finishTaskRun } from "../controller/completion-orchestrator";
import { buildControllerTaskLedgerProjection } from "../controller/task-ledger";
import { buildControllerContextPack } from "../controller/context-pack";
import { loadControllerProjectState, saveControllerProjectState } from "../controller/project-state";
import {
  CONTROLLER_SCHEMA_VERSION,
  CONTROLLER_TOOL_SURFACE,
  CONTROLLER_TOOL_SURFACE_VERSION,
  controllerToolSurfaceFingerprint,
  MIN_AGENT_TIMEOUT_MS,
  formatDurationMs,
  normalizeAgentTimeoutMs,
} from "../controller/runtime-config";
import { PREFERRED_FACADE_TOOL_NAMES, STABLE_CONTROLLER_TOOL_NAMES } from "./toolset-names";
import { buildLocalConnectorStatusForRepo } from "../local-bridge/connector-freshness";
import type {
  ControllerAgent,
  ControllerTask,
  IssueKind,
  IssueStatus,
  TaskDraft,
  TaskRisk,
  TaskCommandEvidence,
  TaskStatus,
  TaskVerification,
} from "../controller/types";
import {
  gitDiff,
  gitSnapshot,
  readRepositoryRange,
  searchRepository,
} from "../repository/inspector";
import {
  closeGitHubIssue,
  getGitHubStatus,
  publishIssueToGitHub,
  refreshGitHubIssue,
} from "../github/github";
import {
  getGitHubPluginStatus,
  saveGitHubPluginConfig,
} from "../github/plugin";
import {
  executeLocalBridgeJob,
  getLocalBridgeJobEvents,
  getLocalBridgeJobSnapshot,
  listLocalBridgeJobs,
  readLocalBridgeJobOutput,
  reconcileLocalBridgeJobs,
  submitLocalBridgeJob,
} from "../local-bridge/job-store";
import type {
  LocalBridgeJobAction,
} from "../local-bridge/types";
import { runHelper } from "../runtime/helper-runner";
import {
  listSessions,
  openSession,
  readSession,
  runBrowserConsult,
  runBrowserFollowup,
} from "../chatgpt-browser/engine";
import type {
  BrowserProviderName,
  NativeBrowserChannel,
  ThinkingLevel,
} from "../chatgpt-browser/types";
import { hashMcpInput, tryWriteMcpAuditEntry } from "./audit";
import { loadMcpRuntimeState } from "./auth";
import { normalizeMcpRelativePath, resolveMcpPath } from "./paths";
import { currentGitBranch, isRepoHarnessAdopted } from "./repo";
import { repositoryToolNames } from "./repository-tools";
import { redactMcpText } from "./redaction";
import type { McpAgentRunnerName, McpPolicy } from "./types";

export interface McpToolContext {
  repoRoot: string;
  policy: McpPolicy;
  enableChatgptBrowser?: boolean;
  /** Controller-issued MCP execution identity; absent on legacy non-controller calls. */
  sessionId?: string;
  /** Authenticated or controller-issued principal used to scope session state. */
  principalId?: string;
  controllerInstanceId?: string;
  /** Bound repository identity for session cache keys. */
  repoId?: string;
  checkoutId?: string;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export type CallToolResult = Omit<SdkCallToolResult, "content"> & {
  content: Array<{ type: "text"; text: string }>;
};

const EMPTY_SCHEMA = { type: "object", additionalProperties: false };

function textResult(
  value: unknown,
  structuredContent: unknown = typeof value === "string" ? undefined : value,
): CallToolResult {
  const normalizedStructuredContent = structuredContent as Record<string, unknown> | undefined;
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: normalizedStructuredContent,
  };
}

function errorResult(
  code: string,
  message: string,
  details?: unknown,
): CallToolResult {
  const result = textResult({
    error: { code, message: redactMcpText(message).text, details },
  });
  result.isError = true;
  return result;
}

function dispatchErrorResult(
  code: string,
  message: string,
  options: {
    requestId?: string;
    retryable?: boolean;
    details?: unknown;
  } = {},
): CallToolResult {
  const payload = {
    accepted: false,
    code,
    message: redactMcpText(message).text,
    retryable: options.retryable === true,
    requestId: options.requestId,
    details: options.details,
  };
  const result = textResult({
    error: payload,
    ...payload,
  });
  result.isError = true;
  return result;
}

function audit(
  ctx: McpToolContext,
  tool: string,
  status: "ok" | "blocked" | "failed",
  input: unknown,
  targetPath?: string,
  error?: string,
): void {
  tryWriteMcpAuditEntry(ctx.repoRoot, {
    timestamp: new Date().toISOString(),
    tool,
    status,
    targetPath,
    inputHash: hashMcpInput(input),
    error,
  });
}

function isProbablyBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, Math.min(bytes.length, 8000)).includes(0);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileSummary(
  path: string,
  repoRoot: string,
): { path: string; size: number; modifiedAt: string } | null {
  try {
    const fileStat = statSync(join(repoRoot, path));
    if (!fileStat.isFile()) return null;
    return {
      path,
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
    };
  } catch (_error) {
    return null;
  }
}

function knownRunPathReplacements(
  repoRoot: string,
  run: Partial<{
    executionRoot: string;
    worktree: string;
    worktreePath: string;
  }>,
): Array<{ from: string; to: string }> {
  const replacements = new Map<string, string>();
  const remember = (from: string | undefined, to: string) => {
    if (!from || !from.startsWith("/")) return;
    replacements.set(from, to);
  };
  remember(repoRoot, "<repo>");
  remember(run.executionRoot, "<execution-root>");
  remember(run.worktreePath, "<worktree>");
  remember(run.worktree, run.worktree === repoRoot ? "<repo>" : "<worktree>");
  return [...replacements.entries()]
    .sort((left, right) => right[0].length - left[0].length)
    .map(([from, to]) => ({ from, to }));
}

function redactRunText(
  text: string,
  repoRoot: string,
  run: Partial<{
    executionRoot: string;
    worktree: string;
    worktreePath: string;
  }>,
  maxChars: number,
): { text: string; truncated: boolean; redactions: Array<{ type: string; count: number }> } {
  let scrubbed = text;
  for (const entry of knownRunPathReplacements(repoRoot, run)) {
    scrubbed = scrubbed.split(entry.from).join(entry.to);
  }
  scrubbed = scrubbed
    .replace(/\/(?:private\/)?tmp\/[^\s"']+/g, "<abs-path>")
    .replace(/\/(?:private\/)?var\/folders\/[^\s"']+/g, "<abs-path>")
    .replace(/\/Users\/[^\s"']+/g, "<abs-path>")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<abs-path>");
  const redacted = redactMcpText(scrubbed);
  if (redacted.text.length <= maxChars) {
    return { text: redacted.text, truncated: false, redactions: redacted.redactions };
  }
  return {
    text: redacted.text.slice(-maxChars),
    truncated: true,
    redactions: redacted.redactions,
  };
}

function maybeTail(
  value: string | undefined,
  repoRoot: string,
  run: Partial<{
    executionRoot: string;
    worktree: string;
    worktreePath: string;
  }>,
  maxChars: number,
): { text: string; truncated: boolean; redactions: Array<{ type: string; count: number }> } | undefined {
  if (!value) return undefined;
  return redactRunText(value, repoRoot, run, maxChars);
}

function summarizeAgentRun(
  repoRoot: string,
  run: Record<string, unknown>,
  options: {
    includePaths?: boolean;
    includeOutput?: boolean;
    tailChars?: number;
  } = {},
): Record<string, unknown> {
  const tailChars = Math.min(Math.max(options.tailChars ?? 4096, 256), 16 * 1024);
  const base: Record<string, unknown> = {
    runId: run.runId,
    issueId: run.issueId,
    taskId: run.taskId,
    agent: run.agent,
    provider: run.provider,
    executionMode: run.executionMode,
    executionClass: run.executionClass,
    allowedPaths: run.allowedPaths,
    status: run.status,
    closureState: run.closureState,
    closureUpdatedAt: run.closureUpdatedAt,
    preservationReason: run.preservationReason,
    preservationDetails: typeof run.preservationDetails === "string"
      ? redactRunText(run.preservationDetails, repoRoot, {
        executionRoot: typeof run.executionRoot === "string" ? run.executionRoot : undefined,
        worktree: typeof run.worktree === "string" ? run.worktree : undefined,
        worktreePath: typeof run.worktreePath === "string" ? run.worktreePath : undefined,
      }, 1000).text
      : run.preservationDetails,
    branch: run.branch,
    baseRevision: run.baseRevision,
    changedFiles: Array.isArray(run.changedFiles) ? run.changedFiles.slice(0, 100) : run.changedFiles,
    exitCode: run.exitCode,
    error: typeof run.error === "string"
      ? redactRunText(run.error, repoRoot, {
        executionRoot: typeof run.executionRoot === "string" ? run.executionRoot : undefined,
        worktree: typeof run.worktree === "string" ? run.worktree : undefined,
        worktreePath: typeof run.worktreePath === "string" ? run.worktreePath : undefined,
      }, 1000).text
      : run.error,
    executorHealth: run.executorHealth,
    timeoutMs: run.timeoutMs,
    deadlineAt: run.deadlineAt,
    startupDeadlineAt: run.startupDeadlineAt,
    lastHeartbeatAt: run.lastHeartbeatAt,
    progress: run.progress,
    autoIntegrate: run.autoIntegrate,
    autoIntegrationError: typeof run.autoIntegrationError === "string"
      ? redactRunText(run.autoIntegrationError, repoRoot, {
        executionRoot: typeof run.executionRoot === "string" ? run.executionRoot : undefined,
        worktree: typeof run.worktree === "string" ? run.worktree : undefined,
        worktreePath: typeof run.worktreePath === "string" ? run.worktreePath : undefined,
      }, 1000).text
      : run.autoIntegrationError,
    worktreeCleanedAt: run.worktreeCleanedAt,
    cleanupBranchDeletedAt: run.cleanupBranchDeletedAt,
    diffArtifactPath: run.diffArtifactPath,
    terminationReason: run.terminationReason,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    integratedSessionId: run.integratedSessionId,
    integratedAt: run.integratedAt,
    timing: run.timing,
    github: run.github && typeof run.github === "object"
      ? {
        owner: (run.github as Record<string, unknown>).owner,
        repo: (run.github as Record<string, unknown>).repo,
        taskId: (run.github as Record<string, unknown>).taskId,
        state: (run.github as Record<string, unknown>).state,
        url: (run.github as Record<string, unknown>).url,
        pullRequestUrl: (run.github as Record<string, unknown>).pullRequestUrl,
        baseRef: (run.github as Record<string, unknown>).baseRef,
        model: (run.github as Record<string, unknown>).model,
        createPullRequest: (run.github as Record<string, unknown>).createPullRequest,
      }
      : run.github,
    detail: {
      pathsIncluded: options.includePaths === true,
      outputIncluded: options.includeOutput !== false,
      next: {
        log: "Call get_task_run_log for a larger bounded tail.",
        diff: "Call get_task_diff to inspect Git changes from an isolated worktree.",
      },
    },
  };
  if (options.includeOutput !== false) {
    const stdout = maybeTail(
      typeof run.stdoutTail === "string" ? run.stdoutTail : undefined,
      repoRoot,
      {
        executionRoot: typeof run.executionRoot === "string" ? run.executionRoot : undefined,
        worktree: typeof run.worktree === "string" ? run.worktree : undefined,
        worktreePath: typeof run.worktreePath === "string" ? run.worktreePath : undefined,
      },
      tailChars,
    );
    const stderr = maybeTail(
      typeof run.stderrTail === "string" ? run.stderrTail : undefined,
      repoRoot,
      {
        executionRoot: typeof run.executionRoot === "string" ? run.executionRoot : undefined,
        worktree: typeof run.worktree === "string" ? run.worktree : undefined,
        worktreePath: typeof run.worktreePath === "string" ? run.worktreePath : undefined,
      },
      tailChars,
    );
    if (stdout) {
      base.stdoutTail = stdout.text;
      base.stdoutTailTruncated = stdout.truncated;
    }
    if (stderr) {
      base.stderrTail = stderr.text;
      base.stderrTailTruncated = stderr.truncated;
    }
    const redactions = [...(stdout?.redactions ?? []), ...(stderr?.redactions ?? [])];
    if (redactions.length > 0) base.redactions = redactions;
  }
  if (options.includePaths === true) {
    Object.assign(base, {
      repoRoot: run.repoRoot,
      executionRoot: run.executionRoot,
      worktree: run.worktree,
      worktreePath: run.worktreePath,
      promptPath: run.promptPath,
      stdoutPath: run.stdoutPath,
      stderrPath: run.stderrPath,
      resultPath: run.resultPath,
      eventsPath: run.eventsPath,
      controllerPid: run.controllerPid,
      controllerEpoch: run.controllerEpoch,
      controllerEpochPath: run.controllerEpochPath,
      launchPid: run.launchPid,
      workerPid: run.workerPid,
      agentPid: run.agentPid,
    });
  }
  return base;
}

function summarizeRunList(
  repoRoot: string,
  runs: Array<Record<string, unknown>>,
  includePaths = false,
): Array<Record<string, unknown>> {
  return runs.map((run) => summarizeAgentRun(repoRoot, run, { includePaths, includeOutput: false }));
}

function compactDispatchRun(run: Record<string, unknown>): Record<string, unknown> {
  const runId = typeof run.runId === "string" ? run.runId : String(run.runId ?? "");
  const detail: Record<string, unknown> = runId
    ? {
      get_task_run: { run_id: runId },
      get_task_run_log: { run_id: runId },
      get_task_run_events: { run_id: runId },
      get_task_diff: { run_id: runId },
    }
    : {};
  return {
    runId: run.runId,
    issueId: run.issueId,
    taskId: run.taskId,
    status: run.status,
    agent: run.agent,
    provider: run.provider,
    executionMode: run.executionMode,
    executionClass: run.executionClass,
    timeoutMs: run.timeoutMs,
    startedAt: run.startedAt,
    deadlineAt: run.deadlineAt,
    finishedAt: run.finishedAt,
    integratedSessionId: run.integratedSessionId,
    autoIntegrationError: run.autoIntegrationError,
    worktreeCleanedAt: run.worktreeCleanedAt,
    accepted: run.accepted,
    reused: run.reused,
    github: run.github,
    error: run.error,
    detail,
  };
}

function compactTaskView(task: Record<string, unknown>): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    effectiveStatus: task.effectiveStatus,
    declaredStatus: task.declaredStatus,
    latestRunId: task.latestRunId,
    latestRunStatus: task.latestRunStatus,
    activeRunId: task.activeRunId,
    activeRunStatus: task.activeRunStatus,
    verificationStatus: task.verificationStatus,
    dispatchable: task.dispatchable,
    retryable: task.retryable,
    requiresExplicitRetry: task.requiresExplicitRetry,
  };
}

function compactIssueView(issue: Record<string, unknown>): Record<string, unknown> {
  const id = typeof issue.id === "string" ? issue.id : String(issue.id ?? "");
  const tasks = Array.isArray(issue.tasks) ? issue.tasks as Array<Record<string, unknown>> : [];
  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    lifecycleStatus: issue.lifecycleStatus,
    github: issue.github,
    taskCount: tasks.length,
    tasks: tasks.map((task) => compactTaskView(task)),
    detail: id ? { get_issue: { issue_id: id } } : {},
  };
}

function dispatchExecutorHealthResult(
  health: ExecutorHealth,
  options: { requestId?: string; retryable?: boolean } = {},
): CallToolResult {
  return dispatchErrorResult(executorHealthCode(health), health.message, {
    requestId: options.requestId,
    retryable: options.retryable,
    details: { executorHealth: health },
  });
}

function taskExecutorHealth(
  ctx: McpToolContext,
  task: ControllerTask,
  agent: ControllerAgent,
  githubRepo?: string,
): ExecutorHealth | null {
  if (agent === "github-copilot") {
    return classifyGitHubCopilotPreflight(
      getGitHubStatus(ctx.repoRoot, githubRepo),
      task,
    );
  }
  return classifyLocalExecutorHealth(
    agent,
    {
      agentRunner: ctx.policy.execution.agentRunner,
      allowedAgents: ctx.policy.execution.allowedAgents,
    },
    task,
  );
}

function listFilesUnder(
  repoRoot: string,
  root: string,
  maxFiles: number,
  out: string[],
): void {
  if (out.length >= maxFiles) return;
  const absoluteRoot = join(repoRoot, root);
  if (!existsSync(absoluteRoot)) return;
  const rootStat = statSync(absoluteRoot);
  if (rootStat.isFile()) {
    out.push(root);
    return;
  }
  if (!rootStat.isDirectory()) return;
  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (out.length >= maxFiles) return;
    const child = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      listFilesUnder(repoRoot, child, maxFiles, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(child);
    }
  }
}

function workflowFileCandidates(repoRoot: string): string[] {
  const roots = [
    "AGENTS.md",
    "CLAUDE.md",
    "SKILL.md",
    "docs/spec.md",
    "docs/domain-rules.md",
    "docs/project/chatgpt-planning-profile.md",
    "docs/reference-configs",
    "docs/mvp2",
    ".spec-workflow/specs",
    "ios/AGENTS.md",
    "plans",
    "tasks",
    ".ai/context",
    ".ai/harness/handoff",
    ".ai/harness/checks",
  ];
  const files: string[] = [];
  for (const root of roots) {
    const rootFiles: string[] = [];
    listFilesUnder(repoRoot, root, 700, rootFiles);
    files.push(...rootFiles);
  }
  return Array.from(new Set(files)).sort();
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "artifact"
  );
}

function timestampPrefix(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}`;
}

function parseRunnerAgent(value: unknown): McpAgentRunnerName | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "codex" || normalized === "claude" ? normalized : null;
}

function parseControllerAgent(value: unknown): ControllerAgent | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "codex" ||
    normalized === "claude" ||
    normalized === "github-copilot"
    ? normalized
    : null;
}

function resolveDispatchAgent(
  ctx: McpToolContext,
  task: ControllerTask,
  requested: unknown,
): ControllerAgent | null {
  const hasExplicitRequest = requested !== undefined && requested !== null && String(requested).trim() !== "";
  if (hasExplicitRequest) return parseControllerAgent(requested);
  if (task.recommendedAgent) return task.recommendedAgent;
  const firstLocal = ctx.policy.execution.allowedAgents[0];
  return firstLocal ?? task.recommendedAgent ?? null;
}

function parseLocalBridgeAction(value: unknown): LocalBridgeJobAction | null {
  const normalized = String(value ?? "").trim();
  return normalized === "launch-task" ||
    normalized === "quick-agent-session" ||
    normalized === "run-check" ||
    normalized === "verify-edit-session" ||
    normalized === "repository-command"
    ? normalized
    : null;
}

function localBridgeRequestFromArgs(args: Record<string, unknown>) {
  const action = parseLocalBridgeAction(args.action);
  if (!action)
    throw new Error(
      "action must be launch-task, quick-agent-session, or run-check",
    );
  const requestedBy =
    String(args.requested_by ?? "chatgpt").trim() || "chatgpt";
  if (action === "launch-task") {
    const issueId = String(args.issue_id ?? "").trim();
    const taskId = String(args.task_id ?? "").trim();
    if (!issueId || !taskId)
      throw new Error("launch-task requires issue_id and task_id");
    return {
      action,
      requestedBy,
      payload: {
        issueId,
        taskId,
        requestId: typeof args.request_id === "string" ? args.request_id.trim() || undefined : undefined,
        agent: parseControllerAgent(args.agent) ?? undefined,
        isolate: typeof args.isolate === "boolean" ? args.isolate : undefined,
        timeoutMs:
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        githubRepo:
          typeof args.github_repo === "string" ? args.github_repo : undefined,
        baseRef: typeof args.base_ref === "string" ? args.base_ref : undefined,
        model: typeof args.model === "string" ? args.model : undefined,
        createPullRequest:
          typeof args.create_pull_request === "boolean"
            ? args.create_pull_request
            : undefined,
        approveDestructive: args.approve_destructive === true,
      },
    } as const;
  }
  if (action === "run-check") {
    const checkId = String(args.check_id ?? "").trim();
    if (!checkId) throw new Error("run-check requires check_id");
    return {
      action,
      requestedBy,
      payload: {
        checkId,
        timeoutMs:
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
      },
    } as const;
  }
  const title = String(args.title ?? "").trim();
  const objective = String(args.objective ?? "").trim();
  if (!title || !objective)
    throw new Error("quick-agent-session requires title and objective");
  const agent = parseControllerAgent(args.agent);
  if (agent === "github-copilot")
    throw new Error("quick-agent-session supports local codex or claude only");
  return {
    action,
    requestedBy,
    payload: {
      title,
      objective,
      requestId: typeof args.request_id === "string" ? args.request_id.trim() || undefined : undefined,
      summary: typeof args.summary === "string" ? args.summary : undefined,
      allowedPaths: stringList(args.allowed_paths),
      forbiddenPaths: stringList(args.forbidden_paths),
      checks: stringList(args.checks),
      acceptanceCriteria: stringList(args.acceptance_criteria),
      risk: ["readonly", "low", "medium", "high", "destructive"].includes(String(args.risk)) ? args.risk as TaskRisk : "low",
      agent: agent === "claude" || agent === "codex" ? agent : undefined,
      isolate: typeof args.isolate === "boolean" ? args.isolate : undefined,
      timeoutMs:
        typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
      ephemeral: typeof args.ephemeral === "boolean" ? args.ephemeral : true,
      approveDestructive: args.approve_destructive === true,
    },
  } as const;
}

function runnerGoalPath(args: Record<string, unknown>): string {
  return String(args.goal_path ?? ".ai/harness/handoff/codex-goal.md").trim();
}

function runnerTimeoutMs(ctx: McpToolContext, value: unknown): number {
  return normalizeAgentTimeoutMs(value, {
    defaultMs: ctx.policy.execution.runnerTimeoutMs,
    maxMs: ctx.policy.execution.runnerMaxTimeoutMs,
    label: "timeout_ms",
  });
}

function runAgentGoal(
  ctx: McpToolContext,
  args: Record<string, unknown>,
): CallToolResult {
  if (!ctx.policy.execution.agentRunner || !ctx.policy.execution.codexRunner) {
    audit(
      ctx,
      "run_agent_goal",
      "blocked",
      args,
      undefined,
      "dev runner is disabled",
    );
    return errorResult(
      "DEV_RUNNER_DISABLED",
      "MCP dev runner is disabled. Start the orchestrator profile with an explicit dev-runner setting.",
    );
  }

  const agent = parseRunnerAgent(args.agent);
  if (!agent) {
    audit(ctx, "run_agent_goal", "blocked", args, undefined, "invalid agent");
    return errorResult("INVALID_AGENT", "agent must be codex or claude");
  }
  if (!ctx.policy.execution.allowedAgents.includes(agent)) {
    audit(
      ctx,
      "run_agent_goal",
      "blocked",
      args,
      undefined,
      `agent is not allowed: ${agent}`,
    );
    return errorResult(
      "AGENT_DENIED",
      `agent is not enabled for this MCP dev runner: ${agent}`,
    );
  }

  const goalPath = runnerGoalPath(args);
  const decision = resolveMcpPath(ctx.repoRoot, goalPath, ctx.policy, "read");
  if (!decision.ok || !decision.absolutePath || !decision.relativePath) {
    audit(ctx, "run_agent_goal", "blocked", args, goalPath, decision.reason);
    return errorResult("POLICY_DENIED", decision.reason ?? "goal path denied", {
      path: goalPath,
    });
  }

  const fileStat = statSync(decision.absolutePath);
  if (!fileStat.isFile())
    return errorResult(
      "NOT_A_FILE",
      `goal path is not a file: ${decision.relativePath}`,
    );
  if (fileStat.size > ctx.policy.maxFileBytes)
    return errorResult(
      "FILE_TOO_LARGE",
      `goal exceeds ${ctx.policy.maxFileBytes} bytes`,
    );

  const rawGoal = readFileSync(decision.absolutePath, "utf-8");
  const redactedGoal = redactMcpText(rawGoal);
  const prompt = [
    "Execute this repo-harness dev-mode agent handoff from the local repository.",
    "Respect the goal text exactly. Do not reveal secrets or credentials in your final output.",
    "",
    redactedGoal.text,
  ].join("\n");
  const timeoutMs = runnerTimeoutMs(ctx, args.timeout_ms);
  const command =
    agent === "codex"
      ? {
          bin: "codex",
          args: ["exec", "--json", "--cd", ctx.repoRoot, prompt],
          preview: `codex exec --json --cd ${ctx.repoRoot} <goal>`,
        }
      : { bin: "claude", args: ["-p", prompt], preview: "claude -p <goal>" };
  const result = runProcess(command.bin, command.args, {
    cwd: ctx.repoRoot,
    timeoutMs,
    maxOutputBytes: 128 * 1024,
  });
  const stdout = redactMcpText(result.stdout);
  const stderr = redactMcpText(result.stderr || result.error);
  audit(
    ctx,
    "run_agent_goal",
    result.ok ? "ok" : "failed",
    args,
    decision.relativePath,
    stderr.text,
  );
  return textResult({
    agent,
    goalPath: decision.relativePath,
    command: command.preview,
    exitCode: result.status,
    timedOut: result.timedOut,
    stdout: stdout.text,
    stderr: stderr.text,
    redactions: [
      ...redactedGoal.redactions,
      ...stdout.redactions,
      ...stderr.redactions,
    ],
  });
}

function prdArtifactPath(slug: string): string {
  const normalized = slugify(slug);
  const prefixed = /^\d{8}-\d{4}-/.test(normalized)
    ? normalized
    : `${timestampPrefix()}-${normalized}`;
  return `plans/prds/${prefixed}.prd.md`;
}

function sprintArtifactPath(slug: string): string {
  const normalized = slugify(slug);
  const prefixed = /^\d{8}-\d{4}-/.test(normalized)
    ? normalized
    : `${timestampPrefix()}-${normalized}`;
  return `plans/sprints/${prefixed}.sprint.md`;
}

function frontmatter(title: string, kind: string): string {
  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    `kind: ${JSON.stringify(kind)}`,
    `created_at: ${JSON.stringify(new Date().toISOString())}`,
    `source: "repo-harness-mcp"`,
    "---",
    "",
  ].join("\n");
}

function bodyWithFrontmatter(
  title: string,
  kind: string,
  body: string,
): string {
  return body.trimStart().startsWith("---")
    ? body.trimEnd() + "\n"
    : `${frontmatter(title, kind)}${body.trimEnd()}\n`;
}

function writeMarkdownArtifact(
  ctx: McpToolContext,
  tool: string,
  relativePath: string,
  title: string,
  kind: string,
  body: string,
  overwrite: boolean,
  input: unknown,
  extra?: Record<string, unknown>,
): CallToolResult {
  const decision = resolveMcpPath(
    ctx.repoRoot,
    relativePath,
    ctx.policy,
    "write",
  );
  if (!decision.ok || !decision.absolutePath) {
    audit(ctx, tool, "blocked", input, relativePath, decision.reason);
    return errorResult("POLICY_DENIED", decision.reason ?? "path denied", {
      path: relativePath,
    });
  }
  if (existsSync(decision.absolutePath) && !overwrite) {
    audit(
      ctx,
      tool,
      "blocked",
      input,
      relativePath,
      "target exists and overwrite was not requested",
    );
    return errorResult(
      "WOULD_OVERWRITE",
      `target already exists: ${relativePath}`,
    );
  }
  mkdirSync(dirname(decision.absolutePath), { recursive: true });
  writeFileSync(
    decision.absolutePath,
    bodyWithFrontmatter(title, kind, body),
    "utf-8",
  );
  audit(ctx, tool, "ok", input, relativePath);
  return textResult({
    status: "written",
    path: relativePath,
    ...(extra ?? {}),
  });
}

function validateGoal(body: string): string[] {
  return [
    "# Codex Goal",
    "## Source of truth",
    "## Role",
    "## Scope",
    "## Required workflow",
    "## Required checks",
    "## Done when",
  ].filter((section) => !body.includes(section));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
}

function taskObjects(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

function controllerTaskDrafts(value: unknown): TaskDraft[] {
  return taskObjects(value).map((task) => ({
    title: String(task.title ?? "").trim(),
    objective: String(task.objective ?? "").trim(),
    dependsOn: stringList(task.depends_on ?? task.dependsOn),
    allowedPaths: stringList(task.allowed_paths ?? task.allowedPaths),
    forbiddenPaths: stringList(task.forbidden_paths ?? task.forbiddenPaths),
    checks: stringList(task.checks),
    acceptanceCriteria: stringList(
      task.acceptance_criteria ?? task.acceptanceCriteria,
    ),
    risk: (["readonly", "low", "medium", "high", "destructive"].includes(String(task.risk))
      ? String(task.risk)
      : "medium") as TaskRisk,
    recommendedAgent:
      parseControllerAgent(task.agent ?? task.recommendedAgent) ?? undefined,
  }));
}

function controllerEditOperations(value: unknown): EditOperation[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    )
    .map((entry) => {
      const type = String(entry.type);
      const path = String(entry.path ?? "");
      const expectedSha256 = String(entry.expected_sha256 ?? entry.expectedSha256 ?? "");
      if (type === "create") return { type, path, content: String(entry.content ?? "") };
      if (type === "delete") return { type, path, expectedSha256 };
      if (type === "write") return { type, path, expectedSha256, content: String(entry.content ?? "") };
      if (type === "replace") {
        return {
          type,
          path,
          expectedSha256,
          replacements: taskObjects(entry.replacements).map((replacement) => ({
            oldText: String(replacement.old_text ?? replacement.oldText ?? ""),
            newText: String(replacement.new_text ?? replacement.newText ?? ""),
            replaceAll: replacement.replace_all === true || replacement.replaceAll === true,
          })),
        };
      }
      if (type === "insert_before" || type === "insert_after") {
        return {
          type,
          path,
          expectedSha256,
          anchor: String(entry.anchor ?? ""),
          content: String(entry.content ?? ""),
          occurrence: typeof entry.occurrence === "number" ? Math.trunc(entry.occurrence) : undefined,
        };
      }
      if (type === "prepend" || type === "append") {
        return { type, path, expectedSha256, content: String(entry.content ?? "") };
      }
      throw new Error(`invalid edit operation type: ${type}`);
    });
}

function renderPrdFromIdeaBody(args: Record<string, unknown>): string {
  const title = String(args.title ?? "Untitled PRD").trim() || "Untitled PRD";
  const idea = String(args.idea ?? "").trim();
  const problem =
    String(args.problem ?? "").trim() ||
    "TBD: clarify the concrete user or workflow pain.";
  const users = stringList(args.users);
  const goals = stringList(args.goals);
  const nonGoals = stringList(args.non_goals);
  const success = stringList(args.success_criteria);
  const notes = String(args.notes ?? "").trim();
  return [
    `# ${title}`,
    "",
    "> **Status**: Draft",
    "",
    "## Idea",
    "",
    idea || "TBD: summarize the originating idea.",
    "",
    "## Problem",
    "",
    problem,
    "",
    "## Users",
    "",
    ...(users.length > 0 ? users.map((entry) => `- ${entry}`) : ["- TBD"]),
    "",
    "## Goals",
    "",
    ...(goals.length > 0
      ? goals.map((entry) => `- ${entry}`)
      : ["- Turn the idea into a reviewable repo-harness PRD."]),
    "",
    "## Non-goals",
    "",
    ...(nonGoals.length > 0
      ? nonGoals.map((entry) => `- ${entry}`)
      : ["- Directly executing implementation work from ChatGPT."]),
    "",
    "## Acceptance Criteria",
    "",
    ...(success.length > 0
      ? success.map((entry) => `- [ ] ${entry}`)
      : [
          "- [ ] The PRD can be converted into a checklist Sprint with staged verification gates.",
        ]),
    "",
    "## Workflow Contract",
    "",
    "- PRD is the source of product intent.",
    "- Sprint must be generated as ordered checklist task cards.",
    "- Codex execution must happen through a host-native `/goal` prompt or local Codex session, not through remote MCP execution.",
    "",
    "## Handoff Notes",
    "",
    notes || "- Generated from an idea through repo-harness MCP.",
  ].join("\n");
}

function renderChecklistSprintBody(args: Record<string, unknown>): string {
  const title =
    String(args.title ?? "Checklist Sprint").trim() || "Checklist Sprint";
  const prdPath = String(args.prd_path ?? "").trim();
  const tasks = taskObjects(args.tasks);
  const taskBlocks =
    tasks.length > 0
      ? tasks.map((task, index) => {
          const taskTitle =
            String(task.title ?? `Task ${index + 1}`).trim() ||
            `Task ${index + 1}`;
          const objective =
            String(task.objective ?? "").trim() ||
            "Complete the scoped implementation slice.";
          const files = stringList(task.files);
          const checks = stringList(task.checks);
          const stageGate =
            String(task.stage_gate ?? "").trim() ||
            "Update this checklist, run relevant checks, and stage the completed slice before continuing.";
          return [
            `### Task Card ${index + 1}: ${taskTitle}`,
            "",
            `- [ ] Objective: ${objective}`,
            `- [ ] Files/entrypoints: ${files.length > 0 ? files.map((entry) => `\`${entry}\``).join(", ") : "TBD during execution"}`,
            `- [ ] Verification: ${checks.length > 0 ? checks.map((entry) => `\`${entry}\``).join(", ") : "Focused check for this slice"}`,
            `- [ ] Stage gate: ${stageGate}`,
          ].join("\n");
        })
      : [
          [
            "### Task Card 1: Plan the first implementation slice",
            "",
            "- [ ] Objective: Derive the first concrete implementation slice from the PRD.",
            "- [ ] Files/entrypoints: TBD during execution",
            "- [ ] Verification: Focused check for this slice",
            "- [ ] Stage gate: Update this checklist, run relevant checks, and stage the completed slice before continuing.",
          ].join("\n"),
        ];

  return (
    [
      `# ${title}`,
      "",
      "> **Status**: Draft",
      "",
      "## Source",
      "",
      `- PRD: \`${prdPath || "TBD"}\``,
      "",
      "## Execution Rule",
      "",
      "- Execute task cards in order.",
      "- Keep each task card reviewable as one staged slice.",
      "- After every completed phase, update the checklist and stage the result before continuing.",
      "- Do not treat unstaged work as a completed phase.",
      "",
      "## Checklist",
      "",
      ...taskBlocks.flatMap((block) => [block, ""]),
      "## Final Acceptance",
      "",
      "- [ ] All task cards are checked.",
      "- [ ] Required checks pass.",
      "- [ ] Handoff explains staged state, residual risks, and next bottleneck if any.",
    ]
      .join("\n")
      .trimEnd() + "\n"
  );
}

function renderCodexGoalFromSprint(args: Record<string, unknown>): {
  body: string;
  prompt: string;
} {
  const prdPath = String(args.prd_path ?? "").trim();
  const sprintPath = String(args.sprint_path ?? "").trim();
  const goalPrdPath = String(args.goal_prd_path ?? prdPath).trim() || prdPath;
  const goalSprintPath =
    String(args.goal_sprint_path ?? sprintPath).trim() || sprintPath;
  const referenceRepo = String(args.reference_repo ?? "").trim();
  const extraInstructions = String(args.extra_instructions ?? "").trim();
  const prompt = [
    "/goal",
    `Read: ${goalPrdPath}`,
    `Open or use a worktree and complete: ${goalSprintPath}`,
    "After each completed phase, stage the result before continuing.",
    "Use the user's language for status reports unless repo-local instructions require otherwise.",
    referenceRepo ? `Reference repo: ${referenceRepo}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const body = [
    "# Codex Goal",
    "",
    "## Source of truth",
    "",
    `- PRD: \`${goalPrdPath}\``,
    `- Checklist Sprint: \`${goalSprintPath}\``,
    ...(referenceRepo
      ? [`- Reference repo: \`${referenceRepo}\` (read-only comparison source)`]
      : []),
    "",
    "## Role",
    "",
    "Codex is the executor. ChatGPT/repo-harness may prepare planning artifacts, but implementation ownership stays in the local Codex session.",
    "",
    "## Scope",
    "",
    "- Open or use an isolated worktree for the sprint implementation.",
    "- Execute the checklist Sprint task cards in order.",
    "- Update the Sprint checklist as phases complete.",
    "- Stage each completed phase before continuing to the next phase.",
    "- Do not modify the reference repo or ignored secrets/ops state.",
    "",
    "## Required workflow",
    "",
    "1. Read the PRD and Sprint paths above before editing.",
    "2. Build the P1/P2/P3 map required by repo-local AGENTS.md for non-trivial changes.",
    "3. Execute one checklist task card at a time.",
    "4. After each phase, run the relevant focused checks, update the checklist, and stage the completed slice.",
    "5. Continue until the Sprint checklist is complete or a real blocker is reached.",
    "6. Leave a concise handoff with staged state and verification evidence.",
    ...(extraInstructions ? ["", extraInstructions] : []),
    "",
    "## Required checks",
    "",
    "- Run the checks named by the Sprint task card.",
    "- At sprint closeout, run repo-required checks unless the Sprint narrows the verification surface with a stated reason.",
    "",
    "## Done when",
    "",
    "- The checklist Sprint is complete.",
    "- Every completed phase is staged.",
    "- Checks pass or failures are documented with exact blocker evidence.",
    "- No commit is created unless the user explicitly asks for commit.",
    "",
    "## Host-native /goal prompt",
    "",
    "```text",
    prompt,
    "```",
  ].join("\n");
  return { body, prompt };
}

function parseThinking(value: unknown): ThinkingLevel | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    value === "light" ||
    value === "standard" ||
    value === "extended" ||
    value === "heavy"
  )
    return value;
  throw new Error(`invalid thinking level: ${String(value)}`);
}

function parseBrowserProvider(value: unknown): BrowserProviderName | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "oracle" || value === "native") return value;
  throw new Error(`invalid browser provider: ${String(value)}`);
}

function parseNativeBrowserChannel(
  value: unknown,
): NativeBrowserChannel | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    value === "chrome" ||
    value === "chrome-beta" ||
    value === "chrome-dev" ||
    value === "chrome-canary"
  )
    return value;
  throw new Error(`invalid browser channel: ${String(value)}`);
}

export function buildMcpToolDefinitions(
  policy: McpPolicy,
  opts: { enableChatgptBrowser?: boolean } = {},
): McpToolDefinition[] {
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = {
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: false,
  };
  const stringPathSchema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  };
  const markdownWriterSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      slug: { type: "string" },
      body: { type: "string" },
      overwrite: { type: "boolean" },
    },
    required: ["title", "slug", "body"],
    additionalProperties: false,
  };
  const ideaPrdSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      slug: { type: "string" },
      idea: { type: "string" },
      problem: { type: "string" },
      users: { type: "array", items: { type: "string" } },
      goals: { type: "array", items: { type: "string" } },
      non_goals: { type: "array", items: { type: "string" } },
      success_criteria: { type: "array", items: { type: "string" } },
      notes: { type: "string" },
      overwrite: { type: "boolean" },
    },
    required: ["title", "slug", "idea"],
    additionalProperties: false,
  };
  const checklistSprintSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      slug: { type: "string" },
      prd_path: { type: "string" },
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            objective: { type: "string" },
            files: { type: "array", items: { type: "string" } },
            checks: { type: "array", items: { type: "string" } },
            stage_gate: { type: "string" },
          },
          required: ["title", "objective"],
          additionalProperties: false,
        },
      },
      overwrite: { type: "boolean" },
    },
    required: ["title", "slug", "prd_path", "tasks"],
    additionalProperties: false,
  };
  const goalFromSprintSchema = {
    type: "object",
    properties: {
      prd_path: { type: "string" },
      sprint_path: { type: "string" },
      goal_prd_path: { type: "string" },
      goal_sprint_path: { type: "string" },
      reference_repo: { type: "string" },
      extra_instructions: { type: "string" },
      overwrite: { type: "boolean" },
    },
    required: ["prd_path", "sprint_path"],
    additionalProperties: false,
  };
  const browserRunSchema = {
    type: "object",
    properties: {
      prompt: { type: "string" },
      title: { type: "string" },
      files: { type: "array", items: { type: "string" } },
      model: { type: "string" },
      thinking: {
        type: "string",
        enum: ["light", "standard", "extended", "heavy"],
      },
      provider: { type: "string", enum: ["oracle", "native"] },
      browserChannel: {
        type: "string",
        enum: ["chrome", "chrome-beta", "chrome-dev", "chrome-canary"],
      },
      followups: { type: "array", items: { type: "string" } },
      writeOutput: { type: "string" },
      overwriteOutput: { type: "boolean" },
      timeoutMs: { type: "number" },
      dryRun: { type: "boolean" },
    },
    required: ["prompt"],
    additionalProperties: false,
  };
  const browserSessionSchema = {
    type: "object",
    properties: { sessionId: { type: "string" } },
    required: ["sessionId"],
    additionalProperties: false,
  };
  const agentTimeoutSchema = {
    type: "number",
    minimum: MIN_AGENT_TIMEOUT_MS,
    maximum: policy.execution.runnerMaxTimeoutMs,
    description: `Execution limit in milliseconds. Defaults to ${policy.execution.runnerTimeoutMs}; maximum ${policy.execution.runnerMaxTimeoutMs}. The value is never silently reduced.`,
  };
  const agentRunnerSchema = {
    type: "object",
    properties: {
      agent: { type: "string", enum: ["codex", "claude"] },
      goal_path: {
        type: "string",
        default: ".ai/harness/handoff/codex-goal.md",
      },
      timeout_ms: agentTimeoutSchema,
    },
    required: ["agent"],
    additionalProperties: false,
  };

  const tools: McpToolDefinition[] = [
    {
      name: "harness_status",
      description: "Return repo-harness adoption and workflow status.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "harness_doctor",
      description: "Return compact MCP setup diagnostics.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "list_workflow_files",
      description: "List policy-readable workflow files.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "read_workflow_file",
      description:
        "Read one policy-allowed workflow file by repo-relative path.",
      inputSchema: stringPathSchema,
      annotations: readOnly,
    },
    {
      name: "latest_handoff",
      description: "Return latest repo-harness handoff artifacts.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "latest_checks",
      description: "Return latest repo-harness check artifacts.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "list_prds",
      description: "List PRD artifacts under plans/prds.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "list_sprints",
      description: "List sprint artifacts under plans/sprints.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "summarize_repo_harness_state",
      description: "Return a compact planning state summary.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "write_prd",
      description: "Write a PRD under plans/prds/*.prd.md.",
      inputSchema: markdownWriterSchema,
      annotations: write,
    },
    {
      name: "write_prd_from_idea",
      description:
        "Turn a product idea into a strict-compatible draft PRD under plans/prds/*.prd.md.",
      inputSchema: ideaPrdSchema,
      annotations: write,
    },
    {
      name: "write_sprint",
      description: "Write a sprint under plans/sprints/*.sprint.md.",
      inputSchema: markdownWriterSchema,
      annotations: write,
    },
    {
      name: "write_checklist_sprint",
      description:
        "Turn a PRD into an ordered checklist Sprint with per-phase staging gates.",
      inputSchema: checklistSprintSchema,
      annotations: write,
    },
    {
      name: "write_plan",
      description: "Write an implementation plan under plans/plan-*.md.",
      inputSchema: markdownWriterSchema,
      annotations: write,
    },
    {
      name: "prepare_codex_goal_from_sprint",
      description:
        "Prepare .ai/harness/handoff/codex-goal.md and a host-native /goal prompt from PRD + checklist Sprint.",
      inputSchema: goalFromSprintSchema,
      annotations: write,
    },
    {
      name: "write_codex_goal",
      description:
        "Write .ai/harness/handoff/codex-goal.md after required section validation.",
      inputSchema: {
        type: "object",
        properties: {
          body: { type: "string" },
          overwrite: { type: "boolean" },
        },
        required: ["body"],
        additionalProperties: false,
      },
      annotations: write,
    },
    {
      name: "append_handoff_note",
      description: "Append a timestamped planner handoff note.",
      inputSchema: {
        type: "object",
        properties: { actor: { type: "string" }, body: { type: "string" } },
        required: ["body"],
        additionalProperties: false,
      },
      annotations: write,
    },
  ];

  if (policy.profile === "controller") {
    const taskItemSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        objective: { type: "string" },
        depends_on: { type: "array", items: { type: "string" } },
        allowed_paths: { type: "array", items: { type: "string" } },
        forbidden_paths: { type: "array", items: { type: "string" } },
        checks: { type: "array", items: { type: "string" } },
        acceptance_criteria: { type: "array", items: { type: "string" } },
        risk: { type: "string", enum: ["readonly", "low", "medium", "high", "destructive"] },
        agent: { type: "string", enum: ["codex", "claude", "github-copilot"] },
      },
      required: ["title", "objective"],
      additionalProperties: false,
    };
    tools.push(
      {
        name: "controller_capabilities",
        description:
          "Return the active controller tool-surface version and expected capabilities. Use this to detect a stale ChatGPT connector tool snapshot.",
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: "local_bridge_status",
        description:
          "Return the localhost-only visual controller endpoint, execution state, and recent local bridge Jobs.",
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: "controller_context",
        description:
          "Return one compact controller start-work context: Git status, current Issue focus, active Runs and Jobs, recommended execution mode, and available checks.",
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string" },
            known_paths: { type: "array", items: { type: "string" } },
            expected_files: { type: "number" },
            expected_changed_lines: { type: "number" },
            requires_investigation: { type: "boolean" },
            requires_parallelism: { type: "boolean" },
            requires_long_running_checks: { type: "boolean" },
            needs_dependencies: { type: "boolean" },
            risk: { type: "string", enum: ["readonly", "low", "medium", "high", "destructive"] },
          },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "controller_context_pack",
        description:
          "Build a bounded code context pack for a task: relevant files, search-hit line ranges, and raw snippets. This is for scoped investigation, not blind implementation.",
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string" },
            issue_id: { type: "string" },
            task_id: { type: "string" },
            known_paths: { type: "array", items: { type: "string" } },
            include_globs: { type: "array", items: { type: "string" } },
            exclude_globs: { type: "array", items: { type: "string" } },
            search_terms: { type: "array", items: { type: "string" } },
            max_files: { type: "number" },
            max_snippets: { type: "number" },
            max_chars_per_snippet: { type: "number" },
          },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "quick_agent_session",
        description:
          "Start an ephemeral local Codex or Claude session directly from an objective, without requiring an Issue or Task. Current workspace is the default; isolation is opt-in or selected for concurrency.",
        inputSchema: {
          type: "object",
          properties: {
            request_id: { type: "string" },
            title: { type: "string" },
            objective: { type: "string" },
            summary: { type: "string" },
            agent: { type: "string", enum: ["codex", "claude"] },
            isolate: {
              type: "boolean",
              description: "Optional. false uses the current workspace, true forces an isolated worktree, and omission selects automatically.",
            },
            timeout_ms: agentTimeoutSchema,
            ephemeral: { type: "boolean", description: "Defaults to true and stays outside the durable Issue board." },
            allowed_paths: { type: "array", items: { type: "string" } },
            forbidden_paths: { type: "array", items: { type: "string" } },
            checks: { type: "array", items: { type: "string" } },
            acceptance_criteria: { type: "array", items: { type: "string" } },
            risk: { type: "string", enum: ["readonly", "low", "medium", "high", "destructive"] },
            approve_destructive: { type: "boolean" },
            requested_by: { type: "string" },
          },
          required: ["title", "objective"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      },
      {
        name: "submit_local_job",
        description:
          "Submit a high-level local Job Ticket. Local work dispatches immediately unless it is explicitly destructive; no ordinary risk approval queue is used.",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["launch-task", "quick-agent-session", "run-check"],
            },
            request_id: { type: "string" },
            issue_id: { type: "string" },
            task_id: { type: "string" },
            agent: {
              type: "string",
              enum: ["codex", "claude", "github-copilot"],
            },
            isolate: {
              type: "boolean",
              description:
                "Optional. Omit for automatic placement: use the current workspace when no local Run is active and a worktree only for concurrency. false forces the current workspace and is rejected during concurrency; true forces a worktree.",
            },
            supervisor_instructions: {
              type: "string",
              description: "Optional follow-up guidance from a supervising ChatGPT review. Appended to the retried Run prompt without narrowing normal executor capabilities.",
            },
            timeout_ms: agentTimeoutSchema,
            github_repo: { type: "string" },
            base_ref: { type: "string" },
            model: { type: "string" },
            create_pull_request: { type: "boolean" },
            approve_destructive: { type: "boolean" },
            ephemeral: { type: "boolean", description: "Quick Agent defaults to true and stays outside the durable Issue board." },
            title: { type: "string" },
            objective: { type: "string" },
            summary: { type: "string" },
            allowed_paths: { type: "array", items: { type: "string" } },
            forbidden_paths: { type: "array", items: { type: "string" } },
            checks: { type: "array", items: { type: "string" } },
            acceptance_criteria: { type: "array", items: { type: "string" } },
            risk: { type: "string", enum: ["readonly", "low", "medium", "high", "destructive"] },
            check_id: { type: "string" },
            requested_by: { type: "string" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: false,
        },
      },
      {
        name: "list_local_jobs",
        description: "List recent local Job Tickets and execution state.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "get_local_job",
        description: "Read one local Job Ticket status and compact metadata.",
        inputSchema: {
          type: "object",
          properties: {
            job_id: { type: "string" },
            include_events: { type: "boolean" },
          },
          required: ["job_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "get_local_job_output",
        description: "Read bounded stdout or stderr for one local Job Ticket.",
        inputSchema: {
          type: "object",
          properties: {
            job_id: { type: "string" },
            stream: { type: "string", enum: ["stdout", "stderr"] },
            max_bytes: { type: "number" },
          },
          required: ["job_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "project_snapshot",
        description:
          "Return Git state, controller issue board, active task runs, and workflow markers.",
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: "search_repository",
        description:
          "Search policy-readable source and documentation files without loading the full repository.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            include_globs: { type: "array", items: { type: "string" } },
            exclude_globs: { type: "array", items: { type: "string" } },
            max_results: { type: "number" },
            max_files: { type: "number" },
            case_sensitive: { type: "boolean" },
          },
          required: ["query"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "read_repository_file",
        description:
          "Read a line range from one policy-readable repository file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            start_line: { type: "number" },
            end_line: { type: "number" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "get_git_diff",
        description:
          "Return the current unstaged Git diff, optionally limited to one repo-relative path.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            max_bytes: { type: "number" },
          },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "list_checks",
        description:
          "List focused repository checks from safe package scripts and .repo-harness/checks.json.",
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: "run_check",
        description:
          "Start one named focused repository check as a Local Job and return immediately; inspect it with get_local_job.",
        inputSchema: {
          type: "object",
          properties: {
            check_id: { type: "string" },
            timeout_ms: { type: "number" },
          },
          required: ["check_id"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: false,
        },
      },
      {
        name: "list_issues",
        description: "List controller-managed issues and task summaries.",
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: "get_project_board",
        description: "Return task counts, ready work, and issue/task status.",
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: "get_project_progress",
        description:
          "Return evidence-gate completion, effective status, blockers, throughput, current-focus progress, and attention items without lifecycle-percentage estimates.",
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: "get_project_governance",
        description:
          "Return the current execution focus, evidence-driven execution queue, dead dependencies, pending review/acceptance, duplicate active Issues, and closeout anomalies.",
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: "reconcile_project_governance",
        description:
          "Apply only safe governance repairs: replace superseded dependencies, return failed attempts to a retryable Task state, close fully completed Issues, and select the sole active Issue as focus.",
        inputSchema: EMPTY_SCHEMA,
        annotations: write,
      },
      {
        name: "get_project_state",
        description: "Return the current execution focus and Issue creation policy.",
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: "set_current_issue",
        description: "Select the one active Issue that is allowed to drive the execution queue.",
        inputSchema: {
          type: "object",
          properties: { issue_id: { type: "string" } },
          required: ["issue_id"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "archive_issue",
        description: "Move a done or cancelled Issue out of the current workspace while retaining its full evidence history.",
        inputSchema: {
          type: "object",
          properties: { issue_id: { type: "string" } },
          required: ["issue_id"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "restore_issue",
        description: "Restore an archived Issue to the normal controller views.",
        inputSchema: {
          type: "object",
          properties: { issue_id: { type: "string" } },
          required: ["issue_id"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "get_task_progress_detail",
        description:
          "Return one Task with effective progress, bounded Run and timeline summaries by default, and full detail on demand.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            task_id: { type: "string" },
            detail_level: { type: "string", enum: ["summary", "full"] },
          },
          required: ["issue_id", "task_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "get_worklog_timeline",
        description:
          "Read the unified controller worklog across Issues, Tasks, Runs, Direct Edits, Verification, and GitHub sync.",
        inputSchema: {
          type: "object",
          properties: {
            category: { type: "string", enum: ["issue", "task", "run", "verification", "edit", "github", "local_job", "system"] },
            issue_id: { type: "string" },
            task_id: { type: "string" },
            run_id: { type: "string" },
            edit_session_id: { type: "string" },
            since: { type: "string" },
            until: { type: "string" },
            limit: { type: "number" },
          },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "export_worklog",
        description:
          "Export the controller worklog to a repository report under tasks/reports or another safe repo-relative path.",
        inputSchema: {
          type: "object",
          properties: {
            format: { type: "string", enum: ["markdown", "json"] },
            output_path: { type: "string" },
            issue_id: { type: "string" },
            task_id: { type: "string" },
            run_id: { type: "string" },
            edit_session_id: { type: "string" },
          },
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "get_github_plugin_status",
        description:
          "Return optional GitHub Issue/Project plugin configuration, readiness, and supported capabilities.",
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: "configure_github_plugin",
        description:
          "Enable or configure the optional GitHub Issue/Project synchronization plugin. Local controller files remain authoritative.",
        inputSchema: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            repository: { type: "string" },
            clear_repository: { type: "boolean" },
            sync_mode: { type: "string", enum: ["manual", "checkpoint"] },
            include_tasks: { type: "boolean" },
            project_owner: { type: "string" },
            project_number: { type: "number" },
            clear_project: { type: "boolean" },
          },
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "get_issue",
        description: "Read one controller issue by ID with bounded task summaries by default and full detail on demand.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            detail_level: { type: "string", enum: ["summary", "full"] },
          },
          required: ["issue_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "github_status",
        description:
          "Check GitHub CLI authentication, repository mapping, Projects readiness, and cloud-agent session support.",
        inputSchema: {
          type: "object",
          properties: { repo: { type: "string" } },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "publish_issue_to_github",
        description:
          "Create or update the controller Issue in GitHub, optionally mirroring Tasks as sub-issues and adding all items to a GitHub Project.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            repo: { type: "string" },
            labels: { type: "array", items: { type: "string" } },
            include_tasks: { type: "boolean" },
            project_owner: { type: "string" },
            project_number: { type: "number" },
          },
          required: ["issue_id"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: true,
          destructiveHint: false,
        },
      },
      {
        name: "refresh_github_issue",
        description:
          "Refresh the linked GitHub Issue metadata and remote state.",
        inputSchema: {
          type: "object",
          properties: { issue_id: { type: "string" } },
          required: ["issue_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "close_github_issue",
        description:
          "Close the linked GitHub Issue after local controller acceptance.",
        inputSchema: {
          type: "object",
          properties: { issue_id: { type: "string" } },
          required: ["issue_id"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: true,
          destructiveHint: true,
        },
      },
      {
        name: "inspect_issue_readiness",
        description:
          "Score launch readiness, list blockers and warnings, and summarize executable Tasks. Agent selection happens at dispatch time.",
        inputSchema: {
          type: "object",
          properties: { issue_id: { type: "string" } },
          required: ["issue_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "inspect_task_readiness",
        description:
          "Evaluate launch readiness for one Task only. Other Issues, focus selection, unrelated Tasks, and missing named checks do not block it.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            task_id: { type: "string" },
            retry_from_run_id: { type: "string" },
            approve_destructive: { type: "boolean" },
          },
          required: ["issue_id", "task_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "prepare_issue_launch",
        description:
          "Return an Issue Launcher preview without starting any agent session.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            max_parallel: { type: "number" },
          },
          required: ["issue_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "assess_work_request",
        description:
          "Choose direct_edit, quick_agent, or issue_task before creating work. Prefer repository search plus bounded direct edits for low/medium-risk changes, even when exact files need discovery; use an Agent only when direct patches are not safe or practical.",
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string" },
            known_paths: { type: "array", items: { type: "string" } },
            expected_files: { type: "number" },
            expected_changed_lines: { type: "number" },
            requires_investigation: { type: "boolean" },
            requires_parallelism: { type: "boolean" },
            requires_long_running_checks: { type: "boolean" },
            needs_dependencies: { type: "boolean" },
            risk: { type: "string", enum: ["readonly", "low", "medium", "high", "destructive"] },
          },
          required: ["description"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "create_issue",
        description:
          "Create a durable Issue only for broad, long-running, dependency-aware, parallel, protected-path, or high-risk work. File discovery by itself is not a reason to create an Issue or start an Agent; search first and use bounded direct edits when practical.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            kind: {
              type: "string",
              enum: ["bug", "feature", "governance", "investigation"],
            },
            summary: { type: "string" },
            goals: { type: "array", items: { type: "string" } },
            non_goals: { type: "array", items: { type: "string" } },
            acceptance_criteria: { type: "array", items: { type: "string" } },
            related_artifacts: { type: "array", items: { type: "string" } },
            tasks: { type: "array", items: taskItemSchema },
            allow_while_focused: { type: "boolean", description: "Explicitly allow a separate Issue while another Issue is the current execution focus." },
            allow_duplicate: { type: "boolean", description: "Explicitly allow an active Issue with the same normalized title." },
            allow_when_paused: { type: "boolean", description: "Explicitly override a paused Issue-creation policy." },
          },
          required: ["title"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "update_issue",
        description: "Update issue intent, artifacts, or lifecycle status.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            title: { type: "string" },
            summary: { type: "string" },
            status: {
              type: "string",
              enum: [
                "backlog",
                "analysis",
                "planned",
                "launch_blocked",
                "in_progress",
                "review",
                "done",
                "cancelled",
              ],
            },
            goals: { type: "array", items: { type: "string" } },
            non_goals: { type: "array", items: { type: "string" } },
            acceptance_criteria: { type: "array", items: { type: "string" } },
            related_artifacts: { type: "array", items: { type: "string" } },
          },
          required: ["issue_id"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "plan_issue",
        description:
          "Replace the pre-execution task plan for an Issue with ordered dependency-aware tasks.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            tasks: { type: "array", items: taskItemSchema },
          },
          required: ["issue_id", "tasks"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "append_task",
        description:
          "Append a stable Task to an Issue after execution has already started.",
        inputSchema: {
          type: "object",
          properties: { issue_id: { type: "string" }, task: taskItemSchema },
          required: ["issue_id", "task"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "split_task",
        description:
          "Supersede one not-running Task with two or more smaller replacement Tasks while preserving downstream dependencies.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            task_id: { type: "string" },
            tasks: { type: "array", minItems: 2, items: taskItemSchema },
          },
          required: ["issue_id", "task_id", "tasks"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "supersede_task",
        description:
          "Mark a Task as superseded and optionally link replacement Task IDs.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            task_id: { type: "string" },
            replacement_task_ids: { type: "array", items: { type: "string" } },
          },
          required: ["issue_id", "task_id"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "set_task_dependencies",
        description:
          "Replace one Task dependency list and revalidate the Issue DAG.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            task_id: { type: "string" },
            depends_on: { type: "array", items: { type: "string" } },
          },
          required: ["issue_id", "task_id", "depends_on"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "update_task",
        description: "Update one task status or append a controller note.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            task_id: { type: "string" },
            status: {
              type: "string",
              enum: [
                "backlog",
                "analysis",
                "planned",
                "ready",
                "launch_blocked",
                "running",
                "blocked",
                "review",
                "integrated",
                "verifying",
                "changes_requested",
                "verified",
                "done",
                "cancelled",
                "superseded",
              ],
            },
            note: { type: "string" },
          },
          required: ["issue_id", "task_id"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "dispatch_task",
        description:
          "Execute one Task with an agent selected at dispatch time. Task definitions remain executor-neutral; Codex, Claude, and GitHub Copilot are optional implementation tools.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            task_id: { type: "string" },
            request_id: { type: "string" },
            agent: {
              type: "string",
              enum: ["codex", "claude", "github-copilot"],
            },
            timeout_ms: agentTimeoutSchema,
            isolate: {
              type: "boolean",
              description:
                "Optional. Omit for automatic placement: use the current workspace when no local Run is active and a worktree only for concurrency. false forces the current workspace and is rejected during concurrency; true forces a worktree.",
            },
            github_repo: { type: "string" },
            base_ref: { type: "string" },
            model: { type: "string" },
            create_pull_request: { type: "boolean" },
            approve_destructive: { type: "boolean", description: "Explicit same-request authorization for destructive or irreversible execution." },
          },
          required: ["issue_id", "task_id"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: false,
        },
      },
      {
        name: "launch_issue",
        description:
          "Execute independent Tasks from one Issue with an optional runtime agent override. Task definitions do not permanently bind an agent.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            max_parallel: { type: "number" },
            request_id: { type: "string" },
            agent: { type: "string", enum: ["codex", "claude", "github-copilot"], description: "Optional runtime executor override for selected Tasks." },
            timeout_ms: agentTimeoutSchema,
            isolate: {
              type: "boolean",
              description:
                "Optional. Omit for automatic placement: use the current workspace when no local Run is active and a worktree only for concurrency. false forces the current workspace and is rejected during concurrency; true forces a worktree.",
            },
            github_repo: { type: "string" },
            base_ref: { type: "string" },
            model: { type: "string" },
            create_pull_request: { type: "boolean" },
            approve_destructive: { type: "boolean", description: "Explicit same-request authorization for destructive or irreversible execution." },
          },
          required: ["issue_id"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: true,
          destructiveHint: false,
        },
      },
      {
        name: "dispatch_ready_tasks",
        description:
          "Execute up to max_parallel independent Tasks with an optional runtime agent override.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            max_parallel: { type: "number" },
            request_id: { type: "string" },
            agent: { type: "string", enum: ["codex", "claude", "github-copilot"], description: "Optional runtime executor override for selected Tasks." },
            timeout_ms: agentTimeoutSchema,
            isolate: {
              type: "boolean",
              description:
                "Optional. Omit for automatic placement: use the current workspace when no local Run is active and a worktree only for concurrency. false forces the current workspace and is rejected during concurrency; true forces a worktree.",
            },
            github_repo: { type: "string" },
            base_ref: { type: "string" },
            model: { type: "string" },
            create_pull_request: { type: "boolean" },
            approve_destructive: { type: "boolean", description: "Explicit same-request authorization for destructive or irreversible execution." },
          },
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: true,
          destructiveHint: false,
        },
      },
      {
        name: "get_task_run",
        description:
          "Read one persistent agent run with current status, bounded output tails, and opt-in path details.",
        inputSchema: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            include_paths: { type: "boolean", description: "Opt in to full local filesystem paths and PIDs." },
            include_output: { type: "boolean", description: "Return bounded stdout/stderr tails. Defaults to true." },
            tail_chars: { type: "number", description: "Per-stream character budget for the bounded tails; capped at 16384." },
          },
          required: ["run_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "get_task_run_events",
        description:
          "Read structured lifecycle events for a local or GitHub cloud Task Run.",
        inputSchema: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            limit: { type: "number" },
            since_event_index: { type: "number" },
            include_heartbeats: { type: "boolean" },
          },
          required: ["run_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "get_task_run_log",
        description:
          "Read a bounded, redacted tail of current local output or GitHub cloud-agent session logs. GitHub logs can be watched directly in the linked Agents UI.",
        inputSchema: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            max_bytes: { type: "number", description: "Bounded log tail size; capped at 1 MiB." },
          },
          required: ["run_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "get_task_diff",
        description:
          "Inspect the Git status and diff from one isolated Task Run worktree.",
        inputSchema: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            max_bytes: { type: "number" },
          },
          required: ["run_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "integrate_task_run",
        description:
          "Integrate one reviewed isolated Task Run into the main working tree through a rollback-capable edit session.",
        inputSchema: {
          type: "object",
          properties: { run_id: { type: "string" } },
          required: ["run_id"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: true,
        },
      },
      {
        name: "finish_task_run",
        description:
          "Finish one reviewed Run in a single policy-gated step: integrate if needed, verify, accept when allowed, and clean the isolated worktree. Use decision=auto for low/medium trusted work; use approve_and_finish only for explicit human approval.",
        inputSchema: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            decision: {
              type: "string",
              enum: ["auto", "approve_and_finish", "request_changes", "discard"],
            },
            reviewer: { type: "string" },
            note: { type: "string" },
            cleanup: { type: "boolean" },
            commit: { type: "boolean", description: "Create a selected-path Git commit after successful finish. Refuses to mix with pre-staged changes." },
          },
          required: ["run_id"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: false,
        },
      },
      {
        name: "list_task_runs",
        description: "List recent persistent agent runs.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number" },
            include_paths: { type: "boolean", description: "Opt in to full local filesystem paths and PIDs." },
          },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "cancel_task_run",
        description: "Cancel a queued or running local agent task.",
        inputSchema: {
          type: "object",
          properties: { run_id: { type: "string" } },
          required: ["run_id"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: true,
        },
      },
      {
        name: "retry_task_run",
        description:
          "Create a new run for a failed, blocked, cancelled, or change-requested task.",
        inputSchema: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            timeout_ms: agentTimeoutSchema,
            isolate: {
              type: "boolean",
              description:
                "Optional. Omit for automatic placement: use the current workspace when no local Run is active and a worktree only for concurrency. false forces the current workspace and is rejected during concurrency; true forces a worktree.",
            },
          },
          required: ["run_id"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "verify_task",
        description:
          "Record task-local completion evidence. Declared checks are executed when present; missing checks are a warning, and reported command evidence can satisfy risk-adaptive verification.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            task_id: { type: "string" },
            run_id: { type: "string" },
            integrated_revision: { type: "string" },
            reviewed_diff_hash: { type: "string" },
            reviewer: { type: "string" },
            check_results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  check_id: { type: "string" },
                  ok: { type: "boolean", description: "Deprecated compatibility field. The Controller executes the named check and uses the actual outcome." },
                  summary: { type: "string" },
                },
                required: ["check_id"],
                additionalProperties: false,
              },
            },
            reported_commands: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  command: { type: "array", items: { type: "string" }, minItems: 1 },
                  cwd: { type: "string" },
                  ok: { type: "boolean" },
                  exit_code: { type: "number" },
                  stdout: { type: "string" },
                  stderr: { type: "string" },
                  artifact_path: { type: "string" },
                  executed_at: { type: "string" },
                },
                required: ["command", "ok"],
                additionalProperties: false,
              },
            },
            acceptance_results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  criterion: { type: "string" },
                  ok: { type: "boolean" },
                  evidence: { type: "string" },
                },
                required: ["criterion", "ok"],
                additionalProperties: false,
              },
            },
          },
          required: ["issue_id", "task_id", "reviewer"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "accept_task",
        description:
          "Accept a verified task, mark it done, and unlock dependent tasks.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            task_id: { type: "string" },
            note: { type: "string" },
          },
          required: ["issue_id", "task_id"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "request_task_changes",
        description:
          "Return a reviewed task for another focused execution run.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            task_id: { type: "string" },
            note: { type: "string" },
          },
          required: ["issue_id", "task_id", "note"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "begin_edit_session",
        description:
          "Open a bounded direct-edit session tied to a purpose and optional Issue/Task.",
        inputSchema: {
          type: "object",
          properties: {
            purpose: { type: "string" },
            issue_id: { type: "string" },
            task_id: { type: "string" },
            allowed_paths: { type: "array", items: { type: "string" } },
            max_files: { type: "number" },
            max_changed_lines: { type: "number" },
            checks: { type: "array", items: { type: "string" }, description: "Named checks to run before finalization." },
          },
          required: ["purpose"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "apply_patch",
        description:
          "Append one bounded patch batch to an active edit session. Prefer batches of 100 operations or fewer and pass expected_revision to avoid stale revisions.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            expected_revision: { type: "number", description: "Optional current revision precondition for the edit session." },
            operations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["create", "write", "replace", "insert_before", "insert_after", "prepend", "append", "delete"],
                  },
                  path: { type: "string" },
                  content: { type: "string" },
                  expected_sha256: { type: "string" },
                  anchor: { type: "string", description: "Anchor text for insert_before or insert_after." },
                  occurrence: { type: "number", description: "1-based anchor occurrence; defaults to 1." },
                  replacements: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        old_text: { type: "string" },
                        new_text: { type: "string" },
                        replace_all: { type: "boolean" },
                      },
                      required: ["old_text", "new_text"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["type", "path"],
                additionalProperties: false,
              },
            },
          },
          required: ["session_id", "operations"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: false,
        },
      },
      {
        name: "get_edit_session",
        description: "Read an edit session, revisions, savepoints, and operation manifest.",
        inputSchema: {
          type: "object",
          properties: { session_id: { type: "string" } },
          required: ["session_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "list_edit_sessions",
        description: "List recent direct-edit sessions with revision, changed-file, and check summaries.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "get_edit_session_diff",
        description: "Read the current aggregate localized diff for one direct-edit session.",
        inputSchema: {
          type: "object",
          properties: { session_id: { type: "string" } },
          required: ["session_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "create_edit_savepoint",
        description: "Name the current edit revision so later patch batches can be rolled back to it.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            name: { type: "string" },
          },
          required: ["session_id", "name"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "verify_edit_session",
        description: "Start verification for the current edit revision as a Local Job and return immediately. Checks are optional unless configured on the session.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            check_ids: { type: "array", items: { type: "string" } },
            request_id: { type: "string" },
            reviewer: { type: "string" },
            note: { type: "string" },
          },
          required: ["session_id"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "rollback_edit_session",
        description:
          "Rollback an active edit session completely, to a prior revision, or to a named savepoint.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            to_revision: { type: "number", description: "Keep revisions up to this value; omit for full rollback." },
            savepoint: { type: "string", description: "Rollback to a named savepoint." },
          },
          required: ["session_id"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: false,
        },
      },
      {
        name: "finalize_edit_session",
        description:
          "Close an active edit session. Configured checks must pass; sessions without configured checks finalize directly.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            reviewer: { type: "string" },
            note: { type: "string" },
          },
          required: ["session_id"],
          additionalProperties: false,
        },
        annotations: write,
      },
    );
  }

  if (policy.execution.fixedWorkflowCheck) {
    tools.push({
      name: "run_workflow_check",
      description: "Run the fixed repo-harness strict workflow check.",
      inputSchema: EMPTY_SCHEMA,
      annotations: write,
    });
  }
  if (opts.enableChatgptBrowser === true) {
    tools.push(
      {
        name: "run_chatgpt_browser_consult",
        description:
          "Run a local ChatGPT Web browser consult through repo-harness. This may create a real ChatGPT Web conversation unless dryRun is true.",
        inputSchema: browserRunSchema,
        annotations: {
          readOnlyHint: false,
          openWorldHint: true,
          destructiveHint: false,
        },
      },
      {
        name: "read_chatgpt_browser_session",
        description:
          "Read a saved repo-harness ChatGPT browser consult session.",
        inputSchema: browserSessionSchema,
        annotations: readOnly,
      },
      {
        name: "list_chatgpt_browser_sessions",
        description:
          "List saved repo-harness ChatGPT browser consult sessions.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "open_chatgpt_browser_session",
        description:
          "Return the ChatGPT conversation URL for a saved browser session. The MCP tool does not launch the local browser.",
        inputSchema: browserSessionSchema,
        annotations: readOnly,
      },
      {
        name: "continue_chatgpt_browser_session",
        description:
          "Create a follow-up ChatGPT browser consult record linked to an existing session.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            prompt: { type: "string" },
            dryRun: { type: "boolean" },
          },
          required: ["sessionId", "prompt"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: true,
          destructiveHint: false,
        },
      },
    );
  }
  if (policy.execution.agentRunner && policy.execution.codexRunner) {
    tools.push({
      name: "run_agent_goal",
      description:
        "Dev mode only: run the fixed Codex goal handoff through an explicitly enabled local Codex or Claude CLI.",
      inputSchema: agentRunnerSchema,
      annotations: write,
    });
  }
  return tools;
}

export function controllerExpectedToolNames(
  policy: McpPolicy,
  opts: { enableChatgptBrowser?: boolean } = {},
): string[] {
  const names = buildMcpToolDefinitions(policy, opts).map((tool) => tool.name);
  if (policy.profile !== "controller") return names;
  // The Connector readiness expectation must match the stable default schema
  // served by toolset.ts. Full compatibility tools are intentionally omitted.
  return [...STABLE_CONTROLLER_TOOL_NAMES];
}

export async function callMcpTool(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  try {
    switch (name) {
      case "harness_status": {
        const roots = [
          "docs/spec.md",
          "plans",
          "tasks/current.md",
          ".ai/harness/handoff",
          ".ai/harness/checks",
        ];
        audit(ctx, name, "ok", args);
        return textResult({
          repoRoot: ctx.repoRoot,
          adopted: isRepoHarnessAdopted(ctx.repoRoot),
          profile: ctx.policy.profile,
          branch: currentGitBranch(ctx.repoRoot),
          workflowRoots: roots.map((path) => ({
            path,
            exists: existsSync(join(ctx.repoRoot, path)),
          })),
        });
      }
      case "harness_doctor": {
        const localConfig = existsSync(
          join(ctx.repoRoot, ".repo-harness", "mcp.local.json"),
        );
        const codexConfig = existsSync(
          join(ctx.repoRoot, ".codex", "config.toml"),
        );
        audit(ctx, name, "ok", args);
        return textResult({
          status: isRepoHarnessAdopted(ctx.repoRoot)
            ? "ready_local"
            : "not_adopted",
          repo: ctx.repoRoot,
          profile: ctx.policy.profile,
          mcp: {
            localConfig,
            policy: "builtin",
            profile: ctx.policy.profile,
            toolSurface:
              ctx.policy.profile === "controller"
                ? CONTROLLER_TOOL_SURFACE
                : `${ctx.policy.profile}-legacy-v1`,
            toolCount: buildMcpToolDefinitions(ctx.policy, {
              enableChatgptBrowser: ctx.enableChatgptBrowser === true,
            }).length,
            repositoryRead:
              ctx.policy.profile === "controller"
                ? "ordinary repository source and document files are readable; immutable secret and runtime paths remain denied"
                : "workflow-scoped",
            deniedPaths: ctx.policy.denyGlobs.length,
            runner: {
              enabled: ctx.policy.execution.agentRunner,
              defaultTimeoutMs: ctx.policy.execution.runnerTimeoutMs,
              maxTimeoutMs: ctx.policy.execution.runnerMaxTimeoutMs,
            },
          },
          codex: {
            configured: codexConfig,
            fix: codexConfig
              ? null
              : "repo-harness mcp setup codex --repo . --scope project",
          },
          chatgpt: {
            localEndpoint: "http://127.0.0.1:8765/mcp",
            manualStepsRequired: true,
            guide: "docs/repo-harness-chatgpt-mcp-setup.md",
          },
        });
      }
      case "controller_capabilities": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "controller_capabilities requires the controller profile",
          );
        const expectedTools = controllerExpectedToolNames(ctx.policy, {
          enableChatgptBrowser: ctx.enableChatgptBrowser === true,
        });
        const preferredTools: string[] = [...PREFERRED_FACADE_TOOL_NAMES];
        const capabilityDescriptors = listCapabilityDescriptors();
        const connectorSnapshot = Array.isArray(args.connector_tool_names)
          ? args.connector_tool_names.map(String)
          : Array.isArray(args.connectorToolNames)
            ? args.connectorToolNames.map(String)
            : undefined;
        const connectorFreshness = await buildLocalConnectorStatusForRepo({
          repoRoot: ctx.repoRoot,
          expectedTools,
          connectorToolNames: connectorSnapshot,
        });
        // staleConnector only when ChatGPT snapshot is supplied and missing rh_*.
        const missingFacadeTools = connectorFreshness.missingConnectorTools;
        const staleConnector = connectorFreshness.status === "chatgpt_snapshot_missing_facade";
        const payload = {
          schemaVersion: CONTROLLER_SCHEMA_VERSION,
          toolSurface: CONTROLLER_TOOL_SURFACE,
          toolSurfaceVersion: CONTROLLER_TOOL_SURFACE_VERSION,
          toolSurfaceFingerprint: controllerToolSurfaceFingerprint(expectedTools),
          executionModel: "chatgpt-controller-execution-bridge",
          profile: ctx.policy.profile,
          capabilities: {
            repositoryInspection: true,
            issueLauncher: true,
            githubIssuesAndProjects: true,
            localAgentRuns: ctx.policy.execution.agentRunner,
            githubCopilotSessions: true,
            dynamicTaskGraph: true,
            runtimeAgentSelection: true,
            taskAgentBinding: false,
            structuredRunEvents: true,
            boundedDirectEdits: true,
            multiRevisionDirectEdits: true,
            editSavepoints: true,
            partialEditRollback: true,
            directEditFirstRouting: true,
            persistedEditDiffs: true,
            verifiedEditFinalization: true,
            verificationGate: true,
            localRunWatch: true,
            localVisualController: true,
            hierarchicalControllerUI: true,
            localApprovalQueue: false,
            localRiskApprovalGate: false,
            quickAgentSessions: true,
            persistentTimeouts: true,
            timeoutProgress: true,
            connectorSchemaDiagnostics: true,
            projectProgressAggregation: true,
            effectiveTaskStatus: true,
            unifiedWorklogTimeline: true,
            exportableWorklogReports: true,
            githubPluginConfiguration: true,
            serverSentEventDashboard: true,
            singleExecutionFocus: false,
            taskLocalReadiness: true,
            riskAdaptiveVerification: true,
            ephemeralQuickAgentSessions: true,
            automaticRunContinuation: true,
            reportedCommandEvidence: true,
            governanceDiagnostics: true,
            safeGovernanceReconciliation: true,
            evidenceGateProgress: true,
            directTaskActions: true,
            issueArchiving: true,
            retryableRunFailures: true,
            issueCreationGuardrails: true,
            persistedCheckEvidence: true,
            persistedCheckReuse: true,
            directVerification: true,
            controllerContextAggregation: true,
            taskLedgerProjection: true,
            assistantPluginRuntime: true,
            chatgptFacadeTools: true,
            goalWorkloop: true,
            handoffInbox: true,
            codexGrokDelegation: true,
            selfHealingRepair: true,
          },
          runner: {
            enabled: ctx.policy.execution.agentRunner,
            allowedAgents: ctx.policy.execution.allowedAgents,
            defaultTimeoutMs: ctx.policy.execution.runnerTimeoutMs,
            defaultTimeout: formatDurationMs(
              ctx.policy.execution.runnerTimeoutMs,
            ),
            maxTimeoutMs: ctx.policy.execution.runnerMaxTimeoutMs,
            maxTimeout: formatDurationMs(
              ctx.policy.execution.runnerMaxTimeoutMs,
            ),
            note: "Requested timeout values are validated explicitly and are never silently reduced to the default.",
          },
          preferredTools,
          capabilityGroups: summarizeCapabilityGroups(),
          toolArchitecture: {
            facadeTools: preferredTools,
            atomicTypedToolsRetained: true,
            internalHandlersRetained: true,
            domainSchemaLoading: 'static_stable_surface',
            dynamicDomainSchemaLoadingSupported: false,
            capabilityDescriptorCount: capabilityDescriptors.length,
          },
          toolExposure: {
            preferred: preferredTools,
            note: "Prefer the five rh_* workflow facades for orchestration. Typed repository, Git, Issue/Task, Campaign, plugin, browser, iOS, artifact, and recovery tools remain available because the current MCP transport cannot load domain schemas per conversation.",
            advanced: expectedTools.filter((tool) => !preferredTools.includes(tool)).slice(0, 40),
            compatibilityRetained: true,
          },
          expectedTools,
          facadeToolsPresentInExpectedTools: preferredTools.every((tool: string) => expectedTools.includes(tool)),
          staleConnector,
          missingFacadeTools,
          connectorFreshness: {
            status: connectorFreshness.status,
            severity: connectorFreshness.severity,
            summary: connectorFreshness.summary,
            missingLocalTools: connectorFreshness.missingLocalTools,
            missingConnectorTools: connectorFreshness.missingConnectorTools,
            expectedFacadeTools: connectorFreshness.expectedFacadeTools,
            restartRecommended: connectorFreshness.restartRecommended,
            reconnectRecommended: connectorFreshness.reconnectRecommended,
            suggestedActions: connectorFreshness.suggestedActions,
          },
          docs: [
            "docs/architecture/current/README.md",
            "docs/architecture/history.md",
            "docs/operations/controller-reliability-runbook.md",
            "docs/repo-harness-github-issue-launcher.md",
            "docs/repo-harness-chatgpt-mcp-setup.md",
          ],
          staleConnectorHint: staleConnector
            ? `Stale ChatGPT connector tool snapshot is missing facade tools: ${missingFacadeTools.join(", ")}. Refresh/reconnect MCP so tools/list reloads rh_status, rh_inbox, rh_context, and rh_work.`
            : connectorFreshness.status === "unable_to_verify_chatgpt_snapshot"
              ? `Local MCP tool surface includes preferred facade tools. ChatGPT connector snapshot was not supplied, so freshness cannot be verified from this call. If ChatGPT tools/list is missing rh_status/rh_inbox/rh_context/rh_work, reconnect MCP. Pass connector_tool_names for an exact check.`
              : connectorFreshness.status === "stale_fingerprint"
                ? `Local MCP process fingerprint/version may be stale. Restart controller/MCP, then reconnect ChatGPT if rh_* are still missing.`
                : connectorFreshness.status === "local_mcp_missing_facade"
                  ? `Local MCP tool surface is missing facade tools: ${connectorFreshness.missingLocalTools.join(", ")}. Restart controller/MCP.`
                  : `Connector clients must match ${CONTROLLER_TOOL_SURFACE} schema ${CONTROLLER_SCHEMA_VERSION}. Prefer rh_status/rh_inbox/rh_context/rh_work. Pass connector_tool_names to detect a stale ChatGPT tool snapshot precisely.`,
        };
        audit(ctx, name, "ok", args);
        return textResult(payload);
      }
      case "local_bridge_status": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "local_bridge_status requires the controller profile",
          );
        const runtime = loadMcpRuntimeState(ctx.repoRoot);
        const reconciliation = reconcileLocalBridgeJobs(ctx.repoRoot);
        const jobs = listLocalBridgeJobs(ctx.repoRoot, 12);
        const payload = {
          endpoint:
            runtime?.localController?.endpoint ?? "http://127.0.0.1:8766/",
          running: runtime?.localController?.running ?? false,
          error: runtime?.localController?.error,
          counts: jobs.reduce<Record<string, number>>((counts, job) => {
            counts[job.status] = (counts[job.status] ?? 0) + 1;
            return counts;
          }, {}),
          approvalQueue: false,
          reconciliation,
          recentJobs: jobs.map((job) => ({
            jobId: job.jobId,
            action: job.action,
            status: job.status,
            checkId: job.action === "run-check" ? (job.payload as { checkId?: string }).checkId : undefined,
            runId: job.runId,
            issueId: job.issueId,
            taskId: job.taskId,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            finishedAt: job.finishedAt,
            revision: job.revision,
            deadlineAt: job.deadlineAt,
            error: job.error?.slice(0, 300),
          })),
          fallback:
            "Open the localhost Local Controller to launch work or inspect execution when a ChatGPT write action is unavailable.",
        };
        audit(ctx, name, "ok", args);
        return textResult(payload);
      }
      case "controller_context_pack": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "controller_context_pack requires the controller profile",
          );
        const pack = buildControllerContextPack(ctx.repoRoot, ctx.policy, {
          description: typeof args.description === "string" ? args.description : undefined,
          issueId: typeof args.issue_id === "string" ? args.issue_id : undefined,
          taskId: typeof args.task_id === "string" ? args.task_id : undefined,
          knownPaths: stringList(args.known_paths),
          includeGlobs: stringList(args.include_globs),
          excludeGlobs: stringList(args.exclude_globs),
          searchTerms: stringList(args.search_terms),
          maxFiles: typeof args.max_files === "number" ? args.max_files : undefined,
          maxSnippets: typeof args.max_snippets === "number" ? args.max_snippets : undefined,
          maxCharsPerSnippet: typeof args.max_chars_per_snippet === "number" ? args.max_chars_per_snippet : undefined,
        });
        audit(ctx, name, "ok", args);
        return textResult(pack);
      }
      case "controller_context": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "controller_context requires the controller profile",
          );
        const board = projectBoard(ctx.repoRoot);
        const taskLedger = buildControllerTaskLedgerProjection(ctx.repoRoot);
        const runs = listAgentJobs(ctx.repoRoot, 8);
        const reconciliation = reconcileLocalBridgeJobs(ctx.repoRoot);
        const jobs = listLocalBridgeJobs(ctx.repoRoot, 8);
        const checks = listControllerChecks(ctx.repoRoot).map((check) => ({
          id: check.id,
          description: check.description,
          timeoutMs: check.timeoutMs,
          source: check.source,
        }));
        const assessment = typeof args.description === "string" && args.description.trim()
          ? assessWorkMode({
              description: String(args.description),
              knownPaths: stringList(args.known_paths),
              expectedFiles: typeof args.expected_files === "number" ? args.expected_files : undefined,
              expectedChangedLines: typeof args.expected_changed_lines === "number" ? args.expected_changed_lines : undefined,
              requiresInvestigation: args.requires_investigation === true,
              requiresParallelism: args.requires_parallelism === true,
              requiresLongRunningChecks: args.requires_long_running_checks === true,
              needsDependencies: args.needs_dependencies === true,
              risk: typeof args.risk === "string" ? args.risk as TaskRisk : undefined,
            })
          : undefined;
        const payload = {
          git: gitSnapshot(ctx.repoRoot),
          currentIssueId: board.currentIssueId,
          taskLedger,
          taskLedgerStatus: taskLedger.status,
          currentIssue: board.issues.find((issue) => issue.id === board.currentIssueId)
            ? {
                id: board.issues.find((issue) => issue.id === board.currentIssueId)?.id,
                title: board.issues.find((issue) => issue.id === board.currentIssueId)?.title,
                status: board.issues.find((issue) => issue.id === board.currentIssueId)?.status,
              }
            : undefined,
          readyTasks: board.readyTasks.slice(0, 10),
          activeRuns: runs.map((run) => ({
            runId: run.runId,
            issueId: run.issueId,
            taskId: run.taskId,
            status: run.status,
            agent: run.agent,
            provider: run.provider,
            executionMode: run.executionMode,
            progress: run.progress,
            lastHeartbeatAt: run.lastHeartbeatAt,
            error: run.error?.slice(0, 300),
          })),
          localBridge: {
            reconciliation,
            recentJobs: jobs.map((job) => ({
              jobId: job.jobId,
              action: job.action,
              status: job.status,
              checkId: job.action === "run-check" ? (job.payload as { checkId?: string }).checkId : undefined,
              issueId: job.issueId,
              taskId: job.taskId,
              updatedAt: job.updatedAt,
            })),
          },
          checks,
          recommendedExecution: assessment,
        };
        audit(ctx, name, "ok", args);
        return textResult(payload);
      }
      case "quick_agent_session":
      case "submit_local_job": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            `${name} requires the controller profile`,
          );
        const requestArgs = name === "quick_agent_session"
          ? { ...args, action: "quick-agent-session" }
          : args;
        const request = localBridgeRequestFromArgs(requestArgs);
        const job = submitLocalBridgeJob(ctx.repoRoot, request);
        const result =
          job.status === "approved"
            ? executeLocalBridgeJob(ctx.repoRoot, job.jobId)
            : job;
        audit(ctx, name, "ok", args, undefined);
        return textResult({
          accepted: true,
          job: {
            jobId: result.jobId,
            action: result.action,
            status: result.status,
            runId: result.runId,
            issueId: result.issueId,
            taskId: result.taskId,
            updatedAt: result.updatedAt,
          },
          localController:
            loadMcpRuntimeState(ctx.repoRoot)?.localController?.endpoint ??
            "http://127.0.0.1:8766/",
          next: result.runId
            ? `Inspect Run ${result.runId}.`
            : "Inspect the Job result.",
        });
      }
      case "list_local_jobs": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "list_local_jobs requires the controller profile",
          );
        const limit = typeof args.limit === "number" ? args.limit : 50;
        const jobs = listLocalBridgeJobs(ctx.repoRoot, limit);
        audit(ctx, name, "ok", args);
        return textResult({ jobs });
      }
      case "get_local_job": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "get_local_job requires the controller profile",
          );
        const jobId = String(args.job_id ?? "").trim();
        const includeEvents = args.include_events === true;
        const includeOutput = args.include_output === true;
        const snapshot = getLocalBridgeJobSnapshot(ctx.repoRoot, jobId);
        const payload = {
          job: snapshot.job,
          ...(snapshot.status !== "ok" ? { lookup: snapshot } : {}),
          ...(includeEvents && snapshot.status === "ok" ? { events: getLocalBridgeJobEvents(ctx.repoRoot, jobId) } : {}),
          ...(includeOutput
            ? {
                output: readLocalBridgeJobOutput(ctx.repoRoot, jobId, {
                  stream: args.stream === "stderr" ? "stderr" : "stdout",
                  maxBytes: typeof args.max_bytes === "number" ? args.max_bytes : undefined,
                }),
              }
            : {}),
        };
        audit(ctx, name, "ok", args);
        return textResult(payload);
      }
      case "get_local_job_output": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "get_local_job_output requires the controller profile",
          );
        const jobId = String(args.job_id ?? "").trim();
        const payload = readLocalBridgeJobOutput(ctx.repoRoot, jobId, {
          stream: args.stream === "stderr" ? "stderr" : "stdout",
          maxBytes: typeof args.max_bytes === "number" ? args.max_bytes : undefined,
        });
        audit(ctx, name, "ok", args);
        return textResult(payload);
      }
      case "project_snapshot": {
        if (ctx.policy.profile !== "controller") return errorResult("TOOL_DISABLED", "project_snapshot requires the controller profile");
        const markerPaths = [
          ".ai/harness/active-plan",
          ".ai/harness/active-sprint",
          ".ai/harness/active-worktree",
          "tasks/current.md",
        ];
        const markers = markerPaths.map((path) => {
          const absolute = join(ctx.repoRoot, path);
          if (!existsSync(absolute)) return { path, exists: false };
          const raw = readFileSync(absolute, "utf-8");
          return {
            path,
            exists: true,
            bytes: Buffer.byteLength(raw),
            lines: raw.split(/\r?\n/).length,
            sha256: createHash("sha256").update(raw).digest("hex").slice(0, 16),
            preview: redactMcpText(raw).text.slice(0, 400),
          };
        });
        const board = projectBoard(ctx.repoRoot);
        const compactIssues = board.issues.slice(0, 50).map((value) => {
          const issue = value as Record<string, any>;
          const tasks = Array.isArray(issue.tasks) ? issue.tasks : [];
          return {
            id: issue.id,
            title: issue.title,
            status: issue.status,
            lifecycleStatus: issue.lifecycleStatus,
            isCurrent: issue.isCurrent,
            updatedAt: issue.updatedAt,
            taskCounts: tasks.reduce<Record<string, number>>((counts, task) => {
              const status = String(task.effectiveStatus ?? task.status ?? "unknown");
              counts[status] = (counts[status] ?? 0) + 1;
              return counts;
            }, {}),
          };
        });
        const snapshotRuns = listAgentJobs(ctx.repoRoot, 11);
        const runs = snapshotRuns.slice(0, 10).map((run) => ({
          runId: run.runId,
          issueId: run.issueId,
          taskId: run.taskId,
          agent: run.agent,
          provider: run.provider,
          executionMode: run.executionMode,
          status: run.status,
          progress: run.progress,
          createdAt: run.createdAt,
          finishedAt: run.finishedAt,
          error: run.error?.slice(0, 300),
        }));
        const payload = {
          git: gitSnapshot(ctx.repoRoot),
          board: {
            counts: board.counts,
            declaredCounts: board.declaredCounts,
            archivedCounts: board.archivedCounts,
            currentIssueId: board.currentIssueId,
            readyTasks: board.readyTasks.slice(0, 50),
            queueableTasks: board.queueableTasks.slice(0, 50),
            issueCount: board.issues.length,
            archivedIssueCount: board.archivedIssueCount,
            issues: compactIssues,
          },
          runs,
          markers,
          truncated: {
            issues: board.issues.length > compactIssues.length,
            readyTasks: board.readyTasks.length > 50,
            queueableTasks: board.queueableTasks.length > 50,
            runs: snapshotRuns.length > 10,
          },
        };
        audit(ctx, name, "ok", args);
        return textResult(payload);
      }
      case "search_repository": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "search_repository requires the controller profile",
          );
        const session = ctx.sessionId && ctx.repoId
          ? {
            sessionId: ctx.sessionId,
            repoId: ctx.repoId,
            checkoutId: ctx.checkoutId ?? ctx.repoId,
          }
          : undefined;
        const result = searchRepository(ctx.repoRoot, ctx.policy, {
          query: String(args.query ?? ""),
          includeGlobs: stringList(args.include_globs),
          excludeGlobs: stringList(args.exclude_globs),
          maxResults:
            typeof args.max_results === "number" ? args.max_results : undefined,
          maxFiles:
            typeof args.max_files === "number" ? args.max_files : undefined,
          caseSensitive: args.case_sensitive === true,
          session,
        });
        audit(ctx, name, "ok", args);
        return textResult(result);
      }
      case "read_repository_file": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "read_repository_file requires the controller profile",
          );
        const path = String(args.path ?? "");
        const session = ctx.sessionId && ctx.repoId
          ? {
            sessionId: ctx.sessionId,
            repoId: ctx.repoId,
            checkoutId: ctx.checkoutId ?? ctx.repoId,
          }
          : undefined;
        const result = readRepositoryRange(
          ctx.repoRoot,
          ctx.policy,
          path,
          typeof args.start_line === "number" ? args.start_line : 1,
          typeof args.end_line === "number" ? args.end_line : 200,
          session,
        );
        const redacted = redactMcpText(result.content);
        audit(ctx, name, "ok", args, result.path);
        return textResult({
          ...result,
          content: redacted.text,
          redactions: redacted.redactions,
        });
      }
      case "get_git_diff": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "get_git_diff requires the controller profile",
          );
        const path =
          typeof args.path === "string" && args.path.trim()
            ? args.path.trim()
            : undefined;
        if (path) {
          const decision = resolveMcpPath(
            ctx.repoRoot,
            path,
            ctx.policy,
            "read",
          );
          if (!decision.ok)
            return errorResult(
              "POLICY_DENIED",
              decision.reason ?? "path denied",
              { path },
            );
        }
        const maxBytes =
          typeof args.max_bytes === "number"
            ? Math.min(Math.max(Math.trunc(args.max_bytes), 1024), 512 * 1024)
            : 128 * 1024;
        const result = gitDiff(ctx.repoRoot, path, maxBytes);
        const redacted = redactMcpText(result.diff);
        audit(ctx, name, "ok", args, path);
        return textResult({
          ...result,
          diff: redacted.text,
          redactions: redacted.redactions,
        });
      }
      case "list_checks": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "list_checks requires the controller profile",
          );
        const checks = listControllerChecks(ctx.repoRoot);
        audit(ctx, name, "ok", args);
        return textResult({ checks });
      }
      case "run_check": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "run_check requires the controller profile",
          );
        const job = submitLocalBridgeJob(ctx.repoRoot, {
          action: "run-check",
          requestedBy: "mcp:run_check",
          payload: {
            checkId: String(args.check_id ?? ""),
            timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
            requestId: typeof args.request_id === "string" ? args.request_id.trim() || undefined : undefined,
          },
        });
        const result = job.status === "approved"
          ? executeLocalBridgeJob(ctx.repoRoot, job.jobId)
          : job;
        audit(ctx, name, "ok", args);
        return textResult({
          job: result,
          localController:
            loadMcpRuntimeState(ctx.repoRoot)?.localController?.endpoint ??
            "http://127.0.0.1:8766/",
          next: `Inspect Job ${result.jobId} with get_local_job.`,
        });
      }
      case "list_issues": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "list_issues requires the controller profile",
          );
        const projectState = loadControllerProjectState(ctx.repoRoot);
        const issues = listIssueEffectiveViews(ctx.repoRoot).map((issue) => {
          const readiness = inspectIssueReadiness(ctx.repoRoot, issue.id);
          return {
          id: issue.id,
          title: issue.title,
          kind: issue.kind,
          status: issue.status,
          lifecycleStatus: issue.lifecycleStatus,
          archivedAt: issue.archivedAt,
          isCurrent: projectState.currentIssueId === issue.id,
          updatedAt: issue.updatedAt,
          taskCount: issue.tasks.length,
          taskCounts: issue.tasks.reduce<Record<string, number>>((counts, task) => {
            counts[task.effectiveStatus] = (counts[task.effectiveStatus] ?? 0) + 1;
            return counts;
          }, {}),
          declaredTaskCounts: issue.tasks.reduce<Record<string, number>>((counts, task) => {
            counts[task.declaredStatus] = (counts[task.declaredStatus] ?? 0) + 1;
            return counts;
          }, {}),
          readyTaskIds: readiness.readyTaskIds,
          queueableTaskIds: readiness.queueableTaskIds,
          approvalPendingTaskIds: readiness.approvalPendingTaskIds,
        };
        });
        audit(ctx, name, "ok", args);
        return textResult({ issues });
      }
      case "get_project_board": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "get_project_board requires the controller profile",
          );
        const board = projectBoard(ctx.repoRoot);
        audit(ctx, name, "ok", args);
        return textResult(board);
      }
      case "get_project_progress": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "get_project_progress requires the controller profile");
        const progress = getProjectProgress(ctx.repoRoot);
        audit(ctx, name, "ok", args);
        return textResult(progress);
      }
      case "get_project_governance": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "get_project_governance requires the controller profile");
        const governance = inspectProjectGovernance(ctx.repoRoot);
        audit(ctx, name, "ok", args);
        return textResult(governance);
      }
      case "reconcile_project_governance": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "reconcile_project_governance requires the controller profile");
        const result = reconcileProjectGovernance(ctx.repoRoot);
        audit(ctx, name, "ok", args, ".ai/harness/controller/project-state.json");
        return textResult(result);
      }
      case "get_project_state": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "get_project_state requires the controller profile");
        const state = loadControllerProjectState(ctx.repoRoot);
        audit(ctx, name, "ok", args);
        return textResult(state);
      }
      case "set_current_issue": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "set_current_issue requires the controller profile");
        const issue = getIssue(ctx.repoRoot, String(args.issue_id ?? ""));
        if (issue.archivedAt || ["done", "cancelled"].includes(issue.status))
          return errorResult("ISSUE_NOT_ACTIVE", `only an active, non-archived Issue can be selected (current: ${issue.status})`);
        const state = saveControllerProjectState(ctx.repoRoot, { currentIssueId: issue.id }, "chatgpt-controller");
        audit(ctx, name, "ok", args, ".ai/harness/controller/project-state.json");
        return textResult(state);
      }
      case "archive_issue": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "archive_issue requires the controller profile");
        const issue = archiveIssue(ctx.repoRoot, String(args.issue_id ?? ""));
        audit(ctx, name, "ok", args, `tasks/issues/${issue.id}`);
        return textResult(projectIssueEffectiveView(ctx.repoRoot, issue));
      }
      case "restore_issue": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "restore_issue requires the controller profile");
        const issue = restoreIssue(ctx.repoRoot, String(args.issue_id ?? ""));
        audit(ctx, name, "ok", args, `tasks/issues/${issue.id}`);
        return textResult(projectIssueEffectiveView(ctx.repoRoot, issue));
      }
      case "get_task_progress_detail": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "get_task_progress_detail requires the controller profile");
        const result = getTaskProgressReadView(
          ctx.repoRoot,
          String(args.issue_id ?? ""),
          String(args.task_id ?? ""),
          args.detail_level === "full" ? "full" : "summary",
        );
        audit(ctx, name, "ok", args, `tasks/issues/${result.issue.id}`);
        return textResult(result);
      }
      case "get_worklog_timeline": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "get_worklog_timeline requires the controller profile");
        const events = getControllerTimeline(ctx.repoRoot, {
          category: parseWorklogCategory(args.category),
          issueId: typeof args.issue_id === "string" ? args.issue_id : undefined,
          taskId: typeof args.task_id === "string" ? args.task_id : undefined,
          runId: typeof args.run_id === "string" ? args.run_id : undefined,
          editSessionId: typeof args.edit_session_id === "string" ? args.edit_session_id : undefined,
          since: typeof args.since === "string" ? args.since : undefined,
          until: typeof args.until === "string" ? args.until : undefined,
          limit: typeof args.limit === "number" ? Math.trunc(args.limit) : undefined,
        });
        audit(ctx, name, "ok", args);
        return textResult({ events });
      }
      case "export_worklog": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "export_worklog requires the controller profile");
        const result = exportControllerWorklog(ctx.repoRoot, {
          format: args.format === "json" ? "json" : "markdown",
          outputPath: typeof args.output_path === "string" ? args.output_path : undefined,
          filter: {
            issueId: typeof args.issue_id === "string" ? args.issue_id : undefined,
            taskId: typeof args.task_id === "string" ? args.task_id : undefined,
            runId: typeof args.run_id === "string" ? args.run_id : undefined,
            editSessionId: typeof args.edit_session_id === "string" ? args.edit_session_id : undefined,
          },
        });
        audit(ctx, name, "ok", args, result.path);
        return textResult(result);
      }
      case "get_github_plugin_status": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "get_github_plugin_status requires the controller profile");
        const status = getGitHubPluginStatus(ctx.repoRoot);
        audit(ctx, name, "ok", args, status.repository);
        return textResult(status);
      }
      case "configure_github_plugin": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "configure_github_plugin requires the controller profile");
        const config = saveGitHubPluginConfig(ctx.repoRoot, {
          enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
          repository: args.clear_repository === true ? "" : typeof args.repository === "string" ? args.repository : undefined,
          syncMode: args.sync_mode === "checkpoint" ? "checkpoint" : args.sync_mode === "manual" ? "manual" : undefined,
          includeTasks: typeof args.include_tasks === "boolean" ? args.include_tasks : undefined,
          projectOwner: args.clear_project === true ? "" : typeof args.project_owner === "string" ? args.project_owner : undefined,
          projectNumber: args.clear_project === true ? null : typeof args.project_number === "number" ? args.project_number : undefined,
        });
        audit(ctx, name, "ok", args, ".repo-harness/plugins/github.json");
        return textResult(config);
      }
      case "get_issue": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "get_issue requires the controller profile",
          );
        const issue = getIssueReadView(
          ctx.repoRoot,
          String(args.issue_id ?? ""),
          args.detail_level === "full" ? "full" : "summary",
        );
        audit(ctx, name, "ok", args, `tasks/issues/${issue.id}`);
        return textResult(issue);
      }
      case "github_status": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "github_status requires the controller profile",
          );
        const status = getGitHubStatus(
          ctx.repoRoot,
          typeof args.repo === "string" ? args.repo : undefined,
        );
        audit(
          ctx,
          name,
          status.available && status.authenticated ? "ok" : "failed",
          args,
          status.repository?.nameWithOwner,
          status.errors.join("; "),
        );
        return textResult(status);
      }
      case "publish_issue_to_github": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "publish_issue_to_github requires the controller profile",
          );
        const issue = publishIssueToGitHub(
          ctx.repoRoot,
          String(args.issue_id ?? ""),
          {
            repo: typeof args.repo === "string" ? args.repo : undefined,
            labels: stringList(args.labels),
            includeTasks: args.include_tasks === true,
            projectOwner:
              typeof args.project_owner === "string"
                ? args.project_owner
                : undefined,
            projectNumber:
              typeof args.project_number === "number"
                ? Math.trunc(args.project_number)
                : undefined,
          },
        );
        audit(ctx, name, "ok", args, issue.github?.url);
        return textResult(projectIssueEffectiveView(ctx.repoRoot, issue));
      }
      case "refresh_github_issue": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "refresh_github_issue requires the controller profile",
          );
        const result = refreshGitHubIssue(
          ctx.repoRoot,
          String(args.issue_id ?? ""),
        );
        audit(ctx, name, "ok", args, result.issue.github?.url);
        return textResult({
          ...result,
          issue: projectIssueEffectiveView(ctx.repoRoot, result.issue),
        });
      }
      case "close_github_issue": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "close_github_issue requires the controller profile",
          );
        const issue = closeGitHubIssue(
          ctx.repoRoot,
          String(args.issue_id ?? ""),
        );
        audit(ctx, name, "ok", args, issue.github?.url);
        return textResult(projectIssueEffectiveView(ctx.repoRoot, issue));
      }
      case "inspect_issue_readiness": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "inspect_issue_readiness requires the controller profile",
          );
        const readiness = inspectIssueReadiness(
          ctx.repoRoot,
          String(args.issue_id ?? ""),
        );
        audit(
          ctx,
          name,
          readiness.ready ? "ok" : "blocked",
          args,
          `tasks/issues/${readiness.issueId}`,
          [...readiness.blockers, ...readiness.taskBlockers].map((item) => item.message).join("; "),
        );
        return textResult(readiness);
      }
      case "inspect_task_readiness": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "inspect_task_readiness requires the controller profile",
          );
        const readiness = inspectTaskReadiness(
          ctx.repoRoot,
          String(args.issue_id ?? ""),
          String(args.task_id ?? ""),
          {
            retryFromRunId: typeof args.retry_from_run_id === "string" ? args.retry_from_run_id : undefined,
            approveDestructive: args.approve_destructive === true,
          },
        );
        audit(
          ctx,
          name,
          readiness.ready ? "ok" : "blocked",
          args,
          `tasks/issues/${readiness.issueId}`,
          readiness.blockers.map((item) => item.message).join("; "),
        );
        return textResult(readiness);
      }
      case "prepare_issue_launch": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "prepare_issue_launch requires the controller profile",
          );
        const issueId = String(args.issue_id ?? "");
        const issue = getIssue(ctx.repoRoot, issueId);
        const readiness = inspectIssueReadiness(ctx.repoRoot, issueId);
        const maxParallel = Math.min(
          Math.max(
            typeof args.max_parallel === "number"
              ? Math.trunc(args.max_parallel)
              : readiness.suggestedMaxParallel,
            1,
          ),
          4,
        );
        const tasks = issue.tasks
          .filter((task) => readiness.queueableTaskIds.includes(task.id))
          .map((task) => ({
            id: task.id,
            title: task.title,
            agent: task.recommendedAgent ?? "runtime-selected",
            risk: task.risk,
            allowedPaths: task.allowedPaths,
            checks: task.checks,
            acceptanceCriteria: task.acceptanceCriteria,
            github: task.github,
          }));
        const preview = {
          issue: {
            id: issue.id,
            title: issue.title,
            status: issue.status,
            github: issue.github,
          },
          readiness,
          maxParallel,
          tasks,
        };
        audit(
          ctx,
          name,
          readiness.queueable ? "ok" : "blocked",
          args,
          `tasks/issues/${issue.id}`,
        );
        return textResult(preview);
      }
      case "assess_work_request": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "assess_work_request requires the controller profile");
        const assessment = assessWorkMode({
          description: String(args.description ?? ""),
          knownPaths: stringList(args.known_paths),
          expectedFiles: typeof args.expected_files === "number" ? args.expected_files : undefined,
          expectedChangedLines: typeof args.expected_changed_lines === "number" ? args.expected_changed_lines : undefined,
          requiresInvestigation: args.requires_investigation === true,
          requiresParallelism: args.requires_parallelism === true,
          requiresLongRunningChecks: args.requires_long_running_checks === true,
          needsDependencies: args.needs_dependencies === true,
          risk: typeof args.risk === "string" ? args.risk as TaskRisk : undefined,
        });
        audit(ctx, name, "ok", args);
        return textResult(assessment);
      }
      case "create_issue": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "create_issue requires the controller profile",
          );
        const issue = createIssue(ctx.repoRoot, {
          title: String(args.title ?? ""),
          kind: (args.kind ? String(args.kind) : "feature") as IssueKind,
          summary: typeof args.summary === "string" ? args.summary : undefined,
          goals: stringList(args.goals),
          nonGoals: stringList(args.non_goals),
          acceptanceCriteria: stringList(args.acceptance_criteria),
          relatedArtifacts: stringList(args.related_artifacts),
          tasks: controllerTaskDrafts(args.tasks),
          allowWhileFocused: args.allow_while_focused === true,
          allowDuplicate: args.allow_duplicate === true,
          allowWhenPaused: args.allow_when_paused === true,
        });
        audit(ctx, name, "ok", args, `tasks/issues/${issue.id}`);
        return textResult(projectIssueEffectiveView(ctx.repoRoot, issue));
      }
      case "update_issue": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "update_issue requires the controller profile",
          );
        const issue = updateIssue(ctx.repoRoot, String(args.issue_id ?? ""), {
          title: typeof args.title === "string" ? args.title : undefined,
          status:
            typeof args.status === "string"
              ? (args.status as IssueStatus)
              : undefined,
          summary: typeof args.summary === "string" ? args.summary : undefined,
          goals: Array.isArray(args.goals) ? stringList(args.goals) : undefined,
          nonGoals: Array.isArray(args.non_goals)
            ? stringList(args.non_goals)
            : undefined,
          acceptanceCriteria: Array.isArray(args.acceptance_criteria)
            ? stringList(args.acceptance_criteria)
            : undefined,
          relatedArtifacts: Array.isArray(args.related_artifacts)
            ? stringList(args.related_artifacts)
            : undefined,
        });
        audit(ctx, name, "ok", args, `tasks/issues/${issue.id}`);
        return textResult(projectIssueEffectiveView(ctx.repoRoot, issue));
      }
      case "plan_issue": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "plan_issue requires the controller profile",
          );
        const issue = planIssue(
          ctx.repoRoot,
          String(args.issue_id ?? ""),
          controllerTaskDrafts(args.tasks),
        );
        audit(ctx, name, "ok", args, `tasks/issues/${issue.id}`);
        return textResult(projectIssueEffectiveView(ctx.repoRoot, issue));
      }
      case "append_task": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "append_task requires the controller profile",
          );
        const drafts = controllerTaskDrafts([args.task]);
        if (drafts.length !== 1)
          return errorResult(
            "INVALID_TASK",
            "append_task requires one valid task",
          );
        const issue = appendTask(
          ctx.repoRoot,
          String(args.issue_id ?? ""),
          drafts[0],
        );
        audit(ctx, name, "ok", args, `tasks/issues/${issue.id}`);
        return textResult(projectIssueEffectiveView(ctx.repoRoot, issue));
      }
      case "split_task": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "split_task requires the controller profile",
          );
        const issue = splitTask(
          ctx.repoRoot,
          String(args.issue_id ?? ""),
          String(args.task_id ?? ""),
          controllerTaskDrafts(args.tasks),
        );
        audit(ctx, name, "ok", args, `tasks/issues/${issue.id}`);
        return textResult(projectIssueEffectiveView(ctx.repoRoot, issue));
      }
      case "supersede_task": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "supersede_task requires the controller profile",
          );
        const issue = supersedeTask(
          ctx.repoRoot,
          String(args.issue_id ?? ""),
          String(args.task_id ?? ""),
          stringList(args.replacement_task_ids),
        );
        audit(ctx, name, "ok", args, `tasks/issues/${issue.id}`);
        return textResult(projectIssueEffectiveView(ctx.repoRoot, issue));
      }
      case "set_task_dependencies": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "set_task_dependencies requires the controller profile",
          );
        const issue = setTaskDependencies(
          ctx.repoRoot,
          String(args.issue_id ?? ""),
          String(args.task_id ?? ""),
          stringList(args.depends_on),
        );
        audit(ctx, name, "ok", args, `tasks/issues/${issue.id}`);
        return textResult(projectIssueEffectiveView(ctx.repoRoot, issue));
      }
      case "update_task": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "update_task requires the controller profile",
          );
        const issue = updateTask(
          ctx.repoRoot,
          String(args.issue_id ?? ""),
          String(args.task_id ?? ""),
          {
            status:
              typeof args.status === "string"
                ? (args.status as TaskStatus)
                : undefined,
            note: typeof args.note === "string" ? args.note : undefined,
          },
        );
        audit(ctx, name, "ok", args, `tasks/issues/${issue.id}`);
        return textResult(projectIssueEffectiveView(ctx.repoRoot, issue));
      }
      case "dispatch_task": {
        if (ctx.policy.profile !== "controller") return errorResult("TOOL_DISABLED", "dispatch_task requires the controller profile");
        const issueId = String(args.issue_id ?? "").trim();
        const taskId = String(args.task_id ?? "").trim();
        if (!issueId) return errorResult("ISSUE_ID_REQUIRED", "dispatch_task requires issue_id. Use quick_agent_session for direct Codex/Claude work without an Issue.");
        if (!taskId) return errorResult("TASK_ID_REQUIRED", "dispatch_task requires task_id. Use quick_agent_session for direct Codex/Claude work without a Task.");
        const issue = getIssue(ctx.repoRoot, issueId);
        const task = issue.tasks.find((entry) => entry.id === taskId);
        if (!task) return errorResult("TASK_NOT_FOUND", `task not found: ${issueId}/${taskId}`);
        const requested = resolveDispatchAgent(ctx, task, args.agent);
        if (!requested) return errorResult("AGENT_REQUIRED", "No agent is selected or enabled. Pass agent explicitly or enable a local agent in the controller profile.");
        const requestId = typeof args.request_id === "string" ? args.request_id.trim() || undefined : undefined;
        const health = taskExecutorHealth(
          ctx,
          task,
          requested,
          typeof args.github_repo === "string" ? args.github_repo : undefined,
        );
        if (health) return dispatchExecutorHealthResult(health, { requestId, retryable: false });
        try {
          const accepted = acceptTaskJob({
            repoRoot: ctx.repoRoot,
            issueId,
            taskId,
            agent: requested,
            executorPolicy: {
              agentRunner: ctx.policy.execution.agentRunner,
              allowedAgents: ctx.policy.execution.allowedAgents,
            },
            timeoutMs: runnerTimeoutMs(ctx, args.timeout_ms),
            isolate: typeof args.isolate === "boolean" ? args.isolate : undefined,
            githubRepo: typeof args.github_repo === "string" ? args.github_repo : undefined,
            baseRef: typeof args.base_ref === "string" ? args.base_ref : undefined,
            model: typeof args.model === "string" ? args.model : undefined,
            createPullRequest: args.create_pull_request !== false,
            requestId,
            approveDestructive: args.approve_destructive === true,
          });
          dispatchAcceptedTaskJob(ctx.repoRoot, accepted.runId);
          audit(ctx, name, "ok", args, accepted.runId);
          return textResult(compactDispatchRun(accepted as unknown as Record<string, unknown>));
        } catch (error) {
          if (isExecutorHealthError(error)) {
            audit(ctx, name, "blocked", args, undefined, error.message);
            return dispatchExecutorHealthResult(error.executorHealth, { requestId, retryable: false });
          }
          const message = error instanceof Error ? error.message : String(error);
          audit(ctx, name, "failed", args, undefined, message);
          return dispatchErrorResult("RUN_PERSIST_FAILED", message, { requestId, retryable: true });
        }
      }
      case "launch_issue": {
        if (ctx.policy.profile !== "controller") return errorResult("TOOL_DISABLED", "launch_issue requires the controller profile");
        const issueId = String(args.issue_id ?? "");
        const issue = getIssue(ctx.repoRoot, issueId);
        const maxParallel = Math.min(Math.max(typeof args.max_parallel === "number" ? Math.trunc(args.max_parallel) : 2, 1), 4);
        const selected: ControllerTask[] = [];
        const skipped: Array<{ taskId: string; reason: string; readiness?: unknown; executorHealth?: ExecutorHealth }> = [];
        for (const task of issue.tasks) {
          const readiness = inspectTaskReadiness(ctx.repoRoot, issueId, task.id, {
            approveDestructive: args.approve_destructive === true,
          });
          if (!readiness.ready) {
            skipped.push({ taskId: task.id, reason: readiness.blockers.map((entry) => entry.code).join(", ") || "not dispatchable", readiness });
            continue;
          }
          if (selected.length >= maxParallel) break;
          if (selected.some((entry) => taskWriteScopesConflict(entry, task))) {
            skipped.push({ taskId: task.id, reason: "allowed path scope overlaps another selected Task" });
            continue;
          }
          selected.push(task);
        }
        const runs = [];
        for (const task of selected) {
          const agent = resolveDispatchAgent(ctx, task, args.agent);
          if (!agent) {
            skipped.push({ taskId: task.id, reason: "no runtime agent selected or enabled" });
            continue;
          }
          const health = taskExecutorHealth(
            ctx,
            task,
            agent,
            typeof args.github_repo === "string" ? args.github_repo : undefined,
          );
          if (health) {
            skipped.push({ taskId: task.id, reason: health.message, executorHealth: health });
            continue;
          }
          runs.push(startTaskJob({
            repoRoot: ctx.repoRoot,
            issueId,
            taskId: task.id,
            agent,
            executorPolicy: {
              agentRunner: ctx.policy.execution.agentRunner,
              allowedAgents: ctx.policy.execution.allowedAgents,
            },
            timeoutMs: runnerTimeoutMs(ctx, args.timeout_ms),
            isolate: typeof args.isolate === "boolean" ? args.isolate : undefined,
            githubRepo: typeof args.github_repo === "string" ? args.github_repo : undefined,
            baseRef: typeof args.base_ref === "string" ? args.base_ref : undefined,
            model: typeof args.model === "string" ? args.model : undefined,
            createPullRequest: args.create_pull_request !== false,
            approveDestructive: args.approve_destructive === true,
          }));
        }
        const readiness = inspectIssueReadiness(ctx.repoRoot, issueId);
        audit(ctx, name, runs.length > 0 ? "ok" : "failed", args, `tasks/issues/${issue.id}`);
        return textResult({
          readiness,
          dispatched: runs.length,
          runs: runs.map((run) => compactDispatchRun(run as unknown as Record<string, unknown>)),
          skipped,
        });
      }
      case "dispatch_ready_tasks": {
        if (ctx.policy.profile !== "controller") return errorResult("TOOL_DISABLED", "dispatch_ready_tasks requires the controller profile");
        const requestedIssue = typeof args.issue_id === "string" && args.issue_id.trim() ? args.issue_id.trim() : undefined;
        const maxParallel = Math.min(Math.max(typeof args.max_parallel === "number" ? Math.trunc(args.max_parallel) : 2, 1), 4);
        const batchRequestId = typeof args.request_id === "string" ? args.request_id.trim() || undefined : undefined;
        const candidates: Array<{ issueId: string; task: ControllerTask }> = [];
        const skipped: Array<{ issueId: string; taskId: string; reason: string; executorHealth?: ExecutorHealth }> = [];
        for (const issue of listIssues(ctx.repoRoot)) {
          if (requestedIssue && issue.id !== requestedIssue) continue;
          if (issue.archivedAt || ["done", "cancelled"].includes(issue.status)) continue;
          for (const task of issue.tasks) {
            const readiness = inspectTaskReadiness(ctx.repoRoot, issue.id, task.id, {
                approveDestructive: args.approve_destructive === true,
            });
            if (readiness.ready) candidates.push({ issueId: issue.id, task });
            else if (readiness.blockers.length > 0) skipped.push({ issueId: issue.id, taskId: task.id, reason: readiness.blockers.map((entry) => entry.code).join(", ") });
          }
        }
        const selected: Array<{ issueId: string; task: ControllerTask }> = [];
        for (const candidate of candidates) {
          if (selected.length >= maxParallel) break;
          if (selected.some((entry) => taskWriteScopesConflict(entry.task, candidate.task))) {
            skipped.push({ issueId: candidate.issueId, taskId: candidate.task.id, reason: "allowed path scope overlaps another selected Task" });
            continue;
          }
          selected.push(candidate);
        }
        const accepted = [];
        for (const candidate of selected) {
          const agent = resolveDispatchAgent(ctx, candidate.task, args.agent);
          if (!agent) {
            skipped.push({ issueId: candidate.issueId, taskId: candidate.task.id, reason: "no runtime agent selected or enabled" });
            continue;
          }
          const health = taskExecutorHealth(
            ctx,
            candidate.task,
            agent,
            typeof args.github_repo === "string" ? args.github_repo : undefined,
          );
          if (health) {
            skipped.push({ issueId: candidate.issueId, taskId: candidate.task.id, reason: health.message, executorHealth: health });
            continue;
          }
          const requestId = batchRequestId ? `${batchRequestId}:${candidate.issueId}:${candidate.task.id}` : undefined;
          try {
            const summary = acceptTaskJob({
              repoRoot: ctx.repoRoot,
              issueId: candidate.issueId,
              taskId: candidate.task.id,
              agent,
              executorPolicy: {
                agentRunner: ctx.policy.execution.agentRunner,
                allowedAgents: ctx.policy.execution.allowedAgents,
              },
              timeoutMs: runnerTimeoutMs(ctx, args.timeout_ms),
              isolate: typeof args.isolate === "boolean" ? args.isolate : undefined,
              githubRepo: typeof args.github_repo === "string" ? args.github_repo : undefined,
              baseRef: typeof args.base_ref === "string" ? args.base_ref : undefined,
              model: typeof args.model === "string" ? args.model : undefined,
              createPullRequest: args.create_pull_request !== false,
              requestId,
              approveDestructive: args.approve_destructive === true,
            });
            dispatchAcceptedTaskJob(ctx.repoRoot, summary.runId);
            accepted.push(summary);
          } catch (error) {
            if (isExecutorHealthError(error)) {
              skipped.push({
                issueId: candidate.issueId,
                taskId: candidate.task.id,
                reason: error.executorHealth.message,
                executorHealth: error.executorHealth,
              });
              continue;
            }
            skipped.push({
              issueId: candidate.issueId,
              taskId: candidate.task.id,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        audit(ctx, name, accepted.length > 0 ? "ok" : "failed", args);
        return textResult({
          requestedIssue,
          dispatched: accepted.length,
          runIds: accepted.map((entry) => entry.runId),
          accepted: accepted.map((entry) => compactDispatchRun(entry as unknown as Record<string, unknown>)),
          skipped,
          currentFocus: loadControllerProjectState(ctx.repoRoot).currentIssueId,
          focusIsInformational: true,
        });
      }
      case "get_task_run": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "get_task_run requires the controller profile",
          );
        const run = getAgentJob(ctx.repoRoot, String(args.run_id ?? ""));
        audit(ctx, name, "ok", args, run.promptPath);
        return textResult(summarizeAgentRun(ctx.repoRoot, run as unknown as Record<string, unknown>, {
          includePaths: args.include_paths === true,
          includeOutput: args.include_output !== false,
          tailChars: typeof args.tail_chars === "number" ? Math.trunc(args.tail_chars) : undefined,
        }));
      }
      case "get_task_run_events": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "get_task_run_events requires the controller profile",
          );
        const sinceEventIndex = typeof args.since_event_index === "number"
          ? Math.trunc(args.since_event_index)
          : undefined;
        const events = getAgentJobEvents(
          ctx.repoRoot,
          String(args.run_id ?? ""),
          typeof args.limit === "number" ? Math.trunc(args.limit) : 200,
          {
            sinceIndex: sinceEventIndex,
            includeHeartbeats: args.include_heartbeats === true,
          },
        );
        audit(ctx, name, "ok", args);
        return textResult({
          events,
          // Keep an existing cursor stable when no new event is available. New events
          // that race with a read are returned on the next call instead of being lost.
          nextSinceEventIndex: events.at(-1)?.data?.eventIndex ?? sinceEventIndex,
          heartbeatsCollapsed: args.include_heartbeats !== true,
        });
      }
      case "get_task_run_log": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "get_task_run_log requires the controller profile",
          );
        const log = getAgentJobLog(
          ctx.repoRoot,
          String(args.run_id ?? ""),
          false,
          typeof args.max_bytes === "number" ? Math.trunc(args.max_bytes) : 32 * 1024,
        );
        audit(ctx, name, "ok", args, log.url);
        const run = getAgentJob(ctx.repoRoot, String(args.run_id ?? ""));
        const bounded = redactRunText(
          log.log,
          ctx.repoRoot,
          {
            executionRoot: run.executionRoot,
            worktree: run.worktree,
            worktreePath: run.worktreePath,
          },
          Math.max(
            4 * 1024,
            Math.min(
              typeof args.max_bytes === "number" ? Math.trunc(args.max_bytes) : 32 * 1024,
              256 * 1024,
            ),
          ),
        );
        return textResult({
          ...log,
          log: bounded.text,
          truncated: bounded.truncated,
          redactions: bounded.redactions,
          next: bounded.truncated
            ? "Call get_task_run_log with a larger max_bytes value for more retained tail."
            : undefined,
        });
      }
      case "get_task_diff": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "get_task_diff requires the controller profile",
          );
        const diff = taskRunDiff(
          ctx.repoRoot,
          String(args.run_id ?? ""),
          typeof args.max_bytes === "number"
            ? Math.min(Math.max(Math.trunc(args.max_bytes), 1024), 1024 * 1024)
            : undefined,
        );
        audit(ctx, name, "ok", args, diff.worktree);
        return textResult(diff);
      }
      case "integrate_task_run": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "integrate_task_run requires the controller profile",
          );
        const integrated = integrateAgentJob(
          ctx.repoRoot,
          ctx.policy,
          String(args.run_id ?? ""),
        );
        audit(
          ctx,
          name,
          "ok",
          args,
          `.ai/harness/edit-sessions/${integrated.session.sessionId}`,
        );
        return textResult(integrated);
      }
      case "list_task_runs": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "list_task_runs requires the controller profile",
          );
        const runs = listAgentJobs(
          ctx.repoRoot,
          typeof args.limit === "number" ? args.limit : 50,
        );
        audit(ctx, name, "ok", args);
        return textResult({
          runs: summarizeRunList(
            ctx.repoRoot,
            runs as unknown as Array<Record<string, unknown>>,
            args.include_paths === true,
          ),
        });
      }
      case "cancel_task_run": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "cancel_task_run requires the controller profile",
          );
        const run = cancelAgentJob(ctx.repoRoot, String(args.run_id ?? ""));
        audit(ctx, name, "ok", args, run.promptPath);
        return textResult(run);
      }
      case "retry_task_run": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "retry_task_run requires the controller profile",
          );
        const previous = getAgentJob(ctx.repoRoot, String(args.run_id ?? ""));
        if (
          !["failed", "cancelled", "unknown", "waiting_for_user"].includes(
            previous.status,
          )
        )
          return errorResult(
            "RUN_NOT_RETRYABLE",
            `run status is ${previous.status}`,
          );
        const issue = getIssue(ctx.repoRoot, previous.issueId);
        const task = issue.tasks.find((entry) => entry.id === previous.taskId);
        const health = task
          ? taskExecutorHealth(
              ctx,
              task,
              previous.agent,
              previous.github
                ? `${previous.github.owner}/${previous.github.repo}`
                : undefined,
            )
          : null;
        if (health) return dispatchExecutorHealthResult(health, { retryable: false });
        const run = retryAgentJob(ctx.repoRoot, previous.runId, {
          executorPolicy: {
            agentRunner: ctx.policy.execution.agentRunner,
            allowedAgents: ctx.policy.execution.allowedAgents,
          },
          timeoutMs:
            args.timeout_ms === undefined
              ? undefined
              : runnerTimeoutMs(ctx, args.timeout_ms),
          isolate: typeof args.isolate === "boolean" ? args.isolate : undefined,
          supervisorInstructions: typeof args.supervisor_instructions === "string"
            ? args.supervisor_instructions
            : undefined,
        });
        audit(
          ctx,
          name,
          run.status === "failed" ? "failed" : "ok",
          args,
          run.github?.url ?? run.promptPath,
          run.error,
        );
        return textResult(run);
      }
      case "finish_task_run": {
        if (ctx.policy.profile !== "controller") return errorResult("TOOL_DISABLED", "finish_task_run requires the controller profile");
        const runId = String(args.run_id ?? "").trim();
        if (!runId) return errorResult("RUN_ID_REQUIRED", "finish_task_run requires run_id");
        const decision = typeof args.decision === "string" ? args.decision : "auto";
        if (!["auto", "approve_and_finish", "request_changes", "discard"].includes(decision)) {
          return errorResult("INVALID_DECISION", "decision must be auto, approve_and_finish, request_changes, or discard");
        }
        const finished = finishTaskRun(ctx.repoRoot, {
          runId,
          decision: decision as "auto" | "approve_and_finish" | "request_changes" | "discard",
          reviewer: typeof args.reviewer === "string" ? args.reviewer : undefined,
          note: typeof args.note === "string" ? args.note : undefined,
          cleanup: typeof args.cleanup === "boolean" ? args.cleanup : undefined,
          commit: typeof args.commit === "boolean" ? args.commit : undefined,
        });
        audit(ctx, name, ["blocked", "needs_decision"].includes(finished.action) ? "failed" : "ok", args, `tasks/issues/${finished.issueId}`, finished.reason);
        return textResult(finished);
      }
      case "verify_task": {
        if (ctx.policy.profile !== "controller") return errorResult("TOOL_DISABLED", "verify_task requires the controller profile");
        const issueId = String(args.issue_id ?? "");
        const taskId = String(args.task_id ?? "");
        const current = getIssue(ctx.repoRoot, issueId);
        const task = current.tasks.find((entry) => entry.id === taskId);
        if (!task) return errorResult("TASK_NOT_FOUND", `task not found: ${issueId}/${taskId}`);
        const policy = taskExecutionPolicy(task);
        const evidenceRunId = typeof args.run_id === "string" ? args.run_id : task.runIds.at(-1);
        let evidenceRun: ReturnType<typeof getAgentJob> | undefined;
        if (evidenceRunId) {
          evidenceRun = getAgentJob(ctx.repoRoot, evidenceRunId);
          if (evidenceRun.issueId !== issueId || evidenceRun.taskId !== taskId) return errorResult("RUN_TASK_MISMATCH", `Run ${evidenceRunId} does not belong to ${issueId}/${taskId}`);
          if (evidenceRun.status !== "succeeded") return errorResult("RUN_NOT_SUCCEEDED", `verification requires a succeeded Run (current: ${evidenceRun.status})`);
          if (evidenceRun.provider === "local" && evidenceRun.worktree !== ctx.repoRoot && !evidenceRun.integratedSessionId) return errorResult("RUN_NOT_INTEGRATED", "integrate the isolated local Run before recording verification");
          if (evidenceRun.provider === "github" && evidenceRun.github?.createPullRequest !== false && !evidenceRun.github?.pullRequestUrl) return errorResult("GITHUB_PR_NOT_READY", "GitHub cloud verification requires the linked pull request to be available");
        }

        const requestedCheckInputs = taskObjects(args.check_results).map((entry) => ({
          checkId: String(entry.check_id ?? "").trim(),
          requestedSummary: typeof entry.summary === "string" ? entry.summary : undefined,
        })).filter((entry) => entry.checkId);
        const registryChecks = listControllerChecks(ctx.repoRoot);
        const requestedCheckIds = task.checks.length > 0 ? task.checks : requestedCheckInputs.map((entry) => entry.checkId);
        const normalizedChecks = normalizeCheckIds(requestedCheckIds, registryChecks);
        const checkIds = normalizedChecks.validCheckIds;
        const checkResults = await Promise.all(checkIds.map(async (checkId) => {
          try {
            const result = await runControllerCheckAsync(ctx.repoRoot, checkId);
            return {
              checkId,
              ok: result.ok,
              summary: result.ok
                ? `Passed with persisted evidence: ${result.artifactPath}`
                : `Failed with persisted evidence: ${result.artifactPath}; ${(result.stderr || result.stdout).slice(0, 500)}`,
            };
          } catch (error) {
            return { checkId, ok: false, summary: error instanceof Error ? error.message : String(error) };
          }
        }));

        const commandEvidence: TaskCommandEvidence[] = [];
        for (const entry of taskObjects(args.reported_commands)) {
          const command = Array.isArray(entry.command) ? entry.command.map(String).map((part) => part.trim()).filter(Boolean) : [];
          if (command.length === 0) return errorResult("INVALID_COMMAND_EVIDENCE", "reported command evidence requires a non-empty command argv");
          const cwdInput = typeof entry.cwd === "string" && entry.cwd.trim() ? entry.cwd.trim() : undefined;
          if (cwdInput && cwdInput !== "." && cwdInput !== "./") {
            const cwdDecision = resolveMcpPath(ctx.repoRoot, cwdInput, ctx.policy, "read");
            if (!cwdDecision.ok) {
              const normalizedCwd = normalizeMcpRelativePath(cwdInput);
              const missingHarnessEvidence = normalizedCwd.ok &&
                normalizedCwd.relativePath?.startsWith(".ai/harness/") &&
                cwdDecision.reason?.startsWith("path does not exist:");
              if (!missingHarnessEvidence) return errorResult("COMMAND_EVIDENCE_PATH_DENIED", cwdDecision.reason ?? "reported command cwd is denied");
            }
          }
          const artifactInput = typeof entry.artifact_path === "string" && entry.artifact_path.trim() ? entry.artifact_path.trim() : undefined;
          if (artifactInput) {
            const artifactDecision = resolveMcpPath(ctx.repoRoot, artifactInput, ctx.policy, "read");
            if (!artifactDecision.ok) {
              const normalizedArtifact = normalizeMcpRelativePath(artifactInput);
              const missingHarnessEvidence = normalizedArtifact.ok &&
                normalizedArtifact.relativePath?.startsWith(".ai/harness/") &&
                artifactDecision.reason?.startsWith("path does not exist:");
              if (!missingHarnessEvidence) return errorResult("COMMAND_EVIDENCE_ARTIFACT_DENIED", artifactDecision.reason ?? "reported command artifact is denied");
            }
          }
          commandEvidence.push({
            command,
            cwd: cwdInput,
            ok: entry.ok === true,
            exitCode: typeof entry.exit_code === "number" ? Math.trunc(entry.exit_code) : undefined,
            stdout: typeof entry.stdout === "string" ? entry.stdout.slice(-32 * 1024) : undefined,
            stderr: typeof entry.stderr === "string" ? entry.stderr.slice(-32 * 1024) : undefined,
            artifactPath: artifactInput,
            reportedBy: String(args.reviewer ?? "").trim(),
            executedAt: typeof entry.executed_at === "string" ? entry.executed_at : new Date().toISOString(),
            source: "reported",
          });
        }

        let acceptanceResults = taskObjects(args.acceptance_results).map((entry) => ({
          criterion: String(entry.criterion ?? ""),
          ok: entry.ok === true,
          evidence: typeof entry.evidence === "string" ? entry.evidence : undefined,
        }));
        if (acceptanceResults.length === 0 && evidenceRun && task.acceptanceCriteria.length > 0) {
          acceptanceResults = task.acceptanceCriteria.map((criterion) => ({ criterion, ok: true, evidence: `Successful Run ${evidenceRun!.runId}.` }));
        }
        const verification: TaskVerification = {
          runId: evidenceRunId,
          integratedRevision: typeof args.integrated_revision === "string" ? args.integrated_revision : evidenceRun?.integratedSessionId,
          reviewedDiffHash: typeof args.reviewed_diff_hash === "string" ? args.reviewed_diff_hash : undefined,
          reviewer: String(args.reviewer ?? ""),
          checkResults,
          commandEvidence,
          acceptanceResults,
          verifiedAt: new Date().toISOString(),
        };
        const issue = recordTaskVerification(ctx.repoRoot, issueId, taskId, verification);
        const issueView = projectIssueEffectiveView(ctx.repoRoot, issue);
        const verifiedTask = issueView.tasks.find((entry) => entry.id === taskId);
        audit(ctx, name, ["verified", "done"].includes(verifiedTask?.status ?? "") ? "ok" : "failed", args, `tasks/issues/${issue.id}`);
        return textResult({
          issueId,
          taskId,
          policy,
          checkNormalization: {
            validCheckIds: normalizedChecks.validCheckIds,
            invalidCheckIds: normalizedChecks.invalidCheckIds,
            warnings: normalizedChecks.warnings,
          },
          task: verifiedTask ? compactTaskView(verifiedTask as unknown as Record<string, unknown>) : undefined,
          tasks: issueView.tasks.map((entry) => compactTaskView(entry as unknown as Record<string, unknown>)),
          issue: compactIssueView(issueView as unknown as Record<string, unknown>),
        });
      }
      case "accept_task": {
        if (ctx.policy.profile !== "controller") return errorResult("TOOL_DISABLED", "accept_task requires the controller profile");
        const issueId = String(args.issue_id ?? "");
        const taskId = String(args.task_id ?? "");
        const current = getIssue(ctx.repoRoot, issueId);
        const task = current.tasks.find((entry) => entry.id === taskId);
        if (!task) return errorResult("TASK_NOT_FOUND", `task not found: ${issueId}/${taskId}`);
        if (task.status === "done") return textResult(projectIssueEffectiveView(ctx.repoRoot, current));
        if (task.status !== "verified" || !task.verification) return errorResult("TASK_NOT_VERIFIED", `task has not passed its risk-adaptive verification requirements (current: ${task.status})`);
        const issue = acceptVerifiedTask(ctx.repoRoot, issueId, taskId, typeof args.note === "string" ? args.note : "Accepted after required verification evidence.");
        audit(ctx, name, "ok", args, `tasks/issues/${issue.id}`);
        return textResult(projectIssueEffectiveView(ctx.repoRoot, issue));
      }
      case "request_task_changes": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "request_task_changes requires the controller profile",
          );
        const issueId = String(args.issue_id ?? "");
        const taskId = String(args.task_id ?? "");
        const current = getIssue(ctx.repoRoot, issueId);
        const task = current.tasks.find((entry) => entry.id === taskId);
        if (!task)
          return errorResult(
            "TASK_NOT_FOUND",
            `task not found: ${issueId}/${taskId}`,
          );
        if (
          !["review", "integrated", "verifying", "verified"].includes(
            task.status,
          )
        )
          return errorResult(
            "TASK_NOT_REVIEWABLE",
            `task must be in review, integrated, verifying, or verified before requesting changes (current: ${task.status})`,
          );
        const issue = updateTask(ctx.repoRoot, issueId, taskId, {
          status: "changes_requested",
          note: String(args.note ?? ""),
        });
        audit(ctx, name, "ok", args, `tasks/issues/${issue.id}`);
        return textResult(projectIssueEffectiveView(ctx.repoRoot, issue));
      }
      case "begin_edit_session": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "begin_edit_session requires the controller profile",
          );
        const session = beginEditSession(ctx.repoRoot, {
          purpose: String(args.purpose ?? ""),
          issueId:
            typeof args.issue_id === "string" ? args.issue_id : undefined,
          taskId: typeof args.task_id === "string" ? args.task_id : undefined,
          allowedPaths: stringList(args.allowed_paths),
          maxFiles:
            typeof args.max_files === "number" ? args.max_files : undefined,
          maxChangedLines:
            typeof args.max_changed_lines === "number"
              ? args.max_changed_lines
              : undefined,
          checks: stringList(args.checks),
        });
        audit(
          ctx,
          name,
          "ok",
          args,
          `.ai/harness/edit-sessions/${session.sessionId}`,
        );
        return textResult(session);
      }
      case "apply_patch": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "apply_patch requires the controller profile",
          );
        let session;
        try {
          session = applyEditOperations(
            ctx.repoRoot,
            ctx.policy,
            String(args.session_id ?? ""),
            controllerEditOperations(args.operations),
            {
              expectedRevision:
                typeof args.expected_revision === "number"
                  ? Math.trunc(args.expected_revision)
                  : undefined,
              maxBatchOperations: PREFERRED_EDIT_PATCH_BATCH_OPERATIONS,
            },
          );
        } catch (error) {
          if (error instanceof EditSessionPatchError) {
            audit(ctx, name, "failed", args, `.ai/harness/edit-sessions/${error.details.sessionId}`, error.message);
            return errorResult(error.code, error.message, error.details);
          }
          throw error;
        }
        audit(
          ctx,
          name,
          "ok",
          args,
          `.ai/harness/edit-sessions/${session.sessionId}`,
        );
        return textResult(session);
      }
      case "get_edit_session": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "get_edit_session requires the controller profile",
          );
        const session = getEditSession(
          ctx.repoRoot,
          String(args.session_id ?? ""),
        );
        audit(
          ctx,
          name,
          "ok",
          args,
          `.ai/harness/edit-sessions/${session.sessionId}`,
        );
        return textResult(session);
      }
      case "list_edit_sessions": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "list_edit_sessions requires the controller profile");
        const limit = typeof args.limit === "number" ? args.limit : 100;
        audit(ctx, name, "ok", args);
        return textResult({ sessions: listEditSessions(ctx.repoRoot, limit) });
      }
      case "get_edit_session_diff": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "get_edit_session_diff requires the controller profile");
        const result = getEditSessionDiff(ctx.repoRoot, String(args.session_id ?? ""));
        audit(ctx, name, "ok", args, result.path);
        return textResult(result);
      }
      case "create_edit_savepoint": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "create_edit_savepoint requires the controller profile");
        const session = createEditSavepoint(
          ctx.repoRoot,
          String(args.session_id ?? ""),
          String(args.name ?? ""),
        );
        audit(ctx, name, "ok", args, `.ai/harness/edit-sessions/${session.sessionId}`);
        return textResult(session);
      }
      case "verify_edit_session": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "verify_edit_session requires the controller profile");
        const session = getEditSession(ctx.repoRoot, String(args.session_id ?? ""));
        const requestId = typeof args.request_id === "string" ? args.request_id.trim() || undefined : undefined;
        const job = submitLocalBridgeJob(ctx.repoRoot, {
          action: "verify-edit-session",
          requestedBy: "mcp:verify_edit_session",
          payload: {
            sessionId: session.sessionId,
            revision: session.currentRevision,
            requestId,
            checkIds: Array.isArray(args.check_ids) ? stringList(args.check_ids) : undefined,
            reviewer: typeof args.reviewer === "string" ? args.reviewer : undefined,
            note: typeof args.note === "string" ? args.note : undefined,
          },
        });
        const result = job.status === "approved"
          ? executeLocalBridgeJob(ctx.repoRoot, job.jobId)
          : job;
        audit(ctx, name, "ok", args, session.diffPath);
        return textResult({
          accepted: true,
          job: {
            jobId: result.jobId,
            action: result.action,
            status: result.status,
            updatedAt: result.updatedAt,
          },
          editSession: {
            sessionId: session.sessionId,
            revision: session.currentRevision,
            status: session.status,
            diffPath: session.diffPath,
          },
          next: `Inspect Job ${result.jobId} with get_local_job.`,
        });
      }
      case "rollback_edit_session": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "rollback_edit_session requires the controller profile",
          );
        const session = rollbackEditSession(
          ctx.repoRoot,
          String(args.session_id ?? ""),
          {
            toRevision: typeof args.to_revision === "number" ? Math.trunc(args.to_revision) : undefined,
            savepoint: typeof args.savepoint === "string" ? args.savepoint : undefined,
          },
        );
        audit(
          ctx,
          name,
          "ok",
          args,
          `.ai/harness/edit-sessions/${session.sessionId}`,
        );
        return textResult(session);
      }
      case "finalize_edit_session": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "finalize_edit_session requires the controller profile",
          );
        const session = finalizeEditSession(
          ctx.repoRoot,
          String(args.session_id ?? ""),
          {
            reviewer: typeof args.reviewer === "string" ? args.reviewer : undefined,
            note: typeof args.note === "string" ? args.note : undefined,
          },
        );
        audit(
          ctx,
          name,
          "ok",
          args,
          `.ai/harness/edit-sessions/${session.sessionId}`,
        );
        return textResult(session);
      }
      case "list_workflow_files": {
        const files = workflowFileCandidates(ctx.repoRoot)
          .filter(
            (path) => resolveMcpPath(ctx.repoRoot, path, ctx.policy, "read").ok,
          )
          .map((path) => fileSummary(path, ctx.repoRoot))
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .filter((entry) => entry.size <= ctx.policy.maxFileBytes);
        audit(ctx, name, "ok", args);
        return textResult({ files });
      }
      case "read_workflow_file": {
        const path = typeof args.path === "string" ? args.path : "";
        const decision = resolveMcpPath(ctx.repoRoot, path, ctx.policy, "read");
        if (!decision.ok || !decision.absolutePath || !decision.relativePath) {
          audit(ctx, name, "blocked", args, path, decision.reason);
          return errorResult(
            "POLICY_DENIED",
            decision.reason ?? "path denied",
            { path },
          );
        }
        const fileStat = statSync(decision.absolutePath);
        if (!fileStat.isFile())
          return errorResult(
            "NOT_A_FILE",
            `path is not a file: ${decision.relativePath}`,
          );
        if (fileStat.size > ctx.policy.maxFileBytes)
          return errorResult(
            "FILE_TOO_LARGE",
            `file exceeds ${ctx.policy.maxFileBytes} bytes`,
          );
        const bytes = readFileSync(decision.absolutePath);
        if (isProbablyBinary(bytes))
          return errorResult("BINARY_FILE", "binary files are not supported");
        const raw = bytes.toString("utf-8");
        const redacted = redactMcpText(raw);
        audit(ctx, name, "ok", args, decision.relativePath);
        const payload = {
          path: decision.relativePath,
          size: fileStat.size,
          sha256: sha256(raw),
          redactions: redacted.redactions,
          content: redacted.text,
        };
        return textResult(payload, {
          path: payload.path,
          size: payload.size,
          sha256: payload.sha256,
          redactions: payload.redactions,
        });
      }
      case "latest_handoff": {
        const paths = [
          ".ai/harness/handoff/resume.md",
          ".ai/harness/handoff/controller-current.md",
          ".ai/harness/handoff/codex-goal.md",
          ".ai/harness/handoff/chatgpt-plan.md",
        ];
        const handoff = paths.map((path) => {
          const decision = resolveMcpPath(
            ctx.repoRoot,
            path,
            ctx.policy,
            "read",
          );
          if (
            !decision.ok ||
            !decision.absolutePath ||
            !existsSync(decision.absolutePath)
          )
            return { path, exists: false };
          const content = redactMcpText(
            readFileSync(decision.absolutePath, "utf-8"),
          ).text;
          return {
            path,
            exists: true,
            preview: content.split(/\r?\n/).slice(0, 24).join("\n"),
          };
        });
        audit(ctx, name, "ok", args);
        return textResult({ handoff });
      }
      case "latest_checks": {
        const files = workflowFileCandidates(ctx.repoRoot)
          .filter((path) => path.startsWith(".ai/harness/checks/"))
          .filter(
            (path) => resolveMcpPath(ctx.repoRoot, path, ctx.policy, "read").ok,
          )
          .map((path) => fileSummary(path, ctx.repoRoot))
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
          .slice(0, 20);
        audit(ctx, name, "ok", args);
        return textResult({ files });
      }
      case "list_prds":
      case "list_sprints": {
        const root = name === "list_prds" ? "plans/prds" : "plans/sprints";
        const files: string[] = [];
        listFilesUnder(ctx.repoRoot, root, 200, files);
        audit(ctx, name, "ok", args);
        return textResult({
          files: files
            .map((path) => fileSummary(path, ctx.repoRoot))
            .filter(Boolean),
        });
      }
      case "summarize_repo_harness_state": {
        const current = existsSync(join(ctx.repoRoot, "tasks/current.md"))
          ? readFileSync(join(ctx.repoRoot, "tasks/current.md"), "utf-8")
              .split(/\r?\n/)
              .slice(0, 50)
              .join("\n")
          : null;
        audit(ctx, name, "ok", args);
        return textResult({
          status: {
            adopted: isRepoHarnessAdopted(ctx.repoRoot),
            branch: currentGitBranch(ctx.repoRoot),
            profile: ctx.policy.profile,
          },
          current: current ? redactMcpText(current).text : null,
        });
      }
      case "write_prd": {
        const title = String(args.title ?? "").trim();
        const slug = slugify(String(args.slug ?? title));
        return writeMarkdownArtifact(
          ctx,
          name,
          prdArtifactPath(slug),
          title,
          "prd",
          String(args.body ?? ""),
          args.overwrite === true,
          args,
        );
      }
      case "write_prd_from_idea": {
        const title = String(args.title ?? "").trim();
        const slug = slugify(String(args.slug ?? title));
        const body = renderPrdFromIdeaBody(args);
        return writeMarkdownArtifact(
          ctx,
          name,
          prdArtifactPath(slug),
          title,
          "prd",
          body,
          args.overwrite === true,
          args,
        );
      }
      case "write_sprint": {
        const title = String(args.title ?? "").trim();
        const slug = slugify(String(args.slug ?? title));
        return writeMarkdownArtifact(
          ctx,
          name,
          sprintArtifactPath(slug),
          title,
          "sprint",
          String(args.body ?? ""),
          args.overwrite === true,
          args,
        );
      }
      case "write_checklist_sprint": {
        const title = String(args.title ?? "").trim();
        const slug = slugify(String(args.slug ?? title));
        const prdPath = String(args.prd_path ?? "").trim();
        const prdDecision = resolveMcpPath(
          ctx.repoRoot,
          prdPath,
          ctx.policy,
          "read",
        );
        if (
          !prdDecision.ok ||
          !prdDecision.absolutePath ||
          !existsSync(prdDecision.absolutePath)
        ) {
          audit(
            ctx,
            name,
            "blocked",
            args,
            prdPath,
            prdDecision.reason ?? "PRD path does not exist or is not readable",
          );
          return errorResult(
            "PRD_NOT_READABLE",
            "PRD path does not exist or is not policy-readable.",
            { path: prdPath },
          );
        }
        const body = renderChecklistSprintBody(args);
        return writeMarkdownArtifact(
          ctx,
          name,
          sprintArtifactPath(slug),
          title,
          "sprint",
          body,
          args.overwrite === true,
          args,
        );
      }
      case "write_plan": {
        const title = String(args.title ?? "").trim();
        const slug = slugify(String(args.slug ?? title));
        return writeMarkdownArtifact(
          ctx,
          name,
          `plans/plan-${slug}.md`,
          title,
          "plan",
          String(args.body ?? ""),
          args.overwrite === true,
          args,
        );
      }
      case "prepare_codex_goal_from_sprint": {
        const prdPath = String(args.prd_path ?? "").trim();
        const sprintPath = String(args.sprint_path ?? "").trim();
        const missingInputs = [
          { label: "PRD", path: prdPath },
          { label: "Sprint", path: sprintPath },
        ].filter((entry) => {
          const decision = resolveMcpPath(
            ctx.repoRoot,
            entry.path,
            ctx.policy,
            "read",
          );
          return (
            !decision.ok ||
            !decision.absolutePath ||
            !existsSync(decision.absolutePath)
          );
        });
        if (missingInputs.length > 0) {
          audit(
            ctx,
            name,
            "blocked",
            args,
            missingInputs[0]?.path,
            `${missingInputs.map((entry) => entry.label).join(", ")} path does not exist or is not readable`,
          );
          return errorResult(
            "SOURCE_NOT_READABLE",
            "PRD or Sprint path does not exist or is not policy-readable.",
            { missing: missingInputs },
          );
        }
        const goal = renderCodexGoalFromSprint(args);
        const missing = validateGoal(goal.body);
        if (missing.length > 0) {
          audit(
            ctx,
            name,
            "blocked",
            args,
            ".ai/harness/handoff/codex-goal.md",
            `missing required goal sections: ${missing.join(", ")}`,
          );
          return errorResult(
            "INVALID_GOAL",
            "Generated Codex goal is missing required sections.",
            { missing },
          );
        }
        return writeMarkdownArtifact(
          ctx,
          name,
          ".ai/harness/handoff/codex-goal.md",
          "Codex Goal",
          "codex-goal",
          goal.body,
          args.overwrite === true,
          args,
          {
            prompt: goal.prompt,
          },
        );
      }
      case "write_codex_goal": {
        const body = String(args.body ?? "");
        const missing = validateGoal(body);
        if (body.trim().length < 120 || missing.length > 0) {
          audit(
            ctx,
            name,
            "blocked",
            args,
            ".ai/harness/handoff/codex-goal.md",
            `missing required goal sections: ${missing.join(", ")}`,
          );
          return errorResult(
            "INVALID_GOAL",
            "Codex goal is missing required sections or is too small.",
            { missing },
          );
        }
        return writeMarkdownArtifact(
          ctx,
          name,
          ".ai/harness/handoff/codex-goal.md",
          "Codex Goal",
          "codex-goal",
          body,
          args.overwrite === true,
          args,
        );
      }
      case "append_handoff_note": {
        const path = ".ai/harness/handoff/chatgpt-plan.md";
        const decision = resolveMcpPath(
          ctx.repoRoot,
          path,
          ctx.policy,
          "write",
        );
        if (!decision.ok || !decision.absolutePath)
          return errorResult("POLICY_DENIED", decision.reason ?? "path denied");
        mkdirSync(dirname(decision.absolutePath), { recursive: true });
        const actor =
          String(args.actor ?? "chatgpt-planner").trim() || "chatgpt-planner";
        const body = String(args.body ?? "").trim();
        const block = [
          ``,
          `## ${new Date().toISOString()}`,
          ``,
          `Actor: ${actor}`,
          ``,
          body,
          ``,
        ].join("\n");
        appendFileSync(decision.absolutePath, block, "utf-8");
        audit(ctx, name, "ok", args, path);
        return textResult({ status: "appended", path });
      }
      case "run_workflow_check": {
        const result = runHelper({
          helper: "check-task-workflow",
          args: ["--strict"],
          cwd: ctx.repoRoot,
          stdio: "pipe",
          timeoutMs: 60_000,
          maxOutputBytes: 96 * 1024,
        });
        const stdout = redactMcpText(result.stdout ?? "");
        const stderr = redactMcpText(result.stderr ?? "");
        audit(
          ctx,
          name,
          result.exitCode === 0 ? "ok" : "failed",
          args,
          undefined,
          stderr.text,
        );
        return textResult({
          exitCode: result.exitCode,
          reason: result.reason,
          stdout: stdout.text,
          stderr: stderr.text,
          helper: result.resolved
            ? {
                source: result.resolved.source,
                fileName: basename(result.resolved.path),
              }
            : null,
        });
      }
      case "run_chatgpt_browser_consult": {
        if (ctx.enableChatgptBrowser !== true)
          return errorResult(
            "TOOL_DISABLED",
            "ChatGPT browser tools require repo-harness mcp serve --enable-chatgpt-browser",
          );
        const result = await runBrowserConsult({
          repoRoot: ctx.repoRoot,
          title: typeof args.title === "string" ? args.title : undefined,
          prompt: String(args.prompt ?? ""),
          files: stringList(args.files).map((path) => ({ path })),
          followups: stringList(args.followups),
          model: typeof args.model === "string" ? args.model : undefined,
          thinking: parseThinking(args.thinking),
          provider: parseBrowserProvider(args.provider),
          browserChannel: parseNativeBrowserChannel(args.browserChannel),
          writeOutput:
            typeof args.writeOutput === "string" ? args.writeOutput : undefined,
          writeOutputPolicy: "mcp",
          overwriteOutput: args.overwriteOutput === true,
          timeoutMs:
            typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
          dryRun: args.dryRun === true,
        });
        audit(
          ctx,
          name,
          result.error ? "failed" : "ok",
          args,
          result.meta.output.outputPath,
          result.error?.message,
        );
        return textResult({
          sessionId: result.sessionId,
          status: result.status,
          output: result.output,
          conversationUrl: result.conversationUrl,
          paths: {
            sessionDir: result.paths.sessionDir,
            output: result.paths.output,
            transcript: result.paths.transcript,
          },
          dryRun: result.dryRun,
          error: result.error,
        });
      }
      case "read_chatgpt_browser_session": {
        if (ctx.enableChatgptBrowser !== true)
          return errorResult(
            "TOOL_DISABLED",
            "ChatGPT browser tools require repo-harness mcp serve --enable-chatgpt-browser",
          );
        const sessionId = String(args.sessionId ?? "").trim();
        const session = readSession(ctx.repoRoot, sessionId);
        audit(ctx, name, "ok", args);
        return textResult({
          meta: session.meta,
          output: session.output,
          transcript: session.transcript,
        });
      }
      case "list_chatgpt_browser_sessions": {
        if (ctx.enableChatgptBrowser !== true)
          return errorResult(
            "TOOL_DISABLED",
            "ChatGPT browser tools require repo-harness mcp serve --enable-chatgpt-browser",
          );
        const limit =
          typeof args.limit === "number" &&
          Number.isInteger(args.limit) &&
          args.limit > 0
            ? args.limit
            : 20;
        const sessions = listSessions(ctx.repoRoot, limit);
        audit(ctx, name, "ok", args);
        return textResult({ sessions });
      }
      case "open_chatgpt_browser_session": {
        if (ctx.enableChatgptBrowser !== true)
          return errorResult(
            "TOOL_DISABLED",
            "ChatGPT browser tools require repo-harness mcp serve --enable-chatgpt-browser",
          );
        const sessionId = String(args.sessionId ?? "").trim();
        const result = openSession(ctx.repoRoot, sessionId, false);
        audit(ctx, name, "ok", args);
        return textResult({ sessionId, url: result.url, launched: false });
      }
      case "continue_chatgpt_browser_session": {
        if (ctx.enableChatgptBrowser !== true)
          return errorResult(
            "TOOL_DISABLED",
            "ChatGPT browser tools require repo-harness mcp serve --enable-chatgpt-browser",
          );
        const sessionId = String(args.sessionId ?? "").trim();
        const prompt = String(args.prompt ?? "").trim();
        const result = await runBrowserFollowup({
          repoRoot: ctx.repoRoot,
          sessionId,
          title: `followup ${sessionId}`,
          prompt,
          dryRun: args.dryRun === true,
        });
        audit(
          ctx,
          name,
          result.error ? "failed" : "ok",
          args,
          result.meta.output.outputPath,
          result.error?.message,
        );
        return textResult({
          sourceSessionId: sessionId,
          sessionId: result.sessionId,
          status: result.status,
          output: result.output,
          paths: {
            output: result.paths.output,
            transcript: result.paths.transcript,
          },
          error: result.error,
        });
      }
      case "run_agent_goal":
        return runAgentGoal(ctx, args);
      default:
        return errorResult("UNKNOWN_TOOL", `unknown MCP tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit(ctx, name, "failed", args, undefined, message);
    return errorResult("TOOL_FAILED", message);
  }
}
