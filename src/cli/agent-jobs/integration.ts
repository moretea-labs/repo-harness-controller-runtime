import { createHash } from "crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "fs";
import { spawnSync } from "child_process";
import { relative } from "path";
import {
  applyEditOperations,
  beginEditSession,
  getEditSession,
  type EditOperation,
  type EditSession,
} from "../editing/edit-session";
import { getIssue, updateTask } from "../controller/issue-store";
import { readTaskRunEvidence } from "../controller/run-evidence";
import { resolveEffectiveTaskState } from "../controller/task-status-resolver";
import { resolveMcpPath } from "../mcp/paths";
import type { McpPolicy } from "../mcp/types";
import {
  getAgentJob,
  listAgentJobs,
  markAgentJobIntegrated,
} from "./job-manager";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function binary(value: Buffer): boolean {
  return value.subarray(0, Math.min(value.length, 8192)).includes(0);
}

function gitBuffer(
  cwd: string,
  args: string[],
): { ok: boolean; stdout: Buffer; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    stderr: Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf-8")
      : String(result.error?.message ?? ""),
  };
}

function changedPaths(
  worktree: string,
): Array<{ status: string; path: string }> {
  const result = gitBuffer(worktree, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (!result.ok)
    throw new Error(`failed to inspect task worktree: ${result.stderr}`);
  const chunks = result.stdout.toString("utf-8").split("\0").filter(Boolean);
  const changes: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk.length < 4) throw new Error("unexpected git status entry");
    const status = chunk.slice(0, 2);
    if (/[RCU]/.test(status))
      throw new Error(
        `rename, copy, or unresolved merge status is not supported for integration: ${status}`,
      );
    changes.push({ status, path: chunk.slice(3) });
  }
  return changes;
}

function baseContent(
  worktree: string,
  revision: string,
  path: string,
): { exists: boolean; content: string } {
  const result = gitBuffer(worktree, ["show", `${revision}:${path}`]);
  if (!result.ok) return { exists: false, content: "" };
  if (binary(result.stdout))
    throw new Error(`binary file integration is not supported: ${path}`);
  return { exists: true, content: result.stdout.toString("utf-8") };
}

function branchExists(repoRoot: string, branch: string): boolean {
  return gitBuffer(repoRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]).ok;
}

function worktreePathMatchesRoot(
  repoRoot: string,
  worktree: string,
  path: string,
): boolean {
  const workerPath = `${worktree}/${path}`;
  const rootPath = `${repoRoot}/${path}`;
  const workerExists = existsSync(workerPath);
  const rootExists = existsSync(rootPath);
  if (workerExists !== rootExists) return false;
  if (!workerExists) return true;

  const workerStat = lstatSync(workerPath);
  const rootStat = lstatSync(rootPath);
  if (workerStat.isSymbolicLink() || rootStat.isSymbolicLink()) {
    return (
      workerStat.isSymbolicLink() &&
      rootStat.isSymbolicLink() &&
      readlinkSync(workerPath) === readlinkSync(rootPath)
    );
  }
  if (!workerStat.isFile() || !rootStat.isFile()) return false;
  return sha256(readFileSync(workerPath)) === sha256(readFileSync(rootPath));
}

export interface IntegratedWorktreeCleanupAudit {
  eligible: boolean;
  reasons: string[];
  worktreeExists: boolean;
  branchExists: boolean;
  uniqueCommitCount: number | null;
  changedPaths: string[];
  mismatchedPaths: string[];
  conflictingRunIds: string[];
}

