import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { resolveControllerHome } from '../repositories/controller-home';

export interface McpLocalConfig {
  version?: number;
  repo?: string;
  server?: {
    host?: string;
    port?: number;
    transport?: string;
  };
  auth?: {
    mode?: string;
    tokenFile?: string;
    oauthFile?: string;
  };
  chatgpt?: {
    serverName?: string;
    endpoint?: string;
  };
  profile?: string;
  toolset?: 'core' | 'advanced' | 'full';
  devMode?: {
    agentRunner?: boolean;
    allowedAgents?: string[];
    timeoutMs?: number;
    maxTimeoutMs?: number;
  };
  localController?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    autoOpen?: boolean;
  };
}

export type McpRuntimeStatus = 'starting' | 'running' | 'degraded' | 'stopped';
export type McpRuntimeTunnelMode = 'none' | 'quick' | 'named' | 'tailscale';

export interface McpRuntimeState {
  version: 1;
  repo: string;
  startedAt: string;
  updatedAt: string;
  status: McpRuntimeStatus;
  tunnelMode: McpRuntimeTunnelMode;
  server: {
    endpoint: string;
    pid?: number;
    running: boolean;
    healthy: boolean;
    restartCount: number;
    lastStartAt?: string;
    lastHealthyAt?: string;
    lastExitAt?: string;
    lastExit?: string;
    profile?: string;
    toolSurface?: string;
    schemaVersion?: number;
    toolSurfaceVersion?: number;
    toolSurfaceFingerprint?: string;
    runtimeToolSurfaceFingerprint?: string;
    toolset?: 'core' | 'advanced' | 'full';
    toolCount?: number;
    repoId?: string;
    defaultTimeoutMs?: number;
    maxTimeoutMs?: number;
    healthMismatch?: string;
  };
  localController?: {
    endpoint: string;
    running: boolean;
    pid?: number;
    startedAt?: string;
    error?: string;
  };
  tunnel?: {
    pid?: number;
    running: boolean;
    healthy?: boolean;
    restartCount: number;
    name?: string;
    publicEndpoint?: string;
    lastUrlChangeAt?: string;
    lastHealthyAt?: string;
    lastStartAt?: string;
    lastExitAt?: string;
    lastExit?: string;
    connectorNeedsReconnect?: boolean;
  };
  recentErrors?: Array<{
    at: string;
    source: 'server' | 'tunnel' | 'health' | 'config' | 'local-controller';
    message: string;
  }>;
}

export type McpHttpAuthMode = 'oauth' | 'bearer';

export function mcpLocalConfigPath(repoRoot: string): string {
  return join(repoRoot, '.repo-harness', 'mcp.local.json');
}

export function mcpTokenPath(repoRoot: string): string {
  return join(repoRoot, '.repo-harness', 'mcp.tokens.json');
}

export function mcpOAuthPath(repoRoot: string): string {
  return join(repoRoot, '.repo-harness', 'mcp.oauth.json');
}

export function mcpOAuthTokenStorePath(repoRoot: string): string {
  return join(repoRoot, '.repo-harness', 'mcp.oauth-tokens.json');
}

export function mcpRuntimeStatePath(repoRoot: string): string {
  return join(repoRoot, '.repo-harness', 'mcp.runtime.json');
}

function mcpControllerHomePath(controllerHome: string, filename: string): string {
  return join(resolveControllerHome(controllerHome), 'mcp', filename);
}

export function mcpControllerHomeLocalConfigPath(controllerHome: string): string {
  return mcpControllerHomePath(controllerHome, 'mcp.local.json');
}

export function mcpControllerHomeTokenPath(controllerHome: string): string {
  return mcpControllerHomePath(controllerHome, 'mcp.tokens.json');
}

export function mcpControllerHomeOAuthPath(controllerHome: string): string {
  return mcpControllerHomePath(controllerHome, 'mcp.oauth.json');
}

export function mcpControllerHomeOAuthTokenStorePath(controllerHome: string): string {
  return mcpControllerHomePath(controllerHome, 'mcp.oauth-tokens.json');
}

export function mcpServiceOAuthTokenStorePath(controllerHome: string): string {
  return mcpControllerHomeOAuthTokenStorePath(controllerHome);
}

export function mcpServiceOAuthTokenStoreFallbackPaths(_controllerHome: string, legacyRepoRoot?: string): string[] {
  if (!legacyRepoRoot) return [];
  const legacyPath = mcpOAuthTokenStorePath(legacyRepoRoot);
  return existsSync(legacyPath) ? [legacyPath] : [];
}

export function mcpControllerHomeRuntimeStatePath(controllerHome: string): string {
  return mcpControllerHomePath(controllerHome, 'mcp.runtime.json');
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (_error) {
    return null;
  }
}

function writeJsonFile(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  return path;
}

export function loadMcpLocalConfig(repoRoot: string): McpLocalConfig | null {
  const path = mcpLocalConfigPath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as McpLocalConfig;
  } catch (_error) {
    return null;
  }
}

export function loadMcpRuntimeState(repoRoot: string): McpRuntimeState | null {
  const path = mcpRuntimeStatePath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as McpRuntimeState;
  } catch (_error) {
    return null;
  }
}

