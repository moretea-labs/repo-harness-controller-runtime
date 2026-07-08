import { spawn } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { runProcess } from '../../effects/process-runner';
import {
  loadMcpServiceLocalConfig,
  loadMcpServiceRuntimeState,
  mcpControllerHomeOAuthPath,
  mcpControllerHomeTokenPath,
  type McpRuntimeState,
} from './auth';
import {
  inferMcpTunnelMode,
  normalizeKeepalivePublicEndpoint,
  resolveSelfCliInvocation,
} from './keepalive';
import { resolveMcpRepoRoot } from './repo';
import { runMcpDoctor, runMcpSetupChatgpt, runMcpSetupCodex, type McpSetupResult } from './setup';
import { CONTROLLER_TOOL_SURFACE } from '../controller/runtime-config';
import { ensureControllerHome } from '../repositories/controller-home';
import { getGitHubPluginStatus, loadGitHubPluginConfig, saveGitHubPluginConfig } from '../github/plugin';

const LOCAL_HEALTH_TIMEOUT_MS = 4_000;
const STARTUP_WAIT_ATTEMPTS = 160;
const STARTUP_WAIT_INTERVAL_MS = 250;
const TOOLS_SMOKE_ATTEMPTS = 20;
const TOOLS_SMOKE_INTERVAL_MS = 500;
const REQUIRED_RESTART_TOOLS = [
  'controller_capabilities',
  'repository_latest_source_diagnose',
  'repository_bootstrap_local_project',
] as const;

export interface McpRestartOptions {
  repo?: string;
  logFile?: string;
  skipCodexSetup?: boolean;
  skipPublicCheck?: boolean;
  skipToolsSmoke?: boolean;
  skipGithubPlugin?: boolean;
  githubRepo?: string;
  githubSyncMode?: string;
  githubIncludeTasks?: boolean;
}

interface McpDoctorReport {
  chatgpt?: {
    defaultServerName?: string;
    expectedToolSurface?: string;
    serverName?: string;
  };
}

interface ResolvedMcpRestartConfig {
  repoRoot: string;
  host: string;
  port: number;
  profile: string;
  authMode: string;
  publicEndpoint?: string;
  defaultServerName: string;
  expectedToolSurface: string;
  devRunner: boolean;
  devRunnerAgents: string[];
  devRunnerTimeoutMs: number;
  devRunnerMaxTimeoutMs: number;
  localUiEnabled: boolean;
  localUiHost: string;
  localUiPort: number;
  localUiAutoOpen: boolean;
  tunnelMode: 'none' | 'quick' | 'named';
  tunnelName?: string;
  oauthFile: string;
  tokenFile: string;
  stdoutLogPath: string;
  stderrLogPath: string;
}

interface PublicSurfaceCheck {
  endpoint: string;
  toolSurface: string;
}

interface ToolsSmokeCheck {
  toolCount: number;
  expectedTools: string[];
}

interface GitHubPluginSummary {
  enabled: boolean | 'skipped';
  syncMode: string;
  includeTasks: boolean | 'skipped';
  ready: boolean | 'skipped';
}

interface RepoLaunchAgent {
  label: string;
  plistPath: string;
}

export function defaultMcpRestartLogPath(repoRoot: string): string {
  return join(repoRoot, '.ai', 'local', 'logs', 'repo-harness-mcp.log');
}

export function shouldVerifyPublicSurface(config: {
  tunnelMode: ResolvedMcpRestartConfig['tunnelMode'];
  publicEndpoint?: string;
}): boolean {
  return config.tunnelMode !== 'none' && Boolean(config.publicEndpoint);
}

export function buildMcpRestartKeepaliveArgs(config: ResolvedMcpRestartConfig): string[] {
  const args = [
    'mcp',
    'keepalive',
    '--repo',
    config.repoRoot,
    '--host',
    config.host,
    '--port',
    String(config.port),
    '--profile',
    config.profile,
    '--auth',
    config.authMode,
    '--tunnel',
    config.tunnelMode,
  ];

  if (config.devRunner) {
    args.push('--enable-dev-runner');
    if (config.devRunnerAgents.length > 0) {
      args.push('--dev-runner-agents', config.devRunnerAgents.join(','));
    }
    args.push('--dev-runner-timeout-ms', String(config.devRunnerTimeoutMs));
    args.push('--dev-runner-max-timeout-ms', String(config.devRunnerMaxTimeoutMs));
  }

  if (config.localUiEnabled) {
    args.push('--local-ui-host', config.localUiHost, '--local-ui-port', String(config.localUiPort));
    if (config.localUiAutoOpen) args.push('--open-local-ui');
  } else {
    args.push('--no-local-ui');
  }

  if (config.tunnelMode === 'named') {
    if (config.tunnelName) args.push('--cloudflare-tunnel-name', config.tunnelName);
    if (config.publicEndpoint) args.push('--public-endpoint', config.publicEndpoint);
  } else if (config.tunnelMode === 'quick' && config.publicEndpoint) {
    args.push('--public-endpoint', config.publicEndpoint);
  }

  return args;
}

