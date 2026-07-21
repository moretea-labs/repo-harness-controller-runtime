import { spawn } from "child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "fs";
import { createConnection } from "net";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { listAgentJobs, reconcileAgentJobs } from "../agent-jobs/job-manager";
import { bootoutRepoLaunchAgents, findRepoLaunchAgents } from "./launch-agents";
import { ensureSlotHome, readActiveSlotAuthority } from "./runtime-slots";
import { CONTROLLER_LIFECYCLE_OWNER_ENV } from "./lifecycle-authority";
import { listLocalBridgeJobs, loadLocalBridgeConfig, reconcileLocalBridgeJobs } from "../local-bridge/job-store";
import {
  loadMcpLocalConfig,
  loadMcpRuntimeState,
  loadMcpServiceLocalConfig,
  loadMcpServiceRuntimeState,
  mcpControllerHomeLocalConfigPath,
  mcpControllerHomeRuntimeStatePath,
  mcpRuntimeStatePath,
  resolveMcpRuntimeAuthority,
  type McpRuntimeAuthority,
  type McpRuntimeState,
} from "../mcp/auth";
import { inferMcpTunnelMode, isExpectedLocalControllerHealth, normalizeKeepalivePublicEndpoint, resolveSelfCliInvocation } from "../mcp/keepalive";
import { withDirectNetworkProxyBypass } from "../mcp/proxy-env";
import { resolveMcpRepoRoot } from "../mcp/repo";
import { resolveRepoPreferredControllerHome } from "../repositories/controller-home";
import { loadRepositoryRegistry } from "../repositories/registry";
import { listActiveExecutionJobs } from "../../runtime/execution/jobs/store";
import { listRepositories } from "../repositories/registry";
import { runProcess } from "../../effects/process-runner";
import { ensureControllerDaemon, readControllerDaemonStatus, type ControllerDaemonStatus } from "../../runtime/control-plane/daemon-client";
import {
  CONTROLLER_RUNTIME_SOURCE_ROOT_ENV,
  evaluateActiveRuntimeSourceDrift,
  readRuntimeGeneration,
  resolveControllerRuntimeSourceRoot,
  type RuntimeSourceIdentity,
} from "../../runtime/control-plane/runtime-generation";
import { projectionBlocksReadiness, readRepositoryProjectionSnapshot } from "../../runtime/projections/materialized-view";
import { projectionObservation } from "../../runtime/projections/materialized-view";
import { readSchedulerHealthSnapshot } from "../../runtime/control-plane/global-scheduler/scheduler";
import { evaluateRuntimeHealth, type RuntimeHealthEvaluation } from "../../runtime/health";
import { isProcessAlive, terminateProcessTree } from "../../runtime/shared/process-tree";
import { launchStableSupervisor, readStableSupervisorState, stableSupervisorIsAlive, stopStableSupervisor } from "../../runtime/supervisor/bridge";
import { isStableSupervisorInstalled, supervisorLogPath } from "../../runtime/supervisor/paths";
import { startRegisteredSupervisorService } from "../../runtime/supervisor/installer";

const DEFAULT_START_TIMEOUT_MS = 60_000;
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
    tunnelMode: "none" | "quick" | "named" | "tailscale";
    publicEndpoint?: string;
  };
}

export interface ControllerServiceProcess {
  pid: number;
  command: string;
  kind:
    | "supervisor"
    | "mcp-keepalive"
    | "mcp-serve"
    | "local-controller"
    | "controller-daemon"
    | "tunnel-supervisor"
    | "tunnel-worker"
    | "tunnel-client"
    | "unknown";
}

export interface ControllerServiceHealth {
  mcp: boolean;
  localController: boolean;
}

export interface ControllerServiceReadiness {
  gateway: boolean;
  daemon: boolean;
  scheduler: boolean;
  localController: boolean;
  projection: boolean;
  public: boolean;
  connector: boolean;
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
  ready: boolean;
  readiness: ControllerServiceReadiness;
  restartRequired: boolean;
  restartReasons: string[];
  runtimeGeneration?: string;
  runtimeSource?: RuntimeSourceIdentity;
  supervisor: {
    pid?: number;
    alive: boolean;
    staleState: boolean;
  };
  daemon: ControllerDaemonStatus;
  mcpRuntime: McpRuntimeState | null;
  health: ControllerServiceHealth;
  /** Shared semantic evaluation; legacy boolean health fields remain compatible. */
  healthEvaluation?: RuntimeHealthEvaluation;
  ports: {
    mcp: number;
    localController: number;
    mcpReachable: boolean;
    localControllerReachable: boolean;
    mcpOwners: string[];
    localControllerOwners: string[];
  };
  authority: {
    localConfig: McpRuntimeAuthority;
    runtimeState: McpRuntimeAuthority;
  };
  orphanedProcesses: ControllerServiceProcess[];
  infos: string[];
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
  controllerHome?: string;
  logFile?: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Internal lifecycle control: detached coordinators protect only themselves, not the old managed ancestry. */
  protectCallerAncestry?: boolean;
  /** Internal lifecycle control: require every managed stack process to be gone before startup continues. */
  requireFullStop?: boolean;
  /** Internal blue/green control: manage only slot-local legacy processes, never the root Stable Supervisor. */
  slotLocalLifecycle?: boolean;
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

export function controllerServiceStatePath(repoRoot: string, controllerHome?: string): string {
  // Prefer controllerHome so blue/green slots never overwrite each other's
  // supervisor PID/state. Legacy repo-local path remains the fallback.
  if (controllerHome?.trim()) {
    return join(resolve(controllerHome.trim()), "lifecycle", "controller-service.json");
  }
  return join(repoRoot, ".ai", "local", "state", "controller-service.json");
}

export function defaultControllerServiceLogPath(repoRoot: string, controllerHome?: string): string {
  if (controllerHome?.trim()) {
    return join(resolve(controllerHome.trim()), "logs", "repo-harness-controller.log");
  }
  return join(repoRoot, ".ai", "local", "logs", "repo-harness-controller.log");
}

function writeControllerServiceState(
  repoRoot: string,
  state: ControllerServiceState,
  controllerHome?: string,
): ControllerServiceState {
  const path = controllerServiceStatePath(repoRoot, controllerHome ?? state.controllerHome);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  return state;
}

export function loadControllerServiceState(repoRoot: string, controllerHome?: string): ControllerServiceState | null {
  const candidates = [
    controllerHome ? controllerServiceStatePath(repoRoot, controllerHome) : null,
    controllerServiceStatePath(repoRoot),
  ].filter((value): value is string => Boolean(value));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as ControllerServiceState;
      if (controllerHome && parsed.controllerHome && resolve(parsed.controllerHome) !== resolve(controllerHome)) {
        continue;
      }
      return parsed;
    } catch (_error) {
      // try next candidate
    }
  }
  return null;
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

