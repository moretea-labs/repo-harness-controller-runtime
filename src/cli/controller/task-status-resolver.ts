import type { AgentJobMeta, AgentJobStatus } from "../agent-jobs/types";
import type { ControllerIssue, ControllerTask, TaskStatus } from "./types";

export type IssueLifecycleStatus = "active" | "completed" | "cancelled" | "archived";

export type EffectiveTaskStatus =
  | TaskStatus
  | "queued"
  | "waiting_for_user"
  | "cancelled_by_parent"
  | "archived_by_parent"
  | "inactive_by_parent";

export type EffectiveTaskStateReason =
  | "issue_archived"
  | "issue_cancelled"
  | "issue_completed"
  | "declared_done"
  | "declared_cancelled"
  | "declared_superseded"
  | "superseded_by_relation"
  | "active_run_queued"
  | "active_run_running"
  | "active_run_waiting_for_user"
  | "declared_status";

export type VerificationStatus =
  | "not_started"
  | "pending"
  | "passed"
  | "changes_requested";

export interface HistoricalRunOutcome {
  runId: string;
  status: AgentJobStatus;
  finishedAt?: string;
}

export interface RunEvidenceAggregate {
  latestRun?: AgentJobMeta;
  currentActiveRun?: AgentJobMeta;
  activeRuns: AgentJobMeta[];
  historicalOutcomes: HistoricalRunOutcome[];
  multipleActiveRuns: boolean;
}

export interface EffectiveTaskState {
  taskId: string;
  declaredStatus: TaskStatus;
  effectiveStatus: EffectiveTaskStatus;
  reason: EffectiveTaskStateReason;
  issueLifecycleStatus: IssueLifecycleStatus;
  latestRunId?: string;
  latestRunStatus?: AgentJobStatus;
  activeRunId?: string;
  activeRunStatus?: AgentJobStatus;
  activeRunIds: string[];
  historicalRunOutcomes: HistoricalRunOutcome[];
  verificationStatus: VerificationStatus;
  replacementTaskIds: string[];
  terminal: boolean;
  inactive: boolean;
  dispatchable: boolean;
  retryable: boolean;
  requiresExplicitRetry: boolean;
  dependencySatisfied: boolean;
  multipleActiveRuns: boolean;
}

export interface SupersededDependencyMigration {
  dependencyTaskId: string;
  replacementTaskIds: string[];
}

export interface TaskDependencyState {
  ready: boolean;
  pendingTaskIds: string[];
  cancelledTaskIds: string[];
  missingTaskIds: string[];
  supersededMigrations: SupersededDependencyMigration[];
  migratedDependsOn: string[];
}

const EXPLICIT_TERMINAL = new Set<TaskStatus>(["done", "cancelled", "superseded"]);
const ACTIVE_RUN = new Set<AgentJobStatus>(["queued", "running", "waiting_for_user"]);
const RETRYABLE_RUN = new Set<AgentJobStatus>(["failed", "cancelled", "unknown"]);