function localHealthUrl(host: string, port: number): string {
  return `http://${host}:${port}/health`;
}

function localControllerUrl(host: string, port: number): string {
  return `http://${host}:${port}/`;
}

function processMatchesRepoHarness(commandLine: string, repoRoot: string): boolean {
  if (!commandLine.includes(repoRoot)) return false;
  return commandLine.includes('repo-harness')
    || commandLine.includes('/src/cli/index.ts')
    || commandLine.includes('/src/cli/hook-entry.ts');
}

export interface McpProcessBindingConfig {
  repoRoot: string;
  host: string;
  port: number;
  profile: string;
}

function normalizeCommandPath(value: string | undefined): string | undefined {
  return value?.replace(/\\/g, '/').replace(/\/+$/, '');
}

function extractCommandFlag(commandLine: string, flag: string): string | undefined {
  const escaped = flag.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return commandLine.match(new RegExp(escaped + '\\s+([^\\s]+)'))?.[1];
}

function commandHost(commandLine: string): string {
  return extractCommandFlag(commandLine, '--host') ?? '127.0.0.1';
}

function commandPort(commandLine: string): number {
  const parsed = Number(extractCommandFlag(commandLine, '--port') ?? '8765');
  return Number.isInteger(parsed) ? parsed : 0;
}

function commandProfile(commandLine: string): string {
  return extractCommandFlag(commandLine, '--profile') ?? 'controller';
}

export function isPeerMcpProcessForBinding(commandLine: string, config: McpProcessBindingConfig): boolean {
  if (!commandLine.includes('mcp keepalive') && !commandLine.includes('mcp serve')) return false;
  const processRepo = normalizeCommandPath(extractCommandFlag(commandLine, '--repo'));
  const currentRepo = normalizeCommandPath(config.repoRoot);
  if (!processRepo || !currentRepo || processRepo === currentRepo) return false;
  return commandHost(commandLine) === config.host
    && commandPort(commandLine) === config.port
    && commandProfile(commandLine) === config.profile;
}

export function isStaleControllerDaemonForRestart(commandLine: string, repoRoot: string): boolean {
  if (!commandLine.includes('daemon-entry.ts')) return false;
  const controllerHome = normalizeCommandPath(extractCommandFlag(commandLine, '--controller-home'));
  const currentRepo = normalizeCommandPath(repoRoot);
  if (!controllerHome || !currentRepo) return false;
  const currentControllerHome = currentRepo + '/_ops/controller-home';
  if (controllerHome === currentControllerHome || controllerHome.startsWith(currentControllerHome + '/')) return false;
  return controllerHome.includes('/.ai/local/controller-home') || controllerHome.includes('/repo-harness-controller-home-');
}

function launchctlDomain(): string {
  const uid = typeof process.getuid === 'function'
    ? process.getuid()
    : Number(runProcess('id', ['-u'], { timeoutMs: 2_000, maxOutputBytes: 1024 }).stdout.trim());
  if (!Number.isInteger(uid) || uid < 0) {
    throw new Error('Unable to resolve current uid for launchctl.');
  }
  return `gui/${uid}`;
}

export function parseLaunchAgentLabel(plistText: string): string | undefined {
  const match = /<key>\s*Label\s*<\/key>\s*<string>([^<]+)<\/string>/i.exec(plistText);
  return match?.[1]?.trim() || undefined;
}

export function isRepoLaunchAgentPlist(plistText: string, repoRoot: string): boolean {
  if (!plistText.includes(repoRoot)) return false;
  return plistText.includes('repo-harness-mcp-launch.sh')
    || (plistText.includes('repo-harness') && plistText.includes('keepalive'));
}

