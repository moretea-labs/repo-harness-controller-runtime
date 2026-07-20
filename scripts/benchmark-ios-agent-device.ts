#!/usr/bin/env bun
/**
 * Real iOS agent-device evidence-tier benchmark.
 *
 * This script performs actual provider actions against one explicitly selected
 * iOS target. It never invents baseline data and never runs without --device.
 * A warmup is followed by at least three measured runs. The provider remains
 * responsible for device/session serialization, timeouts, cleanup and redaction.
 *
 * Examples:
 *   bun scripts/benchmark-ios-agent-device.ts \
 *     --repo-id repo_... --device "iPhone 17 Pro" --query "AirPods" \
 *     --search-selector 'type="SearchField"' --submit-selector 'label="搜索"' \
 *     --result-text "AirPods" --runs 5 --json
 *
 *   # Exercise scoped/full fallback with an intentionally absent exact result:
 *   bun scripts/benchmark-ios-agent-device.ts ... \
 *     --result-text "__repo_harness_missing_result__" \
 *     --result-scope "商品列表" --snapshot-depth 8
 */
import { performance } from 'perf_hooks';
import { resolve } from 'path';
import { executeIosAgentDeviceAction } from '../src/runtime/plugins/ios-agent-device';

type EvidenceTier = 'exact_wait' | 'scoped_snapshot' | 'full_snapshot' | 'unknown';

