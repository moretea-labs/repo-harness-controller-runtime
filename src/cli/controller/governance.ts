import { listAgentJobs } from "../agent-jobs/job-manager";
import type { AgentJobMeta } from "../agent-jobs/types";
import {
  acceptVerifiedTask,
  archiveIssue,
  getIssue,
  listIssues,
  setTaskDependencies,
  updateIssue,
  updateTask,
} from "./issue-store";
import { clearCurrentIssue, loadControllerProjectState, saveControllerProjectState } from "./project-state";
import type { ControllerIssue, ControllerTask } from "./types";
import { taskExecutionPolicy } from "./execution-policy";
import { readIssueRunEvidence } from "./run-evidence";
import { resolveEffectiveTaskState, resolveIssueTaskStates, resolveTaskDependencies, type EffectiveTaskState } from "./task-status-resolver";
import { tryAppendControllerWorklogEvent } from "./worklog";

export type GovernanceSeverity = "info" | "warning" | "critical";
export type GovernanceAction =
  | "set_focus"
  | "repair_dependency"
  | "retry_task"
  | "review_task"
  | "accept_task"
  | "close_issue"
  | "archive_issue"
  | "merge_duplicate"
  | "none";

export interface GovernanceFinding {
  id: string;
  code: string;
  severity: GovernanceSeverity;
  message: string;
  issueId?: string;
  taskId?: string;
  runId?: string;
  recommendedAction: GovernanceAction;
  autoFixable: boolean;
}

export interface ExecutionQueueItem {
  issueId: string;
  issueTitle: string;
  taskId: string;
  taskTitle: string;
  agent: string;
  risk: string;
  latestRunId?: string;
  latestRunStatus?: string;
  action: "launch" | "retry" | "review" | "accept" | "unblock";
}

export interface ProjectGovernanceSnapshot {
  generatedAt: string;
  health: "healthy" | "attention" | "blocked";
  status: GovernanceStatusSummary;
  currentIssueId?: string;
  currentIssueTitle?: string;
  activeIssueCount: number;
  archivedIssueCount: number;
  executionQueue: ExecutionQueueItem[];
  findings: GovernanceFinding[];
  counts: Record<string, number>;
}

export interface ReconcileResult {
  changed: boolean;
  changes: Array<{ issueId: string; taskId?: string; action: string; summary: string }>;
  governance: ProjectGovernanceSnapshot;
}

export type GovernanceStatusKind =
  | "idle"
  | "ready"
  | "needs_review"
  | "needs_retry"
  | "blocked"
  | "archive_ready";

export interface GovernanceStatusSummary {
  kind: GovernanceStatusKind;
  label: string;
  reason: string;
  issueId?: string;
  taskId?: string;
}

const ISSUE_TERMINAL = new Set(["done", "cancelled"]);
const TASK_TERMINAL = new Set(["done", "cancelled", "superseded"]);
const GOVERNANCE_RETRY_BLOCKER_NOTE = "explicit retry is required and no new Run was created";

function findingId(code: string, issueId?: string, taskId?: string): string {
  return [code, issueId, taskId].filter(Boolean).join(":");
}

function latestRun(task: ControllerTask, byId: Map<string, AgentJobMeta>): AgentJobMeta | undefined {
  for (const id of task.runIds.slice().reverse()) {
    const run = byId.get(id);
    if (run) return run;
  }
  return undefined;
}

function normalizedTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, "").trim();
}

function activeIssues(issues: ControllerIssue[]): ControllerIssue[] {
  return issues.filter((issue) => !issue.archivedAt && !ISSUE_TERMINAL.has(issue.status));
}

function governanceStatusSummary(input: {
  activeIssueCount: number;
  executionQueue: ExecutionQueueItem[];
  findings: GovernanceFinding[];
}): GovernanceStatusSummary {
  const blocked = input.findings.find((entry) => entry.severity === "critical");
  if (blocked) {
    return {
      kind: "blocked",
      label: "Blocked",
      reason: blocked.message,
      issueId: blocked.issueId,
      taskId: blocked.taskId,
    };
  }

  const review = input.findings.find((entry) => ["TASK_REVIEW_PENDING", "TASK_ACCEPTANCE_PENDING"].includes(entry.code));
  if (review) {
    return {
      kind: "needs_review",
      label: "Needs review",
      reason: review.message,
      issueId: review.issueId,
      taskId: review.taskId,
    };
  }

  const retry = input.findings.find((entry) => entry.code === "FAILED_RUN_BLOCKED_TASK");
  if (retry) {
    return {
      kind: "needs_retry",
      label: "Needs retry decision",
      reason: retry.message,
      issueId: retry.issueId,
      taskId: retry.taskId,
    };
  }

  const ready = input.executionQueue.find((entry) => entry.action === "launch");
  if (ready) {
    return {
      kind: "ready",
      label: "Ready to dispatch",
      reason: `${ready.issueId}/${ready.taskId} can be launched without additional governance repair.`,
      issueId: ready.issueId,
      taskId: ready.taskId,
    };
  }

  const archiveReady = input.findings.find((entry) => entry.code === "TERMINAL_ISSUE_NOT_ARCHIVED");
  if (archiveReady) {
    return {
      kind: "archive_ready",
      label: "Archive ready",
      reason: archiveReady.message,
      issueId: archiveReady.issueId,
    };
  }

  return {
    kind: "idle",
    label: input.activeIssueCount > 0 ? "No immediate action" : "No active issues",
    reason: input.activeIssueCount > 0
      ? "No review, retry, blocked, or dispatchable task needs immediate governance action."
      : "No active controller issues remain in the current workspace.",
  };
}

