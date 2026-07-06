import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  RECOVERY_ACTIONS,
  assertRecoveryAuthorized,
  buildCapabilityRecoverySnapshot,
  buildPatchHandoffArtifact,
  buildRecoveryAuditRecord,
  buildRuntimeMaintenanceStatus,
  buildSelfHealingLoopPlan,
  applyRuntimeMaintenance,
  classifyFailure,
  detectDirtyPathConflicts,
} from '../../src/runtime/recovery';

describe('capability recovery classifier', () => {
  it('classifies platform blocks without treating them as local failures', () => {
    expect(classifyFailure("This tool call was blocked by OpenAI's safety checks.")).toBe('platform_blocked');
  });

  it('classifies auth and agent runtime failures', () => {
    expect(classifyFailure('Transport channel closed, when Auth(AuthorizationRequired)')).toBe('auth_required');
    expect(classifyFailure('timeout waiting for child process to exit')).toBe('agent_runtime_failure');
  });

  it('classifies runtime storage local-job blockers distinctly', () => {
    expect(classifyFailure('RUNTIME_STORAGE_NOT_READY: local-jobs: active or unreadable Local Jobs must finish before runtime storage can be relocated')).toBe('local_jobs_legacy_active');
  });
});

describe('capability recovery probe', () => {
  it('reports ready when local capabilities are healthy', () => {
    const snapshot = buildCapabilityRecoverySnapshot({
      generatedAt: '2026-07-05T00:00:00.000Z',
      daemonStatus: 'ready',
      schedulerStatus: 'ready',
      queueDepth: 0,
      runningWorkers: 0,
      activeLeases: 0,
      localBridgeRunning: true,
      connectorHealthy: true,
      runtimeProjectionStale: false,
      runtimeProjectionPersisted: true,
      commandPreviewAvailable: true,
      commandExecuteAvailable: true,
      issueToolsAvailable: true,
      jobToolsAvailable: true,
      pluginStates: [{ pluginId: 'github', enabled: true, healthState: 'ready', ready: true }],
    });

    expect(snapshot.overallState).toBe('ready');
    expect(snapshot.fallbackRequired).toBe(false);
  });

  it('routes platform blocks to patch handoff instead of restart loops', () => {
    const snapshot = buildCapabilityRecoverySnapshot({
      generatedAt: '2026-07-05T00:00:00.000Z',
      daemonStatus: 'ready',
      schedulerStatus: 'ready',
      localBridgeRunning: true,
      connectorHealthy: true,
      commandPreviewAvailable: true,
      commandExecuteAvailable: false,
      issueToolsAvailable: false,
      jobToolsAvailable: false,
      recentErrors: ["This tool call was blocked by OpenAI's safety checks."],
    });

    const actionIds = snapshot.recommendedActions.map((action) => action.id);
    expect(snapshot.platformBlocked).toBe(true);
    expect(snapshot.fallbackRequired).toBe(true);
    expect(actionIds).toContain('recovery.create_patch_handoff');
    expect(actionIds).not.toContain('recovery.restart_controller');
  });

  it('routes runtime storage blockers to the maintenance executor', () => {
    const snapshot = buildCapabilityRecoverySnapshot({
      generatedAt: '2026-07-05T00:00:00.000Z',
      daemonStatus: 'ready',
      schedulerStatus: 'ready',
      localBridgeRunning: true,
      connectorHealthy: true,
      runtimeStorageReady: false,
      runtimeStorageWarnings: ['local-jobs: active or unreadable Local Jobs must finish before runtime storage can be relocated'],
      commandPreviewAvailable: true,
      commandExecuteAvailable: false,
      recentErrors: ['RUNTIME_STORAGE_NOT_READY: local-jobs: active or unreadable Local Jobs must finish before runtime storage can be relocated'],
    });

    const actionIds = snapshot.recommendedActions.map((action) => action.id);
    expect(snapshot.capabilities.find((capability) => capability.id === 'runtime.storage')?.class).toBe('local_jobs_legacy_active');
    expect(actionIds).toContain('recovery.local_jobs_reconcile');
    expect(actionIds).toContain('recovery.runtime_storage_finalize_relocation');
    expect(snapshot.notes.join(' ')).toContain('runtime_maintenance_apply');
  });

  it('detects stale worker state as recoverable runtime state', () => {
    const snapshot = buildCapabilityRecoverySnapshot({
      generatedAt: '2026-07-05T00:00:00.000Z',
      daemonStatus: 'ready',
      schedulerStatus: 'ready',
      queueDepth: 2,
      runningWorkers: 0,
      activeLeases: 1,
      localBridgeRunning: true,
      connectorHealthy: true,
    });

    expect(snapshot.capabilities.find((capability) => capability.id === 'worker.loop')?.class).toBe('stale_runtime_state');
    expect(snapshot.recommendedActions.map((action) => action.id)).toContain('recovery.reconcile_jobs');
  });
});

