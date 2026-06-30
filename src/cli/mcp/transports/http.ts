import { randomUUID, timingSafeEqual } from 'crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMultiRepositoryToolDefinitions, createMcpToolContext, createRepoHarnessMcpServerFromContext, type McpServerOptions } from '../server';
import {
  loadMcpLocalConfig,
  mcpOAuthTokenStorePath,
  parseMcpHttpAuthMode,
  readMcpBearerToken,
  readMcpOAuthPassphrase,
  type McpHttpAuthMode,
} from '../auth';
import { createMcpOAuthProvider, McpOAuthTokenStore } from '../oauth';
import { resolveMcpRepoRoot } from '../repo';
import { buildMcpToolDefinitions, controllerExpectedToolNames } from '../tools';
import { repositoryToolDefinitions } from '../repository-tools';
import { runtimeToolDefinitions } from '../../../runtime/gateway/mcp/runtime-tools';
import { injectDurableCommandFields } from '../../../runtime/gateway/mcp/router';
import { ensureControllerDaemon, readControllerDaemonStatus } from '../../../runtime/control-plane/daemon-client';
import { rebuildRepositoryProjection } from '../../../runtime/projections/materialized-view';
import { getRepository } from '../../repositories/registry';
import {
  CONTROLLER_SCHEMA_VERSION,
  CONTROLLER_TOOL_SURFACE,
  CONTROLLER_TOOL_SURFACE_VERSION,
  controllerToolSurfaceFingerprint,
  repositoryIdentity,
} from '../../controller/runtime-config';

export interface McpHttpOptions extends McpServerOptions {
  host?: string;
  port?: number;
  authToken?: string;
  auth?: string;
}

function bearerFromRequest(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export function isAuthorizedMcpHttpRequest(req: Request, expectedToken: string | null): boolean {
  if (!expectedToken) return false;
  return bearerFromRequest(req) === expectedToken;
}

function rawBodyToJson(body: Buffer): unknown | undefined {
  if (body.length === 0) return undefined;
  return JSON.parse(body.toString('utf-8'));
}

function isInitializeRequest(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as Record<string, unknown>).method === 'initialize';
}

export interface McpSessionLookupErrorResponse {
  status: 400 | 404;
  body: {
    error: 'missing_session' | 'session_not_found';
    code: 'MCP_SESSION_REQUIRED' | 'MCP_SESSION_EXPIRED';
    message: string;
    recoverable: true;
    action: 'reinitialize';
  };
}

export function mcpSessionLookupError(sessionId: string | undefined): McpSessionLookupErrorResponse {
  if (!sessionId?.trim()) {
    return {
      status: 400,
      body: {
        error: 'missing_session',
        code: 'MCP_SESSION_REQUIRED',
        message: 'Mcp-Session-Id header is required for this request.',
        recoverable: true,
        action: 'reinitialize',
      },
    };
  }
  return {
    status: 404,
    body: {
      error: 'session_not_found',
      code: 'MCP_SESSION_EXPIRED',
      message: 'MCP session not found or expired; initialize a new session.',
      recoverable: true,
      action: 'reinitialize',
    },
  };
}

export function sendMcpSessionLookupError(res: Response, sessionId: string | undefined): void {
  const response = mcpSessionLookupError(sessionId);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Mcp-Session-Reset', 'reinitialize');
  res.setHeader('x-repo-harness-session-reset', 'reinitialize');
  res.status(response.status).json(response.body);
}

export function mcpRequestError(error: unknown) {
  return {
    status: 500 as const,
    body: {
      error: 'request_failed' as const,
      code: 'MCP_REQUEST_FAILED' as const,
      message: error instanceof Error ? error.message : String(error),
      recoverable: true as const,
      sessionPreserved: true as const,
      action: 'retry' as const,
    },
  };
}

export function sendMcpRequestError(res: Response, error: unknown): void {
  const response = mcpRequestError(error);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('x-repo-harness-session-preserved', 'true');
  res.status(response.status).json(response.body);
}

