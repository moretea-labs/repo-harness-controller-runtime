import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RepoActor } from '../../src/runtime/control-plane/repo-actor/actor';
import { GlobalScheduler } from '../../src/runtime/control-plane/global-scheduler/scheduler';
import { assertAutomatedOperationAllowed } from '../../src/runtime/control-plane/governance/external-effects';
import { boundExecutionResult, readExecutionArtifact } from '../../src/runtime/evidence/artifact-store';
import {
  cancelExecutionJob,
  createExecutionJob,
  getExecutionJob,
  listExecutionJobs,
  updateExecutionJob,
} from '../../src/runtime/execution/jobs/store';
import { normalizeClaims } from '../../src/runtime/resources/claims/conflicts';
import { claimsForMcpOperation } from '../../src/runtime/gateway/mcp/resource-policy';
import {
  acquireExecutionLeases,
  assertFencingToken,
  listActiveLeases,
  releaseExecutionLeases,
} from '../../src/runtime/resources/leases/store';
import { evaluateSchedule } from '../../src/runtime/workflow/schedules/engine';
import { createSchedule, listActiveOccurrences, listOccurrences } from '../../src/runtime/workflow/schedules/store';
import { createPortfolioWorkflow } from '../../src/runtime/workflow/portfolio/store';
import { recordCandidateFinding } from '../../src/runtime/workflow/findings/store';
import { invalidateExecutionWorker } from '../../src/runtime/execution/workers/ownership';