function processCommandLine(pid: number | undefined): string | undefined {
  if (!pid || pid <= 0 || !isPidAlive(pid)) return undefined;
  const result = runProcess("ps", ["-o", "command=", "-p", String(pid)], {
    timeoutMs: 1_000,
    maxOutputBytes: 16 * 1024,
  });
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

function processMatchesRepoHarness(
  commandLine: string,
  repoRoot: string,
  controllerHome?: string,
): boolean {
  const isHarness = commandLine.includes("repo-harness")
    || commandLine.includes("/src/cli/index.ts")
    || commandLine.includes("/scripts/controller-runtime.sh")
    || commandLine.includes("daemon-entry.ts");
  if (!isHarness) return false;
  // Prefer controllerHome so blue/green slots that share a repo root do not
  // claim each other's managed processes during stop/restart.
  if (controllerHome) {
    if (commandLine.includes(controllerHome)) return true;
    // Never claim a process that is explicitly bound to a different controller home.
    if (commandLine.includes("--controller-home") && !commandLine.includes(controllerHome)) {
      return false;
    }
    // When a dedicated controllerHome is provided (slot or explicit), do not fall
    // back to repo-root matching. Shared-repo blue/green would otherwise cross-kill.
    return false;
  }
  return commandLine.includes(repoRoot);
}

function detectProcessKind(commandLine: string): ControllerServiceProcess["kind"] {
  if (commandLine.includes("mcp keepalive")) return "mcp-keepalive";
  if (commandLine.includes("mcp serve")) return "mcp-serve";
  if (commandLine.includes("controller service")) return "supervisor";
  if (commandLine.includes("controller ui")) return "local-controller";
  if (commandLine.includes("daemon-entry.ts")) return "controller-daemon";
  if (commandLine.includes("controller-ngrok-rotation.sh supervise")) return "tunnel-supervisor";
  if (commandLine.includes("controller-ngrok-rotation.sh run-once")) return "tunnel-worker";
  if (commandLine.includes("ngrok http ")) return "tunnel-client";
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

function trackedActiveChildProcessPids(repoRoot: string, controllerHome: string): Set<number> {
  const tracked = new Set<number>();
  const add = (pid: number | undefined) => {
    if (Number.isInteger(pid) && Number(pid) > 0) tracked.add(Number(pid));
  };
  for (const run of listAgentJobs(repoRoot, 200)) {
    if (!["queued", "starting", "running"].includes(run.status)) continue;
    add(run.launchPid);
    add(run.workerPid);
    add(run.agentPid);
  }
  for (const job of listLocalBridgeJobs(repoRoot, 200)) {
    if (!["pending_approval", "approved", "running", "dispatched"].includes(job.status)) continue;
    add(job.ownerPid);
    add(job.workerPid);
  }
  const normalizedRoot = repoRoot.replace(/\\/g, "/");
  const repository = loadRepositoryRegistry(controllerHome).repositories.find((entry) =>
    entry.canonicalRoot.replace(/\\/g, "/") === normalizedRoot
  );
  if (repository) {
    for (const job of listActiveExecutionJobs(controllerHome, repository.repoId)) add(job.workerPid);
  }
  return tracked;
}

export function classifyDetachedControllerServiceProcesses(
  processes: ControllerServiceProcess[],
  opts: {
    supervisorAlive: boolean;
    supervisorPid?: number;
    trackedChildPids?: Set<number>;
  },
): ControllerServiceProcess[] {
  const trackedChildPids = opts.trackedChildPids ?? new Set<number>();
  return opts.supervisorAlive
    ? processes.filter((entry) =>
      entry.kind !== "controller-daemon"
      && entry.kind !== "mcp-serve"
      && entry.kind !== "local-controller"
      && entry.kind !== "tunnel-supervisor"
      && entry.kind !== "tunnel-worker"
      && entry.kind !== "tunnel-client"
      && entry.pid !== opts.supervisorPid
      && !trackedChildPids.has(entry.pid))
    : processes.filter((entry) =>
      entry.kind !== "controller-daemon"
      && !trackedChildPids.has(entry.pid));
}

const MANAGED_CONTROLLER_PROCESS_KINDS = new Set<ControllerServiceProcess["kind"]>([
  "supervisor",
  "mcp-keepalive",
  "mcp-serve",
  "local-controller",
  "controller-daemon",
  "tunnel-supervisor",
  "tunnel-worker",
  "tunnel-client",
]);

function collectControllerServiceProcesses(
  repoRoot: string,
  state: ControllerServiceState | null,
  controllerHome: string,
  options: Pick<ControllerServiceOptions, "protectCallerAncestry"> = {},
): ControllerServiceProcess[] {
  const seen = new Map<number, ControllerServiceProcess>();
  const protectedPids = options.protectCallerAncestry === false
    ? new Set<number>([process.pid])
    : currentProcessAncestry();
  for (const pid of trackedActiveChildProcessPids(repoRoot, controllerHome)) protectedPids.add(pid);
  const add = (pid: number | undefined, command: string, kind: ControllerServiceProcess["kind"]) => {
    if (!pid || pid <= 0 || protectedPids.has(pid) || !isPidAlive(pid)) return;
    if (!seen.has(pid)) seen.set(pid, { pid, command, kind });
  };
  const addRecorded = (pid: number | undefined, kind: ControllerServiceProcess["kind"]) => {
    const commandLine = processCommandLine(pid);
    if (!commandLine || !processMatchesRepoHarness(commandLine, repoRoot, controllerHome)) return;
    add(pid, commandLine, kind);
  };

  // Only trust state PIDs when the recorded controllerHome matches this slot.
  const stateOwnsHome = !state?.controllerHome
    || resolve(state.controllerHome) === resolve(controllerHome);
  if (stateOwnsHome) {
    addRecorded(state?.supervisor.pid, "supervisor");
    addRecorded(state?.localController?.pid, "local-controller");
  }
  const serviceRuntime = loadMcpServiceRuntimeState(controllerHome, repoRoot);
  // Slot homes must only adopt controller-home runtime PIDs. Falling back to
  // repo-local runtime would let one slot stop another slot's gateway.
  if (serviceRuntime) {
    addRecorded(serviceRuntime.server.pid, "mcp-serve");
    addRecorded(serviceRuntime.localController?.pid, "local-controller");
    addRecorded(serviceRuntime.tunnel?.pid, "unknown");
  } else if (stateOwnsHome) {
    const legacyRuntime = loadMcpRuntimeState(repoRoot);
    addRecorded(legacyRuntime?.server.pid, "mcp-serve");
    addRecorded(legacyRuntime?.localController?.pid, "local-controller");
    addRecorded(legacyRuntime?.tunnel?.pid, "unknown");
  }
  const daemon = readControllerDaemonStatus(controllerHome);
  addRecorded(daemon.pid, "controller-daemon");

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
    if (!processMatchesRepoHarness(commandLine, repoRoot, controllerHome)) continue;
    add(pid, commandLine, detectProcessKind(commandLine));
  }
  return Array.from(seen.values()).sort((a, b) => a.pid - b.pid);
}

function resolveServiceConfig(repoRoot: string, explicitLogFile?: string, explicitControllerHome?: string): {
  repoRoot: string;
  controllerHome: string;
  packageVersion: string;
  mcpHost: string;
  mcpPort: number;
  localControllerHost: string;
  localControllerPort: number;
  localControllerEnabled: boolean;
  allowLanMobileIntents: boolean;
  tunnelMode: "none" | "quick" | "named" | "tailscale";
  publicEndpoint?: string;
  toolset: "core" | "advanced" | "full";
  profile: string;
  authMode: string;
  enableDevRunner: boolean;
  devRunnerAgents: string[];
  devRunnerTimeoutMs?: number;
  devRunnerMaxTimeoutMs?: number;
  logPath: string;
} {
  const controllerHome = resolveRepoPreferredControllerHome(repoRoot, explicitControllerHome);
  const localConfig = loadMcpServiceLocalConfig(controllerHome, repoRoot) ?? loadMcpLocalConfig(repoRoot);
  const localBridgeConfig = loadLocalBridgeConfig(repoRoot);
  const runtime = loadMcpServiceRuntimeState(controllerHome, repoRoot) ?? loadMcpRuntimeState(repoRoot);
  const publicEndpoint = normalizeKeepalivePublicEndpoint(localConfig?.chatgpt?.endpoint);
  const tunnelMode = publicEndpoint || runtime?.tunnel?.name
    ? inferMcpTunnelMode(runtime?.tunnelMode, publicEndpoint, runtime?.tunnel?.name)
    : "none";
  const toolset = localConfig?.toolset === "full"
    ? "full"
    : localConfig?.toolset === "advanced"
      ? "advanced"
      : "core";
  return {
    repoRoot,
    controllerHome,
    packageVersion: currentPackageVersion(),
    mcpHost: localConfig?.server?.host ?? "127.0.0.1",
    mcpPort: localConfig?.server?.port ?? 8765,
    localControllerHost: localBridgeConfig.host ?? localConfig?.localController?.host ?? "127.0.0.1",
    localControllerPort: localBridgeConfig.port ?? localConfig?.localController?.port ?? 8766,
    localControllerEnabled: localConfig?.localController?.enabled ?? true,
    allowLanMobileIntents: localBridgeConfig.allowLanMobileIntents === true,
    tunnelMode,
    publicEndpoint,
    toolset,
    profile: localConfig?.profile ?? "controller",
    authMode: localConfig?.auth?.mode === "bearer" ? "bearer" : "oauth",
    enableDevRunner: localConfig?.devMode?.agentRunner === true,
    devRunnerAgents: localConfig?.devMode?.allowedAgents ?? ["codex"],
    devRunnerTimeoutMs: localConfig?.devMode?.timeoutMs,
    devRunnerMaxTimeoutMs: localConfig?.devMode?.maxTimeoutMs,
    logPath: resolve(explicitLogFile ?? defaultControllerServiceLogPath(repoRoot, controllerHome)),
  };
}

export function buildControllerServiceEnv(
  controllerHome: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const runtimeSource = resolveControllerRuntimeSourceRoot({ env: baseEnv });
  return {
    ...withDirectNetworkProxyBypass(baseEnv),
    REPO_HARNESS_CONTROLLER_HOME: controllerHome,
    // Single Controller lifecycle owns Gateway/Local UI/tunnel/daemon children.
    [CONTROLLER_LIFECYCLE_OWNER_ENV]: '1',
    // Pin Controller Runtime Source for daemon/keepalive children so ambient
    // execution-repository cwd cannot redefine generation identity.
    ...(runtimeSource.root
      ? { [CONTROLLER_RUNTIME_SOURCE_ROOT_ENV]: runtimeSource.root }
      : {}),
  };
}

async function healthSummary(
  repoRoot: string,
  host: string,
  mcpPort: number,
  localControllerHost: string,
  localControllerPort: number,
  generation?: string,
): Promise<{
  health: ControllerServiceHealth;
  mcpReachable: boolean;
  localControllerReachable: boolean;
  localControllerPayload: Record<string, unknown> | null;
}> {
  const [mcpHealth, localControllerHealth, mcpReachable, localControllerReachable] = await Promise.all([
    jsonHealth(localMcpHealthUrl(host, mcpPort)),
    jsonHealth(localControllerHealthUrl(localControllerHost, localControllerPort)),
    portReachable(host, mcpPort),
    portReachable(localControllerHost, localControllerPort),
  ]);
  return {
    health: {
      mcp: mcpHealth?.status === "ok"
        && (!generation || mcpHealth.generation === generation),
      localController: isExpectedLocalControllerHealth(localControllerHealth, { repoRoot, generation }),
    },
    mcpReachable,
    localControllerReachable,
    localControllerPayload: localControllerHealth,
  };
}

function adoptedRepo(repoRoot: string): boolean {
  return existsSync(join(repoRoot, ".ai", "harness", "policy.json")) || existsSync(join(repoRoot, "tasks", "current.md"));
}

function summarizeLegacyMcpConfigMismatch(repoRoot: string, controllerHome: string): string[] {
  const legacy = loadMcpLocalConfig(repoRoot);
  const service = loadMcpServiceLocalConfig(controllerHome, repoRoot);
  if (!legacy || !service) return [];

  const mismatches: string[] = [];
  if ((legacy.toolset ?? "core") !== (service.toolset ?? "core")) {
    mismatches.push(`toolset legacy=${legacy.toolset ?? "core"} service=${service.toolset ?? "core"}`);
  }
  if ((legacy.chatgpt?.endpoint ?? "") !== (service.chatgpt?.endpoint ?? "")) {
    mismatches.push("chatgpt.endpoint");
  }
  if ((legacy.server?.host ?? "127.0.0.1") !== (service.server?.host ?? "127.0.0.1")) {
    mismatches.push("server.host");
  }
  if ((legacy.server?.port ?? 8765) !== (service.server?.port ?? 8765)) {
    mismatches.push("server.port");
  }
  if ((legacy.localController?.port ?? 8766) !== (service.localController?.port ?? 8766)) {
    mismatches.push("localController.port");
  }
  if ((legacy.devMode?.timeoutMs ?? 0) !== (service.devMode?.timeoutMs ?? 0)) {
    mismatches.push("devMode.timeoutMs");
  }
  if ((legacy.devMode?.maxTimeoutMs ?? 0) !== (service.devMode?.maxTimeoutMs ?? 0)) {
    mismatches.push("devMode.maxTimeoutMs");
  }
  const legacyAgents = (legacy.devMode?.allowedAgents ?? []).join(",");
  const serviceAgents = (service.devMode?.allowedAgents ?? []).join(",");
  if (legacyAgents !== serviceAgents) {
    mismatches.push("devMode.allowedAgents");
  }
  if (mismatches.length === 0) return [];
  return [
    `Legacy repo-local MCP config diverges from controllerHome (${mismatches.join(", ")}). Controller Home is authoritative; avoid reading or editing .repo-harness/mcp.* for live status.`,
  ];
}

function controllerHomeConfigAuthoritative(controllerHome: string): boolean {
  return existsSync(mcpControllerHomeLocalConfigPath(controllerHome));
}

export async function controllerServiceStatus(opts: ControllerServiceOptions = {}): Promise<ControllerServiceStatus> {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? ".");
  const config = resolveServiceConfig(repoRoot, opts.logFile, opts.controllerHome);
  const state = loadControllerServiceState(repoRoot, config.controllerHome);
  const stableInstalled = !opts.slotLocalLifecycle && isStableSupervisorInstalled(config.controllerHome);
  const stableState = stableInstalled ? readStableSupervisorState(config.controllerHome) : null;
  // Stable Supervisor is controller-scoped, but its live Daemon/Gateway state is
  // slot-local. Status must follow the managed active component home instead of
  // reading stale or absent runtime files from the root Controller Home.
  const runtimeHome = stableInstalled
    ? stableState?.controllerDaemon?.controllerHome
      ?? stableState?.gatewayHost?.controllerHome
      ?? ensureSlotHome(config.controllerHome, readActiveSlotAuthority(config.controllerHome).activeSlot)
    : config.controllerHome;
  // Never fall back to shared repo-local MCP runtime when a dedicated controllerHome
  // is in use — blue/green slots would otherwise claim each other's PIDs/health.
  const serviceRuntime = loadMcpServiceRuntimeState(runtimeHome, repoRoot);
  const runtime = serviceRuntime
    ?? (opts.controllerHome ? null : loadMcpRuntimeState(repoRoot));
  const authority = {
    localConfig: resolveMcpRuntimeAuthority(runtimeHome, repoRoot, "local-config"),
    runtimeState: resolveMcpRuntimeAuthority(runtimeHome, repoRoot, "runtime-state"),
  };
  const runtimeGeneration = readRuntimeGeneration(runtimeHome);
  // Drift compares startup Runtime Source against the Controller package authority.
  // opts.repo / execution repository root is never used as "current" runtime source.
  const sourceDrift = evaluateActiveRuntimeSourceDrift(runtimeGeneration?.source);
  const runtimeStatePath = serviceRuntime
    ? mcpControllerHomeRuntimeStatePath(runtimeHome)
    : mcpRuntimeStatePath(repoRoot);
  const supervisorPid = stableState?.supervisor.pid ?? state?.supervisor.pid ?? runtime?.server.pid;
  const supervisorAlive = stableInstalled
    ? stableSupervisorIsAlive(config.controllerHome, stableState)
    : isPidAlive(supervisorPid);
  const daemon = readControllerDaemonStatus(runtimeHome);
  const ports = await healthSummary(
    repoRoot,
    config.mcpHost,
    config.mcpPort,
    config.localControllerHost,
    config.localControllerPort,
    runtimeGeneration?.generation,
  );
  const repositories = listRepositories(runtimeHome)
    .filter((repository) => repository.enabled && !repository.removedAt);
  const projectionSnapshots = repositories.map((repository) => ({
    repoId: repository.repoId,
    snapshot: readRepositoryProjectionSnapshot(runtimeHome, repository.repoId),
  }));
  const staleProjectionRepos = projectionSnapshots
    .filter(({ snapshot }) => snapshot.stale)
    .map(({ repoId }) => repoId);
  const blockingStaleProjectionRepos = projectionSnapshots
    .filter(({ snapshot }) => projectionBlocksReadiness(snapshot))
    .map(({ repoId }) => repoId);
  const scheduler = readSchedulerHealthSnapshot(runtimeHome);
  const schedulerHeartbeatAgeMs = scheduler.lastTickAt
    ? Math.max(0, Date.now() - Date.parse(scheduler.lastTickAt))
    : undefined;
  const schedulerDispatchHeartbeatAgeMs = scheduler.lastDispatchAt
    ? Math.max(0, Date.now() - Date.parse(scheduler.lastDispatchAt))
    : undefined;
  const projectionObservations = projectionSnapshots.map(({ snapshot }) => projectionObservation(snapshot));
  const projectionHealth = projectionObservations.length === 0
    ? {
      readable: true,
      persisted: true,
      producerHealthy: daemon.status === "ready" && daemon.degraded !== true,
    }
    : {
      readable: projectionObservations.every((observation) => observation.readable),
      persisted: projectionObservations.every((observation) => observation.persisted),
      dirty: projectionObservations.some((observation) => observation.dirty),
      sourceRevisionChanged: projectionObservations.some((observation) => observation.sourceRevisionChanged),
      refreshPending: projectionObservations.some((observation) => observation.refreshPending),
      refreshGraceElapsed: projectionObservations.some((observation) => observation.refreshGraceElapsed),
      activeInvariantAtRisk: projectionObservations.some((observation) => observation.activeInvariantAtRisk),
      producerHealthy: daemon.status === "ready" && daemon.degraded !== true,
    };
  const healthEvaluation = evaluateRuntimeHealth({
    daemon: {
      status: daemon.status,
      error: daemon.error,
      // The durable scheduler loop runs inside the Controller Daemon process.
      // Its last tick is the authoritative live daemon heartbeat.
      heartbeatAgeMs: schedulerHeartbeatAgeMs,
    },
    scheduler: {
      status: daemon.degraded ? "degraded" : daemon.status,
      heartbeatAgeMs: schedulerHeartbeatAgeMs,
      dispatchHeartbeatAgeMs: schedulerDispatchHeartbeatAgeMs,
    },
    workers: {
      queueDepth: projectionSnapshots.reduce((sum, { snapshot }) => sum + snapshot.projection.queueDepth, 0),
      runningWorkers: projectionSnapshots.reduce((sum, { snapshot }) => sum + snapshot.projection.runningWorkers, 0),
      activeLeases: projectionSnapshots.reduce((sum, { snapshot }) => sum + snapshot.projection.activeLeases, 0),
      activeAttentionCount: projectionSnapshots.reduce((sum, { snapshot }) => sum + snapshot.projection.currentAttention.length, 0),
    },
    projection: projectionHealth,
    localBridge: {
      enabled: config.localControllerEnabled,
      requiredForReadiness: config.localControllerEnabled,
      mode: config.localControllerEnabled ? runtime?.localController?.mode ?? "standalone" : "disabled",
      endpoint: localControllerHealthUrl(config.localControllerHost, config.localControllerPort),
      endpointReachable: ports.localControllerReachable,
      expectedSurface: ports.health.localController,
      generationMatches: runtimeGeneration?.generation
        ? ports.localControllerPayload?.generation === runtimeGeneration.generation
        : undefined,
      processAlive: runtime?.localController?.running,
      runtimeStateFresh: runtime?.localController !== undefined,
    },
    runtimeStorage: { readable: true, ready: true },
  });
  const processes = collectControllerServiceProcesses(repoRoot, state, config.controllerHome);
  const trackedChildPids = trackedActiveChildProcessPids(repoRoot, runtimeHome);
  const orphanedProcesses = classifyDetachedControllerServiceProcesses(processes, {
    supervisorAlive,
    supervisorPid: state?.supervisor.pid,
    trackedChildPids,
  });
  const infos: string[] = [];
  const warnings: string[] = [];
  const problems: string[] = [];
  const restartReasons = [...sourceDrift.reasons];
  const publicReady = !runtime?.tunnel?.publicEndpoint || runtime?.tunnel?.healthy === true;
  const connectorReady = !runtime?.tunnel?.publicEndpoint || (
    publicReady
    && runtime?.tunnel?.connectorNeedsReconnect !== true
    && (!runtimeGeneration?.generation || runtime?.generation === runtimeGeneration.generation)
    && (!runtimeGeneration?.generation || runtime?.server.generation === runtimeGeneration.generation)
  );
  const projectionReady = healthEvaluation.components.projection.ready;
  const readiness: ControllerServiceReadiness = {
    gateway: ports.health.mcp,
    daemon: healthEvaluation.components.daemon.ready,
    scheduler: healthEvaluation.components.scheduler.ready,
    localController: healthEvaluation.components.localBridge.ready,
    projection: projectionReady,
    public: publicReady,
    connector: connectorReady,
  };
  const ready = supervisorAlive
    && readiness.gateway
    && readiness.daemon
    && readiness.scheduler
    && readiness.localController
    && readiness.projection;

  if (!process.versions.bun) warnings.push("Bun runtime is not active; start and restart commands require `bun`.");
  if (!adoptedRepo(repoRoot)) warnings.push("Repository does not look adopted yet (`.ai/harness/policy.json` or `tasks/current.md` missing).");
  if (state?.packageVersion && state.packageVersion !== config.packageVersion) {
    warnings.push(`Lifecycle state was started by repo-harness ${state.packageVersion}; current CLI is ${config.packageVersion}. Use restart to refresh the stack.`);
  }
  const legacyConfigDivergence = summarizeLegacyMcpConfigMismatch(repoRoot, config.controllerHome);
  if (authority.localConfig.warning) warnings.push(authority.localConfig.warning);
  if (authority.runtimeState.warning) warnings.push(authority.runtimeState.warning);
  if (legacyConfigDivergence.length > 0) {
    (controllerHomeConfigAuthoritative(config.controllerHome) ? infos : warnings).push(...legacyConfigDivergence);
  }
  if (sourceDrift.restartRequired) warnings.push(...sourceDrift.reasons.map((reason) => `restart required: ${reason}`));
  if ((stableState?.supervisor.pid ?? state?.supervisor.pid) && !supervisorAlive) problems.push(`Supervisor PID ${stableState?.supervisor.pid ?? state?.supervisor.pid} is no longer alive; a previous start likely exited unexpectedly.`);
  if (ports.mcpReachable && !ports.health.mcp) {
    problems.push(`MCP port ${config.mcpPort} is in use but /health is not reporting a healthy repo-harness surface.`);
  }
  if (ports.localControllerReachable && !ports.health.localController) {
    problems.push(`Local Controller port ${config.localControllerPort} is in use but /health is not reporting the expected local-only controller surface.`);
  }
  if (daemon.status === "failed" || daemon.degraded) problems.push(`Controller daemon is unhealthy: ${daemon.error ?? "unknown error"}`);
  if (runtime?.server.healthMismatch) problems.push(`MCP runtime generation/tool surface mismatch: ${runtime.server.healthMismatch}`);
  if (!projectionReady) problems.push(`Runtime projection is stale for ${blockingStaleProjectionRepos.join(", ") || "active runtime state"}.`);
  if (staleProjectionRepos.length > 0 && blockingStaleProjectionRepos.length === 0) {
    infos.push(`Ignoring stale idle runtime projections for ${staleProjectionRepos.join(", ")}.`);
  }
  if (!connectorReady && runtime?.tunnel?.publicEndpoint) problems.push("Connector readiness is stale; public endpoint changed or generation drifted.");
  if (orphanedProcesses.length > 0) warnings.push(`Detected ${orphanedProcesses.length} detached repo-harness process(es) outside the tracked supervisor.`);

  return {
    repoRoot,
    packageVersion: config.packageVersion,
    bunVersion: process.versions.bun ?? null,
    controllerHome: config.controllerHome,
    adopted: adoptedRepo(repoRoot),
    serviceStatePath: controllerServiceStatePath(repoRoot, config.controllerHome),
    runtimeStatePath,
    logPath: stableInstalled ? supervisorLogPath(config.controllerHome) : config.logPath,
    running: supervisorAlive && ports.health.mcp && (!config.localControllerEnabled || ports.health.localController),
    ready,
    readiness,
    restartRequired: sourceDrift.restartRequired,
    restartReasons,
    runtimeGeneration: runtimeGeneration?.generation,
    runtimeSource: runtimeGeneration?.source,
    supervisor: {
      pid: supervisorPid,
      alive: supervisorAlive,
      staleState: Boolean(supervisorPid && !supervisorAlive),
    },
    daemon,
    mcpRuntime: runtime,
    health: ports.health,
    healthEvaluation,
    ports: {
      mcp: config.mcpPort,
      localController: config.localControllerPort,
      mcpReachable: ports.mcpReachable,
      localControllerReachable: ports.localControllerReachable,
      mcpOwners: listPortOwners(config.mcpPort),
      localControllerOwners: listPortOwners(config.localControllerPort),
    },
    authority,
    orphanedProcesses,
    infos,
    warnings,
    problems,
  };
}

