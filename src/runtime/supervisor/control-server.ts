import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'http';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { createServer as createSocketServer, type Socket } from 'net';
import { randomBytes } from 'crypto';
import { dirname } from 'path';
import { supervisorControlSocketPath, supervisorRescueAuthPath } from './paths';
import { readMcpServiceBearerToken, mcpServiceOAuthTokenStoreFallbackPaths, mcpServiceOAuthTokenStorePath } from '../../cli/mcp/auth';
import { McpOAuthTokenStore } from '../../cli/mcp/oauth';
import { dispatchRescueTool, RESCUE_MCP_TOOLS, type RescueDispatchContext } from './rescue-mcp';
import type { SupervisorCommandRequest, SupervisorCommandResponse, SupervisorOperation, SupervisorOperationKind, SupervisorState } from './types';

export const DEFAULT_SUPERVISOR_CONTROL_HOST = '127.0.0.1';
export const DEFAULT_SUPERVISOR_CONTROL_PORT = 8770;

export interface SupervisorControlHandlers extends RescueDispatchContext {
  stop(): Promise<void>;
  submitCommand(input: { requestId: string; kind: SupervisorOperationKind; actor: string; reason?: string; candidateReleasePath?: string }): { operation: SupervisorOperation; deduplicated: boolean };
}

export interface SupervisorControlServerOptions {
  controllerHome: string;
  repoRoot?: string;
  controlHost?: string;
  controlPort?: number;
  authToken?: string;
  handlers: SupervisorControlHandlers;
  onStopped?: () => void;
}

export interface SupervisorControlServerHandle {
  host: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

function ensureAuthToken(controllerHome: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const path = supervisorRescueAuthPath(controllerHome);
  try {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown };
    if (typeof existing.token === 'string' && existing.token.trim()) return existing.token;
  } catch { /* create below */ }
  const token = randomBytes(32).toString('base64url');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, token })}\n`, 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      const existing = JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown };
      if (typeof existing.token === 'string' && existing.token.trim()) return existing.token;
    } catch {
      throw new Error('SUPERVISOR_RESCUE_AUTH_UNCERTAIN: token file exists but is not readable');
    }
    throw new Error('SUPERVISOR_RESCUE_AUTH_UNCERTAIN: token file exists without a valid token');
  }
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return token;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
}

function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return typeof value === 'string' && /^Bearer\s+/i.test(value) ? value.replace(/^Bearer\s+/i, '').trim() : undefined;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = '';
    let settled = false;
    request.setEncoding('utf8');
    const onData = (chunk: string): void => {
      if (settled) return;
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') <= 128 * 1024) return;
      settled = true;
      request.off('data', onData);
      request.resume();
      reject(new Error('RESCUE_REQUEST_TOO_LARGE'));
    };
    request.on('data', onData);
    request.on('end', () => {
      if (!settled) resolveBody(body);
    });
    request.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleRescueMcp(
  request: IncomingMessage,
  response: ServerResponse,
  tokens: { rescue: string; main?: string; oauthToken: (token: string) => ReturnType<McpOAuthTokenStore['getAccessToken']> },
  handlers: SupervisorControlHandlers,
  mutationAllowed: () => boolean,
): Promise<void> {
  const supplied = bearer(request);
  const oauthInfo = supplied ? tokens.oauthToken(supplied) : undefined;
  const oauthValid = Boolean(oauthInfo && (!oauthInfo.expiresAt || oauthInfo.expiresAt > Math.floor(Date.now() / 1000)));
  if (!supplied || (supplied !== tokens.rescue && supplied !== tokens.main && !oauthValid)) {
    const proto = String(request.headers['x-forwarded-proto'] ?? 'https').split(',')[0].trim();
    const host = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '').split(',')[0].trim();
    const metadata = host ? `${proto}://${host}/.well-known/oauth-protected-resource/rescue/mcp` : undefined;
    response.setHeader('www-authenticate', metadata
      ? `Bearer realm="repo-harness-recovery", resource_metadata="${metadata}"`
      : 'Bearer realm="repo-harness-recovery"');
    json(response, 401, { error: { code: 'RESCUE_AUTH_REQUIRED', message: 'A valid Recovery token, main MCP bearer token, or existing MCP OAuth access token is required.' } });
    return;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? ''))) {
    json(response, 415, { error: { code: 'RESCUE_CONTENT_TYPE_REQUIRED', message: 'Content-Type application/json is required.' } });
    return;
  }
  let message: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    message = JSON.parse(await readBody(request)) as typeof message;
  } catch (error) {
    if (error instanceof Error && error.message === 'RESCUE_REQUEST_TOO_LARGE') throw error;
    json(response, 400, rpcError(null, -32700, 'Invalid JSON.'));
    return;
  }
  const id = message.id ?? null;
  if (message.method === 'notifications/initialized') {
    response.statusCode = 202;
    response.end();
    return;
  }
  if (message.method === 'initialize') {
    json(response, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'repo-harness-recovery', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    json(response, 200, { jsonrpc: '2.0', id, result: { tools: RESCUE_MCP_TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    const name = typeof message.params?.name === 'string' ? message.params.name : '';
    if (name !== 'runtime_status' && name !== 'runtime_operation_get' && !mutationAllowed()) {
      json(response, 429, rpcError(id, -32029, 'Recovery mutation rate limit exceeded.'));
      return;
    }
    try {
      const result = dispatchRescueTool(name, message.params?.arguments, handlers);
      const text = JSON.stringify(result.payload);
      json(response, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text }],
          structuredContent: result.payload,
          ...(result.isError ? { isError: true } : {}),
        },
      });
    } catch (error) {
      json(response, 200, rpcError(id, -32602, error instanceof Error ? error.message : String(error)));
    }
    return;
  }
  json(response, 200, rpcError(id, -32601, `Unsupported MCP method: ${message.method ?? '(missing)'}`));
}

