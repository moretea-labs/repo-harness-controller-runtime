import { execSync } from 'child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerRepository } from '../../src/cli/repositories/registry';
import { listHandoffItems } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import { createExecutionJob, getExecutionJob, updateExecutionJob } from '../../src/runtime/execution/jobs/store';
import { evaluateSchedule } from '../../src/runtime/workflow/schedules/engine';
import { settleScheduledExecution } from '../../src/runtime/workflow/schedules/settlement';
import { createSchedule, getSchedule, listOccurrences, saveOccurrence, saveSchedule } from '../../src/runtime/workflow/schedules/store';

const workspaces: string[] = [];

function maintenanceWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-live-maintenance-'));
  workspaces.push(root);
  execSync('git init', { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'README.md'), 'runtime maintenance test\n');
  const controllerHome = join(root, '_controller_home');
  const localJobs = join(root, '.ai/harness/local-jobs');
  mkdirSync(localJobs, { recursive: true });
  const repository = registerRepository({
    controllerHome,
    path: root,
    repoIdOverride: 'repo-live-maintenance',
    defaultBranch: 'main',
  });
  return { root, controllerHome, localJobs, repository };
}

function writeLocalJob(
  localJobs: string,
  jobId: string,
  patch: Record<string, unknown> = {},
): string {
  const jobRoot = join(localJobs, jobId);
  mkdirSync(jobRoot, { recursive: true });
  const body = {
    schemaVersion: 1,
    jobId,
    action: 'repository-command',
    status: 'running',
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    workerPid: 99999999,
    ...patch,
  };
  const path = join(jobRoot, 'job.json');
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

function createLiveMaintenanceSchedule(
  controllerHome: string,
  repoId: string,
  overrides: {
    requestId?: string;
    trigger?: { type: 'manual' } | { type: 'interval'; everyMinutes: number };
    actionId?: string;
    confirmMaintenance?: boolean;
    authorization?: string;
    cancelPendingApprovals?: boolean;
    cooldownMinutes?: number;
    dailyBudgetMinutes?: number;
    maxFailures?: number;
    backoffBaseMinutes?: number;
    backoffMaxMinutes?: number;
  } = {},
) {
  const actionId = overrides.actionId ?? 'local_jobs_reconcile';
  return createSchedule(controllerHome, {
    requestId: overrides.requestId ?? `maintenance-schedule:${actionId}:${Date.now()}`,
    repoId,
    name: 'Auto runtime maintenance',
    enabled: true,
    trigger: overrides.trigger ?? { type: 'manual' },
    policy: {
      maxActiveOccurrences: 1,
      maxFailures: overrides.maxFailures ?? 3,
      cooldownMinutes: overrides.cooldownMinutes ?? 0,
      dailyBudgetMinutes: overrides.dailyBudgetMinutes ?? 30,
      shadowMode: false,
      backoffBaseMinutes: overrides.backoffBaseMinutes ?? 5,
      backoffMaxMinutes: overrides.backoffMaxMinutes ?? 60,
    },
    action: {
      operation: 'runtime_maintenance_apply',
      arguments: {
        action_id: actionId,
        confirm_maintenance: overrides.confirmMaintenance ?? true,
        authorization: overrides.authorization ?? actionId,
        min_age_minutes: 0,
        cancel_pending_approvals: overrides.cancelPendingApprovals ?? false,
      },
      resourceClaims: [{ resourceKey: 'runtime-maintenance', mode: 'write' }],
    },
    stopConditions: [],
  });
}

afterEach(() => {
  while (workspaces.length) rmSync(workspaces.pop()!, { recursive: true, force: true });
});

describe('live maintenance schedules', () => {
  test('queues one bounded live maintenance occurrence for an allowlisted safe action', async () => {
    const { controllerHome, localJobs, repository } = maintenanceWorkspace();
    const jobPath = writeLocalJob(localJobs, 'JOB-stale');
    const before = readFileSync(jobPath, 'utf8');
    const schedule = createLiveMaintenanceSchedule(controllerHome, repository.repoId);

    const occurrence = await evaluateSchedule(controllerHome, schedule, true, { source: 'manual', eventId: 'dispatch-1' });

    expect(occurrence?.status).toBe('queued');
    expect(occurrence?.decision).toBe('execute');
    expect(occurrence?.jobId).toBeTruthy();
    expect(readFileSync(jobPath, 'utf8')).toBe(before);
    const job = getExecutionJob(controllerHome, repository.repoId, occurrence!.jobId!);
    expect(job.payload.operation).toBe('runtime_maintenance_apply');
    expect(job.payload.arguments).toMatchObject({
      action_id: 'local_jobs_reconcile',
      confirm_maintenance: true,
      authorization: 'local_jobs_reconcile',
    });
    expect(listHandoffItems({ controllerHome, repoId: repository.repoId, status: 'all' })).toHaveLength(0);
  });

  test('keeps preview side-effect free and creates one handoff when only unsafe maintenance candidates exist', async () => {
    const { controllerHome, localJobs, repository } = maintenanceWorkspace();
    const brokenRoot = join(localJobs, 'JOB-broken');
    mkdirSync(brokenRoot, { recursive: true });
    const jobPath = join(brokenRoot, 'job.json');
    writeFileSync(jobPath, '{not-json\n');
    const before = readFileSync(jobPath, 'utf8');
    const schedule = createLiveMaintenanceSchedule(controllerHome, repository.repoId);

    const occurrence = await evaluateSchedule(controllerHome, schedule, true, { source: 'manual', eventId: 'blocked-1' });

    expect(occurrence?.status).toBe('skipped');
    expect(occurrence?.decision).toBe('maintenance_not_ready');
    expect(occurrence?.handoffId).toBeTruthy();
    expect(readFileSync(jobPath, 'utf8')).toBe(before);
    const stored = getSchedule(controllerHome, repository.repoId, schedule.scheduleId);
    expect(stored.consecutiveFailures).toBe(1);
    expect(stored.nextEligibleAt).toBeTruthy();
    const handoffs = listHandoffItems({ controllerHome, repoId: repository.repoId, status: 'all' });
    expect(handoffs).toHaveLength(1);
    expect(occurrence?.handoffId).toBeTruthy();
    expect(handoffs[0]?.id).toBe(occurrence!.handoffId!);
  });

  test('pauses misconfigured automatic maintenance outside the allowlist', async () => {
    const { controllerHome, repository } = maintenanceWorkspace();
    const schedule = createLiveMaintenanceSchedule(controllerHome, repository.repoId, {
      actionId: 'full_maintenance_pass',
      authorization: 'full_maintenance_pass',
    });

    const occurrence = await evaluateSchedule(controllerHome, schedule, true, { source: 'manual', eventId: 'allowlist-1' });

    expect(occurrence?.status).toBe('skipped');
    expect(occurrence?.decision).toBe('operation_blocked');
    expect(occurrence?.handoffId).toBeTruthy();
    const stored = getSchedule(controllerHome, repository.repoId, schedule.scheduleId);
    expect(stored.enabled).toBe(false);
    expect(stored.pausedReason).toContain('allowlisted actions');
  });

  test('settlement applies exponential backoff, writes one handoff per failed occurrence, and pauses at the failure limit', async () => {
    const { controllerHome, localJobs, repository } = maintenanceWorkspace();
    writeLocalJob(localJobs, 'JOB-stale');
    const schedule = createLiveMaintenanceSchedule(controllerHome, repository.repoId, {
      maxFailures: 2,
      backoffBaseMinutes: 5,
      backoffMaxMinutes: 60,
    });

    const first = await evaluateSchedule(controllerHome, schedule, true, { source: 'manual', eventId: 'failure-1' });
    const firstJob = getExecutionJob(controllerHome, repository.repoId, first!.jobId!);
    settleScheduledExecution(controllerHome, firstJob, 'failed', 'Maintenance execution failed on first attempt.');
    const afterFirst = getSchedule(controllerHome, repository.repoId, schedule.scheduleId);
    const firstBackoffMs = Date.parse(afterFirst.nextEligibleAt ?? '') - Date.now();

    expect(afterFirst.consecutiveFailures).toBe(1);
    expect(firstBackoffMs).toBeGreaterThan(4 * 60_000);
    expect(listHandoffItems({ controllerHome, repoId: repository.repoId, status: 'all' })).toHaveLength(1);

    const second = await evaluateSchedule(controllerHome, afterFirst, true, { source: 'manual', eventId: 'failure-2' });
    const secondJob = getExecutionJob(controllerHome, repository.repoId, second!.jobId!);
    settleScheduledExecution(controllerHome, secondJob, 'failed', 'Maintenance execution failed on second attempt.');
    const afterSecond = getSchedule(controllerHome, repository.repoId, schedule.scheduleId);
    const secondBackoffMs = Date.parse(afterSecond.nextEligibleAt ?? '') - Date.now();

    expect(afterSecond.consecutiveFailures).toBe(2);
    expect(afterSecond.enabled).toBe(false);
    expect(afterSecond.pausedReason).toContain('Maximum consecutive failures reached');
    expect(secondBackoffMs).toBeGreaterThan(firstBackoffMs + 2 * 60_000);
    expect(listHandoffItems({ controllerHome, repoId: repository.repoId, status: 'all' })).toHaveLength(2);
    const occurrences = listOccurrences(controllerHome, repository.repoId, schedule.scheduleId, 10);
    expect(occurrences.filter((entry) => entry.status === 'failed')).toHaveLength(2);
    expect(occurrences.every((entry) => entry.handoffId)).toBe(true);
  });

  test('enforces daily runtime budget before dispatching another live occurrence', async () => {
    const { controllerHome, repository } = maintenanceWorkspace();
    const schedule = createLiveMaintenanceSchedule(controllerHome, repository.repoId, {
      trigger: { type: 'interval', everyMinutes: 60 },
      dailyBudgetMinutes: 1,
    });
    const timestamp = new Date().toISOString();
    const priorJob = createExecutionJob(controllerHome, {
      repoId: repository.repoId,
      type: 'scheduled-occurrence',
      requestId: 'budget-history',
      semanticKey: 'budget-history',
      origin: { surface: 'schedule', actor: schedule.scheduleId },
      payload: { operation: 'runtime_maintenance_apply', scheduleId: schedule.scheduleId, occurrenceId: 'OCC-budget-history', target: 'mcp-tool' },
    }).job;
    updateExecutionJob(controllerHome, repository.repoId, priorJob.jobId, (current) => ({
      ...current,
      status: 'succeeded',
      startedAt: new Date(Date.now() - (2 * 60_000)).toISOString(),
      finishedAt: timestamp,
    }));
    saveOccurrence(controllerHome, {
      schemaVersion: 1,
      revision: 0,
      occurrenceId: 'OCC-budget-history',
      scheduleId: schedule.scheduleId,
      repoId: repository.repoId,
      windowKey: 'budget-history',
      status: 'succeeded',
      decision: 'execute',
      createdAt: timestamp,
      updatedAt: timestamp,
      jobId: priorJob.jobId,
    });

    const occurrence = await evaluateSchedule(controllerHome, getSchedule(controllerHome, repository.repoId, schedule.scheduleId), false, { source: 'timer' });

    expect(occurrence?.status).toBe('skipped');
    expect(occurrence?.decision).toBe('budget_exhausted');
  });

  test('enforces cooldown before dispatching another live occurrence', async () => {
    const { controllerHome, localJobs, repository } = maintenanceWorkspace();
    writeLocalJob(localJobs, 'JOB-stale');
    const schedule = createLiveMaintenanceSchedule(controllerHome, repository.repoId, {
      trigger: { type: 'interval', everyMinutes: 60 },
      cooldownMinutes: 30,
    });
    const warmed = saveSchedule(controllerHome, {
      ...schedule,
      lastTriggeredAt: new Date().toISOString(),
      lastOccurrenceId: 'OCC-recent',
    });

    const occurrence = await evaluateSchedule(controllerHome, warmed, false, { source: 'timer' });

    expect(occurrence?.status).toBe('skipped');
    expect(occurrence?.decision).toBe('cooldown');
  });
});
