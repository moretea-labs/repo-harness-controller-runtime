import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createIssue, updateTask } from "../../src/cli/controller/issue-store";
import {
  buildControllerTaskLedgerProjection,
  controllerTaskLedgerArtifactPaths,
  writeControllerTaskLedgerArtifacts,
} from "../../src/cli/controller/task-ledger";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-harness-task-ledger-"));
  roots.push(root);
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, ".ai/harness"), { recursive: true });
  return root;
}

describe("controller task ledger projection", () => {
  test("builds a compact recovery projection without replacing source review", () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Ledger recovery",
      summary: "Recover controller state compactly.",
      tasks: [{
        title: "Implement slice",
        objective: "Change one bounded module.",
        allowedPaths: ["src/runtime/**"],
        checks: ["check:type"],
      }],
    });
    updateTask(root, issue.id, "T1", { status: "review", note: "Ready for controller review." });

    const projection = buildControllerTaskLedgerProjection(root);

    expect(projection.source).toBe("controller-task-ledger");
    expect(projection.currentIssueId).toBe(issue.id);
    expect(projection.issueCount).toBe(1);
    expect(projection.attention[0]?.taskId).toBe("T1");
    expect(projection.attention[0]?.effectiveStatus).toBe("review");
    expect(projection.suggestedNextActions.join("\n")).toContain("Review Task");
    expect(projection.contextContract.rawCodeRequiredForImplementation).toBe(true);
  });

  test("writes JSON and markdown handoff artifacts for fresh-session recovery", () => {
    const root = repo();
    createIssue(root, {
      title: "Handoff recovery",
      summary: "Persist compact continuation state.",
      tasks: [{ title: "Next slice", objective: "Continue work." }],
    });

    const written = writeControllerTaskLedgerArtifacts(root, { reason: "unit-test" });
    const paths = controllerTaskLedgerArtifactPaths();

    expect(written.artifacts.map((artifact) => artifact.path)).toEqual([paths.json, paths.handoff]);
    expect(existsSync(join(root, paths.json))).toBe(true);
    expect(existsSync(join(root, paths.handoff))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, paths.json), "utf-8")).source).toBe("controller-task-ledger");
    const handoff = readFileSync(join(root, paths.handoff), "utf-8");
    expect(handoff).toContain("unit-test");
    expect(handoff).toContain("Context Contract");
    expect(handoff).toContain("not a substitute for source review");
  });
});
