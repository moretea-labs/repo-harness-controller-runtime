import { spawn, type ChildProcess } from 'child_process';
import { accessSync, constants } from 'fs';
import { resolve } from 'path';
import {
  loadMcpLocalConfig,
  loadMcpRuntimeState,
  loadMcpServiceLocalConfig,
  loadMcpServiceRuntimeState,
  mcpControllerHomeRuntimeStatePath,
  mcpRuntimeStatePath,
  writeMcpRuntimeState,
  writeMcpServiceRuntimeState,
  type McpRuntimeState,
  type McpRuntimeTunnelMode,
} from './auth';
import type { McpServerOptions } from './server';
import { loadLocalBridgeConfig } from '../local-bridge/job-store';
import { startLocalBridgeServer, type LocalBridgeServerHandle } from '../local-bridge/server';
import { runtimePolicy } from './multi-repository';
import { ensureControllerHome } from '../repositories/controller-home';
import { resolveMcpRepoRoot } from './repo';
import {
  CONTROLLER_SCHEMA_VERSION,
  CONTROLLER_TOOL_SURFACE,
  CONTROLLER_TOOL_SURFACE_VERSION,
  controllerToolSurfaceFingerprint,
  repositoryIdentity,
} from '../controller/runtime-config';
import { controllerExpectedToolNames } from './tools';
import { CORE_CONTROLLER_TOOL_NAMES } from './toolset';
import { parseMcpToolset } from './multi-repository';
import { runtimeToolDefinitions } from '../../runtime/gateway/mcp/runtime-tools';

export interface McpKeepaliveOptions extends McpServerOptions {
  repo?: string;
  host?: string;
  port?: number;
  auth?: string;
  tunnel?: string;
  cloudflaredBin?: string;
  cloudflareTunnelName?: string;
  publicEndpoint?: string;
  checkIntervalMs?: number;
  restartDelayMs?: number;
  unhealthyRestartWindowMs?: number;
  tunnelUnhealthyRestartWindowMs?: number;
  toolset?: 'core' | 'full' | string;
  localUi?: boolean;
  localUiHost?: string;
  localUiPort?: number;
  openLocalUi?: boolean;
}

const DEFAULT_CHECK_INTERVAL_MS = 15_000;
const DEFAULT_RESTART_DELAY_MS = 2_000;
const HEALTH_TIMEOUT_MS = 4_000;
const STARTUP_HEALTH_GRACE_MS = 5_000;
const STARTUP_HEALTH_RETRY_MS = 250;
const LOCAL_FAILURE_THRESHOLD = 2;
const PUBLIC_FAILURE_THRESHOLD = 2;
export const DEFAULT_MCP_UNHEALTHY_RESTART_WINDOW_MS = 5 * 60_000;
export const DEFAULT_MCP_TUNNEL_UNHEALTHY_RESTART_WINDOW_MS = 2 * 60_000;
const LOCAL_HEALTH_WARNING_INTERVAL_MS = 60_000;
const QUICK_TUNNEL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function shouldRestartMcpServer(
  childRunning: boolean,
  failureCount: number,
  unhealthySinceAt: number | undefined,
  now: number,
  unhealthyRestartWindowMs = DEFAULT_MCP_UNHEALTHY_RESTART_WINDOW_MS,
): boolean {
  if (!childRunning) return true;
  if (failureCount < LOCAL_FAILURE_THRESHOLD || unhealthySinceAt === undefined) return false;
  return now - unhealthySinceAt >= unhealthyRestartWindowMs;
}

export function shouldRestartMcpTunnel(
  localHealthy: boolean,
  childRunning: boolean,
  failureCount: number,
  unhealthySinceAt: number | undefined,
  now: number,
  unhealthyRestartWindowMs = DEFAULT_MCP_TUNNEL_UNHEALTHY_RESTART_WINDOW_MS,
): boolean {
  if (!childRunning) return true;
  if (!localHealthy) return false;
  if (failureCount < PUBLIC_FAILURE_THRESHOLD || unhealthySinceAt === undefined) return false;
  return now - unhealthySinceAt >= unhealthyRestartWindowMs;
}

export function extractCloudflareQuickTunnelUrl(text: string): string | undefined {
  return text.match(QUICK_TUNNEL_PATTERN)?.[0];
}

