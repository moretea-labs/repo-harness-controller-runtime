import { randomUUID } from "crypto";
import { spawn } from "child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { runProcess } from "../../effects/process-runner";
import { readControllerDaemonStatus } from "../../runtime/control-plane/daemon-client";
import { isProcessAlive } from "../../runtime/shared/process-tree";
import { loadMcpServiceRuntimeState } from "../mcp/auth";
import { resolveMcpRepoRoot } from "../mcp/repo";
import { resolveRepoPreferredControllerHome } from "../repositories/controller-home";
import {
  controllerServiceStatus,
  loadControllerServiceState,
  restartControllerService,
  startControllerService,
  stopControllerService,
  type ControllerServiceActionResult,
  type ControllerServiceOptions,
  type ControllerServiceStatus,
} from "./lifecycle";

export type ControllerRestartPhase =
  | "scheduled"
  | "coordinator_started"
  | "waiting_for_handoff"
  | "stopping"
  | "starting"
  | "verifying"
  | "succeeded"
  | "failed";

export interface ControllerRestartVerification {
  ok: boolean;
  localMcp: boolean;
  controllerDaemon: boolean;
  localBridge: boolean;
  projection: boolean;
  runtimeSourceCurrent: boolean;
  runtimeGenerationPresent: boolean;
  runtimeGenerationChanged: boolean;
  connectorHealthy: boolean;
  publicConfigured: boolean;
  publicHealth: boolean;
  oauthDiscovery: boolean;
  checkedAt: string;
  failures: string[];
}

export interface ControllerRestartState {
  schemaVersion: 1;
  requestId: string;
  repoRoot: string;
  controllerHome: string;
  phase: ControllerRestartPhase;
  requestedAt: string;
  updatedAt: string;
  requestedBy: string;
  reason?: string;
  delayMs: number;
  launcherPid?: number;
  coordinatorPid?: number;
  previousGeneration?: string;
  runtimeGeneration?: string;
  completedAt?: string;
  verification?: ControllerRestartVerification;
  error?: string;
}

export interface ControllerRestartScheduledResult {
  action: "restart_scheduled";
  accepted: true;
  deduplicated: boolean;
  requestId: string;
  statePath: string;
  logPath: string;
  reconnectContract: "stable_domain_retry";
  state: ControllerRestartState;
}

export type ControllerRestartRequestResult = ControllerServiceActionResult | ControllerRestartScheduledResult;

export interface ControllerRestartRequestOptions extends ControllerServiceOptions {
  requestId?: string;
  requestedBy?: string;
  reason?: string;
  delayMs?: number;
  mode?: "auto" | "sync" | "detached";
}

export interface RestartCoordinatorDependencies {
  now?: () => Date;
  launch?: (input: {
    repoRoot: string;
    controllerHome: string;
    requestId: string;
    logPath: string;
  }) => number | undefined;
  ancestry?: () => Set<number>;
  isPidAlive?: (pid: number | undefined) => boolean;
  sleep?: (ms: number) => Promise<void>;
  restart?: typeof restartControllerService;
  stop?: typeof stopControllerService;
  start?: typeof startControllerService;
  status?: typeof controllerServiceStatus;
  fetchJson?: (url: string) => Promise<Record<string, unknown> | null>;
  verificationAttempts?: number;
  verificationIntervalMs?: number;
  manageExternalTunnel?: (repoRoot: string, action: "start" | "stop") => void;
}

const ACTIVE_PHASES = new Set<ControllerRestartPhase>([
  "scheduled",
  "coordinator_started",
  "waiting_for_handoff",
  "stopping",
  "starting",
  "verifying",
]);
const DEFAULT_DELAY_MS = 1_500;
const ACTIVE_STATE_MAX_AGE_MS = 5 * 60_000;
const PUBLIC_TIMEOUT_MS = 5_000;
const DEFAULT_VERIFICATION_ATTEMPTS = 20;
const DEFAULT_VERIFICATION_INTERVAL_MS = 500;

