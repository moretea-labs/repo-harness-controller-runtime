import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getAgentJob, startTaskJob } from "../../src/cli/agent-jobs/job-manager";
import type { AgentJobMeta } from "../../src/cli/agent-jobs/types";
import {
  invalidateAgentWorker,
  matchesAgentWorkerCommand,
  shouldTolerateOwnedFinalizationInvalidation,
} from "../../src/cli/agent-jobs/worker-lifecycle";
import {
  createIssue,
  inspectIssueReadiness,
  inspectTaskReadiness,
  listIssues,
  projectBoard,
  recordTaskVerification,
  supersedeTask,
  updateTask,
} from "../../src/cli/controller/issue-store";
import { getProjectProgress } from "../../src/cli/controller/progress";
import {
  resolveIssueTaskStates,
  resolveTaskDependencies,
} from "../../src/cli/controller/task-status-resolver";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-harness-execution-first-v7-"));
  roots.push(root);
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, ".ai/harness/jobs"), { recursive: true });
  return root;
}

function writeRun(
  root: string,
  issueId: string,
  taskId: string,
  runId: string,
  percent: number,
  scope: { executionClass: "read_only" | "low_risk_change" | "medium_risk_change" | "high_risk_change" | "destructive_change"; allowedPaths: string[] } = { executionClass: "low_risk_change", allowedPaths: [] },
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
    executionClass: scope.executionClass,
    allowedPaths: scope.allowedPaths,
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
    progress: {
      phase: "editing",
      percent,
      currentActivity: `working at ${percent}%`,
      lastActivityAt: now,
      activityCount: 1,
    },
    createdAt: now,
    startedAt: now,
  }, null, 2)}\n`);
}

describe("Controller v7 compatibility on the V8 execution bridge", () => {
  test("high-risk metadata does not block local execution", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Task-local readiness",
      tasks: [
        {
          title: "High risk without scope",
          objective: "Refactor a sensitive subsystem.",
          risk: "high",
        },
        {
          title: "Independent low-risk task",
          objective: "Update a bounded source file.",
          allowedPaths: ["src/safe.ts"],
          risk: "low",
        },
      ],
    });

    const highRisk = inspectTaskReadiness(root, issue.id, "T1");
    const ready = inspectTaskReadiness(root, issue.id, "T2");
    const aggregate = inspectIssueReadiness(root, issue.id);

    expect(highRisk.ready).toBe(true);
    expect(highRisk.approvalSatisfied).toBe(true);
    expect(highRisk.blockers.some((entry) => entry.code === "RISK_CONFIRMATION_REQUIRED")).toBe(false);
    expect(ready.ready).toBe(true);
    expect(ready.warnings.some((entry) => entry.message.includes("No named checks"))).toBe(true);
    expect(aggregate.ready).toBe(true);
    expect(aggregate.readyTaskIds).toContain("T2");
    expect(aggregate.readyTaskIds).toContain("T1");
  });

  test("high-risk Tasks are directly executable without an approval queue", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Approval queue",
      tasks: [{
        title: "High-risk scoped change",
        objective: "Refactor the bounded security adapter.",
        allowedPaths: ["src/security/adapter.ts"],
        risk: "high",
      }],
    });
    const task = inspectTaskReadiness(root, issue.id, "T1");
    const aggregate = inspectIssueReadiness(root, issue.id);
    expect(task.ready).toBe(true);
    expect(task.queueable).toBe(true);
    expect(task.approvalSatisfied).toBe(true);
    expect(aggregate.ready).toBe(true);
    expect(aggregate.readyTaskIds).toEqual(["T1"]);
    expect(aggregate.approvalPendingTaskIds).toEqual([]);
  });

  test("missing named checks are completion warnings rather than launch blockers", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "No-check execution",
      tasks: [{
        title: "Read repository",
        objective: "Inspect and summarize repository state without modifying files.",
        risk: "readonly",
      }],
    });
    const readiness = inspectTaskReadiness(root, issue.id, "T1");
    expect(readiness.ready).toBe(true);
    expect(readiness.executionClass).toBe("read_only");
    expect(readiness.warnings.length).toBeGreaterThan(0);
  });

  test("read-only Tasks skip diff, named-check, and human acceptance gates", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Read-only completion",
      tasks: [{
        title: "Audit status",
        objective: "Inspect and report current status.",
        checks: ["optional-read-check"],
        acceptanceCriteria: ["Status is summarized."],
        risk: "readonly",
      }],
    });
    updateTask(root, issue.id, "T1", { status: "review" });
    const completed = recordTaskVerification(root, issue.id, "T1", {
      reviewer: "controller-test",
      checkResults: [],
      acceptanceResults: [],
      verifiedAt: new Date().toISOString(),
    });
    expect(completed.tasks[0]?.status).toBe("verified");
    expect(completed.tasks[0]?.verification?.autoCompleted).toBe(false);
  });

  test("real failed checks remain authoritative for change Tasks", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Failed check evidence",
      tasks: [{
        title: "Low-risk checked change",
        objective: "Update a bounded source file.",
        allowedPaths: ["src/checked.ts"],
        checks: ["unit"],
        risk: "low",
      }],
    });
    updateTask(root, issue.id, "T1", { status: "review" });
    const changed = recordTaskVerification(root, issue.id, "T1", {
      reviewer: "controller-test",
      checkResults: [{ checkId: "unit", ok: false, summary: "unit failed" }],
      acceptanceResults: [],
      verifiedAt: new Date().toISOString(),
    });
    expect(changed.tasks[0]?.status).toBe("changes_requested");
  });

  test("successful Run acceptance templates remain pending until independently evaluated", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Pending Run acceptance",
      tasks: [{
        title: "Medium change",
        objective: "Update a bounded source file.",
        allowedPaths: ["src/pending.ts"],
        acceptanceCriteria: ["The change behaves correctly."],
        risk: "medium",
      }],
    });
    updateTask(root, issue.id, "T1", { status: "review" });
    const pending = recordTaskVerification(root, issue.id, "T1", {
      runId: "RUN-pending-acceptance",
      reviewer: "controller",
      reviewedDiffHash: "sha256:pending-diff",
      checkResults: [],
      commandEvidence: [{ command: ["true"], ok: true, source: "controller" }],
      acceptanceResults: [{
        criterion: "The change behaves correctly.",
        ok: false,
        outcome: "not_evaluated",
        source: "run_completion",
        evidence: "Successful Run RUN-pending-acceptance; acceptance was not independently evaluated.",
      }],
      verifiedAt: new Date().toISOString(),
    });
    expect(pending.tasks[0]?.status).toBe("verifying");
  });

  test("legacy automatic successful-Run acceptance is not trusted as a pass", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Legacy Run acceptance",
      tasks: [{
        title: "Medium legacy change",
        objective: "Update a bounded source file.",
        allowedPaths: ["src/legacy.ts"],
        acceptanceCriteria: ["The legacy change behaves correctly."],
        risk: "medium",
      }],
    });
    updateTask(root, issue.id, "T1", { status: "review" });
    const pending = recordTaskVerification(root, issue.id, "T1", {
      runId: "RUN-legacy",
      reviewer: "legacy-controller",
      reviewedDiffHash: "sha256:legacy-diff",
      checkResults: [],
      commandEvidence: [{ command: ["true"], ok: true, source: "controller" }],
      acceptanceResults: [{
        criterion: "The legacy change behaves correctly.",
        ok: true,
        evidence: "Successful Run RUN-legacy.",
      }],
      verifiedAt: new Date().toISOString(),
    });
    expect(pending.tasks[0]?.status).toBe("verifying");
  });

  test("explicit acceptance failure still requests changes", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Failed acceptance",
      tasks: [{
        title: "Medium rejected change",
        objective: "Update a bounded source file.",
        allowedPaths: ["src/rejected.ts"],
        acceptanceCriteria: ["The change behaves correctly."],
        risk: "medium",
      }],
    });
    updateTask(root, issue.id, "T1", { status: "review" });
    const rejected = recordTaskVerification(root, issue.id, "T1", {
      reviewer: "human-reviewer",
      reviewedDiffHash: "sha256:rejected-diff",
      checkResults: [],
      commandEvidence: [{ command: ["true"], ok: true, source: "reported" }],
      acceptanceResults: [{
        criterion: "The change behaves correctly.",
        ok: false,
        outcome: "failed",
        source: "reported",
        evidence: "The observed behavior does not match the criterion.",
      }],
      verifiedAt: new Date().toISOString(),
    });
    expect(rejected.tasks[0]?.status).toBe("changes_requested");
  });

  test("high-risk Tasks accept reported command evidence but retain human acceptance", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "High-risk evidence",
      tasks: [{
        title: "Sensitive migration",
        objective: "Migrate a bounded schema safely.",
        allowedPaths: ["database/migrations/**"],
        acceptanceCriteria: ["Migration evidence is recorded."],
        risk: "high",
      }],
    });
    updateTask(root, issue.id, "T1", { status: "review" });
    const verified = recordTaskVerification(root, issue.id, "T1", {
      reviewer: "controller-test",
      reviewedDiffHash: "sha256:test-diff",
      checkResults: [],
      commandEvidence: [{
        command: ["migration-tool", "--dry-run"],
        ok: true,
        exitCode: 0,
        source: "reported",
      }],
      acceptanceResults: [{
        criterion: "Migration evidence is recorded.",
        ok: true,
        evidence: "Dry-run output reviewed.",
      }],
      verifiedAt: new Date().toISOString(),
    });
    expect(verified.tasks[0]?.status).toBe("verified");
    expect(verified.tasks[0]?.verification?.commandEvidence?.length).toBe(1);
  });

  test("multiple active Issues contribute independent ready Tasks to the board", () => {
    const root = repo();
    const first = createIssue(root, {
      title: "First active issue",
      tasks: [{ title: "First task", objective: "Edit first file.", allowedPaths: ["src/first.ts"], risk: "low" }],
    });
    const second = createIssue(root, {
      title: "Second active issue",
      tasks: [{ title: "Second task", objective: "Edit second file.", allowedPaths: ["src/second.ts"], risk: "low" }],
    });
    const board = projectBoard(root);
    expect(board.readyTasks.map((entry) => `${entry.issueId}/${entry.taskId}`)).toEqual(
      expect.arrayContaining([`${first.id}/T1`, `${second.id}/T1`]),
    );
    expect(listIssues(root)).toHaveLength(2);
  });

  test("replacement dependencies are not satisfied by legacy done labels without closure evidence", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Dependency migration",
      tasks: [
        { title: "Old", objective: "Old task.", risk: "low" },
        { title: "Replacement A", objective: "Replacement A.", risk: "low" },
        { title: "Replacement B", objective: "Replacement B.", risk: "low" },
        { title: "Downstream", objective: "Wait for replacements.", dependsOn: ["T1"], risk: "low" },
      ],
    });
    supersedeTask(root, issue.id, "T1", ["T2", "T3"]);
    updateTask(root, issue.id, "T2", { status: "done" });
    updateTask(root, issue.id, "T3", { status: "done" });
    const refreshed = listIssues(root).find((entry) => entry.id === issue.id)!;
    const states = resolveIssueTaskStates(refreshed);
    const dependency = resolveTaskDependencies(refreshed, refreshed.tasks[3]!, states);
    expect(dependency.ready).toBe(false);
    expect(dependency.pendingTaskIds).toEqual(["T2", "T3"]);
    expect(refreshed.tasks[3]!.dependsOn).toEqual(["T2", "T3"]);
    expect(dependency.supersededMigrations).toEqual([]);
  });

  test("progress follows live Run evidence instead of fixed lifecycle percentages", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Dynamic progress",
      tasks: [{ title: "Implement", objective: "Implement a low-risk change.", allowedPaths: ["src/value.ts"], risk: "low" }],
    });
    const runId = "RUN-dynamic-progress";
    writeRun(root, issue.id, "T1", runId, 20);
    updateTask(root, issue.id, "T1", { status: "running", runId });
    const first = getProjectProgress(root).issues.find((entry) => entry.id === issue.id)!.tasks[0]!.percent;
    writeRun(root, issue.id, "T1", runId, 80);
    const second = getProjectProgress(root).issues.find((entry) => entry.id === issue.id)!.tasks[0]!.percent;
    expect(second).toBeGreaterThan(first);
  });
  test("only overlapping active write scopes block concurrent launch", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Task-local concurrency",
      tasks: [
        { title: "Active writer", objective: "Edit shared source.", allowedPaths: ["src/shared/**"], risk: "low" },
        { title: "Conflicting writer", objective: "Edit the same shared source.", allowedPaths: ["src/shared/value.ts"], risk: "low" },
      ],
    });
    const runId = "RUN-active-scope";
    writeRun(root, issue.id, "T1", runId, 40, {
      executionClass: "low_risk_change",
      allowedPaths: ["src/shared/**"],
    });
    updateTask(root, issue.id, "T1", { status: "running", runId });
    expect(inspectTaskReadiness(root, issue.id, "T2").blockers.map((entry) => entry.code)).toContain("ACTIVE_SCOPE_CONFLICT");
    expect(() => startTaskJob({
      repoRoot: root,
      issueId: issue.id,
      taskId: "T2",
      agent: "codex",
      timeoutMs: 10_000,
      isolate: true,
    })).toThrow("ACTIVE_SCOPE_CONFLICT");
  });

  test("unresolved integration evidence blocks a later overlapping launch", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Drift prevention",
      tasks: [
        { title: "Pending integration", objective: "Edit shared source.", allowedPaths: ["src/shared/**"], risk: "low" },
        { title: "Later writer", objective: "Edit the same source.", allowedPaths: ["src/shared/value.ts"], risk: "low" },
      ],
    });
    const runId = "RUN-pending-integration";
    writeRun(root, issue.id, "T1", runId, 96, {
      executionClass: "low_risk_change",
      allowedPaths: ["src/shared/**"],
    });
    const metaPath = join(root, ".ai/harness/jobs", runId, "meta.json");
    const pending = JSON.parse(readFileSync(metaPath, "utf-8"));
    pending.status = "waiting_for_user";
    pending.closureState = "integration_blocked";
    pending.preservationReason = "overlapping_unmerged_work";
    pending.finishedAt = new Date().toISOString();
    writeFileSync(metaPath, `${JSON.stringify(pending, null, 2)}\n`);
    updateTask(root, issue.id, "T1", { status: "integration_blocked", runId });

    expect(() => startTaskJob({
      repoRoot: root,
      issueId: issue.id,
      taskId: "T2",
      agent: "codex",
      timeoutMs: 10_000,
      isolate: false,
    })).toThrow("DRIFT_PREVENTION_BLOCKED");
  });

  test("does not delete a live launch lock while allowing the current Controller to proceed", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Cross-process launch reservation",
      tasks: [{
        title: "Reserved workspace task",
        objective: "Update one bounded file.",
        allowedPaths: ["src/example.ts"],
        risk: "low",
      }],
    });
    const lockDir = join(root, ".ai/harness/controller");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "run-launch.lock"), `${JSON.stringify({
      pid: process.pid,
      createdAt: "2000-01-01T00:00:00.000Z",
    })}\n`);

    const lockPath = join(lockDir, "run-launch.lock");
    expect(readFileSync(lockPath, "utf-8")).toContain(`"pid":${process.pid}`);
    const run = startTaskJob({
      repoRoot: root,
      issueId: issue.id,
      taskId: "T1",
      agent: "codex",
      isolate: false,
      timeoutMs: 10_000,
    });
    expect(run.runId).toContain("RUN-");
  });

  test("queued Runs that never start become terminal unknown evidence with finishedAt", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Startup timeout",
      tasks: [{ title: "Launch", objective: "Launch a bounded task.", allowedPaths: ["src/start.ts"], risk: "low" }],
    });
    const runId = "RUN-startup-timeout";
    const dir = join(root, ".ai/harness/jobs", runId);
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    for (const file of ["stdout.log", "stderr.log", "events.jsonl"]) writeFileSync(join(dir, file), "");
    writeFileSync(join(dir, "meta.json"), `${JSON.stringify({
      schemaVersion: 2,
      runId,
      issueId: issue.id,
      taskId: "T1",
      agent: "codex",
      provider: "local",
      executionMode: "workspace",
      status: "queued",
      repoRoot: root,
      worktree: root,
      branch: null,
      baseRevision: null,
      promptPath: `.ai/harness/jobs/${runId}/prompt.md`,
      stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`,
      stderrPath: `.ai/harness/jobs/${runId}/stderr.log`,
      resultPath: `.ai/harness/jobs/${runId}/result.json`,
      eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`,
      workerPid: 99999999,
      startupDeadlineAt: "2000-01-01T00:00:00.000Z",
      createdAt: now,
    }, null, 2)}\n`);
    updateTask(root, issue.id, "T1", { runId });
    const run = getAgentJob(root, runId);
    expect(run.status).toBe("unknown");
    expect(run.finishedAt).toBeTruthy();
    expect(run.error).toContain("startup deadline");
    const refreshed = listIssues(root).find((entry) => entry.id === issue.id)!;
    expect(refreshed.tasks[0]!.status).toBe("blocked");
  });

  test("accepted Runs that never finish startup become terminal unknown evidence after restart-style reconciliation", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Accepted startup timeout",
      tasks: [{ title: "Launch", objective: "Launch a bounded task.", allowedPaths: ["src/start.ts"], risk: "low" }],
    });
    const runId = "RUN-accepted-startup-timeout";
    const dir = join(root, ".ai/harness/jobs", runId);
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    for (const file of ["stdout.log", "stderr.log", "events.jsonl"]) writeFileSync(join(dir, file), "");
    writeFileSync(join(dir, "meta.json"), `${JSON.stringify({
      schemaVersion: 3,
      repoId: "repo-test",
      checkoutId: "checkout-test",
      requestId: "accepted-timeout-1",
      runId,
      issueId: issue.id,
      taskId: "T1",
      agent: "codex",
      provider: "local",
      executionMode: "workspace",
      status: "starting",
      repoRoot: root,
      executionRoot: root,
      worktree: root,
      worktreePath: root,
      branch: null,
      baseRevision: null,
      promptPath: `.ai/harness/jobs/${runId}/prompt.md`,
      stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`,
      stderrPath: `.ai/harness/jobs/${runId}/stderr.log`,
      resultPath: `.ai/harness/jobs/${runId}/result.json`,
      eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`,
      launchPid: 99999999,
      startupDeadlineAt: "2000-01-01T00:00:00.000Z",
      createdAt: now,
      progress: {
        phase: "starting",
        percent: 2,
        currentActivity: "Accepted but never launched",
        lastActivityAt: now,
        activityCount: 0,
      },
    }, null, 2)}\n`);
    updateTask(root, issue.id, "T1", { status: "ready", runId });
    const run = getAgentJob(root, runId);
    expect(run.status).toBe("unknown");
    expect(run.finishedAt).toBeTruthy();
    expect(run.error).toContain("startup deadline");
    const refreshed = listIssues(root).find((entry) => entry.id === issue.id)!;
    expect(refreshed.tasks[0]!.status).toBe("blocked");
  });

  test("orphaned successful Run evidence verifies but cannot complete without integration evidence", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Terminal reconciliation",
      tasks: [{
        title: "Complete bounded change",
        objective: "Implement a bounded low-risk change.",
        allowedPaths: ["src/reconciled.ts"],
        risk: "low",
      }],
    });
    const runId = "RUN-terminal-reconcile";
    writeRun(root, issue.id, "T1", runId, 90, {
      executionClass: "low_risk_change",
      allowedPaths: ["src/reconciled.ts"],
    });
    updateTask(root, issue.id, "T1", { status: "running", runId });
    const dir = join(root, ".ai/harness/jobs", runId);
    writeFileSync(join(dir, "result.json"), `${JSON.stringify({
      ok: true,
      exitCode: 0,
      finishedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    const run = getAgentJob(root, runId);
    expect(run.status).toBe("succeeded");
    const refreshed = listIssues(root).find((entry) => entry.id === issue.id)!;
    expect(refreshed.tasks[0]!.status).toBe("verified");
    expect(refreshed.tasks[0]!.verification?.autoCompleted).toBe(false);
  });

  test("isolated Runs do not become succeeded before automatic integration finishes", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Auto integration recovery",
      tasks: [{
        title: "Preserve isolated change",
        objective: "Keep the worktree available when auto integration did not finish.",
        allowedPaths: ["src/recovered.ts"],
        risk: "low",
      }],
    });
    const runId = "RUN-auto-integration-recovery";
    const dir = join(root, ".ai/harness/jobs", runId);
    const worktree = join(root, ".ai/harness/worktrees", runId);
    mkdirSync(dir, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    const now = new Date().toISOString();
    for (const file of ["stdout.log", "stderr.log", "events.jsonl"]) writeFileSync(join(dir, file), "");
    writeFileSync(join(dir, "meta.json"), `${JSON.stringify({
      schemaVersion: 3,
      repoId: "repo-test",
      checkoutId: "checkout-test",
      runId,
      issueId: issue.id,
      taskId: "T1",
      agent: "codex",
      provider: "local",
      executionMode: "worktree",
      executionClass: "low_risk_change",
      allowedPaths: ["src/recovered.ts"],
      status: "running",
      repoRoot: root,
      executionRoot: worktree,
      worktree,
      worktreePath: worktree,
      branch: "controller/test",
      baseRevision: "HEAD",
      promptPath: `.ai/harness/jobs/${runId}/prompt.md`,
      stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`,
      stderrPath: `.ai/harness/jobs/${runId}/stderr.log`,
      resultPath: `.ai/harness/jobs/${runId}/result.json`,
      eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`,
      workerPid: 99999999,
      autoIntegrate: true,
      createdAt: now,
      startedAt: now,
      lastHeartbeatAt: now,
      progress: {
        phase: "finalizing",
        percent: 96,
        currentActivity: "Agent implementation finished; automatic integration is finalizing",
        lastActivityAt: now,
        activityCount: 1,
      },
    }, null, 2)}\n`);
    updateTask(root, issue.id, "T1", { status: "running", runId });
    writeFileSync(join(dir, "result.json"), `${JSON.stringify({
      ok: true,
      exitCode: 0,
      finishedAt: new Date().toISOString(),
    }, null, 2)}\n`);

    const run = getAgentJob(root, runId);
    expect(run.status).toBe("waiting_for_user");
    expect(run.autoIntegrationError).toContain("automatic worktree integration did not finish");
    expect(run.closureState).toBe("preserved");
    expect(run.preservationReason).toBe("integration_failed");
    expect(run.integratedSessionId).toBeUndefined();
    expect(run.finishedAt).toBeUndefined();

    const refreshed = listIssues(root).find((entry) => entry.id === issue.id)!;
    expect(refreshed.tasks[0]!.status).toBe("review");
    expect(refreshed.tasks[0]!.notes.at(-1)).toContain("Automatic integration did not finish");
  });

  test("treats PPID=1 workers as disconnected ownership", () => {
    const now = new Date().toISOString();
    const invalidation = invalidateAgentWorker({
      schemaVersion: 3,
      runId: "RUN-ppid-orphan",
      issueId: "ISS-1",
      taskId: "T1",
      agent: "codex",
      provider: "local",
      executionMode: "workspace",
      status: "running",
      repoRoot: "/repo",
      worktree: "/repo",
      worktreePath: "/repo",
      branch: null,
      baseRevision: null,
      promptPath: "prompt.md",
      stdoutPath: "stdout.log",
      stderrPath: "stderr.log",
      resultPath: "result.json",
      eventsPath: "events.jsonl",
      workerPid: 321,
      createdAt: now,
      startedAt: now,
    }, {
      parentPid: 123,
    }, {
      currentParentPid: 1,
      workerPid: 321,
    });
    expect(invalidation?.code).toBe("PARENT_DISCONNECTED");
    expect(invalidation?.message).toContain("PPID became 1");
  });

  test("hands a live owned finalizer across a Controller epoch change without weakening Worker fencing", () => {
    const now = new Date().toISOString();
    const finalizing = {
      schemaVersion: 3,
      runId: "RUN-finalizer-handoff",
      issueId: "ISS-1",
      taskId: "T1",
      agent: "codex",
      provider: "local",
      executionMode: "worktree",
      status: "running",
      repoRoot: "/repo",
      worktree: "/repo/worktree",
      branch: "controller/finalizer",
      baseRevision: "base",
      promptPath: "prompt.md",
      stdoutPath: "stdout.log",
      stderrPath: "stderr.log",
      resultPath: "result.json",
      eventsPath: "events.jsonl",
      workerPid: 321,
      autoIntegrate: true,
      progress: {
        phase: "finalizing",
        percent: 96,
        currentActivity: "finalizing",
        lastActivityAt: now,
        activityCount: 1,
      },
      createdAt: now,
    } satisfies AgentJobMeta;
    const epochChanged = {
      code: "CONTROLLER_EPOCH_STALE",
      message: "Controller ownership epoch changed",
    } as const;

    expect(shouldTolerateOwnedFinalizationInvalidation(finalizing, epochChanged, {
      workerPid: 321,
      childExited: true,
    })).toBe(true);
    expect(shouldTolerateOwnedFinalizationInvalidation(finalizing, epochChanged, {
      workerPid: 999,
      childExited: true,
    })).toBe(false);
    expect(shouldTolerateOwnedFinalizationInvalidation(finalizing, {
      code: "WORKER_REPLACED",
      message: "Run belongs to another Worker",
    }, {
      workerPid: 321,
      childExited: true,
    })).toBe(false);
  });

  test("does not confuse a PID-reused process with the expected Agent Worker command", () => {
    const configPath = "/repo/.ai/harness/jobs/RUN-1/worker-config.json";
    expect(matchesAgentWorkerCommand(
      `/usr/bin/node /repo/src/cli/agent-jobs/job-worker.ts ${configPath}`,
      configPath,
    )).toBe(true);
    expect(matchesAgentWorkerCommand("/usr/bin/node unrelated-server.js", configPath)).toBe(false);
    expect(matchesAgentWorkerCommand(
      "/usr/bin/node /repo/src/cli/agent-jobs/job-worker.ts /repo/.ai/harness/jobs/RUN-2/worker-config.json",
      configPath,
    )).toBe(false);
    expect(matchesAgentWorkerCommand(
      `/usr/bin/node unrelated.js --log=job-worker.ts ${configPath}`,
      configPath,
    )).toBe(false);
  });

});
