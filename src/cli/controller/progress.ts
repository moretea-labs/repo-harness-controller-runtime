import { getAgentJobEvents, listAgentJobs } from "../agent-jobs/job-manager";
import type { AgentJobMeta } from "../agent-jobs/types";
import { getIssue, listIssues } from "./issue-store";
import { loadControllerProjectState } from "./project-state";
import type { ControllerIssue, ControllerTask, TaskStatus } from "./types";
import {
  listControllerWorklogEvents,
  type ControllerWorklogEvent,
  type WorklogFilter,
} from "./worklog";

const TERMINAL_TASKS = new Set<TaskStatus>(["done", "cancelled", "superseded"]);
const ACTIVE_RUNS = new Set(["queued", "running", "waiting_for_user"]);
const FAILED_RUNS = new Set(["failed", "unknown", "cancelled"]);

export type EvidenceGateState = "pending" | "in_progress" | "passed" | "failed" | "not_required";

export interface EvidenceGate {
  state: EvidenceGateState;
  label: string;
  evidence?: string;
}

export interface TaskCompletionEvidence {
  execution: EvidenceGate;
  integration: EvidenceGate;
  checks: EvidenceGate;
  acceptance: EvidenceGate;
  closure: EvidenceGate;
  completedGates: number;
  totalGates: number;
  summary: string;
}

export interface TaskProgressSnapshot {
  issueId: string;
  taskId: string;
  title: string;
  objective: string;
  status: TaskStatus;
  effectiveStatus: string;
  percent: number;
  completion: TaskCompletionEvidence;
  latestRunId?: string;
  latestRunStatus?: string;
  currentActivity?: string;
  lastActivityAt: string;
  elapsedMs?: number | null;
  runCount: number;
  notesCount: number;
  blockedBy: string[];
  risk: string;
  agent: string;
  verification: "not_started" | "pending" | "passed" | "changes_requested";
  githubUrl?: string;
}

export interface IssueProgressSnapshot {
  id: string;
  title: string;
  kind: string;
  status: string;
  percent: number;
  completedGates: number;
  totalGates: number;
  completedTasks: number;
  actionableTaskCount: number;
  activeTaskCount: number;
  totalTasks: number;
  taskCounts: Record<string, number>;
  attentionCount: number;
  currentTask?: TaskProgressSnapshot;
  updatedAt: string;
  githubUrl?: string;
  archivedAt?: string;
  isCurrent: boolean;
  tasks: TaskProgressSnapshot[];
}

export interface ProgressAttentionItem {
  severity: "warning" | "critical";
  type: "failed_run" | "blocked_task" | "changes_requested" | "stale_run" | "approval" | "governance";
  message: string;
  issueId?: string;
  taskId?: string;
  runId?: string;
  at: string;
}

export interface ProjectProgressSnapshot {
  generatedAt: string;
  overallPercent: number;
  completedGates: number;
  totalGates: number;
  issueCount: number;
  activeIssueCount: number;
  archivedIssueCount: number;
  taskCount: number;
  activeRunCount: number;
  completedTaskCount: number;
  currentIssueId?: string;
  totals: Record<string, number>;
  throughput: {
    completedLast24Hours: number;
    completedLast7Days: number;
    averageCycleTimeMs: number | null;
  };
  issues: IssueProgressSnapshot[];
  archivedIssues: IssueProgressSnapshot[];
  attention: ProgressAttentionItem[];
}

export interface ControllerTimelineEvent {
  id: string;
  at: string;
  category: string;
  action: string;
  summary: string;
  actor: string;
  issueId?: string;
  taskId?: string;
  runId?: string;
  jobId?: string;
  editSessionId?: string;
  details?: Record<string, unknown>;
}

function runById(runs: AgentJobMeta[]): Map<string, AgentJobMeta> {
  return new Map(runs.map((run) => [run.runId, run]));
}

function latestRun(task: ControllerTask, byId: Map<string, AgentJobMeta>): AgentJobMeta | undefined {
  for (const id of task.runIds.slice().reverse()) {
    const run = byId.get(id);
    if (run) return run;
  }
  return undefined;
}