function hasGovernanceRetryBlocker(task: ControllerTask): boolean {
  return task.notes.some((note) => note.includes(GOVERNANCE_RETRY_BLOCKER_NOTE));
}

function shouldAutoAcceptVerifiedTask(task: ControllerTask): boolean {
  if (task.status !== "verified" || !task.verification) return false;
  const policy = taskExecutionPolicy(task);
  return policy.autoCompleteAfterSuccessfulRun && !policy.requiresHumanAcceptance;
}

function taskQueueItem(issue: ControllerIssue, task: ControllerTask, state: EffectiveTaskState): ExecutionQueueItem | undefined {
  const common = {
    issueId: issue.id,
    issueTitle: issue.title,
    taskId: task.id,
    taskTitle: task.title,
    agent: task.recommendedAgent ?? "runtime-selected",
    risk: task.risk,
    latestRunId: state.latestRunId,
    latestRunStatus: state.latestRunStatus,
  };
  if (state.dispatchable) return { ...common, action: "launch" };
  if (state.retryable && state.requiresExplicitRetry) return { ...common, action: "retry" };
  if (["review", "integrated", "verifying"].includes(state.effectiveStatus)) return { ...common, action: "review" };
  if (state.effectiveStatus === "verified") return { ...common, action: "accept" };
  if (["launch_blocked", "blocked", "waiting_for_user"].includes(state.effectiveStatus)) return { ...common, action: "unblock" };
  return undefined;
}