export function inspectIntegratedWorktreeCleanup(
  repoRoot: string,
  runId: string,
): IntegratedWorktreeCleanupAudit {
  const run = getAgentJob(repoRoot, runId);
  const reasons: string[] = [];
  const worktreeExists = existsSync(run.worktree);
  const hasBranch = Boolean(run.branch && branchExists(repoRoot, run.branch));
  let uniqueCommitCount: number | null = null;
  let changes: Array<{ status: string; path: string }> = [];
  const mismatchedPaths: string[] = [];

  if (run.provider !== "local" || run.executionMode !== "worktree") {
    reasons.push("Run did not use a local isolated worktree");
  }
  if (!run.integratedSessionId) {
    reasons.push("Run has no integrated edit session");
  }

  const autoFinalizing =
    run.status === "running" &&
    run.autoIntegrate === true &&
    run.progress?.phase === "finalizing";
  const cleanupRetry = [
    "succeeded",
    "failed",
    "cancelled",
    "unknown",
    "waiting_for_user",
  ].includes(run.status);
  if (!autoFinalizing && !cleanupRetry) {
    reasons.push(`Run is still active in status ${run.status}`);
  }

  const conflictingRunIds = listAgentJobs(repoRoot, 5000)
    .filter(
      (entry) =>
        entry.runId !== runId &&
        ["queued", "starting", "running", "waiting_for_user"].includes(
          entry.status,
        ) &&
        ((run.branch && entry.branch === run.branch) ||
          entry.worktree === run.worktree),
    )
    .map((entry) => entry.runId);
  if (conflictingRunIds.length > 0) {
    reasons.push(
      `Worktree or branch is referenced by active Runs: ${conflictingRunIds.join(", ")}`,
    );
  }

  if (hasBranch) {
    if (run.branch) {
      const unique = gitBuffer(repoRoot, [
        "rev-list",
        "--count",
        `HEAD..${run.branch}`,
      ]);
      if (!unique.ok) {
        reasons.push(
          `Failed to inspect branch-only commits: ${unique.stderr.trim() || "unknown git error"}`,
        );
      } else {
        uniqueCommitCount = Number(unique.stdout.toString("utf-8").trim());
        if (!Number.isFinite(uniqueCommitCount)) {
          uniqueCommitCount = null;
          reasons.push("Git returned an invalid unique-commit count");
        } else if (uniqueCommitCount > 0) {
          reasons.push(
            `Temporary branch contains ${uniqueCommitCount} commit(s) not reachable from the target checkout HEAD`,
          );
        }
      }
    }
  } else {
    uniqueCommitCount = 0;
  }

  if (worktreeExists) {
    try {
      changes = changedPaths(run.worktree);
      for (const change of changes) {
        if (!worktreePathMatchesRoot(repoRoot, run.worktree, change.path)) {
          mismatchedPaths.push(change.path);
        }
      }
      if (mismatchedPaths.length > 0) {
        reasons.push(
          `Worktree changes are not fully reproduced in the target workspace: ${mismatchedPaths.join(", ")}`,
        );
      }
    } catch (error) {
      reasons.push(
        `Failed to verify worktree contents: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    worktreeExists,
    branchExists: hasBranch,
    uniqueCommitCount,
    changedPaths: changes.map((entry) => entry.path),
    mismatchedPaths,
    conflictingRunIds,
  };
}

export function integrateAgentJob(
  repoRoot: string,
  policy: McpPolicy,
  runId: string,
): { session: EditSession; changedPaths: string[] } {
  const run = getAgentJob(repoRoot, runId);
  const autoFinalizing = run.status === "running" &&
    run.autoIntegrate === true &&
    run.executionMode === "worktree" &&
    run.progress?.phase === "finalizing";
  if (run.status !== "succeeded" && !autoFinalizing)
    throw new Error(
      `only succeeded or auto-finalizing Runs can be integrated (current: ${run.status})`,
    );
  if (run.provider !== "local")
    throw new Error(
      "GitHub cloud Runs are integrated through their pull request, not the local worktree integration path",
    );
  if (run.worktree === repoRoot || !run.branch || !run.baseRevision)
    throw new Error(
      "Run did not use an isolated Git worktree; its changes are already in the main working tree",
    );
  if (run.integratedSessionId) {
    const existing = getEditSession(repoRoot, run.integratedSessionId);
    return {
      session: existing,
      changedPaths: existing.operations.map((operation) => operation.path),
    };
  }
  if (!existsSync(run.worktree))
    throw new Error(`task worktree no longer exists: ${run.worktree}`);

  const issue = getIssue(repoRoot, run.issueId);
  const task = issue.tasks.find((entry) => entry.id === run.taskId);
  if (!task) throw new Error(`task not found: ${run.issueId}/${run.taskId}`);
  const state = resolveEffectiveTaskState({ issue, task, runs: readTaskRunEvidence(repoRoot, task) });
  const taskReady = autoFinalizing
    ? !state.terminal && !state.inactive && ["review", "verified"].includes(task.status)
    : !state.terminal && !state.inactive && ["review", "verified"].includes(state.effectiveStatus);
  if (!taskReady)
    throw new Error(
      `task must be active and in review before integration (declared: ${task.status}, effective: ${state.effectiveStatus})`,
    );

  const changes = changedPaths(run.worktree);
  if (changes.length === 0)
    throw new Error("task worktree has no changes to integrate");
  if (changes.length > 25)
    throw new Error(
      `task changed ${changes.length} files; split or manually integrate work larger than 25 files`,
    );

  const operations: EditOperation[] = [];
  for (const change of changes) {
    const decision = resolveMcpPath(repoRoot, change.path, policy, "write");
    if (!decision.ok || !decision.absolutePath || !decision.relativePath)
      throw new Error(decision.reason ?? `path denied: ${change.path}`);
    const worktreePath = `${run.worktree}/${decision.relativePath}`;
    const base = baseContent(
      run.worktree,
      run.baseRevision,
      decision.relativePath,
    );
    const rootExists = existsSync(decision.absolutePath);
    const rootContent = rootExists
      ? readFileSync(decision.absolutePath)
      : Buffer.alloc(0);
    if (binary(rootContent))
      throw new Error(
        `binary file integration is not supported: ${decision.relativePath}`,
      );
    const rootText = rootContent.toString("utf-8");
    if (base.exists) {
      if (!rootExists || sha256(rootText) !== sha256(base.content))
        throw new Error(
          `main working tree changed since Task dispatch: ${decision.relativePath}`,
        );
    } else if (rootExists) {
      throw new Error(
        `integration would overwrite a new main-tree file: ${decision.relativePath}`,
      );
    }

    const workerExists =
      existsSync(worktreePath) && statSync(worktreePath).isFile();
    if (!workerExists) {
      if (!base.exists)
        throw new Error(
          `cannot integrate missing untracked file: ${decision.relativePath}`,
        );
      operations.push({
        type: "delete",
        path: decision.relativePath,
        expectedSha256: sha256(rootText),
      });
      continue;
    }
    const workerBytes = readFileSync(worktreePath);
    if (binary(workerBytes))
      throw new Error(
        `binary file integration is not supported: ${decision.relativePath}`,
      );
    const workerText = workerBytes.toString("utf-8");
    if (base.exists)
      operations.push({
        type: "write",
        path: decision.relativePath,
        expectedSha256: sha256(rootText),
        content: workerText,
      });
    else
      operations.push({
        type: "create",
        path: decision.relativePath,
        content: workerText,
      });
  }

  const allowedPaths =
    task.allowedPaths.length > 0
      ? task.allowedPaths
      : operations.map((operation) => operation.path);
  const session = beginEditSession(repoRoot, {
    purpose: `Integrate ${runId} from isolated Task worktree`,
    issueId: run.issueId,
    taskId: run.taskId,
    allowedPaths,
    maxFiles: operations.length,
    maxChangedLines: 5000,
  });
  const applied = applyEditOperations(
    repoRoot,
    policy,
    session.sessionId,
    operations,
  );
  markAgentJobIntegrated(repoRoot, runId, applied.sessionId);
  updateTask(repoRoot, run.issueId, run.taskId, {
    status: "integrated",
    note: `${runId} integrated through edit session ${applied.sessionId}; run focused checks and record verification before acceptance.`,
  });
  return {
    session: applied,
    changedPaths: operations.map((operation) => operation.path),
  };
}

export function cleanupIntegratedWorktree(
  repoRoot: string,
  runId: string,
): {
  removed: boolean;
  branchDeleted: boolean;
  audit: IntegratedWorktreeCleanupAudit;
} {
  const run = getAgentJob(repoRoot, runId);
  if (run.provider !== "local" || run.executionMode !== "worktree") {
    return {
      removed: false,
      branchDeleted: false,
      audit: inspectIntegratedWorktreeCleanup(repoRoot, runId),
    };
  }

  const audit = inspectIntegratedWorktreeCleanup(repoRoot, runId);
  if (!audit.eligible) {
    throw new Error(
      `refusing to clean isolated worktree: ${audit.reasons.join("; ")}`,
    );
  }

  let removed = !existsSync(run.worktree);
  if (!removed) {
    const remove = gitBuffer(repoRoot, [
      "worktree",
      "remove",
      "--force",
      run.worktree,
    ]);
    if (!remove.ok)
      throw new Error(`failed to remove verified worktree: ${remove.stderr}`);
    removed = !existsSync(run.worktree);
    if (!removed)
      throw new Error(
        `verified worktree still exists after git cleanup: ${run.worktree}`,
      );
  }

  let branchDeleted = !run.branch || !branchExists(repoRoot, run.branch);
  if (run.branch && !branchDeleted) {
    const deleted = gitBuffer(repoRoot, ["branch", "-d", run.branch]);
    if (!deleted.ok && !deleted.stderr.includes("not found"))
      throw new Error(
        `failed to delete verified worktree branch: ${deleted.stderr}`,
      );
    branchDeleted = !branchExists(repoRoot, run.branch);
  }
  return { removed, branchDeleted, audit };
}

export function taskRunDiff(
  repoRoot: string,
  runId: string,
  maxBytes = 256 * 1024,
): {
  runId: string;
  worktree: string;
  status: string;
  diff: string;
  untracked: string[];
  truncated: boolean;
} {
  const run = getAgentJob(repoRoot, runId);
  if (run.provider !== "local")
    throw new Error(
      "GitHub cloud Run diffs are reviewed in the linked pull request",
    );
  if (!existsSync(run.worktree)) {
    if (
      run.diffArtifactPath &&
      existsSync(`${repoRoot}/${run.diffArtifactPath}`)
    ) {
      return JSON.parse(
        readFileSync(`${repoRoot}/${run.diffArtifactPath}`, "utf-8"),
      ) as {
        runId: string;
        worktree: string;
        status: string;
        diff: string;
        untracked: string[];
        truncated: boolean;
      };
    }
    throw new Error(`task worktree no longer exists: ${run.worktree}`);
  }
  const status = gitBuffer(run.worktree, [
    "status",
    "--short",
    "--untracked-files=all",
  ]);
  const diff = gitBuffer(run.worktree, [
    "diff",
    "--no-ext-diff",
    "--binary",
    run.baseRevision ?? "HEAD",
    "--",
  ]);
  if (!status.ok || !diff.ok)
    throw new Error(
      status.stderr || diff.stderr || "failed to inspect task diff",
    );
  const untrackedResult = gitBuffer(run.worktree, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const raw = diff.stdout.toString("utf-8");
  const clipped =
    Buffer.byteLength(raw, "utf-8") > maxBytes
      ? Buffer.from(raw, "utf-8").subarray(0, maxBytes).toString("utf-8")
      : raw;
  return {
    runId,
    worktree: relative(repoRoot, run.worktree).replace(/\\/g, "/") || ".",
    status: status.stdout.toString("utf-8").trim(),
    diff: clipped,
    untracked: untrackedResult.ok
      ? untrackedResult.stdout.toString("utf-8").split(/\r?\n/).filter(Boolean)
      : [],
    truncated: clipped.length < raw.length,
  };
}
