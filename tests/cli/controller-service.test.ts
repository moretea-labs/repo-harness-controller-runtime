import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { terminateProcessesByCommand, waitForNoProcessesByCommand } from "../runtime/process-hygiene";
import { formatControllerServiceStatus, type ControllerServiceStatus } from "../../src/cli/controller/lifecycle";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli/index.ts");
const SCRIPT = join(ROOT, "scripts/controller-runtime.sh");

const fixtures: Array<{ repoRoot: string; controllerHome: string }> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    spawnSync("bun", [CLI, "controller", "stop", "--repo", fixture.repoRoot], {
      cwd: ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        REPO_HARNESS_CONTROLLER_HOME: fixture.controllerHome,
      },
    });
    await terminateProcessesByCommand([fixture.repoRoot, fixture.controllerHome]);
    await waitForNoProcessesByCommand([fixture.repoRoot, fixture.controllerHome]);
    rmSync(fixture.repoRoot, { recursive: true, force: true });
    rmSync(fixture.controllerHome, { recursive: true, force: true });
  }
});

test("status formatting reports a live Supervisor as recovering and deduplicates diagnostics", () => {
  const text = formatControllerServiceStatus({
    repoRoot: "/tmp/repo",
    packageVersion: "1.0.0",
    bunVersion: "1.3.14",
    runtimeGeneration: "generation-test",
    authority: { runtimeState: { authority: "controller-home", path: "/tmp/controller-home/mcp/mcp.runtime.json" } },
    supervisor: { alive: true, pid: 1234 },
    daemon: { status: "ready", pid: 5678 },
    ports: { mcp: 8795, localController: 8776, mcpReachable: false, localControllerReachable: false },
    health: { mcp: false, localController: false },
    readiness: { gateway: false, daemon: true, scheduler: true, localController: true, projection: true, connector: false, public: false },
    logPath: "/tmp/supervisor.log",
    ready: false,
    running: false,
    restartRequired: false,
    restartReasons: [],
    infos: ["same info", "same info"],
    warnings: ["same warning", "same warning"],
    problems: ["same problem", "same problem"],
  } as unknown as ControllerServiceStatus);

  expect(text).toContain("Controller stack: recovering/degraded");
  expect(text.match(/info: same info/g)).toHaveLength(1);
  expect(text.match(/warning: same warning/g)).toHaveLength(1);
  expect(text.match(/problem: same problem/g)).toHaveLength(1);
});

test("controller rollout CLI accepts an operator-visible reason", () => {
  const result = spawnSync("bun", [CLI, "controller", "rollout", "--help"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("--reason <text>");
});

async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a free port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}

async function createFixture(): Promise<{ repoRoot: string; controllerHome: string }> {
  const repoRoot = mkdtempSync(join(tmpdir(), "repo-harness-controller-service-"));
  const controllerHome = mkdtempSync(join(tmpdir(), "repo-harness-controller-home-"));
  const mcpPort = await freePort();
  const localControllerPort = await freePort();
  fixtures.push({ repoRoot, controllerHome });
  mkdirSync(join(repoRoot, ".ai", "harness"), { recursive: true });
  mkdirSync(join(repoRoot, "tasks"), { recursive: true });
  mkdirSync(join(repoRoot, ".repo-harness"), { recursive: true });
  writeFileSync(join(repoRoot, ".ai", "harness", "policy.json"), "{}\n");
  writeFileSync(join(repoRoot, "tasks", "current.md"), "# Current\n");
  writeFileSync(
    join(repoRoot, ".repo-harness", "mcp.local.json"),
    `${JSON.stringify({
      version: 1,
      profile: "controller",
      server: { host: "127.0.0.1", port: mcpPort },
      auth: { mode: "bearer" },
      localController: { enabled: true, host: "127.0.0.1", port: localControllerPort, autoOpen: false },
    }, null, 2)}\n`,
  );
  expect(spawnSync("git", ["init", "-b", "main"], { cwd: repoRoot }).status).toBe(0);
  return { repoRoot, controllerHome };
}

function runCli(
  controllerHome: string,
  args: string[],
  options: { useScript?: boolean } = {},
) {
  return spawnSync(
    options.useScript ? "bash" : "bun",
    options.useScript ? [SCRIPT, ...args] : [CLI, ...args],
    {
      cwd: ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        REPO_HARNESS_CONTROLLER_HOME: controllerHome,
        // Keep lifecycle integration tests bounded independently of the
        // production restart recovery window.
        REPO_HARNESS_CONTROLLER_START_TIMEOUT_MS: "45000",
        // Detached test daemons must self-expire even if the test process is
        // interrupted before afterEach can stop the temporary controllerHome.
        REPO_HARNESS_DAEMON_MAX_LIFETIME_MS: "120000",
        REPO_HARNESS_NGROK_ROTATION_CONFIG: join(controllerHome, "disabled-ngrok-rotation.env"),
      },
    },
  );
}

