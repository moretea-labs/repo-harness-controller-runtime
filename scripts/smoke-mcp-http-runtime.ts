import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerRepository } from '../src/cli/repositories/registry';
import { readControllerDaemonStatus } from '../src/runtime/control-plane/daemon-client';

const root = mkdtempSync(join(tmpdir(), 'repo-harness-mcp-http-smoke-'));
const repoRoot = join(root, 'repo');
const controllerHome = join(root, 'controller');
let serverPid: number | undefined;
let daemonPid: number | undefined;

function git(...args: string[]): void { execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'ignore' }); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('PORT_DISCOVERY_FAILED'));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
async function waitJson(url: string, timeoutMs: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.json() as Record<string, unknown>;
      return { status: response.status, body };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(100);
    }
  }
  throw new Error(`HTTP_SMOKE_TIMEOUT: ${url}: ${lastError}`);
}

try {
  execFileSync('mkdir', ['-p', repoRoot]);
  git('init');
  git('config', 'user.email', 'mcp-smoke@example.invalid');
  git('config', 'user.name', 'MCP Smoke');
  writeFileSync(join(repoRoot, 'README.md'), '# MCP HTTP smoke\n', 'utf8');
  git('add', 'README.md');
  git('commit', '-m', 'initial');
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'mcp-http-smoke' });
  const port = await freePort();
  const child = spawn(process.execPath, [
    '--loader', join(process.cwd(), 'src/runtime/shared/node-ts-loader.mjs'),
    join(process.cwd(), 'src/cli/index.ts'), 'mcp', 'serve', '--repo', repoRoot,
    '--transport', 'http', '--enable-dev-runner', '--dev-runner-agents', 'codex,claude', '--host', '127.0.0.1', '--port', String(port), '--profile', 'controller', '--auth', 'oauth',
  ], {
    env: { ...process.env, REPO_HARNESS_CONTROLLER_HOME: controllerHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverPid = child.pid;
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  child.once('exit', (code) => {
    if (code && code !== 0) stderr += `\nserver exited ${code}`;
  });

  const health = await waitJson(`http://127.0.0.1:${port}/health`, 20_000);
  if (health.status !== 200 || health.body.status !== 'ok') throw new Error(`HEALTH_FAILED: ${JSON.stringify(health)} ${stderr}`);
  if (health.body.toolset !== 'core') throw new Error(`TOOLSET_CHANGED: ${String(health.body.toolset)}`);
  if (health.body.toolCount !== 29) throw new Error(`TOOL_COUNT_CHANGED: ${String(health.body.toolCount)}`);
  if (health.body.compatibilityToolCount !== 86) throw new Error(`LEGACY_MCP_TOOL_COUNT_CHANGED: ${String(health.body.compatibilityToolCount)}`);
  if (health.body.toolSurfaceFingerprint !== 'bd5bd8c9ae39ccdf') throw new Error(`FINGERPRINT_CHANGED: ${String(health.body.toolSurfaceFingerprint)}`);

  let ready = await waitJson(`http://127.0.0.1:${port}/ready`, 20_000);
  const readyDeadline = Date.now() + 20_000;
  while (ready.status !== 200 && Date.now() < readyDeadline) {
    await sleep(100);
    ready = await waitJson(`http://127.0.0.1:${port}/ready`, 2_000);
  }
  if (ready.status !== 200 || ready.body.ready !== true) throw new Error(`READINESS_FAILED: ${JSON.stringify(ready)} ${stderr}`);
  const repoHealth = await waitJson(`http://127.0.0.1:${port}/repos/${repository.repoId}/health`, 10_000);
  if (repoHealth.status !== 200 || repoHealth.body.status !== 'ok') throw new Error(`REPOSITORY_HEALTH_FAILED: ${JSON.stringify(repoHealth)}`);
  daemonPid = readControllerDaemonStatus(controllerHome).pid;

  console.log(JSON.stringify({
    status: 'ok', port, repoId: repository.repoId,
    toolset: health.body.toolset,
    toolCount: health.body.toolCount,
    runtimeFingerprint: health.body.runtimeToolSurfaceFingerprint,
    compatibilityToolCount: health.body.compatibilityToolCount,
    fingerprint: health.body.toolSurfaceFingerprint,
    ready: ready.body.ready,
    repositoryHealth: repoHealth.body.status,
  }, null, 2));
} finally {
  if (serverPid) { try { process.kill(serverPid, 'SIGTERM'); } catch { /* stopped */ } }
  if (daemonPid) { try { process.kill(daemonPid, 'SIGTERM'); } catch { /* stopped */ } }
  await sleep(250);
  rmSync(root, { recursive: true, force: true });
}
