import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { join } from "path";
import { getMcpPolicy } from "../../src/cli/mcp/policy";
import {
  buildMcpToolDefinitions,
  callMcpTool,
  controllerExpectedToolNames,
  type McpToolContext,
} from "../../src/cli/mcp/tools";
import { controllerToolSurfaceFingerprint } from "../../src/cli/controller/runtime-config";

async function jsonTool(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await callMcpTool(ctx, name, args);
  return { raw: result, value: JSON.parse(result.content[0].text) };
}

async function waitForRun(
  ctx: McpToolContext,
  runId: string,
  predicate: (run: any) => boolean,
  attempts = 120,
  delayMs = 25,
) {
  let run = (await jsonTool(ctx, "get_task_run", { run_id: runId })).value;
  for (let attempt = 0; attempt < attempts && !predicate(run); attempt += 1) {
    await Bun.sleep(delayMs);
    run = (await jsonTool(ctx, "get_task_run", { run_id: runId })).value;
  }
  return run;
}

async function withController<T>(
  fn: (repoRoot: string, ctx: McpToolContext) => Promise<T>,
): Promise<T> {
  const repoRoot = mkdtempSync(join(tmpdir(), "repo-harness-controller-"));
  try {
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    mkdirSync(join(repoRoot, "tasks"), { recursive: true });
    mkdirSync(join(repoRoot, ".ai/harness"), { recursive: true });
    mkdirSync(join(repoRoot, ".repo-harness"), { recursive: true });
    writeFileSync(join(repoRoot, ".repo-harness/checks.json"), JSON.stringify({
      version: 1,
      checks: Object.fromEntries(["focused", "manual-review", "typecheck"].map((id) => [id, {
        description: `Test check ${id}`,
        command: [process.execPath, "-e", "process.exit(0)"],
        timeoutMs: 10_000,
      }])),
    }));
    writeFileSync(
      join(repoRoot, "src/example.ts"),
      "export const value = 1;\n",
    );
    writeFileSync(join(repoRoot, "tasks/current.md"), "# Current\n");
    return await fn(repoRoot, {
      repoRoot,
      policy: getMcpPolicy("controller", { repoRoot }),
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

describe("MCP controller profile", () => {
  test("exposes controller tools and preserves immutable secret denies", async () => {
    await withController(async (repoRoot, ctx) => {
      mkdirSync(join(repoRoot, ".repo-harness"), { recursive: true });
      writeFileSync(
        join(repoRoot, ".repo-harness/mcp.policy.json"),
        JSON.stringify({ profiles: { controller: { denyGlobs: [] } } }),
      );
      const overridden = getMcpPolicy("controller", { repoRoot });
      const names = buildMcpToolDefinitions(overridden).map(
        (tool) => tool.name,
      );
      expect(names).toContain("controller_capabilities");
      expect(names).toContain("local_bridge_status");
      expect(names).toContain("controller_context");
      expect(names).toContain("submit_local_job");
      expect(names).not.toContain("approve_local_job");
      expect(names).toContain("create_edit_savepoint");
      expect(names).toContain("project_snapshot");
      expect(names).toContain("assess_work_request");
      expect(names).toContain("create_issue");
      expect(names).toContain("dispatch_task");
      expect(names).toContain("apply_patch");
      expect(names).toContain("list_edit_sessions");
      expect(names).toContain("get_edit_session_diff");
      expect(names).toContain("verify_edit_session");
      expect(names).toContain("finalize_edit_session");
      expect(names).toContain("run_check");
      expect(names).toContain("publish_issue_to_github");
      expect(names).toContain("launch_issue");
      expect(names).toContain("verify_task");
      expect(names).toContain("get_project_progress");
      expect(names).toContain("get_project_governance");
      expect(names).toContain("reconcile_project_governance");
      expect(names).toContain("get_project_state");
      expect(names).toContain("set_current_issue");
      expect(names).toContain("archive_issue");
      expect(names).toContain("restore_issue");
      expect(names).toContain("get_task_progress_detail");
      expect(names).toContain("get_worklog_timeline");
      expect(names).toContain("export_worklog");
      expect(names).toContain("get_github_plugin_status");
      expect(names).toContain("configure_github_plugin");
      expect(controllerExpectedToolNames(ctx.policy)).toContain("repository_command_preview");
      expect(controllerExpectedToolNames(ctx.policy)).toContain("repository_command_execute");
      const capabilities = await jsonTool(
        { ...ctx, policy: overridden },
        "controller_capabilities",
      );
      expect(capabilities.value.toolSurface).toBe(
        "controller-chatgpt-bridge-v8",
      );
      expect(capabilities.value.expectedTools).toContain("launch_issue");
      expect(capabilities.value.expectedTools).toContain("submit_local_job");
      expect(capabilities.value.expectedTools).toContain("controller_context");
      expect(capabilities.value.expectedTools).toContain("repository_command_preview");
      expect(capabilities.value.expectedTools).toContain("repository_command_execute");
      expect(capabilities.value.expectedTools).toEqual(
        controllerExpectedToolNames(overridden),
      );
      expect(capabilities.value.toolSurfaceFingerprint).toBe(
        controllerToolSurfaceFingerprint(controllerExpectedToolNames(overridden)),
      );
      expect(capabilities.value.capabilities.directEditFirstRouting).toBe(true);
      expect(capabilities.value.capabilities.controllerContextAggregation).toBe(true);
      expect(capabilities.value.capabilities.persistedCheckReuse).toBe(true);
      expect(capabilities.value.expectedTools).toContain("verify_edit_session");
      const source = await jsonTool(
        { ...ctx, policy: overridden },
        "read_repository_file",
        { path: "src/example.ts" },
      );
      expect(source.value.content).toContain("value = 1");
      const denied = await jsonTool(
        { ...ctx, policy: overridden },
        "read_repository_file",
        { path: ".env" },
      );
      expect(denied.value.error.code).toBe("TOOL_FAILED");
      expect(denied.raw.isError).toBe(true);
    });
  });

  test("exposes V5 governance, focus, evidence, timeline, export, and optional GitHub plugin tools", async () => {
    await withController(async (repoRoot, ctx) => {
      const created = await jsonTool(ctx, "create_issue", {
        title: "V5 execution tools",
        kind: "feature",
        summary: "Exercise the progress and worklog surface.",
        acceptance_criteria: ["The Task is visible."],
        tasks: [{
          title: "Inspect progress",
          objective: "Read derived Task progress.",
          allowed_paths: ["src/**"],
          checks: ["manual-review"],
          acceptance_criteria: ["Visible"],
        }],
      });
      const progress = await jsonTool(ctx, "get_project_progress");
      expect(progress.value.issueCount).toBe(1);
      expect(progress.value.issues[0].id).toBe(created.value.id);
      const focus = await jsonTool(ctx, "set_current_issue", { issue_id: created.value.id });
      expect(focus.value.currentIssueId).toBe(created.value.id);
      const governance = await jsonTool(ctx, "get_project_governance");
      expect(governance.value.currentIssueId).toBe(created.value.id);
      expect(governance.value.executionQueue[0].taskId).toBe("T1");

      const detail = await jsonTool(ctx, "get_task_progress_detail", {
        issue_id: created.value.id,
        task_id: "T1",
      });
      expect(detail.value.progress.taskId).toBe("T1");
      expect(detail.value.timeline.some((event: { action: string }) => event.action === "task_created")).toBe(true);

      const timeline = await jsonTool(ctx, "get_worklog_timeline", { issue_id: created.value.id });
      expect(timeline.value.events.length).toBeGreaterThan(0);
      const exported = await jsonTool(ctx, "export_worklog", {
        output_path: "tasks/reports/mcp-v5-worklog.md",
        issue_id: created.value.id,
      });
      expect(existsSync(join(repoRoot, exported.value.path))).toBe(true);

      const config = await jsonTool(ctx, "configure_github_plugin", {
        enabled: false,
        repository: "owner/repository",
        sync_mode: "checkpoint",
      });
      expect(config.value.syncMode).toBe("checkpoint");
      const status = await jsonTool(ctx, "get_github_plugin_status");
      expect(status.value.ready).toBe(false);
      expect(status.value.config.repository).toBe("owner/repository");
    });
  });

  test("submits high-risk local Jobs without an approval queue", async () => {
    await withController(async (_repoRoot, ctx) => {
      const submitted = await jsonTool(ctx, "submit_local_job", {
        action: "quick-agent-session",
        title: "Immediate local example",
        objective: "Prepare a high-risk local Codex session.",
        allowed_paths: ["src/**"],
        checks: ["manual-review"],
        acceptance_criteria: [
          "The session is accepted immediately without a risk approval queue.",
        ],
        risk: "high",
        agent: "codex",
      });
      expect(submitted.value.job.status).toBe("dispatched");
      const status = await jsonTool(ctx, "local_bridge_status");
      expect(status.value.approvalQueue).toBe(false);
      expect(status.value.pendingApproval).toBeUndefined();
      expect(status.value.endpoint).toContain("127.0.0.1");
    });
  });

  test("returns one compact controller context with execution guidance", async () => {
    await withController(async (_repoRoot, ctx) => {
      const created = await jsonTool(ctx, "create_issue", {
        title: "Compact context",
        kind: "feature",
        summary: "Exercise controller_context",
        tasks: [{
          title: "Bounded change",
          objective: "Update one known file",
          allowed_paths: ["src/**"],
          checks: ["focused"],
        }],
      });
      expect(created.value.id).toBeTruthy();
      const context = await jsonTool(ctx, "controller_context", {
        description: "Update the example constant in one known file.",
        known_paths: ["src/example.ts"],
        expected_files: 1,
        expected_changed_lines: 2,
        risk: "low",
      });
      expect(context.value.git.branch).toBeNull();
      expect(context.value.currentIssueId).toBe(created.value.id);
      expect(context.value.readyTasks.length).toBeGreaterThan(0);
      expect(context.value.checks.some((check: { id: string }) => check.id === "focused")).toBe(true);
      expect(context.value.recommendedExecution.recommendedMode).toBe("direct_edit");
    });
  });

  test("searches code, manages Issue tasks, and unlocks dependencies after acceptance", async () => {
    await withController(async (_repoRoot, ctx) => {
      const searched = await jsonTool(ctx, "search_repository", {
        query: "value = 1",
        include_globs: ["src/**"],
      });
      expect(searched.value.results[0]).toMatchObject({
        path: "src/example.ts",
        line: 1,
      });

      const created = await jsonTool(ctx, "create_issue", {
        title: "Controller workflow",
        kind: "feature",
        summary: "Exercise dependency-aware task state.",
        tasks: [
          {
            title: "First",
            objective: "First task",
            allowed_paths: ["src/**"],
            checks: ["manual-review"],
          },
          {
            title: "Second",
            objective: "Second task",
            depends_on: ["T1"],
            allowed_paths: ["src/**"],
          },
        ],
      });
      expect(
        created.value.tasks.map((task: { status: string }) => task.status),
      ).toEqual(["ready", "planned"]);

      await jsonTool(ctx, "update_task", {
        issue_id: created.value.id,
        task_id: "T1",
        status: "review",
      });
      await jsonTool(ctx, "verify_task", {
        issue_id: created.value.id,
        task_id: "T1",
        reviewer: "test-controller",
        check_results: [{ check_id: "manual-review", ok: true }],
        acceptance_results: [],
      });
      const accepted = await jsonTool(ctx, "accept_task", {
        issue_id: created.value.id,
        task_id: "T1",
      });
      expect(
        accepted.value.tasks.map((task: { status: string }) => task.status),
      ).toEqual(["done", "ready"]);
      const board = await jsonTool(ctx, "get_project_board");
      expect(board.value.readyTasks[0]).toMatchObject({
        issueId: created.value.id,
        taskId: "T2",
      });
    });
  });

  test("rejects invalid and cyclic Task dependency graphs", async () => {
    await withController(async (_repoRoot, ctx) => {
      const missing = await jsonTool(ctx, "create_issue", {
        title: "Invalid dependency",
        tasks: [
          { title: "Broken", objective: "bad graph", depends_on: ["T9"] },
        ],
      });
      expect(missing.raw.isError).toBe(true);
      expect(missing.value.error.message).toContain("unknown task dependency");

      const cyclic = await jsonTool(ctx, "create_issue", {
        title: "Cycle",
        tasks: [
          { title: "One", objective: "one", depends_on: ["T2"] },
          { title: "Two", objective: "two", depends_on: ["T1"] },
        ],
      });
      expect(cyclic.raw.isError).toBe(true);
      expect(cyclic.value.error.message).toContain("cycle");
    });
  });

  test("runs only named focused checks from repository configuration", async () => {
    await withController(async (repoRoot, ctx) => {
      mkdirSync(join(repoRoot, ".repo-harness"), { recursive: true });
      writeFileSync(
        join(repoRoot, ".repo-harness/checks.json"),
        JSON.stringify({
          version: 1,
          checks: {
            focused: {
              description: "Focused controller smoke check",
              command: [
                process.execPath,
                "-e",
                'setTimeout(() => console.log("focused-ok"), 2500)',
              ],
              timeoutMs: 10_000,
            },
          },
        }),
      );
      const listed = await jsonTool(ctx, "list_checks");
      expect(
        listed.value.checks.map((check: { id: string }) => check.id),
      ).toContain("focused");
      const runStartedAt = Date.now();
      const submitted = (await Promise.race([
        jsonTool(ctx, "run_check", { check_id: "focused" }),
        Bun.sleep(5_000).then(() => {
          throw new Error("run_check remained synchronously blocked for 5 seconds");
        }),
      ])) as Awaited<ReturnType<typeof jsonTool>>;
      expect(Date.now() - runStartedAt).toBeLessThan(2_400);
      expect(["approved", "running"]).toContain(submitted.value.job.status);

      let finished = (
        await jsonTool(ctx, "get_local_job", {
          job_id: submitted.value.job.jobId,
        })
      ).value.job;
      const runDeadline = Date.now() + 30_000;
      for (let attempt = 0; Date.now() < runDeadline && finished.status === "running"; attempt += 1) {
        await Bun.sleep(20);
        finished = (
          await jsonTool(ctx, "get_local_job", {
            job_id: submitted.value.job.jobId,
          })
        ).value.job;
      }
      expect(finished.status).not.toBe("running");
      expect(finished.status).toBe("succeeded");
      expect(finished.result.stdout).toContain("focused-ok");
    });
  });

  test("applies SHA-guarded bounded edits and rolls them back", async () => {
    await withController(async (repoRoot, ctx) => {
      const read = await jsonTool(ctx, "read_workflow_file", {
        path: "src/example.ts",
      });
      const session = await jsonTool(ctx, "begin_edit_session", {
        purpose: "Change constant",
        allowed_paths: ["src/**"],
        max_files: 1,
        max_changed_lines: 5,
      });
      const applied = await jsonTool(ctx, "apply_patch", {
        session_id: session.value.sessionId,
        operations: [
          {
            type: "replace",
            path: "src/example.ts",
            expected_sha256: read.value.sha256,
            replacements: [{ old_text: "value = 1", new_text: "value = 2" }],
          },
        ],
      });
      expect(applied.value.status).toBe("dirty");
      expect(readFileSync(join(repoRoot, "src/example.ts"), "utf-8")).toContain(
        "value = 2",
      );
      const rolledBack = await jsonTool(ctx, "rollback_edit_session", {
        session_id: session.value.sessionId,
      });
      expect(rolledBack.value.status).toBe("rolled_back");
      expect(readFileSync(join(repoRoot, "src/example.ts"), "utf-8")).toContain(
        "value = 1",
      );
    });
  });


  test("routes known small changes to direct edits and records patch/check/finalization evidence", async () => {
    await withController(async (repoRoot, ctx) => {
      const assessment = await jsonTool(ctx, "assess_work_request", {
        description: "Update the example constant and its documentation.",
        known_paths: ["src/example.ts"],
        expected_files: 1,
        expected_changed_lines: 2,
        risk: "low",
      });
      expect(assessment.value.recommendedMode).toBe("direct_edit");
      expect(assessment.value.issueRequired).toBe(false);

      const discoveryAssessment = await jsonTool(ctx, "assess_work_request", {
        description: "Locate the Controller routing and dashboard files, then implement a bounded update.",
        expected_files: 6,
        expected_changed_lines: 500,
        requires_investigation: true,
        risk: "medium",
      });
      expect(discoveryAssessment.value.recommendedMode).toBe("direct_edit");
      expect(discoveryAssessment.value.confidence).toBe("medium");
      expect(discoveryAssessment.value.nextTools[0]).toBe("search_repository");
      expect(discoveryAssessment.value.issueRequired).toBe(false);

      const read = await jsonTool(ctx, "read_repository_file", { path: "src/example.ts" });
      const session = await jsonTool(ctx, "begin_edit_session", {
        purpose: "Update example constant",
        allowed_paths: ["src/**"],
        checks: ["focused"],
      });
      await jsonTool(ctx, "apply_patch", {
        session_id: session.value.sessionId,
        operations: [{
          type: "replace",
          path: "src/example.ts",
          expected_sha256: read.value.sha256,
          replacements: [{ old_text: "value = 1", new_text: "value = 3" }],
        }],
      });
      const diff = await jsonTool(ctx, "get_edit_session_diff", { session_id: session.value.sessionId });
      expect(diff.value.patch).toContain("+export const value = 3;");
      const verified = await jsonTool(ctx, "verify_edit_session", {
        session_id: session.value.sessionId,
        reviewer: "test-reviewer",
      });
      expect(verified.value.status).toBe("checked");
      expect(verified.value.checkResults[0].ok).toBe(true);
      const finalized = await jsonTool(ctx, "finalize_edit_session", {
        session_id: session.value.sessionId,
        reviewer: "test-reviewer",
      });
      expect(finalized.value.status).toBe("finalized");
      const listed = await jsonTool(ctx, "list_edit_sessions");
      expect(listed.value.sessions[0]).toMatchObject({
        sessionId: session.value.sessionId,
        status: "finalized",
        changedFiles: 1,
        checksPassed: 1,
      });
      const timeline = await jsonTool(ctx, "get_worklog_timeline", {
        category: "edit",
        edit_session_id: session.value.sessionId,
      });
      expect(timeline.value.events.some((event: { action: string }) => event.action === "edit_session_finalized")).toBe(true);
    });
  });

  test("dispatches one short persistent agent run and moves the task to review", async () => {
    await withController(async (repoRoot, baseCtx) => {
      const binRoot = mkdtempSync(
        join(tmpdir(), "repo-harness-controller-bin-"),
      );
      const originalPath = process.env.PATH;
      try {
        const fakeCodex = join(binRoot, "codex");
        writeFileSync(
          fakeCodex,
          '#!/usr/bin/env bash\necho "controller-run-ok"\nexit 0\n',
        );
        chmodSync(fakeCodex, 0o755);
        process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
        const ctx = {
          ...baseCtx,
          policy: getMcpPolicy("controller", {
            repoRoot,
            devAgentRunner: true,
            allowedAgents: ["codex"],
            runnerTimeoutMs: 10_000,
          }),
        };
        const created = await jsonTool(ctx, "create_issue", {
          title: "Run task",
          summary: "Exercise a local persistent Run.",
          goals: ["Run one scoped worker."],
          acceptance_criteria: ["The worker completes successfully."],
          tasks: [
            {
              title: "Execute",
              objective: "Run fake Codex",
              allowed_paths: ["src/**"],
              checks: ["focused"],
              acceptance_criteria: ["The worker completes successfully."],
              agent: "codex",
            },
          ],
        });
        const dispatched = await jsonTool(ctx, "dispatch_task", {
          issue_id: created.value.id,
          task_id: "T1",
          isolate: false,
          timeout_ms: 10_000,
        });
        expect(dispatched.value.accepted).toBe(true);
        expect(["starting", "running"]).toContain(dispatched.value.status);
        let run = (
          await jsonTool(ctx, "get_task_run", {
            run_id: dispatched.value.runId,
          })
        ).value;
        for (
          let attempt = 0;
          attempt < 50 && !["succeeded", "failed"].includes(run.status);
          attempt += 1
        ) {
          await Bun.sleep(25);
          run = (
            await jsonTool(ctx, "get_task_run", {
              run_id: dispatched.value.runId,
            })
          ).value;
        }
        expect(run.status).toBe("succeeded");
        expect(run.stdoutTail).toContain("controller-run-ok");
        let issue = await jsonTool(ctx, "get_issue", {
          issue_id: created.value.id,
        });
        for (
          let attempt = 0;
          attempt < 200 && issue.value.tasks[0].status !== "review";
          attempt += 1
        ) {
          await Bun.sleep(25);
          issue = await jsonTool(ctx, "get_issue", {
            issue_id: created.value.id,
          });
        }
        expect(issue.value.tasks[0].status).toBe("review");
      } finally {
        process.env.PATH = originalPath;
        rmSync(binRoot, { recursive: true, force: true });
      }
    });
  });

  test("returns task run events with cursor support and collapsed heartbeats by default", async () => {
    await withController(async (repoRoot, baseCtx) => {
      const binRoot = mkdtempSync(
        join(tmpdir(), "repo-harness-controller-events-bin-"),
      );
      const originalPath = process.env.PATH;
      try {
        const fakeCodex = join(binRoot, "codex");
        writeFileSync(
          fakeCodex,
          `#!/usr/bin/env bash
printf '%s\n' '{"type":"thread.started"}'
printf '%s\n' '{"type":"turn.started"}'
sleep 0.2
printf '%s\n' '{"type":"item.started","item":{"type":"command_execution","command":"bun test focused"}}'
sleep 0.2
printf '%s\n' '{"type":"turn.completed"}'
`,
        );
        chmodSync(fakeCodex, 0o755);
        process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
        const ctx = {
          ...baseCtx,
          policy: getMcpPolicy("controller", {
            repoRoot,
            devAgentRunner: true,
            allowedAgents: ["codex"],
            runnerTimeoutMs: 10_000,
          }),
        };
        const created = await jsonTool(ctx, "create_issue", {
          title: "Run events",
          tasks: [
            {
              title: "Execute",
              objective: "Emit run events",
              allowed_paths: ["src/**"],
              checks: ["focused"],
              agent: "codex",
            },
          ],
        });
        const dispatched = await jsonTool(ctx, "dispatch_task", {
          issue_id: created.value.id,
          task_id: "T1",
          isolate: false,
          timeout_ms: 10_000,
        });
        let run = (
          await jsonTool(ctx, "get_task_run", {
            run_id: dispatched.value.runId,
          })
        ).value;
        for (
          let attempt = 0;
          attempt < 60 && !["succeeded", "failed"].includes(run.status);
          attempt += 1
        ) {
          await Bun.sleep(25);
          run = (
            await jsonTool(ctx, "get_task_run", {
              run_id: dispatched.value.runId,
            })
          ).value;
        }
        const initial = await jsonTool(ctx, "get_task_run_events", {
          run_id: dispatched.value.runId,
          limit: 20,
        });
        expect(initial.value.events.length).toBeGreaterThan(0);
        expect(initial.value.heartbeatsCollapsed).toBe(true);
        const cursor = initial.value.nextSinceEventIndex;
        const delta = await jsonTool(ctx, "get_task_run_events", {
          run_id: dispatched.value.runId,
          since_event_index: typeof cursor === "number" ? cursor : -1,
          limit: 20,
        });
        expect(delta.value.events.length).toBe(0);
      } finally {
        process.env.PATH = originalPath;
        rmSync(binRoot, { recursive: true, force: true });
      }
    });
  });
  test("preserves an explicit 60-minute timeout through MCP, Run metadata, and worker config", async () => {
    await withController(async (repoRoot, baseCtx) => {
      const binRoot = mkdtempSync(
        join(tmpdir(), "repo-harness-controller-bin-"),
      );
      const originalPath = process.env.PATH;
      try {
        const fakeCodex = join(binRoot, "codex");
        writeFileSync(
          fakeCodex,
          '#!/usr/bin/env bash\necho "timeout-propagation-ok"\n',
        );
        chmodSync(fakeCodex, 0o755);
        process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
        const ctx = {
          ...baseCtx,
          policy: getMcpPolicy("controller", {
            repoRoot,
            devAgentRunner: true,
            allowedAgents: ["codex"],
          }),
        };
        const created = await jsonTool(ctx, "create_issue", {
          title: "Long timeout propagation",
          summary: "Verify that a one-hour request is not silently reduced.",
          goals: ["Keep the requested timeout intact."],
          acceptance_criteria: ["The Run and worker both use 3600000ms."],
          tasks: [
            {
              title: "Execute",
              objective: "Run with a one-hour timeout.",
              allowed_paths: ["src/**"],
              checks: ["manual"],
              acceptance_criteria: ["The Run and worker both use 3600000ms."],
              agent: "codex",
            },
          ],
        });
        const dispatched = await jsonTool(ctx, "dispatch_task", {
          issue_id: created.value.id,
          task_id: "T1",
          isolate: false,
          timeout_ms: 3_600_000,
        });
        expect(dispatched.raw.isError).not.toBe(true);
        expect(dispatched.value.timeoutMs).toBe(3_600_000);
        let run = (
          await jsonTool(ctx, "get_task_run", {
            run_id: dispatched.value.runId,
          })
        ).value;
        for (let attempt = 0; attempt < 60 && !run.startedAt; attempt += 1) {
          await Bun.sleep(25);
          run = (
            await jsonTool(ctx, "get_task_run", {
              run_id: dispatched.value.runId,
            })
          ).value;
        }
        expect(
          Date.parse(run.deadlineAt) - Date.parse(run.startedAt),
        ).toBe(3_600_000);
        const workerConfig = JSON.parse(
          readFileSync(
            join(
              repoRoot,
              ".ai/harness/jobs",
              dispatched.value.runId,
              "worker-config.json",
            ),
            "utf-8",
          ),
        );
        expect(workerConfig.timeoutMs).toBe(3_600_000);
      } finally {
        process.env.PATH = originalPath;
        rmSync(binRoot, { recursive: true, force: true });
      }
    });
  });

  test("rejects an oversized timeout instead of silently falling back to the default", async () => {
    await withController(async (repoRoot, baseCtx) => {
      const ctx = {
        ...baseCtx,
        policy: getMcpPolicy("controller", {
          repoRoot,
          devAgentRunner: true,
          allowedAgents: ["codex"],
        }),
      };
      const created = await jsonTool(ctx, "create_issue", {
        title: "Reject oversized timeout",
        summary: "Do not silently change operator intent.",
        goals: ["Return an explicit validation error."],
        acceptance_criteria: ["No Run is created."],
        tasks: [
          {
            title: "Execute",
            objective: "Reject invalid timeout.",
            allowed_paths: ["src/**"],
            checks: ["manual"],
            acceptance_criteria: ["No Run is created."],
            agent: "codex",
          },
        ],
      });
      const dispatched = await jsonTool(ctx, "dispatch_task", {
        issue_id: created.value.id,
        task_id: "T1",
        timeout_ms: 13 * 60 * 60 * 1000,
      });
      expect(dispatched.raw.isError).toBe(true);
      expect(dispatched.value.error.message).toContain("43200000");
    });
  });

  test("streams local agent output while a detached Run is still executing", async () => {
    await withController(async (repoRoot, baseCtx) => {
      const binRoot = mkdtempSync(
        join(tmpdir(), "repo-harness-controller-bin-"),
      );
      const originalPath = process.env.PATH;
      try {
        const fakeCodex = join(binRoot, "codex");
        writeFileSync(
          fakeCodex,
          '#!/usr/bin/env bash\necho "stream-first"\nsleep 1\necho "stream-second"\n',
        );
        chmodSync(fakeCodex, 0o755);
        process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
        const ctx = {
          ...baseCtx,
          policy: getMcpPolicy("controller", {
            repoRoot,
            devAgentRunner: true,
            allowedAgents: ["codex"],
            runnerTimeoutMs: 10_000,
          }),
        };
        const created = await jsonTool(ctx, "create_issue", {
          title: "Stream local output",
          summary: "Expose detached worker progress before completion.",
          goals: ["Observe live output."],
          acceptance_criteria: [
            "The first output line is visible while the Run is active.",
          ],
          tasks: [
            {
              title: "Stream",
              objective: "Emit two separated log lines",
              allowed_paths: ["src/**"],
              checks: ["manual-live-log"],
              acceptance_criteria: [
                "The first output line is visible while the Run is active.",
              ],
              agent: "codex",
            },
          ],
        });
        const dispatched = await jsonTool(ctx, "dispatch_task", {
          issue_id: created.value.id,
          task_id: "T1",
          isolate: false,
          timeout_ms: 10_000,
        });
        let observedWhileRunning = false;
        let run = dispatched.value;
        for (let attempt = 0; attempt < 60; attempt += 1) {
          await Bun.sleep(25);
          run = (
            await jsonTool(ctx, "get_task_run", {
              run_id: dispatched.value.runId,
            })
          ).value;
          const logValue = (
            await jsonTool(ctx, "get_task_run_log", {
              run_id: dispatched.value.runId,
            })
          ).value.log;
          const log = typeof logValue === "string" ? logValue : "";
          if (run.status === "running" && log.includes("stream-first")) {
            observedWhileRunning = true;
            break;
          }
        }
        expect(observedWhileRunning).toBe(true);
        for (
          let attempt = 0;
          attempt < 80 && !["succeeded", "failed"].includes(run.status);
          attempt += 1
        ) {
          await Bun.sleep(25);
          run = (
            await jsonTool(ctx, "get_task_run", {
              run_id: dispatched.value.runId,
            })
          ).value;
        }
        expect(run.status).toBe("succeeded");
        const finalLog = await jsonTool(ctx, "get_task_run_log", {
          run_id: dispatched.value.runId,
        });
        expect(finalLog.value.log).toContain("stream-second");
      } finally {
        process.env.PATH = originalPath;
        rmSync(binRoot, { recursive: true, force: true });
      }
    });
  });

  test("reuses the same runId when dispatch_task is retried with the same request_id", async () => {
    await withController(async (repoRoot, baseCtx) => {
      const binRoot = mkdtempSync(join(tmpdir(), "repo-harness-controller-idem-bin-"));
      const originalPath = process.env.PATH;
      try {
        const fakeCodex = join(binRoot, "codex");
        writeFileSync(
          fakeCodex,
          '#!/usr/bin/env bash\necho "idempotent-run"\nsleep 0.2\n',
        );
        chmodSync(fakeCodex, 0o755);
        process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
        const ctx = {
          ...baseCtx,
          policy: getMcpPolicy("controller", {
            repoRoot,
            devAgentRunner: true,
            allowedAgents: ["codex"],
            runnerTimeoutMs: 10_000,
          }),
        };
        const created = await jsonTool(ctx, "create_issue", {
          title: "Dispatch idempotency",
          tasks: [
            {
              title: "Execute",
              objective: "Verify same-request reuse",
              allowed_paths: ["src/**"],
              checks: ["manual"],
              agent: "codex",
            },
          ],
        });
        const first = await jsonTool(ctx, "dispatch_task", {
          issue_id: created.value.id,
          task_id: "T1",
          request_id: "req-123",
        });
        const second = await jsonTool(ctx, "dispatch_task", {
          issue_id: created.value.id,
          task_id: "T1",
          request_id: "req-123",
        });
        expect(first.value.runId).toBe(second.value.runId);
        if (!second.raw.isError) expect(second.value.reused).toBe(true);
        const runs = await jsonTool(ctx, "list_task_runs", {});
        expect(runs.value.runs.filter((entry: { runId: string }) => entry.runId === first.value.runId)).toHaveLength(1);
      } finally {
        process.env.PATH = originalPath;
        rmSync(binRoot, { recursive: true, force: true });
      }
    });
  });

  test("returns dispatch_task quickly after acceptance even when agent startup is slow", async () => {
    await withController(async (repoRoot, baseCtx) => {
      const binRoot = mkdtempSync(join(tmpdir(), "repo-harness-controller-fast-ack-bin-"));
      const originalPath = process.env.PATH;
      try {
        const fakeCodex = join(binRoot, "codex");
        writeFileSync(
          fakeCodex,
          `#!/usr/bin/env bash
sleep 1.2
echo "slow-start-ok"
`,
        );
        chmodSync(fakeCodex, 0o755);
        process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
        const ctx = {
          ...baseCtx,
          policy: getMcpPolicy("controller", {
            repoRoot,
            devAgentRunner: true,
            allowedAgents: ["codex"],
            runnerTimeoutMs: 10_000,
          }),
        };
        const created = await jsonTool(ctx, "create_issue", {
          title: "Fast accept",
          tasks: [
            {
              title: "Execute slowly",
              objective: "Confirm dispatch returns before worker finishes.",
              allowed_paths: ["src/**"],
              checks: ["manual"],
              agent: "codex",
            },
          ],
        });
        const startedAt = Date.now();
        const dispatched = await jsonTool(ctx, "dispatch_task", {
          issue_id: created.value.id,
          task_id: "T1",
          request_id: "slow-accept-1",
        });
        expect(dispatched.value.accepted).toBe(true);
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        const acceptedRun = (
          await jsonTool(ctx, "get_task_run", { run_id: dispatched.value.runId })
        ).value;
        expect(["starting", "running", "succeeded"]).toContain(acceptedRun.status);
      } finally {
        process.env.PATH = originalPath;
        rmSync(binRoot, { recursive: true, force: true });
      }
    });
  });

  test("creates only one Run for concurrent dispatch_task calls with the same request_id", async () => {
    await withController(async (repoRoot, baseCtx) => {
      const binRoot = mkdtempSync(join(tmpdir(), "repo-harness-controller-concurrent-idem-bin-"));
      const originalPath = process.env.PATH;
      try {
        const fakeCodex = join(binRoot, "codex");
        writeFileSync(
          fakeCodex,
          '#!/usr/bin/env bash\necho "concurrent-idem"\nsleep 0.2\n',
        );
        chmodSync(fakeCodex, 0o755);
        process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
        const ctx = {
          ...baseCtx,
          policy: getMcpPolicy("controller", {
            repoRoot,
            devAgentRunner: true,
            allowedAgents: ["codex"],
            runnerTimeoutMs: 10_000,
          }),
        };
        const created = await jsonTool(ctx, "create_issue", {
          title: "Concurrent dispatch",
          tasks: [
            {
              title: "Execute once",
              objective: "Ensure concurrent retries collapse to one Run.",
              allowed_paths: ["src/**"],
              checks: ["manual"],
              agent: "codex",
            },
          ],
        });
        const [first, second] = await Promise.all([
          jsonTool(ctx, "dispatch_task", {
            issue_id: created.value.id,
            task_id: "T1",
            request_id: "concurrent-req-1",
          }),
          jsonTool(ctx, "dispatch_task", {
            issue_id: created.value.id,
            task_id: "T1",
            request_id: "concurrent-req-1",
          }),
        ]);
        expect(first.value.runId).toBeTruthy();
        expect(second.value.runId).toBe(first.value.runId);
        const runs = await jsonTool(ctx, "list_task_runs", {});
        expect(
          runs.value.runs.filter((entry: { runId: string }) => entry.runId === first.value.runId),
        ).toHaveLength(1);
      } finally {
        process.env.PATH = originalPath;
        rmSync(binRoot, { recursive: true, force: true });
      }
    });
  });

  test("keeps dispatch responses compact even when the issue contains large notes and history", async () => {
    await withController(async (repoRoot, baseCtx) => {
      const binRoot = mkdtempSync(join(tmpdir(), "repo-harness-controller-compact-bin-"));
      const originalPath = process.env.PATH;
      try {
        const fakeCodex = join(binRoot, "codex");
        writeFileSync(fakeCodex, '#!/usr/bin/env bash\necho "compact"\n');
        chmodSync(fakeCodex, 0o755);
        process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
        const ctx = {
          ...baseCtx,
          policy: getMcpPolicy("controller", {
            repoRoot,
            devAgentRunner: true,
            allowedAgents: ["codex"],
            runnerTimeoutMs: 10_000,
          }),
        };
        const created = await jsonTool(ctx, "create_issue", {
          title: "Compact response",
          summary: "x".repeat(20_000),
          tasks: [
            {
              title: "Execute",
              objective: "Keep dispatch response small",
              allowed_paths: ["src/**"],
              checks: ["manual"],
              acceptance_criteria: ["y".repeat(5000)],
              agent: "codex",
            },
          ],
        });
        const dispatched = await jsonTool(ctx, "dispatch_task", {
          issue_id: created.value.id,
          task_id: "T1",
          request_id: "compact-1",
        });
        const bytes = Buffer.byteLength(dispatched.raw.content[0].text, "utf-8");
        expect(bytes).toBeLessThan(2048);
        expect(dispatched.value.issue).toBeUndefined();
        expect(dispatched.value.run).toBeUndefined();
      } finally {
        process.env.PATH = originalPath;
        rmSync(binRoot, { recursive: true, force: true });
      }
    });
  });

  test("reviews and integrates an isolated Task Run before acceptance", async () => {
    const repoRoot = mkdtempSync(
      join(tmpdir(), "repo-harness-controller-git-"),
    );
    const binRoot = mkdtempSync(join(tmpdir(), "repo-harness-controller-bin-"));
    const originalPath = process.env.PATH;
    try {
      mkdirSync(join(repoRoot, "src"), { recursive: true });
      mkdirSync(join(repoRoot, "tasks"), { recursive: true });
      mkdirSync(join(repoRoot, ".ai/harness"), { recursive: true });
      mkdirSync(join(repoRoot, ".repo-harness"), { recursive: true });
      writeFileSync(join(repoRoot, ".repo-harness/checks.json"), JSON.stringify({
        version: 1,
        checks: { focused: { command: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 10_000 } },
      }));
      writeFileSync(
        join(repoRoot, "src/example.ts"),
        "export const value = 1;\n",
      );
      writeFileSync(join(repoRoot, "tasks/current.md"), "# Current\n");
      expect(spawnSync("git", ["init"], { cwd: repoRoot }).status).toBe(0);
      expect(
        spawnSync("git", ["config", "user.email", "test@example.com"], {
          cwd: repoRoot,
        }).status,
      ).toBe(0);
      expect(
        spawnSync("git", ["config", "user.name", "Test"], { cwd: repoRoot })
          .status,
      ).toBe(0);
      expect(spawnSync("git", ["add", "."], { cwd: repoRoot }).status).toBe(0);
      expect(
        spawnSync("git", ["commit", "-m", "initial"], { cwd: repoRoot }).status,
      ).toBe(0);

      const fakeCodex = join(binRoot, "codex");
      writeFileSync(
        fakeCodex,
        '#!/usr/bin/env bash\nprintf "export const value = 2;\\n" > src/example.ts\necho "isolated-change-ok"\n',
      );
      chmodSync(fakeCodex, 0o755);
      process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
      const ctx: McpToolContext = {
        repoRoot,
        policy: getMcpPolicy("controller", {
          repoRoot,
          devAgentRunner: true,
          allowedAgents: ["codex"],
          runnerTimeoutMs: 10_000,
        }),
      };
      const created = await jsonTool(ctx, "create_issue", {
        title: "Integrate isolated work",
        summary: "Exercise isolated implementation and integration.",
        goals: ["Integrate one reviewed change."],
        acceptance_criteria: [
          "The main worktree contains the reviewed value change.",
        ],
        tasks: [
          {
            title: "Change value",
            objective: "Change the example value",
            allowed_paths: ["src/**"],
            checks: ["focused"],
            acceptance_criteria: ["The example value is 2."],
            agent: "codex",
          },
        ],
      });
        const dispatched = await jsonTool(ctx, "dispatch_task", {
          issue_id: created.value.id,
          task_id: "T1",
          isolate: true,
          timeout_ms: 10_000,
        });
      let run = (
        await jsonTool(ctx, "get_task_run", {
          run_id: dispatched.value.runId,
        })
      ).value;
      const runDeadline = Date.now() + 30_000;
      for (
        let attempt = 0;
        Date.now() < runDeadline && !["succeeded", "failed"].includes(run.status);
        attempt += 1
      ) {
        await Bun.sleep(25);
        run = (
          await jsonTool(ctx, "get_task_run", {
            run_id: dispatched.value.runId,
          })
        ).value;
      }
      expect(run.status).toBe("succeeded");
      for (
        let attempt = 0;
        attempt < 120 && !run.worktreeCleanedAt && !run.autoIntegrationError;
        attempt += 1
      ) {
        await Bun.sleep(25);
        run = (
          await jsonTool(ctx, "get_task_run", {
            run_id: dispatched.value.runId,
          })
        ).value;
      }
      expect(run.autoIntegrationError).toBeUndefined();
      expect(run.integratedSessionId).toBeTruthy();
      expect(run.worktreeCleanedAt).toBeTruthy();
      expect(existsSync(run.worktree)).toBe(false);
      expect(readFileSync(join(repoRoot, "src/example.ts"), "utf-8")).toContain(
        "value = 2",
      );
      const diff = await jsonTool(ctx, "get_task_diff", { run_id: run.runId });
      expect(diff.value.status).toContain("src/example.ts");
      const premature = await jsonTool(ctx, "accept_task", {
        issue_id: created.value.id,
        task_id: "T1",
      });
      expect(premature.value.error.code).toBe("TASK_NOT_VERIFIED");

      const integrated = await jsonTool(ctx, "integrate_task_run", {
        run_id: run.runId,
      });
      expect(integrated.value.session.status).toBe("dirty");
      const integratedIssue = await jsonTool(ctx, "get_issue", {
        issue_id: created.value.id,
      });
      expect(integratedIssue.value.tasks[0].status).toBe("integrated");
      let currentIssue = integratedIssue;
      if (currentIssue.value.tasks[0].status !== "done") {
        const verified = await jsonTool(ctx, "verify_task", {
          issue_id: created.value.id,
          task_id: "T1",
          run_id: run.runId,
          reviewer: "test-controller",
          check_results: [{ check_id: "focused", ok: true }],
          acceptance_results: [{
            criterion: "The example value is 2.",
            ok: true,
            evidence: "src/example.ts contains value = 2",
          }],
        });
        if (verified.value.error) {
          currentIssue = await jsonTool(ctx, "get_issue", { issue_id: created.value.id });
          expect(currentIssue.value.tasks[0].status).toBe("done");
        } else {
          expect(["verified", "done"]).toContain(verified.value.tasks[0].status);
          currentIssue = verified.value.tasks[0].status === "verified"
            ? await jsonTool(ctx, "accept_task", { issue_id: created.value.id, task_id: "T1" })
            : verified;
        }
      }
      expect(currentIssue.value.tasks[0].status).toBe("done");
    } finally {
      process.env.PATH = originalPath;
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(binRoot, { recursive: true, force: true });
    }
  });

  test("previews launch readiness and supports dynamic Task graph changes", async () => {
    await withController(async (_repoRoot, ctx) => {
      const created = await jsonTool(ctx, "create_issue", {
        title: "Dynamic launcher",
        summary: "Exercise readiness and task evolution.",
        goals: ["Launch only well-scoped work."],
        acceptance_criteria: ["All planned work is verified."],
        tasks: [
          {
            title: "Foundation",
            objective: "Prepare foundation.",
            allowed_paths: ["src/foundation/**"],
            checks: ["typecheck"],
            acceptance_criteria: ["Foundation is ready."],
          },
          {
            title: "Consumer",
            objective: "Use the foundation.",
            depends_on: ["T1"],
            allowed_paths: ["src/consumer/**"],
            checks: ["typecheck"],
            acceptance_criteria: ["Consumer uses the foundation."],
          },
        ],
      });
      const preview = await jsonTool(ctx, "prepare_issue_launch", {
        issue_id: created.value.id,
      });
      expect(preview.value.readiness.ready).toBe(true);
      expect(
        preview.value.tasks.map((task: { id: string }) => task.id),
      ).toEqual(["T1"]);

      const appended = await jsonTool(ctx, "append_task", {
        issue_id: created.value.id,
        task: {
          title: "Verification",
          objective: "Verify integrated behaviour.",
          depends_on: ["T2"],
          allowed_paths: ["tests/**"],
          checks: ["test"],
          acceptance_criteria: ["Regression coverage exists."],
        },
      });
      expect(appended.value.tasks.at(-1).id).toBe("T3");

      const split = await jsonTool(ctx, "split_task", {
        issue_id: created.value.id,
        task_id: "T1",
        tasks: [
          {
            title: "Foundation model",
            objective: "Prepare model.",
            acceptance_criteria: ["Model is ready."],
          },
          {
            title: "Foundation service",
            objective: "Prepare service.",
            acceptance_criteria: ["Service is ready."],
          },
        ],
      });
      expect(
        split.value.tasks.find((task: { id: string }) => task.id === "T1")
          .status,
      ).toBe("superseded");
      expect(
        split.value.tasks.find((task: { id: string }) => task.id === "T2")
          .dependsOn,
      ).toEqual(["T4", "T5"]);
    });
  });

  test("publishes Issues and runs a visible GitHub Copilot cloud session", async () => {
    await withController(async (repoRoot, ctx) => {
      const binRoot = mkdtempSync(join(tmpdir(), "repo-harness-gh-bin-"));
      const originalPath = process.env.PATH;
      const originalState = process.env.GH_FAKE_STATE;
      try {
        const fakeGh = join(binRoot, "gh");
        const statePath = join(binRoot, "state.json");
        writeFileSync(statePath, JSON.stringify({ nextIssue: 40 }));
        writeFileSync(
          fakeGh,
          `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const statePath = process.env.GH_FAKE_STATE;
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const writeState = (value) => fs.writeFileSync(statePath, JSON.stringify(value));
if (args[0] === '--version') { console.log('gh version 2.80.0 (fake)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { console.log('authenticated'); process.exit(0); }
if (args[0] === 'repo' && args[1] === 'view') { console.log(JSON.stringify({ nameWithOwner: 'acme/demo', url: 'https://github.com/acme/demo', defaultBranchRef: { name: 'main' } })); process.exit(0); }
if (args[0] === 'issue' && args[1] === 'create') { const state = readState(); const number = state.nextIssue++; writeState(state); console.log('https://github.com/acme/demo/issues/' + number); process.exit(0); }
if (args[0] === 'issue' && ['edit', 'close'].includes(args[1])) { process.exit(0); }
if (args[0] === 'issue' && args[1] === 'view') { console.log(JSON.stringify({ number: Number(args[2]), title: 'Synced', state: 'OPEN', url: 'https://github.com/acme/demo/issues/' + args[2], labels: [], assignees: [], projectItems: [], updatedAt: new Date().toISOString() })); process.exit(0); }
if (args[0] === 'project' && args[1] === 'item-add') { console.log(JSON.stringify({ id: 'PVTI_fake' })); process.exit(0); }
if (args[0] === 'api') { const endpoint = args.find((arg) => arg.startsWith('/agents/repos/')); const isPost = args.includes('POST'); if (endpoint && isPost) { process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ id: 'agent-1', state: 'queued', html_url: 'https://github.com/acme/demo/agents/agent-1' }))); return; } if (endpoint) { console.log(JSON.stringify({ id: 'agent-1', state: 'completed', html_url: 'https://github.com/acme/demo/agents/agent-1', pull_request: { html_url: 'https://github.com/acme/demo/pull/77' } })); process.exit(0); } }
if (args[0] === 'agent-task' && args[1] === 'view') { console.log('cloud-session-log'); process.exit(0); }
console.error('unsupported fake gh call: ' + args.join(' '));
process.exit(2);
`,
        );
        chmodSync(fakeGh, 0o755);
        process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
        process.env.GH_FAKE_STATE = statePath;

        const created = await jsonTool(ctx, "create_issue", {
          title: "GitHub managed work",
          summary: "Publish work and execute it in a visible GitHub session.",
          goals: ["Expose progress in GitHub."],
          acceptance_criteria: [
            "The cloud session produces a reviewable pull request.",
          ],
          tasks: [
            {
              title: "Cloud implementation",
              objective: "Implement the scoped change.",
              allowed_paths: ["src/**"],
              checks: ["typecheck"],
              acceptance_criteria: ["A reviewable pull request is produced."],
              agent: "github-copilot",
            },
          ],
        });
        const published = await jsonTool(ctx, "publish_issue_to_github", {
          issue_id: created.value.id,
          repo: "acme/demo",
          include_tasks: true,
          project_owner: "acme",
          project_number: 3,
        });
        expect(published.value.github.url).toContain("/issues/40");
        expect(published.value.tasks[0].github.url).toContain("/issues/41");

        const dispatched = await jsonTool(ctx, "dispatch_task", {
          issue_id: created.value.id,
          task_id: "T1",
          agent: "github-copilot",
          github_repo: "acme/demo",
        });
        expect(dispatched.value.provider).toBe("github");
        const completed = {
          value: await waitForRun(ctx, dispatched.value.runId, (run) => run.status === "succeeded", 80, 25),
        };
        expect(completed.value.status).toBe("succeeded");
        expect(completed.value.github.pullRequestUrl).toContain("/pull/77");
        const log = await jsonTool(ctx, "get_task_run_log", {
          run_id: dispatched.value.runId,
        });
        expect(log.value.log).toContain("cloud-session-log");

        const completedIssue = await jsonTool(ctx, "get_issue", {
          issue_id: created.value.id,
        });
        expect(completedIssue.value.tasks[0].status).toBe("done");
        expect(completedIssue.value.tasks[0].verification).toBeTruthy();
      } finally {
        process.env.PATH = originalPath;
        if (originalState === undefined) delete process.env.GH_FAKE_STATE;
        else process.env.GH_FAKE_STATE = originalState;
        rmSync(binRoot, { recursive: true, force: true });
      }
    });
  });
});
