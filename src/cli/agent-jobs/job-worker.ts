import { appendFileSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
import { spawn } from "child_process";
import { getIssue, removeEphemeralIssue, updateTask } from "../controller/issue-store";
import { invalidateAgentWorker } from "./worker-lifecycle";
import type {
  AgentJobEvent,
  AgentJobMeta,
  AgentJobProgress,
  AgentJobWorkerConfig,
  AgentProgressPhase,
} from "./types";

const configPath = process.argv[2];
if (!configPath) throw new Error("agent job worker requires a config path");

type AgentJobWorkerRuntimeConfig = AgentJobWorkerConfig & {
  ownershipPollIntervalMs?: number;
  ownershipKillGraceMs?: number;
};

const config = JSON.parse(
  readFileSync(configPath, "utf-8"),
) as AgentJobWorkerRuntimeConfig;
const prompt = readFileSync(config.promptPath, "utf-8");
const meta = JSON.parse(readFileSync(config.metaPath, "utf-8")) as AgentJobMeta;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const OWNERSHIP_POLL_INTERVAL_MS = Math.max(
  50,
  config.ownershipPollIntervalMs ?? 5_000,
);
const OWNERSHIP_KILL_GRACE_MS = Math.max(
  100,
  config.ownershipKillGraceMs ?? 5_000,
);
let timedOut = false;
let spawnError: Error | undefined;
let ownershipError: Error | undefined;
let child: ReturnType<typeof spawn> | undefined;
let childExited = false;
let failClosedRequested = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let ownershipGuard: ReturnType<typeof setInterval> | undefined;
let executionTimeout: ReturnType<typeof setTimeout> | undefined;
let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
let hardExitTimer: ReturnType<typeof setTimeout> | undefined;
let settleAgentResult:
  | ((code: number | null, signal: NodeJS.Signals | null) => void)
  | undefined;
assertOwnership();

function event(
  type: AgentJobEvent["type"],
  message?: string,
  data?: Record<string, unknown>,
): void {
  appendFileSync(
    config.eventsPath,
    `${JSON.stringify({ at: new Date().toISOString(), type, message, data })}\n`,
    "utf-8",
  );
}

function persistJson(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(temporaryPath, path);
}

function persistMeta(value: AgentJobMeta): void {
  persistJson(config.metaPath, value);
}

function missingOwnershipError(): Error {
  return new Error("Run ownership metadata is unreadable or missing");
}

function tryReadMeta(): AgentJobMeta | undefined {
  try {
    return JSON.parse(readFileSync(config.metaPath, "utf-8")) as AgentJobMeta;
  } catch (_error) {
    return undefined;
  }
}

function readMeta(): AgentJobMeta {
  const current = tryReadMeta();
  if (!current) throw missingOwnershipError();
  return current;
}

function ownershipFailure(current: AgentJobMeta | undefined): Error | undefined {
  if (!current) return missingOwnershipError();
  const invalidation = invalidateAgentWorker(current, {
    controllerPid: config.controllerPid,
    controllerEpoch: config.controllerEpoch,
    controllerEpochPath: config.controllerEpochPath,
    parentPid: config.parentPid,
  }, {
    currentParentPid: process.ppid,
    workerPid: process.pid,
  });
  return invalidation ? new Error(invalidation.message) : undefined;
}

function assertOwnership(): void {
  const invalid = ownershipFailure(tryReadMeta());
  if (invalid) throw invalid;
}

function persistOwnershipLoss(reason: string): void {
  const current = readMeta();
  if (
    current.workerPid !== process.pid ||
    !["starting", "running"].includes(current.status)
  ) {
    return;
  }
  current.status = "unknown";
  current.error = reason;
  current.finishedAt = new Date().toISOString();
  current.lastHeartbeatAt = current.finishedAt;
  current.progress = {
    phase: "failed",
    percent: 100,
    currentActivity: reason,
    lastActivityAt: current.finishedAt,
    activityCount: (current.progress?.activityCount ?? 0) + 1,
  };
  persistMeta(current);
  event("run_failed", reason, { ownershipLost: true });
}

function terminateAgent(signal: NodeJS.Signals): void {
  if (!child?.pid || childExited) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (_error) {
    try {
      child.kill(signal);
    } catch (_nested) {
      /* process already exited */
    }
  }
}

function stopWorkerLoops(): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }
  if (ownershipGuard) {
    clearInterval(ownershipGuard);
    ownershipGuard = undefined;
  }
}