describe('authorized recovery actions', () => {
  it('requires explicit authorization for mutating recovery', () => {
    expect(() => assertRecoveryAuthorized(RECOVERY_ACTIONS.rebuildProjection)).toThrow('RECOVERY_AUTHORIZATION_REQUIRED');
    expect(() => assertRecoveryAuthorized(RECOVERY_ACTIONS.rebuildProjection, RECOVERY_ACTIONS.rebuildProjection.id)).not.toThrow();
  });

  it('builds audit evidence records', () => {
    const record = buildRecoveryAuditRecord({
      actor: 'test',
      action: RECOVERY_ACTIONS.reconcileJobs,
      result: 'planned',
      reason: 'stale lease evidence',
      affectedPaths: ['.ai/harness/jobs'],
      at: '2026-07-05T00:00:00.000Z',
    });

    expect(record.id).toMatch(/^REC-/);
    expect(record.confirmation).toBe('authorization');
    expect(record.affectedPaths).toEqual(['.ai/harness/jobs']);
  });
});


describe('runtime maintenance executor', () => {
  function tempRepo() {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-maintenance-test-'));
    const controllerHome = join(root, '_controller_home');
    const localJobs = join(root, '.ai/harness/local-jobs');
    mkdirSync(localJobs, { recursive: true });
    return { root, controllerHome, localJobs, repository: { repoId: 'repo-test', canonicalRoot: root } };
  }

  it('terminalizes stale active Local Jobs without using Local Job tickets', () => {
    const { controllerHome, localJobs, repository } = tempRepo();
    const jobDir = join(localJobs, 'JOB-stale');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, 'job.json'), `${JSON.stringify({
      schemaVersion: 1,
      jobId: 'JOB-stale',
      action: 'repository-command',
      status: 'running',
      createdAt: '2026-07-05T00:00:00.000Z',
      updatedAt: '2026-07-05T00:00:00.000Z',
      workerPid: 99999999,
    }, null, 2)}
`);

    const before = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 0 });
    expect(before.recommendedActions).toContain('local_jobs_reconcile');

    const applied = applyRuntimeMaintenance(repository, controllerHome, {
      actionId: 'local_jobs_reconcile',
      confirmMaintenance: true,
      minAgeMinutes: 0,
    });
    expect(applied.applied.some((candidate) => candidate.applied && candidate.id === 'JOB-stale')).toBe(true);
    const stored = JSON.parse(readFileSync(join(jobDir, 'job.json'), 'utf8')) as { status: string; error: string };
    expect(stored.status).toBe('orphaned');
    expect(stored.error).toContain('runtime maintenance');
  });

  it('quarantines unreadable Local Job entries', () => {
    const { controllerHome, localJobs, repository } = tempRepo();
    mkdirSync(join(localJobs, 'JOB-broken'), { recursive: true });
    const applied = applyRuntimeMaintenance(repository, controllerHome, {
      actionId: 'quarantine_unreadable_local_jobs',
      confirmMaintenance: true,
      minAgeMinutes: 0,
    });
    expect(applied.applied.some((candidate) => candidate.applied && candidate.id === 'JOB-broken')).toBe(true);
  });

  it('plans model repair only after bounded local recovery and restart fallback', () => {
    const plan = buildSelfHealingLoopPlan({
      objective: 'fix repeated TypeError in recovery apply',
      recentErrors: ['TypeError: cannot read properties of undefined'],
      chatgptAvailable: false,
      codexCliAvailable: true,
      deepseekAvailable: true,
    });

    expect(plan.failureClass).toBe('source_defect_suspected');
    expect(plan.modelRepairProducer.preferredProducer).toBe('local_codex_cli');
    expect(plan.phases.map((phase) => phase.id)).toEqual(['observe', 'local-maintenance', 'restart-fallback', 'model-repair-generation', 'continuation']);
  });
});

describe('sandbox patch handoff artifact', () => {
  it('deduplicates touched paths and records a stable diff hash', () => {
    const artifact = buildPatchHandoffArtifact({
      issueId: 'ISS-1',
      taskId: 'T1',
      baseHead: 'abc123',
      branch: 'worktree/recovery',
      diff: 'diff --git a/a b/a\n',
      touchedPaths: ['src/a.ts', 'src/a.ts'],
      checks: [{ id: 'package:check:type', status: 'passed' }],
      actor: 'codex',
      source: 'blocked-chatgpt-session',
      createdAt: '2026-07-05T00:00:00.000Z',
    });

    expect(artifact.id).toMatch(/^PATCH-/);
    expect(artifact.touchedPaths).toEqual(['src/a.ts']);
    expect(artifact.integration.safeToApply).toBe(true);
  });

  it('detects dirty path conflicts before integration', () => {
    expect(detectDirtyPathConflicts(['src/a.ts', 'src/b.ts'], ['src/b.ts'])).toEqual(['src/b.ts']);
  });
});