async function waitForHealthyStart(
  repoRoot: string,
  timeoutMs: number,
  logPath: string,
  controllerHome: string,
  slotLocalLifecycle = false,
): Promise<ControllerServiceStatus> {
  const deadline = Date.now() + Math.max(2_000, timeoutMs);
  let latest = await controllerServiceStatus({ repo: repoRoot, logFile: logPath, controllerHome, slotLocalLifecycle });
  while (Date.now() < deadline) {
    if (latest.ready && latest.supervisor.alive) return latest;
    await sleep(HEALTH_POLL_INTERVAL_MS);
    latest = await controllerServiceStatus({ repo: repoRoot, logFile: logPath, controllerHome, slotLocalLifecycle });
  }
  const tail = readLogTail(logPath);
  const lines = [
    `Controller stack did not become healthy within ${timeoutMs}ms.`,
    `Gateway health: ${latest.health.mcp ? "ok" : "not ready"}`,
    `Local Controller health: ${latest.health.localController ? "ok" : "not ready"}`,
    `Ready state: ${latest.ready ? "ok" : "recovering/degraded"}`,
    `Daemon state: ${latest.daemon.status}${latest.daemon.degraded ? " (degraded)" : ""}`,
    `Runtime projection: ${latest.readiness.projection ? "ready" : "recovering/stale"}`,
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

function spawnDetached(
  command: string,
  args: string[],
  cwd: string,
  logPath: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  try {
    const child = spawn(command, args, {
      cwd,
      env,
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
  const config = resolveServiceConfig(repoRoot, opts.logFile, opts.controllerHome);
  let status = await controllerServiceStatus({
    repo: repoRoot,
    logFile: config.logPath,
    controllerHome: config.controllerHome,
    slotLocalLifecycle: opts.slotLocalLifecycle,
  });
  if (status.running && status.supervisor.alive) {
    return { action: "already_running", cleanedPids: [], status };
  }

  if (!opts.slotLocalLifecycle && isStableSupervisorInstalled(config.controllerHome)) {
    let cleaned: number[] = [];
    const stableState = readStableSupervisorState(config.controllerHome);
    if (status.supervisor.alive || stableState?.desiredState === 'running' || status.orphanedProcesses.length > 0) {
      cleaned = (await stopControllerService({
        repo: repoRoot,
        controllerHome: config.controllerHome,
        logFile: config.logPath,
        stopTimeoutMs: opts.stopTimeoutMs,
        protectCallerAncestry: opts.protectCallerAncestry,
        requireFullStop: opts.requireFullStop,
        slotLocalLifecycle: opts.slotLocalLifecycle,
      })).cleanedPids;
      status = await controllerServiceStatus({
        repo: repoRoot,
        logFile: config.logPath,
        controllerHome: config.controllerHome,
        slotLocalLifecycle: opts.slotLocalLifecycle,
      });
    }
    ensureStartableStatus(status);
    const launchAgents = findRepoLaunchAgents(repoRoot);
    if (launchAgents.length > 0) bootoutRepoLaunchAgents(launchAgents);
    const service = startRegisteredSupervisorService(config.controllerHome);
    const launched = service.managed ? undefined : launchStableSupervisor({
      repoRoot,
      controllerHome: config.controllerHome,
      logPath: supervisorLogPath(config.controllerHome),
      controlPort: Number(process.env.REPO_HARNESS_SUPERVISOR_CONTROL_PORT) || undefined,
    });
    writeControllerServiceState(repoRoot, {
      schemaVersion: 1,
      repoRoot,
      packageVersion: config.packageVersion,
      controllerHome: config.controllerHome,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: "running",
      supervisor: { ...(launched?.pid ? { pid: launched.pid } : {}), logPath: supervisorLogPath(config.controllerHome), startedAt: nowIso() },
      config: {
        mcpHost: config.mcpHost,
        mcpPort: config.mcpPort,
        localControllerHost: config.localControllerHost,
        localControllerPort: config.localControllerPort,
        tunnelMode: config.tunnelMode,
        publicEndpoint: config.publicEndpoint,
      },
    }, config.controllerHome);
    const startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    status = await waitForHealthyStart(
      repoRoot,
      startTimeoutMs,
      supervisorLogPath(config.controllerHome),
      config.controllerHome,
      opts.slotLocalLifecycle,
    );
    return { action: "started", cleanedPids: cleaned, status };
  }

  let cleaned: number[] = [];
  // Only stop processes owned by THIS controllerHome. Healthy foreign listeners on
  // the configured ports must refuse start (ensureStartableStatus) instead of being
  // torn down — blue/green slots must never kill each other on port collision.
  const state = loadControllerServiceState(repoRoot, config.controllerHome);
  const ownsTrackedSupervisor = Boolean(
    state?.controllerHome
    && resolve(state.controllerHome) === resolve(config.controllerHome)
    && state.supervisor.pid
    && isPidAlive(state.supervisor.pid),
  );
  const shouldStopOwnStack = ownsTrackedSupervisor
    || status.supervisor.alive
    || status.orphanedProcesses.length > 0;
  if (shouldStopOwnStack) {
    cleaned = (await stopControllerService({
      repo: repoRoot,
      controllerHome: config.controllerHome,
      logFile: config.logPath,
      stopTimeoutMs: opts.stopTimeoutMs,
      protectCallerAncestry: opts.protectCallerAncestry,
      requireFullStop: opts.requireFullStop,
    })).cleanedPids;
    status = await controllerServiceStatus({ repo: repoRoot, logFile: config.logPath, controllerHome: config.controllerHome });
  }

  ensureStartableStatus(status);
  reconcileAgentJobs(repoRoot);
  reconcileLocalBridgeJobs(repoRoot);
  // The lifecycle starts the isolated Daemon before keepalive. Daemon owns the
  // generation rotation; keepalive and Gateway reuse that same record.
  ensureControllerDaemon(config.controllerHome);

  // Legacy per-component LaunchAgents create a second lifecycle owner. Boot them
  // out before starting the single Controller supervisor; they remain readable
  // for migration, but are never bootstrapped by the modern lifecycle.
  const launchAgents = findRepoLaunchAgents(repoRoot);
  if (launchAgents.length > 0) bootoutRepoLaunchAgents(launchAgents);

  const cli = resolveSelfCliInvocation();
  const serviceEnv = buildControllerServiceEnv(config.controllerHome);
  const keepaliveArgs = [
    ...cli.args,
    "mcp",
    "keepalive",
    "--repo",
    repoRoot,
    "--controller-home",
    config.controllerHome,
    "--host",
    config.mcpHost,
    "--port",
    String(config.mcpPort),
    "--profile",
    config.profile,
    "--auth",
    config.authMode,
    "--toolset",
    config.toolset,
    "--local-ui",
    "--local-ui-host",
    config.localControllerHost,
    "--local-ui-port",
    String(config.localControllerPort),
    ...(config.allowLanMobileIntents ? ["--mobile-lan"] : []),
    "--tunnel",
    config.tunnelMode,
  ];
  if (config.enableDevRunner) {
    keepaliveArgs.push("--enable-dev-runner");
    if (config.devRunnerAgents.length > 0) {
      keepaliveArgs.push("--dev-runner-agents", config.devRunnerAgents.join(","));
    }
    if (config.devRunnerTimeoutMs) {
      keepaliveArgs.push("--dev-runner-timeout-ms", String(config.devRunnerTimeoutMs));
    }
    if (config.devRunnerMaxTimeoutMs) {
      keepaliveArgs.push("--dev-runner-max-timeout-ms", String(config.devRunnerMaxTimeoutMs));
    }
  }
  if (config.publicEndpoint) keepaliveArgs.push("--public-endpoint", config.publicEndpoint);
  const pid = spawnDetached(
    cli.command,
    keepaliveArgs,
    repoRoot,
    config.logPath,
    serviceEnv,
  );
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
    // Local UI is hosted inside the supervisor process, so all public Controller
    // surfaces share one lifecycle PID and one runtime generation.
    localController: {
      pid,
      startedAt: nowIso(),
    },
    config: {
      mcpHost: config.mcpHost,
      mcpPort: config.mcpPort,
      localControllerHost: config.localControllerHost,
      localControllerPort: config.localControllerPort,
      tunnelMode: config.tunnelMode,
      publicEndpoint: config.publicEndpoint,
    },
  }, config.controllerHome);

  const configuredStartTimeout = Number(process.env.REPO_HARNESS_CONTROLLER_START_TIMEOUT_MS);
  const startTimeoutMs = opts.startTimeoutMs
    ?? (Number.isFinite(configuredStartTimeout) && configuredStartTimeout >= 2_000 ? Math.trunc(configuredStartTimeout) : DEFAULT_START_TIMEOUT_MS);
  status = await waitForHealthyStart(repoRoot, startTimeoutMs, config.logPath, config.controllerHome, opts.slotLocalLifecycle);
  return { action: "started", cleanedPids: cleaned, status };
}

export async function stopControllerService(opts: ControllerServiceOptions = {}): Promise<ControllerServiceActionResult> {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? ".");
  const config = resolveServiceConfig(repoRoot, opts.logFile, opts.controllerHome);
  const state = loadControllerServiceState(repoRoot, config.controllerHome);
  const status = await controllerServiceStatus({
    repo: repoRoot,
    logFile: config.logPath,
    controllerHome: config.controllerHome,
    slotLocalLifecycle: opts.slotLocalLifecycle,
  });
  if (!opts.slotLocalLifecycle && isStableSupervisorInstalled(config.controllerHome)) {
    const stableState = readStableSupervisorState(config.controllerHome);
    const stableAlive = stableSupervisorIsAlive(config.controllerHome, stableState);
    if (stableAlive || stableState?.desiredState === 'running') {
      const launchAgents = findRepoLaunchAgents(repoRoot);
      if (launchAgents.length > 0) bootoutRepoLaunchAgents(launchAgents);
      const stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
      const stopped = await stopStableSupervisor(config.controllerHome);
      const deadline = Date.now() + stopTimeoutMs;
      while (Date.now() < deadline && stableSupervisorIsAlive(config.controllerHome, readStableSupervisorState(config.controllerHome))) {
        await sleep(PROCESS_STOP_POLL_MS);
      }
      if (!stopped.stopped || stableSupervisorIsAlive(config.controllerHome, readStableSupervisorState(config.controllerHome))) {
        throw new Error('CONTROLLER_STABLE_SUPERVISOR_STOP_INCOMPLETE');
      }

      // A control-socket stop acknowledges before every managed descendant has
      // necessarily released its listener. Sweep only identity-proven
      // repo-harness processes for this Controller Home, then prove the stack is
      // fully gone before a replacement Supervisor is allowed to bind 8765,
      // 8766, or 8770.
      const residual = collectControllerServiceProcesses(repoRoot, state, config.controllerHome, {
        protectCallerAncestry: false,
      }).filter((entry) => MANAGED_CONTROLLER_PROCESS_KINDS.has(entry.kind));
      const residualPids = residual.length > 0
        ? await stopProcesses(residual, stopTimeoutMs)
        : [];
      if (residual.length > 0) await sleep(PROCESS_STOP_POLL_MS);
      const survivors = collectControllerServiceProcesses(repoRoot, state, config.controllerHome, {
        protectCallerAncestry: false,
      }).filter((entry) => MANAGED_CONTROLLER_PROCESS_KINDS.has(entry.kind));
      if (survivors.length > 0) {
        throw new Error(`CONTROLLER_STABLE_FULL_STOP_INCOMPLETE: ${survivors.map((entry) => `${entry.kind}:${entry.pid}`).join(', ')}`);
      }
      if (state) {
        writeControllerServiceState(repoRoot, {
          ...state,
          updatedAt: nowIso(),
          status: "stopped",
          supervisor: { ...state.supervisor, pid: undefined, stoppedAt: nowIso() },
          localController: { ...state.localController, pid: undefined, stoppedAt: nowIso() },
        }, config.controllerHome);
      }
      return {
        action: "stopped",
        cleanedPids: [
          ...(stableState?.supervisor.pid ? [stableState.supervisor.pid] : []),
          ...residualPids,
        ],
        status: await controllerServiceStatus({
          repo: repoRoot,
          logFile: config.logPath,
          controllerHome: config.controllerHome,
          slotLocalLifecycle: opts.slotLocalLifecycle,
        }),
      };
    }
    // A release may have just been installed while the legacy KeepAlive/Daemon
    // still owns this controllerHome. Fall through to the identity-scoped legacy
    // collector so installation performs one real handoff instead of starting a
    // second owner on the same ports.
  }
  const launchAgents = findRepoLaunchAgents(repoRoot);
  if (launchAgents.length > 0) bootoutRepoLaunchAgents(launchAgents);
  const processes = collectControllerServiceProcesses(repoRoot, state, config.controllerHome, opts);
  const stoppable = opts.requireFullStop
    ? processes.filter((entry) => MANAGED_CONTROLLER_PROCESS_KINDS.has(entry.kind))
    : processes.filter((entry) => entry.kind !== "unknown" || entry.command.includes(repoRoot));
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
      }, config.controllerHome);
    }
    return { action: "already_stopped", cleanedPids: [], status };
  }

  const stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const cleaned = await stopProcesses(stoppable, stopTimeoutMs);
  if (opts.requireFullStop) {
    await sleep(PROCESS_STOP_POLL_MS);
    const remaining = collectControllerServiceProcesses(repoRoot, state, config.controllerHome, opts)
      .filter((entry) => MANAGED_CONTROLLER_PROCESS_KINDS.has(entry.kind));
    if (remaining.length > 0) {
      cleaned.push(...await stopProcesses(remaining, stopTimeoutMs));
      await sleep(PROCESS_STOP_POLL_MS);
    }
    const survivors = collectControllerServiceProcesses(repoRoot, state, config.controllerHome, opts)
      .filter((entry) => MANAGED_CONTROLLER_PROCESS_KINDS.has(entry.kind));
    if (survivors.length > 0) {
      throw new Error(`CONTROLLER_FULL_STOP_INCOMPLETE: ${survivors.map((entry) => `${entry.kind}:${entry.pid}`).join(", ")}`);
    }
  }
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
    }, config.controllerHome);
  }
  return {
    action: "stopped",
    cleanedPids: cleaned,
    status: await controllerServiceStatus({
      repo: repoRoot,
      logFile: config.logPath,
      controllerHome: config.controllerHome,
      slotLocalLifecycle: opts.slotLocalLifecycle,
    }),
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
  const logPath = resolveServiceConfig(repoRoot, opts.logFile, opts.controllerHome).logPath;
  return {
    logPath,
    text: readLogTail(logPath, Math.max(1_000, (opts.tail ?? 200) * 200)),
  };
}

