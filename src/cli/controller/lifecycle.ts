import { spawn } from "child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "fs";
import { createConnection } from "net";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { reconcileAgentJobs } from "../agent-jobs/job-manager";
import { reconcileLocalBridgeJobs } from "../local-bridge/job-store";
import { loadMcpLocalConfig, loadMcpRuntimeState, mcpRuntimeStatePath, type McpRuntimeState } from "../mcp/auth";
import { inferMcpTunnelMode, isExpectedLocalControllerHealth, normalizeKeepalivePublicEndpoint, resolveSelfCliInvocation } from "../mcp/keepalive";
import { resolveMcpRepoRoot } from "../mcp/repo";
import { resolveControllerHome } from "../repositories/controller-home";
import { runProcess } from "../../effects/process-runner";
import { ensureControllerDaemon, readControllerDaemonStatus, type ControllerDaemonStatus } from "../../runtime/control-plane/daemon-client";
import { isProcessAlive, terminateProcessTree } from "../../runtime/shared/process-tree";

const DEFAULT_START_TIMEOUT_MS = 20_000;
const DEFAULT_STOP_TIMEOUT_MS = 8_000;
const HEALTH_TIMEOUT_MS = 2_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const PORT_PROBE_TIMEOUT_MS = 750;
const PROCESS_STOP_POLL_MS = 100;

export interface ControllerServiceState {
  schemaVersion: 1;
  repoRoot: string;
  packageVersion: string;
  controllerHome: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "stopped";
  supervisor: {
    pid?: number;
    logPath: string;
    startedAt?: string;
    stoppedAt?: string;
  };
  localController?: {
    pid?: number;
    startedAt?: string;
    stoppedAt?: string;
  };
  config: {
    mcpHost: string;
    mcpPort: number;
    localControllerHost: string;
    localControllerPort: number;
    tunnelMode: "none" | "quick" | "named";
  };
}

export interface ControllerServiceProcess {
  pid: number;
  command: string;
  kind: "supervisor" | "mcp-keepalive" | "mcp-serve" | "local-controller" | "controller-daemon" | "unknown";
}

export interface ControllerServiceHealth {
  mcp: boolean;
  localController: boolean;
}

export interface ControllerServiceStatus {
  repoRoot: string;
  packageVersion: string;
  bunVersion: string | null;
  controllerHome: string;
  adopted: boolean;
  serviceStatePath: string;
  runtimeStatePath: string;
  logPath: string;
  running: boolean;
  supervisor: {
    pid?: number;
    alive: boolean;
    staleState: boolean;
  };
  daemon: ControllerDaemonStatus;
  mcpRuntime: McpRuntimeState | null;
  health: ControllerServiceHealth;
  ports: {
    mcp: number;
    localController: number;
    mcpReachable: boolean;
    localControllerReachable: boolean;
    mcpOwners: string[];
    localControllerOwners: string[];
  };
  orphanedProcesses: ControllerServiceProcess[];
  warnings: string[];
  problems: string[];
}

export interface ControllerServiceActionResult {
  action: "started" | "already_running" | "stopped" | "already_stopped" | "restarted";
  cleanedPids: number[];
  status: ControllerServiceStatus;
}

export interface ControllerServiceLogsResult {
  logPath: string;
  text: string;
}

export interface ControllerServiceOptions {
  repo?: string;
  logFile?: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function currentPackageVersion(): string {
  const path = fileURLToPath(new URL("../../../package.json", import.meta.url));
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : "0.0.0-dev";
  } catch (_error) {
    return "0.0.0-dev";
  }
}

export function controllerServiceStatePath(repoRoot: string): string {
  return join(repoRoot, ".ai", "local", "state", "controller-service.json");
}

export function defaultControllerServiceLogPath(repoRoot: string): string {
  return join(repoRoot, ".ai", "local", "logs", "repo-harness-controller.log");
}