function parseJsonPrefix<T>(text: string): T {
  const start = text.indexOf("{");
  if (start < 0) throw new Error(`JSON payload missing from output: ${text}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, index + 1)) as T;
    }
  }
  throw new Error(`JSON payload was not terminated: ${text}`);
}

async function waitForRunning(repoRoot: string, controllerHome: string, running: boolean): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = runCli(controllerHome, ["controller", "status", "--repo", repoRoot, "--json"]);
    expect(result.status).toBe(0);
    payload = JSON.parse(result.stdout) as Record<string, unknown>;
    if (payload.running === running) return payload;
    await Bun.sleep(250);
  }
  return payload;
}

describe("controller service lifecycle", () => {
  test("exposes one top-level Controller lifecycle", () => {
    const result = runCli("/tmp/unused", ["controller", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("start");
    expect(result.stdout).toContain("stop");
    expect(result.stdout).toContain("status");
    expect(result.stdout).toContain("restart");
    expect(result.stdout).toContain("logs");
    expect(result.stdout).not.toMatch(/^\s+service\b/m);
    expect(result.stdout).not.toMatch(/^\s+ui\b/m);
  });

  test("starts, reports, logs, restarts, and stops the detached Controller stack idempotently", async () => {
    const { repoRoot, controllerHome } = await createFixture();

    const start = runCli(controllerHome, ["start", "--repo", repoRoot, "--json"], { useScript: true });
    expect(start.status, start.stderr || start.stdout).toBe(0);
    const firstStart = parseJsonPrefix<{
      action: string;
      status: {
        running: boolean;
        serviceStatePath: string;
        runtimeStatePath: string;
        controllerHome: string;
        mcpRuntime?: {
          server?: { toolset?: string };
          localController?: { pid?: number };
        };
        supervisor: { pid?: number };
      };
    }>(start.stdout);
    expect(firstStart.action).toBe("started");
    expect(firstStart.status.running).toBe(true);
    // Lifecycle state is owned by controllerHome so blue/green slots never share PIDs.
    expect(realpathSync(firstStart.status.serviceStatePath)).toBe(
      realpathSync(join(controllerHome, "lifecycle", "controller-service.json")),
    );
    expect(firstStart.status.supervisor.pid).toBeTruthy();
    expect(firstStart.status.mcpRuntime?.localController?.pid).toBe(firstStart.status.supervisor.pid);
    expect(realpathSync(firstStart.status.controllerHome)).toBe(realpathSync(controllerHome));
    expect(realpathSync(firstStart.status.runtimeStatePath)).toBe(
      realpathSync(join(controllerHome, 'mcp', 'mcp.runtime.json')),
    );
    if (firstStart.status.mcpRuntime?.server?.toolset) {
      expect(firstStart.status.mcpRuntime.server.toolset).toBe('advanced');
    }

    const secondStart = runCli(controllerHome, ["start", "--repo", repoRoot, "--json"], { useScript: true });
    expect(secondStart.status).toBe(0);
    const secondPayload = parseJsonPrefix<{ action: string; status: { supervisor: { pid?: number } } }>(secondStart.stdout);
    expect(secondPayload.action).toBe("already_running");
    expect(secondPayload.status.supervisor.pid).toBe(firstStart.status.supervisor.pid);

    const running = await waitForRunning(repoRoot, controllerHome, true);
    expect(running.running).toBe(true);
    expect((running.health as { mcp?: boolean; localController?: boolean }).mcp).toBe(true);
    expect((running.health as { mcp?: boolean; localController?: boolean }).localController).toBe(true);

    const logs = runCli(controllerHome, ["logs", "--repo", repoRoot], { useScript: true });
    expect(logs.status).toBe(0);
    expect(logs.stdout).toContain("[repo-harness mcp keepalive] Repo:");

    const restart = runCli(controllerHome, ["restart", "--repo", repoRoot, "--json"], { useScript: true });
    expect(restart.status, restart.stderr || restart.stdout).toBe(0);
    const restarted = parseJsonPrefix<{
      action: string;
      status: {
        running: boolean;
        supervisor: { pid?: number };
        mcpRuntime?: { localController?: { pid?: number } };
      };
    }>(restart.stdout);
    expect(restarted.action).toBe("restarted");
    expect(restarted.status.running).toBe(true);
    expect(restarted.status.supervisor.pid).not.toBe(firstStart.status.supervisor.pid);
    expect(restarted.status.mcpRuntime?.localController?.pid).toBe(restarted.status.supervisor.pid);

    const stop = runCli(controllerHome, ["stop", "--repo", repoRoot, "--json"], { useScript: true });
    expect(stop.status).toBe(0);
    const stopped = parseJsonPrefix<{ action: string }>(stop.stdout);
    expect(stopped.action).toBe("stopped");

    const finalStatus = await waitForRunning(repoRoot, controllerHome, false);
    expect(finalStatus.running).toBe(false);
    expect((finalStatus.supervisor as { alive?: boolean }).alive).toBe(false);

    const logPath = join(controllerHome, "logs", "repo-harness-controller.log");
    expect(readFileSync(logPath, "utf-8")).toContain("[repo-harness mcp keepalive] Repo:");
  }, 150_000);

  test("status warns when repo-local legacy MCP config diverges from controller-home config", async () => {
    const { repoRoot, controllerHome } = await createFixture();
    mkdirSync(join(controllerHome, "mcp"), { recursive: true });
    writeFileSync(
      join(controllerHome, "mcp", "mcp.local.json"),
      `${JSON.stringify({
        version: 1,
        profile: "controller",
        toolset: "advanced",
        server: { host: "127.0.0.1", port: 8765 },
        auth: { mode: "oauth" },
        chatgpt: { endpoint: "https://controller.example.test/mcp" },
        localController: { enabled: true, host: "127.0.0.1", port: 8766, autoOpen: false },
        devMode: { agentRunner: true, allowedAgents: ["codex"], timeoutMs: 3_600_000, maxTimeoutMs: 43_200_000 },
      }, null, 2)}\n`,
    );

    const status = runCli(controllerHome, ["controller", "status", "--repo", repoRoot, "--json"]);
    expect(status.status).toBe(0);
    const payload = JSON.parse(status.stdout) as { infos?: string[]; warnings?: string[] };
    expect(payload.infos?.some((line) => line.includes("Legacy repo-local MCP config diverges from controllerHome"))).toBe(true);
    expect(payload.warnings?.some((line) => line.includes("Legacy repo-local MCP config diverges from controllerHome"))).not.toBe(true);
  });
});
