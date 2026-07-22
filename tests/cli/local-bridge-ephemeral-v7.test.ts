import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { createIssue, getIssue, listIssues } from "../../src/cli/controller/issue-store";
import { getLocalBridgeJob, submitLocalBridgeJob } from "../../src/cli/local-bridge/job-store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-harness-ephemeral-v7-"));
  const controllerHome = mkdtempSync(join(tmpdir(), "repo-harness-ephemeral-v7-home-"));
  roots.push(root, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, ".ai/harness/jobs"), { recursive: true });
  spawnSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  return root;
}

describe("Quick Agent v7 ephemeral lifecycle", () => {
  test("ephemeral Quick Agent metadata stays hidden and remains available after failure for retry", () => {
    const root = repo();
    const job = submitLocalBridgeJob(root, {
      action: "quick-agent-session",
      requestedBy: "test",
      payload: {
        title: "Ephemeral diagnosis",
        objective: "Inspect a transient failure.",
        risk: "readonly",
      },
    });
    expect(job.ephemeral).toBe(true);

    const issue = createIssue(root, {
      title: "Ephemeral diagnosis",
      kind: "investigation",
      ephemeral: true,
      ephemeralOwnerJobId: job.jobId,
      tasks: [{ title: "Inspect", objective: "Inspect only.", risk: "readonly" }],
    });
    expect(listIssues(root)).toEqual([]);
    expect(getIssue(root, issue.id).ephemeral).toBe(true);

    const runId = "RUN-ephemeral-failed";
    const runDir = join(root, ".ai/harness/jobs", runId);
    mkdirSync(runDir, { recursive: true });
    const now = new Date().toISOString();
    for (const file of ["stdout.log", "stderr.log", "events.jsonl"]) writeFileSync(join(runDir, file), "");
    writeFileSync(join(runDir, "meta.json"), `${JSON.stringify({
      schemaVersion: 2,
      runId,
      issueId: issue.id,
      taskId: "T1",
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
      error: "synthetic failure",
      createdAt: now,
      startedAt: now,
      finishedAt: now,
    }, null, 2)}\n`);

    const jobPath = join(root, ".ai/harness/local-jobs", job.jobId, "job.json");
    const stored = JSON.parse(readFileSync(jobPath, "utf-8"));
    stored.status = "dispatched";
    stored.runId = runId;
    stored.issueId = issue.id;
    stored.taskId = "T1";
    delete stored.finishedAt;
    writeFileSync(jobPath, `${JSON.stringify(stored, null, 2)}\n`);

    const refreshed = getLocalBridgeJob(root, job.jobId);
    expect(refreshed.status).toBe("failed");
    expect(refreshed.finishedAt).toBeTruthy();
    expect(refreshed.cleanupAt).toBeUndefined();
    const retained = getIssue(root, issue.id);
    expect(retained.ephemeral).toBe(true);
    expect(listIssues(root)).toEqual([]);
  });
});
