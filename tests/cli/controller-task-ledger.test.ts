import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createIssue, updateTask } from "../../src/cli/controller/issue-store";
import {
  buildControllerTaskLedgerProjection,
  controllerTaskLedgerArtifactPaths,
  writeControllerTaskLedgerArtifacts,
} from "../../src/cli/controller/task-ledger";
import { getMcpPolicy } from "../../src/cli/mcp/policy";
import { buildControllerContextPack } from "../../src/cli/controller/context-pack";

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
    expect(projection.status.kind).toBe("needs_review");
    expect(projection.status.taskId).toBe("T1");
    expect(projection.status.nextAction).toContain("inspect raw diff");
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
    expect(handoff).toContain("Continuation state");
    expect(handoff).toContain("Context Contract");
    expect(handoff).toContain("not a substitute for source review");
  });
});


describe("controller context pack", () => {
  test("builds bounded raw snippets from explicit paths and task focus", () => {
    const root = repo();
    mkdirSync(join(root, "src/runtime"), { recursive: true });
    writeFileSync(join(root, "src/runtime/example.ts"), [
      "export function loadRuntimeConfig() {",
      "  return { source: 'controller-home' };",
      "}",
      "",
      "export function saveRuntimeConfig() {",
      "  return 'legacy fallback preserved';",
      "}",
    ].join("\n"));
    const issue = createIssue(root, {
      title: "Context pack recovery",
      summary: "Find runtime config code without loading the whole repository.",
      tasks: [{
        title: "Inspect runtime config",
        objective: "Inspect loadRuntimeConfig and saveRuntimeConfig before editing.",
        allowedPaths: ["src/runtime/**"],
        checks: ["check:type"],
      }],
    });

    const pack = buildControllerContextPack(root, getMcpPolicy("controller", { repoRoot: root }), {
      issueId: issue.id,
      taskId: "T1",
      knownPaths: ["src/runtime/example.ts"],
      searchTerms: ["loadRuntimeConfig"],
      maxFiles: 3,
      maxSnippets: 6,
    });

    expect(pack.source).toBe("controller-context-pack");
    expect(pack.schemaVersion).toBe(3);
    expect(pack.focus.issueId).toBe(issue.id);
    expect(pack.contextContract.rawCodeRequiredForImplementation).toBe(true);
    expect(pack.validation).toEqual({ policy: "task-targeted", checks: ["check:type"] });
    expect(pack.files.map((file) => file.path)).toContain("src/runtime/example.ts");
    expect(pack.files[0]?.snippets[0]?.content).toContain("loadRuntimeConfig");
    expect(pack.next.join("\n")).toContain("raw diff");
  });

  test("reports denied explicit paths instead of bypassing MCP policy", () => {
    const root = repo();
    writeFileSync(join(root, ".env"), "SECRET=1\n");

    const pack = buildControllerContextPack(root, getMcpPolicy("controller", { repoRoot: root }), {
      knownPaths: [".env"],
      maxFiles: 2,
    });

    expect(pack.files.length).toBe(0);
    expect(pack.deniedPaths[0]?.path).toBe(".env");
    expect(pack.deniedPaths[0]?.reason).toContain("denied");
  });
});
