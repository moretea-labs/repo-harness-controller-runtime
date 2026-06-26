import { expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const HELPER_DIR = join(ROOT, "assets/templates/helpers");

function run(cmd: string, args: string[], cwd: string) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env },
  });
}

test("diagnoses Todo Source Plan none strict-workflow fixture", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "repo-harness-workflow-debug-")));
  try {
    const scriptsDir = join(cwd, "scripts");
    const harnessScriptsDir = join(cwd, ".ai/harness/scripts");
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(harnessScriptsDir, { recursive: true });
    mkdirSync(join(cwd, ".ai/harness/triage"), { recursive: true });
    mkdirSync(join(cwd, "docs/architecture"), { recursive: true });

    for (const file of readdirSync(HELPER_DIR).filter((name) => name.endsWith(".sh") || name.endsWith(".ts"))) {
      copyFileSync(join(HELPER_DIR, file), join(scriptsDir, file));
      copyFileSync(join(HELPER_DIR, file), join(harnessScriptsDir, file));
    }
    copyFileSync(
      join(ROOT, "assets/workflow-contract.v1.json"),
      join(cwd, ".ai/harness/workflow-contract.json"),
    );
    writeFileSync(join(cwd, ".ai/harness/triage/.gitkeep"), "");
    if (!existsSync(join(cwd, "docs/architecture/index.md"))) {
      writeFileSync(
        join(cwd, "docs/architecture/index.md"),
        "# Architecture Index\n\n## Pending Requests\n\n<!-- BEGIN ARCHITECTURE PENDING REQUESTS -->\n- (none)\n<!-- END ARCHITECTURE PENDING REQUESTS -->\n",
      );
    }
    expect(run("bash", ["-lc", "chmod +x scripts/*.sh .ai/harness/scripts/*.sh"], cwd).status).toBe(0);

    const ensure = run(
      "bash",
      ["scripts/ensure-task-workflow.sh", "--slug", "handoff-check", "--title", "Handoff Check"],
      cwd,
    );
    console.error("ENSURE_STDOUT\n" + ensure.stdout);
    console.error("ENSURE_STDERR\n" + ensure.stderr);
    expect(ensure.status).toBe(0);

    for (const dir of [
      ".ai/context",
      ".ai/harness/triage",
      "deploy",
      "deploy/env",
      "deploy/scripts",
      "deploy/submissions",
      "deploy/runbooks",
      "deploy/release-checklists",
      "deploy/sql",
      "docs/reference-configs",
    ]) {
      mkdirSync(join(cwd, dir), { recursive: true });
    }
    writeFileSync(join(cwd, ".ai/context/capability-source-map.json"), "{}\n");
    for (const file of [
      "docs/reference-configs/harness-overview.md",
      "docs/reference-configs/agentic-development-flow.md",
      "docs/reference-configs/external-tooling.md",
      "docs/reference-configs/sprint-contracts.md",
      "docs/reference-configs/heartbeat-triage.md",
      "docs/reference-configs/handoff-protocol.md",
      "docs/reference-configs/document-generation.md",
      "docs/reference-configs/global-working-rules.md",
      "deploy/README.md",
    ]) {
      writeFileSync(join(cwd, file), "# Fixture\n");
    }

    writeFileSync(
      join(cwd, ".ai/harness/handoff/current.md"),
      "# Harness Handoff\n\n## Source Artifacts\n\n- Plan: plans/plan-20260602-0034-live-work.md\n- Todo Source Plan: (none)\n",
    );
    writeFileSync(
      join(cwd, ".ai/harness/handoff/resume.md"),
      "# Codex Resume Packet\n\n## Source Artifacts\n\n- Plan: plans/plan-20260602-0034-live-work.md\n",
    );

    const result = run("bash", ["scripts/check-task-workflow.sh", "--strict"], cwd);
    console.error("TASK_WORKFLOW_STATUS=" + result.status);
    console.error("TASK_WORKFLOW_STDOUT\n" + result.stdout);
    console.error("TASK_WORKFLOW_STDERR\n" + result.stderr);
    expect(result.status).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