function writeControllerServiceState(repoRoot: string, state: ControllerServiceState): ControllerServiceState {
  const path = controllerServiceStatePath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  return state;
}

export function loadControllerServiceState(repoRoot: string): ControllerServiceState | null {
  const path = controllerServiceStatePath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ControllerServiceState;
  } catch (_error) {
    return null;
  }
}

function isPidAlive(pid: number | undefined): boolean {
  return pid !== process.pid && isProcessAlive(pid);
}

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

async function stopPid(pid: number, timeoutMs: number): Promise<void> {
  await terminateProcessTree(pid, {
    gracePeriodMs: Math.max(PROCESS_STOP_POLL_MS, Math.min(timeoutMs, 1_500)),
    killAfterMs: Math.max(500, timeoutMs),
    pollIntervalMs: PROCESS_STOP_POLL_MS,
  });
}

function readLogTail(path: string, maxChars = 8_000): string {
  try {
    const text = readFileSync(path, "utf-8");
    return text.length <= maxChars ? text : text.slice(-maxChars);
  } catch (_error) {
    return "";
  }
}

function normalizedHost(host: string): string {
  return host === "::1" ? "[::1]" : host;
}

function localMcpHealthUrl(host: string, port: number): string {
  return `http://${normalizedHost(host)}:${port}/health`;
}

function localControllerHealthUrl(host: string, port: number): string {
  return `http://${normalizedHost(host)}:${port}/health`;
}