export function inspectProjectGovernance(repoRoot: string): ProjectGovernanceSnapshot {
  const issues = listIssues(repoRoot);
  const runs = listAgentJobs(repoRoot, 2000);
  const byId = new Map(runs.map((run) => [run.runId, run]));
  const state = loadControllerProjectState(repoRoot);
  const active = activeIssues(issues);
  const archived = issues.filter((issue) => Boolean(issue.archivedAt));
  const findings: GovernanceFinding[] = [];

  const focus = state.currentIssueId ? active.find((issue) => issue.id === state.currentIssueId) : undefined;
  if (!focus && active.length > 1) {
    findings.push({
      id: findingId("CURRENT_ISSUE_MISSING"),
      code: "CURRENT_ISSUE_MISSING",
      severity: "info",
      message: `${active.length} active Issues exist without a selected focus. Focus is informational and does not block independent Tasks.`,
      recommendedAction: "set_focus",
      autoFixable: false,
    });
  }
  if (focus && (focus.archivedAt || ISSUE_TERMINAL.has(focus.status))) {
    findings.push({
      id: findingId("CURRENT_ISSUE_TERMINAL", focus.id),
      code: "CURRENT_ISSUE_TERMINAL",
      severity: "warning",
      message: `Current Issue ${focus.id} is terminal or archived. Clear it for navigation clarity; execution of other Tasks is unaffected.`,
      issueId: focus.id,
      recommendedAction: "set_focus",
      autoFixable: true,
    });
  }
  if (active.length > 1) {
    findings.push({
      id: findingId("MULTIPLE_ACTIVE_ISSUES"),
      code: "MULTIPLE_ACTIVE_ISSUES",
      severity: "info",
      message: `${active.length} active Issues exist. Independent non-conflicting Tasks may execute across all of them.`,
      recommendedAction: "set_focus",
      autoFixable: false,
    });
  }

  const titleGroups = new Map<string, ControllerIssue[]>();
  for (const issue of active) {
    const key = normalizedTitle(issue.title);
    if (!key) continue;
    const group = titleGroups.get(key) ?? [];
    group.push(issue);
    titleGroups.set(key, group);
  }
  for (const group of titleGroups.values()) {
    if (group.length < 2) continue;
    findings.push({
      id: findingId("DUPLICATE_ACTIVE_ISSUES", group[0].id),
      code: "DUPLICATE_ACTIVE_ISSUES",
      severity: "warning",
      message: `Potential duplicate active Issues: ${group.map((issue) => issue.id).join(", ")}.`,
      issueId: group[0].id,
      recommendedAction: "merge_duplicate",
      autoFixable: false,
    });
  }

  for (const issue of issues.filter((entry) => !entry.archivedAt)) {
    const issueStates = resolveIssueTaskStates(issue, readIssueRunEvidence(repoRoot, issue));
    const nonSuperseded = issue.tasks.filter((task) => {
      const state = issueStates.get(task.id)!;
      return state.effectiveStatus !== "superseded" && state.effectiveStatus !== "cancelled";
    });
    if (nonSuperseded.length > 0 && nonSuperseded.every((task) => issueStates.get(task.id)!.effectiveStatus === "done") && issue.status !== "done") {
      findings.push({
        id: findingId("ISSUE_NOT_CLOSED", issue.id),
        code: "ISSUE_NOT_CLOSED",
        severity: "warning",
        message: `${issue.id} has no unfinished Tasks but is still ${issue.status}.`,
        issueId: issue.id,
        recommendedAction: "close_issue",
        autoFixable: true,
      });
    }
    if (ISSUE_TERMINAL.has(issue.status) && !issue.archivedAt) {
      findings.push({
        id: findingId("TERMINAL_ISSUE_NOT_ARCHIVED", issue.id),
        code: "TERMINAL_ISSUE_NOT_ARCHIVED",
        severity: "info",
        message: `${issue.id} is terminal and can be moved out of the current workspace.`,
        issueId: issue.id,
        recommendedAction: "archive_issue",
        autoFixable: false,
      });
    }

    let hasActionableTask = false;
    for (const task of issue.tasks) {
      const state = issueStates.get(task.id)!;
      if (state.terminal || state.inactive) continue;
      const run = latestRun(task, byId);
      if (state.multipleActiveRuns) {
        findings.push({
          id: findingId("MULTIPLE_ACTIVE_RUNS", issue.id, task.id),
          code: "MULTIPLE_ACTIVE_RUNS",
          severity: "critical",
          message: `${task.id} has multiple active Run records: ${state.activeRunIds.join(", ")}.`,
          issueId: issue.id,
          taskId: task.id,
          runId: state.activeRunId,
          recommendedAction: "none",
          autoFixable: false,
        });
      } else if (state.activeRunIds.length > 0 && !state.activeRunId) {
        findings.push({
          id: findingId("STALE_ACTIVE_RUN", issue.id, task.id),
          code: "STALE_ACTIVE_RUN",
          severity: "critical",
          message: `${task.id} has stale active Run evidence: ${state.activeRunIds.join(", ")}. Refresh or cancel it before further execution.`,
          issueId: issue.id,
          taskId: task.id,
          recommendedAction: "none",
          autoFixable: false,
        });
      }
      const dependencyState = resolveTaskDependencies(issue, task, issueStates);
      const cancelledDeps = dependencyState.cancelledTaskIds;
      const staleSupersededDeps = dependencyState.supersededMigrations.map((entry) => entry.dependencyTaskId);
      if (cancelledDeps.length > 0) {
        findings.push({
          id: findingId("CANCELLED_DEPENDENCY", issue.id, task.id),
          code: "CANCELLED_DEPENDENCY",
          severity: "critical",
          message: `${task.id} depends on cancelled Task(s): ${cancelledDeps.join(", ")}.`,
          issueId: issue.id,
          taskId: task.id,
          recommendedAction: "repair_dependency",
          autoFixable: false,
        });
      }
      if (staleSupersededDeps.length > 0) {
        findings.push({
          id: findingId("STALE_SUPERSEDED_DEPENDENCY", issue.id, task.id),
          code: "STALE_SUPERSEDED_DEPENDENCY",
          severity: "warning",
          message: `${task.id} still points at superseded Task(s): ${staleSupersededDeps.join(", ")}.`,
          issueId: issue.id,
          taskId: task.id,
          recommendedAction: "repair_dependency",
          autoFixable: true,
        });
      }
      if (state.retryable && state.requiresExplicitRetry) {
        findings.push({
          id: findingId("FAILED_RUN_BLOCKED_TASK", issue.id, task.id),
          code: "FAILED_RUN_BLOCKED_TASK",
          severity: "warning",
          message: `${task.id} has a failed/cancelled Run recorded as evidence. It remains non-dispatchable until explicit retry.`,
          issueId: issue.id,
          taskId: task.id,
          runId: state.latestRunId,
          recommendedAction: "retry_task",
          autoFixable: false,
        });
      }
      if (state.dispatchable || state.retryable || ["blocked", "launch_blocked", "review", "integrated", "verifying", "verified", "running", "queued", "waiting_for_user"].includes(state.effectiveStatus)) hasActionableTask = true;
      if (state.effectiveStatus === "review") {
        findings.push({
          id: findingId("TASK_REVIEW_PENDING", issue.id, task.id),
          code: "TASK_REVIEW_PENDING",
          severity: "warning",
          message: `${task.id} has implementation output but still needs review and Verification Gate evidence.`,
          issueId: issue.id,
          taskId: task.id,
          runId: run?.runId,
          recommendedAction: "review_task",
          autoFixable: false,
        });
      }
      if (state.effectiveStatus === "verified") {
        findings.push({
          id: findingId("TASK_ACCEPTANCE_PENDING", issue.id, task.id),
          code: "TASK_ACCEPTANCE_PENDING",
          severity: "warning",
          message: `${task.id} passed verification but has not been accepted and closed.`,
          issueId: issue.id,
          taskId: task.id,
          runId: run?.runId,
          recommendedAction: "accept_task",
          autoFixable: false,
        });
      }
    }
    if (!ISSUE_TERMINAL.has(issue.status) && issue.tasks.length > 0 && !hasActionableTask) {
      findings.push({
        id: findingId("ISSUE_HAS_NO_ACTIONABLE_TASK", issue.id),
        code: "ISSUE_HAS_NO_ACTIONABLE_TASK",
        severity: "critical",
        message: `${issue.id} is active but has no Task that can be launched, reviewed, accepted, or retried.`,
        issueId: issue.id,
        recommendedAction: "repair_dependency",
        autoFixable: false,
      });
    }
  }

  const queueIssue = focus && !focus.archivedAt && !ISSUE_TERMINAL.has(focus.status) ? focus : undefined;
  const executionQueue = active.flatMap((issue) => {
    const states = resolveIssueTaskStates(issue, readIssueRunEvidence(repoRoot, issue));
    return issue.tasks
      .filter((task) => {
        const state = states.get(task.id)!;
        const dependencies = resolveTaskDependencies(issue, task, states);
        return !state.terminal && !state.inactive && state.activeRunIds.length === 0 && dependencies.ready;
      })
      .map((task) => taskQueueItem(issue, task, states.get(task.id)!))
      .filter((entry): entry is ExecutionQueueItem => Boolean(entry));
  });

  const counts = findings.reduce<Record<string, number>>((result, entry) => {
    result[entry.severity] = (result[entry.severity] ?? 0) + 1;
    result[entry.code] = (result[entry.code] ?? 0) + 1;
    return result;
  }, {});
  const health = (counts.critical ?? 0) > 0 ? "blocked" : (counts.warning ?? 0) > 0 ? "attention" : "healthy";
  return {
    generatedAt: new Date().toISOString(),
    health,
    status: governanceStatusSummary({ activeIssueCount: active.length, executionQueue, findings }),
    currentIssueId: focus?.id,
    currentIssueTitle: focus?.title,
    activeIssueCount: active.length,
    archivedIssueCount: archived.length,
    executionQueue,
    findings,
    counts,
  };
}

