import { describe, expect, test } from 'bun:test';
import {
  buildAcceptedQueuedDigest,
  buildJobOperationDigest,
  buildSyncOperationDigest,
  classifyUserFacingError,
  phaseFromJobStatus,
} from '../../src/runtime/control-plane/facade/operation-digest';
import type { ExecutionJob } from '../../src/runtime/execution/jobs/types';

function job(overrides: Partial<ExecutionJob> = {}): ExecutionJob {
  return {
    schemaVersion: 1,
    revision: 1,
    jobId: 'job_1',
    repoId: 'repo_1',
    type: 'mcp-tool',
    status: 'queued',
    priority: 'P1',
    requestId: 'req_1',
    semanticKey: 'sem_1',
    payload: { operation: 'repository_safe_patch_apply' },
    origin: { surface: 'mcp' },
    resourceClaims: [],
    dependencies: [],
    leaseRefs: [],
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    queuedAt: '2026-07-09T00:00:00.000Z',
    attempt: 1,
    maxAttempts: 2,
    evidenceIds: [],
    ...overrides,
  };
}

describe('operation digest usability', () => {
  test('classifies empty errors as unknown_failure and never leaves blank labels', () => {
    expect(classifyUserFacingError({})).toBe('unknown_failure');
    expect(classifyUserFacingError({ message: 'invalid_check_id: docs' })).toBe('invalid_check_id');
    expect(classifyUserFacingError({ message: 'timed out waiting' })).toBe('timeout');
    expect(classifyUserFacingError({ infrastructure: true, message: 'worker crashed' })).toBe('infrastructure_failure');
    expect(classifyUserFacingError({ acceptance: true })).toBe('acceptance_failure');
  });

  test('queued accept digest suggests wait next action', () => {
    const digest = buildAcceptedQueuedDigest({
      jobId: 'job_1',
      operation: 'dispatch_task',
      deduplicated: false,
    });
    expect(digest.phase).toBe('queued');
    expect(digest.summary).toContain('已接受');
    expect(digest.suggestedNextActions.some((action) => action.label.includes('等待'))).toBe(true);
  });

  test('failed job without message still has readable errorMessage', () => {
    const digest = buildJobOperationDigest(job({
      status: 'failed',
      error: undefined,
    }));
    expect(digest.phase).toBe('failed');
    expect(digest.errorMessage).toBeTruthy();
    expect(digest.errorMessage?.length).toBeGreaterThan(5);
    expect(digest.errorClass).toBeTruthy();
  });

  test('succeeded job exposes changed files from result', () => {
    const digest = buildJobOperationDigest(job({
      status: 'succeeded',
      result: {
        appliedChunks: [{ paths: ['src/a.ts', 'src/b.ts'] }],
      },
    }));
    expect(digest.phase).toBe('succeeded');
    expect(digest.changedFiles).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('sync patch digest is terminal and bounded', () => {
    const digest = buildSyncOperationDigest({
      ok: true,
      operation: 'repository_safe_patch_apply',
      summary: '补丁已同步应用，涉及 2 个文件。',
      changedFiles: ['a.ts', 'b.ts'],
    });
    expect(digest.terminal).toBe(true);
    expect(digest.phase).toBe('succeeded');
    expect(digest.rawAvailable).toBe(false);
  });

  test('phase mapping covers attention and timeout', () => {
    expect(phaseFromJobStatus('human_attention_required')).toBe('needs_attention');
    expect(phaseFromJobStatus('timed_out')).toBe('timed_out');
    expect(phaseFromJobStatus('waiting_for_heavy_check')).toBe('waiting');
  });
});