async function jsonHealth(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function portReachable(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({ host, port });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch (_error) {
        // Ignore close failures.
      }
      resolvePromise(value);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function processMatchesRepoHarness(commandLine: string, repoRoot: string): boolean {
  if (!commandLine.includes(repoRoot)) return false;
  return commandLine.includes("repo-harness")
    || commandLine.includes("/src/cli/index.ts")
    || commandLine.includes("/scripts/controller-runtime.sh");
}

function detectProcessKind(commandLine: string): ControllerServiceProcess["kind"] {
  if (commandLine.includes("mcp keepalive")) return "mcp-keepalive";
  if (commandLine.includes("mcp serve")) return "mcp-serve";
  if (commandLine.includes("controller service")) return "supervisor";
  if (commandLine.includes("controller ui")) return "local-controller";
  if (commandLine.includes("daemon-entry.ts")) return "controller-daemon";
  return "unknown";
}

function listPortOwners(port: number): string[] {
  const result = runProcess("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    timeoutMs: 2_000,
    maxOutputBytes: 16 * 1024,
  });
  if (!result.ok) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(1);
}

function currentProcessAncestry(): Set<number> {
  const protectedPids = new Set<number>([process.pid]);
  let current = process.pid;
  for (let depth = 0; depth < 16; depth += 1) {
    const result = runProcess("ps", ["-o", "ppid=", "-p", String(current)], {
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    });
    if (!result.ok) break;
    const parent = Number(result.stdout.trim());
    if (!Number.isInteger(parent) || parent <= 1 || protectedPids.has(parent)) break;
    protectedPids.add(parent);
    current = parent;
  }
  return protectedPids;
}

function collectControllerServiceProcesses(repoRoot: string, state: ControllerServiceState | null, controllerHome: string): ControllerServiceProcess[] {
  const seen = new Map<number, ControllerServiceProcess>();
  const protectedPids = currentProcessAncestry();
  const add = (pid: number | undefined, command: string, kind: ControllerServiceProcess["kind"]) => {
    if (!pid || pid <= 0 || protectedPids.has(pid)) return;
    if (!seen.has(pid)) seen.set(pid, { pid, command, kind });
  };

  add(state?.supervisor.pid, "controller service supervisor", "supervisor");
  add(state?.localController?.pid, "local controller", "local-controller");
  const runtime = loadMcpRuntimeState(repoRoot);
  add(runtime?.server.pid, "mcp serve", "mcp-serve");
  add(runtime?.localController?.pid, "local controller", "local-controller");
  add(runtime?.tunnel?.pid, "cloudflared tunnel", "unknown");
  const daemon = readControllerDaemonStatus(controllerHome);
  add(daemon.pid, "controller daemon", "controller-daemon");

  const ps = runProcess("ps", ["ax", "-o", "pid=", "-o", "command="], {
    timeoutMs: 5_000,
    maxOutputBytes: 512 * 1024,
  });
  if (!ps.ok) return Array.from(seen.values());
  for (const line of ps.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const commandLine = match[2];
    if (!Number.isInteger(pid) || protectedPids.has(pid)) continue;
    if (!processMatchesRepoHarness(commandLine, repoRoot)) continue;
    add(pid, commandLine, detectProcessKind(commandLine));
  }
  return Array.from(seen.values()).sort((a, b) => a.pid - b.pid);
}

function resolveServiceConfig(repoRoot: string, explicitLogFile?: string): {
  repoRoot: string;
  controllerHome: string;
  packageVersion: string;
  mcpHost: string;
  mcpPort: number;
  localControllerHost: string;
  localControllerPort: number;
  tunnelMode: "none" | "quick" | "named";
  toolset: "core" | "full";
  logPath: string;
} {
  const localConfig = loadMcpLocalConfig(repoRoot);
  const runtime = loadMcpRuntimeState(repoRoot);
  const publicEndpoint = normalizeKeepalivePublicEndpoint(localConfig?.chatgpt?.endpoint);
  const tunnelMode = publicEndpoint || runtime?.tunnel?.name
    ? inferMcpTunnelMode(runtime?.tunnelMode, publicEndpoint, runtime?.tunnel?.name)
    : "none";
  return {
    repoRoot,
    controllerHome: resolveControllerHome(),
    packageVersion: currentPackageVersion(),
    mcpHost: localConfig?.server?.host ?? "127.0.0.1",
    mcpPort: localConfig?.server?.port ?? 8765,
    localControllerHost: localConfig?.localController?.host ?? "127.0.0.1",
    localControllerPort: localConfig?.localController?.port ?? 8766,
    tunnelMode,
    toolset: localConfig?.toolset === "full" ? "full" : "core",
    logPath: resolve(explicitLogFile ?? defaultControllerServiceLogPath(repoRoot)),
  };
}

async function healthSummary(repoRoot: string, host: string, mcpPort: number, localControllerHost: string, localControllerPort: number): Promise<{
  health: ControllerServiceHealth;
  mcpReachable: boolean;
  localControllerReachable: boolean;
}> {
  const [mcpHealth, localControllerHealth, mcpReachable, localControllerReachable] = await Promise.all([
    jsonHealth(localMcpHealthUrl(host, mcpPort)),
    jsonHealth(localControllerHealthUrl(localControllerHost, localControllerPort)),
    portReachable(host, mcpPort),
    portReachable(localControllerHost, localControllerPort),
  ]);
  return {
    health: {
      mcp: mcpHealth?.status === "ok",
      localController: isExpectedLocalControllerHealth(localControllerHealth, repoRoot),
    },
    mcpReachable,
    localControllerReachable,
  };
}

function adoptedRepo(repoRoot: string): boolean {
  return existsSync(join(repoRoot, ".ai", "harness", "policy.json")) || existsSync(join(repoRoot, "tasks", "current.md"));
}

export async function controllerServiceStatus(opts: ControllerServiceOptions = {}): Promise<ControllerServiceStatus> {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? ".");
  const config = resolveServiceConfig(repoRoot, opts.logFile);
  const state = loadControllerServiceState(repoRoot);
  const runtime = loadMcpRuntimeState(repoRoot);
  const supervisorAlive = isPidAlive(state?.supervisor.pid);
  const daemon = readControllerDaemonStatus(config.controllerHome);
  const ports = await healthSummary(repoRoot, config.mcpHost, config.mcpPort, config.localControllerHost, config.localControllerPort);
  const processes = collectControllerServiceProcesses(repoRoot, state, config.controllerHome);
  const orphanedProcesses = supervisorAlive
    ? processes.filter((entry) =>
      entry.kind !== "controller-daemon"
      && entry.kind !== "mcp-serve"
      && entry.kind !== "local-controller"
      && entry.pid !== state?.supervisor.pid)
    : processes.filter((entry) => entry.kind !== "controller-daemon");
  const warnings: string[] = [];
  const problems: string[] = [];

  if (!process.versions.bun) warnings.push("Bun runtime is not active; start and restart commands require `bun`.");
  if (!adoptedRepo(repoRoot)) warnings.push("Repository does not look adopted yet (`.ai/harness/policy.json` or `tasks/current.md` missing).");
  if (state?.packageVersion && state.packageVersion !== config.packageVersion) {
    warnings.push(`Lifecycle state was started by repo-harness ${state.packageVersion}; current CLI is ${config.packageVersion}. Use restart to refresh the stack.`);
  }
  if (state?.supervisor.pid && !supervisorAlive) problems.push(`Supervisor PID ${state.supervisor.pid} is no longer alive; a previous start likely exited unexpectedly.`);
  if (ports.mcpReachable && !ports.health.mcp) {
    problems.push(`MCP port ${config.mcpPort} is in use but /health is not reporting a healthy repo-harness surface.`);
  }
  if (ports.localControllerReachable && !ports.health.localController) {
    problems.push(`Local Controller port ${config.localControllerPort} is in use but /health is not reporting the expected local-only controller surface.`);
  }
  if (daemon.status === "failed") problems.push(`Controller daemon is unhealthy: ${daemon.error ?? "unknown error"}`);
  if (orphanedProcesses.length > 0) warnings.push(`Detected ${orphanedProcesses.length} detached repo-harness process(es) outside the tracked supervisor.`);

  return {
    repoRoot,
    packageVersion: config.packageVersion,
    bunVersion: process.versions.bun ?? null,
    controllerHome: config.controllerHome,
    adopted: adoptedRepo(repoRoot),
    serviceStatePath: controllerServiceStatePath(repoRoot),
    runtimeStatePath: mcpRuntimeStatePath(repoRoot),
    logPath: config.logPath,
    running: supervisorAlive && ports.health.mcp && ports.health.localController,
    supervisor: {
      pid: state?.supervisor.pid,
      alive: supervisorAlive,
      staleState: Boolean(state?.supervisor.pid && !supervisorAlive),
    },
    daemon,
    mcpRuntime: runtime,
    health: ports.health,
    ports: {
      mcp: config.mcpPort,
      localController: config.localControllerPort,
      mcpReachable: ports.mcpReachable,
      localControllerReachable: ports.localControllerReachable,
      mcpOwners: listPortOwners(config.mcpPort),
      localControllerOwners: listPortOwners(config.localControllerPort),
    },
    orphanedProcesses,
    warnings,
    problems,
  };
}