function effectiveStatus(task: ControllerTask, run?: AgentJobMeta): string {
  if (run?.status === "running" || run?.status === "queued") return run.status;
  if (run?.status === "waiting_for_user") return "needs_attention";
  if (run && FAILED_RUNS.has(run.status) && task.status === "ready") return "retry_ready";
  if (run && FAILED_RUNS.has(run.status) && !["done", "verified", "cancelled", "superseded"].includes(task.status)) return "run_failed";
  return task.status;
}

function taskVerification(task: ControllerTask): TaskProgressSnapshot["verification"] {
  if (task.status === "changes_requested") return "changes_requested";
  if (task.verification && ["verified", "done"].includes(task.status)) return "passed";
  if (["review", "integrated", "verifying"].includes(task.status)) return "pending";
  return "not_started";
}

function gate(label: string, state: EvidenceGateState, evidence?: string): EvidenceGate {
  return { label, state, evidence };
}

function completionEvidence(task: ControllerTask, run?: AgentJobMeta): TaskCompletionEvidence {
  const execution = !run
    ? gate("Implementation Run", "pending")
    : ["queued", "running", "waiting_for_user"].includes(run.status)
      ? gate("Implementation Run", "in_progress", run.runId)
      : run.status === "succeeded"
        ? gate("Implementation Run", "passed", run.runId)
        : gate("Implementation Run", "failed", `${run.runId}: ${run.status}`);

  let integration: EvidenceGate;
  if (!run || run.status !== "succeeded") integration = gate("Change Integration", "pending");
  else if (run.provider === "github") {
    if (run.github?.createPullRequest === false) {
      integration = gate("Change Integration", "not_required", "Cloud Run did not require a pull request.");
    } else if (run.github?.pullRequestUrl && ["verified", "done"].includes(task.status)) {
      integration = gate("Change Integration", "passed", run.github.pullRequestUrl);
    } else if (run.github?.pullRequestUrl) {
      integration = gate("Change Integration", "in_progress", run.github.pullRequestUrl);
    } else {
      integration = gate("Change Integration", "pending", "Cloud Run is awaiting a pull request.");
    }
  }
  else if (run.worktree === run.repoRoot) integration = gate("Change Integration", "not_required", "Run used the current workspace.");
  else if (run.integratedSessionId) integration = gate("Change Integration", "passed", run.integratedSessionId);
  else if (run.autoIntegrationError) integration = gate("Change Integration", "failed", run.autoIntegrationError);
  else integration = gate("Change Integration", "pending", "Successful isolated Run is awaiting integration.");

  const verification = task.verification;
  const declaredChecksPassed = verification && (task.checks.length > 0
    ? task.checks.every((checkId) => verification.checkResults.some((entry) => entry.checkId === checkId && entry.ok))
    : verification.checkResults.length > 0 && verification.checkResults.every((entry) => entry.ok));
  const checks = !verification
    ? gate("Named Checks", "pending")
    : declaredChecksPassed
      ? gate("Named Checks", "passed", `${verification.checkResults.length} persisted check result(s) passed.`)
      : gate("Named Checks", "failed", "One or more declared checks are missing or failed.");
  const declaredAcceptancePassed = verification && (task.acceptanceCriteria.length === 0
    ? true
    : task.acceptanceCriteria.every((criterion) => verification.acceptanceResults.some((entry) => entry.criterion === criterion && entry.ok)));
  const acceptance = !verification
    ? gate("Acceptance Criteria", "pending")
    : task.acceptanceCriteria.length === 0
      ? gate("Acceptance Criteria", "not_required", "No Task-level acceptance criteria were declared.")
      : declaredAcceptancePassed
        ? gate("Acceptance Criteria", "passed", `${verification.acceptanceResults.length} criterion result(s) recorded.`)
        : gate("Acceptance Criteria", "failed", "One or more declared acceptance criteria are missing or failed.");
  const closure = task.status === "done"
    ? gate("Human Acceptance", "passed", "Task accepted and closed.")
    : task.status === "verified"
      ? gate("Human Acceptance", "in_progress", "Verification passed; explicit acceptance is still required.")
      : gate("Human Acceptance", "pending");

  const gates = [execution, integration, checks, acceptance, closure];
  const completedGates = gates.filter((entry) => entry.state === "passed" || entry.state === "not_required").length;
  return {
    execution,
    integration,
    checks,
    acceptance,
    closure,
    completedGates,
    totalGates: gates.length,
    summary: `${completedGates}/${gates.length} evidence gates complete`,
  };
}

