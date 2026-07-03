import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { registerRepository } from "../../src/cli/repositories/registry";
import { executeExecutionJob } from "../../src/runtime/execution/workers/executor";
import {
  listAssistantPluginManifests,
  submitAssistantPluginAction,
} from "../../src/runtime/plugins/store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
});

function repoFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), "repo-harness-plugin-runtime-"));
  const controllerHome = mkdtempSync(join(tmpdir(), "repo-harness-plugin-controller-"));
  roots.push(repoRoot, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(join(repoRoot, "tasks"), { recursive: true });
  mkdirSync(join(repoRoot, ".ai/harness"), { recursive: true });
  mkdirSync(join(repoRoot, ".repo-harness"), { recursive: true });
  writeFileSync(join(repoRoot, "src/example.ts"), "export const value = 1;\n");
  writeFileSync(join(repoRoot, "tasks/current.md"), "# Current\n");
  spawnSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
  const repository = registerRepository({ path: repoRoot, controllerHome });
  return { repoRoot, controllerHome, repository };
}

function ledgerEvents(controllerHome: string, repoId: string) {
  const path = join(controllerHome, "repositories", repoId, "events", "ledger.jsonl");
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { eventType: string; data?: Record<string, unknown> });
}

describe("personal assistant plugin runtime", () => {
  test("discovers derived manifests and executes idempotent configure actions with audit events", async () => {
    const { repoRoot, controllerHome, repository } = repoFixture();
    const manifests = listAssistantPluginManifests(controllerHome, repository);
    expect(manifests.map((manifest) => manifest.pluginId)).toContain("github");
    const github = manifests.find((manifest) => manifest.pluginId === "github");
    expect(github?.enabled).toBe(false);
    expect(github?.actions.some((action) => action.actionId === "configure")).toBe(true);
    expect(github?.actions.find((action) => action.actionId === "close_issue")?.confirmation).toBe("strong_confirmation");

    expect(() => submitAssistantPluginAction(controllerHome, repository, {
      pluginId: "github",
      actionId: "configure",
      requestId: "plugin-config-1",
      args: { enabled: true, repository: "owner/repo", sync_mode: "checkpoint" },
      origin: { surface: "local-ui", actor: "test" },
    })).toThrow("PLUGIN_CONFIRMATION_REQUIRED");

    const first = submitAssistantPluginAction(controllerHome, repository, {
      pluginId: "github",
      actionId: "configure",
      requestId: "plugin-config-1",
      args: { enabled: true, repository: "owner/repo", sync_mode: "checkpoint" },
      confirmAuthorization: true,
      origin: { surface: "local-ui", actor: "test" },
    });
    const second = submitAssistantPluginAction(controllerHome, repository, {
      pluginId: "github",
      actionId: "configure",
      requestId: "plugin-config-1",
      args: { enabled: true, repository: "owner/repo", sync_mode: "checkpoint" },
      confirmAuthorization: true,
      origin: { surface: "local-ui", actor: "test" },
    });
    expect(first.job.jobId).toBe(second.job.jobId);
    expect(second.deduplicated).toBe(true);

    const execution = await executeExecutionJob(controllerHome, first.job);
    expect(execution.ok).toBe(true);
    expect(execution.result?.plugin).toBeDefined();
    expect(execution.result?.result).toBeDefined();

    const manifestPath = join(controllerHome, "repositories", repository.repoId, "plugins", "manifests", "github.json");
    expect(existsSync(manifestPath)).toBe(true);
    const storedManifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { enabled: boolean; revision: number };
    expect(storedManifest.enabled).toBe(true);
    expect(storedManifest.revision).toBeGreaterThan(0);

    const configPath = join(repoRoot, ".repo-harness", "plugins", "github.json");
    expect(readFileSync(configPath, "utf-8")).toContain("\"repository\": \"owner/repo\"");

    const events = ledgerEvents(controllerHome, repository.repoId);
    expect(events.some((event) => event.eventType === "plugin_action_requested" && event.data?.actionId === "configure")).toBe(true);
    expect(events.some((event) => event.eventType === "plugin_action_succeeded" && event.data?.actionId === "configure")).toBe(true);
  });
});
