import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/cli/repositories/registry';
import { buildWorkflowWatchdogReport } from '../../src/runtime/watchdog/workflow-watchdog';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-watchdog-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-watchdog-controller-'));
  roots.push(repoRoot, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  return { controllerHome, repository: registerRepository({ path: repoRoot, controllerHome }) };
}

describe('workflow watchdog', () => {
  it('builds a bounded read-only diagnosis over jobs, schedules, and runtime processes', () => {
    const { controllerHome, repository } = fixture();
    const report = buildWorkflowWatchdogReport(controllerHome, repository, { includeProcesses: false });
    expect(report.repoId).toBe(repository.repoId);
    expect(report.queues.schedules.total).toBe(0);
    expect(report.recoveryPlan.every((entry) => entry.risk !== 'destructive')).toBe(true);
  });

  it('does not classify terminal Agent Runs as stale active work', () => {
    const { controllerHome, repository } = fixture();
    const runRoot = join(repository.canonicalRoot, '.ai/harness/jobs', 'RUN-terminal');
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(join(runRoot, 'meta.json'), `${JSON.stringify({
      schemaVersion: 1,
      runId: 'RUN-terminal',
      issueId: 'ISS-test',
      taskId: 'T1',
      status: 'succeeded',
      provider: 'local',
      agent: 'codex',
      createdAt: '2026-07-01T00:00:00.000Z',
      finishedAt: '2026-07-01T00:01:00.000Z',
      lastHeartbeatAt: '2026-07-01T00:01:00.000Z',
      progress: { lastActivityAt: '2026-07-01T00:01:00.000Z', currentActivity: 'done' },
    }, null, 2)}\n`);
    const report = buildWorkflowWatchdogReport(controllerHome, repository, { includeProcesses: false, staleMinutes: 10 });
    expect(report.staleWork.some((entry) => entry.id === 'RUN-terminal')).toBe(false);
    expect(report.findings.some((entry) => entry.code === 'STALE_WORK_ITEMS')).toBe(false);
  });
});
