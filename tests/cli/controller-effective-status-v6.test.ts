import { describe, expect, test } from "bun:test";
import type { AgentJobMeta, AgentJobStatus } from "../../src/cli/agent-jobs/types";
import {
  resolveEffectiveTaskState,
  resolveIssueTaskStates,
  resolveTaskDependencies,
} from "../../src/cli/controller/task-status-resolver";
import type {
  ControllerIssue,
  ControllerTask,
  IssueStatus,
  TaskStatus,
} from "../../src/cli/controller/types";

function task(
  status: TaskStatus,
  patch: Partial<ControllerTask> = {},
): ControllerTask {
  return {
    id: "T1",
    title: "Task",
    objective: "Test effective state.",
    status,
    dependsOn: [],
    allowedPaths: ["src/**"],
    forbiddenPaths: [],
    checks: ["test"],
    acceptanceCriteria: ["State is stable."],
    risk: "low",
    recommendedAgent: "codex",
    notes: [],
    runIds: [],
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    ...patch,
  };
}

function completedTask(patch: Partial<ControllerTask> = {}): ControllerTask {
  return task("done", {
    verification: {
      runId: "RUN-completed",
      reviewer: "test",
      verifiedAt: "2026-06-21T00:00:00.000Z",
      checkResults: [],
      acceptanceResults: [],
      autoCompleted: true,
      integrationEvidence: {
        runId: "RUN-completed",
        kind: "commit",
        targetBranch: "main",
        targetRevision: "abc123",
        reachable: true,
        recordedAt: "2026-06-21T00:00:00.000Z",
        strategy: "already_integrated",
      },
      cleanupEvidence: {
        runId: "RUN-completed",
        worktreeRemovedOrNotCreated: true,
        branchDeletedOrRetained: true,
        leasesReleased: true,
        runTerminal: true,
        editSessionClosedOrNotCreated: true,
        noActiveProcess: true,
        noDirtyDiff: true,
        recordedAt: "2026-06-21T00:00:00.000Z",
      },
    },
    ...patch,
  });
}

function issue(
  taskValue: ControllerTask,
  status: IssueStatus = "in_progress",
  patch: Partial<ControllerIssue> = {},
): ControllerIssue {
  return {
    schemaVersion: 3,
    id: "ISS-1",
    title: "Issue",
    slug: "issue",
    kind: "governance",
    status,
    summary: "Test status resolution.",
    goals: ["Stable state."],
    nonGoals: [],
    acceptanceCriteria: ["No resurrection."],
    relatedArtifacts: [],
    tasks: [taskValue],
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    ...patch,
  };
}

function run(status: AgentJobStatus, runId = `RUN-${status}`): AgentJobMeta {
  return {
    schemaVersion: 2,
    runId,
    issueId: "ISS-1",
    taskId: "T1",
    agent: "codex",
    provider: "local",
    executionMode: "workspace",
    status,
    repoRoot: "/repo",
    worktree: "/repo",
    branch: null,
    baseRevision: null,
    promptPath: "prompt.md",
    stdoutPath: "stdout.log",
    stderrPath: "stderr.log",
    resultPath: "result.json",
    eventsPath: "events.jsonl",
    createdAt: "2026-06-21T01:00:00.000Z",
  };
}