function now(deps: RestartCoordinatorDependencies): Date {
  return deps.now?.() ?? new Date();
}

function nowIso(deps: RestartCoordinatorDependencies): string {
  return now(deps).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function safeRequestId(input?: string): string {
  const value = input?.trim() || `restart-${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw new Error("RESTART_REQUEST_ID_INVALID: expected 1-160 safe identifier characters");
  }
  return value;
}

export function controllerRestartDirectory(controllerHome: string): string {
  return join(resolve(controllerHome), "restart");
}

export function controllerRestartStatePath(controllerHome: string, requestId?: string): string {
  const root = controllerRestartDirectory(controllerHome);
  return requestId ? join(root, "requests", `${safeRequestId(requestId)}.json`) : join(root, "current.json");
}

export function controllerRestartLogPath(controllerHome: string): string {
  return join(controllerRestartDirectory(controllerHome), "controller-restart-coordinator.log");
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function readStateFile(path: string): ControllerRestartState | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ControllerRestartState;
    return value?.schemaVersion === 1 && typeof value.requestId === "string" ? value : null;
  } catch {
    return null;
  }
}

export function readControllerRestartState(controllerHome: string, requestId?: string): ControllerRestartState | null {
  return readStateFile(controllerRestartStatePath(controllerHome, requestId));
}

function writeState(state: ControllerRestartState): ControllerRestartState {
  atomicWrite(controllerRestartStatePath(state.controllerHome, state.requestId), state);
  atomicWrite(controllerRestartStatePath(state.controllerHome), state);
  return state;
}

function updateState(
  state: ControllerRestartState,
  patch: Partial<ControllerRestartState>,
  deps: RestartCoordinatorDependencies,
): ControllerRestartState {
  return writeState({ ...state, ...patch, updatedAt: nowIso(deps) });
}

function errorText(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return value.replace(/\s+/g, " ").slice(0, 1_000);
}

function stateAgeMs(state: ControllerRestartState, deps: RestartCoordinatorDependencies): number {
  const updatedAt = Date.parse(state.updatedAt);
  return Number.isFinite(updatedAt) ? Math.max(0, now(deps).getTime() - updatedAt) : Number.POSITIVE_INFINITY;
}

function stateIsActive(state: ControllerRestartState | null, deps: RestartCoordinatorDependencies): state is ControllerRestartState {
  if (!state || !ACTIVE_PHASES.has(state.phase)) return false;
  const alive = (deps.isPidAlive ?? isProcessAlive)(state.coordinatorPid ?? state.launcherPid);
  return alive || stateAgeMs(state, deps) < ACTIVE_STATE_MAX_AGE_MS;
}

function createOwnedLock(path: string, deps: RestartCoordinatorDependencies): number {
  const fd = openSync(path, "wx");
  writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: nowIso(deps) })}\n`, "utf8");
  return fd;
}

function acquireLock(path: string, current: ControllerRestartState | null, deps: RestartCoordinatorDependencies): number | null {
  mkdirSync(dirname(path), { recursive: true });
  try {
    return createOwnedLock(path, deps);
  } catch {
    if (stateIsActive(current, deps)) return null;
    let ownerPid: number | undefined;
    let lockAgeMs = 0;
    try {
      const metadata = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
      ownerPid = Number.isInteger(metadata.pid) ? metadata.pid : undefined;
      lockAgeMs = Math.max(0, now(deps).getTime() - statSync(path).mtimeMs);
    } catch {
      try {
        lockAgeMs = Math.max(0, now(deps).getTime() - statSync(path).mtimeMs);
      } catch {
        return null;
      }
    }
    if ((deps.isPidAlive ?? isProcessAlive)(ownerPid) || lockAgeMs < ACTIVE_STATE_MAX_AGE_MS) return null;
    rmSync(path, { force: true });
    return createOwnedLock(path, deps);
  }
}

