import type { LatencyBreakdown } from './types';
import { EMPTY_LATENCY } from './types';

export type LatencySegment = keyof Omit<LatencyBreakdown, 'path' | 'totalMs'>;

const SEGMENT_KEYS: LatencySegment[] = [
  'gatewayValidationMs',
  'authorizationMs',
  'resourceClaimMs',
  'jobPersistenceMs',
  'schedulerWaitMs',
  'workerStartupMs',
  'repositorySnapshotMs',
  'operationExecutionMs',
  'evidencePersistenceMs',
  'projectionUpdateMs',
  'responseSerializationMs',
];

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Bounded in-process latency accumulator.
 * Does not write files by itself; callers may attach the summary to a receipt
 * or return only totalMs by default.
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
    if (!includeDetail) {
      return { ...EMPTY_LATENCY, totalMs, path: this.path };
    }
    const breakdown: LatencyBreakdown = { ...EMPTY_LATENCY, totalMs, path: this.path };
    for (const key of SEGMENT_KEYS) {
      breakdown[key] = roundMs(this.segments[key] ?? 0);
    }
    return breakdown;
  }

  /** Compact form suitable for default API responses. */
  summaryMs(): { totalMs: number; path?: LatencyBreakdown['path'] } {
    this.stop();
    return {
      totalMs: roundMs(performance.now() - this.startedAt),
      path: this.path,
    };
  }
}

export function mergeLatency(...parts: LatencyBreakdown[]): LatencyBreakdown {
  const merged: LatencyBreakdown = { ...EMPTY_LATENCY };
  for (const part of parts) {
    for (const key of SEGMENT_KEYS) {
      merged[key] = roundMs(merged[key] + (part[key] ?? 0));
    }
    merged.totalMs = roundMs(merged.totalMs + (part.totalMs ?? 0));
    if (part.path) merged.path = part.path;
  }
  return merged;
}

/** Estimate repo-harness overhead vs underlying operation time. */
export function harnessOverheadMs(breakdown: LatencyBreakdown): number {
  return Math.max(0, roundMs(breakdown.totalMs - breakdown.operationExecutionMs));
}