export function loadMcpServiceLocalConfig(controllerHome: string, legacyRepoRoot?: string): McpLocalConfig | null {
  return readJsonFile<McpLocalConfig>(mcpControllerHomeLocalConfigPath(controllerHome))
    ?? (legacyRepoRoot ? loadMcpLocalConfig(legacyRepoRoot) : null);
}

export function loadMcpServiceRuntimeState(controllerHome: string, legacyRepoRoot?: string): McpRuntimeState | null {
  return readJsonFile<McpRuntimeState>(mcpControllerHomeRuntimeStatePath(controllerHome))
    ?? (legacyRepoRoot ? loadMcpRuntimeState(legacyRepoRoot) : null);
}

export function writeMcpRuntimeState(repoRoot: string, state: McpRuntimeState): string {
  const path = mcpRuntimeStatePath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  return path;
}

export function writeMcpServiceRuntimeState(controllerHome: string, state: McpRuntimeState): string {
  return writeJsonFile(mcpControllerHomeRuntimeStatePath(controllerHome), state);
}

export function readMcpBearerToken(repoRoot: string): string | null {
  if (process.env.REPO_HARNESS_MCP_TOKEN?.trim()) return process.env.REPO_HARNESS_MCP_TOKEN.trim();
  const path = mcpTokenPath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { bearerToken?: unknown };
    return typeof parsed.bearerToken === 'string' && parsed.bearerToken.trim().length > 0 ? parsed.bearerToken.trim() : null;
  } catch (_error) {
    return null;
  }
}

export function ensureMcpBearerToken(repoRoot: string): { token: string; path: string; changed: boolean } {
  const path = mcpTokenPath(repoRoot);
  const existing = readMcpBearerToken(repoRoot);
  if (existing) return { token: existing, path, changed: false };

  const token = randomBytes(32).toString('base64url');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, bearerToken: token }, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  return { token, path, changed: true };
}

export function readMcpServiceBearerToken(controllerHome: string, legacyRepoRoot?: string): string | null {
  if (process.env.REPO_HARNESS_MCP_TOKEN?.trim()) return process.env.REPO_HARNESS_MCP_TOKEN.trim();
  const parsed = readJsonFile<{ bearerToken?: unknown }>(mcpControllerHomeTokenPath(controllerHome));
  if (typeof parsed?.bearerToken === 'string' && parsed.bearerToken.trim().length > 0) return parsed.bearerToken.trim();
  return legacyRepoRoot ? readMcpBearerToken(legacyRepoRoot) : null;
}

export function ensureMcpControllerHomeBearerToken(controllerHome: string): { token: string; path: string; changed: boolean } {
  const path = mcpControllerHomeTokenPath(controllerHome);
  const existing = readMcpServiceBearerToken(controllerHome);
  if (existing) return { token: existing, path, changed: false };

  const token = randomBytes(32).toString('base64url');
  writeJsonFile(path, { version: 1, bearerToken: token });
  return { token, path, changed: true };
}

export function parseMcpHttpAuthMode(value: string | undefined): McpHttpAuthMode {
  const mode = (value ?? 'oauth').trim().toLowerCase();
  if (mode === 'oauth' || mode === 'bearer') return mode;
  throw new Error(`invalid --auth "${value}" (expected: oauth, bearer)`);
}

export function readMcpOAuthPassphrase(repoRoot: string): string | null {
  if (process.env.REPO_HARNESS_MCP_OAUTH_PASSPHRASE?.trim()) {
    return process.env.REPO_HARNESS_MCP_OAUTH_PASSPHRASE.trim();
  }
  const path = mcpOAuthPath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { passphrase?: unknown };
    return typeof parsed.passphrase === 'string' && parsed.passphrase.trim().length > 0 ? parsed.passphrase.trim() : null;
  } catch (_error) {
    return null;
  }
}

export function ensureMcpOAuthPassphrase(repoRoot: string): { passphrase: string; path: string; changed: boolean } {
  const path = mcpOAuthPath(repoRoot);
  const existing = readMcpOAuthPassphrase(repoRoot);
  if (existing) return { passphrase: existing, path, changed: false };

  const passphrase = randomBytes(24).toString('base64url');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, passphrase }, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  return { passphrase, path, changed: true };
}

export function readMcpServiceOAuthPassphrase(controllerHome: string, legacyRepoRoot?: string): string | null {
  if (process.env.REPO_HARNESS_MCP_OAUTH_PASSPHRASE?.trim()) {
    return process.env.REPO_HARNESS_MCP_OAUTH_PASSPHRASE.trim();
  }
  const parsed = readJsonFile<{ passphrase?: unknown }>(mcpControllerHomeOAuthPath(controllerHome));
  if (typeof parsed?.passphrase === 'string' && parsed.passphrase.trim().length > 0) return parsed.passphrase.trim();
  return legacyRepoRoot ? readMcpOAuthPassphrase(legacyRepoRoot) : null;
}

export function ensureMcpControllerHomeOAuthPassphrase(controllerHome: string): { passphrase: string; path: string; changed: boolean } {
  const path = mcpControllerHomeOAuthPath(controllerHome);
  const existing = readMcpServiceOAuthPassphrase(controllerHome);
  if (existing) return { passphrase: existing, path, changed: false };

  const passphrase = randomBytes(24).toString('base64url');
  writeJsonFile(path, { version: 1, passphrase });
  return { passphrase, path, changed: true };
}
