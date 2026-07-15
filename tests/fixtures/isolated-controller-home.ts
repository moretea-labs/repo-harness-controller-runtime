import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { terminateProcessesByCommand, waitForNoProcessesByCommand } from '../runtime/process-hygiene';

export interface IsolatedControllerFixture {
  repoRoot: string;
  controllerHome: string;
  mcpPort: number;
  localControllerPort: number;
  greenMcpPort: number;
  greenLocalPort: number;
  matchers: string[];
}

const fixtures: IsolatedControllerFixture[] = [];

export async function allocateFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate free port'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}

/**
 * Create a fully isolated controller fixture that must never touch the real
 * REPO_HARNESS_CONTROLLER_HOME or default ports.
 */
export async function createIsolatedControllerFixture(prefix = 'repo-harness-isolated-'): Promise<IsolatedControllerFixture> {
  const repoRoot = mkdtempSync(join(tmpdir(), `${prefix}repo-`));
  const controllerHome = mkdtempSync(join(tmpdir(), `${prefix}home-`));
  const mcpPort = await allocateFreePort();
  const localControllerPort = await allocateFreePort();
  const greenMcpPort = await allocateFreePort();
  const greenLocalPort = await allocateFreePort();

  mkdirSync(join(repoRoot, '.ai', 'harness'), { recursive: true });
  mkdirSync(join(repoRoot, 'tasks'), { recursive: true });
  mkdirSync(join(repoRoot, '.repo-harness'), { recursive: true });
  writeFileSync(join(repoRoot, '.ai', 'harness', 'policy.json'), '{}\n');
  writeFileSync(join(repoRoot, 'tasks', 'current.md'), '# Current\n');
  writeFileSync(
    join(repoRoot, '.repo-harness', 'mcp.local.json'),
    `${JSON.stringify({
      version: 1,
      profile: 'controller',
      server: { host: '127.0.0.1', port: mcpPort },
      auth: { mode: 'bearer' },
      localController: { enabled: true, host: '127.0.0.1', port: localControllerPort, autoOpen: false },
    }, null, 2)}\n`,
  );
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Repo Harness Test'], { cwd: repoRoot, stdio: 'ignore' });

  // Guard: fixture homes must not be the real user controller home.
  const realHome = process.env.HOME ? join(process.env.HOME, '.repo-harness', 'controller') : '';
  if (realHome && (controllerHome === realHome || repoRoot === realHome)) {
    throw new Error('TEST_GUARD: fixture collided with real controller home');
  }

  const fixture: IsolatedControllerFixture = {
    repoRoot,
    controllerHome,
    mcpPort,
    localControllerPort,
    greenMcpPort,
    greenLocalPort,
    matchers: [repoRoot, controllerHome],
  };
  fixtures.push(fixture);
  return fixture;
}

export function isolatedControllerEnv(fixture: IsolatedControllerFixture, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    REPO_HARNESS_CONTROLLER_HOME: fixture.controllerHome,
    REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT: extra.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT
      ?? process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT
      ?? '',
    REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER: extra.REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER ?? '',
    REPO_HARNESS_CONTROLLER_START_TIMEOUT_MS: extra.REPO_HARNESS_CONTROLLER_START_TIMEOUT_MS ?? '45000',
    // Ensure tests never pick up host tunnel/ngrok rotation.
    REPO_HARNESS_NGROK_ROTATION_CONFIG: join(fixture.controllerHome, 'disabled-ngrok-rotation.env'),
    REPO_HARNESS_CONTROLLER_EXTERNAL_TUNNEL: 'none',
  };
}

export async function destroyIsolatedControllerFixture(fixture: IsolatedControllerFixture): Promise<void> {
  await terminateProcessesByCommand(fixture.matchers);
  await waitForNoProcessesByCommand(fixture.matchers);
  rmSync(fixture.repoRoot, { recursive: true, force: true });
  rmSync(fixture.controllerHome, { recursive: true, force: true });
}

export async function destroyAllIsolatedControllerFixtures(): Promise<void> {
  for (const fixture of fixtures.splice(0)) {
    await destroyIsolatedControllerFixture(fixture);
  }
}

/**
 * Assert current process env is not pointing at the real user controller home
 * when running isolated lifecycle tests.
 */
export function assertIsolatedControllerEnv(controllerHome: string): void {
  const real = process.env.HOME ? join(process.env.HOME, '.repo-harness', 'controller') : '';
  if (real && controllerHome === real) {
    throw new Error('TEST_GUARD: isolated test refused real ~/.repo-harness/controller');
  }
  if (controllerHome.includes('/_ops/controller-home') && !controllerHome.includes(tmpdir())) {
    throw new Error(`TEST_GUARD: isolated test refused repo ops controller home: ${controllerHome}`);
  }
}
