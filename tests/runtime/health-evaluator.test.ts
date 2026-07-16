import { describe, expect, test } from 'bun:test';
import { buildRuntimeOperationalView, evaluateRuntimeHealth } from '../../src/runtime/health';
import type { ExecutionJob } from '../../src/runtime/execution/jobs/types';
import type { HandoffItem } from '../../src/runtime/control-plane/facade/types';

function observations(overrides: Partial<Parameters<typeof evaluateRuntimeHealth>[0]> = {}) {
  return {
    daemon: { status: 'ready', heartbeatAgeMs: 1_000 },
    scheduler: { status: 'ready', heartbeatAgeMs: 1_000, dispatchHeartbeatAgeMs: 1_000 },
    workers: { queueDepth: 0, runningWorkers: 0, activeLeases: 0 },
    projection: { readable: true, persisted: true, producerHealthy: true },
    localBridge: {
      enabled: true,
      requiredForReadiness: true,
      mode: 'embedded' as const,
      endpoint: 'http://127.0.0.1:8766/',
      endpointReachable: true,
      expectedSurface: true,
      generationMatches: true,
      processAlive: true,
      runtimeStateFresh: true,
    },
    runtimeStorage: { readable: true, ready: true },
    ...overrides,
  };
}

describe('shared runtime health evaluator', () => {
  test('keeps readable idle projections healthy regardless of projection age', () => {
    const result = evaluateRuntimeHealth(observations({
      projection: {
        readable: true,
        persisted: true,
        producerHealthy: true,
        contentRevision: 4,
      },
    }));

    expect(result.state).toBe('healthy');
    expect(result.ready).toBe(true);
    expect(result.activeBlockers).toEqual([]);
  });

  test('warns during bounded projection refresh grace and degrades after it expires', () => {
    const pending = evaluateRuntimeHealth(observations({
      projection: {
        readable: true,
        persisted: true,
        producerHealthy: true,
        dirty: true,
        refreshPending: true,
        refreshGraceElapsed: false,
        activeInvariantAtRisk: true,
      },
    }));
    expect(pending.state).toBe('warning');
    expect(pending.ready).toBe(true);

    const missed = evaluateRuntimeHealth(observations({
      projection: {
        readable: true,
        persisted: true,
        producerHealthy: true,
        dirty: true,
        refreshPending: true,
        refreshGraceElapsed: true,
        activeInvariantAtRisk: true,
      },
    }));
    expect(missed.state).toBe('degraded');
    expect(missed.ready).toBe(false);
    expect(missed.activeBlockers.map((item) => item.code)).toContain('PROJECTION_REFRESH_MISSED');
  });

  test('treats projection build failure as a current blocker', () => {
    const result = evaluateRuntimeHealth(observations({
      projection: { readable: true, persisted: true, producerHealthy: true, lastBuildError: 'boom' },
    }));
    expect(result.ready).toBe(false);
    expect(result.activeBlockers.map((item) => item.code)).toContain('PROJECTION_BUILD_FAILED');
  });

  test('treats unresolved active execution attention as a current blocker', () => {
    const result = evaluateRuntimeHealth(observations({
      workers: { queueDepth: 0, runningWorkers: 1, activeLeases: 0, activeAttentionCount: 1 },
    }));
    expect(result.ready).toBe(false);
    expect(result.activeBlockers.map((item) => item.code)).toContain('ACTIVE_JOB_ATTENTION_REQUIRED');
  });

  test('uses a healthy Local Controller endpoint even when process evidence is stale', () => {
    const result = evaluateRuntimeHealth(observations({
      localBridge: {
        enabled: true,
        requiredForReadiness: true,
        mode: 'embedded',
        endpointReachable: true,
        expectedSurface: true,
        processAlive: false,
        runtimeStateFresh: false,
      },
    }));
    expect(result.ready).toBe(true);
    expect(result.components.localBridge.state).toBe('warning');
    expect(result.warnings.map((item) => item.code)).toContain('LOCAL_BRIDGE_PROCESS_EVIDENCE_STALE');
  });

  test('rejects wrong or missing endpoint surfaces and honors disabled mode', () => {
    const missing = evaluateRuntimeHealth(observations({
      localBridge: {
        enabled: true,
        requiredForReadiness: true,
        mode: 'standalone',
        endpointReachable: false,
        expectedSurface: false,
      },
    }));
    expect(missing.ready).toBe(false);
    expect(missing.components.localBridge.state).toBe('unavailable');

    const disabled = evaluateRuntimeHealth(observations({
      localBridge: {
        enabled: false,
        requiredForReadiness: true,
        mode: 'disabled',
        endpointReachable: false,
        expectedSurface: false,
      },
    }));
    expect(disabled.ready).toBe(true);
    expect(disabled.components.localBridge.state).toBe('disabled');
  });

  test('does not let an inactive blue/green slot satisfy readiness', () => {
    const result = evaluateRuntimeHealth(observations({
      localBridge: {
        enabled: true,
        requiredForReadiness: true,
        mode: 'standalone',
        endpointReachable: true,
        expectedSurface: true,
        activeSlot: false,
        generationMatches: true,
      },
    }));
    expect(result.ready).toBe(false);
    expect(result.activeBlockers.map((item) => item.code)).toContain('LOCAL_BRIDGE_INACTIVE_SLOT');
  });
});

function job(overrides: Partial<ExecutionJob>): ExecutionJob {
  return {
    schemaVersion: 1,
    revision: 1,
    jobId: 'job-1',
    repoId: 'repo-1',
    type: 'mcp-tool',
    status: 'failed',
    priority: 'P1',
    requestId: 'request-1',
    semanticKey: 'test',
    payload: { operation: 'test' },
    origin: { surface: 'system' },
    resourceClaims: [],
    dependencies: [],
    leaseRefs: [],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:01:00.000Z',
    queuedAt: '2026-07-16T00:00:00.000Z',
    finishedAt: '2026-07-16T00:01:00.000Z',
    attempt: 1,
    maxAttempts: 1,
    evidenceIds: [],
    error: { code: 'TEST_FAILURE', message: 'historical failure', retryable: false },
    ...overrides,
  };
}

function handoff(overrides: Partial<HandoffItem>): HandoffItem {
  return {
    schemaVersion: 1,
    id: 'handoff-1',
    repoId: 'repo-1',
    title: 'Review required',
    severity: 'needs_review',
    status: 'pending',
    reason: 'human decision',
    summary: 'A human decision is required.',
    currentState: { repoId: 'repo-1', statusSummary: 'waiting' },
    evidenceRefs: [],
    recommendedDecision: 'review',
    recommendedPrompt: 'Review the result.',
    suggestedNextActions: [],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:02:00.000Z',
    ...overrides,
  };
}

describe('runtime operational view', () => {
  test('keeps historical failures out of pending attention and preserves resolved handoffs in history', () => {
    const healthy = evaluateRuntimeHealth(observations());
    const view = buildRuntimeOperationalView({
      health: healthy,
      jobs: [job({}), job({ jobId: 'job-2', status: 'orphaned', finishedAt: undefined, error: undefined })],
      handoffs: [
        handoff({}),
        handoff({ id: 'handoff-2', status: 'resolved', decision: 'accepted', resolver: 'operator' }),
      ],
    });

    expect(view.health.activeBlockers).toEqual([]);
    expect(view.attention.pending.map((item) => item.attentionId)).toEqual(['handoff-1', 'job:job-2']);
    expect(view.history.recentIncidents.map((item) => item.incidentId)).toContain('job:job-1');
    expect(view.history.recentIncidents.map((item) => item.incidentId)).toContain('handoff:handoff-2');
  });
});
