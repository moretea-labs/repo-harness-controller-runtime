import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { projectBoard } from "./issue-store";
import { listControllerWorklogEvents } from "./worklog";

const LEDGER_JSON_PATH = ".ai/harness/controller/task-ledger.json";
const LEDGER_HANDOFF_PATH = ".ai/harness/handoff/controller-current.md";
const LEDGER_SCHEMA_VERSION = 2;

export interface TaskLedgerTaskProjection {
  issueId: string;
  taskId: string;
  title: string;
  objective?: string;
  declaredStatus?: string;
  effectiveStatus?: string;
  statusReason?: string;
  verificationStatus?: string;
  latestRunStatus?: string;
  latestRunClosureState?: string;
  activeRunId?: string;
  activeRunStatus?: string;
  retryable: boolean;
  requiresExplicitRetry: boolean;
  dispatchable: boolean;
  queueable: boolean;
  multipleActiveRuns: boolean;
  allowedPaths: string[];
  checks: string[];
  runIds: string[];
}

export type TaskLedgerStatusKind =
  | "empty"
  | "needs_issue_selection"
  | "active_work"
  | "needs_review"
  | "needs_retry_decision"
  | "blocked"
  | "ready_to_dispatch"
  | "queueable_pending"
  | "continue_current"
  | "complete_or_idle";

export interface TaskLedgerStatusProjection {
  kind: TaskLedgerStatusKind;
  severity: "info" | "action" | "warning" | "blocked";
  label: string;
  reason: string;
  issueId?: string;
  taskId?: string;
  nextAction: string;
}

export interface TaskLedgerIssueProjection {
  id: string;
  title: string;
  status?: string;
  lifecycleStatus?: string;
  isCurrent: boolean;
  updatedAt?: string;
  taskCounts: Record<string, number>;
  tasks: TaskLedgerTaskProjection[];
}

export interface TaskLedgerProjection {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  generatedAt: string;
  source: "controller-task-ledger";
  currentIssueId?: string;
  counts: Record<string, number>;
  declaredCounts: Record<string, number>;
  archivedCounts: Record<string, number>;
  issueCount: number;
  archivedIssueCount: number;
  status: TaskLedgerStatusProjection;
  issues: TaskLedgerIssueProjection[];
  attention: TaskLedgerTaskProjection[];
  readyTasks: Array<Record<string, string>>;
  queueableTasks: Array<Record<string, string>>;
  recentEvents: Array<{
    at: string;
    category: string;
    action: string;
    summary: string;
    issueId?: string;
    taskId?: string;
    runId?: string;
    jobId?: string;
  }>;
  suggestedNextActions: string[];
  contextContract: {
    strategy: string;
    rawCodeRequiredForImplementation: true;
    notes: string[];
  };
}

export interface TaskLedgerArtifactPreview {
  path: string;
  exists: boolean;
  preview?: string;
}

