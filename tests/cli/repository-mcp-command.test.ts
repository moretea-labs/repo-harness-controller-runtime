import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { registerRepository } from "../../src/cli/repositories/registry";
import { callRepositoryTool } from "../../src/cli/mcp/repository-tools";
import { createMcpToolContext } from "../../src/cli/mcp/multi-repository";
import { getLocalBridgeJob, readLocalBridgeJobOutput, readLocalBridgeJobOutputSnapshot } from "../../src/cli/local-bridge/job-store";
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

function writeLocalJobFixture(
  repoRoot: string,
  jobId: string,
  status: "approved" | "running" | "succeeded" | "failed" = "succeeded",
  output: Partial<Record<"stdout" | "stderr", string>> = {},
): void {
  const dir = join(repoRoot, ".ai/harness/local-jobs", jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "job.json"), `${JSON.stringify({
    schemaVersion: 1,
    jobId,
    action: "repository-command",
    payload: {
      controllerHome: join(repoRoot, ".controller-home"),
      repoId: "repo-test",
      command: "printf 'hello\\n'",
    },
    requestedBy: "test",
    approval: "auto",
    status,
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    ...(status === "succeeded" || status === "failed" ? { finishedAt: "2026-07-05T00:00:01.000Z" } : {}),
  }, null, 2)}\n`);
  if (output.stdout !== undefined) writeFileSync(join(dir, "stdout.log"), output.stdout);
  if (output.stderr !== undefined) writeFileSync(join(dir, "stderr.log"), output.stderr);
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

  test("repository command execute returns a compact handoff with inline output for short commands", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-mcp-repo-command-handoff-"));
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
        command: "printf 'alpha\\n'",
      }));
      const executed = await json(callRepositoryTool(controllerHome, "repository_command_execute", {
        repo_id: repository.repoId,
        command: "printf 'alpha\\n'",
        approval_token: preview.approvalToken,
        request_id: "repo-command-handoff-1",
      }));

      expect(executed.accepted).toBe(true);
      expect(executed.status).toBe("succeeded");
      expect(executed.localJob.stdout).toContain("alpha");
      expect(executed.localJob.stderr ?? "").toBe("");
      expect(executed.localJob.stdoutPath).toBe(`.ai/harness/local-jobs/${executed.jobId}/stdout.log`);
      expect(executed.localJob.nextLocalCommand).toContain(executed.jobId);
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
      expect(["running", "succeeded"]).toContain(executedValue.status);
      expect(executedValue.localJob.jobId).toBe(executedValue.jobId);
      expect(executedValue.localJob.stdoutPath).toBe(`.ai/harness/local-jobs/${executedValue.jobId}/stdout.log`);
      expect(executedValue.localJob.stderrPath).toBe(`.ai/harness/local-jobs/${executedValue.jobId}/stderr.log`);
      expect(executedValue.localJob.nextLocalCommand).toContain(executedValue.jobId);
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

  test("local job output snapshots read stdout and stderr with structured bounded responses", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-local-job-output-"));
    const repoRoot = join(workspace, "repo");
    try {
      mkdirSync(repoRoot, { recursive: true });
      writeLocalJobFixture(repoRoot, "JOB-output", "succeeded", {
        stdout: "line-1\nline-2\n",
        stderr: "warn-1\n",
      });

      const stdout = readLocalBridgeJobOutputSnapshot(repoRoot, "JOB-output", { stream: "stdout" });
      expect(stdout.status).toBe("ok");
      expect(stdout.content).toContain("line-2");
      expect(stdout.path).toBe(".ai/harness/local-jobs/JOB-output/stdout.log");

      const stderr = readLocalBridgeJobOutputSnapshot(repoRoot, "JOB-output", { stream: "stderr" });
      expect(stderr.status).toBe("ok");
      expect(stderr.content).toContain("warn-1");
      expect(stderr.path).toBe(".ai/harness/local-jobs/JOB-output/stderr.log");
    } finally {
      await cleanupWorkspace([workspace, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("local job output snapshots return structured not-found, reject traversal, and respect max_bytes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-local-job-output-missing-"));
    const repoRoot = join(workspace, "repo");
    try {
      mkdirSync(repoRoot, { recursive: true });
      writeLocalJobFixture(repoRoot, "JOB-missing", "succeeded");
      writeLocalJobFixture(repoRoot, "JOB-running", "running");
      writeLocalJobFixture(repoRoot, "JOB-bounded", "succeeded", {
        stdout: "0123456789abcdef",
      });

      const missing = readLocalBridgeJobOutputSnapshot(repoRoot, "JOB-missing", { stream: "stdout" });
      expect(missing.status).toBe("not_found");
      expect(missing.error?.code).toBe("LOCAL_JOB_OUTPUT_NOT_FOUND");

      const notReady = readLocalBridgeJobOutputSnapshot(repoRoot, "JOB-running", { stream: "stdout" });
      expect(notReady.status).toBe("not_ready");
      expect(notReady.error?.code).toBe("LOCAL_JOB_OUTPUT_NOT_READY");

      const traversal = readLocalBridgeJobOutputSnapshot(repoRoot, "../escape", { stream: "stdout" });
      expect(traversal.status).toBe("rejected");
      expect(traversal.error?.code).toBe("LOCAL_JOB_PATH_INVALID");

      const bounded = readLocalBridgeJobOutputSnapshot(repoRoot, "JOB-bounded", { stream: "stdout", maxBytes: 4 });
      expect(bounded.status).toBe("ok");
      expect(bounded.truncated).toBe(true);
      expect(bounded.content).toBe("cdef");
    } finally {
      await cleanupWorkspace([workspace, repoRoot]);
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