const homes: string[] = [];
function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'repo-harness-runtime-test-'));
  homes.push(value);
  return value;
}
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe('target architecture runtime', () => {
  test('deduplicates durable commands by requestId and indexes recent jobs', () => {
    const controllerHome = home();
    const input = {
      repoId: 'repo-a',
      type: 'mcp-tool' as const,
      requestId: 'request-1',
      semanticKey: 'create:thing',
      origin: { surface: 'mcp' as const },
      payload: { operation: 'create_issue', target: 'mcp-tool' as const },
      resourceClaims: [{ resourceKey: 'repo-state', mode: 'write' as const }],
    };
    const first = createExecutionJob(controllerHome, input);
    const second = createExecutionJob(controllerHome, input);
    expect(second.deduplicated).toBe(true);
    expect(second.job.jobId).toBe(first.job.jobId);
    expect(listExecutionJobs(controllerHome, 'repo-a', 10).map((job) => job.jobId)).toContain(first.job.jobId);
    expect(() => createExecutionJob(controllerHome, { ...input, semanticKey: 'different' })).toThrow('REQUEST_ID_CONFLICT');
  });

  test('uses leases and fencing tokens for long-running ownership', () => {
    const controllerHome = home();
    const claims = normalizeClaims([], { readOnly: false });
    expect(claims).toEqual([{ resourceKey: 'repo-content:*', mode: 'write' }]);
    const first = acquireExecutionLeases(controllerHome, 'repo-a', 'job-a', claims, 30_000);
    expect(first.acquired).toBe(true);
    const blocked = acquireExecutionLeases(controllerHome, 'repo-a', 'job-b', [{ resourceKey: 'path:src', mode: 'write' }], 30_000);
    expect(blocked.acquired).toBe(false);
    const lease = first.leases[0];
    expect(assertFencingToken(controllerHome, 'repo-a', lease.leaseId, lease.fencingToken).ownerJobId).toBe('job-a');
    expect(() => assertFencingToken(controllerHome, 'repo-a', lease.leaseId, lease.fencingToken + 1)).toThrow('FENCING_TOKEN_STALE');
    releaseExecutionLeases(controllerHome, 'repo-a', 'job-a');
    expect(listActiveLeases(controllerHome, 'repo-a')).toHaveLength(0);
  });

  test('flags lease loss before a durable worker can keep running', () => {
    const controllerHome = home();
    const created = createExecutionJob(controllerHome, {
      repoId: 'repo-a',
      type: 'check',
      requestId: 'lease-loss',
      semanticKey: 'check:lease-loss',
      origin: { surface: 'mcp' },
      payload: { operation: 'run_check', target: 'mcp-tool' },
      resourceClaims: [{ resourceKey: 'heavy-check:repo-a', mode: 'exclusive' }],
    }).job;
    const acquired = acquireExecutionLeases(controllerHome, 'repo-a', created.jobId, created.resourceClaims, 30_000);
    const running = updateExecutionJob(controllerHome, 'repo-a', created.jobId, (job) => ({
      ...job,
      status: 'running',
      attempt: 1,
      workerPid: process.pid,
      leaseRefs: acquired.leases.map((lease) => ({
        leaseId: lease.leaseId,
        resourceKey: lease.resourceKey,
        fencingToken: lease.fencingToken,
        expiresAt: lease.expiresAt,
      })),
    }));
    expect(invalidateExecutionWorker(controllerHome, 'repo-a', created.jobId, {
      workerPid: process.pid,
      attempt: running.attempt,
      job: running,
    })).toBeUndefined();
    releaseExecutionLeases(controllerHome, 'repo-a', created.jobId, running.leaseRefs);
    const invalidation = invalidateExecutionWorker(controllerHome, 'repo-a', created.jobId, {
      workerPid: process.pid,
      attempt: running.attempt,
    });
    expect(invalidation?.code).toBe('LEASE_INVALID');
    expect(invalidation?.message).toContain('LEASE_EXPIRED');
  });

  test('auto-isolates a concurrent agent job into a worktree', () => {
    const controllerHome = home();
    for (const taskId of ['TASK-1', 'TASK-2']) {
      createExecutionJob(controllerHome, {
        repoId: 'repo-a',
        type: 'dispatch-task',
        requestId: `request-${taskId}`,
        semanticKey: `dispatch:${taskId}`,
        origin: { surface: 'mcp' },
        payload: { operation: 'dispatch_task', target: 'mcp-tool', arguments: { issue_id: 'ISSUE-1', task_id: taskId } },
        resourceClaims: [{ resourceKey: 'workspace:checkout-a', mode: 'write' }],
      });
    }
    const actor = new RepoActor(controllerHome, 'repo-a', { maxConcurrentWorkers: 2 });
    const first = actor.tryClaimNext();
    expect(first?.job.status).toBe('running');
    const second = actor.tryClaimNext();
    expect(second?.job.status).toBe('running');
    expect(second?.job.resourceClaims[0]?.resourceKey.startsWith('worktree:')).toBe(true);
    expect(second?.job.payload.arguments?.isolate).toBe(true);
  });

  test('cancels a durable job and releases its leases', () => {
    const controllerHome = home();
    const created = createExecutionJob(controllerHome, {
      repoId: 'repo-a',
      type: 'check',
      requestId: 'cancel-me',
      semanticKey: 'check:one',
      origin: { surface: 'mcp' },
      payload: { operation: 'run_check', target: 'mcp-tool' },
      resourceClaims: [{ resourceKey: 'heavy-check:repo-a', mode: 'exclusive' }],
    }).job;
    const acquired = acquireExecutionLeases(controllerHome, 'repo-a', created.jobId, created.resourceClaims, 30_000);
    updateExecutionJob(controllerHome, 'repo-a', created.jobId, (job) => ({
      ...job,
      leaseRefs: acquired.leases.map((lease) => ({ leaseId: lease.leaseId, resourceKey: lease.resourceKey, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt })),
    }));
    expect(cancelExecutionJob(controllerHome, 'repo-a', created.jobId).status).toBe('cancelled');
    expect(listActiveLeases(controllerHome, 'repo-a')).toHaveLength(0);
  });

  test('creates idempotent bounded Schedule occurrences in shadow mode', async () => {
    const controllerHome = home();
    const schedule = createSchedule(controllerHome, {
      requestId: 'schedule-request-1',
      repoId: 'repo-a',
      name: 'Read-only triage',
      enabled: true,
      trigger: { type: 'manual' },
      policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 0, dailyBudgetMinutes: 10, shadowMode: true },
      action: { operation: 'controller_context', resourceClaims: [{ resourceKey: 'repo-state', mode: 'read' }] },
      stopConditions: [],
    });
    const first = await evaluateSchedule(controllerHome, schedule, true);
    const second = await evaluateSchedule(controllerHome, schedule, true);
    expect(first?.status).toBe('shadowed');
    expect(second?.occurrenceId).toBe(first?.occurrenceId);
    expect(listOccurrences(controllerHome, 'repo-a')).toHaveLength(1);
    expect(listActiveOccurrences(controllerHome, 'repo-a')).toHaveLength(0);
  });

  test('prevents automated external side effects and requirement inflation', () => {
    expect(() => assertAutomatedOperationAllowed('publish_issue_to_github')).toThrow('EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED');
    expect(() => assertAutomatedOperationAllowed('repository_command_execute', { command: 'git push origin main' })).toThrow('EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED');
    expect(() => assertAutomatedOperationAllowed('create_issue', {})).toThrow('AUTOMATED_REQUIREMENT_REQUIRES_CANDIDATE');
    expect(() => assertAutomatedOperationAllowed('run_check', {})).not.toThrow();
  });

  test('deduplicates candidate findings and rejects cyclic Portfolio DAGs', () => {
    const controllerHome = home();
    const first = recordCandidateFinding(controllerHome, {
      repoId: 'repo-a', requestId: 'finding-1', semanticKey: 'same-defect', title: 'Same defect',
      evidence: { source: 'schedule', reference: 'OCC-1' },
    });
    const second = recordCandidateFinding(controllerHome, {
      repoId: 'repo-a', requestId: 'finding-2', semanticKey: 'same-defect', title: 'Same defect',
      evidence: { source: 'schedule', reference: 'OCC-2' },
    });
    expect(second.findingId).toBe(first.findingId);
    expect(second.observationCount).toBe(2);
    expect(() => createPortfolioWorkflow(controllerHome, {
      name: 'cycle', requestId: 'cycle', failurePolicy: 'stop',
      steps: [
        { stepId: 'a', repoId: 'repo-a', operation: 'controller_context', dependsOn: ['b'], priority: 'P2', resourceClaims: [], status: 'pending' },
        { stepId: 'b', repoId: 'repo-b', operation: 'controller_context', dependsOn: ['a'], priority: 'P2', resourceClaims: [], status: 'pending' },
      ],
    })).toThrow('PORTFOLIO_DEPENDENCY_CYCLE');
  });

  test('release freeze blocks writers while preserving read-only observation', () => {
    const controllerHome = home();
    const freeze = acquireExecutionLeases(controllerHome, 'repo-a', 'release-job', [{ resourceKey: 'release:repo-a', mode: 'exclusive' }], 30_000);
    expect(freeze.acquired).toBe(true);
    const reader = acquireExecutionLeases(controllerHome, 'repo-a', 'reader-job', [{ resourceKey: 'repo-state', mode: 'read' }], 30_000);
    expect(reader.acquired).toBe(true);
    const writer = acquireExecutionLeases(controllerHome, 'repo-a', 'writer-job', [{ resourceKey: 'repo-state', mode: 'write' }], 30_000);
    expect(writer.acquired).toBe(false);
  });

  test('read-only MCP operations remain schedulable while a writer holds a lease', () => {
    const controllerHome = home();
    const writer = acquireExecutionLeases(
      controllerHome,
      'repo-a',
      'writer-job',
      claimsForMcpOperation('repository_command_execute', { command: 'git add README.md' }, 'repo-a', 'checkout-a'),
      30_000,
    );
    expect(writer.acquired).toBe(true);
    const reader = acquireExecutionLeases(
      controllerHome,
      'repo-a',
      'reader-job',
      claimsForMcpOperation('controller_context', {}, 'repo-a', 'checkout-a'),
      30_000,
    );
    expect(reader.acquired).toBe(true);
    const secondWriter = acquireExecutionLeases(
      controllerHome,
      'repo-a',
      'writer-job-2',
      claimsForMcpOperation('repository_command_execute', { command: 'git add README.md' }, 'repo-a', 'checkout-a'),
      30_000,
    );
    expect(secondWriter.acquired).toBe(false);
  });

  test('keeps one durable recovery slot available under host pressure', async () => {
    const controllerHome = home();
    const created = createExecutionJob(controllerHome, {
      repoId: '__controller__',
      type: 'mcp-tool',
      requestId: 'controller-repository-list',
      semanticKey: 'repository-list',
      origin: { surface: 'mcp' },
      payload: { operation: 'repository_list', target: 'repository-tool' },
      resourceClaims: [],
      maxAttempts: 1,
    }).job;
    const scheduler = new GlobalScheduler(controllerHome, {
      minFreeMemoryMb: Number.MAX_SAFE_INTEGER,
      maxLoadPerCpu: Number.MAX_SAFE_INTEGER,
      pollIntervalMs: 25,
    });
    await scheduler.tick();
    let current = getExecutionJob(controllerHome, '__controller__', created.jobId);
    for (let attempt = 0; attempt < 80 && ['queued', 'running'].includes(current.status); attempt += 1) {
      await Bun.sleep(25);
      current = getExecutionJob(controllerHome, '__controller__', created.jobId);
    }
    expect(current.status).toBe('succeeded');
  });

  test('moves oversized job results into the Evidence Plane', () => {
    const controllerHome = home();
    const job = createExecutionJob(controllerHome, {
      repoId: 'repo-a',
      type: 'mcp-tool',
      requestId: 'large-output',
      semanticKey: 'large-output',
      origin: { surface: 'mcp' },
      payload: { operation: 'example', target: 'mcp-tool', maxOutputBytes: 16 * 1024 },
      resourceClaims: [],
    }).job;
    const bounded = boundExecutionResult(controllerHome, job, { text: 'x'.repeat(64 * 1024) });
    expect(bounded.result.truncated).toBe(true);
    const artifactId = String(bounded.result.artifactId);
    const artifact = readExecutionArtifact(controllerHome, 'repo-a', artifactId, 128 * 1024);
    expect(artifact.truncated).toBe(false);
    expect((artifact.content as { text: string }).text.length).toBe(64 * 1024);
    expect(getExecutionJob(controllerHome, 'repo-a', job.jobId).jobId).toBe(job.jobId);
  });
});