function taskProgress(issue: ControllerIssue, task: ControllerTask, byId: Map<string, AgentJobMeta>): TaskProgressSnapshot {
  const run = latestRun(task, byId);
  const unresolvedDependencies = task.dependsOn.filter((id) => {
    const dependency = issue.tasks.find((candidate) => candidate.id === id);
    return dependency && dependency.status !== "done";
  });
  const completion = completionEvidence(task, run);
  return {
    issueId: issue.id,
    taskId: task.id,
    title: task.title,
    objective: task.objective,
    status: task.status,
    effectiveStatus: effectiveStatus(task, run),
    percent: Math.round((completion.completedGates / completion.totalGates) * 100),
    completion,
    latestRunId: run?.runId,
    latestRunStatus: run?.status,
    currentActivity: run?.progress?.currentActivity ?? task.notes.at(-1),
    lastActivityAt: run?.progress?.lastActivityAt ?? run?.finishedAt ?? run?.createdAt ?? task.updatedAt,
    elapsedMs: run?.timing?.elapsedMs,
    runCount: task.runIds.length,
    notesCount: task.notes.length,
    blockedBy: unresolvedDependencies,
    risk: task.risk,
    agent: task.recommendedAgent,
    verification: taskVerification(task),
    githubUrl: task.github?.url,
  };
}

function issueProgress(issue: ControllerIssue, byId: Map<string, AgentJobMeta>, currentIssueId?: string): IssueProgressSnapshot {
  const tasks = issue.tasks.map((task) => taskProgress(issue, task, byId));
  const counted = tasks.filter((task) => !["cancelled", "superseded"].includes(task.status));
  const completedGates = counted.reduce((sum, task) => sum + task.completion.completedGates, 0);
  const totalGates = counted.reduce((sum, task) => sum + task.completion.totalGates, 0);
  const taskCounts = issue.tasks.reduce<Record<string, number>>((result, task) => {
    result[task.status] = (result[task.status] ?? 0) + 1;
    return result;
  }, {});
  const attention = tasks.filter((task) => ["blocked", "changes_requested", "launch_blocked", "run_failed", "retry_ready"].includes(task.effectiveStatus));
  const currentTask = tasks
    .filter((task) => ["running", "queued", "needs_attention", "review", "integrated", "verifying", "verified", "retry_ready"].includes(task.effectiveStatus))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
  return {
    id: issue.id,
    title: issue.title,
    kind: issue.kind,
    status: issue.status,
    percent: totalGates ? Math.round((completedGates / totalGates) * 100) : issue.status === "done" ? 100 : 0,
    completedGates,
    totalGates,
    completedTasks: counted.filter((task) => task.status === "done").length,
    actionableTaskCount: counted.filter((task) => ["ready", "changes_requested", "review", "integrated", "verifying", "verified"].includes(task.status)).length,
    activeTaskCount: counted.filter((task) => !TERMINAL_TASKS.has(task.status)).length,
    totalTasks: counted.length,
    taskCounts,
    attentionCount: attention.length,
    currentTask,
    updatedAt: issue.updatedAt,
    githubUrl: issue.github?.url,
    archivedAt: issue.archivedAt,
    isCurrent: issue.id === currentIssueId,
    tasks,
  };
}