function clearTerminationTimers(): void {
  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
    forceKillTimer = undefined;
  }
  if (hardExitTimer) {
    clearTimeout(hardExitTimer);
    hardExitTimer = undefined;
  }
}

function scheduleBoundedTermination(): void {
  terminateAgent("SIGTERM");
  forceKillTimer ??= setTimeout(() => {
    terminateAgent("SIGKILL");
  }, OWNERSHIP_KILL_GRACE_MS);
  forceKillTimer.unref();
  hardExitTimer ??= setTimeout(() => {
    terminateAgent("SIGKILL");
    if (settleAgentResult) {
      settleAgentResult(null, "SIGKILL");
      return;
    }
    process.exit(1);
  }, OWNERSHIP_KILL_GRACE_MS + 250);
}

function beginFailClosed(reason: string): void {
  failClosedRequested = true;
  ownershipError ??= new Error(reason);
  stopWorkerLoops();
  try {
    persistOwnershipLoss(reason);
  } catch (_error) {
    /* metadata may already be gone; fail-closed still terminates the child tree */
  }
  try {
    updateProgress("failed", reason, 100, { ownershipLost: true });
  } catch (_error) {
    /* metadata may already be gone; fail-closed still terminates the child tree */
  }
  scheduleBoundedTermination();
}

function fatalWorkerError(error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  if (!failClosedRequested) {
    beginFailClosed(reason || "worker encountered an unexpected fatal error");
  }
  if (!child?.pid || childExited) process.exit(1);
}

process.once("uncaughtException", fatalWorkerError);
process.once("unhandledRejection", fatalWorkerError);

function appendBounded(
  path: string,
  chunk: Buffer,
  written: number,
  truncated: boolean,
): { written: number; truncated: boolean } {
  if (written >= MAX_STREAM_BYTES) return { written, truncated: true };
  const remaining = MAX_STREAM_BYTES - written;
  const accepted = chunk.subarray(0, remaining);
  if (accepted.length > 0) appendFileSync(path, accepted);
  const nextTruncated = truncated || accepted.length < chunk.length;
  if (nextTruncated && !truncated)
    appendFileSync(
      path,
      "\n[repo-harness] output truncated at 4 MiB\n",
      "utf-8",
    );
  return { written: written + accepted.length, truncated: nextTruncated };
}

function compact(value: unknown, max = 220): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const phaseFloor: Record<AgentProgressPhase, number> = {
  queued: 2,
  starting: 5,
  inspecting: 15,
  editing: 42,
  testing: 72,
  finalizing: 90,
  waiting: 55,
  completed: 100,
  failed: 100,
};

const phaseCeiling: Record<AgentProgressPhase, number> = {
  queued: 4,
  starting: 14,
  inspecting: 41,
  editing: 71,
  testing: 89,
  finalizing: 99,
  waiting: 95,
  completed: 100,
  failed: 100,
};

function updateProgress(
  phase: AgentProgressPhase,
  activity: string,
  percent?: number,
  data?: Record<string, unknown>,
): void {
  const current = JSON.parse(
    readFileSync(config.metaPath, "utf-8"),
  ) as AgentJobMeta;
  const previous = current.progress;
  const basePercent = Math.min(99, percent ?? phaseFloor[phase]);
  const samePhaseIncrement = previous?.phase === phase
    ? Math.min(phaseCeiling[phase], (previous.percent ?? phaseFloor[phase]) + 1)
    : basePercent;
  const nextPercent = Math.max(previous?.percent ?? 0, basePercent, samePhaseIncrement);
  const progress: AgentJobProgress = {
    phase,
    percent: phase === "completed" || phase === "failed" ? 100 : nextPercent,
    currentActivity:
      compact(activity, 280) || previous?.currentActivity || "Agent 正在工作",
    lastActivityAt: new Date().toISOString(),
    activityCount: (previous?.activityCount ?? 0) + 1,
  };
  current.progress = progress;
  current.lastHeartbeatAt = progress.lastActivityAt;
  persistMeta(current);
  event("run_activity", progress.currentActivity, {
    phase,
    percent: progress.percent,
    ...(data ?? {}),
  });
}