export function reconcileProjectGovernance(repoRoot: string): ReconcileResult {
  const changes: ReconcileResult["changes"] = [];
  const issues = listIssues(repoRoot);
  const runs = listAgentJobs(repoRoot, 2000);
  const byId = new Map(runs.map((run) => [run.runId, run]));

  for (const issue of issues.filter((entry) => !entry.archivedAt)) {
    const issueStates = resolveIssueTaskStates(issue, readIssueRunEvidence(repoRoot, issue));
    for (const task of issue.tasks) {
      const state = issueStates.get(task.id)!;
      if (state.terminal || state.inactive) continue;
      let nextDependencies = task.dependsOn.slice();
      let dependencyChanged = false;
      for (const dependencyId of task.dependsOn) {
        const dependency = issue.tasks.find((candidate) => candidate.id === dependencyId);
        if (dependency?.status === "superseded" && (dependency.supersededBy?.length ?? 0) > 0) {
          nextDependencies = nextDependencies.flatMap((value) => value === dependencyId ? dependency.supersededBy ?? [] : [value]);
          dependencyChanged = true;
        }
      }
      if (dependencyChanged) {
        nextDependencies = Array.from(new Set(nextDependencies));
        setTaskDependencies(repoRoot, issue.id, task.id, nextDependencies);
        changes.push({ issueId: issue.id, taskId: task.id, action: "repair_dependency", summary: `Replaced superseded dependencies for ${task.id}.` });
      }
      const latestRunId = state.latestRunId;
      const latestRunStatus = state.latestRunStatus;
      if (latestRunId && latestRunStatus === "succeeded" && task.status === "running") {
        updateTask(repoRoot, issue.id, task.id, {
          status: "review",
          transition: "run_sync",
          note: `${latestRunId} succeeded; Task moved to review by explicit governance reconciliation.`,
        });
        changes.push({ issueId: issue.id, taskId: task.id, action: "review_after_run", summary: `Moved ${task.id} to review after succeeded Run.` });
      } else if (
        latestRunId &&
        latestRunStatus === "succeeded" &&
        task.status === "blocked" &&
        hasGovernanceRetryBlocker(task)
      ) {
        updateTask(repoRoot, issue.id, task.id, {
          status: "review",
          transition: "run_sync",
          note: `${latestRunId} succeeded after an earlier retry-required failure; stale governance blocker was cleared and the Task returned to review.`,
        });
        changes.push({ issueId: issue.id, taskId: task.id, action: "clear_stale_failed_run_blocker", summary: `Returned ${task.id} to review after a later succeeded Run superseded an older retry blocker.` });
      } else if (latestRunId && latestRunStatus && ["failed", "unknown", "cancelled"].includes(latestRunStatus) && ["backlog", "analysis", "planned", "ready", "running", "launch_blocked"].includes(task.status)) {
        updateTask(repoRoot, issue.id, task.id, {
          status: "blocked",
          transition: "run_sync",
          note: `${latestRunId} remains recorded as ${latestRunStatus}; explicit retry is required and no new Run was created.`,
        });
        changes.push({ issueId: issue.id, taskId: task.id, action: "block_after_run", summary: `Blocked ${task.id} after ${latestRunStatus} Run; explicit retry required.` });
      }
      if (shouldAutoAcceptVerifiedTask(task)) {
        acceptVerifiedTask(repoRoot, issue.id, task.id, "Accepted during governance reconciliation because policy auto-completes verified work for this Task.");
        changes.push({ issueId: issue.id, taskId: task.id, action: "auto_accept_verified_task", summary: `Closed ${task.id} because existing verification already satisfies the current auto-complete policy.` });
      }
    }
    const refreshed = getIssue(repoRoot, issue.id);
    const refreshedStates = resolveIssueTaskStates(refreshed, readIssueRunEvidence(repoRoot, refreshed));
    const nonSuperseded = refreshed.tasks.filter((task) => !["superseded", "cancelled"].includes(refreshedStates.get(task.id)!.effectiveStatus));
    if (nonSuperseded.length > 0 && nonSuperseded.every((task) => refreshedStates.get(task.id)!.effectiveStatus === "done") && refreshed.status !== "done") {
      updateIssue(repoRoot, refreshed.id, { status: "done" });
      changes.push({ issueId: refreshed.id, action: "close_issue", summary: `Closed ${refreshed.id} because all active Tasks are done.` });
    }
  }

  const state = loadControllerProjectState(repoRoot);
  const allCurrentIssues = listIssues(repoRoot);
  const currentIssues = activeIssues(allCurrentIssues);
  const focused = state.currentIssueId ? currentIssues.find((issue) => issue.id === state.currentIssueId) : undefined;
  if (state.currentIssueId && !focused) {
    clearCurrentIssue(repoRoot, "governance-reconciler");
    changes.push({ issueId: state.currentIssueId, action: "clear_focus", summary: `Cleared terminal or archived execution focus ${state.currentIssueId}.` });
  }
  if (currentIssues.length === 1 && (!focused || state.currentIssueId !== currentIssues[0].id)) {
    saveControllerProjectState(repoRoot, { currentIssueId: currentIssues[0].id }, "governance-reconciler");
    changes.push({ issueId: currentIssues[0].id, action: "set_focus", summary: `Selected ${currentIssues[0].id} as the only active Issue.` });
  }

  if (changes.length > 0) {
    tryAppendControllerWorklogEvent(repoRoot, {
      category: "system",
      action: "governance_reconciled",
      summary: `Applied ${changes.length} safe governance repair(s).`,
      actor: "governance-reconciler",
      details: { changes },
    });
  }
  return { changed: changes.length > 0, changes, governance: inspectProjectGovernance(repoRoot) };
}

export function archiveTerminalIssue(repoRoot: string, issueId: string): ControllerIssue {
  return archiveIssue(repoRoot, issueId);
}
