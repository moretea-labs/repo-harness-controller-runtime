import { describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'crypto';
import { createServer } from 'net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mcpControllerHomeOAuthPath, mcpControllerHomeTokenPath } from '../../src/cli/mcp/auth';
import { runMcpSetupChatgpt } from '../../src/cli/mcp/setup';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        server.close(() => reject(new Error('unable to allocate test port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch (_error) {
      // Server is still starting.
    }
    await Bun.sleep(50);
  }
  throw new Error('MCP HTTP server did not become healthy');
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'repo-harness-test', version: '0' },
    },
  });
}

async function withTestControllerHome<T>(repoRoot: string, fn: (controllerHome: string) => Promise<T>): Promise<T> {
  const previous = process.env.REPO_HARNESS_CONTROLLER_HOME;
  const controllerHome = join(repoRoot, '.controller-home');
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  try {
    return await fn(controllerHome);
  } finally {
    if (previous === undefined) delete process.env.REPO_HARNESS_CONTROLLER_HOME;
    else process.env.REPO_HARNESS_CONTROLLER_HOME = previous;
  }
}

async function stopMcpServerProcess(proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | null): Promise<void> {
  if (!proc) return;
  proc.kill();
  await proc.exited.catch(() => undefined);
}

describe('mcp http transport', () => {
  test('requires bearer auth and accepts authenticated initialize requests', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-mcp-http-'));
    const port = await freePort();
    let proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | null = null;
    try {
      await withTestControllerHome(repoRoot, async (controllerHome) => {
        mkdirSync(join(repoRoot, '.ai/harness'), { recursive: true });
        writeFileSync(join(repoRoot, '.ai/harness/policy.json'), '{}\n');
        runMcpSetupChatgpt({ repo: repoRoot, port: String(port) });
        const token = (await Bun.file(mcpControllerHomeTokenPath(controllerHome)).json()).bearerToken;

        proc = Bun.spawn(
          [
            'bun',
            'src/cli/index.ts',
            'mcp',
            'serve',
            '--repo',
            repoRoot,
            '--transport',
            'http',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--profile',
            'planner',
            '--auth',
            'bearer',
          ],
          { cwd: process.cwd(), stdout: 'ignore', stderr: 'pipe', env: { ...process.env, REPO_HARNESS_CONTROLLER_HOME: controllerHome } },
        );
        await waitForHealth(port);

        const health = await fetch(`http://127.0.0.1:${port}/health`);
        expect(await health.json()).toMatchObject({
          status: 'ok',
          auth: 'required',
          mcpEndpoint: `http://127.0.0.1:${port}/mcp`,
          grokEndpoint: `http://127.0.0.1:${port}/mcp-grok`,
          bearerEndpoint: `http://127.0.0.1:${port}/mcp-bearer`,
          sessions: {
            active: 0,
            maximum: 64,
            activePosts: 0,
            activeStreams: 0,
            maximumActivePosts: 32,
          },
        });

        const noAuth = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: initializeBody(),
        });
        expect(noAuth.status).toBe(401);

        const badJson = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: '{bad',
        });
        expect(badJson.status).toBe(400);

        const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody(),
        });
        expect(initialized.status).toBe(200);
        const sessionId = initialized.headers.get('mcp-session-id');
        expect(sessionId).toBeTruthy();
        expect(await initialized.text()).toContain('repo-harness-mcp');

        const streamController = new AbortController();
        const stream = await fetch(`http://127.0.0.1:${port}/mcp`, {
          headers: {
            authorization: `Bearer ${token}`,
            'mcp-session-id': sessionId!,
            accept: 'text/event-stream',
          },
          signal: streamController.signal,
        });
        expect(stream.status).toBe(200);
        await Bun.sleep(25);
        const streamingHealth = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
        expect(streamingHealth.sessions.active).toBe(1);
        expect(streamingHealth.sessions.activeStreams).toBe(1);
        streamController.abort();
        await stream.body?.cancel().catch(() => undefined);
        await Bun.sleep(100);
        const closedStreamHealth = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
        expect(closedStreamHealth.sessions.activeStreams).toBe(0);
      });
    } finally {
      await stopMcpServerProcess(proc);
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('supports ChatGPT-compatible OAuth authorization flow', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-mcp-oauth-'));
    const port = await freePort();
    let proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | null = null;
    try {
      await withTestControllerHome(repoRoot, async (controllerHome) => {
        mkdirSync(join(repoRoot, '.ai/harness'), { recursive: true });
        writeFileSync(join(repoRoot, '.ai/harness/policy.json'), '{}\n');
        runMcpSetupChatgpt({ repo: repoRoot, port: String(port) });
        const passphrase = (await Bun.file(mcpControllerHomeOAuthPath(controllerHome)).json()).passphrase;
        const staticBearerToken = 'static-bearer-token';
        writeFileSync(
          mcpControllerHomeTokenPath(controllerHome),
          `${JSON.stringify({ version: 1, bearerToken: staticBearerToken }, null, 2)}\n`,
        );

        proc = Bun.spawn(
          [
            'bun',
            'src/cli/index.ts',
            'mcp',
            'serve',
            '--repo',
            repoRoot,
            '--transport',
            'http',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--profile',
            'planner',
          ],
          { cwd: process.cwd(), stdout: 'ignore', stderr: 'pipe', env: { ...process.env, REPO_HARNESS_CONTROLLER_HOME: controllerHome } },
        );
        await waitForHealth(port);

        const health = await fetch(`http://127.0.0.1:${port}/health`);
        expect(await health.json()).toMatchObject({
          status: 'ok',
          auth: 'oauth',
          mcpEndpoint: `http://127.0.0.1:${port}/mcp`,
          grokEndpoint: `http://127.0.0.1:${port}/mcp-grok`,
          bearerEndpoint: `http://127.0.0.1:${port}/mcp-bearer`,
        });

        const metadata = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`, {
          headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.test' },
        });
        expect(await metadata.json()).toMatchObject({
          resource: 'https://example.test/mcp',
          authorization_servers: ['https://example.test'],
        });

        const grokMetadata = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp-grok`, {
          headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.test' },
        });
        expect(await grokMetadata.json()).toMatchObject({
          resource: 'https://example.test/mcp-grok',
          authorization_servers: ['https://example.test'],
        });

        const registered = await fetch(`http://127.0.0.1:${port}/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['http://localhost/callback'],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            client_name: 'repo-harness-test',
          }),
        });
        expect(registered.status).toBe(201);
        const client = await registered.json() as { client_id: string };
        expect(typeof client.client_id).toBe('string');

        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const authorizeBody = new URLSearchParams({
          passphrase,
          client_id: client.client_id,
          redirect_uri: 'http://localhost/callback',
          response_type: 'code',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: 'state-1',
        });
        const authorized = await fetch(`http://127.0.0.1:${port}/authorize`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: authorizeBody,
          redirect: 'manual',
        });
        expect(authorized.status).toBe(302);
        const redirect = new URL(authorized.headers.get('location') ?? '');
        const code = redirect.searchParams.get('code');
        expect(code).toBeTruthy();

        const token = await fetch(`http://127.0.0.1:${port}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: client.client_id,
            code: code ?? '',
            code_verifier: verifier,
            redirect_uri: 'http://localhost/callback',
          }),
        });
        expect(token.status).toBe(200);
        const tokenJson = await token.json() as { access_token: string; token_type: string };
        expect(tokenJson.token_type).toBe('Bearer');

        const noAuth = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: initializeBody(),
        });
        expect(noAuth.status).toBe(401);
        expect(noAuth.headers.get('www-authenticate')).toContain('resource_metadata');
        expect(noAuth.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');

        const grokNoAuth = await fetch(`http://127.0.0.1:${port}/mcp-grok`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: initializeBody(),
        });
        expect(grokNoAuth.status).toBe(401);
        expect(grokNoAuth.headers.get('www-authenticate')).toContain('resource_metadata');
        expect(grokNoAuth.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp-grok');

        // Bearer-only endpoint must not advertise OAuth resource_metadata.
        const bearerNoAuth = await fetch(`http://127.0.0.1:${port}/mcp-bearer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: initializeBody(),
        });
        expect(bearerNoAuth.status).toBe(401);
        const bearerWwwAuth = bearerNoAuth.headers.get('www-authenticate') ?? '';
        expect(bearerWwwAuth).toContain('Bearer realm="repo-harness-mcp"');
        expect(bearerWwwAuth).not.toContain('resource_metadata');
        expect(await bearerNoAuth.json()).toMatchObject({ error: 'unauthorized' });

        const bearerAuthed = await fetch(`http://127.0.0.1:${port}/mcp-bearer`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${staticBearerToken}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody(),
        });
        expect(bearerAuthed.status).toBe(200);
        expect(await bearerAuthed.text()).toContain('repo-harness-mcp');

        // Incomplete OAuth authorize must not render the passphrase form.
        const incompleteAuthorize = await fetch(`http://127.0.0.1:${port}/authorize`);
        expect(incompleteAuthorize.status).toBe(400);
        expect(incompleteAuthorize.headers.get('content-type') ?? '').toContain('application/json');
        const incompleteText = await incompleteAuthorize.text();
        expect(incompleteText).not.toContain('type="password"');
        expect(incompleteText).not.toContain('name="passphrase"');
        const incompleteBody = JSON.parse(incompleteText) as { message?: string; error?: string };
        expect(incompleteBody.error).toBe('invalid_request');
        expect(incompleteBody.message ?? '').toContain('/mcp-bearer');

        // Valid authorize request still shows passphrase page before submission.
        const authorizeForm = await fetch(
          `http://127.0.0.1:${port}/authorize?${new URLSearchParams({
            client_id: client.client_id,
            redirect_uri: 'http://localhost/callback',
            response_type: 'code',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state: 'state-form',
            resource: `http://127.0.0.1:${port}/mcp-grok`,
          }).toString()}`,
        );
        expect(authorizeForm.status).toBe(200);
        expect(authorizeForm.headers.get('content-type') ?? '').toContain('text/html');
        const formHtml = await authorizeForm.text();
        expect(formHtml).toContain('type="password"');
        expect(formHtml).toContain('name="passphrase"');
        expect(formHtml).toContain('Authorize repo-harness');
        expect(formHtml).toContain('name="resource"');
        expect(formHtml).toContain(encodeURI(`http://127.0.0.1:${port}/mcp-grok`).replace(/&/g, '&amp;'));

        const initializedGrokWithOAuth = await fetch(`http://127.0.0.1:${port}/mcp-grok`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${tokenJson.access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody(),
        });
        expect(initializedGrokWithOAuth.status).toBe(200);
        expect(await initializedGrokWithOAuth.text()).toContain('repo-harness-mcp');

        const fallbackVerifier = randomBytes(32).toString('base64url');
        const fallbackChallenge = createHash('sha256').update(fallbackVerifier).digest('base64url');
        const fallbackClientId = `grok-client-${randomBytes(4).toString('hex')}`;
        const fallbackRedirectUri = 'https://grok.com/oauth/callback';
        const fallbackAuthorized = await fetch(`http://127.0.0.1:${port}/authorize`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            passphrase,
            client_id: fallbackClientId,
            redirect_uri: fallbackRedirectUri,
            response_type: 'code',
            code_challenge: fallbackChallenge,
            code_challenge_method: 'S256',
            state: 'grok-state-1',
            resource: `http://127.0.0.1:${port}/mcp-grok`,
          }),
          redirect: 'manual',
        });
        expect(fallbackAuthorized.status).toBe(302);
        const fallbackRedirect = new URL(fallbackAuthorized.headers.get('location') ?? '');
        expect(fallbackRedirect.origin).toBe('https://grok.com');
        expect(fallbackRedirect.searchParams.get('state')).toBe('grok-state-1');
        const fallbackCode = fallbackRedirect.searchParams.get('code');
        expect(fallbackCode).toBeTruthy();

        const fallbackToken = await fetch(`http://127.0.0.1:${port}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: fallbackClientId,
            code: fallbackCode ?? '',
            code_verifier: fallbackVerifier,
            redirect_uri: fallbackRedirectUri,
            resource: `http://127.0.0.1:${port}/mcp-grok`,
          }),
        });
        expect(fallbackToken.status).toBe(200);
        const fallbackTokenJson = await fallbackToken.json() as { access_token: string; token_type: string };
        expect(fallbackTokenJson.token_type).toBe('Bearer');

        const fallbackInitializedGrok = await fetch(`http://127.0.0.1:${port}/mcp-grok`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${fallbackTokenJson.access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody(),
        });
        expect(fallbackInitializedGrok.status).toBe(200);
        expect(await fallbackInitializedGrok.text()).toContain('repo-harness-mcp');

        const initializedWithStaticBearer = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${staticBearerToken}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody(),
        });
        expect(initializedWithStaticBearer.status).toBe(200);
        expect(await initializedWithStaticBearer.text()).toContain('repo-harness-mcp');

        const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${tokenJson.access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody(),
        });
        expect(initialized.status).toBe(200);
        expect(await initialized.text()).toContain('repo-harness-mcp');
      });
    } finally {
      await stopMcpServerProcess(proc);
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