function codexActivity(line: string):
  | {
      phase: AgentProgressPhase;
      message: string;
      percent?: number;
      data?: Record<string, unknown>;
    }
  | undefined {
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(line) as Record<string, any>;
  } catch (_error) {
    return undefined;
  }
  const type = String(payload.type ?? payload.event ?? "");
  const item = (
    payload.item && typeof payload.item === "object" ? payload.item : payload
  ) as Record<string, any>;
  const itemType = String(item.type ?? payload.item_type ?? "");
  if (type.includes("thread.started"))
    return { phase: "starting", message: "Codex 会话已建立", percent: 8 };
  if (type.includes("turn.started"))
    return {
      phase: "inspecting",
      message: "正在理解任务并检查项目",
      percent: 14,
    };
  if (type.includes("turn.completed"))
    return {
      phase: "finalizing",
      message: "本轮实现完成，正在整理结果",
      percent: 92,
    };
  if (type.includes("turn.failed") || type.includes("error"))
    return {
      phase: "waiting",
      message: compact(
        payload.error?.message ?? payload.message ?? "Codex 报告异常",
      ),
      percent: 60,
    };
  if (itemType.includes("command")) {
    const command = compact(
      item.command ??
        item.cmd ??
        item.text ??
        payload.command ??
        "执行本地命令",
    );
    const testing =
      /test|build|lint|check|xcodebuild|swift test|npm test|bun test/i.test(
        command,
      );
    return {
      phase: testing ? "testing" : "inspecting",
      message: `${testing ? "正在验证" : "正在执行"}：${command}`,
      percent: testing ? 76 : 28,
      data: { command },
    };
  }
  if (/file|patch|edit|change/i.test(itemType)) {
    const path = compact(
      item.path ??
        item.file_path ??
        item.filename ??
        item.changes?.[0]?.path ??
        "项目文件",
    );
    return {
      phase: "editing",
      message: `正在修改：${path}`,
      percent: 52,
      data: { path },
    };
  }
  if (/agent_message|message/i.test(itemType)) {
    const message = compact(
      item.text ?? item.content ?? payload.message ?? "Agent 更新了执行说明",
    );
    if (message) return { phase: "finalizing", message, percent: 88 };
  }
  if (/reasoning|analysis/i.test(itemType))
    return { phase: "inspecting", message: "正在分析实现路径", percent: 22 };
  if (type.includes("item.started"))
    return {
      phase: "inspecting",
      message: `正在处理 ${itemType || "下一步骤"}`,
      percent: 20,
    };
  if (type.includes("item.completed"))
    return {
      phase: "editing",
      message: `${itemType || "步骤"} 已完成`,
      percent: 58,
    };
  return undefined;
}

function genericActivity(
  line: string,
):
  | { phase: AgentProgressPhase; message: string; percent?: number; data?: Record<string, unknown> }
  | undefined {
  const text = compact(line);
  if (!text) return undefined;
  if (/test|build|lint|check|xcodebuild|验证|测试|编译/i.test(text))
    return { phase: "testing", message: text, percent: 76 };
  if (/edit|write|patch|modify|create|delete|修改|写入|创建|删除/i.test(text))
    return { phase: "editing", message: text, percent: 50 };
  return { phase: "inspecting", message: text, percent: 24 };
}

meta.status = "running";
meta.startedAt = meta.startedAt ?? new Date().toISOString();
meta.timeoutMs = config.timeoutMs;
meta.deadlineAt = new Date(
  Date.parse(meta.startedAt) + config.timeoutMs,
).toISOString();
meta.lastHeartbeatAt = new Date().toISOString();
meta.progress = {
  phase: "starting",
  percent: 5,
  currentActivity: `正在启动 ${config.agent}`,
  lastActivityAt: meta.lastHeartbeatAt,
  activityCount: 0,
};
persistMeta(meta);
event("run_started", `${config.agent} process starting.`, {
  executionMode: meta.executionMode,
  autoIntegrate: config.autoIntegrate,
});

const command =
  config.agent === "codex"
    ? {
        bin: "codex",
        args: ["exec", "--json", "--cd", config.worktree, prompt],
      }
    : { bin: "claude", args: ["-p", prompt] };

writeFileSync(config.stdoutPath, "", "utf-8");
writeFileSync(config.stderrPath, "", "utf-8");

let stdoutBytes = 0;
let stderrBytes = 0;
let stdoutTruncated = false;
let stderrTruncated = false;
let stderrPreview = "";
let lastLogEventAt = 0;
let lastActivityAt = 0;
let stdoutLineBuffer = "";
let stderrLineBuffer = "";
function noteLogUpdate(stream: "stdout" | "stderr", bytes: number): void {
  const now = Date.now();
  if (now - lastLogEventAt < 750) return;
  lastLogEventAt = now;
  event("log_updated", `${stream} updated.`, {
    stdoutBytes,
    stderrBytes,
    chunkBytes: bytes,
  });
}