async function waitForHealthyStart(repoRoot: string, timeoutMs: number, logPath: string): Promise<ControllerServiceStatus> {
  const deadline = Date.now() + Math.max(2_000, timeoutMs);
  let latest = await controllerServiceStatus({ repo: repoRoot, logFile: logPath });
  while (Date.now() < deadline) {
    if (latest.health.mcp && latest.health.localController && latest.supervisor.alive) return latest;
    await sleep(HEALTH_POLL_INTERVAL_MS);
    latest = await controllerServiceStatus({ repo: repoRoot, logFile: logPath });
  }
  const tail = readLogTail(logPath);
  const lines = [
    `Controller stack did not become healthy within ${timeoutMs}ms.`,
    `MCP health: ${latest.health.mcp ? "ok" : "not ready"}`,
    `Local Controller health: ${latest.health.localController ? "ok" : "not ready"}`,
    `Supervisor PID: ${latest.supervisor.pid ?? "missing"}`,
  ];
  if (tail) lines.push("", "Recent log tail:", tail);
  throw new Error(lines.join("\n"));
}

function ensureStartableStatus(status: ControllerServiceStatus): void {
  if (status.ports.mcpReachable && !status.health.mcp) {
    throw new Error([
      `Cannot start Controller stack because MCP port ${status.ports.mcp} is already occupied by a non-matching process.`,
      ...status.ports.mcpOwners.map((line) => `  ${line}`),
      "Stop the conflicting process or change `.repo-harness/mcp.local.json` before retrying.",
    ].join("\n"));
  }
  if (status.ports.localControllerReachable && !status.health.localController) {
    throw new Error([
      `Cannot start Controller stack because Local Controller port ${status.ports.localController} is already occupied by a non-matching process.`,
      ...status.ports.localControllerOwners.map((line) => `  ${line}`),
      "Stop the conflicting process or change `.repo-harness/mcp.local.json` before retrying.",
    ].join("\n"));
  }
}

