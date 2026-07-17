import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { bootstrapLaunchAgentWithRetry } from '../../src/cli/controller/launch-agents';
import { supervisorActivationMatchesRelease } from '../../src/cli/commands/supervisor';
import { renderLaunchdSupervisorPlist, renderSystemdSupervisorUnit, supervisorServiceLabel, supervisorSystemdUnitName } from '../../src/runtime/supervisor/installer';
import { createStableIngressRouter } from '../../src/runtime/supervisor/ingress-router';
import { controllerDaemonMaxLifetimeMs } from '../../src/runtime/control-plane/daemon-entry';
import { createSupervisorOperation, readSupervisorOperation, updateSupervisorOperation } from '../../src/runtime/supervisor/operation-store';
import { automaticRecoveryRequestId, managedProcessNeedsReleaseRefresh, reconcileActiveManagedGenerations, reconcileSupervisorStateWithAuthority, terminalizeInterruptedSupervisorOperations } from '../../src/runtime/supervisor/supervisor-runtime';
import { decideRestart, newRestartBudgetRecord, recordFailure, recordRestart, recordStable } from '../../src/runtime/supervisor/restart-policy';
import { SupervisorProcessManager } from '../../src/runtime/supervisor/process-manager';
import { writeMcpServiceLocalConfig } from '../../src/cli/mcp/auth';
import { writeActiveSlotAuthority } from '../../src/cli/controller/runtime-slots';
import { readCurrentSupervisorRelease } from '../../src/runtime/supervisor/paths';
import { createSupervisorControlServer } from '../../src/runtime/supervisor/control-server';
import type { SupervisorManagedProcess, SupervisorState } from '../../src/runtime/supervisor/types';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  return { server, port: address.port };
}

function managedProcess(slot: 'blue' | 'green', pid: number, generation: string): SupervisorManagedProcess {
  return {
    pid,
    instanceId: `process-${pid}`,
    processStartTime: `start-${pid}`,
    executableFingerprint: `fingerprint-${pid}`,
    controllerHome: `/tmp/${slot}`,
    slot,
    generation,
    ownerEpoch: 1,
    state: 'running',
    restartCount: 0,
    consecutiveFailures: 0,
  };
}