function consumeLines(stream: "stdout" | "stderr", chunk: Buffer): void {
  let buffer =
    (stream === "stdout" ? stdoutLineBuffer : stderrLineBuffer) +
    chunk.toString("utf-8");
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  if (stream === "stdout") stdoutLineBuffer = buffer;
  else stderrLineBuffer = buffer;
  for (const line of lines) {
    const activity =
      config.agent === "codex"
        ? (codexActivity(line) ?? genericActivity(line))
        : genericActivity(line);
    if (!activity) continue;
    const now = Date.now();
    if (now - lastActivityAt < 500 && activity.phase === "inspecting") continue;
    lastActivityAt = now;
    updateProgress(
      activity.phase,
      activity.message,
      activity.percent,
      "data" in activity ? activity.data : undefined,
    );
  }
}

child = spawn(command.bin, command.args, {
  cwd: config.worktree,
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
});
meta.agentPid = child.pid;
persistMeta(meta);
updateProgress("starting", `${config.agent} 进程已启动`, 8, { pid: child.pid });

child.stdout?.on("data", (value: Buffer | string) => {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const next = appendBounded(
    config.stdoutPath,
    chunk,
    stdoutBytes,
    stdoutTruncated,
  );
  stdoutBytes = next.written;
  stdoutTruncated = next.truncated;
  consumeLines("stdout", chunk);
  noteLogUpdate("stdout", chunk.length);
});

child.stderr?.on("data", (value: Buffer | string) => {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const next = appendBounded(
    config.stderrPath,
    chunk,
    stderrBytes,
    stderrTruncated,
  );
  stderrBytes = next.written;
  stderrTruncated = next.truncated;
  stderrPreview = `${stderrPreview}${chunk.toString("utf-8")}`.slice(
    -16 * 1024,
  );
  consumeLines("stderr", chunk);
  noteLogUpdate("stderr", chunk.length);
});

heartbeat = setInterval(() => {
  if (failClosedRequested) return;
  const current = tryReadMeta();
  if (!current) {
    beginFailClosed(missingOwnershipError().message);
    return;
  }
  try {
    current.lastHeartbeatAt = new Date().toISOString();
    persistMeta(current);
    event(
      "run_heartbeat",
      current.progress?.currentActivity ?? "Agent process is still running.",
      {
        pid: child?.pid,
        stdoutBytes,
        stderrBytes,
        deadlineAt: current.deadlineAt,
        phase: current.progress?.phase,
        percent: current.progress?.percent,
      },
    );
  } catch (error) {
    beginFailClosed(error instanceof Error ? error.message : String(error));
  }
}, 10_000);
heartbeat.unref();

ownershipGuard = setInterval(() => {
  if (failClosedRequested) return;
  const invalid = ownershipFailure(tryReadMeta());
  if (!invalid) return;
  beginFailClosed(invalid.message);
}, OWNERSHIP_POLL_INTERVAL_MS);
ownershipGuard.unref();

const result = await new Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>((resolve) => {
  let settled = false;
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return;
    settled = true;
    childExited = true;
    stopWorkerLoops();
    if (executionTimeout) {
      clearTimeout(executionTimeout);
      executionTimeout = undefined;
    }
    clearTerminationTimers();
    settleAgentResult = undefined;
    resolve({ code, signal });
  };
  settleAgentResult = finish;
  child.once("error", (error) => {
    spawnError = error;
    finish(null, null);
  });
  child.once("exit", (code, signal) => finish(code, signal));
  child.once("close", () => {
    childExited = true;
  });

  executionTimeout = setTimeout(() => {
    timedOut = true;
    try {
      updateProgress(
        "waiting",
        `已达到执行时限 ${config.timeoutMs}ms，正在终止进程`,
        98,
      );
      event(
        "run_waiting",
        `Agent exceeded timeout ${config.timeoutMs}ms; terminating process.`,
      );
    } catch (_error) {
      /* timeout remains authoritative even if runtime metadata disappeared */
    }
    stopWorkerLoops();
    scheduleBoundedTermination();
  }, config.timeoutMs);
  executionTimeout.unref();
});

