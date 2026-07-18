import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";
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
import { getAgentJob, markAgentJobClosure, markAgentJobIntegrated, markAgentJobIntegrationReview } from "./job-manager";
import type { AgentJobMeta, AgentJobPreservationReason } from "./types";

type IntegrationChangeOutcome = "changed" | "already_integrated";

export interface WorktreeCleanupResult {
  removed: boolean;
  branchDeleted: boolean;
  preserved?: boolean;
  preservationReason?: AgentJobPreservationReason;
  message?: string;
}

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
  let run: AgentJobMeta = getAgentJob(repoRoot, runId);
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

  run = markAgentJobClosure(repoRoot, runId, {
    state: "integrating",
    details: "Applying isolated Run changes to the canonical workspace.",
  });

  const issue = getIssue(repoRoot, run.issueId);
  const task = issue.tasks.find((entry) => entry.id === run.taskId);
  if (!task) throw new Error(`task not found: ${run.issueId}/${run.taskId}`);
  const state = resolveEffectiveTaskState({ issue, task, runs: readTaskRunEvidence(repoRoot, task) });
  const taskReady = autoFinalizing || userResolvableIntegration
    ? !state.terminal && !state.inactive && ["review", "ready_to_integrate", "integrating", "integration_blocked", "integrated", "verified"].includes(task.status)
    : !state.terminal && !state.inactive && ["review", "ready_to_integrate", "integrating", "integration_blocked", "verified"].includes(state.effectiveStatus);
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
    markAgentJobIntegrated(repoRoot, runId, applied.sessionId, {
      changedFiles: initialPlan.changedPaths,
      changeOutcome: "already_integrated",
    });
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
        markAgentJobIntegrated(repoRoot, runId, alreadyIntegrated.sessionId, {
          changedFiles: refreshedPlan.changedPaths,
          changeOutcome: "already_integrated",
        });
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
  markAgentJobIntegrated(repoRoot, runId, applied.sessionId, {
    changedFiles: initialPlan.operations.map((operation) => operation.path),
    changeOutcome: "changed",
  });
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