function getConfiguredPublicOrigin(repoRoot: string): string | undefined {
  const configured = process.env.REPO_HARNESS_MCP_PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch (_error) {
      // Fall through to repo-local config.
    }
  }
  const endpoint = loadMcpLocalConfig(repoRoot)?.chatgpt?.endpoint?.trim();
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint).origin;
  } catch (_error) {
    return undefined;
  }
}

function getPublicOrigin(req: Request, configuredOrigin: string | undefined): string {
  if (configuredOrigin) return configuredOrigin;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '127.0.0.1:8765';
  return `${proto}://${host}`;
}

export function isAllowedMcpOAuthRedirectUri(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      return true;
    }
    if (
      url.protocol === 'https:' &&
      (url.origin === 'https://chatgpt.com' || url.origin === 'https://chat.openai.com') &&
      url.pathname.startsWith('/connector/oauth/')
    ) {
      return true;
    }
    return false;
  } catch (_error) {
    return false;
  }
}

function isRegisteredRedirectUri(redirectUri: string, client: { redirect_uris?: string[] }): boolean {
  return (client.redirect_uris ?? []).some((registered) => redirectUriMatches(redirectUri, registered));
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderPassphrasePage(params: URLSearchParams): string {
  const hiddenFields = Array.from(params.entries())
    .filter(([key]) => key !== 'passphrase')
    .map(([key, value]) => `<input type="hidden" name="${escapeHtmlAttribute(key)}" value="${escapeHtmlAttribute(value)}">`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorize repo-harness</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f6f6f3;color:#1f2328}
.card{width:min(420px,92vw);background:#fff;border:1px solid #d8d8d0;border-radius:12px;padding:32px;box-shadow:0 12px 40px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 20px;color:#60666d;line-height:1.45}
input{width:100%;box-sizing:border-box;border:1px solid #bfc4c9;border-radius:8px;padding:12px;font-size:16px}
button{width:100%;margin-top:14px;border:0;border-radius:8px;padding:12px;background:#1f2328;color:#fff;font-size:16px;font-weight:600}
</style></head>
<body><main class="card">
<h1>Authorize repo-harness</h1>
<p>Enter the local MCP passphrase to let ChatGPT use this workflow-scoped connector.</p>
<form method="POST" action="/authorize">
${hiddenFields}
<input type="password" name="passphrase" placeholder="Passphrase" autofocus>
<button type="submit">Authorize</button>
</form>
</main></body></html>`;
}

function requirePassphrase(passphrase: string): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const provided = typeof req.body?.passphrase === 'string' ? req.body.passphrase : undefined;
    if (provided) {
      const a = Buffer.from(provided);
      const b = Buffer.from(passphrase);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        next();
        return;
      }
    }
    const params = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
    res.type('html').send(renderPassphrasePage(params));
  };
}

function oauthAuthorizationHandler(provider: ReturnType<typeof createMcpOAuthProvider>) {
  return async (req: Request, res: Response) => {
    const query = req.method === 'POST' ? req.body : req.query;
    const clientId = typeof query.client_id === 'string' ? query.client_id : '';
    const responseType = typeof query.response_type === 'string' ? query.response_type : '';
    const codeChallenge = typeof query.code_challenge === 'string' ? query.code_challenge : '';
    const codeChallengeMethod = typeof query.code_challenge_method === 'string' ? query.code_challenge_method : '';
    const state = typeof query.state === 'string' ? query.state : undefined;
    const scope = typeof query.scope === 'string' ? query.scope : undefined;
    let redirectUri = typeof query.redirect_uri === 'string' ? query.redirect_uri : undefined;

    if (responseType !== 'code') {
      res.status(400).json({ error: 'unsupported_response_type', error_description: 'Only code response type is supported' });
      return;
    }
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      res.status(400).json({ error: 'invalid_request', error_description: 'PKCE S256 is required' });
      return;
    }

    const client = await provider.clientsStore.getClient(clientId);
    if (!client) {
      res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
      return;
    }
    if (!redirectUri && client.redirect_uris.length === 1) {
      redirectUri = client.redirect_uris[0];
    }
    if (!redirectUri || !isAllowedMcpOAuthRedirectUri(redirectUri)) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri must be localhost or a ChatGPT connector callback URL',
      });
      return;
    }
    if (!isRegisteredRedirectUri(redirectUri, client)) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri must match a registered client redirect_uri',
      });
      return;
    }

    await provider.authorize(client as OAuthClientInformationFull, {
      state,
      scopes: scope ? scope.split(' ') : [],
      redirectUri,
      codeChallenge,
    }, res);
  };
}

function sendOAuthUnauthorized(
  req: Request,
  res: Response,
  description: string,
  configuredOrigin: string | undefined,
): void {
  const resourceMetadataUrl = `${getPublicOrigin(req, configuredOrigin)}/.well-known/oauth-protected-resource/mcp`;
  res.setHeader(
    'www-authenticate',
    `Bearer error="invalid_token", error_description="${description}", resource_metadata="${resourceMetadataUrl}"`,
  );
  res.status(401).json({ error: 'invalid_token', message: description });
}

function requireMcpHttpAuth(
  mode: McpHttpAuthMode,
  bearerToken: string | null,
  provider: ReturnType<typeof createMcpOAuthProvider> | null,
  configuredOrigin: string | undefined,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (mode === 'bearer') {
      if (!isAuthorizedMcpHttpRequest(req, bearerToken)) {
        res.setHeader('www-authenticate', 'Bearer realm="repo-harness-mcp"');
        res.status(bearerToken ? 401 : 503).json({ error: bearerToken ? 'unauthorized' : 'auth_not_configured' });
        return;
      }
      next();
      return;
    }

    const token = bearerFromRequest(req);
    if (!token || !provider) {
      sendOAuthUnauthorized(req, res, token ? 'OAuth is not configured' : 'Missing Authorization header', configuredOrigin);
      return;
    }
    provider.verifyAccessToken(token)
      .then((authInfo) => {
        (req as unknown as Record<string, unknown>).auth = authInfo;
        next();
      })
      .catch((error: unknown) => {
        if (error instanceof InvalidTokenError) {
          sendOAuthUnauthorized(req, res, error.message, configuredOrigin);
        } else {
          res.status(500).json({ error: 'server_error', message: 'Internal Server Error' });
        }
      });
  };
}

interface ManagedTransport {
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
  inFlightPosts: number;
  inFlightGets: number;
}

interface McpRuntimeStats {
  initializing: number;
  activePosts: number;
  rejectedOverload: number;
}

const MAX_MCP_SESSIONS = 64;
const MAX_INITIALIZING_SESSIONS = 8;
const MAX_POSTS_PER_SESSION = 4;
const MAX_ACTIVE_POSTS = 32;
const MCP_SESSION_TTL_MS = 15 * 60_000;

async function closeManagedTransport(entry: ManagedTransport): Promise<void> {
  try {
    await entry.transport.close();
  } catch (_error) {
    // Session may already be closed by the client.
  }
}

async function pruneTransports(transports: Map<string, ManagedTransport>, forceCapacity = false): Promise<boolean> {
  const now = Date.now();
  const expired = [...transports.entries()]
    .filter(([, entry]) => entry.inFlightPosts === 0 && entry.inFlightGets === 0 && now - entry.lastSeenAt > MCP_SESSION_TTL_MS)
    .map(([sessionId]) => sessionId);
  for (const sessionId of expired) {
    const entry = transports.get(sessionId);
    transports.delete(sessionId);
    if (entry) await closeManagedTransport(entry);
  }
  if (!forceCapacity || transports.size < MAX_MCP_SESSIONS) return transports.size < MAX_MCP_SESSIONS;
  const oldest = [...transports.entries()]
    .filter(([, entry]) => entry.inFlightPosts === 0 && entry.inFlightGets === 0)
    .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
  while (transports.size >= MAX_MCP_SESSIONS && oldest.length > 0) {
    const [sessionId, entry] = oldest.shift()!;
    transports.delete(sessionId);
    await closeManagedTransport(entry);
  }
  return transports.size < MAX_MCP_SESSIONS;
}

async function handleMcpPost(
  req: Request,
  res: Response,
  toolContext: ReturnType<typeof createMcpToolContext>,
  transports: Map<string, ManagedTransport>,
  stats: McpRuntimeStats,
): Promise<void> {
  let body: unknown;
  try {
    body = rawBodyToJson(req.body as Buffer);
  } catch (_error) {
    res.status(400).json({ error: 'invalid JSON request body' });
    return;
  }
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (isInitializeRequest(body)) {
    if (sessionId) {
      res.setHeader('Mcp-Session-Reset', 'reinitialized');
      res.setHeader('x-repo-harness-session-reset', 'reinitialized');
    }
    if (stats.initializing >= MAX_INITIALIZING_SESSIONS || stats.activePosts >= MAX_ACTIVE_POSTS) {
      stats.rejectedOverload += 1;
      res.setHeader('retry-after', '1');
      res.status(503).json({ error: 'server_busy', message: 'Too many MCP sessions are initializing; retry shortly' });
      return;
    }
    stats.initializing += 1;
    stats.activePosts += 1;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      const hasCapacity = await pruneTransports(transports, true);
      if (!hasCapacity || transports.size + stats.initializing > MAX_MCP_SESSIONS) {
        stats.rejectedOverload += 1;
        res.setHeader('retry-after', '1');
        res.status(503).json({ error: 'session_capacity', message: 'All MCP sessions are active; retry shortly' });
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId: string): void => {
          transports.set(newSessionId, { transport: transport!, lastSeenAt: Date.now(), inFlightPosts: 0, inFlightGets: 0 });
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) transports.delete(transport.sessionId);
      };
      const server = createRepoHarnessMcpServerFromContext(toolContext);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      stats.initializing -= 1;
      stats.activePosts -= 1;
      if (!transport?.sessionId) await transport?.close().catch(() => undefined);
    }
    return;
  }
  if (sessionId) {
    const managed = transports.get(sessionId);
    if (managed) {
      if (managed.inFlightPosts >= MAX_POSTS_PER_SESSION || stats.activePosts >= MAX_ACTIVE_POSTS) {
        stats.rejectedOverload += 1;
        res.setHeader('retry-after', '1');
        res.status(429).json({ error: 'session_busy', message: 'Too many MCP requests are active; retry shortly' });
        return;
      }
      managed.lastSeenAt = Date.now();
      managed.inFlightPosts += 1;
      stats.activePosts += 1;
      try {
        await managed.transport.handleRequest(req, res, body);
      } finally {
        managed.inFlightPosts -= 1;
        stats.activePosts -= 1;
      }
      return;
    }
  }
  sendMcpSessionLookupError(res, sessionId);
}

async function handleMcpGet(req: Request, res: Response, transports: Map<string, ManagedTransport>): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const managed = sessionId ? transports.get(sessionId) : undefined;
  if (!managed) {
    sendMcpSessionLookupError(res, sessionId);
    return;
  }
  managed.lastSeenAt = Date.now();
  managed.inFlightGets += 1;
  let released = false;
  const releaseStream = (): void => {
    if (released) return;
    released = true;
    managed.inFlightGets = Math.max(0, managed.inFlightGets - 1);
    managed.lastSeenAt = Date.now();
  };
  req.once('aborted', releaseStream);
  res.once('close', releaseStream);
  try {
    await managed.transport.handleRequest(req, res);
  } finally {
    req.off('aborted', releaseStream);
    res.off('close', releaseStream);
    releaseStream();
  }
}

export async function startMcpHttp(opts: McpHttpOptions): Promise<void> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 8765;
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? '.');
  const authMode = parseMcpHttpAuthMode(opts.auth);
  const authToken = authMode === 'bearer' ? opts.authToken ?? readMcpBearerToken(repoRoot) : null;
  const oauthPassphrase = authMode === 'oauth' ? readMcpOAuthPassphrase(repoRoot) : null;
  const tokenStore = authMode === 'oauth' ? new McpOAuthTokenStore(mcpOAuthTokenStorePath(repoRoot)) : null;
  tokenStore?.load();
  const oauthProvider = tokenStore ? createMcpOAuthProvider(tokenStore) : null;
  const configuredPublicOrigin = getConfiguredPublicOrigin(repoRoot);
  const transports = new Map<string, ManagedTransport>();
  const runtimeStats: McpRuntimeStats = { initializing: 0, activePosts: 0, rejectedOverload: 0 };
  const toolContext = createMcpToolContext({ ...opts, repo: repoRoot });
  const runtimeControllerHome = 'controllerHome' in toolContext ? toolContext.controllerHome : undefined;
  if (runtimeControllerHome) ensureControllerDaemon(runtimeControllerHome);
  const compatibilityToolDefinitions = buildMcpToolDefinitions(toolContext.policy, { enableChatgptBrowser: opts.enableChatgptBrowser === true });
  const toolDefinitions = 'controllerHome' in toolContext
    ? runtimeToolDefinitions.concat(repositoryToolDefinitions, buildMultiRepositoryToolDefinitions(toolContext)).map(injectDurableCommandFields)
    : compatibilityToolDefinitions;
  const controllerToolNames = toolContext.policy.profile === 'controller'
    ? controllerExpectedToolNames(toolContext.policy, { enableChatgptBrowser: opts.enableChatgptBrowser === true })
    : [];
  const runtimeToolNames = toolDefinitions.map((tool) => tool.name);
  const toolSurface = toolContext.policy.profile === 'controller' ? CONTROLLER_TOOL_SURFACE : `${toolContext.policy.profile}-legacy-v1`;
  const toolSurfaceSchemaVersion = toolContext.policy.profile === 'controller' ? CONTROLLER_SCHEMA_VERSION : 1;
  const toolSurfaceVersion = toolContext.policy.profile === 'controller' ? CONTROLLER_TOOL_SURFACE_VERSION : 1;
  const toolSurfaceFingerprint = toolContext.policy.profile === 'controller'
    ? controllerToolSurfaceFingerprint(controllerToolNames)
    : undefined;
  const runtimeToolSurfaceFingerprint = toolContext.policy.profile === 'controller'
    ? controllerToolSurfaceFingerprint(runtimeToolNames)
    : undefined;
  const repoId = repositoryIdentity(repoRoot);
  const startedAt = new Date().toISOString();
  const app = express();
  app.set('trust proxy', 1);

  app.get('/health', (_req, res) => {
    res.setHeader('x-repo-harness-tool-surface', toolSurface);
    res.setHeader('x-repo-harness-tool-surface-version', String(toolSurfaceVersion));
    res.setHeader('x-repo-harness-schema-version', String(toolSurfaceSchemaVersion));
    if (toolSurfaceFingerprint) res.setHeader('x-repo-harness-tool-surface-fingerprint', toolSurfaceFingerprint);
    res.json({
      status: 'ok',
      server: 'repo-harness-mcp',
      version: '1.4.0',
      profile: toolContext.policy.profile,
      toolSurface,
      schemaVersion: toolSurfaceSchemaVersion,
      toolSurfaceVersion,
      toolSurfaceFingerprint,
      runtimeToolSurfaceFingerprint,
      toolCount: toolDefinitions.length,
      compatibilityToolCount: compatibilityToolDefinitions.length,
      repoId,
      startedAt,
      runner: {
        enabled: toolContext.policy.execution.agentRunner,
        defaultTimeoutMs: toolContext.policy.execution.runnerTimeoutMs,
        maxTimeoutMs: toolContext.policy.execution.runnerMaxTimeoutMs,
      },
      auth: authMode === 'oauth' ? (oauthPassphrase ? 'oauth' : 'missing') : (authToken ? 'required' : 'missing'),
      sessions: {
        active: transports.size,
        maximum: MAX_MCP_SESSIONS,
        initializing: runtimeStats.initializing,
        activePosts: runtimeStats.activePosts,
        activeStreams: [...transports.values()].reduce((count, entry) => count + entry.inFlightGets, 0),
        maximumActivePosts: MAX_ACTIVE_POSTS,
        rejectedOverload: runtimeStats.rejectedOverload,
      },
    });
  });

  app.get('/ready', (_req, res) => {
    if (!runtimeControllerHome) {
      res.status(200).json({ ready: true, profile: toolContext.policy.profile, gateway: 'ready', controllerDaemon: 'not-required' });
      return;
    }
    const daemon = readControllerDaemonStatus(runtimeControllerHome);
    const ready = daemon.status === 'ready';
    res.status(ready ? 200 : 503).json({
      ready,
      gateway: { status: 'ready', thin: true, eventLoopIsolatedFromWorkers: true },
      controllerDaemon: daemon,
    });
  });

  app.get('/repos/:repoId/health', (req, res) => {
    if (!runtimeControllerHome) {
      res.status(404).json({ error: 'controller profile required' });
      return;
    }
    try {
      const repository = getRepository(req.params.repoId, runtimeControllerHome, { includeRemoved: true });
      const projection = rebuildRepositoryProjection(runtimeControllerHome, repository.repoId);
      res.json({ status: repository.enabled && !repository.removedAt ? 'ok' : 'disabled', repository: { repoId: repository.repoId, checkoutId: repository.activeCheckoutId, enabled: repository.enabled, removedAt: repository.removedAt }, projection });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  if (authMode === 'oauth' && oauthProvider) {
    app.use('/authorize', express.urlencoded({ extended: false, limit: '10kb' }));
    app.use('/authorize', requirePassphrase(oauthPassphrase ?? ''));
    app.use('/authorize', oauthAuthorizationHandler(oauthProvider));
    app.use('/token', tokenHandler({ provider: oauthProvider, rateLimit: false }));
    app.use('/revoke', revocationHandler({ provider: oauthProvider, rateLimit: false }));
    app.use('/register', clientRegistrationHandler({ clientsStore: oauthProvider.clientsStore, rateLimit: false }));
    app.get('/.well-known/oauth-authorization-server', (req, res) => {
      const origin = getPublicOrigin(req, configuredPublicOrigin);
      res.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        revocation_endpoint: `${origin}/revoke`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        scopes_supported: ['repo-harness'],
      });
    });
    app.get('/.well-known/openid-configuration', (req, res) => {
      const origin = getPublicOrigin(req, configuredPublicOrigin);
      res.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        scopes_supported: ['repo-harness'],
      });
    });
    app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
      const origin = getPublicOrigin(req, configuredPublicOrigin);
      res.json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['repo-harness'],
        bearer_methods_supported: ['header'],
      });
    });
  }

  app.use('/mcp', (_req, res, next) => {
    res.setHeader('x-repo-harness-tool-surface', toolSurface);
    res.setHeader('x-repo-harness-tool-surface-version', String(toolSurfaceVersion));
    res.setHeader('x-repo-harness-schema-version', String(toolSurfaceSchemaVersion));
    if (toolSurfaceFingerprint) res.setHeader('x-repo-harness-tool-surface-fingerprint', toolSurfaceFingerprint);
    next();
  });
  app.post('/mcp', requireMcpHttpAuth(authMode, authToken, oauthProvider, configuredPublicOrigin), express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    handleMcpPost(req, res, toolContext, transports, runtimeStats).catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });
  app.get('/mcp', requireMcpHttpAuth(authMode, authToken, oauthProvider, configuredPublicOrigin), (req, res) => {
    handleMcpGet(req, res, transports).catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  const cleanupTimer = setInterval(() => { void pruneTransports(transports); }, 60_000);
  cleanupTimer.unref();

  const httpServer = app.listen(port, host);
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 70_000;
  httpServer.requestTimeout = 120_000;

  httpServer.on('close', () => {
    clearInterval(cleanupTimer);
    for (const entry of transports.values()) void closeManagedTransport(entry);
    transports.clear();
  });

  await new Promise<void>((resolve) => {
    httpServer.once('listening', resolve);
  });
  const authLabel = authMode === 'oauth' ? (oauthPassphrase ? 'oauth' : 'oauth-missing') : (authToken ? 'bearer' : 'missing');
  console.error(`repo-harness mcp http listening on http://${host}:${port}/mcp (auth: ${authLabel})`);

  const shutdown = () => {
    for (const entry of transports.values()) {
      void closeManagedTransport(entry);
    }
    tokenStore?.flush();
    httpServer.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
