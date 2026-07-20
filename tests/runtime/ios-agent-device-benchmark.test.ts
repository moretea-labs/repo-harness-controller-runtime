import { describe, expect, it } from 'bun:test';
import { percentile, summarize } from '../../scripts/benchmark-ios-agent-device';

describe('iOS agent-device benchmark statistics', () => {
  it('interpolates percentiles deterministically without mutating input', () => {
    const values = [40, 10, 30, 20];
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 0.5)).toBe(25);
    expect(percentile(values, 0.95)).toBeCloseTo(38.5, 8);
    expect(percentile(values, 1)).toBe(40);
    expect(values).toEqual([40, 10, 30, 20]);
  });

  it('reports bounded p50 and p95 summaries and handles empty samples', () => {
    expect(summarize([])).toEqual({ count: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 });
    expect(summarize([100, 200, 300, 400])).toEqual({
      count: 4,
      min: 100,
      p50: 250,
      p95: 385,
      max: 400,
      mean: 250,
    });
  });
});
