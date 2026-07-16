import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureStableSupervisorLayout, supervisorCurrentReleasePath, supervisorReleasesRoot } from '../../src/runtime/supervisor/paths';
import { scheduleControllerServiceRestart, readControllerRestartState } from '../../src/cli/controller/restart-coordinator';
import { ensureControllerDaemon } from '../../src/runtime/control-plane/daemon-client';

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
  test('routes legacy restart scheduling into a durable Supervisor operation', () => {
    const controllerHome = installedHome();
    const result = scheduleControllerServiceRestart({
      repo: process.cwd(),
      controllerHome,
      requestId: 'compat-restart-1',
      requestedBy: 'test',
      reason: 'compatibility',
      mode: 'detached',
    });
    expect(result.action).toBe('restart_scheduled');
    if (result.action !== 'restart_scheduled') return;
    expect(result.state.supervisorOperationId).toBeString();
    expect(result.state.delayMs).toBe(0);
    expect(readControllerRestartState(controllerHome, 'compat-restart-1')?.supervisorOperationId).toBe(result.state.supervisorOperationId);
  });

  test('refuses Gateway-side daemon creation when a stable release is installed', () => {
    const status = ensureControllerDaemon(installedHome());
    expect(status.status).toBe('unavailable');
    expect(status.error).toBe('SUPERVISOR_REQUIRED');
    expect(status.restartRequired).toBe(true);
  });
});
