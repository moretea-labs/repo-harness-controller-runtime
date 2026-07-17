import { describe, expect, test } from 'bun:test';
import { invalidateExecutionWorker } from '../../src/runtime/execution/workers/ownership';
import type { ExecutionJob } from '../../src/runtime/execution/jobs/types';

function runningJob(workerPid: number): ExecutionJob {
  return {
    status: 'running',
    workerPid,
    attempt: 1,
    leaseRefs: [],
  } as ExecutionJob;
}

describe('Execution Worker ownership', () => {
  test('accepts PID 1 as the parent of an intentionally detached worker', () => {
    const invalidation = invalidateExecutionWorker('/tmp/unused-controller-home', 'repo', 'job', {
      workerPid: 4242,
      attempt: 1,
      controllerPid: process.pid,
      currentParentPid: 1,
      job: runningJob(4242),
    });

    expect(invalidation).toBeUndefined();
  });

  test('still rejects an unexpected live parent identity', () => {
    const invalidation = invalidateExecutionWorker('/tmp/unused-controller-home', 'repo', 'job', {
      workerPid: 4242,
      attempt: 1,
      controllerPid: process.pid,
      currentParentPid: process.pid + 1000,
      job: runningJob(4242),
    });

    expect(invalidation?.code).toBe('PARENT_DISCONNECTED');
  });
});