function releaseLock(path: string, fd: number | undefined): void {
  if (fd === undefined) return;
  closeSync(fd);
  rmSync(path, { force: true });
}

function processAncestry(): Set<number> {
  const ancestors = new Set<number>([process.pid]);
  let pid = process.pid;
  for (let depth = 0; depth < 24; depth += 1) {
    const result = runProcess("ps", ["-o", "ppid=", "-p", String(pid)], {
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    });
    if (!result.ok) break;
    const parent = Number(result.stdout.trim());
    if (!Number.isInteger(parent) || parent <= 1 || ancestors.has(parent)) break;
    ancestors.add(parent);
    pid = parent;
  }
  return ancestors;
}

export function restartRequestNeedsDetachedCoordinator(
  repoRootInput: string,
  controllerHomeInput: string,
  deps: RestartCoordinatorDependencies = {},
): boolean {
  if (process.env.REPO_HARNESS_FORCE_DETACHED_RESTART === "1") return true;
  if (process.env.REPO_HARNESS_RESTART_COORDINATOR === "1") return false;

  const repoRoot = resolveMcpRepoRoot(repoRootInput);
  const controllerHome = resolveRepoPreferredControllerHome(repoRoot, controllerHomeInput);
  const service = loadControllerServiceState(repoRoot, controllerHome);
  const runtime = loadMcpServiceRuntimeState(controllerHome, repoRoot);
  const daemon = readControllerDaemonStatus(controllerHome);
  const managedPids = new Set<number>();
  const addPid = (pid: number | undefined) => {
    if (pid && pid > 0) managedPids.add(pid);
  };
  addPid(service?.supervisor.pid);
  addPid(service?.localController?.pid);
  addPid(runtime?.server.pid);
  addPid(runtime?.localController?.pid);
  addPid(runtime?.tunnel?.pid);
  addPid(daemon.pid);

  const ancestors = (deps.ancestry ?? processAncestry)();
  return Array.from(managedPids).some((pid) => ancestors.has(pid));
}

function externalTunnelManaged(): boolean {
  return process.env.REPO_HARNESS_CONTROLLER_EXTERNAL_TUNNEL?.trim().toLowerCase() === "ngrok";
}