function findRepoLaunchAgents(repoRoot: string): RepoLaunchAgent[] {
  const home = process.env.HOME?.trim();
  if (!home) return [];
  const launchAgentsDir = join(home, 'Library', 'LaunchAgents');
  if (!existsSync(launchAgentsDir)) return [];

  const agents: RepoLaunchAgent[] = [];
  for (const entry of readdirSync(launchAgentsDir)) {
    if (!entry.endsWith('.plist')) continue;
    const plistPath = join(launchAgentsDir, entry);
    let plistText = '';
    try {
      plistText = readFileSync(plistPath, 'utf-8');
    } catch (_error) {
      continue;
    }
    if (!isRepoLaunchAgentPlist(plistText, repoRoot)) continue;
    const label = parseLaunchAgentLabel(plistText);
    if (!label) continue;
    agents.push({ label, plistPath });
  }
  return agents;
}

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

async function jsonHealth(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_HEALTH_TIMEOUT_MS);
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

function isHealthyMcpSurface(
  payload: Record<string, unknown> | null,
  profile: string,
  expectedToolSurface: string,
): boolean {
  return payload?.status === 'ok'
    && payload.profile === profile
    && payload.toolSurface === expectedToolSurface;
}

function isHealthyLocalController(payload: Record<string, unknown> | null): boolean {
  return payload?.status === 'ok'
    && payload.toolSurface === CONTROLLER_TOOL_SURFACE;
}

function parseDoctorReport(raw: McpSetupResult): McpDoctorReport {
  return JSON.parse(raw.lines.join('\n')) as McpDoctorReport;
}

function resolveLogPaths(repoRoot: string, explicitLogFile?: string): { stdoutPath: string; stderrPath: string } {
  const combined = resolve(explicitLogFile ?? defaultMcpRestartLogPath(repoRoot));
  return { stdoutPath: combined, stderrPath: combined };
}

function resolveRestartConfig(repoRoot: string, explicitLogFile?: string): ResolvedMcpRestartConfig {
  const controllerHome = ensureControllerHome();
  const doctor = parseDoctorReport(runMcpDoctor({ repo: repoRoot, json: true }));
  const localConfig = loadMcpServiceLocalConfig(controllerHome, repoRoot);
  const runtime = loadMcpServiceRuntimeState(controllerHome, repoRoot);
  const publicEndpoint = normalizeKeepalivePublicEndpoint(localConfig?.chatgpt?.endpoint);
  const tunnelMode = inferMcpTunnelMode(
    runtime?.tunnelMode,
    publicEndpoint,
    runtime?.tunnel?.name,
  );
  const logs = resolveLogPaths(repoRoot, explicitLogFile);

  const defaultServerName = doctor.chatgpt?.defaultServerName?.trim();
  const expectedToolSurface = doctor.chatgpt?.expectedToolSurface?.trim();
  if (!defaultServerName || !expectedToolSurface) {
    throw new Error('Unable to resolve repo-harness MCP defaults from doctor output.');
  }

  return {
    repoRoot,
    host: localConfig?.server?.host ?? '127.0.0.1',
    port: localConfig?.server?.port ?? 8765,
    profile: localConfig?.profile ?? 'controller',
    authMode: localConfig?.auth?.mode ?? 'oauth',
    publicEndpoint,
    defaultServerName,
    expectedToolSurface,
    devRunner: localConfig?.devMode?.agentRunner === true,
    devRunnerAgents: localConfig?.devMode?.allowedAgents ?? ['codex'],
    devRunnerTimeoutMs: localConfig?.devMode?.timeoutMs ?? 3_600_000,
    devRunnerMaxTimeoutMs: localConfig?.devMode?.maxTimeoutMs ?? 43_200_000,
    localUiEnabled: localConfig?.localController?.enabled ?? true,
    localUiHost: localConfig?.localController?.host ?? '127.0.0.1',
    localUiPort: localConfig?.localController?.port ?? 8766,
    localUiAutoOpen: localConfig?.localController?.autoOpen ?? false,
    tunnelMode,
    tunnelName: runtime?.tunnel?.name,
    oauthFile: relative(repoRoot, mcpControllerHomeOAuthPath(controllerHome)),
    tokenFile: relative(repoRoot, mcpControllerHomeTokenPath(controllerHome)),
    stdoutLogPath: logs.stdoutPath,
    stderrLogPath: logs.stderrPath,
  };
}