export function getProjectProgress(repoRoot: string): ProjectProgressSnapshot {
  const now = Date.now();
  const allIssues = listIssues(repoRoot);
  const state = loadControllerProjectState(repoRoot);
  const runs = listAgentJobs(repoRoot, 1000);
  const byId = runById(runs);
  const views = allIssues.map((issue) => issueProgress(issue, byId, state.currentIssueId));
  const issues = views.filter((issue) => !issue.archivedAt);
  const archivedIssues = views.filter((issue) => Boolean(issue.archivedAt));
  const totals: Record<string, number> = {};
  for (const issue of allIssues) for (const task of issue.tasks) totals[task.status] = (totals[task.status] ?? 0) + 1;
  const countedTasks = issues.flatMap((issue) => issue.tasks).filter((task) => !["cancelled", "superseded"].includes(task.status));
  const completedGates = countedTasks.reduce((sum, task) => sum + task.completion.completedGates, 0);
  const totalGates = countedTasks.reduce((sum, task) => sum + task.completion.totalGates, 0);
  const completed = allIssues.flatMap((issue) => issue.tasks).filter((task) => task.status === "done");
  const completedLast24Hours = completed.filter((task) => now - Date.parse(task.updatedAt) <= 86_400_000).length;
  const completedLast7Days = completed.filter((task) => now - Date.parse(task.updatedAt) <= 7 * 86_400_000).length;
  const cycleTimes = completed.map((task) => Date.parse(task.updatedAt) - Date.parse(task.createdAt)).filter((value) => Number.isFinite(value) && value >= 0);
  const attention: ProgressAttentionItem[] = [];

  for (const issue of allIssues.filter((entry) => !entry.archivedAt)) {
    for (const task of issue.tasks) {
      const run = latestRun(task, byId);
      if (run && ["failed", "unknown"].includes(run.status) && !["done", "cancelled", "superseded"].includes(task.status)) {
        attention.push({ severity: task.status === "ready" ? "warning" : "critical", type: "failed_run", message: task.status === "ready" ? `${run.runId} failed; Task is retryable.` : run.error || run.progress?.currentActivity || `Run ${run.status}`, issueId: issue.id, taskId: task.id, runId: run.runId, at: run.finishedAt ?? run.createdAt });
      }
      if (run && ACTIVE_RUNS.has(run.status) && run.lastHeartbeatAt && now - Date.parse(run.lastHeartbeatAt) > 10 * 60_000) {
        attention.push({ severity: "warning", type: "stale_run", message: "Run has not emitted a heartbeat for more than 10 minutes.", issueId: issue.id, taskId: task.id, runId: run.runId, at: run.lastHeartbeatAt });
      }
      if (task.status === "blocked" || task.status === "launch_blocked") attention.push({ severity: task.status === "blocked" ? "critical" : "warning", type: "blocked_task", message: task.notes.at(-1) || `${task.title} is ${task.status}.`, issueId: issue.id, taskId: task.id, at: task.updatedAt });
      if (task.status === "changes_requested") attention.push({ severity: "warning", type: "changes_requested", message: task.notes.at(-1) || `${task.title} requires changes.`, issueId: issue.id, taskId: task.id, at: task.updatedAt });
      if (task.status === "verified") attention.push({ severity: "warning", type: "approval", message: `${task.title} passed verification and is waiting for explicit acceptance.`, issueId: issue.id, taskId: task.id, at: task.updatedAt });
    }
  }
  attention.sort((a, b) => b.at.localeCompare(a.at));
  return {
    generatedAt: new Date().toISOString(),
    overallPercent: totalGates ? Math.round((completedGates / totalGates) * 100) : 0,
    completedGates,
    totalGates,
    issueCount: allIssues.length,
    activeIssueCount: allIssues.filter((issue) => !issue.archivedAt && !["done", "cancelled"].includes(issue.status)).length,
    archivedIssueCount: archivedIssues.length,
    taskCount: allIssues.reduce((sum, issue) => sum + issue.tasks.length, 0),
    activeRunCount: runs.filter((run) => ACTIVE_RUNS.has(run.status)).length,
    completedTaskCount: completed.length,
    currentIssueId: state.currentIssueId,
    totals,
    throughput: {
      completedLast24Hours,
      completedLast7Days,
      averageCycleTimeMs: cycleTimes.length ? Math.round(cycleTimes.reduce((sum, value) => sum + value, 0) / cycleTimes.length) : null,
    },
    issues,
    archivedIssues,
    attention: attention.slice(0, 100),
  };
}

