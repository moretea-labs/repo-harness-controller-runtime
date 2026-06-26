import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  cleanupIntegratedWorktree,
  inspectIntegratedWorktreeCleanup,
} from "../../src/cli/agent-jobs/integration";
import type { AgentJobMeta } from "../../src/cli/agent-jobs/types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function fixture(): {
  root: string;
  worktree: string;
  branch: string;
  baseRevision: string;
} {
  const root = mkdtempSync(join(tmpdir(), "repo-harness-worktree-cleanup-"));
  roots.push(root);
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Repo Harness Test");
  writeFileSync(join(root, "example.txt"), "before\n");
  git(root, "add", "example.txt");
  git(root, "commit", "-m", "initial");
  const baseRevision = git(root, "rev-parse", "HEAD");
  const worktree = join(root, ".ai/harness/worktrees/test-run");
  const branch = "controller/iss-test-t1-12345678";
  mkdirSync(join(root, ".ai/harness/worktrees"), { recursive: true });
  git(root, "worktree", "add", "-b", branch, worktree, baseRevision);
  return { root, worktree, branch, baseRevision };
}

function writeRun(
  fixtureValue: ReturnType<typeof fixture>,
  overrides: Partial<AgentJobMeta> = {},
): string {
  const runId = overrides.runId ?? "RUN-iss-test-t1-1234567890123-12345678";
  const dir = join(fixtureValue.root, ".ai/harness/jobs", runId);
  mkdirSync(dir, { recursive: true });
  for (const name of ["stdout.log", "stderr.log", "events.jsonl"]) {
    writeFileSync(join(dir, name), "");
  }
  const meta: AgentJobMeta = {
    schemaVersion: 3,
    runId,
    issueId: "ISS-TEST",
    taskId: "T1",
    agent: "codex",
    provider: "local",
    executionMode: "worktree",
    status: "succeeded",
    repoRoot: fixtureValue.root,
    worktree: fixtureValue.worktree,
    branch: fixtureValue.branch,
    baseRevision: fixtureValue.baseRevision,
    promptPath: `.ai/harness/jobs/${runId}/prompt.md`,
    stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`,
    stderrPath: `.ai/harness/jobs/${runId}/stderr.log`,
    resultPath: `.ai/harness/jobs/${runId}/result.json`,
    eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`,
    createdAt: new Date().toISOString(),
    integratedSessionId: "EDIT-integrated",
    ...overrides,
  };
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return runId;
}

describe("integrated worktree cleanup", () => {
  test("removes only a branch whose dirty changes are reproduced in the target workspace", () => {
    const value = fixture();
    writeFileSync(join(value.worktree, "example.txt"), "after\n");
    writeFileSync(join(value.root, "example.txt"), "after\n");
    const runId = writeRun(value);

    const audit = inspectIntegratedWorktreeCleanup(value.root, runId);
    expect(audit.eligible).toBe(true);
    expect(audit.uniqueCommitCount).toBe(0);
    expect(audit.mismatchedPaths).toEqual([]);

    const result = cleanupIntegratedWorktree(value.root, runId);
    expect(result.removed).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(existsSync(value.worktree)).toBe(false);
    expect(() =>
      git(value.root, "show-ref", "--verify", `refs/heads/${value.branch}`),
    ).toThrow();
  });

  test("preserves a worktree when its final contents were not reproduced", () => {
    const value = fixture();
    writeFileSync(join(value.worktree, "example.txt"), "worktree-only\n");
    const runId = writeRun(value);

    const audit = inspectIntegratedWorktreeCleanup(value.root, runId);
    expect(audit.eligible).toBe(false);
    expect(audit.mismatchedPaths).toEqual(["example.txt"]);
    expect(() => cleanupIntegratedWorktree(value.root, runId)).toThrow(
      "not fully reproduced",
    );
    expect(existsSync(value.worktree)).toBe(true);
  });

  test("preserves a temporary branch with commits not reachable from target HEAD", () => {
    const value = fixture();
    writeFileSync(join(value.worktree, "example.txt"), "committed in worktree\n");
    git(value.worktree, "add", "example.txt");
    git(value.worktree, "commit", "-m", "unique worktree commit");
    writeFileSync(join(value.root, "example.txt"), "committed in worktree\n");
    const runId = writeRun(value);

    const audit = inspectIntegratedWorktreeCleanup(value.root, runId);
    expect(audit.eligible).toBe(false);
    expect(audit.uniqueCommitCount).toBe(1);
    expect(() => cleanupIntegratedWorktree(value.root, runId)).toThrow(
      "not reachable from the target checkout HEAD",
    );
    expect(existsSync(value.worktree)).toBe(true);
  });

  test("preserves a worktree referenced by another active Run", () => {
    const value = fixture();
    writeFileSync(join(value.worktree, "example.txt"), "after\n");
    writeFileSync(join(value.root, "example.txt"), "after\n");
    const runId = writeRun(value);
    const conflictingRunId = writeRun(value, {
      runId: "RUN-iss-test-t2-1234567890124-87654321",
      taskId: "T2",
      status: "waiting_for_user",
      integratedSessionId: undefined,
    });

    const audit = inspectIntegratedWorktreeCleanup(value.root, runId);
    expect(audit.eligible).toBe(false);
    expect(audit.conflictingRunIds).toEqual([conflictingRunId]);
    expect(existsSync(value.worktree)).toBe(true);
  });
});
