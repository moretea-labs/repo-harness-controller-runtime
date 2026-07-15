import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  controllerServiceStatePath,
  type ControllerServiceActionResult,
  type ControllerServiceStatus,
} from "../../src/cli/controller/lifecycle";
import {
  controllerRestartDirectory,
  controllerRestartStatePath,
  readControllerRestartState,
  restartRequestNeedsDetachedCoordinator,
  runControllerRestartCoordinator,
  scheduleControllerServiceRestart,
  verifyControllerRestart,
  type ControllerRestartState,
} from "../../src/cli/controller/restart-coordinator";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; repoRoot: string; controllerHome: string } {
  const root = mkdtempSync(join(tmpdir(), "repo-harness-restart-coordinator-"));
  const repoRoot = join(root, "repo");
  const controllerHome = join(root, "controller-home");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(controllerHome, { recursive: true });
  roots.push(root);
  return { root, repoRoot, controllerHome };
}

function statusFixture(input: {
  repoRoot: string;
  controllerHome: string;
  generation?: string;
  localMcp?: boolean;
  publicEndpoint?: string;
}): ControllerServiceStatus {
  const localMcp = input.localMcp ?? true;
  return {
    repoRoot: input.repoRoot,
    packageVersion: "test",
    bunVersion: "test",
    controllerHome: input.controllerHome,
    adopted: false,
    serviceStatePath: join(input.repoRoot, "controller-service.json"),
    runtimeStatePath: join(input.controllerHome, "mcp.runtime.json"),
    logPath: join(input.repoRoot, "controller.log"),
    running: true,
    ready: localMcp,
    readiness: {
      gateway: localMcp,
      daemon: true,
      scheduler: true,
      localController: true,
      projection: true,
      public: true,
      connector: true,
    },
    restartRequired: false,
    restartReasons: [],
    runtimeGeneration: input.generation ?? "generation-2",
    supervisor: { pid: 101, alive: true, staleState: false },
    daemon: { schemaVersion: 1, status: "ready", pid: 102 },
    mcpRuntime: {
      version: 1,
      repo: input.repoRoot,
      startedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:01.000Z",
      status: "running",
      tunnelMode: "none",
      generation: input.generation ?? "generation-2",
      server: {
        endpoint: "http://127.0.0.1:8765/mcp",
        running: true,
        healthy: true,
        restartCount: 0,
      },
      localController: {
        endpoint: "http://127.0.0.1:8766/",
        running: true,
      },
      tunnel: input.publicEndpoint ? {
        running: false,
        healthy: true,
        restartCount: 0,
        publicEndpoint: input.publicEndpoint,
        connectorNeedsReconnect: false,
      } : undefined,
    },
    health: { mcp: localMcp, localController: true },
    ports: {
      mcp: 8765,
      localController: 8766,
      mcpReachable: localMcp,
      localControllerReachable: true,
      mcpOwners: [],
      localControllerOwners: [],
    },
    authority: {
      localConfig: { source: "controller-home", path: join(input.controllerHome, "mcp.local.json") },
      runtimeState: { source: "controller-home", path: join(input.controllerHome, "mcp.runtime.json") },
    },
    orphanedProcesses: [],
    infos: [],
    warnings: [],
    problems: [],
  } as unknown as ControllerServiceStatus;
}

function action(action: ControllerServiceActionResult["action"], status: ControllerServiceStatus): ControllerServiceActionResult {
  return { action, cleanedPids: [], status };
}

