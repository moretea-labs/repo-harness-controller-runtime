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
  loadMcpServiceLocalConfig,
  loadMcpServiceRuntimeState,
  mcpServiceOAuthTokenStoreFallbackPaths,
  mcpServiceOAuthTokenStorePath,
  parseMcpHttpAuthMode,
  readMcpServiceBearerToken,
  readMcpServiceOAuthPassphrase,
  type McpLocalConfig,
  type McpHttpAuthMode,
} from '../auth';
import { createMcpOAuthProvider, McpOAuthTokenStore } from '../oauth';
import { isExpectedLocalControllerHealth } from '../keepalive';
import { resolveMcpRepoRoot } from '../repo';
import { buildMcpToolDefinitions } from '../tools';
import { resolveControllerHome } from '../../repositories/controller-home';
import {
  controllerExposureSnapshot,
} from '../toolset';
import { ensureControllerDaemon, readControllerDaemonStatus } from '../../../runtime/control-plane/daemon-client';
import { projectionBlocksReadiness, readRepositoryProjectionSnapshot, rebuildRepositoryProjection } from '../../../runtime/projections/materialized-view';
import { readRuntimeGeneration } from '../../../runtime/control-plane/runtime-generation';
import { getRepository, listRepositories } from '../../repositories/registry';
import {
  CONTROLLER_SCHEMA_VERSION,
  CONTROLLER_TOOL_SURFACE,
  CONTROLLER_TOOL_SURFACE_VERSION,
  controllerToolSurfaceFingerprint,
  repositoryIdentity,
} from '../../controller/runtime-config';
import { McpSessionRegistry, type McpSessionRoute } from './session-registry';

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