export function normalizeKeepalivePublicEndpoint(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (_error) {
    throw new Error(`invalid --public-endpoint "${value}" (expected a public HTTPS URL exactly ending in /mcp)`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.pathname !== '/mcp' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(`invalid --public-endpoint "${value}" (expected a public HTTPS URL exactly ending in /mcp)`);
  }
  return parsed.toString();
}

export function inferMcpTunnelMode(
  requested: string | undefined,
  publicEndpoint: string | undefined,
  tunnelName: string | undefined,
): McpRuntimeTunnelMode {
  const normalized = requested?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0 || normalized === 'auto') {
    return publicEndpoint && tunnelName ? 'named' : 'quick';
  }
  if (normalized === 'none' || normalized === 'quick' || normalized === 'named') return normalized;
  throw new Error(`invalid --tunnel "${requested}" (expected: auto, none, quick, named)`);
}

function endpointOrigin(endpoint: string): string {
  return new URL(endpoint).origin;
}

function localEndpoint(host: string, port: number): string {
  return `http://${host}:${port}/mcp`;
}

function localHealthUrl(host: string, port: number): string {
  return `http://${host}:${port}/health`;
}

function localControllerHealthUrl(host: string, port: number): string {
  return `http://${host === '::1' ? '[::1]' : host}:${port}/health`;
}

function oauthResourceUrl(endpoint: string): string {
  return new URL('/.well-known/oauth-protected-resource/mcp', endpoint).toString();
}

function summarizeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `signal ${signal}`;
  if (code !== null) return `exit ${code}`;
  return 'unknown exit';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function isRunning(child: ChildProcess | undefined): child is ChildProcess {
  return Boolean(child && child.exitCode === null);
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (_error) { return false; }
}

async function stopPid(pid: number): Promise<void> {
  try { process.kill(pid, 'SIGTERM'); } catch (_error) { return; }
  const deadline = Date.now() + 3_000;
  while (isPidAlive(pid) && Date.now() < deadline) await sleep(100);
  if (isPidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch (_error) { /* already stopped */ }
  }
}

async function stopChild(child: ChildProcess | undefined, label: string): Promise<void> {
  if (!isRunning(child)) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (isRunning(child) && Date.now() < deadline) {
    await sleep(100);
  }
  if (isRunning(child)) {
    console.error(`[repo-harness mcp keepalive] ${label} did not exit after SIGTERM; sending SIGKILL`);
    child.kill('SIGKILL');
  }
}

export function resolveSelfCliInvocation(): { command: string; args: string[] } {
  const scriptPath = process.argv[1];
  if (!scriptPath) throw new Error('cannot resolve repo-harness CLI entrypoint for keepalive');
  const resolvedPath = resolve(scriptPath);
  accessSync(resolvedPath, constants.R_OK);
  return { command: process.execPath, args: [resolvedPath] };
}

function resolveCloudflaredBinary(input: string | undefined): string {
  const candidate = input?.trim() || 'cloudflared';
  if (candidate.includes('/') || candidate.includes('\\')) {
    accessSync(candidate, constants.X_OK);
    return candidate;
  }
  const resolved = Bun.which(candidate);
  if (!resolved) throw new Error(`cloudflared binary was not found on PATH (tried "${candidate}")`);
  return resolved;
}

async function jsonHealth(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function isExpectedLocalControllerHealth(payload: Record<string, unknown> | null, repoRoot = process.cwd()): boolean {
  const fingerprint = controllerToolSurfaceFingerprint(
    controllerExpectedToolNames(runtimePolicy(repoRoot, { profile: 'controller' })),
  );
  return payload?.status === 'ok'
    && payload.toolSurface === CONTROLLER_TOOL_SURFACE
    && payload.schemaVersion === CONTROLLER_SCHEMA_VERSION
    && payload.toolSurfaceVersion === CONTROLLER_TOOL_SURFACE_VERSION
    && payload.toolSurfaceFingerprint === fingerprint;
}

function attachLineLogging(
  child: ChildProcess,
  label: string,
  onLine?: (line: string) => void,
): void {
  const bind = (stream: NodeJS.ReadableStream | null, streamLabel: 'stdout' | 'stderr') => {
    if (!stream) return;
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        console.error(`[repo-harness mcp keepalive] [${label}:${streamLabel}] ${line}`);
        onLine?.(line);
      }
    });
    stream.on('end', () => {
      const line = buffer.trim();
      if (line.length === 0) return;
      console.error(`[repo-harness mcp keepalive] [${label}:${streamLabel}] ${line}`);
      onLine?.(line);
    });
  };
  bind(child.stdout, 'stdout');
  bind(child.stderr, 'stderr');
}

