import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { registerRepository } from "../../src/cli/repositories/registry";
import { callMcpTool } from "../../src/cli/mcp/tools";
import { callRepositoryTool } from "../../src/cli/mcp/repository-tools";
import { createMcpToolContext } from "../../src/cli/mcp/multi-repository";
import { getLocalBridgeJob, readLocalBridgeJobOutput, readLocalBridgeJobOutputSnapshot } from "../../src/cli/local-bridge/job-store";
import { routeDurableMcpCall } from "../../src/runtime/gateway/mcp/router";
import { getExecutionJob } from "../../src/runtime/execution/jobs/store";
import { applyExternalFilesystemGrant, previewExternalFilesystemGrant } from "../../src/runtime/safe-tooling/external-filesystem";
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
  test("diagnoses the latest sibling source tree through MCP without mutating the project directories", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-mcp-repo-diagnose-"));
    const controllerHome = join(workspace, "controller-home");
    const staleRoot = join(workspace, "TinyMoments");
    const richRoot = join(workspace, "TinyMoments 1.7");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(staleRoot, { recursive: true });
      git(staleRoot, ["init", "-q"]);
      const registered = registerRepository({ path: staleRoot, controllerHome, displayName: "TinyMoments" });

      mkdirSync(richRoot, { recursive: true });
      mkdirSync(join(richRoot, "TinyMoments.xcodeproj"), { recursive: true });
      mkdirSync(join(richRoot, "App"), { recursive: true });
      writeFileSync(join(richRoot, "Package.swift"), "// swift package\n");
      writeFileSync(join(richRoot, "README.md"), "# TinyMoments\n");
      const canonicalRichRoot = realpathSync(richRoot);

      const response = await json(callRepositoryTool(controllerHome, "repository_latest_source_diagnose", {
        repo_id: registered.repoId,
      }));
      const ctx = createMcpToolContext({ repo: staleRoot, controllerHome, profile: "controller" });
      const capabilities = JSON.parse((await callMcpTool(ctx, "controller_capabilities")).content[0]?.text ?? "{}");

      expect(response.diagnosis.recommendedPath).toBe(canonicalRichRoot);
      expect(response.diagnosis.noMutation).toBe(true);
      expect(capabilities.expectedTools).toContain("repository_latest_source_diagnose");
      expect(capabilities.expectedTools).toContain("repository_bootstrap_local_project");
      expect(existsSync(join(richRoot, ".git"))).toBe(false);
    } finally {
      await cleanupWorkspace([workspace, controllerHome, staleRoot, richRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("bootstraps a non-Git local project through MCP", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-mcp-repo-bootstrap-"));
    const controllerHome = join(workspace, "controller-home");
    const projectRoot = join(workspace, "PulseMetronomeApp");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(projectRoot, { recursive: true });
      mkdirSync(join(projectRoot, "PulseMetronome.xcodeproj"), { recursive: true });
      mkdirSync(join(projectRoot, "PulseMetronome"), { recursive: true });
      writeFileSync(join(projectRoot, "README.md"), "# PulseMetronome\n");
      writeFileSync(join(projectRoot, "build.sh"), "#!/usr/bin/env bash\nxcodebuild\n");

      const response = await json(callRepositoryTool(controllerHome, "repository_bootstrap_local_project", {
        path: projectRoot,
        display_name: "PulseMetronomeApp",
        confirm_authorization: true,
      }));
      expect(response.bootstrap.repository.repoId).toBeTruthy();
      expect(response.bootstrap.createdGit).toBe(true);
      expect(existsSync(join(projectRoot, ".git"))).toBe(true);
    } finally {
      await cleanupWorkspace([workspace, controllerHome, projectRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

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



  test("repository command preview requires external filesystem grants and supports authorized external read/copy", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-mcp-external-command-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    const externalRoot = join(workspace, "external-data");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(externalRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Repo Harness Test"]);
      git(repoRoot, ["config", "user.email", "repo-harness-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "init"]);
      writeFileSync(join(externalRoot, "note.txt"), "external note\n");
      const repository = registerRepository({ path: repoRoot, controllerHome });

      const deniedRead = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: `cat ${join(externalRoot, "note.txt")}`,
      }));
      expect(deniedRead.error.code).toBe("EXTERNAL_FILESYSTEM_GRANT_REQUIRED");

      const readPreview = previewExternalFilesystemGrant(repoRoot, {
        grant_key: "external_notes_read",
        root_path: externalRoot,
        mode: "read",
        reason: "Read fixture notes for repository review",
      });
      applyExternalFilesystemGrant(repoRoot, {
        grant_key: "external_notes_read",
        root_path: externalRoot,
        mode: "read",
        reason: "Read fixture notes for repository review",
        preview_ticket_id: readPreview.previewTicketId,
        confirm_authorization: true,
      });
      const acceptedRead = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: `cat ${join(externalRoot, "note.txt")}`,
      }));
      expect(acceptedRead.status).toBe("preview");
      expect(acceptedRead.externalPathUsages[0].operation).toBe("external_read");

      const deniedCopy = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: `cp ${join(externalRoot, "note.txt")} copied.txt`,
      }));
      expect(deniedCopy.error.code).toBe("EXTERNAL_FILESYSTEM_GRANT_REQUIRED");

      const copyPreview = previewExternalFilesystemGrant(repoRoot, {
        grant_key: "external_notes_copy",
        root_path: externalRoot,
        mode: "copy_into_repo",
        reason: "Copy fixture notes into the selected repository",
      });
      applyExternalFilesystemGrant(repoRoot, {
        grant_key: "external_notes_copy",
        root_path: externalRoot,
        mode: "copy_into_repo",
        reason: "Copy fixture notes into the selected repository",
        preview_ticket_id: copyPreview.previewTicketId,
        confirm_authorization: true,
      });
      const acceptedCopy = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: `cp ${join(externalRoot, "note.txt")} copied.txt`,
      }));
      expect(acceptedCopy.status).toBe("preview");
      expect(acceptedCopy.externalPathUsages[0].operation).toBe("external_copy_into_workspace");
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot, externalRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("repository command scope blocks expired grants, symlink escape, sensitive paths, and external writes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-mcp-external-command-deny-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    const externalRoot = join(workspace, "external-data");
    const fakeHome = join(workspace, "home");
    const fakeSsh = join(fakeHome, ".ssh");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(externalRoot, { recursive: true });
      mkdirSync(fakeSsh, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Repo Harness Test"]);
      git(repoRoot, ["config", "user.email", "repo-harness-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "init"]);
      writeFileSync(join(externalRoot, "note.txt"), "external note\n");
      writeFileSync(join(fakeSsh, "id_ed25519"), "secret\n");
      symlinkSync(join(externalRoot, "note.txt"), join(repoRoot, "escape-link.txt"));
      const repository = registerRepository({ path: repoRoot, controllerHome });

      const expiredPreview = previewExternalFilesystemGrant(repoRoot, {
        grant_key: "expired_notes",
        root_path: externalRoot,
        mode: "read",
        reason: "Expired grant fixture",
      });
      applyExternalFilesystemGrant(repoRoot, {
        grant_key: "expired_notes",
        root_path: externalRoot,
        mode: "read",
        reason: "Expired grant fixture",
        preview_ticket_id: expiredPreview.previewTicketId,
        confirm_authorization: true,
      });
      writeFileSync(join(repoRoot, ".repo-harness/external-filesystem-grants.json"), `${JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        grants: [{
          schemaVersion: 1,
          key: "expired_notes",
          root: externalRoot,
          canonicalRoot: realpathSync(externalRoot),
          mode: "read",
          reason: "Expired grant fixture",
          createdAt: new Date().toISOString(),
          createdBy: "test",
          expiresAt: "2000-01-01T00:00:00.000Z",
        }],
      }, null, 2)}\n`);
      const expired = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: `cat ${join(externalRoot, "note.txt")}`,
      }));
      expect(expired.error.code).toBe("EXTERNAL_FILESYSTEM_GRANT_REQUIRED");

      const symlinkEscape = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: "cat escape-link.txt",
      }));
      expect(symlinkEscape.error.code).toBe("COMMAND_SCOPE_DENIED");

      const sensitive = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: `cat ${join(fakeSsh, "id_ed25519")}`,
      }));
      expect(sensitive.error.code).toBe("COMMAND_POLICY_DENIED");

      const externalWrite = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: `printf 'x' > ${join(externalRoot, "out.txt")}`,
      }));
      expect(externalWrite.error.code).toBe("COMMAND_SCOPE_DENIED");
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot, externalRoot]);
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

  test("safe patch apply splits repeated paths, refreshes fingerprints, and returns actionable failures", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-safe-patch-complete-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Repo Harness Test"]);
      git(repoRoot, ["config", "user.email", "repo-harness-test@example.com"]);
      writeFileSync(join(repoRoot, "app.txt"), "alpha\nbeta\n");
      git(repoRoot, ["add", "app.txt"]);
      git(repoRoot, ["commit", "-m", "init"]);
      const repository = registerRepository({ path: repoRoot, controllerHome });

      const applied = await json(callRepositoryTool(controllerHome, "repository_safe_patch_apply", {
        repo_id: repository.repoId,
        purpose: "safe patch complete test",
        operations: [
          { type: "replace", path: "app.txt", replacements: [{ old_text: "alpha", new_text: "alpha-1" }] },
          { type: "replace", path: "app.txt", replacements: [{ old_text: "beta", new_text: "beta-1" }] },
        ],
        chunk_size: 10,
      }));
      expect(applied.status).toBe("applied");
      expect(applied.appliedChunks.length).toBe(2);
      expect(applied.session.currentRevision).toBe(2);
      expect(readFileSync(join(repoRoot, "app.txt"), "utf-8")).toBe("alpha-1\nbeta-1\n");

      const failed = await json(callRepositoryTool(controllerHome, "repository_safe_patch_apply", {
        repo_id: repository.repoId,
        purpose: "safe patch failure context",
        operations: [
          { type: "replace", path: "app.txt", replacements: [{ old_text: "does-not-exist", new_text: "x" }] },
        ],
      }));
      expect(failed.status).toBe("failed");
      expect(failed.failures[0].code).toBe("REPLACEMENT_TEXT_NOT_FOUND");
      expect(failed.failures[0].context.focus).toContain("alpha-1");
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("structured git diff, commit, and finish workflow complete a feature branch", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-structured-git-complete-"));
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
      const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: "main" });

      const branch = await json(callRepositoryTool(controllerHome, "repository_git_create_branch", {
        repo_id: repository.repoId,
        branch: "feature/structured-flow",
      }));
      expect(branch.execution.ok).toBe(true);
      writeFileSync(join(repoRoot, "README.md"), "hello\nstructured\n");

      const diff = await json(callRepositoryTool(controllerHome, "repository_git_diff", {
        repo_id: repository.repoId,
        paths: ["README.md"],
      }));
      expect(diff.diff.patch).toContain("structured");

      const commit = await json(callRepositoryTool(controllerHome, "repository_git_commit", {
        repo_id: repository.repoId,
        paths: ["README.md"],
        message: "Update README through structured git",
      }));
      expect(commit.commit.committed).toBe(true);
      expect(commit.commit.after.clean).toBe(true);

      const finish = await json(callRepositoryTool(controllerHome, "repository_git_finish_workflow", {
        repo_id: repository.repoId,
        feature_branch: "feature/structured-flow",
        target_branch: "main",
      }));
      expect(finish.finish.completed).toBe(true);
      const branches = spawnSync("git", ["-C", repoRoot, "branch", "--list", "feature/structured-flow"], { encoding: "utf-8" });
      expect(branches.stdout.trim()).toBe("");
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("repository goals run checks, persist run artifacts, and feed stuck diagnosis", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-goal-run-complete-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(join(repoRoot, ".repo-harness"), { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Repo Harness Test"]);
      git(repoRoot, ["config", "user.email", "repo-harness-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n");
      writeFileSync(join(repoRoot, ".repo-harness/checks.json"), JSON.stringify({
        version: 1,
        checks: {
          "git-clean": { description: "Git status is readable", command: ["git", "status", "--short"], cwd: ".", timeoutMs: 5000 },
        },
      }, null, 2));
      git(repoRoot, ["add", "."]);
      git(repoRoot, ["commit", "-m", "init"]);
      const repository = registerRepository({ path: repoRoot, controllerHome });

      const goal = await json(callRepositoryTool(controllerHome, "repository_goal_upsert", {
        repo_id: repository.repoId,
        id: "reliability",
        title: "Improve repo harness reliability",
        checks: ["git-clean"],
      }));
      expect(goal.goal.id).toBe("reliability");

      const run = await json(callRepositoryTool(controllerHome, "repository_goal_run", {
        repo_id: repository.repoId,
        goal_id: "reliability",
        run_checks: true,
      }));
      expect(run.run.status).toBe("succeeded");
      expect(run.run.checks[0].status).toBe("passed");
      expect(existsSync(join(repoRoot, run.path))).toBe(true);

      const runs = await json(callRepositoryTool(controllerHome, "repository_goal_runs", {
        repo_id: repository.repoId,
      }));
      expect(runs.runs[0].runId).toBe(run.run.runId);
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

});
