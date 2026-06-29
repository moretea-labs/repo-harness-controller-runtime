import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { registerRepository } from "../../src/cli/repositories/registry";
import { callRepositoryTool } from "../../src/cli/mcp/repository-tools";
import { createMcpToolContext } from "../../src/cli/mcp/multi-repository";
import { getLocalBridgeJob, readLocalBridgeJobOutput } from "../../src/cli/local-bridge/job-store";
import { routeDurableMcpCall } from "../../src/runtime/gateway/mcp/router";
import { getExecutionJob } from "../../src/runtime/execution/jobs/store";
import { terminateProcessesByCommand, waitForNoProcessesByCommand } from "../runtime/process-hygiene";

function git(root: string, args: string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

async function json(result: ReturnType<typeof callRepositoryTool>) {
  const resolved = await result;
  return JSON.parse(resolved?.content[0]?.text ?? "{}");
}

async function cleanupWorkspace(paths: string[]): Promise<void> {
  await terminateProcessesByCommand(paths);
  await waitForNoProcessesByCommand(paths);
}

describe("repository MCP command tools", () => {
  test("previews and executes repository-scoped git commands through MCP", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-mcp-repo-command-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Repo Harness Test"]);
      git(repoRoot, ["config", "user.email", "repo-harness-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "init"]);

      const repository = registerRepository({ path: repoRoot, controllerHome });
      writeFileSync(join(repoRoot, "tracked.txt"), "v1\n");

      const preview = callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: "git add tracked.txt",
      });
      const previewValue = await json(preview);
      expect(previewValue.status).toBe("preview");
      expect(previewValue.classification.risk).toBe("workspace_write");
      expect(typeof previewValue.approvalToken).toBe("string");

      const executed = callRepositoryTool(controllerHome, "repository_command_execute", {
        repo_id: repository.repoId,
        command: "git add tracked.txt",
        approval_token: previewValue.approvalToken,
        request_id: "repo-command-1",
      });
      const executedValue = await json(executed);
      expect(executedValue.accepted).toBe(true);
      expect(typeof executedValue.jobId).toBe("string");
      let job = getLocalBridgeJob(repoRoot, executedValue.jobId);
      for (let attempt = 0; attempt < 120 && job.status === "running"; attempt += 1) {
        await Bun.sleep(25);
        job = getLocalBridgeJob(repoRoot, executedValue.jobId);
      }
      expect(job.status).toBe("succeeded");
      expect(job.result?.repositoryChanged).toBe(true);

      const status = spawnSync("git", ["-C", repoRoot, "status", "--short"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(status.stdout).toContain("A  tracked.txt");
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("requires the exact preview token before execution", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-mcp-repo-command-token-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Repo Harness Test"]);
      git(repoRoot, ["config", "user.email", "repo-harness-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "init"]);

      const repository = registerRepository({ path: repoRoot, controllerHome });
      writeFileSync(join(repoRoot, "tracked.txt"), "v1\n");

      const executed = callRepositoryTool(controllerHome, "repository_command_execute", {
        repo_id: repository.repoId,
        command: "git add tracked.txt",
        approval_token: "wrong-token",
      });
      const value = await json(executed);
      expect(value.status).toBe("approval_required");
      expect(value.after).toBeUndefined();
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("repository command preview stays read-only and does not create a durable Job", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-mcp-repo-command-preview-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Repo Harness Test"]);
      git(repoRoot, ["config", "user.email", "repo-harness-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "init"]);

      const repository = registerRepository({ path: repoRoot, controllerHome });
      const ctx = createMcpToolContext({ repo: repoRoot, controllerHome, profile: "controller" });
      const durable = await routeDurableMcpCall(ctx, "repository_command_preview", {
        repo_id: repository.repoId,
        command: "git status --short",
      });
      expect(durable).toBeUndefined();

      const preview = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: "git status --short",
      }));
      expect(preview.status).toBe("preview");
      expect(preview.approvalToken).toBeTruthy();
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("long-running command execution runs through the async MCP path and captures output", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-mcp-repo-command-async-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Repo Harness Test"]);
      git(repoRoot, ["config", "user.email", "repo-harness-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "init"]);

      const repository = registerRepository({ path: repoRoot, controllerHome });
      const preview = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: "python - <<'PY'\nimport time\nprint('start')\ntime.sleep(1)\nprint('ready')\nPY",
      }));
      expect(preview.status).toBe("preview");
      const executionPromise = callRepositoryTool(controllerHome, "repository_command_execute", {
        repo_id: repository.repoId,
        command: "python - <<'PY'\nimport time\nprint('start')\ntime.sleep(1)\nprint('ready')\nPY",
        approval_token: preview.approvalToken,
        request_id: "repo-command-async-1",
      });
      const executedValue = await json(executionPromise);
      expect(executedValue.accepted).toBe(true);
      expect(typeof executedValue.jobId).toBe("string");
      expect(["approved", "running"]).toContain(executedValue.status);
      let job = getLocalBridgeJob(repoRoot, executedValue.jobId);
      for (let attempt = 0; attempt < 120 && job.status === "running"; attempt += 1) {
        await Bun.sleep(25);
        job = getLocalBridgeJob(repoRoot, executedValue.jobId);
      }
      expect(job.status).toBe("succeeded");
      const stdout = readLocalBridgeJobOutput(repoRoot, executedValue.jobId, { stream: "stdout" });
      expect(stdout.content).toContain("ready");
      const stderr = readLocalBridgeJobOutput(repoRoot, executedValue.jobId, { stream: "stderr" });
      expect(stderr.content).toBe("");
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("durable repository_update can restore a disabled repository", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-mcp-repo-restore-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      const repository = registerRepository({ path: repoRoot, controllerHome });
      await json(callRepositoryTool(controllerHome, "repository_update", {
        repo_id: repository.repoId,
        enabled: false,
      }));

      const ctx = createMcpToolContext({ repo: repoRoot, controllerHome, profile: "controller" });
      const durable = await routeDurableMcpCall(ctx, "repository_update", {
        repo_id: repository.repoId,
        enabled: true,
        request_id: "restore-disabled-repository",
      });
      const value = JSON.parse(durable?.content[0]?.text ?? "{}");
      expect(value.accepted).toBe(true);
      expect(typeof value.jobId).toBe("string");

      const job = getExecutionJob(controllerHome, repository.repoId, value.jobId);
      expect(job.payload.operation).toBe("repository_update");
      expect(job.repoId).toBe(repository.repoId);
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