describe("Controller v6 effective Task state", () => {
  test.each(["cancelled", "superseded"] as TaskStatus[])(
    "explicit terminal %s cannot be resurrected by active or historical Runs",
    (status) => {
      for (const runStatus of ["queued", "running", "succeeded", "failed", "cancelled", "unknown"] as AgentJobStatus[]) {
        const value = task(status, { runIds: [`RUN-${runStatus}`] });
        const state = resolveEffectiveTaskState({ issue: issue(value), task: value, runs: [run(runStatus)] });
        expect(state.effectiveStatus).toBe(status);
        expect(state.terminal).toBe(true);
        expect(state.dispatchable).toBe(false);
      }
    },
  );

  test("done remains terminal only when integration and cleanup evidence are complete", () => {
    for (const runStatus of ["queued", "running", "succeeded", "failed", "cancelled", "unknown"] as AgentJobStatus[]) {
      const value = completedTask({ runIds: [`RUN-${runStatus}`] });
      const state = resolveEffectiveTaskState({ issue: issue(value), task: value, runs: [run(runStatus)] });
      expect(state.effectiveStatus).toBe("done");
      expect(state.terminal).toBe(true);
      expect(state.dispatchable).toBe(false);
    }
  });

  test("done remains terminal with a Direct Edit completion receipt and no Run", () => {
    const value = task("done", {
      verification: {
        reviewer: "test",
        verifiedAt: "2026-06-21T00:00:00.000Z",
        checkResults: [],
        acceptanceResults: [],
        completionReceipt: {
          schemaVersion: 1,
          receiptId: "REC-direct-edit-test",
          source: "direct_edit",
          issueId: "ISS-1",
          taskId: "T1",
          editSessionId: "EDIT-1",
          targetBranch: "main",
          targetRevision: "abc123",
          changedPaths: ["src/example.ts"],
          delivery: {
            kind: "commit",
            status: "integrated",
            strategy: "edit_session_commit",
            reachable: true,
            recordedAt: "2026-06-21T00:00:00.000Z",
          },
          cleanup: {
            status: "complete",
            warnings: [],
            blockers: [],
            recordedAt: "2026-06-21T00:00:00.000Z",
          },
          recordedAt: "2026-06-21T00:00:00.000Z",
          verifiedAt: "2026-06-21T00:00:00.000Z",
        },
      },
    });
    const state = resolveEffectiveTaskState({ issue: issue(value), task: value });
    expect(state.effectiveStatus).toBe("done");
    expect(state.terminal).toBe(true);
  });

  test("legacy done without completion evidence is reopened as integration blocked", () => {
    const value = task("done");
    const state = resolveEffectiveTaskState({ issue: issue(value), task: value });
    expect(state.effectiveStatus).toBe("integration_blocked");
    expect(state.terminal).toBe(false);
    expect(state.reason).toBe("completion_evidence_missing");
  });

  test("missing completion evidence is classified by the verified Run rather than a later Run", () => {
    const verifiedRun = run("succeeded", "RUN-verified");
    verifiedRun.closureState = "integration_blocked";
    const laterRun = run("waiting_for_user", "RUN-later");
    laterRun.createdAt = "2026-06-21T02:00:00.000Z";
    laterRun.closureState = "cleanup_blocked";
    const value = task("done", {
      runIds: [verifiedRun.runId, laterRun.runId],
      verification: {
        runId: verifiedRun.runId,
        reviewer: "test",
        verifiedAt: "2026-06-21T01:30:00.000Z",
        checkResults: [],
        acceptanceResults: [],
      },
    });

    const state = resolveEffectiveTaskState({
      issue: issue(value),
      task: value,
      runs: [verifiedRun, laterRun],
    });

    expect(state.effectiveStatus).toBe("integration_blocked");
    expect(state.latestRunId).toBe(laterRun.runId);
  });

  test.each(["ready", "done", "cancelled"] as TaskStatus[])(
    "supersededBy is authoritative even when legacy declared status is %s",
    (declared) => {
      const value = task(declared, { supersededBy: ["T2", "T3"], runIds: ["RUN-running"] });
      const state = resolveEffectiveTaskState({ issue: issue(value), task: value, runs: [run("running")] });
      expect(state.declaredStatus).toBe(declared);
      expect(state.effectiveStatus).toBe("superseded");
      expect(state.reason).toBe("superseded_by_relation");
      expect(state.dispatchable).toBe(false);
    },
  );

  test("archived and cancelled parent Issues dominate child Tasks", () => {
    const value = task("ready", { runIds: ["RUN-running"] });
    expect(
      resolveEffectiveTaskState({ issue: issue(value, "in_progress", { archivedAt: "2026-06-21T02:00:00.000Z" }), task: value, runs: [run("running")] }).effectiveStatus,
    ).toBe("archived_by_parent");
    expect(
      resolveEffectiveTaskState({ issue: issue(value, "cancelled"), task: value, runs: [run("running")] }).effectiveStatus,
    ).toBe("cancelled_by_parent");
  });

  test("completed historical Run is evidence only and does not overwrite declared status", () => {
    const value = task("blocked", { runIds: ["RUN-cancelled"] });
    const state = resolveEffectiveTaskState({ issue: issue(value), task: value, runs: [run("cancelled")] });
    expect(state.effectiveStatus).toBe("blocked");
    expect(state.latestRunStatus).toBe("cancelled");
    expect(state.retryable).toBe(true);
    expect(state.requiresExplicitRetry).toBe(true);
    expect(state.dispatchable).toBe(false);
  });

  test("terminal Task ignores retry requirements from historical failed Run evidence", () => {
    const value = completedTask({ runIds: ["RUN-failed"] });
    const state = resolveEffectiveTaskState({ issue: issue(value, "done"), task: value, runs: [run("failed")] });
    expect(state.effectiveStatus).toBe("done");
    expect(state.retryable).toBe(false);
    expect(state.requiresExplicitRetry).toBe(false);
    expect(state.dispatchable).toBe(false);
  });

  test("active Run only overrides a non-terminal active Task", () => {
    const value = task("ready", { runIds: ["RUN-running"] });
    const state = resolveEffectiveTaskState({ issue: issue(value), task: value, runs: [run("running")] });
    expect(state.effectiveStatus).toBe("running");
    expect(state.activeRunId).toBe("RUN-running");
    expect(state.dispatchable).toBe(false);
  });

  test("superseded dependency becomes a migration anomaly rather than an old-task blocker", () => {
    const old = task("superseded", { id: "T1", supersededBy: ["T2", "T3"] });
    const replacementA = completedTask({ id: "T2" });
    const replacementB = task("ready", { id: "T3" });
    const downstream = task("planned", { id: "T4", dependsOn: ["T1"] });
    const parent = issue(old, "in_progress", { tasks: [old, replacementA, replacementB, downstream] });
    const states = resolveIssueTaskStates(parent);
    const dependencies = resolveTaskDependencies(parent, downstream, states);
    expect(dependencies.pendingTaskIds).toEqual(["T3"]);
    expect(dependencies.cancelledTaskIds).toEqual([]);
    expect(dependencies.supersededMigrations).toEqual([
      { dependencyTaskId: "T1", replacementTaskIds: ["T2", "T3"] },
    ]);
    expect(dependencies.ready).toBe(false);
  });
  test("an older active Run cannot override a newer terminal Run", () => {
    const value = task("blocked", { runIds: ["RUN-running", "RUN-failed"] });
    const state = resolveEffectiveTaskState({
      issue: issue(value),
      task: value,
      runs: [run("running", "RUN-running"), run("failed", "RUN-failed")],
    });
    expect(state.effectiveStatus).toBe("blocked");
    expect(state.activeRunId).toBeUndefined();
    expect(state.latestRunId).toBe("RUN-failed");
    expect(state.requiresExplicitRetry).toBe(true);
    expect(state.dispatchable).toBe(false);
  });

  test("multiple active Runs are reported while only the latest owns lifecycle", () => {
    const value = task("ready", { runIds: ["RUN-queued", "RUN-running"] });
    const state = resolveEffectiveTaskState({
      issue: issue(value),
      task: value,
      runs: [run("queued", "RUN-queued"), run("running", "RUN-running")],
    });
    expect(state.effectiveStatus).toBe("running");
    expect(state.activeRunId).toBe("RUN-running");
    expect(state.multipleActiveRuns).toBe(true);
  });

  test("a completed parent Issue makes unfinished child Tasks inactive", () => {
    const value = task("ready", { runIds: ["RUN-running"] });
    const state = resolveEffectiveTaskState({
      issue: issue(value, "done"),
      task: value,
      runs: [run("running")],
    });
    expect(state.effectiveStatus).toBe("inactive_by_parent");
    expect(state.inactive).toBe(true);
    expect(state.dispatchable).toBe(false);
  });

});
