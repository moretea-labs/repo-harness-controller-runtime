import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { cancelAgentJob, getAgentJob } from "../../src/cli/agent-jobs/job-manager";
import type { AgentJobMeta } from "../../src/cli/agent-jobs/types";
import { isProcessAlive, terminateProcessTree } from "../../src/runtime/shared/process-tree";
import { terminateProcessesByCommand, waitForNoProcessesByCommand } from "./process-hygiene";

const roots: string[] = [];
const trackedPids = new Set<number>();

afterEach(async () => {
  for (const pid of trackedPids) {
    await terminateProcessTree(pid, { gracePeriodMs: 50, killAfterMs: 500, pollIntervalMs: 20 });
  }
  trackedPids.clear();
  await terminateProcessesByCommand(roots);
  await waitForNoProcessesByCommand(roots);
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function waitForCleanup(repoRoot: string, runId: string, timeoutMs = 7_000): Promise<AgentJobMeta> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = getAgentJob(repoRoot, runId);
    if (!current.cleanupPending) return current;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for detached cancellation cleanup");
}

describe("durable Task Run cancellation", () => {
  test("persists cancellation before asynchronously reclaiming the process tree", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "repo-harness-cancel-durable-"));
    roots.push(repoRoot);
    const runId = `RUN-cancel-${Date.now()}`;
    const runRoot = join(repoRoot, ".ai/harness/jobs", runId);
    mkdirSync(runRoot, { recursive: true });

    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { detached: true, stdio: "ignore" },
    );
    if (!child.pid) throw new Error("failed to start cancellation fixture process");
    trackedPids.add(child.pid);
    child.unref();
    await Bun.sleep(50);
    expect(isProcessAlive(child.pid)).toBe(true);

    const createdAt = new Date().toISOString();
    const meta: AgentJobMeta = {
      schemaVersion: 3,
      runId,
      issueId: "ISS-CANCEL",
      taskId: "T1",
      agent: "codex",
      provider: "local",
      executionMode: "workspace",
      status: "queued",
      repoRoot,
      worktree: repoRoot,
      branch: null,
      baseRevision: null,
      promptPath: `.ai/harness/jobs/${runId}/prompt.md`,
      stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`,
      stderrPath: `.ai/harness/jobs/${runId}/stderr.log`,
      resultPath: `.ai/harness/jobs/${runId}/result.json`,
      eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`,
      agentPid: child.pid,
      createdAt,
      startedAt: createdAt,
      lastHeartbeatAt: createdAt,
    };
    writeFileSync(join(runRoot, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    writeFileSync(join(runRoot, "stdout.log"), "");
    writeFileSync(join(runRoot, "stderr.log"), "");

    const startedAt = Date.now();
    const cancelled = cancelAgentJob(repoRoot, runId);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(750);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.terminationReason).toBe("cancelled");
    expect(cancelled.cleanupPending).toBe(true);
    expect(cancelled.cancellationPids).toContain(child.pid);
    expect(getAgentJob(repoRoot, runId).status).toBe("cancelled");

    const replay = cancelAgentJob(repoRoot, runId);
    expect(replay.cancellationRequestedAt).toBe(cancelled.cancellationRequestedAt);

    const cleaned = await waitForCleanup(repoRoot, runId);
    trackedPids.delete(child.pid);
    expect(cleaned.status).toBe("cancelled");
    expect(cleaned.cleanupPending).toBe(false);
    expect(cleaned.cleanupFinishedAt).toBeDefined();
    expect(cleaned.cancellationPids).toEqual([]);
    expect(isProcessAlive(child.pid)).toBe(false);
    const replayAfterCleanup = cancelAgentJob(repoRoot, runId);
    expect(replayAfterCleanup.cleanupFinishedAt).toBe(cleaned.cleanupFinishedAt);

    const events = readFileSync(join(runRoot, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.filter((event) => event.type === "run_cancelled")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run_cleanup_completed")).toHaveLength(1);
  });
});
