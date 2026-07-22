import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  attachExecutionWorker,
  claimExecutionJobForDispatch,
  createExecutionJob,
  markExecutionJobSchedulerObserved,
} from '../../src/runtime/execution/jobs/store';
import { executionTimeoutDecision } from '../../src/runtime/execution/jobs/timeouts';
import type { ExecutionJob } from '../../src/runtime/execution/jobs/types';

const homes: string[] = [];

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'repo-harness-timeout-phases-'));
  homes.push(value);
  return value;
}

function createPhasedJob(controllerHome: string) {
  return createExecutionJob(controllerHome, {
    repoId: 'repo-timeout-test',
    checkoutId: 'checkout-timeout-test',
    type: 'agent-run',
    requestId: `timeout-phases-${Date.now()}-${Math.random()}`,
    semanticKey: `timeout-phases-${Date.now()}-${Math.random()}`,
    origin: { surface: 'mcp', actor: 'test' },
    payload: {
      operation: 'quick_agent_session',
      target: 'mcp-tool',
      arguments: { timeout_ms: 3_600_000 },
    },
    resourceClaims: [],
    timeoutPolicy: {
      admissionTimeoutMs: 300_000,
      queueTimeoutMs: 3_600_000,
      executionTimeoutMs: 600_000,
      interactiveWaitMs: 15_000,
    },
    maxAttempts: 1,
  }).job;
}

describe('ExecutionJob timeout phases', () => {
  test('queue time does not consume the Worker execution budget', () => {
    const controllerHome = home();
    const created = createPhasedJob(controllerHome);
    expect(Date.parse(created.admissionDeadlineAt!) - Date.parse(created.createdAt)).toBe(300_000);
    expect(created.deadlineAt).toBe(created.admissionDeadlineAt);

    const observed = markExecutionJobSchedulerObserved(controllerHome, created.repoId, created.jobId)!;
    const observedAt = Date.parse(observed.timings!.schedulerObservedAt!);
    expect(Date.parse(observed.queueDeadlineAt!) - observedAt).toBe(3_600_000);
    expect(observed.deadlineAt).toBe(observed.queueDeadlineAt);

    expect(executionTimeoutDecision(observed, observedAt + 120_001)).toBeUndefined();
    expect(executionTimeoutDecision(observed, observedAt + 3_600_001)).toMatchObject({
      phase: 'queue',
      code: 'QUEUE_TIMEOUT',
    });

    const dispatched = claimExecutionJobForDispatch(controllerHome, created.repoId, created.jobId, [])!;
    const running = attachExecutionWorker(controllerHome, created.repoId, created.jobId, process.pid)!;
    expect(dispatched.status).toBe('dispatched');
    expect(running.status).toBe('running');
    expect(Date.parse(running.executionDeadlineAt!) - Date.parse(running.startedAt!)).toBe(600_000);
    expect(running.deadlineAt).toBe(running.executionDeadlineAt);
  });

  test('legacy Jobs retain their original deadlineAt semantics', () => {
    const created = createPhasedJob(home());
    const legacy = {
      ...created,
      timeoutPolicy: undefined,
      admissionDeadlineAt: undefined,
      queueDeadlineAt: undefined,
      executionDeadlineAt: undefined,
      deadlineAt: new Date(Date.now() - 1).toISOString(),
    } as ExecutionJob;

    expect(executionTimeoutDecision(legacy)).toMatchObject({
      phase: 'legacy',
      code: 'DEADLINE_EXCEEDED',
    });
  });
});