function runLaunchctl(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = runProcess('launchctl', args, {
    timeoutMs: 10_000,
    maxOutputBytes: 256 * 1024,
  });
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function readLogTail(path: string, maxChars = 4000): string {
  try {
    const text = readFileSync(path, 'utf-8');
    return text.length <= maxChars ? text : text.slice(-maxChars);
  } catch (_error) {
    return '';
  }
}

async function stopPid(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (_error) {
    return;
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (_error) {
      return;
    }
    await sleep(100);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (_error) {
    // Already stopped.
  }
}

function collectRepoHarnessPids(config: McpProcessBindingConfig, runtime: McpRuntimeState | null): number[] {
  const repoRoot = config.repoRoot;
  const pids = new Set<number>();
  const addPid = (value: number | undefined): void => {
    if (!value || value === process.pid) return;
    pids.add(value);
  };

  addPid(runtime?.localController?.pid);
  addPid(runtime?.server?.pid);
  addPid(runtime?.tunnel?.pid);

  const ps = runProcess('ps', ['ax', '-o', 'pid=', '-o', 'command='], {
    timeoutMs: 5_000,
    maxOutputBytes: 512 * 1024,
  });
  if (!ps.ok) return Array.from(pids);

  for (const line of ps.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const commandLine = match[2];
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    const repoLocal = processMatchesRepoHarness(commandLine, repoRoot);
    const peerMcp = isPeerMcpProcessForBinding(commandLine, config);
    const staleDaemon = isStaleControllerDaemonForRestart(commandLine, repoRoot);
    if (!repoLocal && !peerMcp && !staleDaemon) continue;
    if (
      staleDaemon
      || peerMcp
      || commandLine.includes('mcp keepalive')
      || commandLine.includes('mcp serve')
      || commandLine.includes('controller ui')
    ) {
      pids.add(pid);
    }
  }

  return Array.from(pids);
}

function collectKeepalivePids(repoRoot: string): number[] {
  const ps = runProcess('ps', ['ax', '-o', 'pid=', '-o', 'command='], {
    timeoutMs: 5_000,
    maxOutputBytes: 512 * 1024,
  });
  if (!ps.ok) return [];

  const pids: number[] = [];
  for (const line of ps.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const commandLine = match[2];
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    if (!processMatchesRepoHarness(commandLine, repoRoot)) continue;
    if (commandLine.includes('mcp keepalive')) pids.push(pid);
  }
  return pids;
}

async function stopRepoHarnessProcesses(configOrRepoRoot: McpProcessBindingConfig | string, runtime: McpRuntimeState | null): Promise<number[]> {
  const config = typeof configOrRepoRoot === 'string'
    ? { repoRoot: configOrRepoRoot, host: '127.0.0.1', port: 8765, profile: 'controller' }
    : configOrRepoRoot;
  const pids = collectRepoHarnessPids(config, runtime);
  for (const pid of pids) await stopPid(pid);
  return pids;
}

function bootoutRepoLaunchAgents(agents: RepoLaunchAgent[]): string[] {
  const lines: string[] = [];
  if (agents.length === 0) return lines;
  const domain = launchctlDomain();
  for (const agent of agents) {
    const result = runLaunchctl(['bootout', domain, agent.plistPath]);
    if (!result.ok) {
      const detail = (result.stderr || result.stdout).trim();
      if (!/not loaded|no such process|service could not be found|could not find service|input\/output error/i.test(detail)) {
        throw new Error(`launchctl bootout failed for ${agent.label}: ${detail || 'unknown error'}`);
      }
    }
    lines.push(`[repo-harness restart] launchd bootout: ${agent.label}`);
  }
  return lines;
}

function bootstrapRepoLaunchAgents(agents: RepoLaunchAgent[]): string[] {
  const lines: string[] = [];
  if (agents.length === 0) return lines;
  const domain = launchctlDomain();
  for (const agent of agents) {
    const bootstrap = runLaunchctl(['bootstrap', domain, agent.plistPath]);
    if (!bootstrap.ok) {
      const detail = (bootstrap.stderr || bootstrap.stdout).trim();
      throw new Error(`launchctl bootstrap failed for ${agent.label}: ${detail || 'unknown error'}`);
    }
    const kickstart = runLaunchctl(['kickstart', '-k', `${domain}/${agent.label}`]);
    if (!kickstart.ok) {
      const detail = (kickstart.stderr || kickstart.stdout).trim();
      if (!/timed out|service could not be found|could not find service|no such process|operation now in progress/i.test(detail)) {
        throw new Error(`launchctl kickstart failed for ${agent.label}: ${detail || 'unknown error'}`);
      }
    }
    lines.push(`[repo-harness restart] launchd restart: ${agent.label}`);
  }
  return lines;
}

function spawnDetached(command: string, args: string[], cwd: string, stdoutPath: string, stderrPath: string): number {
  mkdirSync(dirname(stdoutPath), { recursive: true });
  mkdirSync(dirname(stderrPath), { recursive: true });
  const stdoutFd = openSync(stdoutPath, 'a');
  const stderrFd = openSync(stderrPath, 'a');
  try {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env: process.env,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
    child.unref();
    if (!child.pid) throw new Error('detached process did not return a pid');
    return child.pid;
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

async function waitForMcpHealth(config: ResolvedMcpRestartConfig): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < STARTUP_WAIT_ATTEMPTS; attempt += 1) {
    const payload = await jsonHealth(localHealthUrl(config.host, config.port));
    if (payload && isHealthyMcpSurface(payload, config.profile, config.expectedToolSurface)) {
      return payload;
    }
    await sleep(STARTUP_WAIT_INTERVAL_MS);
  }

  const tail = readLogTail(config.stderrLogPath);
  throw new Error(
    `Local MCP health did not become ready at ${localHealthUrl(config.host, config.port)}.` + (tail ? `\n${tail}` : ''),
  );
}

async function waitForLocalController(config: ResolvedMcpRestartConfig): Promise<void> {
  if (!config.localUiEnabled) return;
  const url = `${localControllerUrl(config.localUiHost, config.localUiPort)}health`;
  for (let attempt = 0; attempt < STARTUP_WAIT_ATTEMPTS; attempt += 1) {
    const payload = await jsonHealth(url);
    if (isHealthyLocalController(payload)) return;
    await sleep(STARTUP_WAIT_INTERVAL_MS);
  }
  throw new Error(`Local Controller did not become ready at ${localControllerUrl(config.localUiHost, config.localUiPort)}`);
}

function parseEventStreamPayload(text: string): Record<string, unknown> {
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : text) as Record<string, unknown>;
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function oauthAccessToken(baseUrl: string, oauthPath: string): Promise<string> {
  const oauth = JSON.parse(readFileSync(oauthPath, 'utf-8')) as { passphrase?: string };
  if (!oauth.passphrase) throw new Error(`Missing passphrase in ${oauthPath}`);

  const registered = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['http://localhost/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'repo-harness-restart-smoke',
    }),
  });
  if (registered.status !== 201) throw new Error(`register failed: ${registered.status}`);
  const client = await registered.json() as { client_id: string };
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challengeBuffer = await crypto.subtle.digest('SHA-256', Buffer.from(verifier));
  const challenge = b64url(new Uint8Array(challengeBuffer));
  const authorized = await fetch(`${baseUrl}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      passphrase: oauth.passphrase,
      client_id: client.client_id,
      redirect_uri: 'http://localhost/callback',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'repo-harness-restart-smoke',
    }),
    redirect: 'manual',
  });
  if (authorized.status !== 302) throw new Error(`authorize failed: ${authorized.status}`);
  const redirectLocation = authorized.headers.get('location');
  if (!redirectLocation) throw new Error('authorize did not provide a redirect location');
  const code = new URL(redirectLocation).searchParams.get('code');
  if (!code) throw new Error('authorize redirect did not include a code');
  const tokenResponse = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: 'http://localhost/callback',
    }),
  });
  if (tokenResponse.status !== 200) throw new Error(`token failed: ${tokenResponse.status}`);
  const tokenJson = await tokenResponse.json() as { access_token?: string };
  if (!tokenJson.access_token) throw new Error('token response did not include an access_token');
  return tokenJson.access_token;
}

async function runToolsSmoke(config: ResolvedMcpRestartConfig): Promise<ToolsSmokeCheck> {
  const baseUrl = `http://${config.host}:${config.port}`;
  const oauthPath = join(config.repoRoot, config.oauthFile);
  const tokenPath = join(config.repoRoot, config.tokenFile);

  for (let attempt = 0; attempt < TOOLS_SMOKE_ATTEMPTS; attempt += 1) {
    try {
      const accessToken = config.authMode === 'oauth'
        ? await oauthAccessToken(baseUrl, oauthPath)
        : (JSON.parse(readFileSync(tokenPath, 'utf-8')) as { bearerToken?: string }).bearerToken;
      if (!accessToken) throw new Error(`Missing bearer token in ${tokenPath}`);

      const initializeResponse = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'repo-harness-restart-smoke', version: '1.0.0' },
          },
        }),
      });
      if (initializeResponse.status !== 200) throw new Error(`initialize failed: ${initializeResponse.status}`);
      const sessionId = initializeResponse.headers.get('mcp-session-id');
      await initializeResponse.text();

      await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      });

      const toolsResponse = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      if (toolsResponse.status !== 200) throw new Error(`tools/list failed: ${toolsResponse.status}`);
      const payload = parseEventStreamPayload(await toolsResponse.text());
      const tools = Array.isArray((payload.result as { tools?: unknown[] } | undefined)?.tools)
        ? ((payload.result as { tools: Array<{ name?: string }> }).tools)
        : [];
      const names = tools.map((tool) => tool.name).filter((name): name is string => typeof name === 'string');
      const missing = REQUIRED_RESTART_TOOLS.filter((tool) => !names.includes(tool));
      if (missing.length > 0) {
        throw new Error(`missing expected tools: ${missing.join(', ')}`);
      }
      return { toolCount: names.length, expectedTools: [...REQUIRED_RESTART_TOOLS] };
    } catch (error) {
      if (attempt === TOOLS_SMOKE_ATTEMPTS - 1) throw error;
      await sleep(TOOLS_SMOKE_INTERVAL_MS);
    }
  }

  throw new Error('MCP tools smoke check failed after retries.');
}

