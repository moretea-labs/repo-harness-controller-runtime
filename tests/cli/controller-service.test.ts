import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli/index.ts");
const SCRIPT = join(ROOT, "scripts/controller-runtime.sh");

const fixtures: Array<{ repoRoot: string; controllerHome: string }> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    spawnSync("bun", [CLI, "controller", "service", "stop", "--repo", fixture.repoRoot], {
      cwd: ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        REPO_HARNESS_CONTROLLER_HOME: fixture.controllerHome,
      },
    });
    rmSync(fixture.repoRoot, { recursive: true, force: true });
    rmSync(fixture.controllerHome, { recursive: true, force: true });
  }
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
      },
    },
  );
}

async function waitForRunning(repoRoot: string, controllerHome: string, running: boolean): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = runCli(controllerHome, ["controller", "service", "status", "--repo", repoRoot, "--json"]);
    expect(result.status).toBe(0);
    payload = JSON.parse(result.stdout) as Record<string, unknown>;
    if (payload.running === running) return payload;
    await Bun.sleep(250);
  }
  return payload;
}

describe("controller service lifecycle", () => {
  test("prints help for the service lifecycle group", () => {
    const result = runCli("/tmp/unused", ["controller", "service", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("start");
    expect(result.stdout).toContain("stop");
    expect(result.stdout).toContain("status");
    expect(result.stdout).toContain("restart");
    expect(result.stdout).toContain("logs");
  });

  test("starts, reports, logs, restarts, and stops the detached Controller stack idempotently", async () => {
    const { repoRoot, controllerHome } = await createFixture();

    const start = runCli(controllerHome, ["start", "--repo", repoRoot, "--json"], { useScript: true });
    expect(start.status).toBe(0);
    const firstStart = JSON.parse(start.stdout) as {
      action: string;
      status: { running: boolean; serviceStatePath: string; supervisor: { pid?: number } };
    };
    expect(firstStart.action).toBe("started");
    expect(firstStart.status.running).toBe(true);
    expect(firstStart.status.serviceStatePath).toBe(
      join(repoRoot, ".ai", "local", "state", "controller-service.json"),
    );
    expect(firstStart.status.supervisor.pid).toBeTruthy();

    const secondStart = runCli(controllerHome, ["start", "--repo", repoRoot, "--json"], { useScript: true });
    expect(secondStart.status).toBe(0);
    const secondPayload = JSON.parse(secondStart.stdout) as { action: string; status: { supervisor: { pid?: number } } };
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
    expect(restart.status).toBe(0);
    const restarted = JSON.parse(restart.stdout) as { action: string; status: { running: boolean } };
    expect(restarted.action).toBe("restarted");
    expect(restarted.status.running).toBe(true);

    const stop = runCli(controllerHome, ["stop", "--repo", repoRoot, "--json"], { useScript: true });
    expect(stop.status).toBe(0);
    const stopped = JSON.parse(stop.stdout) as { action: string };
    expect(stopped.action).toBe("stopped");

    const finalStatus = await waitForRunning(repoRoot, controllerHome, false);
    expect(finalStatus.running).toBe(false);
    expect((finalStatus.supervisor as { alive?: boolean }).alive).toBe(false);

    const logPath = join(repoRoot, ".ai", "local", "logs", "repo-harness-controller.log");
    expect(readFileSync(logPath, "utf-8")).toContain("[repo-harness mcp keepalive] Repo:");
  });
});