describe("controller restart coordinator", () => {
  test("detects a request running inside the managed process ancestry", () => {
    const { repoRoot, controllerHome } = fixture();
    const statePath = controllerServiceStatePath(repoRoot);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify({
      schemaVersion: 1,
      repoRoot,
      packageVersion: "test",
      controllerHome,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      status: "running",
      supervisor: { pid: 777, logPath: join(repoRoot, "controller.log") },
      config: {
        mcpHost: "127.0.0.1",
        mcpPort: 8765,
        localControllerHost: "127.0.0.1",
        localControllerPort: 8766,
        tunnelMode: "none",
      },
    }, null, 2)}\n`);

    expect(restartRequestNeedsDetachedCoordinator(repoRoot, controllerHome, {
      ancestry: () => new Set([process.pid, 777]),
    })).toBe(true);
    expect(restartRequestNeedsDetachedCoordinator(repoRoot, controllerHome, {
      ancestry: () => new Set([process.pid, 778]),
    })).toBe(false);
  });

  test("persists one request, deduplicates overlap, and never removes a lock it did not acquire", () => {
    const { repoRoot, controllerHome } = fixture();
    let launches = 0;
    const deps = {
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      launch: () => { launches += 1; return 9001; },
      isPidAlive: (pid: number | undefined) => pid === 9001,
    };
    const first = scheduleControllerServiceRestart({
      repo: repoRoot,
      controllerHome,
      requestId: "restart-one",
      requestedBy: "test",
      mode: "detached",
    }, deps);
    expect(first.deduplicated).toBe(false);
    expect(launches).toBe(1);
    expect(JSON.parse(readFileSync(first.statePath, "utf8")).requestId).toBe("restart-one");

    const same = scheduleControllerServiceRestart({
      repo: repoRoot,
      controllerHome,
      requestId: "restart-one",
      mode: "detached",
    }, deps);
    expect(same.deduplicated).toBe(true);
    expect(launches).toBe(1);

    const lockPath = join(controllerRestartDirectory(controllerHome), "schedule.lock");
    writeFileSync(lockPath, "owned elsewhere\n");
    const overlapping = scheduleControllerServiceRestart({
      repo: repoRoot,
      controllerHome,
      requestId: "restart-two",
      mode: "detached",
    }, deps);
    expect(overlapping.requestId).toBe("restart-one");
    expect(overlapping.deduplicated).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("fails closed when a live lock owner has not published restart state", () => {
    const { repoRoot, controllerHome } = fixture();
    const lockPath = join(controllerRestartDirectory(controllerHome), "schedule.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({ pid: 4242, createdAt: "2026-07-15T00:00:00.000Z" })}\n`);

    expect(() => scheduleControllerServiceRestart({
      repo: repoRoot,
      controllerHome,
      requestId: "restart-race",
      mode: "detached",
    }, {
      now: () => new Date("2026-07-15T00:00:01.000Z"),
      isPidAlive: (pid) => pid === 4242,
      launch: () => { throw new Error("must not launch without the schedule lock"); },
    })).toThrow("RESTART_SCHEDULE_BUSY");
    expect(existsSync(lockPath)).toBe(true);
    expect(readControllerRestartState(controllerHome)).toBeNull();
  });

  test("records a bounded failed terminal state when post-restart verification fails", async () => {
    const { repoRoot, controllerHome } = fixture();
    scheduleControllerServiceRestart({
      repo: repoRoot,
      controllerHome,
      requestId: "restart-fails",
      mode: "detached",
    }, {
      launch: () => 9002,
      isPidAlive: () => true,
    });
    const failedStatus = statusFixture({ repoRoot, controllerHome, localMcp: false });

    await expect(runControllerRestartCoordinator({
      repo: repoRoot,
      controllerHome,
      requestId: "restart-fails",
    }, {
      sleep: async () => undefined,
      stop: async () => action("stopped", failedStatus),
      start: async () => action("started", failedStatus),
      status: async () => failedStatus,
      verificationAttempts: 1,
    })).rejects.toThrow("RESTART_VERIFICATION_FAILED");

    const persisted = readControllerRestartState(controllerHome, "restart-fails");
    expect(persisted?.phase).toBe("failed");
    expect(persisted?.completedAt).toBeTruthy();
    expect(persisted?.error).toContain("local MCP Gateway is not healthy");
    expect((persisted?.error?.length ?? 0) <= 1_000).toBe(true);
    expect(existsSync(controllerRestartStatePath(controllerHome))).toBe(true);
  });

  test("preserves external tunnel stop/start ordering around a successful restart", async () => {
    const { repoRoot, controllerHome } = fixture();
    const calls: string[] = [];
    scheduleControllerServiceRestart({
      repo: repoRoot,
      controllerHome,
      requestId: "restart-tunnel-success",
      mode: "detached",
    }, { launch: () => 9003, isPidAlive: () => true });
    const ready = statusFixture({ repoRoot, controllerHome, generation: "generation-2" });

    const state = await runControllerRestartCoordinator({
      repo: repoRoot,
      controllerHome,
      requestId: "restart-tunnel-success",
    }, {
      sleep: async () => undefined,
      manageExternalTunnel: (_root, actionName) => { calls.push(`tunnel:${actionName}`); },
      stop: async () => { calls.push("service:stop"); return action("stopped", ready); },
      start: async () => { calls.push("service:start"); return action("started", ready); },
      status: async () => ready,
      verificationAttempts: 1,
    });

    expect(state.phase).toBe("succeeded");
    expect(calls).toEqual(["tunnel:stop", "service:stop", "service:start", "tunnel:start"]);
  });

  test("attempts to restore the external tunnel when service startup fails", async () => {
    const { repoRoot, controllerHome } = fixture();
    const calls: string[] = [];
    scheduleControllerServiceRestart({
      repo: repoRoot,
      controllerHome,
      requestId: "restart-tunnel-failure",
      mode: "detached",
    }, { launch: () => 9004, isPidAlive: () => true });
    const ready = statusFixture({ repoRoot, controllerHome });

    await expect(runControllerRestartCoordinator({
      repo: repoRoot,
      controllerHome,
      requestId: "restart-tunnel-failure",
    }, {
      sleep: async () => undefined,
      manageExternalTunnel: (_root, actionName) => { calls.push(`tunnel:${actionName}`); },
      stop: async () => { calls.push("service:stop"); return action("stopped", ready); },
      start: async () => { calls.push("service:start"); throw new Error("startup failed"); },
      verificationAttempts: 1,
    })).rejects.toThrow("startup failed");

    expect(calls).toEqual(["tunnel:stop", "service:stop", "service:start", "tunnel:start"]);
    expect(readControllerRestartState(controllerHome, "restart-tunnel-failure")?.phase).toBe("failed");
  });

  test("verifies local readiness, generation change, stable-domain health, and OAuth discovery", async () => {
    const { repoRoot, controllerHome } = fixture();
    const endpoint = "https://mcp.example.test/mcp";
    const state: ControllerRestartState = {
      schemaVersion: 1,
      requestId: "restart-success",
      repoRoot,
      controllerHome,
      phase: "verifying",
      requestedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:01.000Z",
      requestedBy: "test",
      delayMs: 0,
      previousGeneration: "generation-1",
    };
    const verification = await verifyControllerRestart(
      state,
      statusFixture({ repoRoot, controllerHome, generation: "generation-2", publicEndpoint: endpoint }),
      {
        fetchJson: async (url) => url.endsWith("/health")
          ? { status: "ok" }
          : { resource: endpoint, authorization_servers: ["https://auth.example.test"] },
      },
    );
    expect(verification.ok).toBe(true);
    expect(verification.runtimeGenerationChanged).toBe(true);
    expect(verification.publicHealth).toBe(true);
    expect(verification.oauthDiscovery).toBe(true);
    expect(verification.failures).toEqual([]);
  });
});