async function verifyPublicSurface(config: ResolvedMcpRestartConfig): Promise<PublicSurfaceCheck | undefined> {
  const publicEndpoint = config.publicEndpoint;
  if (!shouldVerifyPublicSurface(config) || !publicEndpoint) return undefined;
  const response = await fetch(publicEndpoint, { method: 'HEAD', redirect: 'manual' });
  const toolSurface = response.headers.get('x-repo-harness-tool-surface') ?? '';
  if (toolSurface !== config.expectedToolSurface) {
    throw new Error(
      `Public MCP surface mismatch at ${publicEndpoint}: expected ${config.expectedToolSurface} got ${toolSurface || '<missing>'}`,
    );
  }
  return { endpoint: publicEndpoint, toolSurface };
}

function configureGitHubPlugin(
  repoRoot: string,
  opts: McpRestartOptions,
): GitHubPluginSummary {
  if (opts.skipGithubPlugin === true) {
    return {
      enabled: 'skipped',
      syncMode: 'skipped',
      includeTasks: 'skipped',
      ready: 'skipped',
    };
  }

  const current = loadGitHubPluginConfig(repoRoot);
  const repository = opts.githubRepo?.trim() || current.repository;
  if (!repository) {
    return {
      enabled: false,
      syncMode: current.syncMode,
      includeTasks: current.includeTasks,
      ready: false,
    };
  }

  const includeTasks = opts.githubIncludeTasks ?? current.includeTasks;
  const syncMode = opts.githubSyncMode === 'checkpoint' ? 'checkpoint' : 'manual';
  saveGitHubPluginConfig(repoRoot, {
    enabled: true,
    repository,
    syncMode,
    includeTasks,
  });
  const status = getGitHubPluginStatus(repoRoot, true);
  return {
    enabled: status.config.enabled,
    syncMode: status.config.syncMode,
    includeTasks: status.config.includeTasks,
    ready: status.ready,
  };
}