function principalFromRequest(req: Request): string {
  const auth = (req as unknown as { auth?: { clientId?: string } }).auth;
  if (auth?.clientId?.trim()) return `oauth-client:${auth.clientId.trim()}`;
  return bearerFromRequest(req) ? 'mcp-bearer-client' : 'controller-http-client';
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

function initializeClientIdentity(req: Request, body: unknown, route: McpSessionRoute, principalId: string): string {
  const params = typeof body === 'object' && body !== null
    ? (body as { params?: { clientInfo?: { name?: unknown; version?: unknown } } }).params
    : undefined;
  const clientInfo = params?.clientInfo;
  const clientName = typeof clientInfo?.name === 'string' && clientInfo.name.trim() ? clientInfo.name.trim() : 'unknown-client';
  const clientVersion = typeof clientInfo?.version === 'string' && clientInfo.version.trim() ? clientInfo.version.trim() : 'unknown-version';
  const userAgent = typeof req.headers['user-agent'] === 'string' && req.headers['user-agent'].trim()
    ? req.headers['user-agent'].trim().slice(0, 160)
    : 'unknown-agent';
  return `${principalId}|${route}|${clientName}/${clientVersion}|${userAgent}`;
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

function getConfiguredPublicOrigin(config: McpLocalConfig | null): string | undefined {
  const configured = process.env.REPO_HARNESS_MCP_PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch (_error) {
      // Fall through to service or legacy config.
    }
  }
  const endpoint = config?.chatgpt?.endpoint?.trim();
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

function localControllerHealthUrl(host: string, port: number): string {
  return `http://${host === '::1' ? '[::1]' : host}:${port}/health`;
}

async function jsonHealth(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
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

function isRegisteredExternalHttpsRedirectUri(redirectUri: string, client: { redirect_uris?: string[] }): boolean {
  try {
    const url = new URL(redirectUri);
    return url.protocol === 'https:' && !url.username && !url.password && isRegisteredRedirectUri(redirectUri, client);
  } catch (_error) {
    return false;
  }
}

function isSafeOAuthFallbackRedirectUri(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    if (url.username || url.password) return false;
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;
    return url.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

async function getOrRegisterPublicOAuthClient(
  provider: ReturnType<typeof createMcpOAuthProvider>,
  clientId: string,
  redirectUri: string | undefined,
  req: Request,
): Promise<OAuthClientInformationFull | undefined> {
  const existing = await provider.clientsStore.getClient(clientId);
  if (existing) return existing as OAuthClientInformationFull;
  if (!redirectUri || !isSafeOAuthFallbackRedirectUri(redirectUri) || !provider.clientsStore.registerClient) return undefined;
  oauthTrace(req, 'authorize:auto_register_public_client', {
    redirectScheme: new URL(redirectUri).protocol,
    redirectHost: new URL(redirectUri).hostname,
  });
  return provider.clientsStore.registerClient({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: 'repo-harness OAuth fallback client',
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  } as unknown as Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) as OAuthClientInformationFull;
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
<p>Enter the local MCP passphrase to let this MCP client use this workflow-scoped connector.</p>
<form method="POST" action="/authorize">
${hiddenFields}
<input type="password" name="passphrase" placeholder="Passphrase" autofocus>
<button type="submit">Authorize</button>
</form>
</main></body></html>`;
}

/** Collect OAuth authorize params from query (GET) or body (POST form). */
function oauthAuthorizeParamSource(req: Request): Record<string, unknown> {
  if (req.method === 'POST' && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body as Record<string, unknown>;
  }
  return req.query as Record<string, unknown>;
}

function readOAuthAuthorizeString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * True when the request lacks the OAuth parameters needed for a real authorization.
 * Incomplete requests must not render the passphrase form (incompatible clients loop there).
 */
export function isIncompleteOAuthAuthorizeRequest(source: Record<string, unknown>): boolean {
  const clientId = readOAuthAuthorizeString(source, 'client_id');
  const responseType = readOAuthAuthorizeString(source, 'response_type');
  const codeChallenge = readOAuthAuthorizeString(source, 'code_challenge');
  const redirectUri = readOAuthAuthorizeString(source, 'redirect_uri');
  // redirect_uri may be omitted when the client has a single registered URI; client_id is the usable redirect context.
  const hasRedirectContext = Boolean(redirectUri) || Boolean(clientId);
  return !clientId || !responseType || !codeChallenge || !hasRedirectContext;
}

function incompleteOAuthAuthorizeResponseBody(): {
  error: 'invalid_request';
  error_description: string;
  message: string;
  hint: string;
} {
  return {
    error: 'invalid_request',
    error_description:
      'OAuth authorization request is incomplete. Required: client_id, response_type, code_challenge, and a usable redirect context (redirect_uri or a registered client).',
    message:
      'This endpoint expects a complete OAuth authorization request (PKCE). Non-OAuth MCP clients should use /mcp-bearer with Authorization: Bearer <token> instead of /authorize.',
    hint: 'Use POST/GET /mcp-bearer with a repo-harness bearer token for clients that cannot complete OAuth dynamic registration and PKCE.',
  };
}

function isOAuthDebugTraceEnabled(): boolean {
  return process.env.REPO_HARNESS_MCP_OAUTH_TRACE === '1' || process.env.REPO_HARNESS_MCP_OAUTH_TRACE === 'true';
}

const SENSITIVE_OAUTH_FIELDS = new Set([
  'passphrase',
  'code',
  'code_verifier',
  'client_secret',
  'access_token',
  'refresh_token',
  'token',
  'authorization',
]);

function safeOAuthFieldNames(source: Record<string, unknown>): string[] {
  return Object.keys(source)
    .filter((key) => !SENSITIVE_OAUTH_FIELDS.has(key.toLowerCase()))
    .sort();
}

function oauthTrace(req: Request, event: string, extra: Record<string, unknown> = {}): void {
  if (!isOAuthDebugTraceEnabled()) return;
  const source = oauthAuthorizeParamSource(req);
  const userAgent = typeof req.headers['user-agent'] === 'string'
    ? req.headers['user-agent'].split(/[\s/]/)[0]
    : undefined;
  const safe = {
    event,
    method: req.method,
    path: req.path,
    fieldNames: safeOAuthFieldNames(source),
    hasClientId: Boolean(readOAuthAuthorizeString(source, 'client_id')),
    hasRedirectUri: Boolean(readOAuthAuthorizeString(source, 'redirect_uri')),
    hasCodeChallenge: Boolean(readOAuthAuthorizeString(source, 'code_challenge')),
    responseType: readOAuthAuthorizeString(source, 'response_type') || undefined,
    codeChallengeMethod: readOAuthAuthorizeString(source, 'code_challenge_method') || undefined,
    grantType: readOAuthAuthorizeString(source, 'grant_type') || undefined,
    hasResource: Boolean(readOAuthAuthorizeString(source, 'resource')),
    userAgent,
    ...extra,
  };
  console.error(`[repo-harness:mcp-oauth] ${JSON.stringify(safe)}`);
}

function oauthTraceMiddleware(event: string): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    oauthTrace(req, `${event}:request`);
    res.once('finish', () => oauthTrace(req, `${event}:response`, { statusCode: res.statusCode }));
    next();
  };
}

function rejectIncompleteOAuthAuthorize(req: Request, res: Response, next: NextFunction): void {
  const source = oauthAuthorizeParamSource(req);
  if (isIncompleteOAuthAuthorizeRequest(source)) {
    oauthTrace(req, 'authorize:incomplete');
    res.status(400).json(incompleteOAuthAuthorizeResponseBody());
    return;
  }
  oauthTrace(req, 'authorize:complete');
  next();
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
    // Prefer body hidden fields on POST (failed passphrase re-render), else query string on GET.
    const source = oauthAuthorizeParamSource(req);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(source)) {
      if (key === 'passphrase') continue;
      if (typeof value === 'string') params.set(key, value);
    }
    if ([...params.keys()].length === 0 && req.url.includes('?')) {
      const fromUrl = new URLSearchParams(req.url.slice(req.url.indexOf('?')));
      for (const [key, value] of fromUrl.entries()) {
        if (key !== 'passphrase') params.set(key, value);
      }
    }
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

    const client = await getOrRegisterPublicOAuthClient(provider, clientId, redirectUri, req);
    if (!client) {
      res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
      return;
    }
    if (!redirectUri && client.redirect_uris.length === 1) {
      redirectUri = client.redirect_uris[0];
    }
    if (!redirectUri || (!isAllowedMcpOAuthRedirectUri(redirectUri) && !isRegisteredExternalHttpsRedirectUri(redirectUri, client))) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri must be localhost, a ChatGPT connector callback URL, or a registered HTTPS client redirect_uri',
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

function sendBearerUnauthorized(res: Response, description: string, hasConfiguredToken: boolean): void {
  res.setHeader('www-authenticate', 'Bearer realm="repo-harness-mcp"');
  res.status(hasConfiguredToken ? 401 : 503).json({
    error: hasConfiguredToken ? 'unauthorized' : 'auth_not_configured',
    message: description,
  });
}

function sendOAuthUnauthorized(
  req: Request,
  res: Response,
  description: string,
  configuredOrigin: string | undefined,
  resourcePath = '/mcp',
): void {
  const resourceMetadataUrl = `${getPublicOrigin(req, configuredOrigin)}/.well-known/oauth-protected-resource${resourcePath}`;
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
  resourcePath = '/mcp',
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (mode === 'bearer') {
      if (!isAuthorizedMcpHttpRequest(req, bearerToken)) {
        sendBearerUnauthorized(res, bearerToken ? 'Missing or invalid Authorization header' : 'Bearer token is not configured', Boolean(bearerToken));
        return;
      }
      next();
      return;
    }

    if (isAuthorizedMcpHttpRequest(req, bearerToken)) {
      next();
      return;
    }

    const token = bearerFromRequest(req);
    if (!token || !provider) {
      sendOAuthUnauthorized(req, res, token ? 'OAuth is not configured' : 'Missing Authorization header', configuredOrigin, resourcePath);
      return;
    }
    provider.verifyAccessToken(token)
      .then((authInfo) => {
        (req as unknown as Record<string, unknown>).auth = authInfo;
        next();
      })
      .catch((error: unknown) => {
        if (error instanceof InvalidTokenError) {
          sendOAuthUnauthorized(req, res, error.message, configuredOrigin, resourcePath);
        } else {
          res.status(500).json({ error: 'server_error', message: 'Internal Server Error' });
        }
      });
  };
}

interface McpRuntimeStats {
  initializing: number;
  activePosts: number;
  rejectedOverload: number;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const MAX_MCP_SESSIONS = positiveIntegerEnv('REPO_HARNESS_MCP_MAX_SESSIONS', 64);
const MAX_MCP_SESSIONS_PER_PRINCIPAL = positiveIntegerEnv('REPO_HARNESS_MCP_MAX_SESSIONS_PER_PRINCIPAL', 8);
const MAX_INITIALIZING_SESSIONS = positiveIntegerEnv('REPO_HARNESS_MCP_MAX_INITIALIZING_SESSIONS', 8);
const MAX_POSTS_PER_SESSION = positiveIntegerEnv('REPO_HARNESS_MCP_MAX_POSTS_PER_SESSION', 4);
const MAX_ACTIVE_POSTS = positiveIntegerEnv('REPO_HARNESS_MCP_MAX_ACTIVE_POSTS', 32);
const MCP_SESSION_IDLE_TTL_MS = positiveIntegerEnv('REPO_HARNESS_MCP_SESSION_IDLE_TTL_MS', 15 * 60_000);
const MCP_STREAM_LEASE_MS = positiveIntegerEnv('REPO_HARNESS_MCP_STREAM_LEASE_MS', 30 * 60_000);
const MCP_SESSION_ABSOLUTE_LIFETIME_MS = positiveIntegerEnv('REPO_HARNESS_MCP_SESSION_ABSOLUTE_LIFETIME_MS', 2 * 60 * 60_000);
const MCP_ACTIVE_POST_STALL_MS = positiveIntegerEnv('REPO_HARNESS_MCP_ACTIVE_POST_STALL_MS', 10 * 60_000);

type McpToolContext = ReturnType<typeof createMcpToolContext>;
type HttpSessionRegistry = McpSessionRegistry<StreamableHTTPServerTransport, McpToolContext>;

async function handleMcpPost(
  req: Request,
  res: Response,
  baseOptions: McpServerOptions,
  registry: HttpSessionRegistry,
  stats: McpRuntimeStats,
  route: McpSessionRoute,
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
    let reservationId: string | undefined;
    let initializedSessionId: string | undefined;
    try {
      const principalId = principalFromRequest(req);
      const clientIdentity = initializeClientIdentity(req, body, route, principalId);
      reservationId = await registry.reserveForInitialize({
        principalId,
        route,
        ...(principalId === 'mcp-bearer-client' ? { enforcePrincipalCapacity: false } : {}),
        ...(sessionId ? { supersedeSessionId: sessionId } : {}),
      });
      if (!reservationId) {
        stats.rejectedOverload += 1;
        res.setHeader('retry-after', '1');
        res.status(503).json({ error: 'session_capacity', message: 'All MCP sessions are executing active work; retry shortly' });
        return;
      }
      const sessionContext = createMcpToolContext({
        ...baseOptions,
        sessionId: `mcp_${randomUUID().replace(/-/g, '')}`,
        principalId,
      });
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId: string): void => {
          registry.commitInitialize(reservationId!, {
            sessionId: newSessionId,
            transport: transport!,
            toolContext: sessionContext,
            route,
            principalId,
            clientIdentity,
          });
          initializedSessionId = newSessionId;
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) registry.detach(transport.sessionId);
      };
      const server = createRepoHarnessMcpServerFromContext(sessionContext);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      if (initializedSessionId) registry.endPost(initializedSessionId);
      if (reservationId) registry.releaseInitialize(reservationId);
      stats.initializing -= 1;
      stats.activePosts -= 1;
      if (!transport?.sessionId) await transport?.close().catch(() => undefined);
    }
    return;
  }
  if (sessionId) {
    const managed = registry.get(sessionId);
    if (managed && managed.route === route && managed.principalId === principalFromRequest(req)) {
      if (managed.inFlightPosts >= MAX_POSTS_PER_SESSION || stats.activePosts >= MAX_ACTIVE_POSTS) {
        stats.rejectedOverload += 1;
        res.setHeader('retry-after', '1');
        res.status(429).json({ error: 'session_busy', message: 'Too many MCP requests are active; retry shortly' });
        return;
      }
      registry.beginPost(sessionId);
      stats.activePosts += 1;
      try {
        await managed.transport.handleRequest(req, res, body);
      } finally {
        registry.endPost(sessionId);
        stats.activePosts -= 1;
      }
      return;
    }
  }
  sendMcpSessionLookupError(res, sessionId);
}

async function handleMcpGet(req: Request, res: Response, registry: HttpSessionRegistry, route: McpSessionRoute): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const managed = sessionId ? registry.get(sessionId) : undefined;
  if (!managed || managed.route !== route || managed.principalId !== principalFromRequest(req)) {
    sendMcpSessionLookupError(res, sessionId);
    return;
  }
  registry.beginStream(sessionId!);
  let released = false;
  const releaseStream = (): void => {
    if (released) return;
    released = true;
    registry.endStream(sessionId!);
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

async function handleMcpDelete(req: Request, res: Response, registry: HttpSessionRegistry, route: McpSessionRoute): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const managed = sessionId ? registry.get(sessionId) : undefined;
  if (!managed || managed.route !== route || managed.principalId !== principalFromRequest(req)) {
    sendMcpSessionLookupError(res, sessionId);
    return;
  }
  registry.setPendingCloseReason(sessionId!, 'client_delete');
  await managed.transport.handleRequest(req, res);
  if (registry.get(sessionId!)) await registry.close(sessionId!, 'client_delete');
}

export async function startMcpHttp(opts: McpHttpOptions): Promise<void> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 8765;
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? '.');
  const controllerHome = resolveControllerHome(opts.controllerHome);
  const serviceConfig = loadMcpServiceLocalConfig(controllerHome, repoRoot);
  const profile = opts.profile ?? serviceConfig?.profile ?? 'controller';
  const authMode = parseMcpHttpAuthMode(opts.auth ?? serviceConfig?.auth?.mode);
  const authToken = opts.authToken ?? readMcpServiceBearerToken(controllerHome, repoRoot);
  const oauthPassphrase = authMode === 'oauth'
    ? readMcpServiceOAuthPassphrase(controllerHome, repoRoot)
    : null;
  const tokenStore = authMode === 'oauth'
    ? new McpOAuthTokenStore(
      mcpServiceOAuthTokenStorePath(controllerHome),
      mcpServiceOAuthTokenStoreFallbackPaths(controllerHome, repoRoot),
    )
    : null;
  tokenStore?.load();
  const oauthProvider = tokenStore ? createMcpOAuthProvider(tokenStore) : null;
  const configuredPublicOrigin = getConfiguredPublicOrigin(serviceConfig);
  const sessionRegistry = new McpSessionRegistry<StreamableHTTPServerTransport, McpToolContext>({
    maximumSessions: MAX_MCP_SESSIONS,
    maximumSessionsPerPrincipal: MAX_MCP_SESSIONS_PER_PRINCIPAL,
    idleTtlMs: MCP_SESSION_IDLE_TTL_MS,
    streamLeaseMs: MCP_STREAM_LEASE_MS,
    absoluteLifetimeMs: MCP_SESSION_ABSOLUTE_LIFETIME_MS,
    activePostStallMs: MCP_ACTIVE_POST_STALL_MS,
  });
  const runtimeStats: McpRuntimeStats = { initializing: 0, activePosts: 0, rejectedOverload: 0 };
  const toolContext = createMcpToolContext({ ...opts, repo: repoRoot, controllerHome, profile });
  const baseOptions: McpServerOptions = {
    repo: repoRoot,
    controllerHome,
    profile,
    toolset: opts.toolset,
    enableChatgptBrowser: opts.enableChatgptBrowser,
    enableDevRunner: opts.enableDevRunner,
    devRunnerAgents: opts.devRunnerAgents,
    devRunnerTimeoutMs: opts.devRunnerTimeoutMs,
    devRunnerMaxTimeoutMs: opts.devRunnerMaxTimeoutMs,
  };
  const runtimeControllerHome = 'controllerHome' in toolContext ? toolContext.controllerHome : undefined;
  if (runtimeControllerHome) ensureControllerDaemon(runtimeControllerHome);
  const runtimeGeneration = runtimeControllerHome ? readRuntimeGeneration(runtimeControllerHome) : undefined;
  const localControllerConfig = {
    enabled: serviceConfig?.localController?.enabled ?? profile === 'controller',
    host: serviceConfig?.localController?.host ?? '127.0.0.1',
    port: serviceConfig?.localController?.port ?? 8766,
  };
  const compatibilityToolDefinitions = buildMcpToolDefinitions(toolContext.policy, { enableChatgptBrowser: opts.enableChatgptBrowser === true });
  const toolSurface = toolContext.policy.profile === 'controller' ? CONTROLLER_TOOL_SURFACE : `${toolContext.policy.profile}-legacy-v1`;
  const toolSurfaceSchemaVersion = toolContext.policy.profile === 'controller' ? CONTROLLER_SCHEMA_VERSION : 1;
  const toolSurfaceVersion = toolContext.policy.profile === 'controller' ? CONTROLLER_TOOL_SURFACE_VERSION : 1;
  const repoId = toolContext.policy.profile === 'controller' ? undefined : repositoryIdentity(repoRoot);
  const startedAt = new Date().toISOString();
  const localOrigin = `http://${host === '::' || host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  const advertisedOrigin = configuredPublicOrigin ?? localOrigin;
  const app = express();
  app.set('trust proxy', 1);

  const controllerHealth = () => {
    if (!('controllerHome' in toolContext)) return null;
    const exposure = controllerExposureSnapshot(toolContext);
    const fingerprint = controllerToolSurfaceFingerprint(exposure.toolNames);
    return {
      configuredAccessMode: exposure.access.configuredAccessMode,
      effectiveAccessMode: exposure.access.effectiveAccessMode,
      effectiveToolset: exposure.access.effectiveToolset,
      exposureRevision: exposure.access.exposureRevision,
      accessModeSource: exposure.access.source,
      accessModeLastAppliedAt: exposure.access.lastAppliedAt,
      toolset: exposure.access.effectiveToolset,
      toolSurfaceFingerprint: fingerprint,
      runtimeToolSurfaceFingerprint: fingerprint,
      toolCount: exposure.toolNames.length,
      generation: runtimeGeneration?.generation,
      source: runtimeGeneration?.source,
    };
  };

  app.get('/health', (_req, res) => {
    const health = controllerHealth();
    res.setHeader('x-repo-harness-tool-surface', toolSurface);
    res.setHeader('x-repo-harness-tool-surface-version', String(toolSurfaceVersion));
    res.setHeader('x-repo-harness-schema-version', String(toolSurfaceSchemaVersion));
    if (health?.toolset) res.setHeader('x-repo-harness-toolset', health.toolset);
    if (health?.runtimeToolSurfaceFingerprint) res.setHeader('x-repo-harness-runtime-tool-surface-fingerprint', health.runtimeToolSurfaceFingerprint);
    if (health?.toolSurfaceFingerprint) res.setHeader('x-repo-harness-tool-surface-fingerprint', health.toolSurfaceFingerprint);
    const sessionSnapshot = sessionRegistry.snapshot();
    res.json({
      status: 'ok',
      server: 'repo-harness-mcp',
      ...(process.env.REPO_HARNESS_MCP_INSTANCE_ID
        ? { instanceId: process.env.REPO_HARNESS_MCP_INSTANCE_ID }
        : {}),
      version: '1.4.0',
      profile: toolContext.policy.profile,
      toolSurface,
      schemaVersion: toolSurfaceSchemaVersion,
      toolSurfaceVersion,
      toolSurfaceFingerprint: health?.toolSurfaceFingerprint,
      runtimeToolSurfaceFingerprint: health?.runtimeToolSurfaceFingerprint,
      generation: health?.generation,
      source: health?.source,
      toolset: health?.toolset ?? 'full',
      toolCount: health?.toolCount ?? compatibilityToolDefinitions.length,
      compatibilityToolCount: compatibilityToolDefinitions.length,
      configuredAccessMode: health?.configuredAccessMode,
      effectiveAccessMode: health?.effectiveAccessMode,
      effectiveToolset: health?.effectiveToolset,
      accessModeSource: health?.accessModeSource,
      accessModeLastAppliedAt: health?.accessModeLastAppliedAt,
      exposureRevision: health?.exposureRevision,
      ...(repoId ? { repoId } : {}),
      startedAt,
      runner: {
        enabled: toolContext.policy.execution.agentRunner,
        defaultTimeoutMs: toolContext.policy.execution.runnerTimeoutMs,
        maxTimeoutMs: toolContext.policy.execution.runnerMaxTimeoutMs,
      },
      auth: authMode === 'oauth' ? (oauthPassphrase ? 'oauth' : 'missing') : (authToken ? 'required' : 'missing'),
      mcpEndpoint: `${advertisedOrigin}/mcp`,
      grokEndpoint: `${advertisedOrigin}/mcp-grok`,
      bearerEndpoint: `${advertisedOrigin}/mcp-bearer`,
      sessions: {
        ...sessionSnapshot,
        initializing: runtimeStats.initializing,
        activePosts: runtimeStats.activePosts,
        maximumActivePosts: MAX_ACTIVE_POSTS,
        rejectedOverload: runtimeStats.rejectedOverload,
      },
    });
  });

  app.get('/ready', async (_req, res) => {
    const sessionSnapshot = sessionRegistry.snapshot();
    const sessionCapacityReady = sessionSnapshot.acceptingNewSessions
      && runtimeStats.initializing < MAX_INITIALIZING_SESSIONS
      && runtimeStats.activePosts < MAX_ACTIVE_POSTS;
    if (!runtimeControllerHome) {
      res.status(sessionCapacityReady ? 200 : 503).json({
        ready: sessionCapacityReady,
        profile: toolContext.policy.profile,
        gateway: sessionCapacityReady ? 'ready' : 'saturated',
        controllerDaemon: 'not-required',
        sessionCapacity: sessionSnapshot,
      });
      return;
    }
    const daemon = readControllerDaemonStatus(runtimeControllerHome);
    const runtimeState = loadMcpServiceRuntimeState(runtimeControllerHome, repoRoot);
    const repositories = listRepositories(runtimeControllerHome).filter((repository) => repository.enabled && !repository.removedAt);
    const projectionSnapshots = repositories.map((repository) => ({
      repoId: repository.repoId,
      snapshot: readRepositoryProjectionSnapshot(runtimeControllerHome, repository.repoId),
    }));
    const staleRepositories = projectionSnapshots
      .filter(({ snapshot }) => snapshot.stale)
      .map(({ repoId }) => repoId);
    const blockingStaleRepositories = projectionSnapshots
      .filter(({ snapshot }) => projectionBlocksReadiness(snapshot))
      .map(({ repoId }) => repoId);
    const localBridgeHealth = localControllerConfig.enabled
      ? await jsonHealth(localControllerHealthUrl(localControllerConfig.host, localControllerConfig.port))
      : null;
    const localBridgeReady = !localControllerConfig.enabled || isExpectedLocalControllerHealth(localBridgeHealth, {
      repoRoot,
      generation: runtimeGeneration?.generation,
    });
    const daemonReady = daemon.status === 'ready' && daemon.degraded !== true;
    const projectionReady = blockingStaleRepositories.length === 0;
    const publicConfigured = Boolean(runtimeState?.tunnel?.publicEndpoint);
    const publicReady = !publicConfigured || runtimeState?.tunnel?.healthy === true;
    const connectorReady = !publicConfigured || (
      publicReady
      && runtimeState?.tunnel?.connectorNeedsReconnect !== true
      && (!runtimeGeneration?.generation || runtimeState?.generation === runtimeGeneration.generation)
      && (!runtimeGeneration?.generation || runtimeState?.server.generation === runtimeGeneration.generation)
    );
    const ready = daemonReady && projectionReady && localBridgeReady && sessionCapacityReady;
    res.status(ready ? 200 : 503).json({
      ready,
      generation: runtimeGeneration?.generation,
      source: runtimeGeneration?.source,
      gateway: { status: ready ? 'ready' : 'degraded', thin: true, eventLoopIsolatedFromWorkers: true },
      controllerDaemon: daemon,
      localBridge: {
        enabled: localControllerConfig.enabled,
        ready: localBridgeReady,
        endpoint: `http://${localControllerConfig.host === '::1' ? '[::1]' : localControllerConfig.host}:${localControllerConfig.port}/`,
      },
      projections: {
        ready: projectionReady,
        repositoryCount: repositories.length,
        staleRepositories,
        blockingStaleRepositories,
      },
      publicReadiness: {
        configured: publicConfigured,
        ready: publicReady,
        endpoint: runtimeState?.tunnel?.publicEndpoint,
      },
      connectorReadiness: {
        configured: publicConfigured,
        ready: connectorReady,
        connectorNeedsReconnect: runtimeState?.tunnel?.connectorNeedsReconnect === true,
      },
      sessionCapacity: sessionSnapshot,
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
    app.use('/authorize', oauthTraceMiddleware('authorize'));
    // Reject incomplete OAuth requests before rendering the passphrase form.
    app.use('/authorize', rejectIncompleteOAuthAuthorize);
    app.use('/authorize', requirePassphrase(oauthPassphrase ?? ''));
    app.use('/authorize', oauthAuthorizationHandler(oauthProvider));
    app.use('/token', oauthTraceMiddleware('token'));
    app.use('/token', tokenHandler({ provider: oauthProvider, rateLimit: false }));
    app.use('/revoke', oauthTraceMiddleware('revoke'));
    app.use('/revoke', revocationHandler({ provider: oauthProvider, rateLimit: false }));
    app.use('/register', oauthTraceMiddleware('register'));
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
    const protectedResourceMetadata = (resourcePath: '/mcp' | '/mcp-grok' | '/mcp-bearer') => (req: Request, res: Response): void => {
      const origin = getPublicOrigin(req, configuredPublicOrigin);
      res.json({
        resource: `${origin}${resourcePath}`,
        authorization_servers: [origin],
        scopes_supported: ['repo-harness'],
        bearer_methods_supported: ['header'],
      });
    };
    app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata('/mcp'));
    app.get('/.well-known/oauth-protected-resource/mcp-grok', protectedResourceMetadata('/mcp-grok'));
    app.get('/.well-known/oauth-protected-resource/mcp-bearer', protectedResourceMetadata('/mcp-bearer'));
  }

  const setMcpResponseHeaders = (_req: Request, res: Response, next: NextFunction): void => {
    const health = controllerHealth();
    res.setHeader('x-repo-harness-tool-surface', toolSurface);
    res.setHeader('x-repo-harness-tool-surface-version', String(toolSurfaceVersion));
    res.setHeader('x-repo-harness-schema-version', String(toolSurfaceSchemaVersion));
    if (health?.toolset) res.setHeader('x-repo-harness-toolset', health.toolset);
    if (health?.runtimeToolSurfaceFingerprint) res.setHeader('x-repo-harness-runtime-tool-surface-fingerprint', health.runtimeToolSurfaceFingerprint);
    if (health?.toolSurfaceFingerprint) res.setHeader('x-repo-harness-tool-surface-fingerprint', health.toolSurfaceFingerprint);
    next();
  };

  // Primary MCP path: OAuth (or bearer when --auth bearer). Unchanged for ChatGPT.
  app.use('/mcp', setMcpResponseHeaders);
  app.post('/mcp', requireMcpHttpAuth(authMode, authToken, oauthProvider, configuredPublicOrigin), express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    handleMcpPost(req, res, baseOptions, sessionRegistry, runtimeStats, '/mcp').catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });
  app.get('/mcp', requireMcpHttpAuth(authMode, authToken, oauthProvider, configuredPublicOrigin), (req, res) => {
    handleMcpGet(req, res, sessionRegistry, '/mcp').catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });
  app.delete('/mcp', requireMcpHttpAuth(authMode, authToken, oauthProvider, configuredPublicOrigin), (req, res) => {
    handleMcpDelete(req, res, sessionRegistry, '/mcp').catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });

  // Grok-compatible MCP path: OAuth resource separate from ChatGPT's /mcp, same tools.
  app.use('/mcp-grok', setMcpResponseHeaders);
  app.post('/mcp-grok', requireMcpHttpAuth(authMode, authToken, oauthProvider, configuredPublicOrigin, '/mcp-grok'), express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    handleMcpPost(req, res, baseOptions, sessionRegistry, runtimeStats, '/mcp-grok').catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });
  app.get('/mcp-grok', requireMcpHttpAuth(authMode, authToken, oauthProvider, configuredPublicOrigin, '/mcp-grok'), (req, res) => {
    handleMcpGet(req, res, sessionRegistry, '/mcp-grok').catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });
  app.delete('/mcp-grok', requireMcpHttpAuth(authMode, authToken, oauthProvider, configuredPublicOrigin, '/mcp-grok'), (req, res) => {
    handleMcpDelete(req, res, sessionRegistry, '/mcp-grok').catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });

  // Bearer-only MCP path for clients that can send Authorization headers. Never advertises OAuth resource_metadata.
  app.use('/mcp-bearer', setMcpResponseHeaders);
  app.post('/mcp-bearer', requireMcpHttpAuth('bearer', authToken, null, configuredPublicOrigin), express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    handleMcpPost(req, res, baseOptions, sessionRegistry, runtimeStats, '/mcp-bearer').catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });
  app.get('/mcp-bearer', requireMcpHttpAuth('bearer', authToken, null, configuredPublicOrigin), (req, res) => {
    handleMcpGet(req, res, sessionRegistry, '/mcp-bearer').catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });
  app.delete('/mcp-bearer', requireMcpHttpAuth('bearer', authToken, null, configuredPublicOrigin), (req, res) => {
    handleMcpDelete(req, res, sessionRegistry, '/mcp-bearer').catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  const cleanupTimer = setInterval(() => {
    void sessionRegistry.prune();
  }, 60_000);
  cleanupTimer.unref();

  const httpServer = app.listen(port, host);
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 70_000;
  httpServer.requestTimeout = 120_000;

  httpServer.on('close', () => {
    clearInterval(cleanupTimer);
    void sessionRegistry.closeAll('shutdown');
  });

  await new Promise<void>((resolve) => {
    httpServer.once('listening', resolve);
  });
  const authLabel = authMode === 'oauth' ? (oauthPassphrase ? 'oauth' : 'oauth-missing') : (authToken ? 'bearer' : 'missing');
  console.error(
    `repo-harness mcp http listening on http://${host}:${port}/mcp (auth: ${authLabel}), http://${host}:${port}/mcp-grok (auth: ${authLabel}), and http://${host}:${port}/mcp-bearer (auth: bearer)`,
  );

  const shutdown = () => {
    void sessionRegistry.closeAll('shutdown');
    tokenStore?.flush();
    httpServer.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
