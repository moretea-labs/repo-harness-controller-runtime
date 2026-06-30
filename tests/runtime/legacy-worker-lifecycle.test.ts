import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, type ChildProcess } from "child_process";
import { isProcessAlive, terminateProcessTree } from "../../src/runtime/shared/process-tree";
import type { AgentJobMeta, AgentJobWorkerConfig } from "../../src/cli/agent-jobs/types";

type LegacyWorkerConfig = AgentJobWorkerConfig & {
  ownershipPollIntervalMs?: number;
  ownershipKillGraceMs?: number;
};

const roots: string[] = [];
const trackedPids = new Set<number>();
const originalPath = process.env.PATH;

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function workerEntry(): string {
  return join(import.meta.dir, "../../src/cli/agent-jobs/job-worker.ts");
}

function nowIso(): string {
  return new Date().toISOString();
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for worker test state");
}

function createFakeCodex(binRoot: string, agentPidPath: string): void {
  const executable = join(binRoot, "codex");
  writeFileSync(
    executable,
    `#!/usr/bin/env bash
echo "$$" > "${agentPidPath}"
printf '%s\n' '{"type":"turn.started"}'
trap 'exit 0' TERM INT
while true; do
  sleep 1
done
`,
  );
  chmodSync(executable, 0o755);
  process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
}

function writeWorkerFixture(
  root: string,
  overrides: Partial<LegacyWorkerConfig> = {},
): {
  jobDir: string;
  configPath: string;
  metaPath: string;
  resultPath: string;
  epochPath: string;
} {
  const runId = "RUN-legacy-worker";
  const jobDir = join(root, "job");
  mkdirSync(jobDir, { recursive: true });
  const metaPath = join(jobDir, "meta.json");
  const promptPath = join(jobDir, "prompt.md");
  const stdoutPath = join(jobDir, "stdout.log");
  const stderrPath = join(jobDir, "stderr.log");
  const resultPath = join(jobDir, "result.json");
  const eventsPath = join(jobDir, "events.jsonl");
  const configPath = join(jobDir, "worker-config.json");
  const epochPath = join(root, ".ai/harness/controller/runtime-owner.json");
  mkdirSync(join(root, ".ai/harness/controller"), { recursive: true });
  const epoch = {
    schemaVersion: 1,
    pid: process.pid,
    epoch: "worker-test-epoch",
    startedAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeFileSync(epochPath, `${JSON.stringify(epoch, null, 2)}\n`);
  const meta: AgentJobMeta = {
    schemaVersion: 3,
    runId,
    issueId: "ISS-1",
    taskId: "T1",
    agent: "codex",
    provider: "local",
    executionMode: "workspace",
    status: "starting",
    repoRoot: root,
    executionRoot: root,
    worktree: root,
    worktreePath: root,
    branch: null,
    baseRevision: null,
    promptPath,
    stdoutPath,
    stderrPath,
    resultPath,
    eventsPath,
    controllerPid: epoch.pid,
    controllerEpoch: epoch.epoch,
    controllerEpochPath: epochPath,
    createdAt: nowIso(),
  };
  const config: LegacyWorkerConfig = {
    metaPath,
    agent: "codex",
    worktree: root,
    promptPath,
    stdoutPath,
    stderrPath,
    resultPath,
    eventsPath,
    timeoutMs: 15_000,
    autoIntegrate: false,
    controllerPid: epoch.pid,
    controllerEpoch: epoch.epoch,
    controllerEpochPath: epochPath,
    parentPid: process.pid,
    ownershipPollIntervalMs: 100,
    ownershipKillGraceMs: 250,
    ...overrides,
  };
  writeFileSync(promptPath, "Keep running until the worker stops you.\n");
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "");
  writeFileSync(eventsPath, "");
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { jobDir, configPath, metaPath, resultPath, epochPath };
}

async function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for worker exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

