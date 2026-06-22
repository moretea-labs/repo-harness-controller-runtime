import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyEditOperations,
  beginEditSession,
  createEditSavepoint,
  finalizeEditSession,
  getEditSessionDiff,
  rollbackEditSession,
} from "../../src/cli/editing/edit-session";
import { createIssue, inspectTaskReadiness, projectBoard } from "../../src/cli/controller/issue-store";
import { getMcpPolicy } from "../../src/cli/mcp/policy";
import { buildMcpToolDefinitions, callMcpTool, type McpToolContext } from "../../src/cli/mcp/tools";
import { localBridgeDashboardHtml } from "../../src/cli/local-bridge/dashboard";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): { root: string; ctx: McpToolContext } {
  const root = mkdtempSync(join(tmpdir(), "repo-harness-v8-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, ".ai/harness"), { recursive: true });
  mkdirSync(join(root, ".repo-harness"), { recursive: true });
  writeFileSync(join(root, "src/example.ts"), "export const value = 1;\nexport const stable = true;\n");
  return { root, ctx: { repoRoot: root, policy: getMcpPolicy("controller", { repoRoot: root }) } };
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(result: Awaited<ReturnType<typeof callMcpTool>>): any {
  return JSON.parse(result.content[0]!.text);
}

describe("Controller V8 ChatGPT execution bridge", () => {
  test("keeps Tasks executor-neutral and removes ordinary local risk approval gates", () => {
    const { root } = repo();
    const issue = createIssue(root, {
      title: "Executor-neutral work",
      tasks: [{ title: "Refactor module", objective: "Refactor the module.", risk: "high" }],
    });
    expect(issue.tasks[0]?.recommendedAgent).toBeUndefined();
    const readiness = inspectTaskReadiness(root, issue.id, "T1");
    expect(readiness.ready).toBe(true);
    expect(readiness.approvalSatisfied).toBe(true);
    expect(readiness.blockers.some((entry) => entry.code.includes("RISK_CONFIRMATION"))).toBe(false);
    const task = (projectBoard(root).issues[0] as any).tasks[0];
    expect(task.agent).toBe("runtime-selected");
  });

  test("supports multiple patch batches, savepoints, localized aggregate diff, and partial rollback", () => {
    const { root, ctx } = repo();
    const session = beginEditSession(root, { purpose: "Multi-revision edit", allowedPaths: ["src/**"] });
    const path = join(root, "src/example.ts");
    const initial = readFileSync(path, "utf-8");
    const revision1 = applyEditOperations(root, ctx.policy, session.sessionId, [{
      type: "replace",
      path: "src/example.ts",
      expectedSha256: sha(initial),
      replacements: [{ oldText: "value = 1", newText: "value = 2" }],
    }]);
    expect(revision1.status).toBe("dirty");
    expect(revision1.currentRevision).toBe(1);
    createEditSavepoint(root, session.sessionId, "runtime-ready");

    const afterRevision1 = readFileSync(path, "utf-8");
    const revision2 = applyEditOperations(root, ctx.policy, session.sessionId, [{
      type: "append",
      path: "src/example.ts",
      expectedSha256: sha(afterRevision1),
      content: "export const appended = true;\n",
    }]);
    expect(revision2.currentRevision).toBe(2);
    expect(revision2.revisions).toHaveLength(2);
    const diff = getEditSessionDiff(root, session.sessionId);
    expect(diff.patch).toContain("+export const value = 2;");
    expect(diff.patch).toContain("+export const appended = true;");
    expect(diff.patch).not.toContain("@@ -1,1000");

    const rolledBack = rollbackEditSession(root, session.sessionId, { savepoint: "runtime-ready" });
    expect(rolledBack.status).toBe("dirty");
    expect(rolledBack.currentRevision).toBe(1);
    expect(readFileSync(path, "utf-8")).toBe(afterRevision1);
    const finalized = finalizeEditSession(root, session.sessionId);
    expect(finalized.status).toBe("finalized");
  });

  test("publishes runtime Agent selection and the hierarchical Controller surface", async () => {
    const { ctx } = repo();
    const definitions = buildMcpToolDefinitions(ctx.policy);
    const dispatch = definitions.find((entry) => entry.name === "dispatch_task")!;
    expect(JSON.stringify(dispatch.inputSchema)).toContain('"agent"');
    expect(JSON.stringify(dispatch.inputSchema)).not.toContain("approve_risk");
    expect(definitions.map((entry) => entry.name)).toContain("create_edit_savepoint");
    const localJob = definitions.find((entry) => entry.name === "submit_local_job")!;
    expect(JSON.stringify(localJob.inputSchema)).not.toContain('"approval"');
    expect(definitions.map((entry) => entry.name)).not.toContain("approve_local_job");

    const capabilities = json(await callMcpTool(ctx, "controller_capabilities"));
    expect(capabilities.executionModel).toBe("chatgpt-controller-execution-bridge");
    expect(capabilities.capabilities.runtimeAgentSelection).toBe(true);
    expect(capabilities.capabilities.taskAgentBinding).toBe(false);
    expect(capabilities.capabilities.localRiskApprovalGate).toBe(false);
    expect(capabilities.capabilities.multiRevisionDirectEdits).toBe(true);
    expect(capabilities.capabilities.hierarchicalControllerUI).toBe(true);

    const dashboard = localBridgeDashboardHtml("test-token");
    expect(dashboard).toContain("概览");
    expect(dashboard).toContain("工作项");
    expect(dashboard).toContain("活动");
    expect(dashboard).toContain("设置");
    expect(dashboard).toContain("Direct Edit");
    expect(dashboard).not.toContain("Approval Queue");
  });
});