const finishedAt = new Date().toISOString();
const finalOwnershipError = ownershipError ?? ownershipFailure(tryReadMeta());
if (finalOwnershipError) {
  try {
    persistOwnershipLoss(finalOwnershipError.message);
  } catch (_error) {
    /* metadata may already be gone; the worker still exits fail-closed */
  }
}
const ok = result.code === 0 && !timedOut && !spawnError && !finalOwnershipError;
const error =
  finalOwnershipError?.message ??
  spawnError?.message ??
  (timedOut ? `agent timed out after ${config.timeoutMs}ms` : undefined) ??
  (ok
    ? undefined
    : stderrPreview.trim() ||
      `agent exited with code ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}`);

persistJson(config.resultPath, {
  ok,
  exitCode: result.code,
  timedOut,
  signal: result.signal,
  error,
  stdoutBytes,
  stderrBytes,
  stdoutTruncated,
  stderrTruncated,
  finishedAt,
});

const finalMeta = tryReadMeta();
if (!finalMeta) process.exit(1);
if (finalMeta.status === "cancelled" || finalMeta.terminationReason === "cancelled") {
  stopWorkerLoops();
  clearTerminationTimers();
  process.exit(0);
}
const currentOwnershipError = ownershipFailure(finalMeta);
if (currentOwnershipError) {
  process.exit(1);
}
const autoFinalizing = ok && config.autoIntegrate && finalMeta.executionMode === "worktree";
finalMeta.status = ok ? (autoFinalizing ? "running" : "succeeded") : "failed";
finalMeta.exitCode = result.code;
finalMeta.error = error;
finalMeta.terminationReason = timedOut
  ? "timeout"
  : spawnError
    ? "spawn_error"
    : result.signal
      ? "signal"
      : undefined;
finalMeta.lastHeartbeatAt = finishedAt;
if (autoFinalizing) delete finalMeta.finishedAt;
else finalMeta.finishedAt = finishedAt;
finalMeta.progress = {
  phase: autoFinalizing ? "finalizing" : ok ? "completed" : "failed",
  percent: autoFinalizing ? 96 : 100,
  currentActivity: autoFinalizing
    ? "Agent 实现已完成，正在自动集成 worktree 修改"
    : ok
      ? "Agent 实现已完成"
      : (error ?? "Agent 执行失败"),
  lastActivityAt: finishedAt,
  activityCount: (finalMeta.progress?.activityCount ?? 0) + 1,
};
persistMeta(finalMeta);
event("log_updated", "Agent output stream closed.", {
  stdoutBytes,
  stderrBytes,
  stdoutTruncated,
  stderrTruncated,
});
if (!ok) event("run_failed", error);
else if (autoFinalizing) event("run_activity", "Agent process finished; automatic integration is finalizing.");
else event("run_succeeded", "Agent process finished successfully.");

if (!ok) {
  try {
    updateTask(finalMeta.repoRoot, finalMeta.issueId, finalMeta.taskId, {
      status: "blocked",
      runId: finalMeta.runId,
      transition: "run_sync",
      note: `${finalMeta.runId} ended as ${finalMeta.status}; explicit retry is required.${error ? ` ${error}` : ""}`,
    });
  } catch (_error) {
    /* Explicit terminal or parent lifecycle state remains authoritative. */
  }
}

if (ok) {
  try {
    updateTask(finalMeta.repoRoot, finalMeta.issueId, finalMeta.taskId, {
      status: "review",
      runId: finalMeta.runId,
      transition: "run_sync",
      note: `${finalMeta.runId} finished successfully.${config.autoIntegrate ? " Automatic integration is starting." : ""}`,
    });
  } catch (_error) {
    /* Run result remains inspectable even when the Issue was edited manually. */
  }
}