function parseCommand(value: string): SupervisorCommandRequest | null {
  try {
    const parsed = JSON.parse(value) as SupervisorCommandRequest;
    if (!parsed || typeof parsed.command !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function commandResponse(request: SupervisorCommandRequest, handlers: SupervisorControlHandlers, onStopped?: () => void): SupervisorCommandResponse {
  if (request.command === 'ping') return { ok: true };
  if (request.command === 'status') return { ok: true, state: handlers.getState() ?? undefined };
  if (request.command === 'operation_get') {
    const operation = request.operationId ? handlers.getOperation(request.operationId) : undefined;
    return operation ? { ok: true, operation } : { ok: false, error: { code: 'OPERATION_NOT_FOUND', message: 'Operation not found.' } };
  }
  if (request.command === 'operation_submit') {
    if (!request.requestId || !request.kind) return { ok: false, error: { code: 'OPERATION_INPUT_REQUIRED', message: 'requestId and kind are required.' } };
    const accepted = handlers.submitCommand({
      requestId: request.requestId,
      kind: request.kind,
      actor: request.actor ?? 'control-socket',
      reason: request.reason,
      candidateReleasePath: request.candidateReleasePath,
    });
    return { ok: true, deduplicated: accepted.deduplicated, operation: accepted.operation };
  }
  if (request.command === 'stop') {
    void handlers.stop().then(() => onStopped?.());
    return { ok: true, state: handlers.getState() ?? undefined };
  }
  return { ok: false, error: { code: 'COMMAND_NOT_SUPPORTED', message: 'Unsupported Supervisor command.' } };
}

export async function createSupervisorControlServer(options: SupervisorControlServerOptions): Promise<SupervisorControlServerHandle> {
  const host = options.controlHost ?? DEFAULT_SUPERVISOR_CONTROL_HOST;
  const token = ensureAuthToken(options.controllerHome, options.authToken);
  const oauthToken = (supplied: string): ReturnType<McpOAuthTokenStore['getAccessToken']> => {
    // Re-read the durable store for every recovery request so newly issued and
    // revoked main-Connector tokens take effect without restarting Supervisor.
    const store = new McpOAuthTokenStore(
      mcpServiceOAuthTokenStorePath(options.controllerHome),
      mcpServiceOAuthTokenStoreFallbackPaths(options.controllerHome, options.repoRoot),
    );
    store.load();
    return store.getAccessToken(supplied);
  };
  const mainBearerToken = readMcpServiceBearerToken(options.controllerHome, options.repoRoot);
  const mutationWindows = new Map<string, number[]>();
  const mutationAllowed = (request: IncomingMessage): boolean => {
    const key = request.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const recent = (mutationWindows.get(key) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= 10) return false;
    recent.push(now);
    mutationWindows.set(key, recent);
    return true;
  };
  const socketPath = supervisorControlSocketPath(options.controllerHome);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) unlinkSync(socketPath);

  const socketServer = createSocketServer((socket: Socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => {
      buffer = `${buffer}${chunk}`.slice(-128 * 1024);
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = parseCommand(line);
        const response = request ? commandResponse(request, options.handlers, options.onStopped) : { ok: false, error: { code: 'INVALID_COMMAND', message: 'Invalid JSON command.' } };
        socket.write(`${JSON.stringify(response)}\n`);
        newline = buffer.indexOf('\n');
      }
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    socketServer.once('error', reject);
    socketServer.listen(socketPath, () => resolveListen());
  });
  try { chmodSync(socketPath, 0o600); } catch { /* best effort */ }

  const httpServer: HttpServer = createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      json(response, 200, { status: 'ok', server: 'repo-harness-recovery', supervisor: options.handlers.getState()?.observedState ?? 'unknown' });
      return;
    }
    if (request.method === 'POST' && (request.url === '/rescue/mcp' || request.url?.startsWith('/rescue/mcp?'))) {
      void handleRescueMcp(
        request,
        response,
        { rescue: token, main: mainBearerToken ?? undefined, oauthToken },
        options.handlers,
        () => mutationAllowed(request),
      ).catch((error) => {
        if (response.headersSent || response.destroyed) return;
        const message = error instanceof Error ? error.message : String(error);
        json(response, message === 'RESCUE_REQUEST_TOO_LARGE' ? 413 : 400, {
          error: {
            code: message === 'RESCUE_REQUEST_TOO_LARGE' ? 'RESCUE_REQUEST_TOO_LARGE' : 'RESCUE_REQUEST_FAILED',
            message: message.slice(0, 500),
          },
        });
      });
      return;
    }
    json(response, 404, { error: { code: 'NOT_FOUND', message: 'Only /health and /rescue/mcp are available.' } });
  });
  await new Promise<void>((resolveListen, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.controlPort ?? DEFAULT_SUPERVISOR_CONTROL_PORT, host, () => resolveListen());
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : options.controlPort ?? DEFAULT_SUPERVISOR_CONTROL_PORT;

  return {
    host,
    port,
    token,
    close: async () => {
      await Promise.all([
        new Promise<void>((resolveClose) => httpServer.close(() => resolveClose())),
        new Promise<void>((resolveClose) => socketServer.close(() => resolveClose())),
      ]);
      try { unlinkSync(socketPath); } catch { /* already gone */ }
    },
  };
}

export async function sendSupervisorCommand(controllerHome: string, request: SupervisorCommandRequest): Promise<SupervisorCommandResponse> {
  const net = await import('net');
  const socketPath = supervisorControlSocketPath(controllerHome);
  return await new Promise<SupervisorCommandResponse>((resolveResponse, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('SUPERVISOR_CONTROL_TIMEOUT'));
    }, 5_000);
    socket.setEncoding('utf8');
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('data', (chunk) => {
      data = `${data}${chunk}`;
      const newline = data.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try { resolveResponse(JSON.parse(data.slice(0, newline)) as SupervisorCommandResponse); } catch (error) { reject(error); }
    });
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  });
}