describe('Stable Supervisor production hardening', () => {
  test('OS services restart crashes but preserve explicit successful stop', () => {
    const plist = renderLaunchdSupervisorPlist({
      label: 'com.example.supervisor',
      bunPath: '/usr/local/bin/bun',
      supervisorPath: '/tmp/supervisor.js',
      repoRoot: '/tmp/repo',
      controllerHome: '/tmp/home',
      runtimeSourceRoot: '/tmp/repo',
      releaseRevision: 'revision-a',
      logPath: '/tmp/supervisor.log',
    });
    expect(plist).toContain('<key>SuccessfulExit</key><false/>');
    expect(plist).toContain('--release-revision');
    expect(plist).toContain('revision-a');
    expect(plist).not.toContain('<key>KeepAlive</key><true/>');
    const unit = renderSystemdSupervisorUnit({
      bunPath: '/usr/local/bin/bun',
      supervisorPath: '/tmp/supervisor.js',
      repoRoot: '/tmp/repo',
      controllerHome: '/tmp/home',
      runtimeSourceRoot: '/tmp/repo',
    });
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toContain('Restart=always');
    const spaced = renderSystemdSupervisorUnit({
      bunPath: '/Users/example/My Tools/bun',
      supervisorPath: '/Users/example/Controller Home/supervisor.js',
      repoRoot: '/Users/example/Repo Harness',
      controllerHome: '/Users/example/Controller Home',
      runtimeSourceRoot: '/Users/example/Repo Harness',
    });
    expect(spaced).toContain('ExecStart="/Users/example/My Tools/bun"');
    expect(supervisorSystemdUnitName('/tmp/a/controller-home')).not.toBe(supervisorSystemdUnitName('/tmp/b/controller-home'));
    expect(supervisorServiceLabel('/tmp/a/controller-home')).not.toBe(supervisorServiceLabel('/tmp/b/controller-home'));
  });

  test('temporary harness daemons self-expire while production homes do not', () => {
    const temporary = join(tmpdir(), 'repo-harness-supervisor-test', 'controller-home');
    expect(controllerDaemonMaxLifetimeMs(temporary, '')).toBe(5 * 60_000);
    expect(controllerDaemonMaxLifetimeMs('/Users/example/controller-home', '')).toBeUndefined();
    expect(controllerDaemonMaxLifetimeMs('/Users/example/controller-home', '2500')).toBe(2500);
  });

  test('stable ingress does not impose a five-second timeout on valid MCP streams', async () => {
    const main = await listen((_request, response) => {
      setTimeout(() => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: 'ok', delayed: true }));
      }, 5_100);
    });
    const rescue = await listen((_request, response) => response.end('{}'));
    const router = await createStableIngressRouter({
      host: '127.0.0.1', port: 0, rescueHost: '127.0.0.1', rescuePort: rescue.port,
      upstream: () => ({ host: '127.0.0.1', port: main.port }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${router.port}/mcp`);
      expect(response.status).toBe(200);
      expect((await response.json() as { delayed?: boolean }).delayed).toBe(true);
    } finally {
      await router.close();
    }
  }, 10_000);

  test('stable ingress keeps recovery routes available when the main Gateway is absent', async () => {
    const main = await listen((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok', source: 'main' }));
    });
    const rescue = await listen((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok', path: request.url }));
    });
    let upstream: { host: string; port: number } | null = { host: '127.0.0.1', port: main.port };
    const router = await createStableIngressRouter({
      host: '127.0.0.1',
      port: 0,
      rescueHost: '127.0.0.1',
      rescuePort: rescue.port,
      upstream: () => upstream,
    });
    try {
      const mainHealth = await fetch(`http://127.0.0.1:${router.port}/health`).then((response) => response.json()) as { source?: string };
      expect(mainHealth.source).toBe('main');
      upstream = null;
      const unavailable = await fetch(`http://127.0.0.1:${router.port}/health`);
      expect(unavailable.status).toBe(503);
      const rescueHealth = await fetch(`http://127.0.0.1:${router.port}/rescue/health`).then((response) => response.json()) as { path?: string };
      expect(rescueHealth.path).toBe('/health');
      const discovery = await fetch(`http://127.0.0.1:${router.port}/.well-known/oauth-protected-resource/rescue/mcp`, {
        headers: { host: 'recovery.example.test', 'x-forwarded-proto': 'https' },
      }).then((response) => response.json()) as { resource?: string };
      expect(discovery.resource).toBe('https://recovery.example.test/rescue/mcp');
    } finally {
      await router.close();
    }
  });

  test('Rescue MCP accepts query paths and rejects oversized bodies without dropping the response', async () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-supervisor-control-'));
    const control = await createSupervisorControlServer({
      controllerHome: home,
      repoRoot: process.cwd(),
      controlPort: 0,
      authToken: 'test-recovery-token',
      handlers: {
        getState: () => null,
        getOperation: () => null,
        submitOperation: () => { throw new Error('unexpected mutation'); },
        submitCommand: () => { throw new Error('unexpected mutation'); },
        stop: async () => undefined,
      },
    });
    try {
      const endpoint = `http://127.0.0.1:${control.port}/rescue/mcp?session=test`;
      const initialized = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer test-recovery-token', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(initialized.status).toBe(200);
      const oversized = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer test-recovery-token', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', padding: 'x'.repeat(129 * 1024) }),
      });
      expect(oversized.status).toBe(413);
      const payload = await oversized.json() as { error?: { code?: string } };
      expect(payload.error?.code).toBe('RESCUE_REQUEST_TOO_LARGE');
    } finally {
      await control.close();
    }
  });

  test('installed release descriptors preserve immutable child executable identity', async () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-supervisor-release-'));
    const release = join(home, 'supervisor', 'releases', 'release-a');
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, 'supervisor.js'), '');
    writeFileSync(join(release, 'repo-harness.js'), '');
    writeFileSync(join(release, 'daemon.js'), 'setInterval(() => undefined, 1000);');
    writeFileSync(join(release, 'manifest.json'), JSON.stringify({ releaseRevision: 'revision-a', sourceRoot: process.cwd() }));
    mkdirSync(join(home, 'supervisor'), { recursive: true });
    symlinkSync(release, join(home, 'supervisor', 'current'), 'dir');
    const descriptor = readCurrentSupervisorRelease(home);
    expect(descriptor).toBeDefined();
    expect(descriptor?.releaseRevision).toBe('revision-a');
    const manager = new SupervisorProcessManager({
      repoRoot: process.cwd(), controllerHome: home, runtimeSourceRoot: process.cwd(), ownerEpoch: 1,
      runtimeExecutable: descriptor?.runtimeExecutable, daemonExecutable: descriptor?.daemonExecutable,
      releasePath: descriptor?.releasePath, releaseRevision: descriptor?.releaseRevision,
      logPath: join(home, 'supervisor.log'), slot: 'green',
    });
    expect(manager.gatewayArgs(join(home, 'runtime-slots', 'green'))[0]).toBe(descriptor!.runtimeExecutable);
    const spawned = await manager.startDaemon();
    try {
      expect(spawned.identity.releasePath).toBe(descriptor!.releasePath);
      expect(spawned.identity.releaseRevision).toBe('revision-a');
    } finally {
      await manager.stop(spawned.identity);
    }
  });

  test('new Supervisor release handoff replaces healthy persisted children from an older release', () => {
    const oldDaemon = {
      ...managedProcess('blue', 301, 'generation-old'),
      releasePath: '/tmp/releases/old',
      releaseRevision: 'old-revision',
      ownerEpoch: 7,
    };
    const expected = {
      releasePath: '/tmp/releases/current',
      releaseRevision: 'new-revision',
      supervisorExecutable: '/tmp/releases/current/supervisor.js',
      runtimeExecutable: '/tmp/releases/current/repo-harness.js',
      daemonExecutable: '/tmp/releases/current/daemon.js',
    };
    expect(managedProcessNeedsReleaseRefresh(oldDaemon, expected, 8, true)).toBe(true);
    expect(managedProcessNeedsReleaseRefresh({ ...oldDaemon, releasePath: expected.releasePath, releaseRevision: expected.releaseRevision, ownerEpoch: 8 }, expected, 8, true)).toBe(false);
  });

  test('healthy Supervisor status from an older release cannot satisfy activation', () => {
    const control = {
      ok: true,
      state: {
        observedState: 'healthy',
        supervisor: { releaseRevision: 'old-revision' },
        controllerDaemon: { releaseRevision: 'old-revision' },
        gatewayHost: { releaseRevision: 'old-revision' },
      },
    };
    expect(supervisorActivationMatchesRelease(control, 'new-revision')).toBe(false);
    expect(supervisorActivationMatchesRelease({
      ...control,
      state: {
        ...control.state,
        supervisor: { releaseRevision: 'new-revision' },
        controllerDaemon: { releaseRevision: 'new-revision' },
        gatewayHost: { releaseRevision: 'new-revision' },
      },
    }, 'new-revision')).toBe(true);
  });

  test('launchd bootstrap retries bounded macOS error 5', async () => {
    const calls: string[][] = [];
    let bootstrapAttempts = 0;
    const attempts = await bootstrapLaunchAgentWithRetry({
      label: 'com.example.supervisor',
      plistPath: '/Users/example/Library/LaunchAgents/com.example.supervisor.plist',
      domain: 'gui/501',
      retryDelayMs: 0,
    }, {
      run: (args) => {
        calls.push(args);
        if (args[0] === 'enable') return { ok: true, stdout: '', stderr: '' };
        if (args[0] === 'bootstrap') {
          bootstrapAttempts += 1;
          if (bootstrapAttempts < 3) return { ok: false, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
        }
        return { ok: true, stdout: '', stderr: '' };
      },
      wait: async () => undefined,
    });
    expect(attempts).toBe(3);
    expect(calls.filter((args) => args[0] === 'bootstrap')).toHaveLength(3);
    expect(calls[0]).toEqual(['enable', 'gui/501/com.example.supervisor']);
  });

  test('Gateway hosts bind private slot backends and never own the public tunnel', () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-supervisor-routing-'));
    writeActiveSlotAuthority(home, { activeSlot: 'blue', reason: 'test' });
    writeMcpServiceLocalConfig(home, {
      version: 1,
      profile: 'controller',
      toolset: 'core',
      auth: { mode: 'bearer' },
      server: { host: '127.0.0.1', port: 8765 },
      localController: { enabled: true, host: '127.0.0.1', port: 8766, autoOpen: false },
      chatgpt: { endpoint: 'https://stable.example.test/mcp' },
    });
    const manager = new SupervisorProcessManager({
      repoRoot: process.cwd(),
      controllerHome: home,
      runtimeSourceRoot: process.cwd(),
      ownerEpoch: 1,
      logPath: join(home, 'supervisor.log'),
    });
    const args = manager.gatewayArgs(home);
    expect(args[args.indexOf('--port') + 1]).toBe('8785');
    expect(args[args.indexOf('--tunnel') + 1]).toBe('none');
  });

  test('a new failure resets the stable recovery window', () => {
    const started = new Date('2026-07-17T00:00:00.000Z');
    const stable = recordStable(newRestartBudgetRecord('controllerDaemon', 'generation-a', started), started);
    const failed = recordFailure(stable, 'process exited', new Date(started.getTime() + 1_000));
    expect(failed.stableSinceAt).toBeUndefined();
  });

  test('restart backoff is temporary and does not become persistent lockout', () => {
    const now = new Date('2026-07-17T00:00:00.000Z');
    const first = recordRestart(newRestartBudgetRecord('gatewayHost', 'generation-a', now), now);
    const decision = decideRestart(first, new Date(now.getTime() + 100), undefined, 0.5);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('backoff');
    expect(first.lockedOut).toBe(false);
    expect(automaticRecoveryRequestId('gatewayHost', 'generation-a', first))
      .not.toBe(automaticRecoveryRequestId('gatewayHost', 'generation-a', { ...first, attempts: first.attempts + 1 }));
  });

  test('restart reconciliation follows active-slot authority after a pre-cutover crash', () => {
    const blueDaemon = managedProcess('blue', 101, 'generation-blue');
    const blueGateway = managedProcess('blue', 102, 'generation-blue');
    const greenDaemon = managedProcess('green', 201, 'generation-green');
    const greenGateway = managedProcess('green', 202, 'generation-green');
    const state: SupervisorState = {
      schemaVersion: 1,
      supervisor: {
        pid: 1,
        instanceId: 'supervisor',
        processStartTime: 'start',
        executableFingerprint: 'fingerprint',
        controllerHome: '/tmp/controller-home',
        ownerEpoch: 1,
        epoch: 1,
        startedAt: '2026-07-17T00:00:00.000Z',
      },
      desiredState: 'running',
      observedState: 'degraded',
      activeSlot: 'green',
      previousSlot: 'blue',
      activeGeneration: 'generation-green',
      controllerDaemon: greenDaemon,
      gatewayHost: greenGateway,
      standby: { slot: 'blue', generation: 'generation-blue', controllerDaemon: blueDaemon, gatewayHost: blueGateway },
      ingress: { state: 'running', activeUpstreamSlot: 'green', activeUpstreamPort: 8795 },
      restartBudget: {},
      currentOperationId: 'rollout-operation',
      lastIncident: null,
      updatedAt: '2026-07-17T00:00:00.000Z',
    };
    const reconciled = reconcileSupervisorStateWithAuthority(state, {
      schemaVersion: 1,
      activeSlot: 'blue',
      updatedAt: '2026-07-17T00:00:01.000Z',
      reason: 'cutover-not-committed',
    });
    expect(reconciled.activeSlot).toBe('blue');
    expect(reconciled.controllerDaemon?.pid).toBe(101);
    expect(reconciled.gatewayHost?.pid).toBe(102);
    expect(reconciled.standby?.slot).toBe('green');
    expect(reconciled.ingress.activeUpstreamSlot).toBe('blue');
  });

  test('active generation advances only when daemon and Gateway observations agree', () => {
    const daemon = managedProcess('blue', 201, 'generation-old');
    const gateway = managedProcess('blue', 202, 'generation-old');
    const state: SupervisorState = {
      schemaVersion: 1,
      supervisor: {
        pid: 200,
        instanceId: 'supervisor-generation',
        processStartTime: 'start',
        executableFingerprint: 'fingerprint',
        controllerHome: '/tmp/controller-home',
        ownerEpoch: 1,
        epoch: 1,
        startedAt: '2026-07-17T00:00:00.000Z',
      },
      desiredState: 'running',
      observedState: 'healthy',
      activeSlot: 'blue',
      activeGeneration: 'generation-old',
      controllerDaemon: daemon,
      gatewayHost: gateway,
      ingress: { state: 'running', activeUpstreamSlot: 'blue', activeUpstreamPort: 8785 },
      restartBudget: {},
      currentOperationId: null,
      lastIncident: null,
      updatedAt: '2026-07-17T00:00:00.000Z',
    };
    const split = reconcileActiveManagedGenerations(state, {
      controllerDaemon: 'generation-new',
      gatewayHost: 'generation-old',
    });
    expect(split.coherent).toBe(false);
    expect(split.state.controllerDaemon?.generation).toBe('generation-new');
    expect(split.state.gatewayHost?.generation).toBe('generation-old');
    expect(split.state.activeGeneration).toBe('generation-old');

    const synchronized = reconcileActiveManagedGenerations(split.state, {
      controllerDaemon: 'generation-new',
      gatewayHost: 'generation-new',
    });
    expect(synchronized.coherent).toBe(true);
    expect(synchronized.generation).toBe('generation-new');
    expect(synchronized.state.controllerDaemon?.generation).toBe('generation-new');
    expect(synchronized.state.gatewayHost?.generation).toBe('generation-new');
    expect(synchronized.state.activeGeneration).toBe('generation-new');
  });

  test('interrupted mutations become explicit failures instead of blind replay', () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-supervisor-operation-'));
    const created = createSupervisorOperation({
      controllerHome: home,
      repoRoot: process.cwd(),
      requestId: 'interrupted-1',
      kind: 'restart_full',
      requestedBy: 'test',
      actor: 'test',
    });
    updateSupervisorOperation(home, created.operation.operationId, { phase: 'stopping', startedAt: new Date().toISOString() });
    expect(terminalizeInterruptedSupervisorOperations(home)).toBe(1);
    const operation = readSupervisorOperation(home, created.operation.operationId);
    expect(operation?.phase).toBe('failed');
    expect(operation?.error).toBe('SUPERVISOR_RESTART_INTERRUPTED_OPERATION');
  });
});
