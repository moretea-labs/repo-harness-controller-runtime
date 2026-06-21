import { listAgentJobs } from "../agent-jobs/job-manager";
import type { AgentJobMeta } from "../agent-jobs/types";
import {
  archiveIssue,
  getIssue,
  listIssues,
  setTaskDependencies,
  updateIssue,
  updateTask,
} from "./issue-store";
import { clearCurrentIssue, loadControllerProjectState, saveControllerProjectState } from "./project-state";
import type { ControllerIssue, ControllerTask } from "./types";
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

const ISSUE_TERMINAL = new Set(["done", "cancelled"]);
const TASK_TERMINAL = new Set(["done", "cancelled", "superseded"]);
const RUN_FAILED = new Set(["failed", "unknown"]);

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

function taskQueueItem(issue: ControllerIssue, task: ControllerTask, run?: AgentJobMeta): ExecutionQueueItem | undefined {
  if (task.status === "ready" || task.status === "changes_requested") {
    return {
      issueId: issue.id,
      issueTitle: issue.title,
      taskId: task.id,
      taskTitle: task.title,
      agent: task.recommendedAgent,
      risk: task.risk,
      latestRunId: run?.runId,
      latestRunStatus: run?.status,
      action: run && RUN_FAILED.has(run.status) ? "retry" : "launch",
    };
  }
  if (task.status === "review" || task.status === "integrated" || task.status === "verifying") {
    return {
      issueId: issue.id,
      issueTitle: issue.title,
      taskId: task.id,
      taskTitle: task.title,
      agent: task.recommendedAgent,
      risk: task.risk,
      latestRunId: run?.runId,
      latestRunStatus: run?.status,
      action: "review",
    };
  }
  if (task.status === "verified") {
    return {
      issueId: issue.id,
      issueTitle: issue.title,
      taskId: task.id,
      taskTitle: task.title,
      agent: task.recommendedAgent,
      risk: task.risk,
      latestRunId: run?.runId,
      latestRunStatus: run?.status,
      action: "accept",
    };
  }
  if (task.status === "launch_blocked" || task.status === "blocked") {
    return {
      issueId: issue.id,
      issueTitle: issue.title,
      taskId: task.id,
      taskTitle: task.title,
      agent: task.recommendedAgent,
      risk: task.risk,
      latestRunId: run?.runId,
      latestRunStatus: run?.status,
      action: "unblock",
    };
  }
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

  const focus = state.currentIssueId ? issues.find((issue) => issue.id === state.currentIssueId) : undefined;
  if (!focus && active.length > 1) {
    findings.push({
      id: findingId("CURRENT_ISSUE_MISSING"),
      code: "CURRENT_ISSUE_MISSING",
      severity: "critical",
      message: `${active.length} active Issues exist but no current execution focus is selected.`,
      recommendedAction: "set_focus",
      autoFixable: false,
    });
  }
  if (focus && (focus.archivedAt || ISSUE_TERMINAL.has(focus.status))) {
    findings.push({
      id: findingId("CURRENT_ISSUE_TERMINAL", focus.id),
      code: "CURRENT_ISSUE_TERMINAL",
      severity: "critical",
      message: `Current Issue ${focus.id} is terminal or archived and cannot drive execution.`,
      issueId: focus.id,
      recommendedAction: "set_focus",
      autoFixable: true,
    });
  }
  if (active.length > 1) {
    findings.push({
      id: findingId("MULTIPLE_ACTIVE_ISSUES"),
      code: "MULTIPLE_ACTIVE_ISSUES",
      severity: "warning",
      message: `${active.length} active Issues are mixed together. Only the current Issue should drive the execution queue.`,
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
    const nonSuperseded = issue.tasks.filter((task) => !["superseded", "cancelled"].includes(task.status));
    if (nonSuperseded.length > 0 && nonSuperseded.every((task) => task.status === "done") && issue.status !== "done") {
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
      if (TASK_TERMINAL.has(task.status)) continue;
      const run = latestRun(task, byId);
      const cancelledDeps = task.dependsOn.filter((dependencyId) => issue.tasks.find((candidate) => candidate.id === dependencyId)?.status === "cancelled");
      const staleSupersededDeps = task.dependsOn.filter((dependencyId) => {
        const dependency = issue.tasks.find((candidate) => candidate.id === dependencyId);
        return dependency?.status === "superseded" && (dependency.supersededBy?.length ?? 0) > 0;
      });
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
      if (run && RUN_FAILED.has(run.status) && ["blocked", "launch_blocked"].includes(task.status)) {
        findings.push({
          id: findingId("FAILED_RUN_BLOCKED_TASK", issue.id, task.id),
          code: "FAILED_RUN_BLOCKED_TASK",
          severity: "warning",
          message: `${task.id} is permanently blocked by a failed Run. The failed attempt should remain history while the Task returns to a retryable state.`,
          issueId: issue.id,
          taskId: task.id,
          runId: run.runId,
          recommendedAction: "retry_task",
          autoFixable: true,
        });
      }
      if (["ready", "changes_requested", "review", "integrated", "verifying", "verified", "running"].includes(task.status)) hasActionableTask = true;
      if (task.status === "review") {
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
      if (task.status === "verified") {
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

  const queueIssue = focus && !focus.archivedAt && !ISSUE_TERMINAL.has(focus.status)
    ? focus
    : active.length === 1 ? active[0] : undefined;
  const executionQueue = queueIssue
    ? queueIssue.tasks
      .map((task) => taskQueueItem(queueIssue, task, latestRun(task, byId)))
      .filter((entry): entry is ExecutionQueueItem => Boolean(entry))
    : [];

  const counts = findings.reduce<Record<string, number>>((result, entry) => {
    result[entry.severity] = (result[entry.severity] ?? 0) + 1;
    result[entry.code] = (result[entry.code] ?? 0) + 1;
    return result;
  }, {});
  const health = (counts.critical ?? 0) > 0 ? "blocked" : (counts.warning ?? 0) > 0 ? "attention" : "healthy";
  return {
    generatedAt: new Date().toISOString(),
    health,
    currentIssueId: queueIssue?.id,
    currentIssueTitle: queueIssue?.title,
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
    for (const task of issue.tasks) {
      if (TASK_TERMINAL.has(task.status)) continue;
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
      const run = latestRun(task, byId);
      if (run && RUN_FAILED.has(run.status) && ["blocked", "launch_blocked"].includes(task.status)) {
        updateTask(repoRoot, issue.id, task.id, {
          status: "ready",
          note: `${run.runId} remains recorded as a failed attempt; Task returned to ready for retry.`,
        });
        changes.push({ issueId: issue.id, taskId: task.id, action: "restore_retryable", summary: `Returned ${task.id} to ready after failed Run.` });
      }
    }
    const refreshed = getIssue(repoRoot, issue.id);
    const nonSuperseded = refreshed.tasks.filter((task) => !["superseded", "cancelled"].includes(task.status));
    if (nonSuperseded.length > 0 && nonSuperseded.every((task) => task.status === "done") && refreshed.status !== "done") {
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
