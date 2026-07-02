import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");

const REQUIRED_CURRENT_DOCS = [
  "README.md",
  "governance.md",
  "system-overview.md",
  "architecture-invariants.md",
  "entity-model.md",
  "job-and-run-lifecycle.md",
  "dispatch-and-agent-strategy.md",
  "scheduler-and-resource-claims.md",
  "multi-repository-execution.md",
  "automation-and-schedule-engine.md",
  "failure-recovery.md",
  "verification-and-release-gates.md",
  "implementation-status.md",
  "migration-roadmap.md",
  "runtime-directory-map.md",
  "operations-runbook.md",
];

const HISTORICAL_RUNTIME_DOCS = [
  "repo-harness-chatgpt-controller.md",
  "repo-harness-local-execution-bridge.md",
  "repo-harness-execution-closure-v5.md",
  "repo-harness-direct-change-v6.md",
  "repo-harness-execution-first-v7.md",
  "repo-harness-chatgpt-bridge-v8.md",
  "repo-harness-v8-verification.md",
];

function installRuntimeArchitectureBaseline(cwd: string): void {
  const currentRoot = join(cwd, "docs/architecture/current");
  mkdirSync(currentRoot, { recursive: true });
  for (const file of REQUIRED_CURRENT_DOCS) {
    let content = `# ${file}\n\n> Status: **Runtime Authority**\n`;
    if (file === "architecture-invariants.md") {
      content += [
        "",
        "## Invariant 2 — Persist Before Execute",
        "## Invariant 4 — Task Is Intent; Run Is Attempt",
        "## Invariant 16 — Evidence Binds to Exact Revision",
        "## Invariant 21 — Scheduled Work Is Bounded",
        "",
      ].join("\n");
    }
    if (file === "implementation-status.md") {
      content += "\n## Completion Statement\n";
    }
    if (file === "migration-roadmap.md") {
      content += "\n## P0\n\n## P1\n\n## P2\n\n## P3\n\n## P4\n\n## P5\n";
    }
    writeFileSync(join(currentRoot, file), content);
  }
  writeFileSync(
    join(cwd, "docs/architecture/index.md"),
    [
      "# Architecture Index",
      "",
      "## Runtime Authority",
      "",
      "docs/architecture/current/ is the Controller Runtime authority.",
      "",
      "## Pending Architecture Requests",
      "",
      "<!-- BEGIN ARCHITECTURE PENDING REQUESTS -->",
      "- (none)",
      "<!-- END ARCHITECTURE PENDING REQUESTS -->",
      "",
    ].join("\n"),
  );
  for (const file of HISTORICAL_RUNTIME_DOCS) {
    const path = join(cwd, "docs", file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        `# ${file}`,
        "",
        "> **Historical Design — Not Runtime Authority**",
        ">",
        "> Current architecture: [docs/architecture/current/README.md](architecture/current/README.md).",
        "",
      ].join("\n"),
    );
  }
}

function run(cmd: string, args: string[], cwd: string) {
  return spawnSync(cmd, args, { cwd, encoding: "utf-8" });
}