function preserveCleanup(
  repoRoot: string,
  runId: string,
  reason: AgentJobPreservationReason,
  message: string,
): WorktreeCleanupResult {
  markAgentJobClosure(repoRoot, runId, {
    state: "preserved",
    preservationReason: reason,
    details: message,
  });
  return { removed: false, branchDeleted: false, preserved: true, preservationReason: reason, message };
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function worktreeCleanupBlocker(
  repoRoot: string,
  run: AgentJobMeta,
): { reason: AgentJobPreservationReason; message: string } | undefined {
  const runWorktreePath = canonicalExistingPath(run.worktree);
  if (runWorktreePath === canonicalExistingPath(repoRoot)) {
    return { reason: "active_worktree", message: "Refusing to clean the canonical repository workspace." };
  }
  const worktrees = gitBuffer(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!worktrees.ok) {
    return { reason: "unknown_worktree_state", message: `Unable to inspect Git worktree ownership: ${worktrees.stderr}` };
  }
  const records = worktrees.stdout.toString("utf-8").split(/\n\n+/).map((record) => record.trim()).filter(Boolean);
  const selected = records.find((record) => {
    const listedPath = record.split(/\r?\n/).find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    return listedPath ? canonicalExistingPath(listedPath) === runWorktreePath : false;
  });
  if (existsSync(run.worktree) && !selected) {
    return { reason: "unknown_worktree_state", message: `Worktree is not registered with Git; preserving ${run.worktree}.` };
  }
  if (existsSync(run.worktree)) {
    const status = gitBuffer(run.worktree, ["status", "--porcelain", "--untracked-files=all"]);
    if (!status.ok) {
      return { reason: "unknown_worktree_state", message: `Unable to verify worktree cleanliness: ${status.stderr}` };
    }
    if (status.stdout.toString("utf-8").trim()) {
      if (!run.integratedSessionId || !run.baseRevision || !run.changedFiles || run.changedFiles.length === 0) {
        return { reason: "dirty_worktree", message: `Worktree contains changes that are not covered by durable integration evidence; preserving ${run.worktree}.` };
      }
      let actualPaths: string[];
      try {
        actualPaths = plannedChangePaths(run.worktree, run.baseRevision);
      } catch (error) {
        return { reason: "unknown_worktree_state", message: `Unable to verify integrated worktree paths: ${error instanceof Error ? error.message : String(error)}` };
      }
      const expectedPaths = new Set(run.changedFiles);
      const unexpectedPaths = actualPaths.filter((path) => !expectedPaths.has(path));
      if (unexpectedPaths.length > 0) {
        return { reason: "dirty_worktree", message: `Worktree contains changes outside durable integration evidence (${unexpectedPaths.join(", ")}); preserving ${run.worktree}.` };
      }
    }
  }
  if (run.branch) {
    const rootBranch = gitBuffer(repoRoot, ["branch", "--show-current"]);
    if (!rootBranch.ok) {
      return { reason: "unknown_worktree_state", message: `Unable to inspect the canonical branch: ${rootBranch.stderr}` };
    }
    if (rootBranch.stdout.toString("utf-8").trim() === run.branch) {
      return { reason: "protected_branch", message: `Temporary branch ${run.branch} is active in the canonical workspace; preserving it.` };
    }
    const branchMarker = `branch refs/heads/${run.branch}`;
    const activeElsewhere = records.some((record) => {
      const lines = record.split(/\r?\n/);
      const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      return path && canonicalExistingPath(path) !== runWorktreePath && lines.includes(branchMarker);
    });
    if (activeElsewhere) {
      return { reason: "active_worktree", message: `Branch ${run.branch} is checked out by another worktree; preserving it.` };
    }
  }
  return undefined;
}

function cleanupVerifiedWorktree(repoRoot: string, runId: string): WorktreeCleanupResult {
  const run = getAgentJob(repoRoot, runId);
  const blocker = worktreeCleanupBlocker(repoRoot, run);
  if (blocker) return preserveCleanup(repoRoot, runId, blocker.reason, blocker.message);
  markAgentJobClosure(repoRoot, runId, { state: "cleaning", details: "Removing the verified isolated worktree and temporary branch." });
  const cleanupPath = canonicalExistingPath(run.worktree);
  let removed = !existsSync(run.worktree);
  if (!removed) {
    const removal = gitBuffer(repoRoot, ["worktree", "remove", "--force", cleanupPath]);
    if (!removal.ok || existsSync(run.worktree)) {
      return preserveCleanup(repoRoot, runId, "cleanup_failed", `Git could not remove the verified worktree: ${removal.stderr || run.worktree}`);
    }
    removed = true;
  }
  let branchDeleted = !run.branch;
  if (run.branch) {
    const deleted = gitBuffer(repoRoot, ["branch", "-D", run.branch]);
    if (!deleted.ok && !deleted.stderr.includes("not found")) {
      return preserveCleanup(repoRoot, runId, "cleanup_failed", `Worktree was removed but branch ${run.branch} could not be deleted: ${deleted.stderr}`);
    }
    branchDeleted = true;
  }
  markAgentJobClosure(repoRoot, runId, {
    state: "cleanup_pending",
    details: "Verified worktree cleanup completed; Run completion is pending.",
    worktreeCleaned: removed,
    branchDeleted,
  });
  return { removed, branchDeleted };
}

export function cleanupIntegratedWorktree(
  repoRoot: string,
  runId: string,
): WorktreeCleanupResult {
  const run = getAgentJob(repoRoot, runId);
  if (run.provider !== "local" || run.executionMode !== "worktree")
    return { removed: false, branchDeleted: false };
  if (!run.integratedSessionId)
    return preserveCleanup(repoRoot, runId, "unmerged_branch", "Cannot clean an isolated worktree before its integration is durably recorded.");
  return cleanupVerifiedWorktree(repoRoot, runId);
}

export function cleanupNoChangeWorktree(
  repoRoot: string,
  runId: string,
): WorktreeCleanupResult {
  const run = getAgentJob(repoRoot, runId);
  if (run.provider !== "local" || run.executionMode !== "worktree")
    return { removed: false, branchDeleted: false };
  const diff = taskRunDiff(repoRoot, runId);
  if (diff.status || diff.diff || diff.untracked.length > 0) {
    return preserveCleanup(repoRoot, runId, "dirty_worktree", "Cannot discard a no-change worktree because it contains repository changes.");
  }
  return cleanupVerifiedWorktree(repoRoot, runId);
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
