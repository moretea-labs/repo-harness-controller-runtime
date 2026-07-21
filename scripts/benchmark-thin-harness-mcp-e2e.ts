#!/usr/bin/env bun
/**
 * Thin Harness — real MCP Gateway dispatch path benchmark.
 *
 * Measures the same order as createRepoHarnessMcpServerFromContext:
 *   routeDurableMcpCall → (if undefined) callRepositoryTool
 *
 * Phase breakdown:
 *   dispatchMs, selectionMs, classificationMs, thinRoutingMs,
 *   queueDelayMs, workerStartupMs, localJobStartupMs,
 *   operationMs, receiptMs, serializationMs, totalMs
 *
 * Fast cases must keep ExecutionJob / LocalJob / Worker / scheduler wake at 0.
 *
 * Usage:
 *   bun scripts/benchmark-thin-harness-mcp-e2e.ts
 *   bun scripts/benchmark-thin-harness-mcp-e2e.ts --json
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ensureControllerHome, repositoryControllerRoot } from '../src/cli/repositories/controller-home';
import { registerRepository } from '../src/cli/repositories/registry';
import { createMcpToolContext } from '../src/cli/mcp/server';
import { callRepositoryTool } from '../src/cli/mcp/repository-tools';
import {
  classifyGatewayExecutionPath,
  routeDurableMcpCall,
} from '../src/runtime/gateway/mcp/router';
import { listExecutionJobs } from '../src/runtime/execution/jobs/store';
import { listLocalBridgeJobSnapshots } from '../src/cli/local-bridge/job-store';
import { listFastReceipts } from '../src/runtime/execution/thin-harness/fast-receipt';
import {
  getLeaseSideEffectMetrics,
  resetLeaseSideEffectMetrics,
} from '../src/runtime/resources/leases/store';
import type { MultiRepositoryMcpToolContext } from '../src/cli/mcp/multi-repository';

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'thin-mcp-e2e-bench-'));
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  mkdirSync(controllerHome, { recursive: true });
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Bench']);
  git(repoRoot, ['config', 'user.email', 'bench@example.com']);
  writeFileSync(join(repoRoot, 'README.md'), 'mcp e2e benchmark fixture\n');
  writeFileSync(join(repoRoot, 'src', 'lib.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
  writeFileSync(join(repoRoot, 'src', 'util.ts'), 'export function id<T>(value: T): T { return value; }\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'init']);
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'mcp-e2e' });
  const ctx = createMcpToolContext({
    controllerHome,
    profile: 'controller',
    repo: repoRoot,
  }) as MultiRepositoryMcpToolContext;
  return { root, controllerHome, repoRoot, repository, ctx };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, index)]!;
}

function countLeaseFiles(controllerHome: string, repoId: string): number {
  try {
    const active = join(repositoryControllerRoot(controllerHome, repoId), 'leases', 'active');
    if (!existsSync(active)) return 0;
    return readdirSync(active).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

interface PhaseSample {
  dispatchMs: number;
  selectionMs: number;
  classificationMs: number;
  thinRoutingMs: number;
  queueDelayMs: number;
  workerStartupMs: number;
  localJobStartupMs: number;
  operationMs: number;
  receiptMs: number;
  serializationMs: number;
  totalMs: number;
  path: 'direct' | 'fast' | 'durable' | 'reject';
  ok: boolean;
  executionJobDelta: number;
  localJobDelta: number;
  workerSpawnCount: number;
  schedulerWakeDelta: number;
  projectionInvalidationDelta: number;
  runtimeEventDelta: number;
  receiptCount: number;
}

async function dispatchMcpLike(
  fixture: ReturnType<typeof createFixture>,
  name: string,
  args: Record<string, unknown>,
): Promise<{
  phases: Omit<PhaseSample, 'executionJobDelta' | 'localJobDelta' | 'workerSpawnCount' | 'schedulerWakeDelta' | 'projectionInvalidationDelta' | 'runtimeEventDelta' | 'receiptCount'>;
  payload: Record<string, unknown>;
}> {
  const wallStart = performance.now();
  const dispatchStart = performance.now();

  const selectionStart = performance.now();
  // Selection is embedded in handlers; measure classification + routing explicitly.
  const selectionMs = Math.round((performance.now() - selectionStart) * 100) / 100;

  const classificationStart = performance.now();
  const classification = classifyGatewayExecutionPath(name, {
    ...args,
    repo_id: fixture.repository.repoId,
  });
  const classificationMs = Math.round((performance.now() - classificationStart) * 100) / 100;

  const thinStart = performance.now();
  const durableResult = await routeDurableMcpCall(fixture.ctx, name, {
    ...args,
    repo_id: fixture.repository.repoId,
  });
  const thinRoutingMs = Math.round((performance.now() - thinStart) * 100) / 100;

  let queueDelayMs = 0;
  let workerStartupMs = 0;
  let localJobStartupMs = 0;
  let operationMs = 0;
  let receiptMs = 0;
  let payload: Record<string, unknown> = {};
  let path: PhaseSample['path'] = classification.path;
  let ok = true;

  if (durableResult) {
    // Durable accepted path (queued). Measure only accept latency; do not wait for workers.
    payload = (durableResult.structuredContent ?? {}) as Record<string, unknown>;
    const reported = String(payload.path ?? payload.mode ?? 'durable');
    path = reported === 'fast' || reported === 'direct' || reported === 'reject' || reported === 'durable'
      ? reported
      : 'durable';
    queueDelayMs = thinRoutingMs;
    workerStartupMs = 0;
    localJobStartupMs = typeof payload.jobId === 'string' ? thinRoutingMs : 0;
    operationMs = 0;
    ok = durableResult.isError !== true && payload.accepted !== false;
  } else {
    const opStart = performance.now();
    const toolResult = await callRepositoryTool(fixture.controllerHome, name, {
      ...args,
      repo_id: fixture.repository.repoId,
      include_latency_breakdown: true,
    });
    operationMs = Math.round((performance.now() - opStart) * 100) / 100;
    payload = (toolResult?.structuredContent ?? {}) as Record<string, unknown>;
    const reported = String(payload.path ?? payload.mode ?? classification.path);
    path = reported === 'fast' || reported === 'direct' || reported === 'reject' || reported === 'durable'
      || reported === 'durable_worker_inline'
      ? (reported === 'durable_worker_inline' ? 'durable' : reported as PhaseSample['path'])
      : classification.path;
    ok = toolResult?.isError !== true && payload.ok !== false && payload.accepted !== false;
    const latency = payload.latency as { receiptMs?: number; executionMs?: number; totalMs?: number } | undefined;
    receiptMs = latency?.receiptMs ?? 0;
    if (typeof latency?.executionMs === 'number' && latency.executionMs > 0) {
      operationMs = Math.max(operationMs, latency.executionMs);
    }
  }

  const serializationStart = performance.now();
  JSON.stringify(payload);
  const serializationMs = Math.round((performance.now() - serializationStart) * 100) / 100;
  const totalMs = Math.round((performance.now() - wallStart) * 100) / 100;
  const dispatchMs = Math.round((performance.now() - dispatchStart) * 100) / 100;

  return {
    phases: {
      dispatchMs,
      selectionMs,
      classificationMs,
      thinRoutingMs,
      queueDelayMs,
      workerStartupMs,
      localJobStartupMs,
      operationMs,
      receiptMs,
      serializationMs,
      totalMs,
      path,
      ok,
    },
    payload,
  };
}

async function sampleCase(
  fixture: ReturnType<typeof createFixture>,
  name: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<PhaseSample> {
  resetLeaseSideEffectMetrics();
  const sideBefore = getLeaseSideEffectMetrics();
  const jobsBefore = listExecutionJobs(fixture.controllerHome, fixture.repository.repoId).length;
  const localBefore = listLocalBridgeJobSnapshots(fixture.repoRoot).length;
  const receiptsBefore = listFastReceipts(fixture.controllerHome, fixture.repository.repoId, 200).length;

  const { phases, payload } = await dispatchMcpLike(fixture, tool, args);
  const sideAfter = getLeaseSideEffectMetrics();
  const side = (payload.durableSideEffects ?? {}) as {
    executionJobCount?: number;
    localJobCount?: number;
    workerSpawnCount?: number;
    projectionUpdateCount?: number;
    schedulerWakeCount?: number;
    runtimeEventCount?: number;
  };

  const acceptedJob = typeof payload.jobId === 'string' && payload.jobId.trim() ? 1 : 0;
  return {
    ...phases,
    executionJobDelta: Math.max(
      0,
      acceptedJob,
      (side.executionJobCount ?? 0)
        + (listExecutionJobs(fixture.controllerHome, fixture.repository.repoId).length - jobsBefore),
    ),
    localJobDelta: Math.max(
      0,
      (side.localJobCount ?? 0)
        + (listLocalBridgeJobSnapshots(fixture.repoRoot).length - localBefore),
    ),
    workerSpawnCount: side.workerSpawnCount ?? 0,
    schedulerWakeDelta: Math.max(0, (side.schedulerWakeCount ?? 0) + sideAfter.schedulerWakes - sideBefore.schedulerWakes),
    projectionInvalidationDelta: Math.max(
      0,
      (side.projectionUpdateCount ?? 0) + sideAfter.projectionDirtyMarks - sideBefore.projectionDirtyMarks,
    ),
    runtimeEventDelta: Math.max(
      0,
      (side.runtimeEventCount ?? 0)
        + (sideAfter.durableAcquireEvents + sideAfter.durableReleaseEvents)
        - (sideBefore.durableAcquireEvents + sideBefore.durableReleaseEvents),
    ),
    receiptCount: Math.max(
      0,
      listFastReceipts(fixture.controllerHome, fixture.repository.repoId, 200).length - receiptsBefore,
    ),
  };
}

function summarize(samples: PhaseSample[]) {
  const pick = (key: keyof PhaseSample) => {
    if (key === 'ok' || key === 'path') return undefined;
    return {
      p50: median(samples.map((s) => Number(s[key]))),
      p95: p95(samples.map((s) => Number(s[key]))),
    };
  };
  return {
    path: samples[0]?.path,
    ok: samples.every((s) => s.ok),
    totalMs: pick('totalMs'),
    classificationMs: pick('classificationMs'),
    thinRoutingMs: pick('thinRoutingMs'),
    operationMs: pick('operationMs'),
    receiptMs: pick('receiptMs'),
    serializationMs: pick('serializationMs'),
    queueDelayMs: pick('queueDelayMs'),
    executionJobDelta: median(samples.map((s) => s.executionJobDelta)),
    localJobDelta: median(samples.map((s) => s.localJobDelta)),
    workerSpawnCount: median(samples.map((s) => s.workerSpawnCount)),
    schedulerWakeDelta: median(samples.map((s) => s.schedulerWakeDelta)),
    projectionInvalidationDelta: median(samples.map((s) => s.projectionInvalidationDelta)),
    runtimeEventDelta: median(samples.map((s) => s.runtimeEventDelta)),
    receiptCount: median(samples.map((s) => s.receiptCount)),
    cold: samples[0],
    warm: samples.slice(1),
  };
}

async function runCase(
  fixture: ReturnType<typeof createFixture>,
  name: string,
  tool: string,
  argsFactory: () => Record<string, unknown>,
) {
  // 1 cold + 3 warm
  const samples: PhaseSample[] = [];
  for (let i = 0; i < 4; i += 1) {
    samples.push(await sampleCase(fixture, name, tool, argsFactory()));
  }
  return { name, ...summarize(samples), samples };
}

async function main() {
  const asJson = process.argv.includes('--json');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).stdout?.trim() ?? 'unknown';
  const fixture = createFixture();

  try {
    const cases = [];

    cases.push(await runCase(fixture, 'file_read_facade', 'repository_workbench', () => ({
      operation: 'batch_execute',
      payload: {
        steps: [{ kind: 'read_file', input: { path: 'README.md' } }],
      },
    })));

    cases.push(await runCase(fixture, 'rg_search_command', 'repository_command_execute', () => ({
      command: ['rg', 'export', 'src'],
      timeout_ms: 8_000,
    })));

    cases.push(await runCase(fixture, 'git_status_command', 'repository_command_execute', () => ({
      command: ['git', 'status', '--short'],
      timeout_ms: 8_000,
    })));

    cases.push(await runCase(fixture, 'git_diff_command', 'repository_command_execute', () => ({
      command: ['git', 'diff', '--stat'],
      timeout_ms: 8_000,
    })));

    cases.push(await runCase(fixture, 'git_log_command', 'repository_command_execute', () => ({
      command: ['git', 'log', '-n', '3', '--oneline'],
      timeout_ms: 8_000,
    })));

    cases.push(await runCase(fixture, 'focused_readonly_command', 'repository_command_execute', () => ({
      command: ['git', 'rev-parse', 'HEAD'],
      timeout_ms: 8_000,
    })));

    cases.push(await runCase(fixture, 'bounded_patch_batch', 'repository_workbench', () => {
      writeFileSync(join(fixture.repoRoot, 'src', 'lib.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
      return {
        operation: 'batch_execute',
        payload: {
          request_id: `mcp-e2e-patch-${Date.now()}-${Math.random()}`,
          allowed_paths: ['src/**'],
          steps: [
            { kind: 'read_file', input: { path: 'src/lib.ts' } },
            {
              kind: 'apply_patch',
              input: {
                operations: [{
                  type: 'replace',
                  path: 'src/lib.ts',
                  old_text: 'return a + b;',
                  new_text: 'return a + b; // e2e',
                }],
                allowed_paths: ['src/**'],
                purpose: 'mcp-e2e-patch',
              },
            },
            { kind: 'git_diff', input: {} },
          ],
        },
      };
    }));

    cases.push(await runCase(fixture, 'multi_step_read_batch', 'repository_workbench', () => ({
      operation: 'batch_execute',
      payload: {
        steps: [
          { kind: 'git_status', input: {} },
          { kind: 'search', input: { query: 'add' } },
          { kind: 'read_file', input: { path: 'README.md' } },
          { kind: 'read_file', input: { path: 'src/util.ts' } },
          { kind: 'git_diff', input: {} },
        ],
      },
    })));

    cases.push(await runCase(fixture, 'async_command_durable', 'repository_command_execute', () => ({
      command: ['git', 'status', '--short'],
      apply_mode: 'async',
      timeout_ms: 8_000,
    })));

    cases.push(await runCase(fixture, 'full_test_durable', 'repository_command_execute', () => ({
      command: ['bun', 'test'],
      timeout_ms: 120_000,
    })));

    const fastCases = cases.filter((entry) => !['async_command_durable', 'full_test_durable'].includes(entry.name));
    const durableCases = cases.filter((entry) => ['async_command_durable', 'full_test_durable'].includes(entry.name));

    const report = {
      schemaVersion: 1,
      kind: 'mcp_gateway_thin_harness_e2e_benchmark',
      featureRevision: head,
      at: new Date().toISOString(),
      note: 'Measures real Gateway classification before ExecutionJob creation, then repository facade execution. Cold = first sample; warm = next three. No synthetic historical A/B ratios.',
      cases,
      acceptance: {
        fastZeroExecutionJobs: fastCases.every((entry) => entry.executionJobDelta === 0),
        fastZeroLocalJobs: fastCases.every((entry) => entry.localJobDelta === 0),
        fastZeroWorkers: fastCases.every((entry) => entry.workerSpawnCount === 0),
        fastZeroSchedulerWakes: fastCases.every((entry) => entry.schedulerWakeDelta === 0),
        fastZeroProjectionInvalidations: fastCases.every((entry) => entry.projectionInvalidationDelta === 0),
        durableStillRoutesDurable: durableCases.every((entry) => entry.path === 'durable' || String(entry.samples?.[0]?.path) === 'durable'),
        allOk: cases.every((entry) => entry.ok),
      },
      leaseFiles: countLeaseFiles(fixture.controllerHome, fixture.repository.repoId),
    };

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Thin Harness MCP Gateway e2e benchmark`);
      console.log(`feature=${head}\n`);
      console.log(
        'case'.padEnd(26),
        'path'.padEnd(10),
        'p50'.padStart(8),
        'p95'.padStart(8),
        'class'.padStart(8),
        'route'.padStart(8),
        'op'.padStart(8),
        'jobs'.padStart(5),
        'loc'.padStart(5),
        'sch'.padStart(5),
        'ok'.padStart(4),
      );
      for (const entry of cases) {
        console.log(
          entry.name.padEnd(26),
          String(entry.path ?? '?').padEnd(10),
          (entry.totalMs?.p50 ?? 0).toFixed(1).padStart(8),
          (entry.totalMs?.p95 ?? 0).toFixed(1).padStart(8),
          (entry.classificationMs?.p50 ?? 0).toFixed(1).padStart(8),
          (entry.thinRoutingMs?.p50 ?? 0).toFixed(1).padStart(8),
          (entry.operationMs?.p50 ?? 0).toFixed(1).padStart(8),
          String(entry.executionJobDelta).padStart(5),
          String(entry.localJobDelta).padStart(5),
          String(entry.schedulerWakeDelta).padStart(5),
          String(entry.ok).padStart(4),
        );
      }
      console.log('\nAcceptance:', report.acceptance);
    }

    const failed = !report.acceptance.allOk
      || !report.acceptance.fastZeroExecutionJobs
      || !report.acceptance.fastZeroWorkers
      || !report.acceptance.durableStillRoutesDurable;
    process.exitCode = failed ? 1 : 0;
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