function worklogToTimeline(event: ControllerWorklogEvent): ControllerTimelineEvent {
  return {
    id: event.id,
    at: event.at,
    category: event.category,
    action: event.action,
    summary: event.summary,
    actor: event.actor,
    issueId: event.issueId,
    taskId: event.taskId,
    runId: event.runId,
    jobId: event.jobId,
    editSessionId: event.editSessionId,
    details: event.details,
  };
}

export function getControllerTimeline(
  repoRoot: string,
  filter: WorklogFilter = {},
): ControllerTimelineEvent[] {
  const worklog = listControllerWorklogEvents(repoRoot, { ...filter, limit: Math.max(filter.limit ?? 200, 500) }).map(worklogToTimeline);
  const synthetic: ControllerTimelineEvent[] = [];
  const runs = listAgentJobs(repoRoot, 500);
  for (const run of runs) {
    if (filter.issueId && run.issueId !== filter.issueId) continue;
    if (filter.taskId && run.taskId !== filter.taskId) continue;
    if (filter.runId && run.runId !== filter.runId) continue;
    for (const event of getAgentJobEvents(repoRoot, run.runId, 1000)) {
      synthetic.push({
        id: `${run.runId}:${event.at}:${event.type}`,
        at: event.at,
        category: "run",
        action: event.type,
        summary: event.message || event.type,
        actor: run.agent,
        issueId: run.issueId,
        taskId: run.taskId,
        runId: run.runId,
        details: event.data,
      });
    }
  }
  const issues = listIssues(repoRoot);
  for (const issue of issues) {
    if (filter.issueId && issue.id !== filter.issueId) continue;
    synthetic.push({ id: `${issue.id}:created`, at: issue.createdAt, category: "issue", action: "issue_created", summary: issue.title, actor: "repo-harness-controller", issueId: issue.id });
    if (issue.archivedAt) synthetic.push({ id: `${issue.id}:archived`, at: issue.archivedAt, category: "issue", action: "issue_archived", summary: issue.title, actor: "repo-harness-controller", issueId: issue.id });
    for (const task of issue.tasks) {
      if (filter.taskId && task.id !== filter.taskId) continue;
      synthetic.push({ id: `${issue.id}:${task.id}:created`, at: task.createdAt, category: "task", action: "task_created", summary: task.title, actor: "repo-harness-controller", issueId: issue.id, taskId: task.id });
      if (task.verification) synthetic.push({ id: `${issue.id}:${task.id}:verified:${task.verification.verifiedAt}`, at: task.verification.verifiedAt, category: "verification", action: task.status === "verified" ? "verification_passed" : "verification_recorded", summary: `${task.title}: ${task.status}`, actor: task.verification.reviewer, issueId: issue.id, taskId: task.id, runId: task.verification.runId });
    }
  }
  const seen = new Set<string>();
  return [...worklog, ...synthetic]
    .filter((event) => {
      const key = `${event.category}|${event.action}|${event.at}|${event.issueId ?? ""}|${event.taskId ?? ""}|${event.runId ?? ""}|${event.editSessionId ?? ""}|${event.summary}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (filter.since && event.at < filter.since) return false;
      if (filter.until && event.at > filter.until) return false;
      return true;
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, Math.max(1, Math.min(filter.limit ?? 200, 5000)));
}

export function getTaskProgressDetail(repoRoot: string, issueId: string, taskId: string): {
  issue: Pick<ControllerIssue, "id" | "title" | "status" | "github" | "archivedAt">;
  task: ControllerTask;
  progress: TaskProgressSnapshot;
  runs: AgentJobMeta[];
  timeline: ControllerTimelineEvent[];
} {
  const issue = getIssue(repoRoot, issueId);
  const task = issue.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`task not found: ${issueId}/${taskId}`);
  const runs = listAgentJobs(repoRoot, 1000).filter((run) => run.issueId === issueId && run.taskId === taskId);
  return {
    issue: { id: issue.id, title: issue.title, status: issue.status, github: issue.github, archivedAt: issue.archivedAt },
    task,
    progress: taskProgress(issue, task, runById(runs)),
    runs,
    timeline: getControllerTimeline(repoRoot, { issueId, taskId, limit: 300 }),
  };
}