export function formatControllerServiceStatus(status: ControllerServiceStatus): string {
  const lines = [
    `Controller stack: ${status.running ? (status.ready ? "running" : "running (degraded)") : "not running"}`,
    `Repo: ${status.repoRoot}`,
    `Version: ${status.packageVersion}${status.bunVersion ? ` (Bun ${status.bunVersion})` : ""}`,
    `Runtime generation: ${status.runtimeGeneration ?? "missing"}`,
    `Runtime authority: ${status.authority.runtimeState.authority} (${status.authority.runtimeState.path})`,
    `Supervisor: ${status.supervisor.alive ? `pid=${status.supervisor.pid}` : status.supervisor.pid ? `stale pid=${status.supervisor.pid}` : "not running"}`,
    `Controller daemon: ${status.daemon.status}${status.daemon.pid ? ` pid=${status.daemon.pid}` : ""}`,
    `MCP: port=${status.ports.mcp} health=${status.health.mcp ? "ok" : status.ports.mcpReachable ? "conflict" : "down"}`,
    `Local Controller: port=${status.ports.localController} health=${status.health.localController ? "ok" : status.ports.localControllerReachable ? "conflict" : "down"}`,
    `Readiness: gateway=${status.readiness.gateway ? "ok" : "down"} daemon=${status.readiness.daemon ? "ok" : "degraded"} projection=${status.readiness.projection ? "ok" : "stale"} connector=${status.readiness.connector ? "ok" : "stale"} public=${status.readiness.public ? "ok" : "stale"}`,
    `Log: ${status.logPath}`,
  ];
  if (status.infos.length > 0) lines.push("", ...status.infos.map((line) => `info: ${line}`));
  if (status.restartRequired) lines.push(`Restart required: ${status.restartReasons.join("; ")}`);
  if (status.warnings.length > 0) lines.push("", ...status.warnings.map((line) => `warning: ${line}`));
  if (status.problems.length > 0) lines.push("", ...status.problems.map((line) => `problem: ${line}`));
  return lines.join("\n");
}