export interface WrittenTaskLedgerArtifacts {
  projection: TaskLedgerProjection;
  artifacts: TaskLedgerArtifactPreview[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((entry) => Object.keys(entry).length > 0);
}

function taskProjection(issueId: string, value: Record<string, unknown>): TaskLedgerTaskProjection {
  return {
    issueId,
    taskId: asString(value.id) ?? "unknown-task",
    title: asString(value.title) ?? "Untitled task",
    objective: asString(value.objective),
    declaredStatus: asString(value.declaredStatus),
    effectiveStatus: asString(value.effectiveStatus),
    statusReason: asString(value.statusReason),
    verificationStatus: asString(value.verificationStatus),
    latestRunStatus: asString(value.latestRunStatus),
    latestRunClosureState: asString(value.latestRunClosureState),
    activeRunId: asString(value.activeRunId),
    activeRunStatus: asString(value.activeRunStatus),
    retryable: asBoolean(value.retryable),
    requiresExplicitRetry: asBoolean(value.requiresExplicitRetry),
    dispatchable: asBoolean(value.dispatchable),
    queueable: asBoolean(value.queueable),
    multipleActiveRuns: asBoolean(value.multipleActiveRuns),
    allowedPaths: asStringArray(value.allowedPaths),
    checks: asStringArray(value.checks),
    runIds: asStringArray(value.runIds),
  };
}

function compactIssue(value: Record<string, unknown>): TaskLedgerIssueProjection {
  const id = asString(value.id) ?? "unknown-issue";
  const tasks = asRecordArray(value.tasks).map((task) => taskProjection(id, task));
  const taskCounts = tasks.reduce<Record<string, number>>((counts, task) => {
    const status = task.effectiveStatus ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  return {
    id,
    title: asString(value.title) ?? "Untitled issue",
    status: asString(value.status),
    lifecycleStatus: asString(value.lifecycleStatus),
    isCurrent: asBoolean(value.isCurrent),
    updatedAt: asString(value.updatedAt),
    taskCounts,
    tasks,
  };
}

function attentionScore(task: TaskLedgerTaskProjection): number {
  if (task.multipleActiveRuns) return 100;
  if (task.effectiveStatus === 'integration_blocked' || task.latestRunClosureState === 'integration_blocked') return 99;
  if (task.effectiveStatus === 'ready_to_integrate' || task.latestRunClosureState === 'ready_to_integrate') return 98;
  if (task.effectiveStatus === 'cleanup_blocked' || task.latestRunClosureState === 'cleanup_blocked') return 97;
  if (task.effectiveStatus === 'cleanup_pending' || ['integrated', 'cleanup_pending', 'cleaning'].includes(task.latestRunClosureState ?? '')) return 96;
  if (task.requiresExplicitRetry || task.retryable) return 90;
  if (["changes_requested", "blocked"].includes(task.effectiveStatus ?? "")) return 80;
  if (["review", "integrated", "verifying"].includes(task.effectiveStatus ?? "")) return 70;
  if (["queued", "running"].includes(task.effectiveStatus ?? "") || task.activeRunId) return 60;
  if (task.dispatchable || task.queueable) return 40;
  return 0;
}

function buildAttentionTasks(issues: TaskLedgerIssueProjection[]): TaskLedgerTaskProjection[] {
  return issues
    .flatMap((issue) => issue.tasks)
    .map((task) => ({ task, score: attentionScore(task) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.task.issueId.localeCompare(right.task.issueId) || left.task.taskId.localeCompare(right.task.taskId))
    .slice(0, 20)
    .map((entry) => entry.task);
}

function copyCounts(value: unknown): Record<string, number> {
  const record = asRecord(value);
  return Object.fromEntries(Object.entries(record)
    .map(([key, entry]) => [key, typeof entry === "number" && Number.isFinite(entry) ? entry : Number(entry)])
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

function compactBoardTasks(value: unknown): Array<Record<string, string>> {
  return asRecordArray(value).slice(0, 20).map((entry) => Object.fromEntries(Object.entries(entry)
    .flatMap(([key, item]) => {
      const stringValue = asString(item);
      return stringValue ? [[key, stringValue] as [string, string]] : [];
    })));
}


function terminalOrInactiveStatus(status: string | undefined): boolean {
  return ["done", "cancelled", "superseded", "verified"].includes(status ?? "");
}

function taskReference(task: TaskLedgerTaskProjection | Record<string, string> | undefined): { issueId?: string; taskId?: string } {
  if (!task) return {};
  return {
    issueId: typeof task.issueId === "string" ? task.issueId : undefined,
    taskId: typeof task.taskId === "string" ? task.taskId : undefined,
  };
}

function statusProjection(input: {
  currentIssueId?: string;
  issues: TaskLedgerIssueProjection[];
  attention: TaskLedgerTaskProjection[];
  readyTasks: Array<Record<string, string>>;
  queueableTasks: Array<Record<string, string>>;
}): TaskLedgerStatusProjection {
  const current = input.currentIssueId
    ? input.issues.find((issue) => issue.id === input.currentIssueId)
    : undefined;
  const running = input.attention.find((task) => task.multipleActiveRuns || ["queued", "running"].includes(task.effectiveStatus ?? "") || task.activeRunId);
  const cleanupBlocked = input.attention.find((task) => task.effectiveStatus === 'cleanup_blocked' || task.latestRunClosureState === 'cleanup_blocked');
  const review = input.attention.find((task) =>
    ["review", "verifying", "ready_to_integrate", "integrating", "integration_blocked", "integrated", "cleanup_pending"].includes(task.effectiveStatus ?? "")
    || ['ready_to_integrate', 'integrating', 'integration_blocked', 'integrated', 'cleanup_pending'].includes(task.latestRunClosureState ?? ''),
  );
  const retry = input.attention.find((task) => task.retryable || task.requiresExplicitRetry);
  const blocked = input.attention.find((task) => ["blocked", "changes_requested"].includes(task.effectiveStatus ?? ""));
  const ready = input.readyTasks[0];
  const queueable = input.queueableTasks[0];
  const nonTerminalCurrentTask = current?.tasks.find((task) => !terminalOrInactiveStatus(task.effectiveStatus));

  if (!input.issues.length) {
    return {
      kind: "empty",
      severity: "info",
      label: "No controller Issue",
      reason: "No durable controller Issues are available in this repository.",
      nextAction: "Create or import a controller Issue before starting implementation.",
    };
  }

  if (!current) {
    return {
      kind: "needs_issue_selection",
      severity: "action",
      label: "Select current Issue",
      reason: "Issues exist but no current active Issue is selected.",
      nextAction: "Select a current Issue before dispatching or continuing work.",
    };
  }

  if (running) {
    return {
      kind: "active_work",
      severity: running.multipleActiveRuns ? "warning" : "info",
      label: running.multipleActiveRuns ? "Multiple active runs" : "Work in progress",
      reason: running.multipleActiveRuns
        ? "A Task has multiple active Runs and needs coordination before more work is dispatched."
        : "A Task has active queued/running work or an active Run.",
      ...taskReference(running),
      nextAction: `Monitor Task ${running.issueId}/${running.taskId}; avoid overlapping changes until the active Run settles.`,
    };
  }

  if (cleanupBlocked) {
    return {
      kind: "blocked",
      severity: "blocked",
      label: "Cleanup blocked",
      reason: "Integration completed or was attempted, but owned resources are dirty, unmerged, occupied, or could not be safely removed.",
      ...taskReference(cleanupBlocked),
      nextAction: `Resolve cleanup blocker for Task ${cleanupBlocked.issueId}/${cleanupBlocked.taskId}; it cannot be completed until cleanup evidence is recorded.`,
    };
  }

  if (review) {
    const status = review.effectiveStatus ?? review.latestRunClosureState ?? 'review';
    const readyToIntegrate = status === 'ready_to_integrate' || review.latestRunClosureState === 'ready_to_integrate';
    const integrationBlocked = status === 'integration_blocked' || review.latestRunClosureState === 'integration_blocked';
    const cleanupPending = status === 'cleanup_pending' || review.latestRunClosureState === 'cleanup_pending';
    const alreadyIntegrated = status === 'integrated' || review.latestRunClosureState === 'integrated';
    let label = 'Review required';
    let reason = `A Task is awaiting lifecycle review (${status}).`;
    let nextAction = `Review Task ${review.issueId}/${review.taskId}; inspect raw diff and evidence before accepting or requesting changes.`;
    if (readyToIntegrate) {
      label = 'Ready to integrate';
      reason = 'Work is complete and validated; integration is the next step (not finalization wait).';
      nextAction = `Integrate Task ${review.issueId}/${review.taskId}, then run owned cleanup for branch/worktree/edit session.`;
    } else if (integrationBlocked) {
      label = 'Integration blocked';
      reason = 'Integration cannot proceed until conflicts, ownership, or evidence blockers are resolved.';
      nextAction = `Resolve integration blocker for Task ${review.issueId}/${review.taskId}; do not mark ready_to_integrate until blockers clear.`;
    } else if (cleanupPending || alreadyIntegrated) {
      label = alreadyIntegrated ? 'Cleanup after integration' : 'Cleanup pending';
      reason = 'Integration finished or is recorded; owned branch/worktree/temp resources still need cleanup before close.';
      nextAction = `Cleanup owned resources for Task ${review.issueId}/${review.taskId}, then close the Task.`;
    }
    return {
      kind: "needs_review",
      severity: "action",
      label,
      reason,
      ...taskReference(review),
      nextAction,
    };
  }

  if (retry) {
    return {
      kind: "needs_retry_decision",
      severity: "action",
      label: "Retry decision required",
      reason: "A Task has retryable or explicitly retry-required state.",
      ...taskReference(retry),
      nextAction: `Decide whether to retry Task ${retry.issueId}/${retry.taskId} or update its plan first.`,
    };
  }

  if (blocked) {
    return {
      kind: "blocked",
      severity: "blocked",
      label: "Blocked or changes requested",
      reason: "A Task is blocked or has requested changes.",
      ...taskReference(blocked),
      nextAction: `Resolve blocker or requested changes for Task ${blocked.issueId}/${blocked.taskId}.`,
    };
  }

  if (ready) {
    return {
      kind: "ready_to_dispatch",
      severity: "action",
      label: "Ready task available",
      reason: "At least one Task is ready to dispatch.",
      ...taskReference(ready),
      nextAction: `Dispatch a small path-independent slice for Task ${ready.issueId}/${ready.taskId}; keep validation targeted.`,
    };
  }

  if (queueable) {
    return {
      kind: "queueable_pending",
      severity: "info",
      label: "Queueable task available",
      reason: "At least one Task is queueable but may still need approval, retry, or readiness review.",
      ...taskReference(queueable),
      nextAction: `Inspect Task ${queueable.issueId}/${queueable.taskId} readiness before dispatching.`,
    };
  }

  if (nonTerminalCurrentTask) {
    return {
      kind: "continue_current",
      severity: "info",
      label: "Continue current Issue",
      reason: "Current Issue has non-terminal Tasks but no immediate review, retry, blocker, or ready queue item was detected.",
      ...taskReference(nonTerminalCurrentTask),
      nextAction: `Inspect Issue ${current.id} and expand raw source context before choosing the next implementation slice.`,
    };
  }

  return {
    kind: "complete_or_idle",
    severity: "info",
    label: "No immediate task action",
    reason: "No active, blocked, review, retry, ready, or queueable Task was detected.",
    issueId: current.id,
    nextAction: "Close out completed work or create/import the next Issue.",
  };
}

function buildSuggestedNextActions(input: {
  currentIssueId?: string;
  issues: TaskLedgerIssueProjection[];
  attention: TaskLedgerTaskProjection[];
  readyTasks: Array<Record<string, string>>;
  queueableTasks: Array<Record<string, string>>;
}): string[] {
  const actions: string[] = [];
  const current = input.currentIssueId
    ? input.issues.find((issue) => issue.id === input.currentIssueId)
    : undefined;
  const retry = input.attention.find((task) => task.retryable || task.requiresExplicitRetry);
  const review = input.attention.find((task) => ["review", "integrated", "verifying"].includes(task.effectiveStatus ?? ""));
  const blocked = input.attention.find((task) => ["blocked", "changes_requested"].includes(task.effectiveStatus ?? ""));
  const running = input.attention.find((task) => ["queued", "running"].includes(task.effectiveStatus ?? "") || task.activeRunId);

  if (!input.issues.length) actions.push("Create or import a controller Issue before starting implementation.");
  if (!current && input.issues.length) actions.push("Select a current active Issue or ask controller_context for the current queue before dispatching work.");
  if (review) actions.push(`Review Task ${review.issueId}/${review.taskId}, inspect its diff/evidence, then accept or request changes.`);
  if (retry) actions.push(`Decide whether to retry Task ${retry.issueId}/${retry.taskId} or update its plan before retrying.`);
  if (blocked) actions.push(`Resolve blocker or requested changes for Task ${blocked.issueId}/${blocked.taskId}.`);
  if (running) actions.push(`Monitor active Run for Task ${running.issueId}/${running.taskId}; avoid dispatching overlapping work until it settles.`);
  if (input.readyTasks.length) actions.push("Dispatch at most a small path-independent slice from readyTasks; keep verification targeted.");
  if (!input.readyTasks.length && input.queueableTasks.length) actions.push("Inspect queueableTasks readiness before dispatching; some may need explicit retry or dependency updates.");
  if (current && actions.length === 0) actions.push(`Continue current Issue ${current.id}; inspect relevant source before implementation decisions.`);
  if (!actions.some((entry) => entry.includes("source"))) actions.push("For code changes, expand raw source snippets and diffs at the exact decision points; do not rely on this projection alone.");
  return actions.slice(0, 8);
}

export function buildControllerTaskLedgerProjection(repoRoot: string): TaskLedgerProjection {
  const board = projectBoard(repoRoot);
  const issues = asRecordArray(board.issues).map(compactIssue);
  const attention = buildAttentionTasks(issues);
  const readyTasks = compactBoardTasks(board.readyTasks);
  const queueableTasks = compactBoardTasks(board.queueableTasks);
  const status = statusProjection({
    currentIssueId: board.currentIssueId,
    issues,
    attention,
    readyTasks,
    queueableTasks,
  });
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: "controller-task-ledger",
    currentIssueId: board.currentIssueId,
    counts: copyCounts(board.counts),
    declaredCounts: copyCounts(board.declaredCounts),
    archivedCounts: copyCounts(board.archivedCounts),
    issueCount: issues.length,
    archivedIssueCount: typeof board.archivedIssueCount === "number" ? board.archivedIssueCount : 0,
    status,
    issues: issues.slice(0, 20),
    attention,
    readyTasks,
    queueableTasks,
    recentEvents: listControllerWorklogEvents(repoRoot, { limit: 20 }).map((event) => ({
      at: event.at,
      category: event.category,
      action: event.action,
      summary: event.summary,
      issueId: event.issueId,
      taskId: event.taskId,
      runId: event.runId,
      jobId: event.jobId,
    })),
    suggestedNextActions: buildSuggestedNextActions({
      currentIssueId: board.currentIssueId,
      issues,
      attention,
      readyTasks,
      queueableTasks,
    }),
    contextContract: {
      strategy: "projection-for-recovery-only",
      rawCodeRequiredForImplementation: true,
      notes: [
        "Use this ledger to recover goal, status, blockers, review queue, and next action.",
        "Use raw source snippets, type definitions, diffs, and verification output for implementation decisions.",
        "Keep checks targeted unless the task or release policy explicitly requires a wider surface.",
      ],
    },
  };
}

function tableEscape(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderTaskRow(task: TaskLedgerTaskProjection): string {
  return `| ${tableEscape(task.issueId)} | ${tableEscape(task.taskId)} | ${tableEscape(task.title)} | ${tableEscape(task.effectiveStatus)} | ${tableEscape(task.verificationStatus)} | ${tableEscape(task.latestRunStatus ?? task.activeRunStatus ?? "")} |`;
}

export function renderControllerTaskLedgerHandoff(projection: TaskLedgerProjection, reason: string): string {
  const current = projection.currentIssueId
    ? projection.issues.find((issue) => issue.id === projection.currentIssueId)
    : undefined;
  const taskRows = projection.attention.length
    ? projection.attention.map(renderTaskRow)
    : ["| - | - | No attention tasks | - | - | - |"];
  return [
    "# Controller Task Ledger Handoff",
    "",
    `> **Generated**: ${projection.generatedAt}`,
    `> **Reason**: ${reason}`,
    '> **Source**: controller Issue/Task/Run state + worklog projection',
    "",
    "## Current Focus",
    "",
    current
      ? `- Current Issue: \`${current.id}\` — ${current.title} (${current.lifecycleStatus ?? current.status ?? "unknown"})`
      : "- Current Issue: not selected.",
    `- Issue count: ${projection.issueCount}`,
    `- Archived Issue count: ${projection.archivedIssueCount}`,
    `- Effective task counts: \`${JSON.stringify(projection.counts)}\``,
    `- Continuation state: \`${projection.status.kind}\` — ${projection.status.label}`,
    `- Continuation reason: ${projection.status.reason}`,
    "",
    "## Next Actions",
    "",
    ...projection.suggestedNextActions.map((action) => `- ${action}`),
    "",
    "## Attention Tasks",
    "",
    "| Issue | Task | Title | Effective Status | Verification | Latest Run |",
    "| --- | --- | --- | --- | --- | --- |",
    ...taskRows,
    "",
    "## Ready Queue",
    "",
    ...(projection.readyTasks.length
      ? projection.readyTasks.slice(0, 10).map((task) => `- ${task.issueId}/${task.taskId}: ${task.title ?? "Untitled"} (${task.executionClass ?? "unknown"})`)
      : ["- No ready tasks reported."]),
    "",
    "## Recent Worklog",
    "",
    ...(projection.recentEvents.length
      ? projection.recentEvents.slice(0, 10).map((event) => `- ${event.at} [${event.category}/${event.action}] ${event.summary}`)
      : ["- No worklog events recorded yet."]),
    "",
    "## Context Contract",
    "",
    "- This file is a recovery/status projection, not a substitute for source review.",
    "- For implementation, expand the exact source snippets, relevant types/callers, current diff, and focused test output before making decisions.",
    "- Keep validation targeted unless the task/release policy requires broader checks.",
    "",
  ].join("\n");
}

function artifactPreview(repoRoot: string, path: string): TaskLedgerArtifactPreview {
  const absolute = join(repoRoot, path);
  if (!existsSync(absolute)) return { path, exists: false };
  const content = readFileSync(absolute, "utf-8");
  return {
    path,
    exists: true,
    preview: content.split(/\r?\n/).slice(0, 32).join("\n"),
  };
}

export function writeControllerTaskLedgerArtifacts(repoRoot: string, input: { reason?: unknown } = {}): WrittenTaskLedgerArtifacts {
  const reason = String(input.reason ?? "manual").trim() || "manual";
  const projection = buildControllerTaskLedgerProjection(repoRoot);
  const jsonPath = join(repoRoot, LEDGER_JSON_PATH);
  const handoffPath = join(repoRoot, LEDGER_HANDOFF_PATH);
  mkdirSync(dirname(jsonPath), { recursive: true });
  mkdirSync(dirname(handoffPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(projection, null, 2)}\n`, "utf-8");
  writeFileSync(handoffPath, renderControllerTaskLedgerHandoff(projection, reason), "utf-8");
  return {
    projection,
    artifacts: [
      artifactPreview(repoRoot, LEDGER_JSON_PATH),
      artifactPreview(repoRoot, LEDGER_HANDOFF_PATH),
    ],
  };
}

export function controllerTaskLedgerArtifactPaths(): { json: string; handoff: string } {
  return { json: LEDGER_JSON_PATH, handoff: LEDGER_HANDOFF_PATH };
}
