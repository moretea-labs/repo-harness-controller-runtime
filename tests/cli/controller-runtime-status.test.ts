import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CONTROLLER_SCHEMA_VERSION, CONTROLLER_TOOL_SURFACE, CONTROLLER_TOOL_SURFACE_VERSION } from '../../src/cli/controller/runtime-config';
import { controllerServiceStatus } from '../../src/cli/controller/lifecycle';
import { writeMcpServiceLocalConfig, writeMcpServiceRuntimeState } from '../../src/cli/mcp/auth';
import { registerRepository } from '../../src/cli/repositories/registry';
import { markRepositoryProjectionDirty } from '../../src/runtime/projections/invalidation';
import { writeJsonAtomic } from '../../src/runtime/shared/json-files';
import {
  collectRuntimeSourceIdentity,
  CONTROLLER_RUNTIME_SOURCE_ROOT_ENV,
  rotateRuntimeGeneration,
} from '../../src/runtime/control-plane/runtime-generation';

const roots: string[] = [];
const servers: Server[] = [];
const previousRuntimeSourceEnv = process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousRuntimeSourceEnv === undefined) delete process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV];
  else process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV] = previousRuntimeSourceEnv;
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(repoRoot: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function initRepo(repoRoot: string): void {
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'status-fixture' }, null, 2));
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Repo Harness Test');
  git(repoRoot, 'add', 'package.json');
  git(repoRoot, 'commit', '-m', 'init');
}

async function startHealthServer(payload: Record<string, unknown>): Promise<number> {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to allocate health server port');
  return address.port;
}

