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
  finalizeEditSession,
  getEditSession,
  getEditSessionDiff,
  listEditSessions,
  rollbackEditSession,
  verifyEditSession,
  type EditOperation,
} from "../editing/edit-session";
import {
  cancelAgentJob,
  getAgentJob,
  getAgentJobEvents,
  getAgentJobLog,
  listAgentJobs,
  retryAgentJob,
  startTaskJob,
} from "../agent-jobs/job-manager";
import { integrateAgentJob, taskRunDiff } from "../agent-jobs/integration";
import {
  appendTask,
  archiveIssue,
  createIssue,
  getIssue,
  inspectIssueReadiness,
  listIssues,
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
  runControllerCheck,
} from "../controller/check-runner";
import {
  getControllerTimeline,
  getProjectProgress,
  getTaskProgressDetail,
} from "../controller/progress";
import { exportControllerWorklog, parseWorklogCategory } from "../controller/worklog";
import { inspectProjectGovernance, reconcileProjectGovernance } from "../controller/governance";
import { assessWorkMode } from "../controller/work-mode";
import { loadControllerProjectState, saveControllerProjectState } from "../controller/project-state";
import {
  CONTROLLER_SCHEMA_VERSION,
  CONTROLLER_TOOL_SURFACE,
  MIN_AGENT_TIMEOUT_MS,
  formatDurationMs,
  normalizeAgentTimeoutMs,
} from "../controller/runtime-config";
import type {
  ControllerAgent,
  ControllerTask,
  IssueKind,
  IssueStatus,
  TaskDraft,
  TaskRisk,
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
  approveAndExecuteLocalBridgeJob,
  executeLocalBridgeJob,
  getLocalBridgeJob,
  getLocalBridgeJobEvents,
  listLocalBridgeJobs,
  submitLocalBridgeJob,
} from "../local-bridge/job-store";
import type {
  LocalBridgeApproval,
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
import { resolveMcpPath } from "./paths";
import { currentGitBranch, isRepoHarnessAdopted } from "./repo";
import { redactMcpText } from "./redaction";
import type { McpAgentRunnerName, McpPolicy } from "./types";

export interface McpToolContext {
  repoRoot: string;
  policy: McpPolicy;
  enableChatgptBrowser?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

const EMPTY_SCHEMA = { type: "object", additionalProperties: false };

function textResult(
  value: unknown,
  structuredContent: unknown = typeof value === "string" ? undefined : value,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    structuredContent,
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

function scopePrefix(value: string): string {
  return value
    .trim()
    .replace(/^\.\//, "")
    .replace(/\\/g, "/")
    .split(/[?*{[]/, 1)[0]
    .replace(/\/+$/, "");
}

function taskScopesConflict(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  for (const leftPath of left) {
    const a = scopePrefix(leftPath);
    if (!a) return true;
    for (const rightPath of right) {
      const b = scopePrefix(rightPath);
      if (!b || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))
        return true;
    }
  }
  return false;
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

function parseLocalBridgeAction(value: unknown): LocalBridgeJobAction | null {
  const normalized = String(value ?? "").trim();
  return normalized === "launch-task" ||
    normalized === "quick-agent-session" ||
    normalized === "run-check"
    ? normalized
    : null;
}

function parseLocalBridgeApproval(
  value: unknown,
): LocalBridgeApproval | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim();
  if (
    normalized === "auto" ||
    normalized === "confirm" ||
    normalized === "manual-only"
  )
    return normalized;
  throw new Error(`invalid local bridge approval: ${normalized}`);
}

function localBridgeRequestFromArgs(args: Record<string, unknown>) {
  const action = parseLocalBridgeAction(args.action);
  if (!action)
    throw new Error(
      "action must be launch-task, quick-agent-session, or run-check",
    );
  const approval = parseLocalBridgeApproval(args.approval);
  const requestedBy =
    String(args.requested_by ?? "chatgpt").trim() || "chatgpt";
  if (action === "launch-task") {
    const issueId = String(args.issue_id ?? "").trim();
    const taskId = String(args.task_id ?? "").trim();
    if (!issueId || !taskId)
      throw new Error("launch-task requires issue_id and task_id");
    return {
      action,
      approval,
      requestedBy,
      payload: {
        issueId,
        taskId,
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
      },
    } as const;
  }
  if (action === "run-check") {
    const checkId = String(args.check_id ?? "").trim();
    if (!checkId) throw new Error("run-check requires check_id");
    return {
      action,
      approval,
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
    approval,
    requestedBy,
    payload: {
      title,
      objective,
      summary: typeof args.summary === "string" ? args.summary : undefined,
      allowedPaths: stringList(args.allowed_paths),
      forbiddenPaths: stringList(args.forbidden_paths),
      checks: stringList(args.checks),
      acceptanceCriteria: stringList(args.acceptance_criteria),
      risk: args.risk === "medium" || args.risk === "high" ? args.risk : "low",
      agent: agent === "claude" ? "claude" : "codex",
      isolate: typeof args.isolate === "boolean" ? args.isolate : undefined,
      timeoutMs:
        typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
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
    risk: (["low", "medium", "high"].includes(String(task.risk))
      ? String(task.risk)
      : "medium") as TaskRisk,
    recommendedAgent:
      parseControllerAgent(task.agent ?? task.recommendedAgent) ?? "codex",
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
      if (type === "create")
        return {
          type,
          path: String(entry.path ?? ""),
          content: String(entry.content ?? ""),
        };
      if (type === "delete")
        return {
          type,
          path: String(entry.path ?? ""),
          expectedSha256: String(
            entry.expected_sha256 ?? entry.expectedSha256 ?? "",
          ),
        };
      if (type === "write")
        return {
          type,
          path: String(entry.path ?? ""),
          expectedSha256: String(
            entry.expected_sha256 ?? entry.expectedSha256 ?? "",
          ),
          content: String(entry.content ?? ""),
        };
      if (type === "replace")
        return {
          type,
          path: String(entry.path ?? ""),
          expectedSha256: String(
            entry.expected_sha256 ?? entry.expectedSha256 ?? "",
          ),
          replacements: taskObjects(entry.replacements).map((replacement) => ({
            oldText: String(replacement.old_text ?? replacement.oldText ?? ""),
            newText: String(replacement.new_text ?? replacement.newText ?? ""),
            replaceAll:
              replacement.replace_all === true ||
              replacement.replaceAll === true,
          })),
        };
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
        risk: { type: "string", enum: ["low", "medium", "high"] },
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
          "Return the localhost-only visual controller endpoint, local approval queue, and recent local bridge Jobs.",
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: "submit_local_job",
        description:
          "Submit a high-level local Job Ticket. Low-risk Jobs may auto-dispatch according to local policy; confirmation-required Jobs remain visible in the Local Controller UI.",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["launch-task", "quick-agent-session", "run-check"],
            },
            approval: {
              type: "string",
              enum: ["auto", "confirm", "manual-only"],
            },
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
            timeout_ms: agentTimeoutSchema,
            github_repo: { type: "string" },
            base_ref: { type: "string" },
            model: { type: "string" },
            create_pull_request: { type: "boolean" },
            title: { type: "string" },
            objective: { type: "string" },
            summary: { type: "string" },
            allowed_paths: { type: "array", items: { type: "string" } },
            forbidden_paths: { type: "array", items: { type: "string" } },
            checks: { type: "array", items: { type: "string" } },
            acceptance_criteria: { type: "array", items: { type: "string" } },
            risk: { type: "string", enum: ["low", "medium", "high"] },
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
        description: "List recent local Job Tickets and approval state.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "get_local_job",
        description: "Read one local Job Ticket and its event history.",
        inputSchema: {
          type: "object",
          properties: { job_id: { type: "string" } },
          required: ["job_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "approve_local_job",
        description:
          "Approve and execute one confirmation-required local Job Ticket. Manual-only Jobs still require direct local UI action.",
        inputSchema: {
          type: "object",
          properties: { job_id: { type: "string" } },
          required: ["job_id"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: false,
        },
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
          "Run one named focused repository check without accepting arbitrary shell input.",
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
          "Return one Task with effective progress, Run history, Verification evidence, and unified worklog timeline.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            task_id: { type: "string" },
          },
          required: ["issue_id", "task_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "get_worklog_timeline",
        description:
          "Read the unified controller worklog across Issues, Tasks, Runs, approvals, Verification, and GitHub sync.",
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
        description: "Read one controller issue by ID.",
        inputSchema: {
          type: "object",
          properties: { issue_id: { type: "string" } },
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
          "Score launch readiness, list blockers and warnings, and summarize ready Tasks and assigned agents.",
        inputSchema: {
          type: "object",
          properties: { issue_id: { type: "string" } },
          required: ["issue_id"],
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
          "Choose direct_edit, quick_agent, or issue_task before creating work. Bounded known-file changes and document edits should normally avoid Issue creation.",
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
            risk: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["description"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "create_issue",
        description:
          "Create a durable Issue only for complex, long-running, investigative, dependency-aware, or parallel work. Use bounded direct edits for known small code, config, and documentation changes.",
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
          "Start one ready Task as a persistent local Codex/Claude run or a visible GitHub Copilot cloud-agent session.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            task_id: { type: "string" },
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
          "Launch only readiness-approved independent Tasks, using local agents or visible GitHub Copilot cloud sessions according to each Task.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            max_parallel: { type: "number" },
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
          "Start up to max_parallel independent ready Tasks as local runs or GitHub Copilot cloud sessions.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            max_parallel: { type: "number" },
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
          "Read one persistent agent run with current status and log tails.",
        inputSchema: {
          type: "object",
          properties: { run_id: { type: "string" } },
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
          properties: { run_id: { type: "string" }, limit: { type: "number" } },
          required: ["run_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "get_task_run_log",
        description:
          "Read current local output or GitHub cloud-agent session logs. GitHub logs can be watched directly in the linked Agents UI.",
        inputSchema: {
          type: "object",
          properties: { run_id: { type: "string" } },
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
        name: "list_task_runs",
        description: "List recent persistent agent runs.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
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
          "Execute the Task's declared named checks, persist their real results, and record criterion-level acceptance evidence. Caller-supplied booleans never override executed check outcomes.",
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
          required: [
            "issue_id",
            "task_id",
            "reviewer",
            "check_results",
            "acceptance_results",
          ],
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
          "Apply atomic create, full-content write, exact-text replacement, or delete operations inside an open edit session using SHA preconditions.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            operations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["create", "write", "replace", "delete"],
                  },
                  path: { type: "string" },
                  content: { type: "string" },
                  expected_sha256: { type: "string" },
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
          destructiveHint: true,
        },
      },
      {
        name: "get_edit_session",
        description: "Read an edit session and its applied operation manifest.",
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
        description: "List recent direct-edit sessions with changed-file and verification summaries.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "get_edit_session_diff",
        description: "Read the persisted unified patch for one direct-edit session.",
        inputSchema: {
          type: "object",
          properties: { session_id: { type: "string" } },
          required: ["session_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "verify_edit_session",
        description: "Run named checks against an applied direct edit and persist review evidence. Sessions with no named checks still require explicit reviewer evidence.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            check_ids: { type: "array", items: { type: "string" } },
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
          "Rollback a non-finalized applied or verified edit session if files have not changed since application.",
        inputSchema: {
          type: "object",
          properties: { session_id: { type: "string" } },
          required: ["session_id"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: true,
        },
      },
      {
        name: "finalize_edit_session",
        description:
          "Finalize an applied edit session after review and checks.",
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
        const payload = {
          schemaVersion: CONTROLLER_SCHEMA_VERSION,
          toolSurface: CONTROLLER_TOOL_SURFACE,
          profile: ctx.policy.profile,
          capabilities: {
            repositoryInspection: true,
            issueLauncher: true,
            githubIssuesAndProjects: true,
            localAgentRuns: ctx.policy.execution.agentRunner,
            githubCopilotSessions: true,
            dynamicTaskGraph: true,
            structuredRunEvents: true,
            boundedDirectEdits: true,
            directEditFirstRouting: true,
            persistedEditDiffs: true,
            verifiedEditFinalization: true,
            verificationGate: true,
            localRunWatch: true,
            localVisualController: true,
            localApprovalQueue: true,
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
            singleExecutionFocus: true,
            governanceDiagnostics: true,
            safeGovernanceReconciliation: true,
            evidenceGateProgress: true,
            directTaskActions: true,
            issueArchiving: true,
            retryableRunFailures: true,
            issueCreationGuardrails: true,
            persistedCheckEvidence: true,
            directVerification: true,
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
          expectedTools: [
            "controller_capabilities",
            "local_bridge_status",
            "submit_local_job",
            "list_local_jobs",
            "get_local_job",
            "approve_local_job",
            "project_snapshot",
            "search_repository",
            "assess_work_request",
            "create_issue",
            "get_project_governance",
            "reconcile_project_governance",
            "get_project_state",
            "set_current_issue",
            "archive_issue",
            "restore_issue",
            "inspect_issue_readiness",
            "prepare_issue_launch",
            "publish_issue_to_github",
            "launch_issue",
            "dispatch_task",
            "get_task_run",
            "get_task_run_events",
            "get_task_run_log",
            "get_task_diff",
            "integrate_task_run",
            "verify_task",
            "accept_task",
            "begin_edit_session",
            "apply_patch",
            "get_edit_session",
            "list_edit_sessions",
            "get_edit_session_diff",
            "verify_edit_session",
            "finalize_edit_session",
            "rollback_edit_session",
          ],
          docs: [
            "docs/repo-harness-chatgpt-controller.md",
            "docs/repo-harness-github-issue-launcher.md",
            "docs/repo-harness-chatgpt-mcp-setup.md",
            "docs/repo-harness-local-execution-bridge.md",
            "docs/repo-harness-execution-closure-v5.md",
            "docs/repo-harness-direct-change-v6.md",
          ],
          staleConnectorHint:
            "Run mcp setup chatgpt after upgrades and create or refresh the versioned Connector name. The /health endpoint also reports toolSurface, toolCount, profile, repository identity, and timeout limits.",
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
        const jobs = listLocalBridgeJobs(ctx.repoRoot, 25);
        const payload = {
          endpoint:
            runtime?.localController?.endpoint ?? "http://127.0.0.1:8766/",
          running: runtime?.localController?.running ?? false,
          error: runtime?.localController?.error,
          counts: jobs.reduce<Record<string, number>>((counts, job) => {
            counts[job.status] = (counts[job.status] ?? 0) + 1;
            return counts;
          }, {}),
          pendingApproval: jobs.filter(
            (job) => job.status === "pending_approval",
          ),
          recentJobs: jobs,
          fallback:
            "Open the localhost Local Controller to approve or launch work when a ChatGPT write action is unavailable.",
        };
        audit(ctx, name, "ok", args);
        return textResult(payload);
      }
      case "submit_local_job": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "submit_local_job requires the controller profile",
          );
        const request = localBridgeRequestFromArgs(args);
        const job = submitLocalBridgeJob(ctx.repoRoot, request);
        const result =
          job.status === "approved"
            ? executeLocalBridgeJob(ctx.repoRoot, job.jobId)
            : job;
        audit(ctx, name, "ok", args, undefined);
        return textResult({
          job: result,
          localController:
            loadMcpRuntimeState(ctx.repoRoot)?.localController?.endpoint ??
            "http://127.0.0.1:8766/",
          next:
            result.status === "pending_approval"
              ? "Approve this Job in the Local Controller UI."
              : result.runId
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
        const payload = {
          job: getLocalBridgeJob(ctx.repoRoot, jobId),
          events: getLocalBridgeJobEvents(ctx.repoRoot, jobId),
        };
        audit(ctx, name, "ok", args);
        return textResult(payload);
      }
      case "approve_local_job": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "approve_local_job requires the controller profile",
          );
        const jobId = String(args.job_id ?? "").trim();
        const job = approveAndExecuteLocalBridgeJob(ctx.repoRoot, jobId);
        audit(ctx, name, "ok", args);
        return textResult({ job });
      }
      case "project_snapshot": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "project_snapshot requires the controller profile",
          );
        const markerPaths = [
          ".ai/harness/active-plan",
          ".ai/harness/active-sprint",
          ".ai/harness/active-worktree",
          "tasks/current.md",
        ];
        const markers = markerPaths.map((path) => ({
          path,
          exists: existsSync(join(ctx.repoRoot, path)),
          preview: existsSync(join(ctx.repoRoot, path))
            ? redactMcpText(
                readFileSync(join(ctx.repoRoot, path), "utf-8"),
              ).text.slice(0, 2000)
            : null,
        }));
        const payload = {
          git: gitSnapshot(ctx.repoRoot),
          board: projectBoard(ctx.repoRoot),
          runs: listAgentJobs(ctx.repoRoot, 20),
          markers,
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
        const result = searchRepository(ctx.repoRoot, ctx.policy, {
          query: String(args.query ?? ""),
          includeGlobs: stringList(args.include_globs),
          excludeGlobs: stringList(args.exclude_globs),
          maxResults:
            typeof args.max_results === "number" ? args.max_results : undefined,
          maxFiles:
            typeof args.max_files === "number" ? args.max_files : undefined,
          caseSensitive: args.case_sensitive === true,
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
        const result = readRepositoryRange(
          ctx.repoRoot,
          ctx.policy,
          path,
          typeof args.start_line === "number" ? args.start_line : 1,
          typeof args.end_line === "number" ? args.end_line : 200,
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
        const result = runControllerCheck(
          ctx.repoRoot,
          String(args.check_id ?? ""),
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        );
        audit(
          ctx,
          name,
          result.ok ? "ok" : "failed",
          args,
          undefined,
          result.ok ? undefined : result.stderr,
        );
        return textResult(result);
      }
      case "list_issues": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "list_issues requires the controller profile",
          );
        const projectState = loadControllerProjectState(ctx.repoRoot);
        const issues = listIssues(ctx.repoRoot).map((issue) => ({
          id: issue.id,
          title: issue.title,
          kind: issue.kind,
          status: issue.status,
          archivedAt: issue.archivedAt,
          isCurrent: projectState.currentIssueId === issue.id,
          updatedAt: issue.updatedAt,
          taskCount: issue.tasks.length,
        }));
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
        return textResult(issue);
      }
      case "restore_issue": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "restore_issue requires the controller profile");
        const issue = restoreIssue(ctx.repoRoot, String(args.issue_id ?? ""));
        audit(ctx, name, "ok", args, `tasks/issues/${issue.id}`);
        return textResult(issue);
      }
      case "get_task_progress_detail": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "get_task_progress_detail requires the controller profile");
        const result = getTaskProgressDetail(
          ctx.repoRoot,
          String(args.issue_id ?? ""),
          String(args.task_id ?? ""),
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
        const issue = getIssue(ctx.repoRoot, String(args.issue_id ?? ""));
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
        return textResult(issue);
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
        return textResult(result);
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
        return textResult(issue);
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
          .filter((task) => readiness.readyTaskIds.includes(task.id))
          .map((task) => ({
            id: task.id,
            title: task.title,
            agent: task.recommendedAgent,
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
          readiness.ready ? "ok" : "blocked",
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
        return textResult(issue);
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
        return textResult(issue);
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
        return textResult(issue);
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
        return textResult(issue);
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
        return textResult(issue);
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
        return textResult(issue);
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
        return textResult(issue);
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
        return textResult(issue);
      }
      case "dispatch_task": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "dispatch_task requires the controller profile",
          );
        const issueId = String(args.issue_id ?? "");
        const taskId = String(args.task_id ?? "");
        const issue = getIssue(ctx.repoRoot, issueId);
        const task = issue.tasks.find((entry) => entry.id === taskId);
        if (!task)
          return errorResult(
            "TASK_NOT_FOUND",
            `task not found: ${issueId}/${taskId}`,
          );
        const readiness = inspectIssueReadiness(ctx.repoRoot, issueId);
        if (!readiness.ready || !readiness.readyTaskIds.includes(taskId))
          return errorResult(
            "TASK_NOT_LAUNCH_READY",
            "Issue Launcher blocked this Task until readiness blockers are resolved.",
            readiness,
          );
        saveControllerProjectState(ctx.repoRoot, { currentIssueId: issueId }, "chatgpt-controller");
        const requested = parseControllerAgent(
          args.agent ?? task.recommendedAgent,
        );
        if (!requested)
          return errorResult(
            "INVALID_AGENT",
            `unsupported agent: ${String(args.agent ?? task.recommendedAgent)}`,
          );
        if (requested !== "github-copilot") {
          if (!ctx.policy.execution.agentRunner)
            return errorResult(
              "DEV_RUNNER_DISABLED",
              "Start the controller profile with --enable-dev-runner to dispatch local Codex or Claude agents.",
            );
          if (!ctx.policy.execution.allowedAgents.includes(requested))
            return errorResult(
              "AGENT_DENIED",
              `local agent is not enabled: ${requested}`,
            );
        }
        const run = startTaskJob({
          repoRoot: ctx.repoRoot,
          issueId,
          taskId,
          agent: requested,
          timeoutMs: runnerTimeoutMs(ctx, args.timeout_ms),
          isolate: typeof args.isolate === "boolean" ? args.isolate : undefined,
          githubRepo:
            typeof args.github_repo === "string" ? args.github_repo : undefined,
          baseRef:
            typeof args.base_ref === "string" ? args.base_ref : undefined,
          model: typeof args.model === "string" ? args.model : undefined,
          createPullRequest: args.create_pull_request !== false,
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
      case "launch_issue": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "launch_issue requires the controller profile",
          );
        const issueId = String(args.issue_id ?? "");
        const readiness = inspectIssueReadiness(ctx.repoRoot, issueId);
        if (!readiness.ready)
          return errorResult(
            "ISSUE_NOT_READY",
            "Issue Launcher blocked execution until readiness blockers are resolved.",
            readiness,
          );
        const maxParallel = Math.min(
          Math.max(
            typeof args.max_parallel === "number"
              ? Math.trunc(args.max_parallel)
              : readiness.suggestedMaxParallel,
            1,
          ),
          4,
        );
        const issue = getIssue(ctx.repoRoot, issueId);
        saveControllerProjectState(ctx.repoRoot, { currentIssueId: issueId }, "chatgpt-controller");
        const selected: ControllerTask[] = [];
        const skipped: Array<{ taskId: string; reason: string }> = [];
        for (const task of issue.tasks.filter((entry) =>
          readiness.readyTaskIds.includes(entry.id),
        )) {
          if (selected.length >= maxParallel) break;
          if (
            selected.some((entry) =>
              taskScopesConflict(entry.allowedPaths, task.allowedPaths),
            )
          ) {
            skipped.push({
              taskId: task.id,
              reason: "allowed path scope overlaps another selected Task",
            });
            continue;
          }
          selected.push(task);
        }
        const runs = [];
        for (const task of selected) {
          const agent = task.recommendedAgent;
          if (
            agent !== "github-copilot" &&
            (!ctx.policy.execution.agentRunner ||
              !ctx.policy.execution.allowedAgents.includes(agent))
          ) {
            skipped.push({
              taskId: task.id,
              reason: `local agent is not enabled: ${agent}`,
            });
            continue;
          }
          runs.push(
            startTaskJob({
              repoRoot: ctx.repoRoot,
              issueId,
              taskId: task.id,
              agent,
              timeoutMs: runnerTimeoutMs(ctx, args.timeout_ms),
              isolate:
                typeof args.isolate === "boolean" ? args.isolate : undefined,
              githubRepo:
                typeof args.github_repo === "string"
                  ? args.github_repo
                  : undefined,
              baseRef:
                typeof args.base_ref === "string" ? args.base_ref : undefined,
              model: typeof args.model === "string" ? args.model : undefined,
              createPullRequest: args.create_pull_request !== false,
            }),
          );
        }
        audit(
          ctx,
          name,
          runs.some((run) => run.status !== "failed") ? "ok" : "failed",
          args,
          `tasks/issues/${issue.id}`,
        );
        return textResult({
          readiness,
          dispatched: runs.length,
          runs,
          skipped,
        });
      }
      case "dispatch_ready_tasks": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "dispatch_ready_tasks requires the controller profile",
          );
        const requestedIssue =
          typeof args.issue_id === "string" && args.issue_id.trim()
            ? args.issue_id.trim()
            : undefined;
        const projectState = loadControllerProjectState(ctx.repoRoot);
        const governance = inspectProjectGovernance(ctx.repoRoot);
        const issueFilter = requestedIssue ?? projectState.currentIssueId ?? governance.currentIssueId;
        if (!issueFilter) {
          return errorResult(
            "CURRENT_ISSUE_REQUIRED",
            "Select one current execution Issue before dispatching ready Tasks across the project.",
            governance,
          );
        }
        saveControllerProjectState(ctx.repoRoot, { currentIssueId: issueFilter }, "chatgpt-controller");
        const maxParallel = Math.min(
          Math.max(
            typeof args.max_parallel === "number"
              ? Math.trunc(args.max_parallel)
              : 2,
            1,
          ),
          4,
        );
        const candidates = projectBoard(ctx.repoRoot).readyTasks.filter(
          (task) => !issueFilter || task.issueId === issueFilter,
        );
        const selected: Array<{
          issueId: string;
          taskId: string;
          agent: ControllerAgent;
          allowedPaths: string[];
        }> = [];
        const skipped: Array<{
          issueId: string;
          taskId: string;
          reason: string;
        }> = [];
        for (const candidate of candidates) {
          if (selected.length >= maxParallel) break;
          const issue = getIssue(ctx.repoRoot, candidate.issueId);
          const readiness = inspectIssueReadiness(
            ctx.repoRoot,
            candidate.issueId,
          );
          if (
            !readiness.ready ||
            !readiness.readyTaskIds.includes(candidate.taskId)
          ) {
            skipped.push({
              issueId: candidate.issueId,
              taskId: candidate.taskId,
              reason: "Issue Launcher readiness gate blocked this Task",
            });
            continue;
          }
          const task = issue.tasks.find(
            (entry) => entry.id === candidate.taskId,
          );
          if (!task) continue;
          const conflict = selected.some((entry) =>
            taskScopesConflict(entry.allowedPaths, task.allowedPaths),
          );
          if (conflict) {
            skipped.push({
              issueId: candidate.issueId,
              taskId: candidate.taskId,
              reason: "allowed path scope overlaps another selected Task",
            });
            continue;
          }
          selected.push({
            issueId: candidate.issueId,
            taskId: candidate.taskId,
            agent: task.recommendedAgent,
            allowedPaths: task.allowedPaths,
          });
        }
        const runs = [];
        for (const readyTask of selected) {
          if (
            readyTask.agent !== "github-copilot" &&
            (!ctx.policy.execution.agentRunner ||
              !ctx.policy.execution.allowedAgents.includes(readyTask.agent))
          ) {
            skipped.push({
              issueId: readyTask.issueId,
              taskId: readyTask.taskId,
              reason: `local agent is not enabled: ${readyTask.agent}`,
            });
            continue;
          }
          runs.push(
            startTaskJob({
              repoRoot: ctx.repoRoot,
              issueId: readyTask.issueId,
              taskId: readyTask.taskId,
              agent: readyTask.agent,
              timeoutMs: runnerTimeoutMs(ctx, args.timeout_ms),
              isolate:
                typeof args.isolate === "boolean" ? args.isolate : undefined,
              githubRepo:
                typeof args.github_repo === "string"
                  ? args.github_repo
                  : undefined,
              baseRef:
                typeof args.base_ref === "string" ? args.base_ref : undefined,
              model: typeof args.model === "string" ? args.model : undefined,
              createPullRequest: args.create_pull_request !== false,
            }),
          );
        }
        audit(ctx, name, "ok", args);
        return textResult({ dispatched: runs.length, runs, skipped });
      }
      case "get_task_run": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "get_task_run requires the controller profile",
          );
        const run = getAgentJob(ctx.repoRoot, String(args.run_id ?? ""));
        audit(ctx, name, "ok", args, run.promptPath);
        return textResult(run);
      }
      case "get_task_run_events": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "get_task_run_events requires the controller profile",
          );
        const events = getAgentJobEvents(
          ctx.repoRoot,
          String(args.run_id ?? ""),
          typeof args.limit === "number" ? Math.trunc(args.limit) : 200,
        );
        audit(ctx, name, "ok", args);
        return textResult({ events });
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
        );
        audit(ctx, name, "ok", args, log.url);
        return textResult(log);
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
        return textResult({ runs });
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
        if (previous.agent !== "github-copilot") {
          if (!ctx.policy.execution.agentRunner)
            return errorResult(
              "DEV_RUNNER_DISABLED",
              "Start the controller profile with --enable-dev-runner to retry local agents.",
            );
          if (!ctx.policy.execution.allowedAgents.includes(previous.agent))
            return errorResult(
              "AGENT_DENIED",
              `local agent is not enabled: ${previous.agent}`,
            );
        }
        const run = retryAgentJob(ctx.repoRoot, previous.runId, {
          timeoutMs:
            args.timeout_ms === undefined
              ? undefined
              : runnerTimeoutMs(ctx, args.timeout_ms),
          isolate: typeof args.isolate === "boolean" ? args.isolate : undefined,
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
      case "verify_task": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "verify_task requires the controller profile",
          );
        const requestedCheckInputs = taskObjects(args.check_results).map((entry) => ({
          checkId: String(entry.check_id ?? ""),
          requestedSummary:
            typeof entry.summary === "string" ? entry.summary : undefined,
        }));
        const acceptanceResults = taskObjects(args.acceptance_results).map(
          (entry) => ({
            criterion: String(entry.criterion ?? ""),
            ok: entry.ok === true,
            evidence:
              typeof entry.evidence === "string" ? entry.evidence : undefined,
          }),
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
        const evidenceRunId =
          typeof args.run_id === "string" ? args.run_id : task.runIds.at(-1);
        if (evidenceRunId) {
          const run = getAgentJob(ctx.repoRoot, evidenceRunId);
          if (run.issueId !== issueId || run.taskId !== taskId)
            return errorResult(
              "RUN_TASK_MISMATCH",
              `Run ${evidenceRunId} does not belong to ${issueId}/${taskId}`,
            );
          if (run.status !== "succeeded")
            return errorResult(
              "RUN_NOT_SUCCEEDED",
              `verification requires a succeeded Run (current: ${run.status})`,
            );
          if (
            run.provider === "local" &&
            run.worktree !== ctx.repoRoot &&
            !run.integratedSessionId
          )
            return errorResult(
              "RUN_NOT_INTEGRATED",
              "integrate the isolated local Run before recording verification",
            );
          if (
            run.provider === "github" &&
            run.github?.createPullRequest !== false &&
            !run.github?.pullRequestUrl
          )
            return errorResult(
              "GITHUB_PR_NOT_READY",
              "GitHub cloud verification requires the linked pull request to be available",
            );
        }
        const checkIds = task.checks.length > 0
          ? task.checks
          : requestedCheckInputs.map((entry) => entry.checkId).filter(Boolean);
        if (checkIds.length === 0)
          return errorResult(
            "CHECKS_REQUIRED",
            "verification requires at least one declared or requested named check",
          );
        const checkResults = Array.from(new Set(checkIds)).map((checkId) => {
          try {
            const result = runControllerCheck(ctx.repoRoot, checkId);
            return {
              checkId,
              ok: result.ok,
              summary: result.ok
                ? `Passed with persisted evidence: ${result.artifactPath}`
                : `Failed with persisted evidence: ${result.artifactPath}; ${(result.stderr || result.stdout).slice(0, 500)}`,
            };
          } catch (error) {
            return {
              checkId,
              ok: false,
              summary: error instanceof Error ? error.message : String(error),
            };
          }
        });
        const verification: TaskVerification = {
          runId: evidenceRunId,
          integratedRevision:
            typeof args.integrated_revision === "string"
              ? args.integrated_revision
              : undefined,
          reviewedDiffHash:
            typeof args.reviewed_diff_hash === "string"
              ? args.reviewed_diff_hash
              : undefined,
          reviewer: String(args.reviewer ?? ""),
          checkResults,
          acceptanceResults,
          verifiedAt: new Date().toISOString(),
        };
        const issue = recordTaskVerification(
          ctx.repoRoot,
          issueId,
          taskId,
          verification,
        );
        const verifiedTask = issue.tasks.find((entry) => entry.id === taskId);
        audit(
          ctx,
          name,
          verifiedTask?.status === "verified" ? "ok" : "failed",
          args,
          `tasks/issues/${issue.id}`,
        );
        return textResult(issue);
      }
      case "accept_task": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "accept_task requires the controller profile",
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
        if (task.status !== "verified" || !task.verification)
          return errorResult(
            "TASK_NOT_VERIFIED",
            `task must pass the Verification Gate before acceptance (current: ${task.status})`,
          );
        const latestRunId = task.runIds.at(-1);
        if (latestRunId) {
          const run = getAgentJob(ctx.repoRoot, latestRunId);
          if (run.status !== "succeeded")
            return errorResult(
              "RUN_NOT_SUCCEEDED",
              `latest Run status is ${run.status}`,
            );
          if (
            run.provider === "local" &&
            run.worktree !== ctx.repoRoot &&
            !run.integratedSessionId
          )
            return errorResult(
              "RUN_NOT_INTEGRATED",
              "integrate the isolated local Task Run before accepting it",
            );
        }
        const issue = updateTask(ctx.repoRoot, issueId, taskId, {
          status: "done",
          note:
            typeof args.note === "string"
              ? args.note
              : "Accepted after controller verification.",
        });
        audit(ctx, name, "ok", args, `tasks/issues/${issue.id}`);
        return textResult(issue);
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
        return textResult(issue);
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
        const session = applyEditOperations(
          ctx.repoRoot,
          ctx.policy,
          String(args.session_id ?? ""),
          controllerEditOperations(args.operations),
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
      case "verify_edit_session": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "verify_edit_session requires the controller profile");
        const session = verifyEditSession(ctx.repoRoot, String(args.session_id ?? ""), {
          checkIds: Array.isArray(args.check_ids) ? stringList(args.check_ids) : undefined,
          reviewer: typeof args.reviewer === "string" ? args.reviewer : undefined,
          note: typeof args.note === "string" ? args.note : undefined,
        });
        audit(ctx, name, session.status === "verified" ? "ok" : "blocked", args, session.diffPath);
        return textResult(session);
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
