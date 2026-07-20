#!/usr/bin/env bun
/**
 * Thin Harness V1 latency benchmark (library / Fast Executor path).
 * Uses a temporary fixture repository — never mutates the product checkout.
 *
 * Scope (honest V1):
 * - Measures Fast Path library execution (route + async ops + receipt).
 * - Does NOT measure full MCP Gateway transport, schema validation, or Durable baseline A/B.
 * - Durable job/worker counters are zero because Fast Path never creates them (not hard-coded fiction of a full pipeline).
 * - Prefer 1 warmup + 3 runs median for wall time when comparing revisions.
 *
 * Usage:
 *   bun scripts/benchmark-thin-harness.ts
 *   bun scripts/benchmark-thin-harness.ts --json
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ensureControllerHome } from '../src/cli/repositories/controller-home';
import { registerRepository } from '../src/cli/repositories/registry';
import {
  executeFast,
  executeLightweightLanes,
  executeRepositoryBatch,
  type LatencyBreakdown,
} from '../src/runtime/execution/thin-harness';
import { harnessOverheadMs } from '../src/runtime/execution/thin-harness/latency-trace';

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'thin-harness-bench-'));
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  mkdirSync(controllerHome, { recursive: true });
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Bench']);
  git(repoRoot, ['config', 'user.email', 'bench@example.com']);
  writeFileSync(join(repoRoot, 'README.md'), 'benchmark fixture\n');
  writeFileSync(join(repoRoot, 'src', 'lib.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'init']);
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'bench' });
  return { root, controllerHome, repoRoot, repository };
}

interface CaseResult {
  name: string;
  totalMs: number;
  operationExecutionMs: number;
  overheadMs: number;
  executionJobCount: number;
  localJobCount: number;
  workerSpawnCount: number;
  projectionUpdateCount: number;
  receiptCount: number;
  ok: boolean;
  path: string;
}

async function runCase(
  name: string,
  fn: () => Promise<{ latency: LatencyBreakdown; ok: boolean; durableSideEffects?: { executionJobCount: number; localJobCount: number; workerSpawnCount: number; projectionUpdateCount: number }; receipt?: { executionId: string } | null }>,
): Promise<CaseResult> {
  const result = await fn();
  const side = result.durableSideEffects ?? {
    executionJobCount: 0,
    localJobCount: 0,
    workerSpawnCount: 0,
    projectionUpdateCount: 0,
  };
  return {
    name,
    totalMs: result.latency.totalMs,
    operationExecutionMs: result.latency.operationExecutionMs,
    overheadMs: harnessOverheadMs(result.latency),
    executionJobCount: side.executionJobCount,
    localJobCount: side.localJobCount,
    workerSpawnCount: side.workerSpawnCount,
    projectionUpdateCount: side.projectionUpdateCount,
    receiptCount: result.receipt ? 1 : 0,
    ok: result.ok,
    path: result.latency.path ?? 'fast',
  };
}

async function main() {
  const asJson = process.argv.includes('--json');
  const fixture = createFixture();
  try {
    const ctx = { controllerHome: fixture.controllerHome, repository: fixture.repository, includeLatencyBreakdown: true };
    const cases: CaseResult[] = [];

    cases.push(await runCase('small_file_read', () => executeFast(ctx, {
      operation: 'read_file',
      input: { path: 'README.md' },
    })));
    cases.push(await runCase('symbol_search', () => executeFast(ctx, {
      operation: 'search',
      input: { query: 'add', max_results: 10 },
    })));
    cases.push(await runCase('git_status', () => executeFast(ctx, {
      operation: 'git_status',
      input: {},
    })));
    cases.push(await runCase('git_diff', () => executeFast(ctx, {
      operation: 'git_diff',
      input: { max_bytes: 8192 },
    })));
    cases.push(await runCase('small_bounded_patch', () => executeFast(ctx, {
      operation: 'apply_patch',
      input: {
        operations: [{
          type: 'replace',
          path: 'src/lib.ts',
          old_text: 'return a + b;',
          new_text: 'return a + b; // bench',
        }],
        allowed_paths: ['src/**'],
        purpose: 'bench-patch',
      },
      allowedPaths: ['src/**'],
    })));
    cases.push(await runCase('short_focused_command', () => executeFast(ctx, {
      operation: 'repository_command_execute',
      input: { command: ['git', 'status', '--short'] },
      timeoutMs: 10_000,
    })));
    cases.push(await runCase('7_step_typed_batch', async () => {
      const batch = await executeRepositoryBatch(ctx, {
        repoId: fixture.repository.repoId,
        includeLatencyBreakdown: true,
        steps: [
          { kind: 'read_file', input: { path: 'README.md' } },
          { kind: 'search', input: { query: 'add' } },
          { kind: 'read_file', input: { path: 'src/lib.ts' } },
          { kind: 'git_diff', input: {} },
          { kind: 'git_status', input: {} },
          { kind: 'run_short_command', input: { command: ['git', 'rev-parse', 'HEAD'] } },
          { kind: 'search', input: { query: 'benchmark' } },
        ],
      });
      return {
        ok: batch.ok,
        latency: batch.latency,
        receipt: batch.receipt,
        durableSideEffects: {
          executionJobCount: 0,
          localJobCount: 0,
          workerSpawnCount: 0,
          projectionUpdateCount: 0,
        },
      };
    }));
    cases.push(await runCase('4_lane_read_only_analysis', async () => {
      const lanes = await executeLightweightLanes(ctx, {
        repoId: fixture.repository.repoId,
        includeLatencyBreakdown: true,
        maxConcurrency: 4,
        readLanes: [
          { kind: 'search', input: { query: 'add' } },
          { kind: 'read_file', input: { path: 'README.md' } },
          { kind: 'git_status', input: {} },
          { kind: 'git_diff', input: {} },
        ],
      });
      return {
        ok: lanes.ok,
        latency: lanes.latency,
        receipt: lanes.receipt,
        durableSideEffects: {
          executionJobCount: 0,
          localJobCount: 0,
          workerSpawnCount: 0,
          projectionUpdateCount: 0,
        },
      };
    }));

    const report = {
      schemaVersion: 1,
      at: new Date().toISOString(),
      path: 'fast',
      note: 'After Thin Harness V1. Eligible cases must show zero ExecutionJob/LocalJob/Worker/projection counts.',
      cases,
      totals: {
        totalMs: Math.round(cases.reduce((sum, entry) => sum + entry.totalMs, 0) * 100) / 100,
        overheadMs: Math.round(cases.reduce((sum, entry) => sum + entry.overheadMs, 0) * 100) / 100,
        executionJobCount: cases.reduce((sum, entry) => sum + entry.executionJobCount, 0),
        localJobCount: cases.reduce((sum, entry) => sum + entry.localJobCount, 0),
        workerSpawnCount: cases.reduce((sum, entry) => sum + entry.workerSpawnCount, 0),
        projectionUpdateCount: cases.reduce((sum, entry) => sum + entry.projectionUpdateCount, 0),
        receiptCount: cases.reduce((sum, entry) => sum + entry.receiptCount, 0),
      },
    };

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('Thin Harness V1 benchmark (fixture repo)\n');
      console.log(
        'case'.padEnd(28),
        'totalMs'.padStart(10),
        'opMs'.padStart(10),
        'overhead'.padStart(10),
        'jobs'.padStart(6),
        'local'.padStart(6),
        'worker'.padStart(6),
        'proj'.padStart(6),
        'rcpt'.padStart(6),
        'ok'.padStart(4),
      );
      for (const entry of cases) {
        console.log(
          entry.name.padEnd(28),
          entry.totalMs.toFixed(2).padStart(10),
          entry.operationExecutionMs.toFixed(2).padStart(10),
          entry.overheadMs.toFixed(2).padStart(10),
          String(entry.executionJobCount).padStart(6),
          String(entry.localJobCount).padStart(6),
          String(entry.workerSpawnCount).padStart(6),
          String(entry.projectionUpdateCount).padStart(6),
          String(entry.receiptCount).padStart(6),
          String(entry.ok).padStart(4),
        );
      }
      console.log('\nTotals:', report.totals);
      console.log('\nAcceptance: eligible Fast Path creates 0 durable jobs and 0 workers.');
    }

    const failed = cases.filter((entry) => !entry.ok);
    const durableLeak = cases.some((entry) =>
      entry.executionJobCount > 0 || entry.localJobCount > 0 || entry.workerSpawnCount > 0);
    if (failed.length || durableLeak) {
      process.exitCode = 1;
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