export async function runMcpRestart(opts: McpRestartOptions): Promise<McpSetupResult> {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? '.');
  const controllerHome = ensureControllerHome();
  const runtimeBefore = loadMcpServiceRuntimeState(controllerHome, repoRoot);
  const launchAgents = findRepoLaunchAgents(repoRoot);

  const chatgptSetup = runMcpSetupChatgpt({ repo: repoRoot });
  const config = resolveRestartConfig(repoRoot, opts.logFile);
  const changed = [...chatgptSetup.changed];
  const lines: string[] = [
    `[repo-harness restart] repo=${repoRoot}`,
    `[repo-harness restart] host=${config.host} port=${config.port} profile=${config.profile} auth=${config.authMode}`,
    `[repo-harness restart] target_server_name=${config.defaultServerName}`,
    `[repo-harness restart] expected_tool_surface=${config.expectedToolSurface}`,
    `[repo-harness restart] stdout_log=${relative(repoRoot, config.stdoutLogPath)}`,
    `[repo-harness restart] stderr_log=${relative(repoRoot, config.stderrLogPath)}`,
  ];

  if (opts.skipCodexSetup !== true) {
    const codexSetup = runMcpSetupCodex({ repo: repoRoot, scope: 'project' });
    changed.push(...codexSetup.changed);
  } else {
    lines.push('[repo-harness restart] codex setup skipped');
  }

  const github = configureGitHubPlugin(repoRoot, opts);
  if (github.enabled === 'skipped') {
    lines.push('[repo-harness restart] GitHub plugin skipped');
  } else {
    lines.push(`[repo-harness restart] GitHub plugin: enabled=${String(github.enabled)} sync_mode=${github.syncMode} include_tasks=${String(github.includeTasks)}`);
  }

  lines.push(...bootoutRepoLaunchAgents(launchAgents));
  const stoppedPids = await stopRepoHarnessProcesses(config, runtimeBefore);
  lines.push(
    stoppedPids.length > 0
      ? `[repo-harness restart] stopped old repo-local MCP processes: ${stoppedPids.join(' ')}`
      : '[repo-harness restart] no old repo-local MCP processes found',
  );

  let keepalivePid: number | undefined;
  if (launchAgents.length > 0) {
    lines.push(...bootstrapRepoLaunchAgents(launchAgents));
  } else {
    const cli = resolveSelfCliInvocation();
    const keepaliveArgs = [...cli.args, ...buildMcpRestartKeepaliveArgs(config)];
    keepalivePid = spawnDetached(cli.command, keepaliveArgs, repoRoot, config.stdoutLogPath, config.stderrLogPath);
    lines.push(`[repo-harness restart] keepalive_pid=${keepalivePid}`);
  }

  const localHealth = await waitForMcpHealth(config);
  await waitForLocalController(config);
  if (keepalivePid === undefined) {
    keepalivePid = collectKeepalivePids(repoRoot)[0];
  }

  const toolsSmoke = opts.skipToolsSmoke === true ? undefined : await runToolsSmoke(config);
  const publicCheck = opts.skipPublicCheck === true ? undefined : await verifyPublicSurface(config);
  const doctor = parseDoctorReport(runMcpDoctor({ repo: repoRoot, json: true }));

  lines.push('[repo-harness restart] success');
  lines.push(`  version: ${String(localHealth.version ?? '')}`);
  lines.push(`  local_tool_surface: ${String(localHealth.toolSurface ?? '')}`);
  lines.push(`  local_tool_count: ${String(localHealth.toolCount ?? '')}`);
  if (config.localUiEnabled) {
    lines.push(`  local_controller: ${localControllerUrl(config.localUiHost, config.localUiPort)}`);
  }
  lines.push(`  smoke_tool_count: ${toolsSmoke ? String(toolsSmoke.toolCount) : 'skipped'}`);
  lines.push(`  smoke_expected_tools: ${toolsSmoke ? toolsSmoke.expectedTools.join(', ') : 'skipped'}`);
  lines.push(`  github_plugin_enabled: ${String(github.enabled)}`);
  lines.push(`  github_plugin_sync_mode: ${github.syncMode}`);
  lines.push(`  github_plugin_include_tasks: ${String(github.includeTasks)}`);
  lines.push(`  github_plugin_ready: ${String(github.ready)}`);
  if (publicCheck) {
    lines.push(`  public_endpoint: ${publicCheck.endpoint}`);
    lines.push(`  public_tool_surface: ${publicCheck.toolSurface}`);
  }
  lines.push(`  chatgpt_server_name: ${doctor.chatgpt?.serverName ?? config.defaultServerName}`);
  lines.push(`  keepalive_pid: ${keepalivePid ?? 'launchd-managed'}`);
  lines.push(`  log_file: ${config.stderrLogPath}`);
  lines.push('');
  lines.push('Next ChatGPT step:');
  lines.push(`  Recreate or rescan the Connector as "${doctor.chatgpt?.serverName ?? config.defaultServerName}", then call controller_capabilities.`);

  return {
    status: 'ok',
    repoRoot,
    changed: Array.from(new Set(changed)),
    lines,
  };
}
