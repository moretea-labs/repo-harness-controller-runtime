import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join, relative } from "path";
import {
  applyEditOperations,
  beginEditSession,
  EditSessionPatchError,
  finalizeEditSession,
  getEditSession,
  rollbackEditSession,
  type EditOperation,
  type EditSession,
} from "../editing/edit-session";
import { getIssue, updateTask } from "../controller/issue-store";
import { readTaskRunEvidence } from "../controller/run-evidence";
import { resolveEffectiveTaskState } from "../controller/task-status-resolver";
import { resolveMcpPath } from "../mcp/paths";
import type { McpPolicy } from "../mcp/types";
import { getAgentJob, markAgentJobIntegrated, markAgentJobIntegrationReview } from "./job-manager";
import type { AgentJobMeta } from "./types";

type IntegrationChangeOutcome = "changed" | "already_integrated";

interface IntegrationPlan {
  changedPaths: string[];
  operations: EditOperation[];
  conflicts: IntegrationReviewConflict[];
}

interface IntegrationReviewConflict {
  path: string;
  reason: string;
  baseExists: boolean;
  mainExists: boolean;
  worktreeExists: boolean;
  baseSha256?: string;
  mainSha256?: string;
  worktreeSha256?: string;
  mainPreview?: string;
  worktreePreview?: string;
  mergePreview?: string;
}

interface IntegrationReviewPacket {
  schemaVersion: 1;
  kind: "concurrent_main_conflict";
  createdAt: string;
  runId: string;
  issueId: string;
  taskId: string;
  baseRevision: string;
  repoHead?: string;
  worktreeHead?: string;
  changedPaths: string[];
  conflicts: IntegrationReviewConflict[];
}

export class IntegrationReviewRequiredError extends Error {
  readonly packet: IntegrationReviewPacket;
  readonly reviewPath: string;

  constructor(message: string, reviewPath: string, packet: IntegrationReviewPacket) {
    super(message);
    this.name = "IntegrationReviewRequiredError";
    this.reviewPath = reviewPath;
    this.packet = packet;
  }
}

function sha256(value: string): string {
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

function gitRevision(cwd: string): string | undefined {
  const result = gitBuffer(cwd, ["rev-parse", "HEAD"]);
  if (!result.ok) return undefined;
  const revision = result.stdout.toString("utf-8").trim();
  return revision || undefined;
}

function preview(value: string, maxChars = 400): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function plannedChangePaths(
  worktree: string,
  baseRevision: string,
): string[] {
  const diff = gitBuffer(worktree, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    "--find-copies",
    baseRevision,
    "--",
  ]);
  if (!diff.ok)
    throw new Error(`failed to inspect task worktree delta: ${diff.stderr}`);
  const diffChunks = diff.stdout.toString("utf-8").split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < diffChunks.length;) {
    const status = diffChunks[index++] ?? "";
    const code = status[0] ?? "";
    if (code === "R" || code === "C") {
      const fromPath = diffChunks[index++] ?? "";
      const toPath = diffChunks[index++] ?? "";
      throw new Error(
        `rename or copy status is not supported for integration: ${status} ${fromPath} ${toPath}`.trim(),
      );
    }
    const path = diffChunks[index++] ?? "";
    if (!path) throw new Error("unexpected git diff entry");
    if ("UTXB".includes(code))
      throw new Error(
        `unsupported git diff status for integration: ${status} ${path}`,
      );
    if (!"ADM".includes(code))
      throw new Error(
        `unsupported git diff status for integration: ${status} ${path}`,
      );
    paths.push(path);
  }

  const result = gitBuffer(worktree, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (!result.ok)
    throw new Error(`failed to inspect task worktree: ${result.stderr}`);
  const chunks = result.stdout.toString("utf-8").split("\0").filter(Boolean);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk.length < 4) throw new Error("unexpected git status entry");
    const status = chunk.slice(0, 2);
    if (/[RCU]/.test(status))
      throw new Error(
        `rename, copy, or unresolved merge status is not supported for integration: ${status}`,
      );
    if (status === "??") paths.push(chunk.slice(3));
  }

  return Array.from(new Set(paths)).sort((left, right) =>
    left.localeCompare(right)
  );
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

