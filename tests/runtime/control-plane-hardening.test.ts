import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerDaemon, readControllerDaemonStatus } from '../../src/runtime/control-plane/daemon-client';
import { reconcileControllerStartup } from '../../src/runtime/control-plane/startup-recovery';
import { CONTROLLER_SCOPE_REPO_ID } from '../../src/cli/repositories/controller-home';
import {
  createExecutionJob,
  getExecutionJob,
  resumeExecutionJobAfterApproval,
  updateExecutionJob,
} from '../../src/runtime/execution/jobs/store';
import { waitForExecutionJob } from '../../src/runtime/execution/jobs/wait';
import { TERMINAL_JOB_STATUSES } from '../../src/runtime/execution/jobs/types';
import { readExecutionEvidence, recordExecutionEvidence } from '../../src/runtime/evidence/evidence-store';

const roots: string[] = [];

function temp(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function createJob(controllerHome: string, repoId = 'repo-test') {
  return createExecutionJob(controllerHome, {
    repoId,
    checkoutId: 'checkout-test',
    type: 'mcp-tool',
    requestId: `request-${Date.now()}-${Math.random()}`,
    semanticKey: `test:${Date.now()}:${Math.random()}`,
    origin: { surface: 'system', actor: 'test' },
    payload: { operation: 'controller_ready', target: 'runtime', profile: 'controller', arguments: {} },
    resourceClaims: [],
  }).job;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('control-plane hardening', () => {
  test('keeps a live daemon PID authoritative when the scheduler heartbeat is stale', () => {
    const controllerHome = temp('repo-harness-daemon-fence-');
    mkdirSync(join(controllerHome, 'daemon'), { recursive: true });
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(controllerHome, 'daemon', 'controller.pid'), `${process.pid}\n`);
    writeFileSync(join(controllerHome, 'daemon', 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'ready',
      pid: process.pid,
      startedAt,
    }, null, 2)}\n`);

    const degraded = readControllerDaemonStatus(controllerHome);
    expect(degraded.status).toBe('ready');
    expect(degraded.degraded).toBe(true);
    expect(degraded.pid).toBe(process.pid);

    const ensured = ensureControllerDaemon(controllerHome);
    expect(ensured.pid).toBe(process.pid);
    expect(ensured.startedAt).toBe(startedAt);
  });

  test('ensureControllerDaemon skips startup cleanup when the daemon PID is live', () => {
    const controllerHome = temp('repo-harness-daemon-hotpath-');
    mkdirSync(join(controllerHome, 'daemon'), { recursive: true });
    const startedAt = new Date().toISOString();
    writeFileSync(join(controllerHome, 'daemon', 'controller.pid'), `${process.pid}\n`);
    writeFileSync(join(controllerHome, 'daemon', 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'ready',
      pid: process.pid,
      startedAt,
    }, null, 2)}\n`);
    // A live scheduler heartbeat keeps status ready without degraded noise.
    mkdirSync(join(controllerHome, 'scheduler'), { recursive: true });
    writeFileSync(join(controllerHome, 'scheduler', 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      loopStartedAt: new Date().toISOString(),
      lastTickAt: new Date().toISOString(),
      lastDispatchAt: new Date().toISOString(),
      lastReconcileAt: new Date().toISOString(),
      lastRepoDispatch: {},
    }, null, 2)}\n`);

    const first = ensureControllerDaemon(controllerHome);
    const second = ensureControllerDaemon(controllerHome);
    expect(first.pid).toBe(process.pid);
    expect(second.pid).toBe(process.pid);
    expect(second.startedAt).toBe(startedAt);
    // Fast path must not spawn a replacement daemon or rewrite state.
    expect(readControllerDaemonStatus(controllerHome).pid).toBe(process.pid);
  });

  test('returns immediately for waiting approval and resumes the same durable Job', async () => {
    const controllerHome = temp('repo-harness-approval-wait-');
    const created = createJob(controllerHome);
    updateExecutionJob(controllerHome, created.repoId, created.jobId, (job) => ({
      ...job,
      status: 'waiting_for_approval',
      result: {
        approvalRequestId: 'apr-test-1',
        authorization: {
          decision: 'user_confirmation_required',
          approvalRequestId: 'apr-test-1',
          humanSummary: 'Confirm test operation.',
        },
      },
    }));

    expect(TERMINAL_JOB_STATUSES.has('waiting_for_approval')).toBe(false);
    const waited = await waitForExecutionJob({
      controllerHome,
      repoId: created.repoId,
      jobId: created.jobId,
      timeoutMs: 2_000,
      pollIntervalMs: 50,
    });
    expect(waited.timedOut).toBe(false);
    expect(waited.job.status).toBe('waiting_for_approval');

    const resumed = resumeExecutionJobAfterApproval(controllerHome, created.repoId, 'apr-test-1');
    expect(resumed?.jobId).toBe(created.jobId);
    expect(resumed?.status).toBe('queued');
    expect(resumed?.payload.arguments?.approval_request_id).toBe('apr-test-1');
    expect(getExecutionJob(controllerHome, created.repoId, created.jobId).jobId).toBe(created.jobId);
  });

  test('reconciles controller-scoped Jobs without a Repository Registry entry', () => {
    const controllerHome = temp('repo-harness-controller-scope-recovery-');
    createJob(controllerHome, CONTROLLER_SCOPE_REPO_ID);
    const recovery = reconcileControllerStartup(controllerHome);
    const controller = recovery.repositories.find((entry) => entry.repoId === CONTROLLER_SCOPE_REPO_ID);
    expect(controller?.degraded).toBe(false);
    expect(controller?.executionIndexesRebuilt).toBe(true);
    expect(controller?.executionJobs).toBeDefined();
  });

  test('reads recorded EVD references through the evidence store', () => {
    const controllerHome = temp('repo-harness-evidence-read-');
    const repoRoot = temp('repo-harness-evidence-repo-');
    const job = createJob(controllerHome, 'repo-evidence');
    const recorded = recordExecutionEvidence(controllerHome, repoRoot, job, 'succeeded', { marker: 'readable' });
    expect(recorded.evidenceId.startsWith('EVD-')).toBe(true);
    const read = readExecutionEvidence(controllerHome, job.repoId, recorded.evidenceId);
    expect(read.evidenceId).toBe(recorded.evidenceId);
    expect(read.details?.marker).toBe('readable');
  });
});
