import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { getAgentJob } from "../../src/cli/agent-jobs/job-manager";
import { createIssue } from "../../src/cli/controller/issue-store";
import {
  executeLocalBridgeJob,
  submitLocalBridgeJob,
} from "../../src/cli/local-bridge/job-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-harness-codex-args-"));
  const controllerHome = mkdtempSync(join(tmpdir(), "repo-harness-codex-args-home-"));
  roots.push(root, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, ".ai/harness"), { recursive: true });
  mkdirSync(join(root, ".repo-harness"), { recursive: true });
  writeFileSync(join(root, ".repo-harness/mcp.local.json"), `${JSON.stringify({
    version: 1,
    devMode: { agentRunner: true, allowedAgents: ["codex"], timeoutMs: 10_000 },
  }, null, 2)}\n`);
  writeFileSync(join(root, "src/example.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "tasks/current.md"), "# Current\n");
  spawnSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"], { cwd: root, stdio: "ignore" });
  return root;
}

describe("codex command builder", () => {
  test("builds codex exec arguments as global flags before the prompt", async () => {
    const root = repo();
    const binRoot = mkdtempSync(join(tmpdir(), "repo-harness-codex-args-bin-"));
    roots.push(binRoot);
    const originalPath = process.env.PATH;
    const executable = join(binRoot, "codex");
    writeFileSync(
      executable,
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "codex-args:$1:$2:$3:$4"\n',
    );
    chmodSync(executable, 0o755);
    process.env.PATH = `${binRoot}:${originalPath ?? ""}`;

    try {
      const issue = createIssue(root, {
        title: "Codex exec args",
        summary: "Verify the local runner argument order.",
        goals: ["Pass global options before the prompt text."],
        acceptanceCriteria: ["The Run succeeds with the expected CLI args."],
        tasks: [
          {
            title: "Execute with args",
            objective: "Run fake Codex and capture the built command.",
            allowedPaths: ["src/**"],
            checks: ["manual"],
            acceptanceCriteria: ["The Run succeeds with the expected CLI args."],
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
          taskId: issue.tasks[0]!.id,
          agent: "codex",
          executionMode: "auto",
          timeoutMs: 10_000,
        },
      });
      const dispatched = executeLocalBridgeJob(root, submitted.jobId);
      let run = getAgentJob(root, dispatched.runId as string);
      for (
        let attempt = 0;
        attempt < 80 && !["succeeded", "failed"].includes(run.status);
        attempt += 1
      ) {
        await Bun.sleep(25);
        run = getAgentJob(root, dispatched.runId as string);
      }
      expect(run.status).toBe("succeeded");
      expect(run.stdoutTail).toContain("codex-args:exec:--json:--cd:");
      expect(run.stdoutTail).toContain(root);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
