import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  archiveIssue,
  createIssue,
  getIssue,
  inspectIssueReadiness,
  setTaskDependencies,
  splitTask,
  updateIssue,
  updateTask,
} from "../../src/cli/controller/issue-store";
import {
  inspectProjectGovernance,
  reconcileProjectGovernance,
} from "../../src/cli/controller/governance";
import {
  loadControllerProjectState,
  saveControllerProjectState,
} from "../../src/cli/controller/project-state";
import { getProjectProgress } from "../../src/cli/controller/progress";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-harness-v5-execution-"));
  roots.push(root);
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, ".ai/harness/jobs"), { recursive: true });
  return root;
}

function task(title: string, dependsOn: string[] = []) {
  return {
    title,
    objective: `Complete ${title}.`,
    dependsOn,
    allowedPaths: ["src/**"],
    checks: ["focused"],
    acceptanceCriteria: [`${title} is accepted.`],
    risk: "low" as const,
  };
}

function writeFailedRun(root: string, issueId: string, taskId: string): string {
  const runId = `RUN-${taskId}-failed`;
  const dir = join(root, ".ai/harness/jobs", runId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(dir, "stdout.log"), "");
  writeFileSync(join(dir, "stderr.log"), "timeout");
  writeFileSync(join(dir, "events.jsonl"), "");
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify({
    schemaVersion: 2,
    runId,
    issueId,
    taskId,
    agent: "codex",
    provider: "local",
    executionMode: "workspace",
    status: "failed",
    repoRoot: root,
    worktree: root,
    branch: null,
    baseRevision: null,
    promptPath: `.ai/harness/jobs/${runId}/prompt.md`,
    stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`,
    stderrPath: `.ai/harness/jobs/${runId}/stderr.log`,
    resultPath: `.ai/harness/jobs/${runId}/result.json`,
    eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`,
    timeoutMs: 3_600_000,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    error: "agent timed out",
    progress: { phase: "failed", percent: 100, currentActivity: "agent timed out", lastActivityAt: now, activityCount: 4 },
  }, null, 2)}\n`);
  return runId;
}

describe("Controller V5 execution and closure", () => {
  test("keeps current focus informational while multiple active Issues remain executable", () => {
    const root = repo();
    const first = createIssue(root, { title: "First active", summary: "First", goals: ["First"], acceptanceCriteria: ["Done"], tasks: [task("A")] });
    expect(loadControllerProjectState(root).currentIssueId).toBe(first.id);
    const second = createIssue(root, { title: "Second active", summary: "Second", goals: ["Second"], acceptanceCriteria: ["Done"], tasks: [task("B")] });
    expect(second.id).toBeTruthy();

    const governance = inspectProjectGovernance(root);
    expect(governance.currentIssueId).toBe(first.id);
    expect(governance.findings.some((entry) => entry.code === "MULTIPLE_ACTIVE_ISSUES")).toBe(true);
    expect(governance.executionQueue.map((entry) => entry.issueId)).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  test("treats duplicate titles as hints while preserving explicit paused creation policy", () => {
    const root = repo();
    createIssue(root, { title: "Focused work", summary: "Focus", goals: ["Focus"], acceptanceCriteria: ["Done"], tasks: [task("A")] });
    expect(createIssue(root, { title: "Focused work", summary: "Duplicate" }).title).toBe("Focused work");
    saveControllerProjectState(root, { issueCreationMode: "paused" });
    expect(() => createIssue(root, { title: "Paused work", summary: "Paused", allowWhileFocused: true })).toThrow("creation is paused");
    const created = createIssue(root, { title: "Paused work", summary: "Explicit", allowWhileFocused: true, allowWhenPaused: true });
    expect(created.title).toBe("Paused work");
  });

  test("readiness cannot score 100 when there are no dispatchable Tasks", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Dead dependency",
      summary: "Cancelled dependency must block launch.",
      goals: ["Repair the graph."],
      acceptanceCriteria: ["Queue is valid."],
      tasks: [task("Cancelled"), task("Downstream", ["T1"])],
    });
    updateTask(root, issue.id, "T1", { status: "cancelled", note: "No longer needed." });
    const readiness = inspectIssueReadiness(root, issue.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.score).toBeLessThan(100);
    expect(readiness.taskBlockers.some((entry) => entry.code === "CANCELLED_DEPENDENCY")).toBe(true);
  });

  test("safe reconciliation rewires superseded dependencies without auto-retrying failed attempts", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Reconcile flow",
      summary: "Repair safe governance drift.",
      goals: ["Create a real queue."],
      acceptanceCriteria: ["Ready Tasks are visible."],
      tasks: [task("Original"), task("Dependent", ["T1"])],
    });
    splitTask(root, issue.id, "T1", [task("Replacement A"), task("Replacement B")]);
    // Recreate a stale legacy dependency so reconciliation proves it can migrate old data.
    setTaskDependencies(root, issue.id, "T2", ["T1"]);
    const runId = writeFailedRun(root, issue.id, "T3");
    updateTask(root, issue.id, "T3", { status: "blocked", runId, note: "Old behavior blocked the Task." });

    const result = reconcileProjectGovernance(root);
    expect(result.changed).toBe(true);
    expect(result.changes.some((entry) => entry.action === "repair_dependency")).toBe(true);
    expect(result.changes.some((entry) => entry.action === "restore_retryable")).toBe(false);
    expect(getIssue(root, issue.id).tasks.find((entry) => entry.id === "T3")?.status).toBe("blocked");
    const governance = inspectProjectGovernance(root);
    expect(governance.findings.some((entry) => entry.code === "FAILED_RUN_BLOCKED_TASK")).toBe(true);
    expect(governance.executionQueue.some((entry) => entry.taskId === "T3" && entry.action === "retry")).toBe(true);
  });

  test("progress uses only the evidence gates applicable to Task risk", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Evidence progress",
      summary: "Use observable gates.",
      goals: ["Avoid fake percentages."],
      acceptanceCriteria: ["Applicable gates are shown."],
      tasks: [task("Evidence task")],
    });
    saveControllerProjectState(root, { currentIssueId: issue.id });
    const progress = getProjectProgress(root);
    const taskProgress = progress.issues[0].tasks[0];
    expect(taskProgress.completion.totalGates).toBe(3);
    expect(taskProgress.completion.completedGates).toBe(0);
    expect(taskProgress.percent).toBe(0);
    expect(taskProgress.completion.summary).toBe("0/3 applicable evidence gates complete (low_risk_change)");
  });

  test("archived Issues are removed from current views but remain available as history", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Archive completed",
      summary: "Separate history from current work.",
      goals: ["Archive."],
      acceptanceCriteria: ["History remains."],
      tasks: [task("Complete")],
    });
    updateTask(root, issue.id, "T1", { status: "done", note: "Accepted." });
    updateIssue(root, issue.id, { status: "done" });
    archiveIssue(root, issue.id);

    const progress = getProjectProgress(root);
    expect(progress.issues).toHaveLength(0);
    expect(progress.archivedIssues).toHaveLength(1);
    expect(progress.archivedIssueCount).toBe(1);
    expect(loadControllerProjectState(root).issueCreationMode).toBe("open");
    expect(loadControllerProjectState(root).currentIssueId).toBeUndefined();
  });
});
