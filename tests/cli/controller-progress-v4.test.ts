import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createIssue, updateTask } from "../../src/cli/controller/issue-store";
import {
  getControllerTimeline,
  getProjectProgress,
  getTaskProgressDetail,
} from "../../src/cli/controller/progress";
import {
  exportControllerWorklog,
  listControllerWorklogEvents,
} from "../../src/cli/controller/worklog";
import {
  defaultGitHubPluginConfig,
  getGitHubPluginStatus,
  loadGitHubPluginConfig,
  saveGitHubPluginConfig,
} from "../../src/cli/github/plugin";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-harness-v4-progress-"));
  roots.push(root);
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, ".ai/harness/jobs"), { recursive: true });
  return root;
}

function writeRunningRun(root: string, issueId: string): string {
  const runId = "RUN-progress-v4";
  const dir = join(root, ".ai/harness/jobs", runId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(dir, "stdout.log"), "editing task\n");
  writeFileSync(join(dir, "stderr.log"), "");
  writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ at: now, type: "run_activity", message: "Editing implementation", data: { phase: "editing" } })}\n`);
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify({
    schemaVersion: 2,
    runId,
    issueId,
    taskId: "T2",
    agent: "codex",
    provider: "local",
    executionMode: "workspace",
    status: "running",
    repoRoot: root,
    worktree: root,
    branch: null,
    baseRevision: null,
    promptPath: `.ai/harness/jobs/${runId}/prompt.md`,
    stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`,
    stderrPath: `.ai/harness/jobs/${runId}/stderr.log`,
    resultPath: `.ai/harness/jobs/${runId}/result.json`,
    eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`,
    workerPid: process.pid,
    timeoutMs: 3_600_000,
    createdAt: now,
    startedAt: now,
    lastHeartbeatAt: now,
    progress: { phase: "editing", percent: 60, currentActivity: "Editing implementation", lastActivityAt: now, activityCount: 3 },
  }, null, 2)}\n`);
  return runId;
}

describe("Controller V4 progress and worklog", () => {
  test("derives Issue and Task progress from durable state plus the latest Run", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Progress aggregation",
      summary: "Aggregate Task and Run state.",
      goals: ["Show truthful progress."],
      acceptanceCriteria: ["Progress is visible."],
      tasks: [
        { title: "Completed task", objective: "Finish one slice.", allowedPaths: ["src/**"], checks: ["focused"], acceptanceCriteria: ["Done"], risk: "low" },
        { title: "Running task", objective: "Execute the active slice.", allowedPaths: ["src/**"], checks: ["focused"], acceptanceCriteria: ["Running"], risk: "medium" },
        { title: "Ready task", objective: "Wait for execution.", allowedPaths: ["src/**"], checks: ["focused"], acceptanceCriteria: ["Ready"], risk: "low" },
      ],
    });
    updateTask(root, issue.id, "T1", { status: "done", note: "Completed." });
    const runId = writeRunningRun(root, issue.id);
    updateTask(root, issue.id, "T2", { runId });

    const progress = getProjectProgress(root);
    expect(progress.issueCount).toBe(1);
    expect(progress.activeRunCount).toBe(1);
    expect(progress.completedTaskCount).toBe(1);
    expect(progress.totalGates).toBe(15);
    expect(progress.completedGates).toBeGreaterThanOrEqual(1);
    const running = progress.issues[0]?.tasks.find((task) => task.taskId === "T2");
    expect(running?.status).toBe("ready");
    expect(running?.effectiveStatus).toBe("running");
    expect(running?.completion.totalGates).toBe(5);
    expect(running?.completion.execution.state).toBe("in_progress");
    expect(running?.latestRunId).toBe(runId);
    expect(running?.currentActivity).toContain("Editing");

    const detail = getTaskProgressDetail(root, issue.id, "T2");
    expect(detail.runs).toHaveLength(1);
    expect(detail.timeline.some((event) => event.action === "run_activity")).toBe(true);
  });

  test("records controller mutations and exports a tracked worklog report", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Worklog evidence",
      summary: "Keep a durable mutation ledger.",
      goals: ["Record state transitions."],
      acceptanceCriteria: ["A report can be exported."],
      tasks: [{ title: "Record", objective: "Write evidence.", allowedPaths: ["src/**"], checks: ["focused"], acceptanceCriteria: ["Recorded"], risk: "low" }],
    });
    updateTask(root, issue.id, "T1", { status: "review", note: "Implementation complete." });
    const events = listControllerWorklogEvents(root, { issueId: issue.id, limit: 100 });
    expect(events.some((event) => event.action === "issue_created")).toBe(true);
    expect(events.some((event) => event.action === "task_status_changed")).toBe(true);
    expect(events.some((event) => event.action === "task_note_added")).toBe(true);

    const timeline = getControllerTimeline(root, { issueId: issue.id, limit: 100 });
    expect(timeline.length).toBeGreaterThanOrEqual(events.length);
    const exported = exportControllerWorklog(root, { outputPath: "tasks/reports/v4-worklog.md" });
    expect(exported.eventCount).toBeGreaterThan(0);
    expect(readFileSync(join(root, exported.path), "utf-8")).toContain("# Controller Worklog");
    expect(() => exportControllerWorklog(root, { outputPath: "../escape.md" })).toThrow("inside the repository");
    expect(() => exportControllerWorklog(root, { outputPath: join(tmpdir(), "escape.md") })).toThrow("inside the repository");
  });

  test("keeps GitHub optional and persists explicit plugin configuration", () => {
    const root = repo();
    expect(loadGitHubPluginConfig(root)).toEqual(defaultGitHubPluginConfig());
    const saved = saveGitHubPluginConfig(root, {
      enabled: true,
      repository: "owner/repo",
      syncMode: "manual",
      includeTasks: true,
      projectOwner: "owner",
      projectNumber: 7,
    });
    expect(saved.enabled).toBe(true);
    expect(saved.repository).toBe("owner/repo");
    expect(loadGitHubPluginConfig(root).projectNumber).toBe(7);

    const patched = saveGitHubPluginConfig(root, { syncMode: "checkpoint" });
    expect(patched.enabled).toBe(true);
    expect(patched.repository).toBe("owner/repo");
    expect(patched.syncMode).toBe("checkpoint");

    const cleared = saveGitHubPluginConfig(root, {
      repository: "",
      projectOwner: "",
      projectNumber: null,
    });
    expect(cleared.repository).toBeUndefined();
    expect(cleared.projectOwner).toBeUndefined();
    expect(cleared.projectNumber).toBeUndefined();
    expect(() => saveGitHubPluginConfig(root, { projectNumber: 0 })).toThrow("positive integer");
    expect(() => saveGitHubPluginConfig(root, { projectNumber: 1.5 })).toThrow("positive integer");

    const disabledRoot = repo();
    const status = getGitHubPluginStatus(disabledRoot);
    expect(status.probed).toBe(false);
    expect(status.ready).toBe(false);
    expect(listControllerWorklogEvents(root).some((event) => event.action === "github_plugin_configured")).toBe(true);
  });
});
