import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createIssue, getIssue } from "../../src/cli/controller/issue-store";
import {
  CONTROLLER_SCHEMA_VERSION,
  CONTROLLER_TOOL_SURFACE,
  CONTROLLER_TOOL_SURFACE_VERSION,
  controllerToolSurfaceFingerprint,
} from "../../src/cli/controller/runtime-config";
import { getMcpPolicy } from "../../src/cli/mcp/policy";
import { buildMcpToolDefinitions, callMcpTool, type McpToolContext } from "../../src/cli/mcp/tools";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function controller(): { root: string; ctx: McpToolContext } {
  const root = mkdtempSync(join(tmpdir(), "repo-harness-mcp-v7-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, ".ai/harness"), { recursive: true });
  mkdirSync(join(root, ".repo-harness"), { recursive: true });
  writeFileSync(join(root, "src/example.ts"), "export const value = 1;\n");
  return { root, ctx: { repoRoot: root, policy: getMcpPolicy("controller", { repoRoot: root }) } };
}

function value(result: Awaited<ReturnType<typeof callMcpTool>>): any {
  return JSON.parse(result.content[0]!.text);
}

describe("MCP execution-first v7 surface", () => {
  test("publishes versioned task-local capabilities and bounded log controls", async () => {
    const { ctx } = controller();
    const definitions = buildMcpToolDefinitions(ctx.policy);
    const names = definitions.map((entry) => entry.name);
    expect(names).toContain("inspect_task_readiness");
    expect(names).toContain("dispatch_ready_tasks");
    const logTool = definitions.find((entry) => entry.name === "get_task_run_log")!;
    expect(JSON.stringify(logTool.inputSchema)).toContain("max_bytes");
    const dispatch = definitions.find((entry) => entry.name === "dispatch_task")!;
    expect(JSON.stringify(dispatch.inputSchema)).toContain("approve_risk");
    expect(JSON.stringify(dispatch.inputSchema)).toContain("approve_destructive");

    const capabilities = value(await callMcpTool(ctx, "controller_capabilities"));
    expect(capabilities.toolSurface).toBe(CONTROLLER_TOOL_SURFACE);
    expect(capabilities.schemaVersion).toBe(CONTROLLER_SCHEMA_VERSION);
    expect(capabilities.toolSurfaceVersion).toBe(CONTROLLER_TOOL_SURFACE_VERSION);
    expect(capabilities.toolSurfaceFingerprint).toBe(controllerToolSurfaceFingerprint());
    expect(capabilities.capabilities.taskLocalReadiness).toBe(true);
    expect(capabilities.capabilities.singleExecutionFocus).toBe(false);
  });

  test("reported command evidence enters high-risk verification", async () => {
    const { root, ctx } = controller();
    const issue = createIssue(root, {
      title: "Reported command evidence",
      tasks: [{
        title: "Refactor bounded adapter",
        objective: "Refactor the bounded adapter and verify it externally.",
        allowedPaths: ["src/example.ts"],
        risk: "high",
        acceptanceCriteria: ["The adapter remains valid."],
      }],
    });
    const result = await callMcpTool(ctx, "verify_task", {
      issue_id: issue.id,
      task_id: "T1",
      reviewer: "chatgpt-controller",
      reviewed_diff_hash: "sha256:reviewed-diff",
      reported_commands: [{
        command: [process.execPath, "-e", "process.exit(0)"],
        ok: true,
        exit_code: 0,
        stdout: "external verification passed",
      }],
      acceptance_results: [{
        criterion: "The adapter remains valid.",
        ok: true,
        evidence: "External command passed against the reviewed diff.",
      }],
    });
    expect(result.isError).toBeUndefined();
    const task = getIssue(root, issue.id).tasks[0]!;
    expect(task.status).toBe("verified");
    expect(task.verification?.commandEvidence).toHaveLength(1);
    expect(task.verification?.commandEvidence?.[0]?.source).toBe("reported");
    expect(task.verification?.commandEvidence?.[0]?.ok).toBe(true);
  });

  test("Issue readiness keeps task-local blockers out of global blockers", async () => {
    const { root, ctx } = controller();
    const issue = createIssue(root, {
      title: "Mixed readiness",
      tasks: [
        { title: "Unsafe scope", objective: "Refactor the core.", risk: "high" },
        { title: "Safe file", objective: "Update one safe file.", allowedPaths: ["src/example.ts"], risk: "low" },
      ],
    });
    const readiness = value(await callMcpTool(ctx, "inspect_issue_readiness", { issue_id: issue.id }));
    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toHaveLength(0);
    expect(readiness.taskBlockers.some((entry: { code: string }) => entry.code === "TASK_SCOPE_REQUIRED")).toBe(true);
    expect(readiness.readyTaskIds).toContain("T2");
  });
});
