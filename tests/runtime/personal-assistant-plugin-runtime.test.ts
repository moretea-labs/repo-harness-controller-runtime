import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { registerRepository } from "../../src/cli/repositories/registry";
import { buildAssistantReadinessReport } from "../../src/runtime/assistant/readiness";
import { executeExecutionJob } from "../../src/runtime/execution/workers/executor";
import {
  resetIosDevelopmentHooksForTest,
  setIosDevelopmentHooksForTest,
} from "../../src/runtime/safe-tooling";
import {
  clearAssistantPluginManifestCacheForTest,
  listAssistantPluginManifests,
  submitAssistantPluginAction,
} from "../../src/runtime/plugins/store";

const roots: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
  delete process.env.REPO_HARNESS_GMAIL_ACCESS_TOKEN;
  delete process.env.REPO_HARNESS_GOOGLE_ACCESS_TOKEN;
  delete process.env.REPO_HARNESS_GOOGLE_WORKSPACE_ACCESS_TOKEN;
  delete process.env.REPO_HARNESS_GOOGLE_CALENDAR_ACCESS_TOKEN;
  delete process.env.REPO_HARNESS_GOOGLE_TASKS_ACCESS_TOKEN;
  globalThis.fetch = originalFetch;
  resetIosDevelopmentHooksForTest();
  clearAssistantPluginManifestCacheForTest();
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

async function executePluginAction(
  controllerHome: string,
  repository: ReturnType<typeof repoFixture>["repository"],
  input: Parameters<typeof submitAssistantPluginAction>[2],
) {
  const submitted = submitAssistantPluginAction(controllerHome, repository, input);
  const execution = await executeExecutionJob(controllerHome, submitted.job);
  return { submitted, execution };
}

