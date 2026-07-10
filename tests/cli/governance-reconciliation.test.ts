import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createIssue, getIssue, updateTask } from "../../src/cli/controller/issue-store";
import { inspectProjectGovernance, reconcileProjectGovernance } from "../../src/cli/controller/governance";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-harness-governance-reconcile-"));
  roots.push(root);
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, ".ai/harness/jobs"), { recursive: true });
  return root;
}

function task(title: string, risk: "low" | "medium" | "high" = "low") {
  return {
    title,
    objective: `Complete ${title}.`,
    allowedPaths: ["src/**"],
    checks: ["focused"],
    acceptanceCriteria: [`${title} is complete.`],
    risk,
  };
}

function writeRun(
  root: string,
  issueId: string,
  taskId: string,
  status: "failed" | "succeeded",
  runId: string,
): string {
  const dir = join(root, ".ai/harness/jobs", runId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(dir, "stdout.log"), status === "succeeded" ? "ok\n" : "");
  writeFileSync(join(dir, "stderr.log"), status === "failed" ? "agent timed out\n" : "");
  writeFileSync(join(dir, "events.jsonl"), "");
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify({
    schemaVersion: 2,
    runId,
    issueId,
    taskId,
    agent: "codex",
    provider: "local",
    executionMode: "workspace",
    status,
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
    ...(status === "succeeded" ? { finishedAt: now } : { finishedAt: now, error: "agent timed out" }),
    progress: {
      phase: status,
      percent: 100,
      currentActivity: status === "succeeded" ? "completed" : "agent timed out",
      lastActivityAt: now,
      activityCount: 3,
    },
  }, null, 2)}\n`);
  return runId;
}

describe("governance reconciliation", () => {
  test("clears stale failed-run blockers after a later successful run and returns a bounded review status", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Retry drift",
      summary: "A later success should clear stale retry blockers.",
      goals: ["Keep governance deterministic."],
      acceptanceCriteria: ["Successful work returns to review."],
      tasks: [task("Recover run state")],
    });

    const failedRunId = writeRun(root, issue.id, "T1", "failed", "RUN-T1-failed");
    updateTask(root, issue.id, "T1", {
      status: "blocked",
      runId: failedRunId,
      note: `${failedRunId} remains recorded as failed; explicit retry is required and no new Run was created.`,
    });
    const succeededRunId = writeRun(root, issue.id, "T1", "succeeded", "RUN-T1-succeeded");
    updateTask(root, issue.id, "T1", { runId: succeededRunId });

    const result = reconcileProjectGovernance(root);
    const reconciled = getIssue(root, issue.id).tasks.find((entry) => entry.id === "T1");

    expect(result.changed).toBe(true);
    expect(result.changes.some((entry) => entry.action === "clear_stale_failed_run_blocker")).toBe(true);
    expect(reconciled?.status).toBe("review");
    expect(result.governance.findings.some((entry) => entry.code === "FAILED_RUN_BLOCKED_TASK")).toBe(false);
    expect(result.governance.status.kind).toBe("needs_review");
    expect(result.governance.status.taskId).toBe("T1");
  });

  test("auto-completes verified work when policy allows and surfaces terminal issues for archive", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Verification closeout",
      summary: "Verified low-risk work should close deterministically.",
      goals: ["Close policy-satisfied work."],
      acceptanceCriteria: ["Terminal issues are surfaced for archive."],
      tasks: [task("Finish verified work", "low")],
    });

    updateTask(root, issue.id, "T1", {
      status: "verified",
      verification: {
        reviewer: "unit-test",
        verifiedAt: "2026-07-10T00:00:00.000Z",
        checkResults: [],
        acceptanceResults: [],
        autoCompleted: false,
      },
      note: "Legacy drift left the task verified instead of done.",
    });

    const result = reconcileProjectGovernance(root);
    const refreshed = getIssue(root, issue.id);

    expect(result.changed).toBe(true);
    expect(result.changes.some((entry) => entry.action === "auto_accept_verified_task")).toBe(true);
    expect(refreshed.tasks.find((entry) => entry.id === "T1")?.status).toBe("done");
    expect(refreshed.status).toBe("done");
    expect(result.governance.findings.some((entry) => entry.code === "TERMINAL_ISSUE_NOT_ARCHIVED")).toBe(true);
    expect(result.governance.status.kind).toBe("archive_ready");
  });

  test("reports ready status when a launchable task is available", () => {
    const root = repo();
    createIssue(root, {
      title: "Ready queue",
      summary: "Expose a bounded ready status.",
      goals: ["Show launchable work."],
      acceptanceCriteria: ["Ready work is easy to summarize."],
      tasks: [task("Launch me")],
    });

    const governance = inspectProjectGovernance(root);

    expect(governance.executionQueue[0]?.action).toBe("launch");
    expect(governance.status.kind).toBe("ready");
    expect(governance.status.taskId).toBe("T1");
  });
});
