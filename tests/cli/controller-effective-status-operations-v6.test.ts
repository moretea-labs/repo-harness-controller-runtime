import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getAgentJob } from "../../src/cli/agent-jobs/job-manager";
import type { AgentJobStatus } from "../../src/cli/agent-jobs/types";
import {
  createIssue,
  getIssue,
  splitTask,
  supersedeTask,
  updateTask,
} from "../../src/cli/controller/issue-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-harness-v6-effective-"));
  roots.push(root);
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, ".ai/harness/jobs"), { recursive: true });
  return root;
}

function task(title: string) {
  return {
    title,
    objective: `Complete ${title}.`,
    allowedPaths: ["src/**"],
    checks: ["focused"],
    acceptanceCriteria: [`${title} is accepted.`],
    risk: "low" as const,
  };
}

function writeRun(
  root: string,
  issueId: string,
  taskId: string,
  runId: string,
  status: AgentJobStatus,
): void {
  const dir = join(root, ".ai/harness/jobs", runId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(dir, "stdout.log"), "");
  writeFileSync(join(dir, "stderr.log"), "");
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
    createdAt: now,
    startedAt: now,
    finishedAt: ["queued", "running", "waiting_for_user"].includes(status) ? undefined : now,
  }, null, 2)}\n`);
}

describe("Controller v6 effective status write boundaries", () => {
  test("reading a terminal Run does not mutate its Task", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Read purity",
      summary: "Run reads must not rewrite Task intent.",
      goals: ["Keep reads pure."],
      acceptanceCriteria: ["Task status is unchanged."],
      tasks: [task("Read only")],
    });
    const runId = "RUN-read-failed";
    writeRun(root, issue.id, "T1", runId, "failed");
    updateTask(root, issue.id, "T1", { runId });

    expect(getIssue(root, issue.id).tasks[0]?.status).toBe("ready");
    expect(getAgentJob(root, runId).status).toBe("failed");
    expect(getIssue(root, issue.id).tasks[0]?.status).toBe("ready");
  });

  test("split and supersede reject an effective active Run even when declared status is ready", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Active Run guard",
      summary: "Structural changes cannot race an active Run.",
      goals: ["Protect task lifecycle."],
      acceptanceCriteria: ["Active Run blocks structural mutation."],
      tasks: [task("Original"), task("Replacement")],
    });
    const runId = "RUN-active";
    writeRun(root, issue.id, "T1", runId, "running");
    updateTask(root, issue.id, "T1", { runId });

    expect(getIssue(root, issue.id).tasks[0]?.status).toBe("ready");
    expect(() => splitTask(root, issue.id, "T1", [task("A"), task("B")])).toThrow("cancel active Run");
    expect(() => supersedeTask(root, issue.id, "T1", ["T2"])).toThrow("cancel active Run");
  });
});