function threeWayMergeText(input: {
  base: string;
  current: string;
  incoming: string;
  path: string;
}): { ok: boolean; output: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "repo-harness-merge-"));
  try {
    const currentPath = join(dir, "current");
    const basePath = join(dir, "base");
    const incomingPath = join(dir, "incoming");
    writeFileSync(currentPath, input.current, "utf-8");
    writeFileSync(basePath, input.base, "utf-8");
    writeFileSync(incomingPath, input.incoming, "utf-8");
    const result = spawnSync("git", ["merge-file", "-p", currentPath, basePath, incomingPath], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
    if (![0, 1].includes(result.status ?? 0) || result.error) {
      const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
      throw new Error(
        `failed to 3-way merge ${input.path}${stderr ? `: ${stderr}` : ""}`,
      );
    }
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    return {
      ok: result.status === 0,
      output: String(result.stdout ?? ""),
      stderr,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function conflictEntry(input: {
  path: string;
  reason: string;
  baseExists: boolean;
  baseText?: string;
  mainExists: boolean;
  mainText?: string;
  worktreeExists: boolean;
  worktreeText?: string;
  mergePreview?: string;
}): IntegrationReviewConflict {
  return {
    path: input.path,
    reason: input.reason,
    baseExists: input.baseExists,
    mainExists: input.mainExists,
    worktreeExists: input.worktreeExists,
    baseSha256: input.baseExists ? sha256(input.baseText ?? "") : undefined,
    mainSha256: input.mainExists ? sha256(input.mainText ?? "") : undefined,
    worktreeSha256: input.worktreeExists
      ? sha256(input.worktreeText ?? "")
      : undefined,
    mainPreview: input.mainExists ? preview(input.mainText ?? "") : undefined,
    worktreePreview: input.worktreeExists
      ? preview(input.worktreeText ?? "")
      : undefined,
    mergePreview: input.mergePreview
      ? preview(input.mergePreview, 1200)
      : undefined,
  };
}

function createReviewPacket(
  repoRoot: string,
  run: AgentJobMeta,
  changedPaths: string[],
  conflicts: IntegrationReviewConflict[],
): IntegrationReviewRequiredError {
  const packet: IntegrationReviewPacket = {
    schemaVersion: 1,
    kind: "concurrent_main_conflict",
    createdAt: new Date().toISOString(),
    runId: run.runId,
    issueId: run.issueId,
    taskId: run.taskId,
    baseRevision: run.baseRevision ?? "",
    repoHead: gitRevision(repoRoot),
    worktreeHead: gitRevision(run.worktree),
    changedPaths,
    conflicts,
  };
  const absolutePath = join(
    repoRoot,
    ".ai/harness/jobs",
    run.runId,
    "integration-review.json",
  );
  writeFileSync(absolutePath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
  const reviewPath = relative(repoRoot, absolutePath).replace(/\\/g, "/");
  markAgentJobIntegrationReview(repoRoot, run.runId, reviewPath);
  return new IntegrationReviewRequiredError(
    `main changed concurrently; preserved the isolated worktree and wrote a review packet at ${reviewPath}`,
    reviewPath,
    packet,
  );
}

function buildIntegrationPlan(
  repoRoot: string,
  worktreeRoot: string,
  baseRevision: string,
  policy: McpPolicy,
  changedPaths: string[],
): IntegrationPlan {
  const operations: EditOperation[] = [];
  const conflicts: IntegrationReviewConflict[] = [];
  const normalizedPaths: string[] = [];
  for (const changedPath of changedPaths) {
    const decision = resolveMcpPath(repoRoot, changedPath, policy, "write");
    if (!decision.ok || !decision.absolutePath || !decision.relativePath)
      throw new Error(decision.reason ?? `path denied: ${changedPath}`);
    normalizedPaths.push(decision.relativePath);
    const worktreePath = join(worktreeRoot, decision.relativePath);
    const base = baseContent(
      worktreeRoot,
      baseRevision,
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
    const rootChangedFromDispatch = base.exists
      ? !rootExists || sha256(rootText) !== sha256(base.content)
      : rootExists;

    const workerExists =
      existsSync(worktreePath) && statSync(worktreePath).isFile();
    if (!workerExists) {
      if (!base.exists)
        throw new Error(
          `cannot integrate missing untracked file: ${decision.relativePath}`,
        );
      if (rootChangedFromDispatch) {
        conflicts.push(conflictEntry({
          path: decision.relativePath,
          reason: "main_changed_during_delete",
          baseExists: base.exists,
          baseText: base.content,
          mainExists: rootExists,
          mainText: rootText,
          worktreeExists: false,
        }));
        continue;
      }
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
    if (base.exists) {
      if (!rootExists) {
        conflicts.push(conflictEntry({
          path: decision.relativePath,
          reason: "main_missing",
          baseExists: base.exists,
          baseText: base.content,
          mainExists: false,
          worktreeExists: true,
          worktreeText: workerText,
        }));
        continue;
      }
      if (workerText === rootText) continue;
      if (rootChangedFromDispatch) {
        const merge = threeWayMergeText({
          base: base.content,
          current: rootText,
          incoming: workerText,
          path: decision.relativePath,
        });
        if (!merge.ok) {
          conflicts.push(conflictEntry({
            path: decision.relativePath,
            reason: "merge_conflict",
            baseExists: base.exists,
            baseText: base.content,
            mainExists: true,
            mainText: rootText,
            worktreeExists: true,
            worktreeText: workerText,
            mergePreview: merge.output,
          }));
          continue;
        }
        operations.push({
          type: "write",
          path: decision.relativePath,
          expectedSha256: sha256(rootText),
          content: merge.output,
        });
        continue;
      }
      operations.push({
        type: "write",
        path: decision.relativePath,
        expectedSha256: sha256(rootText),
        content: workerText,
      });
      continue;
    }

    if (rootExists) {
      if (rootText === workerText) continue;
      conflicts.push(conflictEntry({
        path: decision.relativePath,
        reason: "main_created_different_content",
        baseExists: false,
        mainExists: true,
        mainText: rootText,
        worktreeExists: true,
        worktreeText: workerText,
      }));
      continue;
    }
    operations.push({
      type: "create",
      path: decision.relativePath,
      content: workerText,
    });
  }
  return {
    changedPaths: Array.from(new Set(normalizedPaths)),
    operations,
    conflicts,
  };
}

function finalizeAlreadyIntegratedSession(
  repoRoot: string,
  run: AgentJobMeta,
  allowedPaths: string[],
): EditSession {
  const session = beginEditSession(repoRoot, {
    purpose: `Record ${run.runId} as already integrated from isolated Task worktree`,
    issueId: run.issueId,
    taskId: run.taskId,
    allowedPaths,
    maxFiles: Math.max(allowedPaths.length, 1),
    maxChangedLines: 1,
  });
  return finalizeEditSession(repoRoot, session.sessionId, {
    reviewer: "repo-harness-controller",
    note: `Equivalent Task Run changes were already present in the main workspace for ${run.runId}.`,
  });
}

function planFromCurrentWorkspace(
  repoRoot: string,
  run: AgentJobMeta,
  policy: McpPolicy,
): IntegrationPlan {
  if (!run.baseRevision)
    throw new Error("isolated Task Run is missing a base revision");
  const changedPaths = plannedChangePaths(run.worktree, run.baseRevision);
  return buildIntegrationPlan(
    repoRoot,
    run.worktree,
    run.baseRevision,
    policy,
    changedPaths,
  );
}

function concurrentPatchError(error: unknown): boolean {
  if (!(error instanceof EditSessionPatchError)) return false;
  if (error.code === "EDIT_SESSION_FINGERPRINT_STALE") return true;
  if (error.code !== "EDIT_PATCH_PRECONDITION_FAILED") return false;
  return error.details.failures.some((failure) =>
    ["STALE_FILE_SHA", "TARGET_MISSING", "CREATE_TARGET_EXISTS"].includes(
      failure.code,
    )
  );
}

export function integrateAgentJob(
  repoRoot: string,
  policy: McpPolicy,
  runId: string,
): {
  session: EditSession;
  changedPaths: string[];
  changeOutcome: IntegrationChangeOutcome;
} {
  const run = getAgentJob(repoRoot, runId);
  const autoFinalizing = run.status === "running" &&
    run.autoIntegrate === true &&
    run.executionMode === "worktree" &&
    run.progress?.phase === "finalizing";
  const userResolvableIntegration = run.status === "waiting_for_user" &&
    run.autoIntegrate === true &&
    run.executionMode === "worktree" &&
    Boolean(run.autoIntegrationError);
  if (run.status !== "succeeded" && !autoFinalizing && !userResolvableIntegration)
    throw new Error(
      `only succeeded, auto-finalizing, or preserved waiting_for_user Runs can be integrated (current: ${run.status})`,
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
      changedPaths: run.changedFiles ?? existing.operations.map((operation) => operation.path),
      changeOutcome: run.changeOutcome === "already_integrated"
        ? "already_integrated"
        : "changed",
    };
  }
  if (!existsSync(run.worktree))
    throw new Error(`task worktree no longer exists: ${run.worktree}`);

  const issue = getIssue(repoRoot, run.issueId);
  const task = issue.tasks.find((entry) => entry.id === run.taskId);
  if (!task) throw new Error(`task not found: ${run.issueId}/${run.taskId}`);
  const state = resolveEffectiveTaskState({ issue, task, runs: readTaskRunEvidence(repoRoot, task) });
  const taskReady = autoFinalizing || userResolvableIntegration
    ? !state.terminal && !state.inactive && ["review", "integrated", "verified"].includes(task.status)
    : !state.terminal && !state.inactive && ["review", "verified"].includes(state.effectiveStatus);
  if (!taskReady)
    throw new Error(
      `task must be active and in review before integration (declared: ${task.status}, effective: ${state.effectiveStatus})`,
    );

  const initialPlan = planFromCurrentWorkspace(repoRoot, run, policy);
  if (initialPlan.changedPaths.length === 0)
    throw new Error("task worktree has no changes to integrate");
  if (initialPlan.changedPaths.length > 25)
    throw new Error(
      `task changed ${initialPlan.changedPaths.length} files; split or manually integrate work larger than 25 files`,
    );
  if (initialPlan.conflicts.length > 0)
    throw createReviewPacket(
      repoRoot,
      run,
      initialPlan.changedPaths,
      initialPlan.conflicts,
    );

  const allowedPaths =
    task.allowedPaths.length > 0
      ? task.allowedPaths
      : initialPlan.changedPaths;
  if (initialPlan.operations.length === 0) {
    const applied = finalizeAlreadyIntegratedSession(
      repoRoot,
      run,
      allowedPaths,
    );
    markAgentJobIntegrated(repoRoot, runId, applied.sessionId);
    updateTask(repoRoot, run.issueId, run.taskId, {
      status: "integrated",
      note: `${runId} already matched the main workspace and was recorded through edit session ${applied.sessionId}; run focused checks and record verification before acceptance.`,
    });
    return {
      session: applied,
      changedPaths: initialPlan.changedPaths,
      changeOutcome: "already_integrated",
    };
  }

  const session = beginEditSession(repoRoot, {
    purpose: `Integrate ${runId} from isolated Task worktree`,
    issueId: run.issueId,
    taskId: run.taskId,
    allowedPaths,
    maxFiles: initialPlan.operations.length,
    maxChangedLines: 5000,
  });
  let applied: EditSession;
  try {
    applied = applyEditOperations(
      repoRoot,
      policy,
      session.sessionId,
      initialPlan.operations,
    );
  } catch (error) {
    try {
      rollbackEditSession(repoRoot, session.sessionId);
    } catch (_rollbackError) {
      /* best effort */
    }
    if (concurrentPatchError(error)) {
      const refreshedPlan = planFromCurrentWorkspace(repoRoot, run, policy);
      if (refreshedPlan.conflicts.length > 0)
        throw createReviewPacket(
          repoRoot,
          run,
          refreshedPlan.changedPaths,
          refreshedPlan.conflicts,
        );
      if (refreshedPlan.operations.length === 0) {
        const alreadyIntegrated = finalizeAlreadyIntegratedSession(
          repoRoot,
          run,
          allowedPaths,
        );
        markAgentJobIntegrated(repoRoot, runId, alreadyIntegrated.sessionId);
        updateTask(repoRoot, run.issueId, run.taskId, {
          status: "integrated",
          note: `${runId} became already integrated while finish was running and was recorded through edit session ${alreadyIntegrated.sessionId}; run focused checks and record verification before acceptance.`,
        });
        return {
          session: alreadyIntegrated,
          changedPaths: refreshedPlan.changedPaths,
          changeOutcome: "already_integrated",
        };
      }
      throw createReviewPacket(
        repoRoot,
        run,
        refreshedPlan.changedPaths,
        refreshedPlan.conflicts.length > 0
          ? refreshedPlan.conflicts
          : refreshedPlan.changedPaths.map((path) =>
              conflictEntry({
                path,
                reason: "main_changed_during_apply",
                baseExists: false,
                mainExists: existsSync(join(repoRoot, path)),
                mainText: existsSync(join(repoRoot, path))
                  ? readFileSync(join(repoRoot, path), "utf-8")
                  : undefined,
                worktreeExists: existsSync(join(run.worktree, path)),
                worktreeText: existsSync(join(run.worktree, path))
                  ? readFileSync(join(run.worktree, path), "utf-8")
                  : undefined,
              }),
            ),
      );
    }
    throw error;
  }
  markAgentJobIntegrated(repoRoot, runId, applied.sessionId);
  updateTask(repoRoot, run.issueId, run.taskId, {
    status: "integrated",
    note: `${runId} integrated through edit session ${applied.sessionId}; run focused checks and record verification before acceptance.`,
  });
  return {
    session: applied,
    changedPaths: initialPlan.operations.map((operation) => operation.path),
    changeOutcome: "changed",
  };
}

export function cleanupIntegratedWorktree(
  repoRoot: string,
  runId: string,
): { removed: boolean; branchDeleted: boolean } {
  const run = getAgentJob(repoRoot, runId);
  if (run.provider !== "local" || run.executionMode !== "worktree")
    return { removed: false, branchDeleted: false };
  if (!run.integratedSessionId)
    throw new Error("cannot clean an isolated worktree before integration");
  let removed = !existsSync(run.worktree);
  if (!removed) {
    const remove = gitBuffer(repoRoot, [
      "worktree",
      "remove",
      "--force",
      run.worktree,
    ]);
    if (!remove.ok)
      throw new Error(`failed to remove integrated worktree: ${remove.stderr}`);
    removed = !existsSync(run.worktree);
    if (!removed) {
      rmSync(run.worktree, { recursive: true, force: true });
      removed = !existsSync(run.worktree);
    }
    if (!removed)
      throw new Error(
        `integrated worktree still exists after cleanup: ${run.worktree}`,
      );
  }
  let branchDeleted = !run.branch;
  if (run.branch) {
    const deleted = gitBuffer(repoRoot, ["branch", "-D", run.branch]);
    if (!deleted.ok && !deleted.stderr.includes("not found"))
      throw new Error(
        `failed to delete integrated worktree branch: ${deleted.stderr}`,
      );
    branchDeleted = true;
  }
  return { removed, branchDeleted };
}

export function cleanupNoChangeWorktree(
  repoRoot: string,
  runId: string,
): { removed: boolean; branchDeleted: boolean } {
  const run = getAgentJob(repoRoot, runId);
  if (run.provider !== "local" || run.executionMode !== "worktree")
    return { removed: false, branchDeleted: false };
  const diff = taskRunDiff(repoRoot, runId);
  if (diff.status || diff.diff || diff.untracked.length > 0) {
    throw new Error("cannot discard a worktree that contains changes");
  }
  let removed = !existsSync(run.worktree);
  if (!removed) {
    const remove = gitBuffer(repoRoot, ["worktree", "remove", "--force", run.worktree]);
    if (!remove.ok) throw new Error(`failed to remove no-change worktree: ${remove.stderr}`);
    removed = !existsSync(run.worktree);
  }
  let branchDeleted = !run.branch;
  if (run.branch) {
    const deleted = gitBuffer(repoRoot, ["branch", "-D", run.branch]);
    if (!deleted.ok && !deleted.stderr.includes("not found")) {
      throw new Error(`failed to delete no-change worktree branch: ${deleted.stderr}`);
    }
    branchDeleted = true;
  }
  return { removed, branchDeleted };
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
