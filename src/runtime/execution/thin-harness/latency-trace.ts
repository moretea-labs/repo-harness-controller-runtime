import type { LatencyBreakdown } from './types';
import { EMPTY_LATENCY } from './types';

export type LatencySegment = 'routingMs' | 'policyMs' | 'snapshotMs' | 'executionMs' | 'receiptMs';

const SEGMENT_KEYS: LatencySegment[] = [
  'routingMs',
  'policyMs',
  'snapshotMs',
  'executionMs',
  'receiptMs',
];

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Bounded in-process latency accumulator with mutually exclusive segments.
 */
export class LatencyTrace {
  private readonly startedAt = performance.now();
  private readonly segments: Partial<Record<LatencySegment, number>> = {};
  private active: { segment: LatencySegment; start: number } | undefined;
  path: LatencyBreakdown['path'];

  constructor(path?: LatencyBreakdown['path']) {
    this.path = path;
  }

  start(segment: LatencySegment): void {
    if (this.active) this.stop();
    this.active = { segment, start: performance.now() };
  }

  stop(): void {
    if (!this.active) return;
    const elapsed = performance.now() - this.active.start;
    this.segments[this.active.segment] = (this.segments[this.active.segment] ?? 0) + elapsed;
    this.active = undefined;
  }

  add(segment: LatencySegment, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.segments[segment] = (this.segments[segment] ?? 0) + ms;
  }

  async measure<T>(segment: LatencySegment, operation: () => Promise<T>): Promise<T> {
    this.start(segment);
    try {
      return await operation();
    } finally {
      this.stop();
    }
  }

  measureSync<T>(segment: LatencySegment, operation: () => T): T {
    this.start(segment);
    try {
      return operation();
    } finally {
      this.stop();
    }
  }

  snapshot(includeDetail = true): LatencyBreakdown {
    this.stop();
    const totalMs = roundMs(performance.now() - this.startedAt);
    const routingMs = roundMs(this.segments.routingMs ?? 0);
    const policyMs = roundMs(this.segments.policyMs ?? 0);
    const snapshotMs = roundMs(this.segments.snapshotMs ?? 0);
    const executionMs = roundMs(this.segments.executionMs ?? 0);
    const receiptMs = roundMs(this.segments.receiptMs ?? 0);
    if (!includeDetail) {
      return { ...EMPTY_LATENCY, totalMs, path: this.path };
    }
    return {
      ...EMPTY_LATENCY,
      routingMs,
      policyMs,
      snapshotMs,
      executionMs,
      receiptMs,
      totalMs,
      path: this.path,
      // Compatibility aliases (non-overlapping mapping).
      gatewayValidationMs: routingMs,
      authorizationMs: policyMs,
      repositorySnapshotMs: snapshotMs,
      operationExecutionMs: executionMs,
      evidencePersistenceMs: receiptMs,
    };
  }

  summaryMs(): { totalMs: number; path?: LatencyBreakdown['path'] } {
    this.stop();
    return {
      totalMs: roundMs(performance.now() - this.startedAt),
      path: this.path,
    };
  }
}

export function harnessOverheadMs(breakdown: LatencyBreakdown): number {
  const op = breakdown.executionMs || breakdown.operationExecutionMs || 0;
  return Math.max(0, roundMs(breakdown.totalMs - op));
}