export async function runMcpKeepalive(rawOpts: McpKeepaliveOptions): Promise<void> {
  const repoRoot = resolveMcpRepoRoot(rawOpts.repo ?? '.');
  const controllerHome = ensureControllerHome(rawOpts.controllerHome);
  const serviceConfig = loadMcpServiceLocalConfig(controllerHome, repoRoot);
  const profile = rawOpts.profile ?? serviceConfig?.profile ?? 'controller';
  const localConfig = profile === 'controller' ? serviceConfig : loadMcpLocalConfig(repoRoot);
  const host = rawOpts.host ?? localConfig?.server?.host ?? '127.0.0.1';
  const port = rawOpts.port ?? localConfig?.server?.port ?? 8765;
  const toolset = parseMcpToolset(rawOpts.toolset ?? localConfig?.toolset ?? 'core', profile);
  const policy = runtimePolicy(repoRoot, {
    controllerHome,
    profile,
    toolset,
    enableDevRunner: rawOpts.enableDevRunner,
    devRunnerAgents: rawOpts.devRunnerAgents,
    devRunnerTimeoutMs: rawOpts.devRunnerTimeoutMs,
    devRunnerMaxTimeoutMs: rawOpts.devRunnerMaxTimeoutMs,
  });
  const expectedToolSurface = profile === 'controller' ? CONTROLLER_TOOL_SURFACE : `${profile}-legacy-v1`;
  const expectedSchemaVersion = profile === 'controller' ? CONTROLLER_SCHEMA_VERSION : 1;
  const expectedToolSurfaceVersion = profile === 'controller' ? CONTROLLER_TOOL_SURFACE_VERSION : 1;
  const compatibilityToolNames = profile === 'controller'
    ? controllerExpectedToolNames(policy, { enableChatgptBrowser: rawOpts.enableChatgptBrowser === true })
    : [];
  const expectedToolSurfaceFingerprint = profile === 'controller'
    ? controllerToolSurfaceFingerprint(compatibilityToolNames)
    : undefined;
  const expectedRuntimeToolNames = profile === 'controller'
    ? (toolset === 'core'
      ? [...CORE_CONTROLLER_TOOL_NAMES]
      : [...compatibilityToolNames, ...runtimeToolDefinitions.map((tool) => tool.name)])
    : [];
  const expectedRuntimeToolSurfaceFingerprint = profile === 'controller'
    ? controllerToolSurfaceFingerprint(expectedRuntimeToolNames)
    : undefined;
  const expectedRepoId = profile === 'controller' ? undefined : repositoryIdentity(repoRoot);
  const previousRuntime = profile === 'controller'
    ? loadMcpServiceRuntimeState(controllerHome, repoRoot)
    : loadMcpRuntimeState(repoRoot);
  const existingHealth = await jsonHealth(localHealthUrl(host, port));
  if (existingHealth?.status === 'ok') {
    const existingMatches = existingHealth.toolSurface === expectedToolSurface
      && existingHealth.schemaVersion === expectedSchemaVersion
      && existingHealth.toolSurfaceVersion === expectedToolSurfaceVersion
      && (expectedToolSurfaceFingerprint === undefined || existingHealth.toolSurfaceFingerprint === expectedToolSurfaceFingerprint)
      && (expectedRuntimeToolSurfaceFingerprint === undefined || existingHealth.runtimeToolSurfaceFingerprint === expectedRuntimeToolSurfaceFingerprint)
      && existingHealth.toolset === toolset
      && existingHealth.profile === profile
      && (expectedRepoId === undefined || existingHealth.repoId === expectedRepoId);
    const previousPid = previousRuntime?.server.pid;
    if (isPidAlive(previousPid) && existingHealth.server === 'repo-harness-mcp') {
      console.error(`[repo-harness mcp keepalive] Replacing previous repo-harness MCP process ${previousPid}.`);
      await stopPid(previousPid as number);
      await sleep(250);
    } else if (!existingMatches) {
      throw new Error(`port ${port} is occupied by an incompatible MCP server (surface=${String(existingHealth.toolSurface ?? 'unknown')}, schema=${String(existingHealth.schemaVersion ?? 'unknown')}, version=${String(existingHealth.toolSurfaceVersion ?? 'unknown')}, fingerprint=${String(existingHealth.toolSurfaceFingerprint ?? 'unknown')}, profile=${String(existingHealth.profile ?? 'unknown')}). Stop the old process or choose another port.`);
    } else {
      throw new Error(`port ${port} already has a compatible repo-harness MCP server, but it is not owned by this keepalive process. Stop it before starting a new supervisor.`);
    }
  }
  const localBridgeConfig = loadLocalBridgeConfig(repoRoot);
  const localUiEnabled = rawOpts.localUi ?? localConfig?.localController?.enabled ?? profile === 'controller';
  const localUiHost = rawOpts.localUiHost ?? localConfig?.localController?.host ?? localBridgeConfig.host ?? '127.0.0.1';
  const localUiPort = rawOpts.localUiPort ?? localConfig?.localController?.port ?? localBridgeConfig.port ?? 8766;
  const openLocalUi = rawOpts.openLocalUi ?? localConfig?.localController?.autoOpen ?? localBridgeConfig.autoOpen ?? false;
  const auth = rawOpts.auth ?? localConfig?.auth?.mode ?? 'oauth';
  const configuredEndpoint = normalizeKeepalivePublicEndpoint(rawOpts.publicEndpoint ?? localConfig?.chatgpt?.endpoint);
  const tunnelName = rawOpts.cloudflareTunnelName?.trim() || undefined;
  const tunnelMode = inferMcpTunnelMode(rawOpts.tunnel, configuredEndpoint, tunnelName);
  if (tunnelMode === 'named' && !configuredEndpoint) {
    throw new Error('named tunnel mode requires --public-endpoint or chatgpt.endpoint in .repo-harness/mcp.local.json');
  }
  if (tunnelMode === 'named' && !tunnelName) {
    throw new Error('named tunnel mode requires --cloudflare-tunnel-name');
  }
  const cloudflaredBin = tunnelMode === 'none' ? undefined : resolveCloudflaredBinary(rawOpts.cloudflaredBin);
  const cli = resolveSelfCliInvocation();
  const checkIntervalMs = rawOpts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const restartDelayMs = rawOpts.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
  const unhealthyRestartWindowMs = rawOpts.unhealthyRestartWindowMs ?? DEFAULT_MCP_UNHEALTHY_RESTART_WINDOW_MS;
  const tunnelUnhealthyRestartWindowMs = rawOpts.tunnelUnhealthyRestartWindowMs ?? DEFAULT_MCP_TUNNEL_UNHEALTHY_RESTART_WINDOW_MS;
  if (!Number.isInteger(checkIntervalMs) || checkIntervalMs < 2_000) {
    throw new Error(`invalid --check-interval-ms "${String(rawOpts.checkIntervalMs)}"`);
  }
  if (!Number.isInteger(restartDelayMs) || restartDelayMs < 250) {
    throw new Error(`invalid --restart-delay-ms "${String(rawOpts.restartDelayMs)}"`);
  }
  if (!Number.isInteger(unhealthyRestartWindowMs) || unhealthyRestartWindowMs < checkIntervalMs) {
    throw new Error(`invalid unhealthy restart window "${String(rawOpts.unhealthyRestartWindowMs)}"`);
  }
  if (!Number.isInteger(tunnelUnhealthyRestartWindowMs) || tunnelUnhealthyRestartWindowMs < checkIntervalMs) {
    throw new Error(`invalid tunnel unhealthy restart window "${String(rawOpts.tunnelUnhealthyRestartWindowMs)}"`);
  }

  let stopping = false;
  let serverChild: ChildProcess | undefined;
  let tunnelChild: ChildProcess | undefined;
  let localBridge: LocalBridgeServerHandle | undefined;
  let localFailureCount = 0;
  let localUnhealthySinceAt: number | undefined;
  let lastLocalHealthWarningAt: number | undefined;
  let publicFailureCount = 0;
  let publicUnhealthySinceAt: number | undefined;
  let lastPublicHealthWarningAt: number | undefined;
  let currentQuickEndpoint: string | undefined;
  let tunnelStartedOnce = false;

  const runtime: McpRuntimeState = {
    version: 1,
    repo: repoRoot,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    status: 'starting',
    tunnelMode,
    localController: localUiEnabled ? {
      endpoint: `http://${localUiHost === '::1' ? '[::1]' : localUiHost}:${localUiPort}/`,
      running: false,
    } : undefined,
    server: {
      endpoint: localEndpoint(host, port),
      running: false,
      healthy: false,
      restartCount: 0,
    },
    tunnel: tunnelMode === 'none' ? undefined : {
      running: false,
      restartCount: 0,
      ...(tunnelName ? { name: tunnelName } : {}),
      ...(configuredEndpoint ? { publicEndpoint: configuredEndpoint } : {}),
      connectorNeedsReconnect: false,
    },
    recentErrors: [],
  };

  const persistRuntime = (): void => {
    runtime.updatedAt = nowIso();
    if (profile === 'controller') {
      writeMcpServiceRuntimeState(controllerHome, runtime);
    } else {
      writeMcpRuntimeState(repoRoot, runtime);
    }
  };

  const recordError = (
    source: 'server' | 'tunnel' | 'health' | 'config' | 'local-controller',
    message: string,
  ): void => {
    runtime.recentErrors = [...(runtime.recentErrors ?? []), { at: nowIso(), source, message }].slice(-10);
    persistRuntime();
  };

  const updateStatus = (): void => {
    if (stopping) {
      runtime.status = 'stopped';
      return;
    }
    const localHealthy = runtime.server.healthy === true;
    const publicHealthy = runtime.tunnelMode === 'none' || runtime.tunnel?.healthy === true;
    if (localHealthy && publicHealthy) {
      runtime.status = 'running';
      return;
    }
    runtime.status = localHealthy || runtime.server.running || runtime.tunnel?.running ? 'degraded' : 'starting';
  };

  const probeLocalHealth = async (): Promise<boolean> => {
    const localHealth = await jsonHealth(localHealthUrl(host, port));
    const mismatch = localHealth?.status === 'ok'
      ? [
        localHealth.toolSurface === expectedToolSurface ? null : `tool surface ${String(localHealth.toolSurface ?? 'missing')} != ${expectedToolSurface}`,
        localHealth.schemaVersion === expectedSchemaVersion ? null : `schema ${String(localHealth.schemaVersion ?? 'missing')} != ${expectedSchemaVersion}`,
        localHealth.toolSurfaceVersion === expectedToolSurfaceVersion ? null : `surface version ${String(localHealth.toolSurfaceVersion ?? 'missing')} != ${expectedToolSurfaceVersion}`,
        expectedToolSurfaceFingerprint === undefined || localHealth.toolSurfaceFingerprint === expectedToolSurfaceFingerprint ? null : `surface fingerprint ${String(localHealth.toolSurfaceFingerprint ?? 'missing')} != ${expectedToolSurfaceFingerprint}`,
        expectedRuntimeToolSurfaceFingerprint === undefined || localHealth.runtimeToolSurfaceFingerprint === expectedRuntimeToolSurfaceFingerprint ? null : `runtime fingerprint ${String(localHealth.runtimeToolSurfaceFingerprint ?? 'missing')} != ${expectedRuntimeToolSurfaceFingerprint}`,
        localHealth.toolset === toolset ? null : `toolset ${String(localHealth.toolset ?? 'missing')} != ${toolset}`,
        localHealth.profile === profile ? null : `profile ${String(localHealth.profile ?? 'missing')} != ${profile}`,
        expectedRepoId === undefined || localHealth.repoId === expectedRepoId ? null : `repository identity ${String(localHealth.repoId ?? 'missing')} != ${expectedRepoId}`,
      ].filter(Boolean).join('; ')
      : '';
    runtime.server.healthy = localHealth?.status === 'ok' && mismatch.length === 0;
    runtime.server.profile = typeof localHealth?.profile === 'string' ? localHealth.profile : undefined;
    runtime.server.toolSurface = typeof localHealth?.toolSurface === 'string' ? localHealth.toolSurface : undefined;
    runtime.server.schemaVersion = typeof localHealth?.schemaVersion === 'number' ? localHealth.schemaVersion : undefined;
    runtime.server.toolSurfaceVersion = typeof localHealth?.toolSurfaceVersion === 'number' ? localHealth.toolSurfaceVersion : undefined;
    runtime.server.toolSurfaceFingerprint = typeof localHealth?.toolSurfaceFingerprint === 'string' ? localHealth.toolSurfaceFingerprint : undefined;
    runtime.server.runtimeToolSurfaceFingerprint = typeof localHealth?.runtimeToolSurfaceFingerprint === 'string' ? localHealth.runtimeToolSurfaceFingerprint : undefined;
    runtime.server.toolset = localHealth?.toolset === 'core' || localHealth?.toolset === 'full' ? localHealth.toolset : undefined;
    runtime.server.toolCount = typeof localHealth?.toolCount === 'number' ? localHealth.toolCount : undefined;
    runtime.server.repoId = typeof localHealth?.repoId === 'string' ? localHealth.repoId : undefined;
    const runner = localHealth?.runner && typeof localHealth.runner === 'object' ? localHealth.runner as Record<string, unknown> : undefined;
    runtime.server.defaultTimeoutMs = typeof runner?.defaultTimeoutMs === 'number' ? runner.defaultTimeoutMs : undefined;
    runtime.server.maxTimeoutMs = typeof runner?.maxTimeoutMs === 'number' ? runner.maxTimeoutMs : undefined;
    runtime.server.healthMismatch = mismatch || undefined;
    if (!runtime.server.healthy) return false;
    runtime.server.lastHealthyAt = nowIso();
    localFailureCount = 0;
    localUnhealthySinceAt = undefined;
    lastLocalHealthWarningAt = undefined;
    if (tunnelMode !== 'none' && !isRunning(tunnelChild)) {
      spawnTunnel(tunnelStartedOnce);
      tunnelStartedOnce = true;
    }
    return true;
  };

  const warmServerHealth = async (): Promise<void> => {
    const deadline = Date.now() + STARTUP_HEALTH_GRACE_MS;
    while (!stopping && isRunning(serverChild) && Date.now() < deadline) {
      if (await probeLocalHealth()) {
        updateStatus();
        persistRuntime();
        return;
      }
      await sleep(STARTUP_HEALTH_RETRY_MS);
    }
    updateStatus();
    persistRuntime();
  };

  const setQuickEndpoint = (endpoint: string): void => {
    if (!runtime.tunnel) return;
    const next = trimTrailingSlash(endpoint) + '/mcp';
    if (runtime.tunnel.publicEndpoint === next) return;
    if (runtime.tunnel.publicEndpoint && runtime.tunnel.publicEndpoint !== next) {
      runtime.tunnel.lastUrlChangeAt = nowIso();
      runtime.tunnel.connectorNeedsReconnect = true;
      recordError('tunnel', `quick tunnel URL changed to ${next}; update the ChatGPT connector or use a named tunnel`);
    }
    runtime.tunnel.publicEndpoint = next;
    currentQuickEndpoint = next;
    if (configuredEndpoint && configuredEndpoint !== next) {
      runtime.tunnel.connectorNeedsReconnect = true;
    }
    persistRuntime();
  };

  const spawnServer = (isRestart: boolean): void => {
    const args = [
      ...cli.args,
      'mcp',
      'serve',
      '--repo',
      repoRoot,
      '--transport',
      'http',
      '--host',
      host,
      '--port',
      String(port),
      '--profile',
      profile,
      '--toolset',
      toolset,
      '--auth',
      auth,
    ];
    if (rawOpts.enableChatgptBrowser === true) args.push('--enable-chatgpt-browser');
    if (rawOpts.enableDevRunner === true) args.push('--enable-dev-runner');
    if (rawOpts.devRunnerAgents) args.push('--dev-runner-agents', rawOpts.devRunnerAgents);
    if (rawOpts.devRunnerTimeoutMs) args.push('--dev-runner-timeout-ms', String(rawOpts.devRunnerTimeoutMs));
    if (rawOpts.devRunnerMaxTimeoutMs) args.push('--dev-runner-max-timeout-ms', String(rawOpts.devRunnerMaxTimeoutMs));
    const env: NodeJS.ProcessEnv = { ...process.env, REPO_HARNESS_CONTROLLER_HOME: controllerHome };
    if (configuredEndpoint && tunnelMode === 'named') {
      env.REPO_HARNESS_MCP_PUBLIC_ORIGIN = endpointOrigin(configuredEndpoint);
    }
    serverChild = spawn(cli.command, args, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runtime.server.running = true;
    runtime.server.pid = serverChild.pid;
    runtime.server.lastStartAt = nowIso();
    if (isRestart) runtime.server.restartCount += 1;
    attachLineLogging(serverChild, 'serve');
    serverChild.once('exit', (code, signal) => {
      runtime.server.running = false;
      runtime.server.healthy = false;
      runtime.server.pid = undefined;
      runtime.server.lastExitAt = nowIso();
      runtime.server.lastExit = summarizeExit(code, signal);
      updateStatus();
      persistRuntime();
      if (!stopping) recordError('server', `mcp serve exited (${runtime.server.lastExit})`);
    });
    updateStatus();
    persistRuntime();
  };

  const spawnTunnel = (isRestart: boolean): void => {
    if (!cloudflaredBin || tunnelMode === 'none') return;
    const args = tunnelMode === 'quick'
      ? ['tunnel', '--protocol', 'http2', '--url', `http://${host}:${port}`]
      : ['tunnel', 'run', '--url', `http://${host}:${port}`, tunnelName as string];
    tunnelChild = spawn(cloudflaredBin, args, {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (runtime.tunnel) {
      runtime.tunnel.running = true;
      runtime.tunnel.pid = tunnelChild.pid;
      runtime.tunnel.lastStartAt = nowIso();
      if (isRestart) runtime.tunnel.restartCount += 1;
    }
    attachLineLogging(tunnelChild, 'tunnel', (line) => {
      if (tunnelMode !== 'quick') return;
      const url = extractCloudflareQuickTunnelUrl(line);
      if (url) setQuickEndpoint(url);
    });
    tunnelChild.once('exit', (code, signal) => {
      if (runtime.tunnel) {
        runtime.tunnel.running = false;
        runtime.tunnel.healthy = false;
        runtime.tunnel.pid = undefined;
        runtime.tunnel.lastExitAt = nowIso();
        runtime.tunnel.lastExit = summarizeExit(code, signal);
      }
      updateStatus();
      persistRuntime();
      if (!stopping) recordError('tunnel', `cloudflared exited (${summarizeExit(code, signal)})`);
    });
    updateStatus();
    persistRuntime();
  };

  const restartTunnel = async (reason: string): Promise<void> => {
    if (runtime.tunnelMode === 'none') return;
    recordError('tunnel', reason);
    await stopChild(tunnelChild, 'cloudflared');
    tunnelChild = undefined;
    if (runtime.tunnelMode === 'quick') {
      currentQuickEndpoint = undefined;
      if (runtime.tunnel) runtime.tunnel.healthy = false;
    }
    await sleep(restartDelayMs);
    spawnTunnel(true);
  };

  const restartServer = async (reason: string): Promise<void> => {
    recordError('server', reason);
    // Keep the tunnel process and public URL alive while the local Gateway is
    // replaced. cloudflared will reconnect to the same local port, avoiding a
    // quick-tunnel URL rotation and preserving the Connector endpoint.
    await stopChild(serverChild, 'mcp serve');
    serverChild = undefined;
    runtime.server.running = false;
    runtime.server.healthy = false;
    await sleep(restartDelayMs);
    spawnServer(true);
    await warmServerHealth();
  };


  const startLocalController = async (): Promise<void> => {
    if (!localUiEnabled || localBridge) return;
    try {
      localBridge = await startLocalBridgeServer({
        repoRoot,
        host: localUiHost,
        port: localUiPort,
        openBrowser: openLocalUi,
      });
      runtime.localController = {
        endpoint: localBridge.url,
        running: true,
        pid: process.pid,
        startedAt: nowIso(),
      };
      console.error(`[repo-harness mcp keepalive] Local Controller: ${localBridge.url}`);
      persistRuntime();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.localController = {
        endpoint: `http://${localUiHost === '::1' ? '[::1]' : localUiHost}:${localUiPort}/`,
        running: false,
        error: message,
      };
      recordError('local-controller', message);
      console.error(`[repo-harness mcp keepalive] Local Controller unavailable: ${message}`);
    }
  };

  const probeLocalControllerHealth = async (): Promise<boolean> => {
    if (!localUiEnabled) {
      runtime.localController = undefined;
      return true;
    }

    const endpoint = `http://${localUiHost === '::1' ? '[::1]' : localUiHost}:${localUiPort}/`;
    const health = await jsonHealth(localControllerHealthUrl(localUiHost, localUiPort));
    const healthy = isExpectedLocalControllerHealth(health);
    runtime.localController = healthy
      ? {
          endpoint,
          running: true,
          ...(localBridge ? { pid: process.pid } : {}),
          startedAt: runtime.localController?.startedAt ?? nowIso(),
        }
      : {
          endpoint,
          running: false,
          ...(localBridge ? { pid: process.pid } : {}),
          error: `health check failed at ${localControllerHealthUrl(localUiHost, localUiPort)}`,
        };
    return healthy;
  };

  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    updateStatus();
    persistRuntime();
    await stopChild(tunnelChild, 'cloudflared');
    await stopChild(serverChild, 'mcp serve');
    if (localBridge) {
      await localBridge.close();
      localBridge = undefined;
    }
    if (runtime.localController) runtime.localController.running = false;
    runtime.server.running = false;
    runtime.server.healthy = false;
    runtime.server.pid = undefined;
    if (runtime.tunnel) {
      runtime.tunnel.running = false;
      runtime.tunnel.healthy = false;
      runtime.tunnel.pid = undefined;
    }
    updateStatus();
    persistRuntime();
  };

  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  console.error(`[repo-harness mcp keepalive] Repo: ${repoRoot}`);
  console.error(`[repo-harness mcp keepalive] Local endpoint: ${runtime.server.endpoint}`);
  console.error(`[repo-harness mcp keepalive] Tunnel mode: ${tunnelMode}`);
  if (configuredEndpoint) {
    console.error(`[repo-harness mcp keepalive] Configured public endpoint: ${configuredEndpoint}`);
  }
  console.error(`[repo-harness mcp keepalive] Runtime state: ${profile === 'controller' ? mcpControllerHomeRuntimeStatePath(controllerHome) : mcpRuntimeStatePath(repoRoot)}`);
  persistRuntime();

  await startLocalController();
  spawnServer(false);
  await warmServerHealth();

  while (!stopping) {
    const localHealthy = await probeLocalHealth();
    if (localHealthy) {
      localFailureCount = 0;
    } else {
      const now = Date.now();
      localFailureCount += 1;
      localUnhealthySinceAt ??= now;
      const childRunning = isRunning(serverChild);
      if (shouldRestartMcpServer(
        childRunning,
        localFailureCount,
        localUnhealthySinceAt,
        now,
        unhealthyRestartWindowMs,
      )) {
        await restartServer(`local MCP health failed at ${localHealthUrl(host, port)}`);
        localFailureCount = 0;
        localUnhealthySinceAt = undefined;
        lastLocalHealthWarningAt = undefined;
        publicFailureCount = 0;
        updateStatus();
        persistRuntime();
        continue;
      }
      if (
        localFailureCount === LOCAL_FAILURE_THRESHOLD
        || lastLocalHealthWarningAt === undefined
        || now - lastLocalHealthWarningAt >= LOCAL_HEALTH_WARNING_INTERVAL_MS
      ) {
        const elapsedMs = now - localUnhealthySinceAt;
        const remainingSeconds = Math.ceil(Math.max(0, unhealthyRestartWindowMs - elapsedMs) / 1000);
        const message = 'local MCP health is degraded at '
          + localHealthUrl(host, port)
          + '; preserving the live Gateway and its sessions for at least '
          + remainingSeconds
          + 's while health recovers';
        console.error('[repo-harness mcp keepalive] ' + message);
        recordError('health', message);
        lastLocalHealthWarningAt = now;
      }
    }

    if (!(await probeLocalControllerHealth())) {
      if (localBridge) {
        try {
          await localBridge.close();
        } catch (_error) {
          // Ignore close errors; the next start attempt should reconcile the port.
        }
        localBridge = undefined;
      }
      await startLocalController();
      await probeLocalControllerHealth();
      updateStatus();
      persistRuntime();
    }

    const activePublicEndpoint = tunnelMode === 'named'
      ? configuredEndpoint
      : currentQuickEndpoint ?? runtime.tunnel?.publicEndpoint;

    if (runtime.tunnel) {
      runtime.tunnel.publicEndpoint = activePublicEndpoint ?? runtime.tunnel.publicEndpoint;
    }

    if (runtime.tunnelMode !== 'none' && activePublicEndpoint) {
      const publicHealth = await jsonHealth(oauthResourceUrl(activePublicEndpoint));
      runtime.tunnel!.healthy = publicHealth?.resource === activePublicEndpoint;
      if (runtime.tunnel!.healthy) {
        runtime.tunnel!.lastHealthyAt = nowIso();
        publicFailureCount = 0;
        publicUnhealthySinceAt = undefined;
        lastPublicHealthWarningAt = undefined;
      } else {
        const now = Date.now();
        publicFailureCount += 1;
        publicUnhealthySinceAt ??= now;
        if (shouldRestartMcpTunnel(
          localHealthy,
          isRunning(tunnelChild),
          publicFailureCount,
          publicUnhealthySinceAt,
          now,
          tunnelUnhealthyRestartWindowMs,
        )) {
          await restartTunnel(`public MCP discovery failed continuously at ${oauthResourceUrl(activePublicEndpoint)}`);
          publicFailureCount = 0;
          publicUnhealthySinceAt = undefined;
          lastPublicHealthWarningAt = undefined;
          updateStatus();
          persistRuntime();
          continue;
        }
        if (lastPublicHealthWarningAt === undefined || now - lastPublicHealthWarningAt >= LOCAL_HEALTH_WARNING_INTERVAL_MS) {
          const reason = localHealthy
            ? 'preserving the live tunnel during the bounded recovery window'
            : 'preserving the live tunnel because the local Gateway is unhealthy';
          recordError('health', `public MCP discovery is degraded at ${oauthResourceUrl(activePublicEndpoint)}; ${reason}`);
          lastPublicHealthWarningAt = now;
        }
      }
    } else if (runtime.tunnelMode !== 'none') {
      runtime.tunnel!.healthy = false;
    }

    updateStatus();
    persistRuntime();
    await sleep(checkIntervalMs);
  }
}
