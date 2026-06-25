import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { getAgentJob } from "../../src/cli/agent-jobs/job-manager";
import { controllerCheckConcurrencyClass, runControllerCheckAsync } from "../../src/cli/controller/check-runner";
import { CONTROLLER_TOOL_SURFACE } from "../../src/cli/controller/runtime-config";
import { createIssue, updateTask } from "../../src/cli/controller/issue-store";
import { beginEditSession, applyEditOperations } from "../../src/cli/editing/edit-session";
import { getMcpPolicy } from "../../src/cli/mcp/policy";
import {
  executeLocalBridgeJob,
  getLocalBridgeJob,
  listLocalBridgeJobs,
  reconcileLocalBridgeJobs,
  submitLocalBridgeJob,
} from "../../src/cli/local-bridge/job-store";
import {
  startLocalBridgeServer,
  type LocalBridgeServerHandle,
} from "../../src/cli/local-bridge/server";

const roots: string[] = [];
const servers: LocalBridgeServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-harness-local-bridge-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, ".ai/harness"), { recursive: true });
  writeFileSync(join(root, "src/example.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "tasks/current.md"), "# Current\n");
  return root;
}

function fakeCodex(): { binRoot: string; restore(): void } {
  const binRoot = mkdtempSync(join(tmpdir(), "repo-harness-local-bridge-bin-"));
  roots.push(binRoot);
  const originalPath = process.env.PATH;
  const executable = join(binRoot, "codex");
  writeFileSync(
    executable,
    '#!/usr/bin/env bash\necho "local-bridge-codex-ok"\n',
  );
  chmodSync(executable, 0o755);
  process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
  return {
    binRoot,
    restore: () => {
      process.env.PATH = originalPath;
    },
  };
}

async function waitForRun(
  root: string,
  runId: string,
  predicate: (run: ReturnType<typeof getAgentJob>) => boolean,
  attempts = 120,
  delayMs = 25,
) {
  let run = getAgentJob(root, runId);
  for (let attempt = 0; attempt < attempts && !predicate(run); attempt += 1) {
    await Bun.sleep(delayMs);
    run = getAgentJob(root, runId);
  }
  return run;
}

describe("Local Execution Bridge", () => {
  test("auto-dispatches a low-risk Task through the persistent Run system", async () => {
    const root = repo();
    const codex = fakeCodex();
    try {
      const issue = createIssue(root, {
        title: "Local bridge task",
        summary: "Run one local Task.",
        goals: ["Start Codex without a shell command."],
        acceptanceCriteria: ["The Run succeeds."],
        tasks: [
          {
            title: "Execute",
            objective: "Run the fake Codex worker.",
            allowedPaths: ["src/**"],
            checks: ["manual"],
            acceptanceCriteria: ["The Run succeeds."],
            risk: "low",
            recommendedAgent: "codex",
          },
        ],
      });
      const submitted = submitLocalBridgeJob(root, {
        action: "launch-task",
        requestedBy: "test",
        payload: {
          issueId: issue.id,
          taskId: "T1",
          agent: "codex",
          executionMode: "auto",
          timeoutMs: 10_000,
        },
      });
      expect(submitted.status).toBe("approved");
      const dispatched = executeLocalBridgeJob(root, submitted.jobId);
      expect(dispatched.status).toBe("dispatched");
      expect(dispatched.runId).toBeTruthy();
      let run = await waitForRun(root, dispatched.runId as string, (value) => ["succeeded", "failed"].includes(value.status));
      expect(run.status).toBe("succeeded");
      expect(run.executionMode).toBe("workspace");
      expect(run.stdoutTail).toContain("local-bridge-codex-ok");
    } finally {
      codex.restore();
    }
  });

  test("uses the current workspace for one Run and auto-integrates a concurrent worktree Run", async () => {
    const root = repo();
    writeFileSync(join(root, "src/first.ts"), "export const first = 0;\n");
    writeFileSync(join(root, "src/second.ts"), "export const second = 0;\n");
    expect(spawnSync("git", ["init"], { cwd: root }).status).toBe(0);
    expect(
      spawnSync("git", ["config", "user.email", "test@example.com"], {
        cwd: root,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "Test"], { cwd: root }).status,
    ).toBe(0);
    expect(spawnSync("git", ["add", "."], { cwd: root }).status).toBe(0);
    expect(
      spawnSync("git", ["commit", "-m", "initial"], { cwd: root }).status,
    ).toBe(0);

    const binRoot = mkdtempSync(join(tmpdir(), "repo-harness-auto-mode-bin-"));
    roots.push(binRoot);
    const originalPath = process.env.PATH;
    const executable = join(binRoot, "codex");
    writeFileSync(
      executable,
      `#!/usr/bin/env bash
case "$*" in
  *"First workspace task"*)
    printf '%s\n' '{"type":"turn.started"}'
    sleep 0.8
    printf 'export const first = 1;\n' > src/first.ts
    ;;
  *)
    printf '%s\n' '{"type":"turn.started"}'
    printf 'export const second = 2;\n' > src/second.ts
    printf '%s\n' '{"type":"item.completed","item":{"type":"file_change","path":"src/second.ts"}}'
    ;;
esac
`,
    );
    chmodSync(executable, 0o755);
    process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
    try {
      const issue = createIssue(root, {
        title: "Automatic execution placement",
        summary: "Use the main workspace until concurrency requires isolation.",
        goals: ["Avoid unnecessary worktrees."],
        acceptanceCriteria: ["Both changes reach the current workspace."],
        tasks: [
          {
            title: "First workspace task",
            objective: "Keep the first Run active in the current workspace.",
            allowedPaths: ["src/first.ts"],
            checks: ["manual"],
            acceptanceCriteria: ["first.ts is updated."],
            risk: "low",
            recommendedAgent: "codex",
          },
          {
            title: "Second concurrent task",
            objective: "Use a temporary worktree and merge immediately.",
            allowedPaths: ["src/second.ts"],
            checks: ["manual"],
            acceptanceCriteria: ["second.ts is updated."],
            risk: "low",
            recommendedAgent: "codex",
          },
        ],
      });
      const firstJob = submitLocalBridgeJob(root, {
        action: "launch-task",
        requestedBy: "test",
        payload: {
          issueId: issue.id,
          taskId: "T1",
          agent: "codex",
          executionMode: "auto",
          timeoutMs: 10_000,
        },
      });
      const firstDispatch = executeLocalBridgeJob(root, firstJob.jobId);
      let first = await waitForRun(root, firstDispatch.runId as string, (value) => value.status === "running", 80);
      expect(first.executionMode).toBe("workspace");
      expect(first.status).toBe("running");

      const secondJob = submitLocalBridgeJob(root, {
        action: "launch-task",
        requestedBy: "test",
        payload: {
          issueId: issue.id,
          taskId: "T2",
          agent: "codex",
          executionMode: "auto",
          timeoutMs: 10_000,
        },
      });
      const secondDispatch = executeLocalBridgeJob(root, secondJob.jobId);
      let second = await waitForRun(root, secondDispatch.runId as string, (value) => value.executionMode === "worktree" || value.status === "failed", 120);
      expect(second.executionMode).toBe("worktree");
      const temporaryWorktree = second.worktree;
      second = await waitForRun(root, secondDispatch.runId as string, (value) => Boolean(value.worktreeCleanedAt || value.autoIntegrationError || value.status === "failed"), 1200);
      expect(second.status).toBe("succeeded");
      expect(second.autoIntegrationError).toBeUndefined();
      expect(second.integratedSessionId).toBeTruthy();
      expect(second.worktreeCleanedAt).toBeTruthy();
      for (let attempt = 0; attempt < 40 && existsSync(temporaryWorktree); attempt += 1) {
        await Bun.sleep(25);
      }
      expect(existsSync(temporaryWorktree)).toBe(false);
      expect(readFileSync(join(root, "src/second.ts"), "utf-8")).toContain(
        "second = 2",
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("parses agent output into visible phase and activity progress", async () => {
    const root = repo();
    const binRoot = mkdtempSync(join(tmpdir(), "repo-harness-progress-bin-"));
    roots.push(binRoot);
    const originalPath = process.env.PATH;
    const executable = join(binRoot, "codex");
    writeFileSync(
      executable,
      `#!/usr/bin/env bash
printf '%s\n' '{"type":"thread.started"}' '{"type":"turn.started"}' '{"type":"item.started","item":{"type":"command_execution","command":"bun test focused"}}'
sleep 0.4
printf '%s\n' '{"type":"turn.completed"}'
`,
    );
    chmodSync(executable, 0o755);
    process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
    try {
      const issue = createIssue(root, {
        title: "Visible progress",
        summary: "Parse structured Codex events.",
        goals: ["Show the current activity."],
        acceptanceCriteria: ["Progress is visible before completion."],
        tasks: [
          {
            title: "Observe",
            objective: "Emit structured events.",
            allowedPaths: ["src/**"],
            checks: ["focused"],
            acceptanceCriteria: ["Progress is visible before completion."],
            risk: "low",
            recommendedAgent: "codex",
          },
        ],
      });
      const job = submitLocalBridgeJob(root, {
        action: "launch-task",
        payload: {
          issueId: issue.id,
          taskId: "T1",
          agent: "codex",
          executionMode: "auto",
          timeoutMs: 10_000,
        },
      });
      const dispatched = executeLocalBridgeJob(root, job.jobId);
      let run = getAgentJob(root, dispatched.runId as string);
      let observed = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await Bun.sleep(20);
        run = getAgentJob(root, dispatched.runId as string);
        if (
          run.progress?.phase === "testing" &&
          run.progress.currentActivity.includes("bun test focused")
        ) {
          observed = true;
          break;
        }
      }
      expect(observed).toBe(true);
      expect(run.progress?.percent).toBeGreaterThanOrEqual(72);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("runs checks without blocking Controller health and deduplicates only active checks", async () => {
    const root = repo();
    mkdirSync(join(root, ".repo-harness"), { recursive: true });
    writeFileSync(join(root, ".repo-harness/checks.json"), JSON.stringify({
      version: 1,
      checks: {
        delayed: {
          command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 500)"],
          timeoutMs: 8_000,
        },
      },
    }));
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0, openBrowser: false });
    servers.push(handle);
    const headers = {
      "x-repo-harness-local-token": handle.token,
      "content-type": "application/json",
    };

    const startedAt = Date.now();
    const created = await fetch(new URL("/api/jobs", handle.url), {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "run-check",
        requestedBy: "test",
        payload: { checkId: "delayed", timeoutMs: 8_000 },
      }),
    }).then((response) => response.json());
    expect(Date.now() - startedAt).toBeLessThan(3_500);
    expect(["approved", "running"]).toContain(created.status);

    const health = await fetch(new URL("/health", handle.url)).then((response) => response.json());
    expect(health.status).toBe("ok");

    const duplicate = submitLocalBridgeJob(root, {
      action: "run-check",
      requestedBy: "test",
      payload: { checkId: "delayed", timeoutMs: 8_000 },
    });
    expect(duplicate.jobId).toBe(created.jobId);

    let finished = getLocalBridgeJob(root, created.jobId);
    for (let attempt = 0; attempt < 300 && finished.status === "running"; attempt += 1) {
      await Bun.sleep(25);
      finished = getLocalBridgeJob(root, created.jobId);
    }
    expect(finished.status).toBe("succeeded");
    expect(finished.finishedAt).toBeTruthy();
    expect(finished.workerPid).toBeUndefined();

    const rerun = submitLocalBridgeJob(root, {
      action: "run-check",
      requestedBy: "test",
      payload: { checkId: "delayed", timeoutMs: 8_000 },
    });
    expect(rerun.jobId).not.toBe(created.jobId);
    expect(rerun.status).toBe("approved");
  });

  test("rebuilds the active check index beyond recent history and keeps listings bounded", () => {
    const root = repo();
    const active = submitLocalBridgeJob(root, {
      action: "run-check",
      requestedBy: "test",
      payload: { checkId: "older-active", timeoutMs: 8_000 },
    });
    const jobRoot = join(root, ".ai/harness/local-jobs");
    const historyBase = Date.now() + 10_000;
    for (let index = 0; index < 125; index += 1) {
      const jobId = `JOB-${historyBase + index}-history-${String(index).padStart(3, "0")}`;
      const directory = join(jobRoot, jobId);
      const at = new Date(historyBase + index).toISOString();
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "job.json"), `${JSON.stringify({
        ...active,
        jobId,
        payload: { checkId: `history-${index}`, timeoutMs: 8_000 },
        status: "succeeded",
        createdAt: at,
        updatedAt: at,
        finishedAt: at,
      }, null, 2)}\n`);
    }

    rmSync(join(jobRoot, "active-index.json"), { force: true });
    const duplicate = submitLocalBridgeJob(root, {
      action: "run-check",
      requestedBy: "test",
      payload: { checkId: "older-active", timeoutMs: 8_000 },
    });
    expect(duplicate.jobId).toBe(active.jobId);

    const recent = listLocalBridgeJobs(root, 5);
    expect(recent).toHaveLength(5);
    expect(recent.some((job) => job.jobId === active.jobId)).toBe(false);

    const terminalAt = new Date().toISOString();
    writeFileSync(join(jobRoot, active.jobId, "job.json"), `${JSON.stringify({
      ...active,
      status: "succeeded",
      updatedAt: terminalAt,
      finishedAt: terminalAt,
    }, null, 2)}\n`);
    rmSync(join(jobRoot, "active-index.json"), { force: true });

    const replacement = submitLocalBridgeJob(root, {
      action: "run-check",
      requestedBy: "test",
      payload: { checkId: "older-active", timeoutMs: 8_000 },
    });
    expect(replacement.jobId).not.toBe(active.jobId);
    expect(replacement.status).toBe("approved");
  });

  test("deduplicates concurrent launch-task submissions with the same requestId", async () => {
    const root = repo();
    const codex = fakeCodex();
    try {
      const issue = createIssue(root, {
        title: "Bridge request idempotency",
        tasks: [
          {
            title: "Execute once",
            objective: "Collapse duplicate launch-task requests.",
            allowedPaths: ["src/**"],
            checks: ["manual"],
            acceptanceCriteria: ["Only one Run is created."],
            risk: "low",
            recommendedAgent: "codex",
          },
        ],
      });
      const [firstJob, secondJob] = await Promise.all([
        Promise.resolve(submitLocalBridgeJob(root, {
          action: "launch-task",
          requestedBy: "test",
          payload: {
            issueId: issue.id,
            taskId: "T1",
            agent: "codex",
            executionMode: "auto",
            timeoutMs: 10_000,
            requestId: "bridge-req-1",
          },
        })),
        Promise.resolve(submitLocalBridgeJob(root, {
          action: "launch-task",
          requestedBy: "test",
          payload: {
            issueId: issue.id,
            taskId: "T1",
            agent: "codex",
            executionMode: "auto",
            timeoutMs: 10_000,
            requestId: "bridge-req-1",
          },
        })),
      ]);
      expect(secondJob.jobId).toBe(firstJob.jobId);
      const dispatched = executeLocalBridgeJob(root, firstJob.jobId);
      let run = await waitForRun(root, dispatched.runId as string, (value) => ["succeeded", "failed"].includes(value.status));
      expect(run.status).toBe("succeeded");
      expect(listLocalBridgeJobs(root).filter((entry) => entry.jobId === firstJob.jobId)).toHaveLength(1);
    } finally {
      codex.restore();
    }
  });

  test("classifies full repository gates as heavy while leaving focused checks concurrent", () => {
    expect(controllerCheckConcurrencyClass("package:test")).toBe("heavy");
    expect(controllerCheckConcurrencyClass("package:check:controller-v8")).toBe("heavy");
    expect(controllerCheckConcurrencyClass("package:check:release-surface")).toBe("heavy");
    expect(controllerCheckConcurrencyClass("focused")).toBe("light");
    expect(controllerCheckConcurrencyClass("package:check:type")).toBe("light");
  });

  test("waits for a repository heavy-check lock held by another Controller", async () => {
    const root = repo();
    mkdirSync(join(root, ".repo-harness"), { recursive: true });
    mkdirSync(join(root, ".ai/harness/controller"), { recursive: true });
    writeFileSync(join(root, ".repo-harness/checks.json"), JSON.stringify({
      version: 1,
      checks: {
        "check:release": {
          command: [process.execPath, "-e", "process.exit(0)"],
          timeoutMs: 5_000,
        },
      },
    }));
    const lockPath = join(root, ".ai/harness/controller/heavy-check.lock");
    writeFileSync(lockPath, `${JSON.stringify({
      lockId: "external-controller",
      controllerPid: process.pid,
      checkId: "package:test",
      createdAt: new Date().toISOString(),
    })}\n`);
    const pids: number[] = [];
    const pending = runControllerCheckAsync(root, "check:release", {
      onSpawn: (pid) => pids.push(pid),
    });
    await Bun.sleep(150);
    expect(pids).toHaveLength(0);
    rmSync(lockPath, { force: true });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(pids).toHaveLength(1);
  });

  test("notifies every subscriber when a deduplicated check spawns", async () => {
    const root = repo();
    mkdirSync(join(root, ".repo-harness"), { recursive: true });
    writeFileSync(join(root, ".repo-harness/checks.json"), JSON.stringify({
      version: 1,
      checks: {
        shared: {
          command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 500)"],
          timeoutMs: 5_000,
        },
      },
    }));
    const firstPids: number[] = [];
    const secondPids: number[] = [];
    const first = runControllerCheckAsync(root, "shared", {
      onSpawn: (pid) => firstPids.push(pid),
    });
    await Bun.sleep(25);
    const second = runControllerCheckAsync(root, "shared", {
      onSpawn: (pid) => secondPids.push(pid),
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.executedAt).toBe(firstResult.executedAt);
    expect(firstPids).toHaveLength(1);
    expect(secondPids).toEqual(firstPids);
  });

  test("does not time out a queued check before its worker spawns", () => {
    const root = repo();
    mkdirSync(join(root, ".repo-harness"), { recursive: true });
    writeFileSync(join(root, ".repo-harness/checks.json"), JSON.stringify({
      version: 1,
      checks: {
        focused: { command: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 5_000 },
      },
    }));
    const job = submitLocalBridgeJob(root, {
      action: "run-check",
      requestedBy: "test",
      payload: { checkId: "focused", timeoutMs: 5_000 },
    });
    const path = join(root, ".ai/harness/local-jobs", job.jobId, "job.json");
    const queued = JSON.parse(readFileSync(path, "utf-8"));
    queued.status = "running";
    queued.startedAt = new Date(Date.now() - 60_000).toISOString();
    queued.updatedAt = queued.startedAt;
    queued.ownerPid = process.pid;
    delete queued.deadlineAt;
    delete queued.workerPid;
    writeFileSync(path, `${JSON.stringify(queued, null, 2)}\n`);

    expect(getLocalBridgeJob(root, job.jobId).status).toBe("running");
  });

  test("reconciles stale running checks after a Controller restart", () => {
    const root = repo();
    mkdirSync(join(root, ".repo-harness"), { recursive: true });
    writeFileSync(join(root, ".repo-harness/checks.json"), JSON.stringify({
      version: 1,
      checks: {
        focused: { command: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 5_000 },
      },
    }));
    const job = submitLocalBridgeJob(root, {
      action: "run-check",
      requestedBy: "test",
      payload: { checkId: "focused", timeoutMs: 5_000 },
    });
    const path = join(root, ".ai/harness/local-jobs", job.jobId, "job.json");
    const stale = JSON.parse(readFileSync(path, "utf-8"));
    stale.status = "running";
    stale.startedAt = new Date(Date.now() - 60_000).toISOString();
    stale.updatedAt = stale.startedAt;
    stale.deadlineAt = new Date(Date.now() - 1_000).toISOString();
    stale.ownerPid = 999_999;
    writeFileSync(path, `${JSON.stringify(stale, null, 2)}\n`);

    const reconciled = reconcileLocalBridgeJobs(root);
    const refreshed = getLocalBridgeJob(root, job.jobId);
    expect(reconciled.terminalized).toBe(1);
    expect(refreshed.status).toBe("timed_out");
    expect(refreshed.finishedAt).toBeTruthy();
    expect(refreshed.error).toContain("deadline");
  });

  test("accepts high-risk quick sessions immediately without an approval queue", () => {
    const root = repo();
    const job = submitLocalBridgeJob(root, {
      action: "quick-agent-session",
      requestedBy: "chatgpt",
      payload: {
        title: "High risk local change",
        objective: "Inspect a risky project-level change.",
        allowedPaths: ["src/**"],
        checks: ["manual"],
        risk: "high",
        agent: "codex",
      },
    });
    expect(job.status).toBe("approved");
    expect(job.approval).toBe("auto");
    expect(listLocalBridgeJobs(root)[0]?.jobId).toBe(job.jobId);
  });

  test("does not create an approval queue for ordinary local work", () => {
    const root = repo();
    const job = submitLocalBridgeJob(root, {
      action: "quick-agent-session",
      requestedBy: "local-ui",
      payload: {
        title: "Ordinary local session",
        objective: "Run ordinary bounded local work.",
        allowedPaths: ["src/**"],
        risk: "low",
        agent: "codex",
      },
    });
    expect(job.status).toBe("approved");
    expect(job.approval).toBe("auto");
  });

  test("serves V5 focus, governance, direct action, worklog, and GitHub plugin APIs", async () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "V5 API surface",
      summary: "Expose progress and evidence.",
      goals: ["Inspect one Task."],
      acceptanceCriteria: ["The V5 endpoints respond."],
      tasks: [{
        title: "Inspect",
        objective: "Return Task detail and timeline.",
        allowedPaths: ["src/**"],
        checks: ["focused"],
        acceptanceCriteria: ["Visible"],
        risk: "low",
      }],
    });
    mkdirSync(join(root, ".repo-harness"), { recursive: true });
    writeFileSync(join(root, ".repo-harness/checks.json"), JSON.stringify({
      version: 1,
      checks: { focused: { command: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 10_000 } },
    }));
    const runId = "RUN-v5-api-succeeded";
    const runDir = join(root, ".ai/harness/jobs", runId);
    mkdirSync(runDir, { recursive: true });
    const now = new Date().toISOString();
    for (const name of ["stdout.log", "stderr.log", "events.jsonl"]) writeFileSync(join(runDir, name), "");
    writeFileSync(join(runDir, "meta.json"), JSON.stringify({
      schemaVersion: 2, runId, issueId: issue.id, taskId: "T1", agent: "codex", provider: "local", executionMode: "workspace", status: "succeeded", repoRoot: root, worktree: root, branch: null, baseRevision: null, promptPath: `.ai/harness/jobs/${runId}/prompt.md`, stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`, stderrPath: `.ai/harness/jobs/${runId}/stderr.log`, resultPath: `.ai/harness/jobs/${runId}/result.json`, eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`, timeoutMs: 10_000, createdAt: now, startedAt: now, finishedAt: now, progress: { phase: "completed", percent: 100, currentActivity: "complete", lastActivityAt: now, activityCount: 1 },
    }, null, 2));
    updateTask(root, issue.id, "T1", { status: "review", runId, note: "Ready for verification." });
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0, openBrowser: false });
    servers.push(handle);
    const headers = { "x-repo-harness-local-token": handle.token };

    const progress = await fetch(new URL("/api/progress", handle.url), { headers }).then((response) => response.json());
    expect(progress.issueCount).toBe(1);
    expect(progress.issues[0].id).toBe(issue.id);
    const focused = await fetch(new URL(`/api/issues/${issue.id}/focus`, handle.url), { method: "POST", headers }).then((response) => response.json());
    expect(focused.currentIssueId).toBe(issue.id);
    const governance = await fetch(new URL("/api/governance", handle.url), { headers }).then((response) => response.json());
    expect(governance.currentIssueId).toBe(issue.id);
    expect(governance.executionQueue[0].taskId).toBe("T1");

    const detail = await fetch(new URL(`/api/issues/${issue.id}/tasks/T1`, handle.url), { headers }).then((response) => response.json());
    expect(detail.task.id).toBe("T1");
    expect(detail.timeline.some((event: { action: string }) => event.action === "issue_created")).toBe(true);

    const verified = await fetch(new URL(`/api/issues/${issue.id}/tasks/T1/verify`, handle.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ confirmAcceptance: true, reviewer: "test-human" }),
    }).then((response) => response.json());
    expect(verified.tasks[0].status).toBe("done");
    expect(existsSync(join(root, ".ai/harness/checks/controller/latest-focused.json"))).toBe(true);
    const accepted = await fetch(new URL(`/api/issues/${issue.id}/tasks/T1/accept`, handle.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    }).then((response) => response.json());
    expect(accepted.tasks[0].status).toBe("done");

    const configured = await fetch(new URL("/api/github/plugin", handle.url), {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, repository: "owner/repo", syncMode: "checkpoint" }),
    }).then((response) => response.json());
    expect(configured.enabled).toBe(true);
    expect(configured.syncMode).toBe("checkpoint");

    const exported = await fetch(new URL("/api/worklog/export", handle.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ outputPath: "tasks/reports/controller-v5.md" }),
    }).then((response) => response.json());
    expect(exported.eventCount).toBeGreaterThan(0);
    expect(existsSync(join(root, exported.path))).toBe(true);
  });


  test("shows direct edits as first-class file changes and completes them through the local API", async () => {
    const root = repo();
    const session = beginEditSession(root, {
      purpose: "Update local example",
      allowedPaths: ["src/**"],
      maxFiles: 1,
      maxChangedLines: 5,
    });
    const current = readFileSync(join(root, "src/example.ts"), "utf-8");
    const hash = new Bun.CryptoHasher("sha256").update(current).digest("hex");
    applyEditOperations(root, getMcpPolicy("controller", { repoRoot: root }), session.sessionId, [{
      type: "replace",
      path: "src/example.ts",
      expectedSha256: hash,
      replacements: [{ oldText: "value = 1", newText: "value = 4" }],
    }]);
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0, openBrowser: false });
    servers.push(handle);
    const headers = { "x-repo-harness-local-token": handle.token };
    const snapshot = await fetch(new URL("/api/snapshot", handle.url), { headers }).then((response) => response.json());
    expect(snapshot.editSessions[0]).toMatchObject({ sessionId: session.sessionId, status: "dirty", changedFiles: 1 });
    const diff = await fetch(new URL(`/api/edit-sessions/${session.sessionId}/diff`, handle.url), { headers }).then((response) => response.json());
    expect(diff.patch).toContain("+export const value = 4;");
    const verified = await fetch(new URL(`/api/edit-sessions/${session.sessionId}/verify`, handle.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "local-test" }),
    }).then((response) => response.json());
    expect(verified.status).toBe("checked");
    const finalized = await fetch(new URL(`/api/edit-sessions/${session.sessionId}/finalize`, handle.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "local-test" }),
    }).then((response) => response.json());
    expect(finalized.status).toBe("finalized");
    const dashboard = await fetch(handle.url).then((response) => response.text());
    expect(dashboard).toContain("开放 Direct Edit");
    expect(dashboard).toContain("Direct Edit");
  });

  test("serves a hardened localhost visual control surface", async () => {
    const root = repo();
    const handle = await startLocalBridgeServer({
      repoRoot: root,
      port: 0,
      openBrowser: false,
    });
    servers.push(handle);

    const health = await fetch(new URL("/health", handle.url)).then(
      (response) => response.json(),
    );
    expect(health.status).toBe("ok");
    expect(health.localOnly).toBe(true);
    expect(health.repoRoot).toBeUndefined();
    expect(health.timeoutPolicy).toBeUndefined();
    expect(health.features).toBeUndefined();

    const denied = await fetch(new URL("/api/snapshot", handle.url));
    expect(denied.status).toBe(403);
    const deniedQueryToken = await fetch(
      new URL(`/api/snapshot?token=${encodeURIComponent(handle.token)}`, handle.url),
    );
    expect(deniedQueryToken.status).toBe(403);

    const rejectedOrigin = await fetch(new URL("/api/snapshot", handle.url), {
      headers: {
        origin: "https://malicious.example",
        "x-repo-harness-local-token": handle.token,
      },
    });
    expect(rejectedOrigin.status).toBe(403);

    const snapshot = await fetch(new URL("/api/snapshot", handle.url), {
      headers: { "x-repo-harness-local-token": handle.token },
    }).then((response) => response.json());
    expect(snapshot.repoRoot).toBe(root);
    expect(snapshot.board).toBeDefined();
    expect(snapshot.toolSurface).toBe(CONTROLLER_TOOL_SURFACE);
    expect(snapshot.timeoutPolicy).toEqual({
      defaultTimeoutMs: 3_600_000,
      maxTimeoutMs: 43_200_000,
    });

    const dashboardResponse = await fetch(handle.url);
    expect(dashboardResponse.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(dashboardResponse.headers.get("pragma")).toBe("no-cache");
    expect(dashboardResponse.headers.get("expires")).toBe("0");
    expect(dashboardResponse.headers.get("referrer-policy")).toBe("no-referrer");
    const setCookie = dashboardResponse.headers.get("set-cookie");
    expect(setCookie).toContain("Path=/api");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const cookieSnapshot = await fetch(new URL("/api/snapshot", handle.url), {
      headers: { cookie: cookie as string },
    }).then((response) => response.json());
    expect(cookieSnapshot.repoRoot).toBe(root);

    const dashboard = await dashboardResponse.text();
    expect(dashboard).not.toContain(handle.token);
    expect(dashboard).not.toContain("?token=");
    expect(dashboard).toContain("repo-harness V8");
    expect(dashboard).toContain("ChatGPT execution bridge");
    expect(dashboard).toContain("执行安全状态修复");
  });
});