function tmpRepo(fn: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "architecture-sync-"));
  try {
    mkdirSync(join(cwd, "scripts"), { recursive: true });
    mkdirSync(join(cwd, ".ai/context"), { recursive: true });
    mkdirSync(join(cwd, ".ai/harness"), { recursive: true });
    mkdirSync(join(cwd, "docs/architecture/requests"), { recursive: true });
    for (const file of [
      "check-architecture-sync.sh",
      "architecture-queue.sh",
      "architecture-event.ts",
      "capability-resolver.ts",
    ]) {
      copyFileSync(join(ROOT, "scripts", file), join(cwd, "scripts", file));
    }
    expect(run("chmod", ["+x", "scripts/check-architecture-sync.sh", "scripts/architecture-queue.sh"], cwd).status).toBe(0);
    writeFileSync(
      join(cwd, ".ai/context/capabilities.json"),
      JSON.stringify(
        {
          version: 1,
          capabilities: [
            {
              id: "apps-web",
              domain: "apps-web",
              name: "web",
              prefixes: ["apps/web"],
              contract_files: {
                agents: "apps/web/AGENTS.md",
                claude: "apps/web/CLAUDE.md",
              },
              architecture_module: "docs/architecture/modules/apps-web/web.md",
              workstream_dir: "tasks/workstreams/apps-web/web",
              lsp_profile: "typescript-lsp",
              verification_hints: ["web checks"],
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(cwd, "docs/architecture/index.md"),
      ["# Architecture Index", "", "## Pending Requests", "", "- (none)", ""].join("\n"),
    );
    fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function writePolicy(cwd: string, mode: "off" | "advisory" | "strict") {
  writeFileSync(
    join(cwd, ".ai/harness/policy.json"),
    JSON.stringify({ architecture: { freshness_gate: mode, gate_min_severity: "medium" } }, null, 2) + "\n",
  );
}

function writePendingCard(cwd: string, capabilityId = "apps-web", severity = "high") {
  writeFileSync(
    join(cwd, "docs/architecture/requests", `${capabilityId}.md`),
    [
      `# Architecture Drift Request: ${capabilityId}`,
      "",
      "> **Status**: Pending",
      "> **Detected**: 2026-06-01T12:00:00+0800",
      `> **Severity**: ${severity}`,
      "> **Change Type**: workflow-surface",
      "> **File**: `apps/web/src/routes/account.tsx`",
      "> **Functional Block**: `apps/web`",
      `> **Capability ID**: \`${capabilityId}\``,
      "> **Matched Prefix**: `apps/web`",
      "> **Architecture Domain**: `apps-web`",
      "> **Architecture Capability**: `web`",
      "> **Architecture Module**: `docs/architecture/modules/apps-web/web.md`",
      "",
    ].join("\n"),
  );
  expect(run("bash", ["scripts/architecture-queue.sh", "reindex"], cwd).status).toBe(0);
}

function writeChangedFiles(cwd: string, paths: string[]) {
  writeFileSync(join(cwd, "changed.txt"), paths.join("\n") + "\n");
}

describe("architecture sync gate", () => {
  test("capability resolver batches match results from stdin", () => {
    tmpRepo((cwd) => {
      const res = spawnSync(
        process.execPath,
        ["scripts/capability-resolver.ts", "match", "--paths-from", "-", "--format", "json"],
        {
          cwd,
          encoding: "utf-8",
          input: "apps/web/src/routes/account.tsx\npackage.json\n",
        },
      );
      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].capability_id).toBe("apps-web");
      expect(parsed[1].capability_id).toBe("root");
    });
  });

  test("strict blocks when a changed capability has a pending request at the threshold", () => {
    tmpRepo((cwd) => {
      writePolicy(cwd, "strict");
      writePendingCard(cwd);
      writeChangedFiles(cwd, ["apps/web/src/routes/account.tsx"]);

      const res = run("bash", ["scripts/check-architecture-sync.sh", "--changed-files", "changed.txt"], cwd);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("blocking=1");
      expect(res.stderr).toContain("strict gate failed");
    });
  });

  test("advisory warns but exits zero for matching pending requests", () => {
    tmpRepo((cwd) => {
      writePolicy(cwd, "advisory");
      writePendingCard(cwd);
      writeChangedFiles(cwd, ["apps/web/src/routes/account.tsx"]);

      const res = run("bash", ["scripts/check-architecture-sync.sh", "--changed-files", "changed.txt"], cwd);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("blocking=1");
      expect(res.stderr).toContain("WARN");
    });
  });

  test("off mode still checks index integrity but ignores freshness blocking", () => {
    tmpRepo((cwd) => {
      writePolicy(cwd, "off");
      writePendingCard(cwd);
      writeChangedFiles(cwd, ["apps/web/src/routes/account.tsx"]);

      const res = run("bash", ["scripts/check-architecture-sync.sh", "--changed-files", "changed.txt"], cwd);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("mode=off");
    });
  });

  test("stale architecture index fails in every mode", () => {
    tmpRepo((cwd) => {
      writePolicy(cwd, "off");
      writePendingCard(cwd);
      writeFileSync(
        join(cwd, "docs/architecture/index.md"),
        `${readFileSync(join(cwd, "docs/architecture/index.md"), "utf-8")}\n- [ ] stale -> [duplicate](requests/duplicate.md)\n`,
      );
      writeChangedFiles(cwd, ["apps/web/src/routes/account.tsx"]);

      const res = run("bash", ["scripts/check-architecture-sync.sh", "--changed-files", "changed.txt"], cwd);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("architecture request index is stale");
    });
  });

  test("missing resolver is advisory in advisory mode and fail-closed in strict mode", () => {
    tmpRepo((cwd) => {
      writePendingCard(cwd);
      writeChangedFiles(cwd, ["apps/web/src/routes/account.tsx"]);
      rmSync(join(cwd, "scripts/capability-resolver.ts"), { force: true });

      writePolicy(cwd, "advisory");
      const advisory = run("bash", ["scripts/check-architecture-sync.sh", "--changed-files", "changed.txt"], cwd);
      expect(advisory.status).toBe(0);
      expect(advisory.stderr).toContain("WARN");

      writePolicy(cwd, "strict");
      const strict = run("bash", ["scripts/check-architecture-sync.sh", "--changed-files", "changed.txt"], cwd);
      expect(strict.status).toBe(1);
      expect(strict.stderr).toContain("strict gate failed");
    });
  });

  test("current Controller Runtime architecture baseline passes when complete", () => {
    tmpRepo((cwd) => {
      installRuntimeArchitectureBaseline(cwd);
      writePolicy(cwd, "off");
      const res = run("bash", ["scripts/check-architecture-sync.sh", "--mode", "off"], cwd);
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain("architecture baseline failed");
    });
  });

  test("missing required current architecture document fails in every mode", () => {
    tmpRepo((cwd) => {
      installRuntimeArchitectureBaseline(cwd);
      rmSync(join(cwd, "docs/architecture/current/entity-model.md"));
      const res = run("bash", ["scripts/check-architecture-sync.sh", "--mode", "off"], cwd);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("missing required file docs/architecture/current/entity-model.md");
    });
  });

  test("missing Runtime Authority declaration fails before freshness evaluation", () => {
    tmpRepo((cwd) => {
      installRuntimeArchitectureBaseline(cwd);
      const path = join(cwd, "docs/architecture/index.md");
      writeFileSync(path, readFileSync(path, "utf-8").replaceAll("Runtime Authority", "Current Architecture"));
      const res = run("bash", ["scripts/check-architecture-sync.sh", "--mode", "off"], cwd);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("docs/architecture/index.md must contain: Runtime Authority");
    });
  });

  test("historical runtime document without authority marker fails", () => {
    tmpRepo((cwd) => {
      installRuntimeArchitectureBaseline(cwd);
      const path = join(cwd, "docs/repo-harness-chatgpt-bridge-v8.md");
      writeFileSync(path, readFileSync(path, "utf-8").replace("Historical Design", "Version Notes"));
      const res = run("bash", ["scripts/check-architecture-sync.sh", "--mode", "off"], cwd);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Historical Design");
    });
  });
});