function runTimestamp(run: AgentJobMeta): number {
  const parsed = Date.parse(run.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function orderedTaskRuns(task: ControllerTask, runs: readonly AgentJobMeta[]): AgentJobMeta[] {
  const taskRuns = runs.filter((run) => run.issueId === undefined || run.taskId === task.id);
  const byId = new Map(taskRuns.map((run) => [run.runId, run]));
  const ordered: AgentJobMeta[] = [];
  const seen = new Set<string>();

  for (const runId of task.runIds) {
    const run = byId.get(runId);
    if (!run || seen.has(runId)) continue;
    seen.add(runId);
    ordered.push(run);
  }

  const unlinked = taskRuns
    .filter((run) => !seen.has(run.runId))
    .sort((left, right) => runTimestamp(left) - runTimestamp(right));
  ordered.push(...unlinked);
  return ordered;
}

export function aggregateRunEvidence(
  task: ControllerTask,
  runs: readonly AgentJobMeta[] = [],
): RunEvidenceAggregate {
  const ordered = orderedTaskRuns(task, runs);
  const latestRun = ordered.at(-1);
  const activeRuns = ordered.filter((run) => ACTIVE_RUN.has(run.status));
  const historicalOutcomes = ordered
    .filter((run) => !ACTIVE_RUN.has(run.status))
    .map((run) => ({ runId: run.runId, status: run.status, finishedAt: run.finishedAt }));
  return {
    latestRun,
    // Only the latest linked Run can be the current lifecycle owner. Older
    // queued/running metadata is stale evidence and must not resurrect a Task.
    currentActiveRun: latestRun && ACTIVE_RUN.has(latestRun.status) ? latestRun : undefined,
    activeRuns,
    historicalOutcomes,
    multipleActiveRuns: activeRuns.length > 1,
  };
}

export function resolveIssueLifecycleStatus(issue: ControllerIssue): IssueLifecycleStatus {
  if (issue.archivedAt) return "archived";
  if (issue.status === "cancelled") return "cancelled";
  if (issue.status === "done") return "completed";
  return "active";
}

function resolveVerificationStatus(task: ControllerTask): VerificationStatus {
  if (task.status === "changes_requested") return "changes_requested";
  if (task.verification && ["verified", "done"].includes(task.status)) return "passed";
  if (["review", "integrated", "verifying", "verified"].includes(task.status)) return "pending";
  return "not_started";
}

function baseState(
  issue: ControllerIssue,
  task: ControllerTask,
  evidence: RunEvidenceAggregate,
): Omit<EffectiveTaskState, "effectiveStatus" | "reason" | "terminal" | "inactive" | "dispatchable" | "retryable" | "requiresExplicitRetry" | "dependencySatisfied"> {
  return {
    taskId: task.id,
    declaredStatus: task.status,
    issueLifecycleStatus: resolveIssueLifecycleStatus(issue),
    latestRunId: evidence.latestRun?.runId,
    latestRunStatus: evidence.latestRun?.status,
    activeRunId: evidence.currentActiveRun?.runId,
    activeRunStatus: evidence.currentActiveRun?.status,
    activeRunIds: evidence.activeRuns.map((run) => run.runId),
    historicalRunOutcomes: evidence.historicalOutcomes,
    verificationStatus: resolveVerificationStatus(task),
    replacementTaskIds: [...(task.supersededBy ?? [])],
    multipleActiveRuns: evidence.multipleActiveRuns,
  };
}

function finalizeState(
  base: ReturnType<typeof baseState>,
  effectiveStatus: EffectiveTaskStatus,
  reason: EffectiveTaskStateReason,
  terminal: boolean,
  inactive: boolean,
): EffectiveTaskState {
  const latestRunStatus = base.latestRunStatus;
  const requiresExplicitRetry =
    latestRunStatus !== undefined && RETRYABLE_RUN.has(latestRunStatus);
  const dispatchable =
    !terminal &&
    !inactive &&
    base.activeRunIds.length === 0 &&
    !requiresExplicitRetry &&
    (effectiveStatus === "ready" || effectiveStatus === "changes_requested");
  const retryable =
    !terminal &&
    !inactive &&
    base.replacementTaskIds.length === 0 &&
    base.activeRunIds.length === 0 &&
    requiresExplicitRetry;
  const dependencySatisfied = effectiveStatus === "done" || effectiveStatus === "superseded";
  return {
    ...base,
    effectiveStatus,
    reason,
    terminal,
    inactive,
    dispatchable,
    retryable,
    requiresExplicitRetry,
    dependencySatisfied,
  };
}

export function resolveEffectiveTaskState(input: {
  issue: ControllerIssue;
  task: ControllerTask;
  runs?: readonly AgentJobMeta[];
}): EffectiveTaskState {
  const { issue, task } = input;
  const evidence = aggregateRunEvidence(task, input.runs ?? []);
  const base = baseState(issue, task, evidence);

  // Parent lifecycle is the strongest semantic for archived/cancelled Issues.
  if (base.issueLifecycleStatus === "archived") {
    return finalizeState(base, "archived_by_parent", "issue_archived", true, true);
  }
  if (base.issueLifecycleStatus === "cancelled") {
    return finalizeState(base, "cancelled_by_parent", "issue_cancelled", true, true);
  }

  // supersededBy is a strong relation even when legacy data left another declared status.
  if ((task.supersededBy?.length ?? 0) > 0) {
    return finalizeState(base, "superseded", "superseded_by_relation", true, false);
  }

  // Explicit Task terminal state always wins over Run evidence.
  if (task.status === "done") return finalizeState(base, "done", "declared_done", true, false);
  if (task.status === "cancelled") return finalizeState(base, "cancelled", "declared_cancelled", true, false);
  if (task.status === "superseded") return finalizeState(base, "superseded", "declared_superseded", true, false);

  if (base.issueLifecycleStatus === "completed") {
    return finalizeState(base, "inactive_by_parent", "issue_completed", true, true);
  }

  // Only a currently active Run may override a non-terminal declared status.
  if (evidence.currentActiveRun?.status === "queued") {
    return finalizeState(base, "queued", "active_run_queued", false, false);
  }
  if (evidence.currentActiveRun?.status === "running") {
    return finalizeState(base, "running", "active_run_running", false, false);
  }
  if (evidence.currentActiveRun?.status === "waiting_for_user") {
    return finalizeState(base, "waiting_for_user", "active_run_waiting_for_user", false, false);
  }

  // Completed historical Runs are evidence only. They never resurrect or replace Task intent.
  return finalizeState(base, task.status, "declared_status", EXPLICIT_TERMINAL.has(task.status), false);
}

export function resolveIssueTaskStates(
  issue: ControllerIssue,
  runsByTask: ReadonlyMap<string, readonly AgentJobMeta[]> = new Map(),
): Map<string, EffectiveTaskState> {
  return new Map(
    issue.tasks.map((task) => [
      task.id,
      resolveEffectiveTaskState({ issue, task, runs: runsByTask.get(task.id) ?? [] }),
    ]),
  );
}

export function resolveTaskDependencies(
  issue: ControllerIssue,
  task: ControllerTask,
  states: ReadonlyMap<string, EffectiveTaskState>,
): TaskDependencyState {
  const pendingTaskIds: string[] = [];
  const cancelledTaskIds: string[] = [];
  const missingTaskIds: string[] = [];
  const supersededMigrations: SupersededDependencyMigration[] = [];
  const migratedDependsOn: string[] = [];

  for (const dependencyId of task.dependsOn) {
    const dependency = issue.tasks.find((candidate) => candidate.id === dependencyId);
    const state = states.get(dependencyId);
    if (!dependency || !state) {
      missingTaskIds.push(dependencyId);
      continue;
    }

    if (state.effectiveStatus === "superseded") {
      const replacements = [...(dependency.supersededBy ?? [])];
      if (replacements.length > 0) {
        supersededMigrations.push({ dependencyTaskId: dependencyId, replacementTaskIds: replacements });
        migratedDependsOn.push(...replacements);
      }
      // The old superseded Task itself never remains a blocker.
      continue;
    }

    if (state.dependencySatisfied) continue;
    if (
      state.effectiveStatus === "cancelled" ||
      state.effectiveStatus === "cancelled_by_parent" ||
      state.effectiveStatus === "archived_by_parent" ||
      state.effectiveStatus === "inactive_by_parent"
    ) {
      cancelledTaskIds.push(dependencyId);
      continue;
    }
    pendingTaskIds.push(dependencyId);
  }

  const normalizedMigrated = Array.from(new Set(migratedDependsOn));
  return {
    ready:
      pendingTaskIds.length === 0 &&
      cancelledTaskIds.length === 0 &&
      missingTaskIds.length === 0 &&
      supersededMigrations.length === 0,
    pendingTaskIds,
    cancelledTaskIds,
    missingTaskIds,
    supersededMigrations,
    migratedDependsOn: normalizedMigrated,
  };
}

export function assertTaskDispatchable(
  issue: ControllerIssue,
  task: ControllerTask,
  runs: readonly AgentJobMeta[],
  options: { retryFromRunId?: string } = {},
): EffectiveTaskState {
  const states = resolveIssueTaskStates(
    issue,
    new Map([[task.id, runs]]),
  );
  // Resolve every dependency without Run evidence; dependency terminal semantics remain authoritative.
  for (const dependency of issue.tasks) {
    if (!states.has(dependency.id)) {
      states.set(dependency.id, resolveEffectiveTaskState({ issue, task: dependency }));
    }
  }
  const state = states.get(task.id)!;
  const dependencies = resolveTaskDependencies(issue, task, states);
  const explicitRetryAuthorized =
    state.retryable &&
    state.requiresExplicitRetry &&
    options.retryFromRunId === state.latestRunId &&
    (state.effectiveStatus === "ready" || state.effectiveStatus === "blocked" || state.effectiveStatus === "changes_requested");
  if (state.activeRunIds.length > 0) {
    throw new Error(`task has active Run evidence: ${state.activeRunIds.join(", ")}`);
  }
  if (!state.dispatchable && !explicitRetryAuthorized) {
    throw new Error(
      `task is not dispatchable: declared=${state.declaredStatus}, effective=${state.effectiveStatus}, reason=${state.reason}, requiresExplicitRetry=${state.requiresExplicitRetry}`,
    );
  }
  if (!dependencies.ready) {
    throw new Error(
      `task dependencies are not dispatchable: ${JSON.stringify(dependencies)}`,
    );
  }
  return state;
}