if (ok && config.autoIntegrate && finalMeta.executionMode === "worktree") {
  try {
    assertOwnership();
    updateProgress("finalizing", "正在自动集成 worktree 修改", 96);
    const [
      { integrateAgentJob, cleanupIntegratedWorktree, taskRunDiff },
      { getMcpPolicy },
    ] = await Promise.all([import("./integration"), import("../mcp/policy")]);
    const archivedDiff = taskRunDiff(
      finalMeta.repoRoot,
      finalMeta.runId,
      1024 * 1024,
    );
    const diffArtifactPath = join(
      dirname(config.metaPath),
      "worktree-diff.json",
    );
    writeFileSync(
      diffArtifactPath,
      `${JSON.stringify(archivedDiff, null, 2)}\n`,
      "utf-8",
    );
    const beforeIntegrationMeta = JSON.parse(
      readFileSync(config.metaPath, "utf-8"),
    ) as AgentJobMeta;
    assertOwnership();
    beforeIntegrationMeta.diffArtifactPath = relative(
      finalMeta.repoRoot,
      diffArtifactPath,
    ).replace(/\\/g, "/");
    persistMeta(beforeIntegrationMeta);
    const integrated = integrateAgentJob(
      finalMeta.repoRoot,
      getMcpPolicy("controller", { repoRoot: finalMeta.repoRoot }),
      finalMeta.runId,
    );
    assertOwnership();
    event(
      "run_auto_integrated",
      `Automatically integrated ${integrated.changedPaths.length} changed path(s).`,
      {
        changedPaths: integrated.changedPaths,
        sessionId: integrated.session.sessionId,
      },
    );
    const cleanup = cleanupIntegratedWorktree(
      finalMeta.repoRoot,
      finalMeta.runId,
    );
    const integratedMeta = JSON.parse(
      readFileSync(config.metaPath, "utf-8"),
    ) as AgentJobMeta;
    const completedAt = new Date().toISOString();
    integratedMeta.status = "succeeded";
    integratedMeta.finishedAt = completedAt;
    integratedMeta.lastHeartbeatAt = completedAt;
    integratedMeta.worktreeCleanedAt = completedAt;
    integratedMeta.progress = {
      phase: "completed",
      percent: 100,
      currentActivity: "实现已完成并自动集成到当前工作区",
      lastActivityAt: completedAt,
      activityCount: (integratedMeta.progress?.activityCount ?? 0) + 1,
    };
    persistMeta(integratedMeta);
    event(
      "run_worktree_cleaned",
      "Integrated worktree and temporary branch were removed.",
      cleanup,
    );
    event("run_succeeded", "Agent process, automatic integration, and worktree cleanup completed.");
  } catch (integrationError) {
    const failedMeta = JSON.parse(
      readFileSync(config.metaPath, "utf-8"),
    ) as AgentJobMeta;
    if (ownershipFailure(failedMeta)) process.exit(1);
    const completedAt = new Date().toISOString();
    failedMeta.status = "waiting_for_user";
    delete failedMeta.finishedAt;
    failedMeta.lastHeartbeatAt = completedAt;
    failedMeta.autoIntegrationError =
      integrationError instanceof Error
        ? integrationError.message
        : String(integrationError);
    failedMeta.progress = {
      phase: "waiting",
      percent: 96,
      currentActivity: `实现完成，但自动集成需要处理：${failedMeta.autoIntegrationError}`,
      lastActivityAt: completedAt,
      activityCount: (failedMeta.progress?.activityCount ?? 0) + 1,
    };
    persistMeta(failedMeta);
    event(
      "run_waiting",
      "Automatic worktree integration failed; the worktree was preserved for review.",
      { error: failedMeta.autoIntegrationError },
    );
    try {
      updateTask(failedMeta.repoRoot, failedMeta.issueId, failedMeta.taskId, {
        status: "review",
        note: `Automatic integration failed for ${failedMeta.runId}: ${failedMeta.autoIntegrationError}`,
      });
    } catch (_error) {
      /* ignore */
    }
  }
}

let continuationStatus: string | undefined;
if (ok) {
  try {
    const { continueTaskAfterSuccessfulRun } = await import("../controller/execution-completion");
    const latestMeta = JSON.parse(readFileSync(config.metaPath, "utf-8")) as AgentJobMeta;
    assertOwnership();
    const continuation = continueTaskAfterSuccessfulRun(latestMeta.repoRoot, latestMeta);
    continuationStatus = continuation.status;
    if (continuation.continued) {
      event("run_verified", `Controller continued Task lifecycle to ${continuation.status}.`, {
        status: continuation.status,
        checkCount: continuation.checkCount,
      });
    } else if (continuation.reason) {
      event("run_waiting", continuation.reason);
    }
  } catch (continuationError) {
    event(
      "run_waiting",
      `Run succeeded but automatic Task continuation failed: ${continuationError instanceof Error ? continuationError.message : String(continuationError)}`,
    );
  }
}

if (!ok || continuationStatus === "done") {
  try {
    const issue = getIssue(finalMeta.repoRoot, finalMeta.issueId);
    if (issue.ephemeral) removeEphemeralIssue(finalMeta.repoRoot, issue.id);
  } catch (_error) {
    // Ephemeral Quick Agent metadata is best-effort; Run logs remain durable.
  }
}

process.exit(ok ? 0 : 1);