export interface NumericSummary {
  count: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export interface IosBenchmarkSample {
  index: number;
  warmup: boolean;
  totalMs: number;
  tier: EvidenceTier;
  accessibilitySnapshotRequests: number;
  nativeBatchRequests: number;
  nativeBatchSteps: number;
  staleRefRecovery: boolean;
  exactWaitFallback: boolean;
  runnerRoundTrips?: number;
  providerWallClockMs?: number;
  phaseTimingsMs?: {
    targetSelection?: number;
    open?: number;
    targetDiscovery?: number;
    interactionAndEvidence?: number;
    screenshot?: number;
    close?: number;
    total?: number;
  };
}

export function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.min(1, percentileValue)) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const weight = rank - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function summarize(values: number[]): NumericSummary {
  if (values.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const rounded = (value: number) => Math.round(value * 100) / 100;
  return {
    count: values.length,
    min: rounded(Math.min(...values)),
    p50: rounded(percentile(values, 0.5)),
    p95: rounded(percentile(values, 0.95)),
    max: rounded(Math.max(...values)),
    mean: rounded(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function integerOption(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function stringRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function findCost(value: unknown): { wallClockMs?: number; runnerRoundTrips?: number } {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCost(item);
      if (found.wallClockMs !== undefined || found.runnerRoundTrips !== undefined) return found;
    }
    return {};
  }
  const record = stringRecord(value);
  if (!record) return {};
  const cost = stringRecord(record.cost);
  if (cost) {
    return {
      wallClockMs: typeof cost.wallClockMs === 'number' ? cost.wallClockMs : undefined,
      runnerRoundTrips: typeof cost.runnerRoundTrips === 'number' ? cost.runnerRoundTrips : undefined,
    };
  }
  for (const child of Object.values(record)) {
    const found = findCost(child);
    if (found.wallClockMs !== undefined || found.runnerRoundTrips !== undefined) return found;
  }
  return {};
}

function requiredOption(name: string): string {
  const value = option(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function usage(): string {
  return [
    'Usage: bun scripts/benchmark-ios-agent-device.ts --repo-id <id> --device <name> --query <text> [options]',
    '',
    'Required:',
    '  --repo-id <id>             Registered repository id used for Controller-owned evidence',
    '  --device <name>            Exact connected physical iPhone or booted Simulator name',
    '  --query <text>              Non-sensitive product-information query',
    '',
    'Evidence targeting:',
    '  --search-selector <value>   Stable selector; preferred over snapshot-scoped refs',
    '  --search-target <ref>       Cached accessibility ref fallback',
    '  --submit-selector <value>   Stable submit selector',
    '  --submit-target <ref>       Cached submit ref fallback',
    '  --result-text <text>        Exact text wait',
    '  --result-selector <value>   Exact selector wait',
    '  --result-scope <value>      Scoped snapshot fallback',
    '  --snapshot-depth <1..20>    Snapshot depth, default 8',
    '',
    'Execution:',
    '  --runs <3..20>              Measured runs after one warmup, default 3',
    '  --controller-home <path>    Defaults to REPO_HARNESS_CONTROLLER_HOME or _ops/controller-home',
    '  --repo-root <path>          Defaults to current working directory',
    '  --relaunch                  Relaunch the app for every run (cold-app measurement)',
    '  --json                      Emit machine-readable JSON',
  ].join('\n');
}

export async function runBenchmark(): Promise<Record<string, unknown>> {
  if (hasFlag('help')) {
    console.log(usage());
    return { help: true };
  }
  const repoId = requiredOption('repo-id');
  const device = requiredOption('device');
  const query = requiredOption('query');
  const runs = integerOption('runs', 3, 3, 20);
  const snapshotDepth = integerOption('snapshot-depth', 8, 1, 20);
  const repoRoot = resolve(option('repo-root') ?? process.cwd());
  const controllerHome = resolve(
    option('controller-home')
      ?? process.env.REPO_HARNESS_CONTROLLER_HOME
      ?? resolve(repoRoot, '_ops/controller-home'),
  );
  const args: Record<string, unknown> = {
    device,
    query,
    relaunch: hasFlag('relaunch'),
    snapshot_depth: snapshotDepth,
  };
  for (const [flag, key] of [
    ['search-selector', 'search_selector'],
    ['search-target', 'search_target'],
    ['submit-selector', 'submit_selector'],
    ['submit-target', 'submit_target'],
    ['result-text', 'result_text'],
    ['result-selector', 'result_selector'],
    ['result-scope', 'result_scope'],
  ] as const) {
    const value = option(flag)?.trim();
    if (value) args[key] = value;
  }

  const samples: IosBenchmarkSample[] = [];
  for (let index = 0; index <= runs; index += 1) {
    const warmup = index === 0;
    const startedAt = performance.now();
    const result = await executeIosAgentDeviceAction({
      controllerHome,
      repoId,
      repoRoot,
      pluginId: 'ios',
      actionId: 'agent_device_jd_search',
      requestId: `ios-evidence-benchmark-${Date.now()}-${index}`,
      args,
      origin: { surface: 'local-ui', actor: 'ios-evidence-benchmark' },
    });
    const totalMs = performance.now() - startedAt;
    const executionPlan = stringRecord(result.executionPlan) ?? {};
    const phaseTimingsMs = stringRecord(executionPlan.timingsMs) as IosBenchmarkSample['phaseTimingsMs'];
    const cost = findCost(result);
    samples.push({
      index,
      warmup,
      totalMs: Math.round(totalMs * 100) / 100,
      tier: typeof executionPlan.accessibilityEvidenceTier === 'string'
        ? executionPlan.accessibilityEvidenceTier as EvidenceTier
        : 'unknown',
      accessibilitySnapshotRequests: Number(executionPlan.accessibilitySnapshotRequests ?? 0),
      nativeBatchRequests: Number(executionPlan.nativeBatchRequests ?? 0),
      nativeBatchSteps: Number(executionPlan.nativeBatchSteps ?? 0),
      staleRefRecovery: executionPlan.staleRefRecovery === true,
      exactWaitFallback: executionPlan.exactWaitFallback === true,
      runnerRoundTrips: cost.runnerRoundTrips,
      providerWallClockMs: cost.wallClockMs,
      phaseTimingsMs,
    });
  }

  const measured = samples.filter((sample) => !sample.warmup);
  const phaseNames = [
    'targetSelection',
    'open',
    'targetDiscovery',
    'interactionAndEvidence',
    'screenshot',
    'close',
    'total',
  ] as const;
  const phaseTimingsMs = Object.fromEntries(phaseNames.map((phase) => [
    phase,
    summarize(measured.flatMap((sample) => {
      const value = sample.phaseTimingsMs?.[phase];
      return typeof value === 'number' ? [value] : [];
    })),
  ]));
  const byTier = Object.fromEntries(
    [...new Set(measured.map((sample) => sample.tier))].map((tier) => [
      tier,
      {
        totalMs: summarize(measured.filter((sample) => sample.tier === tier).map((sample) => sample.totalMs)),
        providerWallClockMs: summarize(measured
          .filter((sample) => sample.tier === tier && sample.providerWallClockMs !== undefined)
          .map((sample) => sample.providerWallClockMs!)),
        runnerRoundTrips: summarize(measured
          .filter((sample) => sample.tier === tier && sample.runnerRoundTrips !== undefined)
          .map((sample) => sample.runnerRoundTrips!)),
      },
    ]),
  );
  return {
    schemaVersion: 1,
    kind: 'ios_agent_device_evidence_tier_benchmark',
    generatedAt: new Date().toISOString(),
    environment: {
      repoId,
      device,
      repoRoot,
      relaunch: hasFlag('relaunch'),
      runCount: runs,
      warmupCount: 1,
      evidenceInputs: {
        hasSearchSelector: typeof args.search_selector === 'string',
        hasSearchTarget: typeof args.search_target === 'string',
        hasSubmitSelector: typeof args.submit_selector === 'string',
        hasSubmitTarget: typeof args.submit_target === 'string',
        hasResultText: typeof args.result_text === 'string',
        hasResultSelector: typeof args.result_selector === 'string',
        resultScope: args.result_scope ?? null,
        snapshotDepth,
      },
    },
    measured: {
      totalMs: summarize(measured.map((sample) => sample.totalMs)),
      accessibilitySnapshotRequests: summarize(measured.map((sample) => sample.accessibilitySnapshotRequests)),
      nativeBatchRequests: summarize(measured.map((sample) => sample.nativeBatchRequests)),
      nativeBatchSteps: summarize(measured.map((sample) => sample.nativeBatchSteps)),
      phaseTimingsMs,
      byTier,
    },
    samples,
    note: 'Results are from actual provider executions. No historical or unavailable device data is synthesized.',
  };
}

if (import.meta.main) {
  try {
    const report = await runBenchmark();
    if (!('help' in report)) {
      if (hasFlag('json')) console.log(JSON.stringify(report, null, 2));
      else {
        const measured = report.measured as Record<string, unknown>;
        console.log('iOS agent-device evidence-tier benchmark');
        console.log(JSON.stringify(measured, null, 2));
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('\n' + usage());
    process.exitCode = 1;
  }
}
