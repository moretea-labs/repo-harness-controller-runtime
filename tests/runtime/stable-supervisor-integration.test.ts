import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureStableSupervisorLayout, supervisorCurrentReleasePath, supervisorReleasesRoot } from '../../src/runtime/supervisor/paths';
import { scheduleControllerServiceRestart, readControllerRestartState } from '../../src/cli/controller/restart-coordinator';
import { ensureControllerDaemon } from '../../src/runtime/control-plane/daemon-client';
import { captureProcessIdentity } from '../../src/runtime/supervisor/identity';
import { createSupervisorState, writeSupervisorState } from '../../src/runtime/supervisor/state-store';

function installedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'stable-supervisor-integration-'));
  ensureStableSupervisorLayout(home);
  const release = join(supervisorReleasesRoot(home), 'fixture');
  mkdirSync(release, { recursive: true });
  for (const entry of ['supervisor.js', 'repo-harness.js', 'daemon.js']) writeFileSync(join(release, entry), '# fixture\n');
  symlinkSync(release, supervisorCurrentReleasePath(home), 'dir');
  return home;
}

describe('stable Supervisor compatibility integration', () => {
  test('falls back to the detached coordinator when a release is installed but no Supervisor is alive', () => {
    const controllerHome = installedHome();
    const result = scheduleControllerServiceRestart({
      repo: process.cwd(),
      controllerHome,
      requestId: 'compat-restart-bootstrap',
      requestedBy: 'test',
      reason: 'first installation handoff',
      mode: 'detached',
    }, {
      launch: () => 4242,
    });
    expect(result.action).toBe('restart_scheduled');
    if (result.action !== 'restart_scheduled') return;
    expect(result.state.supervisorOperationId).toBeUndefined();
    expect(result.state.launcherPid).toBe(4242);
    expect(result.state.delayMs).toBeGreaterThan(0);
  });

  test('routes legacy restart scheduling into a durable operation only when Supervisor identity is live', () => {
    const controllerHome = installedHome();
    const identity = captureProcessIdentity(process.pid, {
      controllerHome,
      instanceId: 'test-live-supervisor',
      ownerEpoch: 1,
    });
    expect(identity).toBeDefined();
    writeSupervisorState(controllerHome, createSupervisorState(controllerHome, identity!));
    const result = scheduleControllerServiceRestart({
      repo: process.cwd(),
      controllerHome,
      requestId: 'compat-restart-live',
      requestedBy: 'test',
      reason: 'compatibility',
      mode: 'detached',
    });
    expect(result.action).toBe('restart_scheduled');
    if (result.action !== 'restart_scheduled') return;
    expect(result.state.supervisorOperationId).toBeString();
    expect(result.state.delayMs).toBe(0);
    expect(readControllerRestartState(controllerHome, 'compat-restart-live')?.supervisorOperationId).toBe(result.state.supervisorOperationId);
  });

  test('refuses Gateway-side daemon creation when a stable release is installed', () => {
    const status = ensureControllerDaemon(installedHome());
    expect(status.status).toBe('unavailable');
    expect(status.error).toBe('SUPERVISOR_REQUIRED');
    expect(status.restartRequired).toBe(true);
  });
});