function spawnDetached(command: string, args: string[], cwd: string, logPath: string): number {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  try {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
    if (!child.pid) throw new Error("detached keepalive did not return a PID");
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

async function stopProcesses(processes: ControllerServiceProcess[], timeoutMs: number): Promise<number[]> {
  const stopped: number[] = [];
  for (const processInfo of processes) {
    await stopPid(processInfo.pid, timeoutMs);
    stopped.push(processInfo.pid);
  }
  return stopped;
}

export async function startControllerService(opts: ControllerServiceOptions = {}): Promise<ControllerServiceActionResult> {
  if (!process.versions.bun) throw new Error("Bun is required to start the Controller stack.");
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? ".");
  const config = resolveServiceConfig(repoRoot, opts.logFile);
  let status = await controllerServiceStatus({ repo: repoRoot, logFile: config.logPath });
  if (status.running && status.supervisor.alive) {
    return { action: "already_running", cleanedPids: [], status };
  }

  let cleaned: number[] = [];
  if (status.supervisor.alive || status.health.mcp || status.health.localController || status.orphanedProcesses.length > 0) {
    cleaned = (await stopControllerService({
      repo: repoRoot,
      logFile: config.logPath,
      stopTimeoutMs: opts.stopTimeoutMs,
    })).cleanedPids;
    status = await controllerServiceStatus({ repo: repoRoot, logFile: config.logPath });
  }

  ensureStartableStatus(status);
  reconcileAgentJobs(repoRoot);
  reconcileLocalBridgeJobs(repoRoot);
  ensureControllerDaemon(config.controllerHome);

  const cli = resolveSelfCliInvocation();
  const localControllerPid = spawnDetached(
    cli.command,
    [
      ...cli.args,
      "controller",
      "ui",
      "--repo",
      repoRoot,
      "--host",
      config.localControllerHost,
      "--port",
      String(config.localControllerPort),
      "--no-open",
    ],
    repoRoot,
    config.logPath,
  );
  let pid: number;
  try {
    pid = spawnDetached(
      cli.command,
      [
        ...cli.args,
        "mcp",
        "keepalive",
        "--repo",
        repoRoot,
        "--host",
        config.mcpHost,
        "--port",
        String(config.mcpPort),
        "--toolset",
        config.toolset,
        "--no-local-ui",
        "--tunnel",
        config.tunnelMode,
      ],
      repoRoot,
      config.logPath,
    );
  } catch (error) {
    await stopPid(localControllerPid, opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    throw error;
  }
  writeControllerServiceState(repoRoot, {
    schemaVersion: 1,
    repoRoot,
    packageVersion: config.packageVersion,
    controllerHome: config.controllerHome,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "running",
    supervisor: {
      pid,
      logPath: config.logPath,
      startedAt: nowIso(),
    },
    localController: {
      pid: localControllerPid,
      startedAt: nowIso(),
    },
    config: {
      mcpHost: config.mcpHost,
      mcpPort: config.mcpPort,
      localControllerHost: config.localControllerHost,
      localControllerPort: config.localControllerPort,
      tunnelMode: config.tunnelMode,
    },
  });

  status = await waitForHealthyStart(repoRoot, opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, config.logPath);
  return { action: "started", cleanedPids: cleaned, status };
}

export async function stopControllerService(opts: ControllerServiceOptions = {}): Promise<ControllerServiceActionResult> {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? ".");
  const config = resolveServiceConfig(repoRoot, opts.logFile);
  const state = loadControllerServiceState(repoRoot);
  const status = await controllerServiceStatus({ repo: repoRoot, logFile: config.logPath });
  const processes = collectControllerServiceProcesses(repoRoot, state, config.controllerHome);
  const stoppable = processes.filter((entry) => entry.kind !== "unknown" || entry.command.includes(repoRoot));
  if (stoppable.length === 0) {
    if (state) {
      writeControllerServiceState(repoRoot, {
        ...state,
        updatedAt: nowIso(),
        status: "stopped",
        supervisor: {
          ...state.supervisor,
          pid: undefined,
          stoppedAt: nowIso(),
        },
        localController: {
          ...state.localController,
          pid: undefined,
          stoppedAt: nowIso(),
        },
      });
    }
    return { action: "already_stopped", cleanedPids: [], status };
  }

  const cleaned = await stopProcesses(stoppable, opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
  if (state) {
    writeControllerServiceState(repoRoot, {
      ...state,
      updatedAt: nowIso(),
      status: "stopped",
      supervisor: {
        ...state.supervisor,
        pid: undefined,
        stoppedAt: nowIso(),
      },
      localController: {
        ...state.localController,
        pid: undefined,
        stoppedAt: nowIso(),
      },
    });
  }
  return {
    action: "stopped",
    cleanedPids: cleaned,
    status: await controllerServiceStatus({ repo: repoRoot, logFile: config.logPath }),
  };
}

export async function restartControllerService(opts: ControllerServiceOptions = {}): Promise<ControllerServiceActionResult> {
  const stopped = await stopControllerService(opts);
  const started = await startControllerService(opts);
  return {
    action: "restarted",
    cleanedPids: [...stopped.cleanedPids, ...started.cleanedPids],
    status: started.status,
  };
}

export async function controllerServiceLogs(opts: ControllerServiceOptions & { tail?: number } = {}): Promise<ControllerServiceLogsResult> {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? ".");
  const logPath = resolveServiceConfig(repoRoot, opts.logFile).logPath;
  return {
    logPath,
    text: readLogTail(logPath, Math.max(1_000, (opts.tail ?? 200) * 200)),
  };
}

export function formatControllerServiceStatus(status: ControllerServiceStatus): string {
  const lines = [
    `Controller stack: ${status.running ? "running" : "not running"}`,
    `Repo: ${status.repoRoot}`,
    `Version: ${status.packageVersion}${status.bunVersion ? ` (Bun ${status.bunVersion})` : ""}`,
    `Supervisor: ${status.supervisor.alive ? `pid=${status.supervisor.pid}` : status.supervisor.pid ? `stale pid=${status.supervisor.pid}` : "not running"}`,
    `Controller daemon: ${status.daemon.status}${status.daemon.pid ? ` pid=${status.daemon.pid}` : ""}`,
    `MCP: port=${status.ports.mcp} health=${status.health.mcp ? "ok" : status.ports.mcpReachable ? "conflict" : "down"}`,
    `Local Controller: port=${status.ports.localController} health=${status.health.localController ? "ok" : status.ports.localControllerReachable ? "conflict" : "down"}`,
    `Log: ${status.logPath}`,
  ];
  if (status.warnings.length > 0) lines.push("", ...status.warnings.map((line) => `warning: ${line}`));
  if (status.problems.length > 0) lines.push("", ...status.problems.map((line) => `problem: ${line}`));
  return lines.join("\n");
}
