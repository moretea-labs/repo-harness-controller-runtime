import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'http';

export interface StableIngressUpstream {
  host: string;
  port: number;
}

export interface StableIngressRouterOptions {
  host: string;
  port: number;
  rescueHost: string;
  rescuePort: number;
  upstream(): StableIngressUpstream | null;
}

export interface StableIngressRouterHandle {
  host: string;
  port: number;
  close(): Promise<void>;
}

function unavailable(response: ServerResponse): void {
  response.statusCode = 503;
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify({ error: { code: 'RUNTIME_GATEWAY_UNAVAILABLE', message: 'The main Gateway is unavailable; the recovery MCP remains available at /rescue/mcp.' } }));
}

function proxy(request: IncomingMessage, response: ServerResponse, target: StableIngressUpstream, path: string): void {
  const headers = {
    ...request.headers,
    host: `${target.host}:${target.port}`,
    'x-forwarded-host': request.headers['x-forwarded-host'] ?? request.headers.host,
    'x-forwarded-proto': request.headers['x-forwarded-proto'] ?? 'https',
  };
  const upstream = httpRequest({
    host: target.host,
    port: target.port,
    method: request.method,
    path,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  // Streamable HTTP and SSE requests may remain idle while the MCP session is
  // healthy. The Gateway owns request deadlines; ingress must not impose a
  // short inactivity timeout that severs valid long-lived sessions.
  upstream.setTimeout(0);
  request.once('aborted', () => upstream.destroy());
  response.once('close', () => {
    if (!response.writableEnded) upstream.destroy();
  });
  upstream.once('error', () => {
    if (response.headersSent) response.destroy();
    else unavailable(response);
  });
  request.pipe(upstream);
}

export async function createStableIngressRouter(options: StableIngressRouterOptions): Promise<StableIngressRouterHandle> {
  const server: Server = createServer((request, response) => {
    const url = request.url ?? '/';
    if (request.method === 'GET' && url === '/.well-known/oauth-protected-resource/rescue/mcp') {
      const proto = String(request.headers['x-forwarded-proto'] ?? 'https').split(',')[0].trim();
      const host = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '').split(',')[0].trim();
      if (!host) {
        unavailable(response);
        return;
      }
      const origin = `${proto}://${host}`;
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'no-store');
      response.end(JSON.stringify({ resource: `${origin}/rescue/mcp`, authorization_servers: [origin], scopes_supported: ['repo-harness'] }));
      return;
    }
    if (url === '/rescue/health') {
      proxy(request, response, { host: options.rescueHost, port: options.rescuePort }, '/health');
      return;
    }
    if (url === '/rescue/mcp' || url.startsWith('/rescue/mcp?')) {
      proxy(request, response, { host: options.rescueHost, port: options.rescuePort }, url);
      return;
    }
    const target = options.upstream();
    if (!target) {
      unavailable(response);
      return;
    }
    proxy(request, response, target, url);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    host: options.host,
    port,
    close: async () => await new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}
