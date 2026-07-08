import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { repositoryControllerRoot } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import {
  applyRuntimeMaintenance,
  applyRuntimeStorageRepair,
  buildRuntimeMaintenanceStatus,
  previewRuntimeStorageRepair,
} from '../../src/runtime/recovery';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-runtime-storage-repair-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-runtime-storage-repair-controller-'));
  roots.push(repoRoot, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 1;\n');
  const repository = registerRepository({ path: repoRoot, controllerHome });
  return { repoRoot, controllerHome, repository };
}

function writeJobAtLocalJobsRoot(localJobsRoot: string, jobId: string, job: Record<string, unknown>) {
  const dir = join(localJobsRoot, jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), `${JSON.stringify({
    schemaVersion: 1,
    jobId,
    action: 'launch-task',
    payload: { issueId: 'ISS-1', taskId: 'T1' },
    requestedBy: 'test',
    approval: 'auto',
    status: 'dispatched',
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...job,
  }, null, 2)}\n`, 'utf-8');
}

function writeLocalJob(repoRoot: string, jobId: string, job: Record<string, unknown>) {
  writeJobAtLocalJobsRoot(join(repoRoot, '.ai/harness/local-jobs'), jobId, job);
}

describe('runtime storage local-jobs repair', () => {
  it('previews and terminalizes dispatched Local Jobs whose projected Execution Job is missing', () => {
    const { repoRoot, controllerHome, repository } = fixture();
    writeLocalJob(repoRoot, 'JOB-missing-ejob', {
      result: { executionJobId: 'EJOB-missing', controllerHome },
    });

    const preview = previewRuntimeStorageRepair(repository, controllerHome, { minAgeMinutes: 0 });
    expect(preview.mutates).toBe(false);
    expect(preview.candidates.map((candidate) => candidate.kind)).toContain('missing_projected_execution_job');

    const applied = applyRuntimeStorageRepair(repository, controllerHome, { confirmRepair: true, minAgeMinutes: 0 });
    expect(applied.applied.some((entry) => entry.status === 'applied')).toBe(true);
    const repaired = JSON.parse(readFileSync(join(repoRoot, '.ai/harness/local-jobs/JOB-missing-ejob/job.json'), 'utf-8')) as { status: string; error?: string };
    expect(repaired.status).toBe('failed');
    expect(repaired.error).toContain('projected Execution Job EJOB-missing is missing');
  });

  it('quarantines unreadable local job directories without crossing repo scope', () => {
    const { repoRoot, controllerHome, repository } = fixture();
    const dir = join(repoRoot, '.ai/harness/local-jobs/JOB-unreadable');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'job.json'), '{not json', 'utf-8');

    const preview = previewRuntimeStorageRepair(repository, controllerHome, { minAgeMinutes: 0 });
    expect(preview.candidates.map((candidate) => candidate.kind)).toContain('unreadable_job_json');
    const applied = applyRuntimeStorageRepair(repository, controllerHome, { confirmRepair: true, minAgeMinutes: 0 });
    expect(applied.applied[0]?.status).toBe('applied');
    expect(applied.auditPath).toBe('.ai/harness/controller/runtime-storage-repair.jsonl');
  });

  it('routes controller-home local job repair through runtime maintenance status and apply', () => {
    const { controllerHome, repository } = fixture();
    const controllerLocalJobsRoot = join(repositoryControllerRoot(controllerHome, repository.repoId), 'local-jobs');
    writeJobAtLocalJobsRoot(controllerLocalJobsRoot, 'JOB-controller-missing-ejob', {
      result: { executionJobId: 'EJOB-controller-missing', controllerHome },
    });

    const status = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 0 });
    expect(status.runtimeStorageRepair.inspectedRoots.some((root) => root.kind === 'controller' && root.exists)).toBe(true);
    expect(status.runtimeStorageRepair.candidates.map((candidate) => candidate.kind)).toContain('missing_projected_execution_job');
    expect(status.recommendedActions).toContain('local_jobs_reconcile');

    const applied = applyRuntimeMaintenance(repository, controllerHome, {
      actionId: 'local_jobs_reconcile',
      confirmMaintenance: true,
      minAgeMinutes: 0,
    });
    expect(applied.runtimeStorageRepairApply?.applied.some((entry) => entry.status === 'applied')).toBe(true);
    const repaired = JSON.parse(readFileSync(join(controllerLocalJobsRoot, 'JOB-controller-missing-ejob/job.json'), 'utf-8')) as { status: string };
    expect(repaired.status).toBe('failed');
  });
});