describe("personal assistant plugin runtime", () => {
  test("discovers derived manifests and executes idempotent configure actions with audit events", async () => {
    const { repoRoot, controllerHome, repository } = repoFixture();
    const manifests = listAssistantPluginManifests(controllerHome, repository);
    expect(manifests.map((manifest) => manifest.pluginId)).toContain("github");
    expect(manifests.map((manifest) => manifest.pluginId)).toEqual(expect.arrayContaining([
      "browser",
      "gmail",
      "google_calendar",
      "google_tasks",
    ]));
    const github = manifests.find((manifest) => manifest.pluginId === "github");
    expect(github?.enabled).toBe(false);
    expect(github?.actions.some((action) => action.actionId === "configure")).toBe(true);
    expect(github?.actions.find((action) => action.actionId === "close_issue")?.confirmation).toBe("strong_confirmation");

    const first = submitAssistantPluginAction(controllerHome, repository, {
      pluginId: "github",
      actionId: "configure",
      requestId: "plugin-config-1",
      args: { enabled: true, repository: "owner/repo", sync_mode: "checkpoint" },
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

  test("refreshes only the touched plugin manifest after a durable action", async () => {
    const { controllerHome, repository } = repoFixture();
    let xcodeProbeCount = 0;
    setIosDevelopmentHooksForTest({
      platform: () => "darwin",
      runCommand(command, args) {
        xcodeProbeCount += 1;
        return { ok: false, status: 1, stdout: "", stderr: `${command} ${args.join(" ")} should not run`, command: [command, ...args] };
      },
    });

    const githubConfig = await executePluginAction(controllerHome, repository, {
      pluginId: "github",
      actionId: "configure",
      requestId: "github-config-no-ios-refresh",
      args: {
        enabled: true,
        repository: "owner/repo",
        sync_mode: "checkpoint",
      },
      confirmAuthorization: true,
      origin: { surface: "local-ui", actor: "test" },
    });

    expect(githubConfig.execution.ok).toBe(true);
    expect(xcodeProbeCount).toBe(0);
  });

  test("exposes Gmail, Calendar, and Tasks capability schemas with separated scopes and guarded writes", async () => {
    const { repoRoot, controllerHome, repository } = repoFixture();
    const manifests = listAssistantPluginManifests(controllerHome, repository);
    const gmail = manifests.find((manifest) => manifest.pluginId === "gmail");
    const calendar = manifests.find((manifest) => manifest.pluginId === "google_calendar");
    const tasks = manifests.find((manifest) => manifest.pluginId === "google_tasks");
    expect(gmail?.permissions.map((entry) => entry.scope)).toEqual(expect.arrayContaining([
      "gmail.readonly",
      "gmail.compose",
      "gmail.send",
      "gmail.modify",
    ]));
    expect(calendar?.permissions.map((entry) => entry.scope)).toEqual(expect.arrayContaining([
      "calendar.events.readonly",
      "calendar.events.write",
      "calendar.events.delete",
    ]));
    expect(tasks?.permissions.map((entry) => entry.scope)).toEqual(expect.arrayContaining([
      "tasks.readonly",
      "tasks.write",
      "tasks.delete",
    ]));
    expect(gmail?.actions.find((action) => action.actionId === "send_message")?.confirmation).toBe("strong_confirmation");
    expect(gmail?.actions.map((action) => action.actionId)).toEqual(expect.arrayContaining([
      "list_labels",
      "modify_message_labels",
      "archive_message",
      "mark_message_read",
      "mark_message_unread",
    ]));
    expect(calendar?.actions.find((action) => action.actionId === "reschedule_event")?.confirmation).toBe("strong_confirmation");
    expect(tasks?.actions.find((action) => action.actionId === "delete_task")?.confirmation).toBe("strong_confirmation");

    const gmailConfig = await executePluginAction(controllerHome, repository, {
      pluginId: "gmail",
      actionId: "configure",
      requestId: "gmail-config",
      args: {
        enabled: true,
        provider: "mock",
        account_email: "assistant@example.com",
        default_query: "label:inbox newer_than:7d",
      },
      confirmAuthorization: true,
      origin: { surface: "local-ui", actor: "test" },
    });
    expect(gmailConfig.execution.ok).toBe(true);
    const gmailConfigPath = join(repoRoot, ".repo-harness", "plugins", "gmail.json");
    expect(readFileSync(gmailConfigPath, "utf-8")).toContain("\"provider\": \"mock\"");
    expect(readFileSync(gmailConfigPath, "utf-8")).not.toContain("access_token");

    expect(() => submitAssistantPluginAction(controllerHome, repository, {
      pluginId: "gmail",
      actionId: "send_message",
      requestId: "gmail-send-missing-confirm",
      args: {
        to: ["recipient@example.com"],
        subject: "Status update",
        body_text: "Hello from repo-harness",
      },
      confirmAuthorization: true,
      origin: { surface: "local-ui", actor: "test" },
    })).toThrow("PLUGIN_CONFIRMATION_TEXT_REQUIRED");

    const gmailSend = await executePluginAction(controllerHome, repository, {
      pluginId: "gmail",
      actionId: "send_message",
      requestId: "gmail-send-confirmed",
      args: {
        to: ["recipient@example.com"],
        subject: "Status update",
        body_text: "Hello from repo-harness",
      },
      confirmAuthorization: true,
      confirmationText: "send-gmail-message",
      origin: { surface: "local-ui", actor: "test" },
    });
    expect(gmailSend.execution.ok).toBe(true);
    const gmailSendResult = gmailSend.execution.result?.result as Record<string, unknown> | undefined;
    expect(gmailSendResult?.message).toBeDefined();

    const gmailLabels = await executePluginAction(controllerHome, repository, {
      pluginId: "gmail",
      actionId: "list_labels",
      requestId: "gmail-labels",
      args: {},
      origin: { surface: "local-ui", actor: "test" },
    });
    expect(gmailLabels.execution.ok).toBe(true);
    const gmailLabelsResult = gmailLabels.execution.result?.result as Record<string, unknown> | undefined;
    expect(gmailLabelsResult?.labels).toBeDefined();

    const gmailArchive = await executePluginAction(controllerHome, repository, {
      pluginId: "gmail",
      actionId: "archive_message",
      requestId: "gmail-archive",
      args: { message_id: "msg-1" },
      confirmAuthorization: true,
      origin: { surface: "local-ui", actor: "test" },
    });
    expect(gmailArchive.execution.ok).toBe(true);
    const gmailArchiveResult = gmailArchive.execution.result?.result as Record<string, unknown> | undefined;
    expect(JSON.stringify(gmailArchiveResult)).toContain("INBOX");

    const calendarConfig = await executePluginAction(controllerHome, repository, {
      pluginId: "google_calendar",
      actionId: "configure",
      requestId: "calendar-config",
      args: {
        enabled: true,
        provider: "mock",
        calendar_id: "primary",
        timezone: "UTC",
      },
      confirmAuthorization: true,
      origin: { surface: "local-ui", actor: "test" },
    });
    expect(calendarConfig.execution.ok).toBe(true);

    const taskConfig = await executePluginAction(controllerHome, repository, {
      pluginId: "google_tasks",
      actionId: "configure",
      requestId: "tasks-config",
      args: {
        enabled: true,
        provider: "mock",
        task_list_id: "@default",
      },
      confirmAuthorization: true,
      origin: { surface: "local-ui", actor: "test" },
    });
    expect(taskConfig.execution.ok).toBe(true);

    const taskCreate = await executePluginAction(controllerHome, repository, {
      pluginId: "google_tasks",
      actionId: "create_task",
      requestId: "tasks-create",
      args: {
        title: "Review release notes",
        due: "2026-07-04T09:00:00.000Z",
      },
      confirmAuthorization: true,
      origin: { surface: "local-ui", actor: "test" },
    });
    expect(taskCreate.execution.ok).toBe(true);
    const taskCreateResult = taskCreate.execution.result?.result as Record<string, unknown> | undefined;
    expect(taskCreateResult?.task).toBeDefined();
  });

  test("reports mock and live Gmail readiness in the assistant summary", async () => {
    const { controllerHome, repository } = repoFixture();

    const mockConfig = await executePluginAction(controllerHome, repository, {
      pluginId: "gmail",
      actionId: "configure",
      requestId: "gmail-mock-config",
      args: {
        enabled: true,
        provider: "mock",
        account_email: "assistant@example.com",
      },
      confirmAuthorization: true,
      origin: { surface: "local-ui", actor: "test" },
    });
    expect(mockConfig.execution.ok).toBe(true);

    const mockReadiness = buildAssistantReadinessReport(controllerHome, repository);
    expect(mockReadiness.status).toBe("ready_for_mock");
    expect(mockReadiness.summary).toBe("Assistant has 0 live Google capability group(s) and 1 mock group(s).");
    expect(mockReadiness.plugins.find((plugin) => plugin.pluginId === "gmail")).toMatchObject({
      providerMode: "mock",
      readinessMode: "mock_provider_ready",
      userFacingStatus: "mock ready",
    });

    process.env.REPO_HARNESS_GMAIL_ACCESS_TOKEN = "test-live-token";
    const liveConfig = await executePluginAction(controllerHome, repository, {
      pluginId: "gmail",
      actionId: "configure",
      requestId: "gmail-live-config",
      args: {
        enabled: true,
        provider: "google-workspace",
        account_email: "assistant@example.com",
      },
      confirmAuthorization: true,
      origin: { surface: "local-ui", actor: "test" },
    });
    expect(liveConfig.execution.ok).toBe(true);

    const liveReadiness = buildAssistantReadinessReport(controllerHome, repository);
    expect(liveReadiness.status).toBe("ready_for_live");
    expect(liveReadiness.summary).toBe("Assistant has 1 live Google capability group(s) and 0 mock group(s).");
    expect(liveReadiness.plugins.find((plugin) => plugin.pluginId === "gmail")).toMatchObject({
      providerMode: "google-workspace",
      credentialSource: "env:REPO_HARNESS_GMAIL_ACCESS_TOKEN",
      readinessMode: "live_provider_ready",
      userFacingStatus: "ready",
    });
  });

  test("returns structured auth and rate-limit failures for Google providers", async () => {
    const { controllerHome, repository } = repoFixture();

    const calendarConfig = await executePluginAction(controllerHome, repository, {
      pluginId: "google_calendar",
      actionId: "configure",
      requestId: "calendar-live-config",
      args: {
        enabled: true,
        provider: "google-workspace",
        calendar_id: "primary",
      },
      confirmAuthorization: true,
      origin: { surface: "local-ui", actor: "test" },
    });
    expect(calendarConfig.execution.ok).toBe(true);

    const calendarRead = await executePluginAction(controllerHome, repository, {
      pluginId: "google_calendar",
      actionId: "list_events",
      requestId: "calendar-auth-failure",
      args: {},
      origin: { surface: "local-ui", actor: "test" },
    });
    expect(calendarRead.execution.ok).toBe(false);
    expect(calendarRead.execution.error?.code).toBe("PLUGIN_AUTH_REQUIRED");
    expect(calendarRead.execution.error?.retryable).toBe(false);

    process.env.REPO_HARNESS_GOOGLE_TASKS_ACCESS_TOKEN = "token-for-tests";
    globalThis.fetch = ((async () =>
      new Response(JSON.stringify({ error: { code: 429, message: "Too Many Requests" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      })) as unknown) as typeof fetch;

    const tasksConfig = await executePluginAction(controllerHome, repository, {
      pluginId: "google_tasks",
      actionId: "configure",
      requestId: "tasks-live-config",
      args: {
        enabled: true,
        provider: "google-workspace",
        task_list_id: "@default",
      },
      confirmAuthorization: true,
      origin: { surface: "local-ui", actor: "test" },
    });
    expect(tasksConfig.execution.ok).toBe(true);

    const taskRead = await executePluginAction(controllerHome, repository, {
      pluginId: "google_tasks",
      actionId: "list_tasklists",
      requestId: "tasks-rate-limit",
      args: {},
      origin: { surface: "local-ui", actor: "test" },
    });
    expect(taskRead.execution.ok).toBe(false);
    expect(taskRead.execution.error?.code).toBe("PLUGIN_RATE_LIMITED");
    expect(taskRead.execution.error?.retryable).toBe(true);
    expect(taskRead.execution.error?.details?.status).toBe(429);

    const events = ledgerEvents(controllerHome, repository.repoId);
    expect(events.some((event) => event.eventType === "plugin_action_failed" && event.data?.actionId === "list_tasklists")).toBe(true);
  });
});