afterEach(async () => {
  process.env.PATH = originalPath;
  const remaining = new Set<number>();
  for (const pid of trackedPids) {
    const result = await terminateProcessTree(pid, {
      gracePeriodMs: 100,
      killAfterMs: 1_000,
      pollIntervalMs: 25,
    });
    for (const remainingPid of result.remainingPids) remaining.add(remainingPid);
  }
  trackedPids.clear();
  if (remaining.size > 0) {
    throw new Error(`worker lifecycle test leaked process IDs: ${[...remaining].join(", ")}`);
  }
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("legacy worker lifecycle hardening", () => {
  test("terminates the agent tree before exiting when the job metadata directory disappears", async () => {
    const root = tempRoot("repo-harness-worker-meta-delete-");
    const binRoot = tempRoot("repo-harness-worker-bin-");
    const agentPidPath = join(root, "agent.pid");
    createFakeCodex(binRoot, agentPidPath);
    const fixture = writeWorkerFixture(root);

    const worker = spawn(process.execPath, [workerEntry(), fixture.configPath], {
      cwd: root,
      stdio: "ignore",
    });
    trackedPids.add(worker.pid!);

    const agentPid = await waitFor(() => {
      if (!existsSync(agentPidPath)) return undefined;
      const value = Number.parseInt(readFileSync(agentPidPath, "utf-8").trim(), 10);
      return Number.isInteger(value) && value > 0 ? value : undefined;
    });
    trackedPids.add(agentPid);
    await waitFor(() => (isProcessAlive(agentPid) ? true : undefined));

    rmSync(fixture.jobDir, { recursive: true, force: true });

    const exited = await waitForExit(worker);
    expect(exited.code).not.toBe(0);
    await waitFor(() => (!isProcessAlive(agentPid) ? true : undefined));
  });

  test("fails closed when its launcher parent disappears unexpectedly", async () => {
    const root = tempRoot("repo-harness-worker-parent-exit-");
    const binRoot = tempRoot("repo-harness-worker-bin-");
    const agentPidPath = join(root, "agent.pid");
    const workerPidPath = join(root, "worker.pid");
    createFakeCodex(binRoot, agentPidPath);
    const fixture = writeWorkerFixture(root, { parentPid: undefined });
    const launcherScript = join(root, "launcher.js");
    writeFileSync(
      launcherScript,
      `
const { readFileSync, writeFileSync } = require("fs");
const { spawn } = require("child_process");
const configPath = process.argv[2];
const workerEntry = process.argv[3];
const workerPidPath = process.argv[4];
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.parentPid = process.pid;
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n", "utf8");
const child = spawn(process.execPath, [workerEntry, configPath], { cwd: ${JSON.stringify(root)}, stdio: "ignore" });
writeFileSync(workerPidPath, String(child.pid), "utf8");
setTimeout(() => process.exit(0), 800);
`,
    );

    const launcher = spawn(process.execPath, [launcherScript, fixture.configPath, workerEntry(), workerPidPath], {
      cwd: root,
      stdio: "ignore",
    });
    trackedPids.add(launcher.pid!);

    const workerPid = await waitFor(() => {
      if (!existsSync(workerPidPath)) return undefined;
      const value = Number.parseInt(readFileSync(workerPidPath, "utf-8").trim(), 10);
      return Number.isInteger(value) && value > 0 ? value : undefined;
    });
    trackedPids.add(workerPid);

    const agentPid = await waitFor(() => {
      if (!existsSync(agentPidPath)) return undefined;
      const value = Number.parseInt(readFileSync(agentPidPath, "utf-8").trim(), 10);
      return Number.isInteger(value) && value > 0 ? value : undefined;
    });
    trackedPids.add(agentPid);
    await waitFor(() => (isProcessAlive(workerPid) && isProcessAlive(agentPid) ? true : undefined));

    await waitForExit(launcher);
    await waitFor(() => (!isProcessAlive(workerPid) ? true : undefined));
    await waitFor(() => (!isProcessAlive(agentPid) ? true : undefined));

    const result = JSON.parse(readFileSync(fixture.resultPath, "utf-8")) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("PPID became 1");
  });
});