describe('controller runtime status', () => {
  test('marks restartRequired when the active runtime commit falls behind main', async () => {
    const repoRoot = tempRoot('repo-harness-runtime-status-repo-');
    const controllerHome = tempRoot('repo-harness-runtime-status-home-');
    initRepo(repoRoot);
    // Pin the Controller Runtime Source authority to this fixture so status does
    // not compare against the ambient package checkout of the test process.
    process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV] = repoRoot;

    const startedFrom = collectRuntimeSourceIdentity(repoRoot);
    rotateRuntimeGeneration(controllerHome, startedFrom);

    writeFileSync(join(repoRoot, 'README.md'), '# advanced\n');
    git(repoRoot, 'add', 'README.md');
    git(repoRoot, 'commit', '-m', 'advance main');

    const status = await controllerServiceStatus({ repo: repoRoot, controllerHome });
    expect(status.runtimeGeneration).toBeTruthy();
    expect(status.authority.runtimeState.authority).toBe('controller-home');
    expect(status.restartRequired).toBe(true);
    expect(status.restartReasons.some((reason) => reason.includes('runtime commit'))).toBe(true);
  });

  test('ignores workflow artifacts when computing runtime source dirtiness', () => {
    const repoRoot = tempRoot('repo-harness-runtime-dirty-repo-');
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'status-fixture' }, null, 2));
    git(repoRoot, 'init', '-b', 'main');
    git(repoRoot, 'config', 'user.email', 'test@example.com');
    git(repoRoot, 'config', 'user.name', 'Repo Harness Test');
    git(repoRoot, 'add', 'package.json');
    git(repoRoot, 'commit', '-m', 'init');

    mkdirSync(join(repoRoot, 'tasks', 'issues'), { recursive: true });
    writeFileSync(join(repoRoot, 'tasks', 'issues', 'ISS-test.issue.md'), '# pending\n');
    expect(collectRuntimeSourceIdentity(repoRoot).dirty).toBe(false);

    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'new-runtime-file.ts'), 'export const ready = true;\n');
    expect(collectRuntimeSourceIdentity(repoRoot).dirty).toBe(true);
  });

  test('does not degrade readiness for stale idle projections on unrelated repositories', async () => {
    const repoRoot = tempRoot('repo-harness-runtime-projection-main-');
    const otherRepoRoot = tempRoot('repo-harness-runtime-projection-other-');
    const controllerHome = tempRoot('repo-harness-runtime-projection-home-');
    initRepo(repoRoot);
    initRepo(otherRepoRoot);
    process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV] = repoRoot;
    mkdirSync(join(repoRoot, '.ai', 'harness'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'harness', 'policy.json'), '{}\n');
    const livePid = process.ppid > 1 ? process.ppid : process.pid;

    const generation = rotateRuntimeGeneration(controllerHome, collectRuntimeSourceIdentity(repoRoot));
    // Gateway health requires generation identity when a runtime generation is active.
    const mcpPort = await startHealthServer({ status: 'ok', generation: generation.generation });
    const localControllerPort = await startHealthServer({
      status: 'ok',
      toolSurface: CONTROLLER_TOOL_SURFACE,
      schemaVersion: CONTROLLER_SCHEMA_VERSION,
      toolSurfaceVersion: CONTROLLER_TOOL_SURFACE_VERSION,
      generation: generation.generation,
    });

    writeMcpServiceLocalConfig(controllerHome, {
      version: 1,
      repo: repoRoot,
      profile: 'controller',
      toolset: 'advanced',
      server: { host: '127.0.0.1', port: mcpPort, transport: 'http' },
      auth: { mode: 'oauth' },
      localController: { enabled: true, host: '127.0.0.1', port: localControllerPort, autoOpen: false },
    });
    writeMcpServiceRuntimeState(controllerHome, {
      version: 1,
      repo: repoRoot,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'running',
      tunnelMode: 'none',
      generation: generation.generation,
      source: generation.source,
      server: {
        endpoint: `http://127.0.0.1:${mcpPort}/mcp`,
        pid: livePid,
        generation: generation.generation,
        running: true,
        healthy: true,
        restartCount: 0,
        profile: 'controller',
        toolSurface: CONTROLLER_TOOL_SURFACE,
        schemaVersion: CONTROLLER_SCHEMA_VERSION,
        toolSurfaceVersion: CONTROLLER_TOOL_SURFACE_VERSION,
        toolset: 'advanced',
      },
      localController: {
        endpoint: `http://127.0.0.1:${localControllerPort}/`,
        running: true,
        pid: livePid,
        generation: generation.generation,
      },
    });
    writeJsonAtomic(join(controllerHome, 'daemon', 'state.json'), {
      schemaVersion: 1,
      status: 'ready',
      pid: livePid,
      startedAt: new Date().toISOString(),
      gatewaySeparated: true,
      workerIsolation: true,
      generation: generation.generation,
      source: generation.source,
    });
    writeFileSync(join(controllerHome, 'daemon', 'controller.pid'), `${livePid}\n`, 'utf8');
    writeJsonAtomic(join(controllerHome, 'scheduler', 'state.json'), {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      loopStartedAt: new Date().toISOString(),
      lastTickAt: new Date().toISOString(),
      lastDispatchAt: new Date().toISOString(),
      lastReconcileAt: new Date().toISOString(),
      lastRepoDispatch: {},
    });

    registerRepository({ path: repoRoot, controllerHome });
    const otherRepository = registerRepository({ path: otherRepoRoot, controllerHome });
    markRepositoryProjectionDirty(controllerHome, otherRepository.repoId, 'test-stale-idle');

    const status = await controllerServiceStatus({ repo: repoRoot, controllerHome });
    expect(status.readiness.gateway).toBe(true);
    expect(status.readiness.localController).toBe(true);
    expect(status.readiness.daemon).toBe(true);
    expect(status.readiness.scheduler).toBe(true);
    expect(status.readiness.projection).toBe(true);
    expect(status.ready).toBe(true);
    expect(status.problems.some((problem) => problem.includes(otherRepository.repoId))).toBe(false);
    expect(status.infos.some((line) => line.includes(`Ignoring stale idle runtime projections for ${otherRepository.repoId}`))).toBe(true);
  });
});
