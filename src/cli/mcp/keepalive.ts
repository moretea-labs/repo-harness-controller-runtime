import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { accessSync, constants } from 'fs';
import { resolve } from 'path';
import {
  loadMcpServiceLocalConfig,
  loadMcpServiceRuntimeState,
  mcpControllerHomeRuntimeStatePath,
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
import { controllerToolNamesForToolset } from './toolset';
import { parseMcpToolset } from './multi-repository';
import { applyDirectNetworkProxyBypass, withDirectNetworkProxyBypass } from './proxy-env';
import { runtimeToolDefinitions } from '../../runtime/gateway/mcp/runtime-tools';

export interface McpKeepaliveOptions extends McpServerOptions {
  repo?: string;
  host?: string;
  port?: number;
  auth?: string;
  tunnel?: string;
  cloudflaredBin?: string;
  tailscaleBin?: string;
  cloudflareTunnelName?: string;
  publicEndpoint?: string;
  checkIntervalMs?: number;
  restartDelayMs?: number;
  unhealthyRestartWindowMs?: number;
  tunnelUnhealthyRestartWindowMs?: number;
  toolset?: 'core' | 'advanced' | 'full' | string;
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

/**
 * Detect bind failures such as Bun/Node "Failed to start server. Is port 8765 in use?".
 * These must fail-fast instead of thrashing KeepAlive restarts against a foreign owner.
 */
export function isAddressInUseFailure(message: string | undefined): boolean {
  if (!message) return false;
  return /eaddrinuse|address already in use|port\s+\d+\s+(is\s+)?in use|failed to start server.*port/i.test(message);
}

export interface McpExpectedHealthIdentity {
  toolSurface: string;
  schemaVersion: number;
  toolSurfaceVersion: number;
  toolSurfaceFingerprint?: string;
  runtimeToolSurfaceFingerprint?: string;
  toolset: string;
  profile: string;
  repoId?: string;
}

export type McpPortOwnershipDecision =
  | { action: 'free' }
  | { action: 'takeover'; pid: number }
  | { action: 'abort'; reason: string };

export function decideMcpPortOwnership(input: {
  health: Record<string, unknown> | null | undefined;
  expected: McpExpectedHealthIdentity;
  previousOwnedPid?: number;
  previousOwnedInstanceId?: string;
  isPidAlive?: (pid: number | undefined) => boolean;
}): McpPortOwnershipDecision {
  const health = input.health;
  if (!health || health.status !== 'ok' || health.server !== 'repo-harness-mcp') {
    return { action: 'free' };
  }

  const pidAlive = input.isPidAlive ?? ((pid) => {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  });

  const matches = health.toolSurface === input.expected.toolSurface
    && health.schemaVersion === input.expected.schemaVersion
    && health.toolSurfaceVersion === input.expected.toolSurfaceVersion
    && (input.expected.toolSurfaceFingerprint === undefined
      || health.toolSurfaceFingerprint === input.expected.toolSurfaceFingerprint)
    && (input.expected.runtimeToolSurfaceFingerprint === undefined
      || health.runtimeToolSurfaceFingerprint === input.expected.runtimeToolSurfaceFingerprint)
    && health.toolset === input.expected.toolset
    && health.profile === input.expected.profile
    && (input.expected.repoId === undefined || health.repoId === input.expected.repoId);

  const previousPid = input.previousOwnedPid;
  const previousInstanceId = input.previousOwnedInstanceId?.trim();
  const healthInstanceId = typeof health.instanceId === 'string' ? health.instanceId.trim() : '';
  // A persisted PID can be reused by the OS. Only take over when the process
  // answering this health request proves the same opaque supervisor instance.
  if (
    previousPid
    && previousInstanceId
    && healthInstanceId === previousInstanceId
    && pidAlive(previousPid)
  ) {
    return { action: 'takeover', pid: previousPid };
  }
  if (!matches) {
    return {
      action: 'abort',
      reason: `port is occupied by an incompatible MCP server (surface=${String(health.toolSurface ?? 'unknown')}, schema=${String(health.schemaVersion ?? 'unknown')}, version=${String(health.toolSurfaceVersion ?? 'unknown')}, fingerprint=${String(health.toolSurfaceFingerprint ?? 'unknown')}, profile=${String(health.profile ?? 'unknown')}, toolset=${String(health.toolset ?? 'unknown')}). Stop the other Gateway or choose another port. One MCP control plane should operate multiple repositories; do not run a second keepalive against the same port.`,
    };
  }
  return {
    action: 'abort',
    reason: 'port already has a compatible repo-harness MCP server that is not owned by this keepalive process. Stop it before starting a new supervisor, or attach to the existing single control plane.',
  };
}

export function mcpServerRestartDelayMs(
  childRunning: boolean,
  restartDelayMs = DEFAULT_RESTART_DELAY_MS,
): number {
  return childRunning ? restartDelayMs : 0;
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

function isPlaceholderPublicEndpointHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.includes('example.com') || host.includes('example.org') || host.includes('example.net')) return true;
  if (host.includes('<') || host.includes('>') || host.includes('named-tunnel-host')) return true;
  return false;
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
  // Setup placeholders must not become live ChatGPT Connector endpoints.
  if (isPlaceholderPublicEndpointHost(parsed.hostname)) return undefined;
  return parsed.toString();
}

export function inferMcpTunnelMode(
  requested: string | undefined,
  publicEndpoint: string | undefined,
  tunnelName: string | undefined,
): McpRuntimeTunnelMode {
  const normalized = requested?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0 || normalized === 'auto') {
    if (publicEndpoint && tunnelName) return 'named';
    if (publicEndpoint) return 'none';
    return 'quick';
  }
  if (normalized === 'none' || normalized === 'quick' || normalized === 'named' || normalized === 'tailscale') return normalized;
  throw new Error(`invalid --tunnel "${requested}" (expected: auto, none, quick, named, tailscale)`);
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

function resolveExecutableBinary(input: string | undefined, defaultCommand: string, label: string): string {
  const candidate = input?.trim() || defaultCommand;
  if (candidate.includes('/') || candidate.includes('\\')) {
    accessSync(candidate, constants.X_OK);
    return candidate;
  }
  const resolved = Bun.which(candidate);
  if (!resolved) throw new Error(`${label} binary was not found on PATH (tried "${candidate}")`);
  return resolved;
}

function resolveCloudflaredBinary(input: string | undefined): string {
  return resolveExecutableBinary(input, 'cloudflared', 'cloudflared');
}

function resolveTailscaleBinary(input: string | undefined): string {
  return resolveExecutableBinary(input, 'tailscale', 'tailscale');
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
  // System HTTP proxies must not intercept MagicDNS / Funnel / loopback health checks.
  applyDirectNetworkProxyBypass(process.env);

  const repoRoot = resolveMcpRepoRoot(rawOpts.repo ?? '.');
  const controllerHome = ensureControllerHome(rawOpts.controllerHome);
  const serviceConfig = loadMcpServiceLocalConfig(controllerHome, repoRoot);
  const profile = rawOpts.profile ?? serviceConfig?.profile ?? 'controller';
  const localConfig = serviceConfig;
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
    ? (() => {
      const restricted = controllerToolNamesForToolset(toolset);
      if (restricted === null) {
        return [...compatibilityToolNames, ...runtimeToolDefinitions.map((tool) => tool.name)];
      }
      return [...restricted];
    })()
    : [];
  const expectedRuntimeToolSurfaceFingerprint = profile === 'controller'
    ? controllerToolSurfaceFingerprint(expectedRuntimeToolNames)
    : undefined;
  const expectedRepoId = profile === 'controller' ? undefined : repositoryIdentity(repoRoot);
  const previousRuntime = loadMcpServiceRuntimeState(controllerHome, repoRoot);
  const expectedHealthIdentity: McpExpectedHealthIdentity = {
    toolSurface: expectedToolSurface,
    schemaVersion: expectedSchemaVersion,
    toolSurfaceVersion: expectedToolSurfaceVersion,
    toolSurfaceFingerprint: expectedToolSurfaceFingerprint,
    runtimeToolSurfaceFingerprint: expectedRuntimeToolSurfaceFingerprint,
    toolset,
    profile,
    repoId: expectedRepoId,
  };
  const existingHealth = await jsonHealth(localHealthUrl(host, port));
  const ownership = decideMcpPortOwnership({
    health: existingHealth,
    expected: expectedHealthIdentity,
    previousOwnedPid: previousRuntime?.server.pid,
    previousOwnedInstanceId: previousRuntime?.server.instanceId,
    isPidAlive,
  });
  if (ownership.action === 'takeover') {
    console.error(`[repo-harness mcp keepalive] Replacing previous repo-harness MCP process ${ownership.pid}.`);
    await stopPid(ownership.pid);
    await sleep(250);
  } else if (ownership.action === 'abort') {
    throw new Error(`port ${port}: ${ownership.reason}`);
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
    throw new Error('named tunnel mode requires --public-endpoint or chatgpt.endpoint in controllerHome/mcp/mcp.local.json');
  }
  if (tunnelMode === 'named' && !tunnelName) {
    throw new Error('named tunnel mode requires --cloudflare-tunnel-name');
  }
  if (tunnelMode === 'tailscale' && !configuredEndpoint) {
    throw new Error('tailscale tunnel mode requires --public-endpoint or chatgpt.endpoint in controllerHome/mcp/mcp.local.json');
  }
  const cloudflaredBin = tunnelMode === 'quick' || tunnelMode === 'named' ? resolveCloudflaredBinary(rawOpts.cloudflaredBin) : undefined;
  const tailscaleBin = tunnelMode === 'tailscale' ? resolveTailscaleBinary(rawOpts.tailscaleBin) : undefined;
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
  let fatalPortConflict: string | undefined;
  let recentServeStderr = '';
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
  let tailscaleFunnelConfigured = false;

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
    tunnel: tunnelMode === 'none' && !configuredEndpoint ? undefined : {
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
    writeMcpServiceRuntimeState(controllerHome, runtime);
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
    const publicHealthy = !configuredEndpoint || runtime.tunnel?.healthy === true;
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
    runtime.server.toolset = localHealth?.toolset === 'core' || localHealth?.toolset === 'advanced' || localHealth?.toolset === 'full'
      ? localHealth.toolset
      : undefined;
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
    if (tunnelMode !== 'none' && (tunnelMode === 'tailscale' ? !tailscaleFunnelConfigured : !isRunning(tunnelChild))) {
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
    recentServeStderr = '';
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
    // Prefer explicit CLI flags; otherwise honor controllerHome mcp.local.json devMode.
    const enableDevRunner = rawOpts.enableDevRunner === true || localConfig?.devMode?.agentRunner === true;
    if (enableDevRunner) args.push('--enable-dev-runner');
    const devRunnerAgents = rawOpts.devRunnerAgents
      ?? (localConfig?.devMode?.allowedAgents?.length ? localConfig.devMode.allowedAgents.join(',') : undefined);
    if (devRunnerAgents) args.push('--dev-runner-agents', devRunnerAgents);
    const devRunnerTimeoutMs = rawOpts.devRunnerTimeoutMs ?? localConfig?.devMode?.timeoutMs;
    if (devRunnerTimeoutMs) args.push('--dev-runner-timeout-ms', String(devRunnerTimeoutMs));
    const devRunnerMaxTimeoutMs = rawOpts.devRunnerMaxTimeoutMs ?? localConfig?.devMode?.maxTimeoutMs;
    if (devRunnerMaxTimeoutMs) args.push('--dev-runner-max-timeout-ms', String(devRunnerMaxTimeoutMs));
    const instanceId = randomUUID();
    const env: NodeJS.ProcessEnv = {
      ...withDirectNetworkProxyBypass(process.env),
      REPO_HARNESS_CONTROLLER_HOME: controllerHome,
      REPO_HARNESS_MCP_INSTANCE_ID: instanceId,
    };
    if (configuredEndpoint) {
      env.REPO_HARNESS_MCP_PUBLIC_ORIGIN = endpointOrigin(configuredEndpoint);
    }
    serverChild = spawn(cli.command, args, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runtime.server.running = true;
    runtime.server.pid = serverChild.pid;
    runtime.server.instanceId = instanceId;
    runtime.server.lastStartAt = nowIso();
    if (isRestart) runtime.server.restartCount += 1;
    attachLineLogging(serverChild, 'serve', (line) => {
      // Bound recent serve output so bind failures like "port already in use"
      // can fail-fast instead of thrashing KeepAlive restarts.
      recentServeStderr = `${recentServeStderr}\n${line}`.slice(-4_000);
      if (isAddressInUseFailure(line)) {
        fatalPortConflict = `port ${port} is already in use (${line.trim()})`;
      }
    });
    serverChild.once('exit', (code, signal) => {
      runtime.server.running = false;
      runtime.server.healthy = false;
      runtime.server.pid = undefined;
      runtime.server.lastExitAt = nowIso();
      runtime.server.lastExit = summarizeExit(code, signal);
      updateStatus();
      persistRuntime();
      if (!stopping) {
        const exitMessage = `mcp serve exited (${runtime.server.lastExit})`;
        if (isAddressInUseFailure(recentServeStderr) || isAddressInUseFailure(fatalPortConflict)) {
          fatalPortConflict = fatalPortConflict
            ?? `port ${port} is already in use; mcp serve exited without binding`;
          recordError('config', `${exitMessage}; ${fatalPortConflict}`);
        } else {
          recordError('server', exitMessage);
        }
      }
    });
    updateStatus();
    persistRuntime();
  };

  const spawnTunnel = (isRestart: boolean): void => {
    if (tunnelMode === 'none') return;
    const command = tunnelMode === 'tailscale' ? tailscaleBin : cloudflaredBin;
    if (!command) return;
    const args = tunnelMode === 'tailscale'
      ? ['funnel', '--bg', String(port)]
      : tunnelMode === 'quick'
        ? ['tunnel', '--protocol', 'http2', '--url', `http://${host}:${port}`]
        : ['tunnel', 'run', '--url', `http://${host}:${port}`, tunnelName as string];
    tunnelChild = spawn(command, args, {
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
        runtime.tunnel.running = tunnelMode === 'tailscale' && code === 0;
        runtime.tunnel.healthy = tunnelMode === 'tailscale' && code === 0 ? runtime.tunnel.healthy : false;
        runtime.tunnel.pid = undefined;
        runtime.tunnel.lastExitAt = nowIso();
        runtime.tunnel.lastExit = summarizeExit(code, signal);
      }
      if (tunnelMode === 'tailscale' && code === 0) {
        tailscaleFunnelConfigured = true;
      }
      updateStatus();
      persistRuntime();
      if (!stopping && !(tunnelMode === 'tailscale' && code === 0)) {
        recordError('tunnel', (tunnelMode === 'tailscale' ? 'tailscale' : 'cloudflared') + ' exited (' + summarizeExit(code, signal) + ')');
      }
    });
    updateStatus();
    persistRuntime();
  };

  const restartTunnel = async (reason: string): Promise<void> => {
    if (runtime.tunnelMode === 'none') return;
    recordError('tunnel', reason);
    await stopChild(tunnelChild, tunnelMode === 'tailscale' ? 'tailscale' : 'cloudflared');
    tunnelChild = undefined;
    if (runtime.tunnelMode === 'quick') {
      currentQuickEndpoint = undefined;
      if (runtime.tunnel) runtime.tunnel.healthy = false;
    }
    if (runtime.tunnelMode === 'tailscale') {
      tailscaleFunnelConfigured = false;
      if (runtime.tunnel) runtime.tunnel.healthy = false;
    }
    await sleep(restartDelayMs);
    spawnTunnel(true);
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
    await stopChild(tunnelChild, tunnelMode === 'tailscale' ? 'tailscale' : 'cloudflared');
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

  const abortForPortConflict = async (reason: string): Promise<never> => {
    fatalPortConflict = reason;
    recordError('config', reason);
    console.error(`[repo-harness mcp keepalive] FAIL-FAST: ${reason}`);
    await shutdown();
    throw new Error(reason);
  };

  const ensurePortOwnershipOrAbort = async (): Promise<void> => {
    const health = await jsonHealth(localHealthUrl(host, port));
    const decision = decideMcpPortOwnership({
      health,
      expected: expectedHealthIdentity,
      previousOwnedPid: runtime.server.pid ?? previousRuntime?.server.pid,
      isPidAlive,
    });
    if (decision.action === 'takeover') {
      console.error(`[repo-harness mcp keepalive] Replacing previous repo-harness MCP process ${decision.pid}.`);
      await stopPid(decision.pid);
      await sleep(250);
      return;
    }
    if (decision.action === 'abort') {
      await abortForPortConflict(`port ${port}: ${decision.reason}`);
    }
  };

  const restartServer = async (reason: string): Promise<void> => {
    if (fatalPortConflict) {
      await abortForPortConflict(fatalPortConflict);
    }
    if (isAddressInUseFailure(reason) || isAddressInUseFailure(recentServeStderr)) {
      await abortForPortConflict(
        `port ${port} is already in use by another process; refusing restart thrash. `
        + 'One MCP control plane should serve multiple repositories from the product source repo. '
        + `Details: ${reason}`,
      );
    }
    // Before respawning, re-check that we still own (or can claim) the port.
    // A foreign healthy Gateway must never be fought with blind KeepAlive restarts.
    if (!isRunning(serverChild)) {
      await ensurePortOwnershipOrAbort();
    }
    const restartDelay = mcpServerRestartDelayMs(isRunning(serverChild), restartDelayMs);
    recordError('server', reason);
    // Keep the tunnel process and public URL alive while the local Gateway is
    // replaced. cloudflared will reconnect to the same local port, avoiding a
    // quick-tunnel URL rotation and preserving the Connector endpoint.
    await stopChild(serverChild, 'mcp serve');
    serverChild = undefined;
    runtime.server.running = false;
    runtime.server.healthy = false;
    if (restartDelay > 0) await sleep(restartDelay);
    spawnServer(true);
    await warmServerHealth();
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
  console.error(`[repo-harness mcp keepalive] Runtime state: ${mcpControllerHomeRuntimeStatePath(controllerHome)}`);
  persistRuntime();

  await startLocalController();
  spawnServer(false);
  await warmServerHealth();

  while (!stopping) {
    if (fatalPortConflict) {
      await abortForPortConflict(fatalPortConflict);
    }
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
        await restartServer(
          isAddressInUseFailure(recentServeStderr) || isAddressInUseFailure(fatalPortConflict)
            ? (fatalPortConflict ?? `port ${port} is already in use`)
            : `local MCP health failed at ${localHealthUrl(host, port)}`,
        );
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

    const activePublicEndpoint = tunnelMode === 'named' || tunnelMode === 'tailscale' || tunnelMode === 'none'
      ? configuredEndpoint
      : currentQuickEndpoint ?? runtime.tunnel?.publicEndpoint;

    if (runtime.tunnel) {
      runtime.tunnel.publicEndpoint = activePublicEndpoint ?? runtime.tunnel.publicEndpoint;
    }

    if (activePublicEndpoint && runtime.tunnel) {
      const publicHealth = await jsonHealth(oauthResourceUrl(activePublicEndpoint));
      runtime.tunnel.healthy = publicHealth?.resource === activePublicEndpoint;
      if (runtime.tunnel.healthy) {
        runtime.tunnel.lastHealthyAt = nowIso();
        publicFailureCount = 0;
        publicUnhealthySinceAt = undefined;
        lastPublicHealthWarningAt = undefined;
      } else {
        const now = Date.now();
        publicFailureCount += 1;
        publicUnhealthySinceAt ??= now;
        if (tunnelMode !== 'none' && shouldRestartMcpTunnel(
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
          const reason = tunnelMode === 'none'
            ? 'operator-managed fixed endpoint is not restarted by keepalive'
            : localHealthy
              ? 'preserving the live tunnel during the bounded recovery window'
              : 'preserving the live tunnel because the local Gateway is unhealthy';
          recordError('health', `public MCP discovery is degraded at ${oauthResourceUrl(activePublicEndpoint)}; ${reason}`);
          lastPublicHealthWarningAt = now;
        }
      }
    } else if (runtime.tunnel) {
      runtime.tunnel.healthy = false;
    }

    updateStatus();
    persistRuntime();
    await sleep(checkIntervalMs);
  }
}