function manageExternalTunnel(repoRoot: string, action: "start" | "stop"): void {
  if (!externalTunnelManaged()) return;
  const script = join(repoRoot, "scripts", "external-tunnel.sh");
  if (!existsSync(script)) throw new Error(`EXTERNAL_TUNNEL_SCRIPT_MISSING: ${script}`);
  const result = runProcess("bash", [script, action], { cwd: repoRoot, timeoutMs: 30_000, maxOutputBytes: 20_000 });
  if (!result.ok) {
    throw new Error(`EXTERNAL_TUNNEL_${action.toUpperCase()}_FAILED: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  }
}

function launchDetachedCoordinator(input: {
  repoRoot: string;
  controllerHome: string;
  requestId: string;
  logPath: string;
}): number | undefined {
  const script = join(input.repoRoot, "scripts", "controller-runtime.sh");
  if (!existsSync(script)) throw new Error(`RESTART_COORDINATOR_SCRIPT_MISSING: ${script}`);
  mkdirSync(dirname(input.logPath), { recursive: true });
  const logFd = openSync(input.logPath, "a");
  try {
    const child = spawn("/bin/bash", [script, "__restart_coordinator_run", "--request-id", input.requestId], {
      cwd: input.repoRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        REPO_HARNESS_CONTROLLER_HOME: input.controllerHome,
        REPO_HARNESS_RESTART_COORDINATOR: "1",
      },
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(logFd);
  }
}

export function scheduleControllerServiceRestart(
  opts: ControllerRestartRequestOptions,
  deps: RestartCoordinatorDependencies = {},
): ControllerRestartScheduledResult {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? ".");
  const controllerHome = resolveRepoPreferredControllerHome(repoRoot, opts.controllerHome);
  const requestId = safeRequestId(opts.requestId);
  const statePath = controllerRestartStatePath(controllerHome, requestId);
  const logPath = controllerRestartLogPath(controllerHome);
  const previousRequest = readControllerRestartState(controllerHome, requestId);
  if (previousRequest) {
    return {
      action: "restart_scheduled",
      accepted: true,
      deduplicated: true,
      requestId,
      statePath,
      logPath,
      reconnectContract: "stable_domain_retry",
      state: previousRequest,
    };
  }

  const current = readControllerRestartState(controllerHome);
  const lockPath = join(controllerRestartDirectory(controllerHome), "schedule.lock");
  const lockFd = acquireLock(lockPath, current, deps);
  if (lockFd === null) {
    const pending = readControllerRestartState(controllerHome) ?? current;
    if (pending) {
      return {
        action: "restart_scheduled",
        accepted: true,
        deduplicated: true,
        requestId: pending.requestId,
        statePath: controllerRestartStatePath(controllerHome, pending.requestId),
        logPath,
        reconnectContract: "stable_domain_retry",
        state: pending,
      };
    }
    throw new Error("RESTART_SCHEDULE_BUSY: another coordinator owns the schedule lock but has not published its durable state yet");
  }

  try {
    const active = readControllerRestartState(controllerHome);
    if (stateIsActive(active, deps)) {
      return {
        action: "restart_scheduled",
        accepted: true,
        deduplicated: true,
        requestId: active.requestId,
        statePath: controllerRestartStatePath(controllerHome, active.requestId),
        logPath,
        reconnectContract: "stable_domain_retry",
        state: active,
      };
    }

    const timestamp = nowIso(deps);
    const runtime = loadMcpServiceRuntimeState(controllerHome, repoRoot);
    let state = writeState({
      schemaVersion: 1,
      requestId,
      repoRoot,
      controllerHome,
      phase: "scheduled",
      requestedAt: timestamp,
      updatedAt: timestamp,
      requestedBy: opts.requestedBy?.trim() || "controller-service",
      reason: opts.reason?.trim().slice(0, 500) || undefined,
      delayMs: Math.max(250, Math.min(Math.trunc(opts.delayMs ?? DEFAULT_DELAY_MS), 30_000)),
      previousGeneration: runtime?.generation,
    });
    try {
      const launcherPid = (deps.launch ?? launchDetachedCoordinator)({ repoRoot, controllerHome, requestId, logPath });
      state = updateState(state, { launcherPid }, deps);
    } catch (error) {
      updateState(state, { phase: "failed", completedAt: nowIso(deps), error: errorText(error) }, deps);
      throw error;
    }
    return {
      action: "restart_scheduled",
      accepted: true,
      deduplicated: false,
      requestId,
      statePath,
      logPath,
      reconnectContract: "stable_domain_retry",
      state,
    };
  } finally {
    releaseLock(lockPath, lockFd ?? undefined);
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PUBLIC_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    return response.ok ? await response.json() as Record<string, unknown> : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function endpointUrl(endpoint: string, pathname: string): string {
  const url = new URL(endpoint);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function verifyControllerRestart(
  state: ControllerRestartState,
  status: ControllerServiceStatus,
  deps: RestartCoordinatorDependencies = {},
): Promise<ControllerRestartVerification> {
  const failures: string[] = [];
  const localMcp = status.health.mcp && status.readiness.gateway;
  const controllerDaemon = status.daemon.status === "ready" && status.readiness.daemon;
  const localBridge = status.health.localController && status.readiness.localController;
  const projection = status.readiness.projection;
  const runtimeSourceCurrent = status.restartRequired === false;
  const runtimeGenerationPresent = Boolean(status.runtimeGeneration);
  const runtimeGenerationChanged = !state.previousGeneration || (
    Boolean(status.runtimeGeneration) && status.runtimeGeneration !== state.previousGeneration
  );
  const connectorHealthy = status.readiness.connector && status.mcpRuntime?.tunnel?.connectorNeedsReconnect !== true;
  const publicEndpoint = status.mcpRuntime?.tunnel?.publicEndpoint;
  const publicConfigured = Boolean(publicEndpoint);
  let publicHealth = !publicConfigured;
  let oauthDiscovery = !publicConfigured;
  if (publicEndpoint) {
    const loadJson = deps.fetchJson ?? fetchJson;
    publicHealth = Boolean(await loadJson(endpointUrl(publicEndpoint, "/health")));
    const metadata = await loadJson(endpointUrl(publicEndpoint, "/.well-known/oauth-protected-resource/mcp"));
    oauthDiscovery = metadata?.resource === publicEndpoint
      && Array.isArray(metadata.authorization_servers)
      && metadata.authorization_servers.length > 0;
  }

  if (!localMcp) failures.push("local MCP Gateway is not healthy");
  if (!controllerDaemon) failures.push("Controller Daemon is not ready");
  if (!localBridge) failures.push("Local Bridge is not healthy");
  if (!projection) failures.push("repository projection is stale");
  if (!runtimeSourceCurrent) failures.push(`runtime source requires restart: ${status.restartReasons.join("; ")}`);
  if (!runtimeGenerationPresent) failures.push("runtime generation is missing");
  if (!runtimeGenerationChanged) failures.push("runtime generation did not change after restart");
  if (!connectorHealthy) failures.push("connector is unhealthy or requires reconnect");
  if (!publicHealth) failures.push("configured public health endpoint is unavailable");
  if (!oauthDiscovery) failures.push("OAuth protected-resource discovery is invalid");

  return {
    ok: failures.length === 0,
    localMcp,
    controllerDaemon,
    localBridge,
    projection,
    runtimeSourceCurrent,
    runtimeGenerationPresent,
    runtimeGenerationChanged,
    connectorHealthy,
    publicConfigured,
    publicHealth,
    oauthDiscovery,
    checkedAt: nowIso(deps),
    failures,
  };
}

export async function runControllerRestartCoordinator(
  opts: ControllerServiceOptions & { requestId: string },
  deps: RestartCoordinatorDependencies = {},
): Promise<ControllerRestartState> {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? ".");
  const controllerHome = resolveRepoPreferredControllerHome(repoRoot, opts.controllerHome);
  let state = readControllerRestartState(controllerHome, opts.requestId);
  if (!state) throw new Error(`RESTART_REQUEST_NOT_FOUND: ${opts.requestId}`);
  if (state.phase === "succeeded" || state.phase === "failed") return state;

  const lockPath = join(controllerRestartDirectory(controllerHome), "execution.lock");
  const lockFd = acquireLock(lockPath, readControllerRestartState(controllerHome), deps);
  if (lockFd === null) return readControllerRestartState(controllerHome, opts.requestId) ?? state;
  const wait = deps.sleep ?? sleep;
  const tunnelManager = deps.manageExternalTunnel ?? manageExternalTunnel;
  let externalTunnelStopped = false;

  try {
    state = updateState(state, {
      phase: "coordinator_started",
      coordinatorPid: process.pid,
      launcherPid: undefined,
      error: undefined,
    }, deps);
    state = updateState(state, { phase: "waiting_for_handoff" }, deps);
    await wait(state.delayMs);

    state = updateState(state, { phase: "stopping" }, deps);
    if (externalTunnelManaged() || deps.manageExternalTunnel) {
      tunnelManager(repoRoot, "stop");
      externalTunnelStopped = true;
    }
    await (deps.stop ?? stopControllerService)({
      repo: repoRoot,
      controllerHome,
      logFile: opts.logFile,
      stopTimeoutMs: opts.stopTimeoutMs,
      // The coordinator is detached specifically so it can replace the old
      // Gateway/keepalive ancestry. Protect only the coordinator process itself.
      protectCallerAncestry: false,
      requireFullStop: true,
    });

    state = updateState(state, { phase: "starting" }, deps);
    const started = await (deps.start ?? startControllerService)({
      repo: repoRoot,
      controllerHome,
      logFile: opts.logFile,
      startTimeoutMs: opts.startTimeoutMs,
    });
    if (externalTunnelStopped) {
      tunnelManager(repoRoot, "start");
      externalTunnelStopped = false;
    }
    state = updateState(state, {
      phase: "verifying",
      runtimeGeneration: started.status.runtimeGeneration,
    }, deps);

    const attempts = Math.max(1, Math.trunc(deps.verificationAttempts ?? DEFAULT_VERIFICATION_ATTEMPTS));
    let verification: ControllerRestartVerification | undefined;
    let latestStatus = started.status;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      latestStatus = await (deps.status ?? controllerServiceStatus)({ repo: repoRoot, controllerHome, logFile: opts.logFile });
      verification = await verifyControllerRestart(state, latestStatus, deps);
      if (verification.ok) break;
      if (attempt < attempts) await wait(deps.verificationIntervalMs ?? DEFAULT_VERIFICATION_INTERVAL_MS);
    }
    if (!verification?.ok) {
      throw new Error(`RESTART_VERIFICATION_FAILED: ${verification?.failures.join("; ") ?? "unknown verification error"}`);
    }

    state = updateState(state, {
      phase: "succeeded",
      runtimeGeneration: latestStatus.runtimeGeneration,
      verification,
      completedAt: nowIso(deps),
    }, deps);
    return state;
  } catch (error) {
    let failure = errorText(error);
    if (externalTunnelStopped) {
      try {
        tunnelManager(repoRoot, "start");
        externalTunnelStopped = false;
      } catch (restoreError) {
        failure = `${failure}; external tunnel restore failed: ${errorText(restoreError)}`.slice(0, 1_000);
      }
    }
    state = updateState(state, {
      phase: "failed",
      completedAt: nowIso(deps),
      error: failure,
    }, deps);
    throw error;
  } finally {
    releaseLock(lockPath, lockFd ?? undefined);
  }
}

export async function requestControllerServiceRestart(
  opts: ControllerRestartRequestOptions = {},
  deps: RestartCoordinatorDependencies = {},
): Promise<ControllerRestartRequestResult> {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? ".");
  const controllerHome = resolveRepoPreferredControllerHome(repoRoot, opts.controllerHome);
  const detached = opts.mode === "detached" || (
    opts.mode !== "sync" && restartRequestNeedsDetachedCoordinator(repoRoot, controllerHome, deps)
  );
  if (detached) return scheduleControllerServiceRestart({ ...opts, repo: repoRoot, controllerHome }, deps);
  const tunnelManager = deps.manageExternalTunnel ?? manageExternalTunnel;
  const manageTunnel = externalTunnelManaged() || Boolean(deps.manageExternalTunnel);
  let externalTunnelStopped = false;
  try {
    if (manageTunnel) {
      tunnelManager(repoRoot, "stop");
      externalTunnelStopped = true;
    }
    const restarted = await (deps.restart ?? restartControllerService)({ ...opts, repo: repoRoot, controllerHome });
    if (externalTunnelStopped) {
      tunnelManager(repoRoot, "start");
      externalTunnelStopped = false;
    }
    return restarted;
  } finally {
    if (externalTunnelStopped) {
      try { tunnelManager(repoRoot, "start"); } catch { /* retain the primary restart failure */ }
    }
  }
}

export function formatControllerRestartScheduled(result: ControllerRestartScheduledResult): string {
  return [
    `Controller restart ${result.deduplicated ? "already pending" : "scheduled"}.`,
    `Request: ${result.requestId}`,
    `Phase: ${result.state.phase}`,
    `State: ${result.statePath}`,
    `Log: ${result.logPath}`,
    "The current MCP request may disconnect while the stack restarts. Retry the stable domain with the same durable request/work identifiers; Connector recreation is not required when auth and the tool schema are unchanged.",
  ].join("\n");
}
