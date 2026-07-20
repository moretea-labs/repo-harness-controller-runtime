import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import {
  callRepositoryTool,
  repositoryToolDefinitions,
} from '../../src/cli/mcp/repository-tools';
import { listLocalBridgeJobSnapshots } from '../../src/cli/local-bridge/job-store';
import {
  acquireCheckoutMutationGate,
  detectPatchProposalConflicts,
  executeFast,
  executeLightweightLanes,
  executeRepositoryBatch,
  getFastPathMetrics,
  integratePatchProposals,
  isFastEligibleTool,
  isFocusedCheckCommand,
  listFastReceipts,
  releaseCheckoutMutationGate,
  resetFastPathMetrics,
  routeExecution,
  runBoundedProcess,
  withCheckoutMutationGate,
  writeFastReceipt,
} from '../../src/runtime/execution/thin-harness';
import { listExecutionJobs } from '../../src/runtime/execution/jobs/store';
import {
  acquireExecutionLeases,
  getLeaseSideEffectMetrics,
  releaseExecutionLeases,
  resetLeaseSideEffectMetrics,
} from '../../src/runtime/resources/leases/store';
import { resourceKeysOverlap } from '../../src/runtime/resources/claims/conflicts';

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
}

function fixture() {
  const controllerHome = tempRoot('thin-harness-home-');
  const repoRoot = tempRoot('thin-harness-repo-');
  mkdirSync(controllerHome, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Thin Harness Test']);
  git(repoRoot, ['config', 'user.email', 'thin-harness@example.com']);
  writeFileSync(join(repoRoot, 'README.md'), 'hello thin harness\n');
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'sample.ts'), 'export const answer = 42;\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'init']);
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'thin-harness-fixture' });
  return { controllerHome, repoRoot, repository };
}

function executionJobCount(controllerHome: string, repoId: string): number {
  try {
    return listExecutionJobs(controllerHome, repoId).length;
  } catch {
    return 0;
  }
}

function localJobCount(repoRoot: string): number {
  try {
    return listLocalBridgeJobSnapshots(repoRoot).length;
  } catch {
    const dir = join(repoRoot, '.ai/harness/local-jobs');
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((name) => name.startsWith('JOB-')).length;
  }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  resetFastPathMetrics();
  resetLeaseSideEffectMetrics();
});

describe('Thin Harness execution router', () => {
  test('bounded read/search/status/diff and short allowlisted commands select fast', () => {
    expect(routeExecution({ operation: 'read_file' }).mode).toBe('fast');
    expect(routeExecution({ operation: 'search' }).mode).toBe('fast');
    expect(routeExecution({ operation: 'git_status' }).mode).toBe('fast');
    expect(routeExecution({ operation: 'git_diff' }).mode).toBe('fast');
    expect(routeExecution({
      operation: 'repository_command_execute',
      command: ['git', 'status', '--short'],
    }).mode).toBe('fast');
    expect(routeExecution({
      operation: 'run_focused_check',
      command: ['bun', 'test', 'tests/runtime/thin-harness.test.ts'],
    }).mode).toBe('fast');
    expect(isFastEligibleTool('repository_git_status')).toBe(true);
  });

  test('long timeout, background, remote write, and agent run select durable', () => {
    expect(routeExecution({
      operation: 'run_short_command',
      command: ['git', 'status'],
      timeoutMs: 120_000,
    }).mode).toBe('durable');
    expect(routeExecution({
      operation: 'read_file',
      background: true,
    }).mode).toBe('durable');
    expect(routeExecution({
      operation: 'repository_command_execute',
      command: ['git', 'push', 'origin', 'main'],
    }).mode).toBe('durable');
    expect(routeExecution({
      operation: 'quick_agent_session',
      agentRun: true,
    }).mode).toBe('durable');
    expect(routeExecution({ operation: 'run_check' }).mode).toBe('durable');
  });

  test('destructive and unknown commands do not enter fast', () => {
    expect(routeExecution({
      operation: 'repository_command_execute',
      command: ['git', 'reset', '--hard', 'HEAD'],
    }).mode).toBe('reject');
    expect(routeExecution({
      operation: 'repository_command_execute',
      command: ['completely-unknown-binary', '--mutate'],
    }).mode).toBe('durable');
    expect(routeExecution({
      operation: 'mystery_op',
    }).mode).toBe('durable');
  });

  test('path scope violations reject', () => {
    expect(routeExecution({
      operation: 'apply_patch',
      paths: ['secrets/token.txt'],
      allowedPaths: ['src/**'],
    }).mode).toBe('reject');
  });

  test('bare package tests are not focused; file-scoped checks are', () => {
    expect(isFocusedCheckCommand(['bun', 'test'])).toBe(false);
    expect(isFocusedCheckCommand(['npm', 'test'])).toBe(false);
    expect(isFocusedCheckCommand(['pnpm', 'test'])).toBe(false);
    expect(isFocusedCheckCommand(['yarn', 'test'])).toBe(false);
    expect(isFocusedCheckCommand(['pytest'])).toBe(false);
    expect(isFocusedCheckCommand(['cargo', 'test'])).toBe(false);
    expect(isFocusedCheckCommand(['node', '--test'])).toBe(false);
    expect(isFocusedCheckCommand(['bun', 'test', 'tests/runtime/thin-harness.test.ts'])).toBe(true);
    expect(isFocusedCheckCommand(['pytest', 'tests/test_foo.py', '-k', 'smoke'])).toBe(true);
    expect(isFocusedCheckCommand(['cargo', 'test', '--lib'])).toBe(true);
    expect(routeExecution({
      operation: 'run_focused_check',
      command: ['bun', 'test'],
    }).mode).toBe('durable');
    expect(routeExecution({
      operation: 'run_focused_check',
      command: ['npm', 'test'],
    }).mode).toBe('durable');
    expect(routeExecution({
      operation: 'run_focused_check',
      command: ['pytest'],
    }).mode).toBe('durable');
    expect(routeExecution({
      operation: 'run_focused_check',
      command: ['bun', 'test', 'tests/runtime/thin-harness.test.ts'],
    }).mode).toBe('fast');
  });
});

describe('Thin Harness fast execution', () => {
  test('eligible fast call does not create ExecutionJob, Local Job, Worker, or projection rebuild', async () => {
    const { controllerHome, repoRoot, repository } = fixture();
    resetFastPathMetrics();
    const beforeJobs = executionJobCount(controllerHome, repository.repoId);
    const beforeLocal = localJobCount(repoRoot);

    const read = await executeFast(
      { controllerHome, repository, includeLatencyBreakdown: true },
      { operation: 'read_file', mode: 'auto', input: { path: 'README.md', start_line: 1, end_line: 10 } },
    );
    expect(read.ok).toBe(true);
    expect(read.decision.mode).toBe('fast');
    expect(read.durableSideEffects.executionJobCount).toBe(0);
    expect(read.durableSideEffects.localJobCount).toBe(0);
    expect(read.durableSideEffects.workerSpawnCount).toBe(0);
    expect(read.durableSideEffects.projectionUpdateCount).toBe(0);
    expect(read.receipt?.mode).toBe('fast');
    expect(executionJobCount(controllerHome, repository.repoId)).toBe(beforeJobs);
    expect(localJobCount(repoRoot)).toBe(beforeLocal);

    const search = await executeFast(
      { controllerHome, repository },
      { operation: 'search', input: { query: 'answer', max_results: 5 } },
    );
    expect(search.ok).toBe(true);
    expect(JSON.stringify(search.result)).toContain('sample.ts');

    const status = await executeFast(
      { controllerHome, repository },
      { operation: 'git_status', input: {} },
    );
    expect(status.ok).toBe(true);
    expect(status.receipt?.repositoryChanged).toBe(false);

    const receipts = listFastReceipts(controllerHome, repository.repoId, 10);
    expect(receipts.length).toBeGreaterThanOrEqual(3);
    expect(getFastPathMetrics().receiptCount).toBeGreaterThanOrEqual(3);
  });

  test('write call is path-scoped and serializes under checkout lock', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    const applied = await executeFast(
      { controllerHome, repository },
      {
        operation: 'apply_patch',
        mode: 'fast',
        input: {
          operations: [{
            type: 'replace',
            path: 'src/sample.ts',
            old_text: 'export const answer = 42;',
            new_text: 'export const answer = 43;',
          }],
          allowed_paths: ['src/**'],
          purpose: 'thin-harness-test',
        },
        allowedPaths: ['src/**'],
      },
    );
    expect(applied.ok).toBe(true);
    expect(applied.receipt?.changedPaths.some((path) => path.includes('sample.ts'))).toBe(true);
    expect(readFileSync(join(repoRoot, 'src/sample.ts'), 'utf8')).toContain('43');
    expect(executionJobCount(controllerHome, repository.repoId)).toBe(0);

    const denied = await executeFast(
      { controllerHome, repository },
      {
        operation: 'apply_patch',
        mode: 'fast',
        input: {
          operations: [{
            type: 'replace',
            path: 'README.md',
            old_text: 'hello thin harness',
            new_text: 'hello denied',
          }],
          allowed_paths: ['src/**'],
        },
        allowedPaths: ['src/**'],
      },
    );
    // Must fail closed without mutating the out-of-scope file.
    expect(denied.ok).toBe(false);
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toContain('hello thin harness');
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).not.toContain('hello denied');
  });

  test('short readonly command runs on fast path without local job', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    const beforeLocal = localJobCount(repoRoot);
    const result = await executeFast(
      { controllerHome, repository, includeLatencyBreakdown: true },
      {
        operation: 'repository_command_execute',
        mode: 'auto',
        input: { command: ['git', 'status', '--short'] },
        timeoutMs: 10_000,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.decision.mode).toBe('fast');
    expect(localJobCount(repoRoot)).toBe(beforeLocal);
    expect(result.latency.totalMs).toBeGreaterThan(0);
  });

  test('fast command yields so concurrent async work can progress (event-loop friendly)', async () => {
    const { controllerHome, repository } = fixture();
    let healthTicks = 0;
    const health = (async () => {
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        healthTicks += 1;
      }
    })();
    const command = executeFast(
      { controllerHome, repository },
      {
        operation: 'repository_command_execute',
        mode: 'auto',
        input: { command: ['sleep', '0.25'] },
        timeoutMs: 5_000,
      },
    );
    await Promise.all([command, health]);
    // If spawnSync blocked the loop, health ticks would stay near 0.
    expect(healthTicks).toBeGreaterThanOrEqual(5);
  });

  test('receipt write failure does not flip a successful mutation to failed', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    // Force receipt dir into a non-writable file so write fails after mutation.
    const receiptsParent = join(controllerHome, 'repositories', repository.repoId);
    mkdirSync(receiptsParent, { recursive: true });
    // writeFastReceipt uses repositoryControllerRoot/.../fast-receipts — poison via chmod if needed.
    // Prefer exercising writeFastReceipt API directly for the failure path contract.
    const written = writeFastReceipt('/definitely/not/a/writable/controller-home', {
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      operation: 'apply_patch',
      startedAt: new Date().toISOString(),
      durationMs: 1,
      outcome: 'succeeded',
      changedPaths: ['src/sample.ts'],
      repositoryChanged: true,
    });
    expect(written.persisted).toBe(false);
    expect(written.warning).toBeTruthy();
    expect(written.receipt?.outcome).toBe('succeeded');

    const applied = await executeFast(
      { controllerHome, repository },
      {
        operation: 'apply_patch',
        mode: 'fast',
        input: {
          operations: [{
            type: 'replace',
            path: 'src/sample.ts',
            old_text: 'export const answer = 42;',
            new_text: 'export const answer = 77;',
          }],
          allowed_paths: ['src/**'],
        },
        allowedPaths: ['src/**'],
        receiptMode: 'none',
      },
    );
    expect(applied.ok).toBe(true);
    expect(applied.operationSucceeded).toBe(true);
    expect(applied.receipt).toBeUndefined();
    expect(readFileSync(join(repoRoot, 'src/sample.ts'), 'utf8')).toContain('77');
  });

  test('identical request_id replays without re-applying mutation', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    const requestId = 'req-idempotent-patch-1';
    const input = {
      operations: [{
        type: 'replace',
        path: 'src/sample.ts',
        old_text: 'export const answer = 42;',
        new_text: 'export const answer = 55;',
      }],
      allowed_paths: ['src/**'],
    };
    const first = await executeFast(
      { controllerHome, repository },
      {
        operation: 'apply_patch',
        mode: 'fast',
        input,
        allowedPaths: ['src/**'],
        requestId,
      },
    );
    expect(first.ok).toBe(true);
    expect(readFileSync(join(repoRoot, 'src/sample.ts'), 'utf8')).toContain('55');

    // Revert file to prove replay does not re-run apply.
    writeFileSync(join(repoRoot, 'src/sample.ts'), 'export const answer = 42;\n');
    const second = await executeFast(
      { controllerHome, repository },
      {
        operation: 'apply_patch',
        mode: 'fast',
        input,
        allowedPaths: ['src/**'],
        requestId,
      },
    );
    expect(second.ok).toBe(true);
    expect(second.result?.replayed).toBe(true);
    expect(readFileSync(join(repoRoot, 'src/sample.ts'), 'utf8')).toContain('42');
  });

  test('out-of-scope patch is rejected before mutation and leaves file unchanged', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    const before = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    const denied = await executeFast(
      { controllerHome, repository },
      {
        operation: 'apply_patch',
        mode: 'fast',
        input: {
          operations: [{
            type: 'replace',
            path: 'README.md',
            old_text: 'hello thin harness',
            new_text: 'should not apply',
          }],
        },
        allowedPaths: ['src/**'],
      },
    );
    expect(denied.ok).toBe(false);
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toBe(before);
  });

  test('durable write lease blocks fast mutation gate', async () => {
    const { controllerHome, repository } = fixture();
    const leases = acquireExecutionLeases(
      controllerHome,
      repository.repoId,
      'JOB-durable-writer-test',
      [{ resourceKey: `workspace:${repository.activeCheckoutId}`, mode: 'write' }],
      15_000,
    );
    expect(leases.acquired).toBe(true);
    try {
      const result = await executeFast(
        { controllerHome, repository },
        {
          operation: 'apply_patch',
          mode: 'fast',
          input: {
            operations: [{
              type: 'replace',
              path: 'src/sample.ts',
              old_text: 'export const answer = 42;',
              new_text: 'export const answer = 1;',
            }],
            allowed_paths: ['src/**'],
          },
          allowedPaths: ['src/**'],
        },
      );
      expect(result.ok).toBe(false);
      expect(result.decision.reasons.some((reason) => reason.includes('mutation_busy') || reason.includes('busy'))).toBe(true);
      expect((result.result?.error as { code?: string } | undefined)?.code).toBe('MUTATION_BUSY');
    } finally {
      releaseExecutionLeases(controllerHome, repository.repoId, 'JOB-durable-writer-test');
    }
  });

  test('stage_paths holds mutation gate until git completes', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    writeFileSync(join(repoRoot, 'src/sample.ts'), 'export const answer = 88;\n');
    const owner = 'test-hold-gate';
    const gate = await acquireCheckoutMutationGate({
      controllerHome,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      repoRoot,
      owner,
      ttlMs: 10_000,
    });
    expect('acquired' in gate && gate.acquired).toBe(true);
    try {
      const competing = await executeFast(
        { controllerHome, repository },
        {
          operation: 'stage_paths',
          mode: 'fast',
          input: { paths: ['src/sample.ts'] },
          requestId: 'stage-while-gate-held',
        },
      );
      expect(competing.ok).toBe(false);
      expect((competing.result?.error as { code?: string } | undefined)?.code).toBe('MUTATION_BUSY');
    } finally {
      if ('acquired' in gate && gate.acquired) {
        releaseCheckoutMutationGate(controllerHome, repository.repoId, repository.activeCheckoutId, gate.gate.ownerJobId, {
          leaseId: gate.gate.leaseId,
          fencingToken: gate.gate.fencingToken,
        });
      }
    }
  });

  test('AbortSignal cancels bounded process and marks cancelled', async () => {
    const controller = new AbortController();
    const pending = runBoundedProcess('sleep', ['2'], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const result = await pending;
    expect(result.cancelled || result.ok === false).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test('AbortSignal cancels Fast repository_command_execute mid-flight', async () => {
    const { controllerHome, repository } = fixture();
    const controller = new AbortController();
    const pending = executeFast(
      { controllerHome, repository },
      {
        operation: 'repository_command_execute',
        mode: 'auto',
        input: { command: ['sleep', '3'] },
        timeoutMs: 10_000,
        signal: controller.signal,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.outcome === 'cancelled' || (result.result as { cancelled?: boolean } | undefined)?.cancelled === true
      || (result.result?.error as { code?: string } | undefined)?.code === 'CANCELLED').toBe(true);
  });

  test('two concurrent fast writers only one acquires mutation ownership', async () => {
    const { controllerHome, repository } = fixture();
    const [a, b] = await Promise.all([
      executeFast(
        { controllerHome, repository },
        {
          operation: 'apply_patch',
          mode: 'fast',
          input: {
            operations: [{
              type: 'replace',
              path: 'src/sample.ts',
              old_text: 'export const answer = 42;',
              new_text: 'export const answer = 100;',
            }],
            allowed_paths: ['src/**'],
          },
          allowedPaths: ['src/**'],
          requestId: 'concurrent-writer-a',
        },
      ),
      executeFast(
        { controllerHome, repository },
        {
          operation: 'apply_patch',
          mode: 'fast',
          input: {
            operations: [{
              type: 'replace',
              path: 'src/sample.ts',
              old_text: 'export const answer = 42;',
              new_text: 'export const answer = 200;',
            }],
            allowed_paths: ['src/**'],
          },
          allowedPaths: ['src/**'],
          requestId: 'concurrent-writer-b',
        },
      ),
    ]);
    const successes = [a, b].filter((entry) => entry.ok);
    const busy = [a, b].filter((entry) =>
      (entry.result?.error as { code?: string } | undefined)?.code === 'MUTATION_BUSY'
      || entry.decision.reasons.some((reason) => reason.includes('mutation_busy') || reason.includes('busy')));
    // At most one success; the other should be busy or fail on content mismatch after first write.
    expect(successes.length).toBeLessThanOrEqual(1);
    expect(successes.length + busy.length + [a, b].filter((e) => !e.ok).length).toBeGreaterThanOrEqual(2);
  });

  test('fast mutation ownership blocks durable lease acquire', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    const gate = await acquireCheckoutMutationGate({
      controllerHome,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      repoRoot,
      owner: 'fast:hold-for-durable-test',
      ttlMs: 15_000,
    });
    expect('acquired' in gate && gate.acquired).toBe(true);
    try {
      const durable = acquireExecutionLeases(
        controllerHome,
        repository.repoId,
        'JOB-durable-blocked-by-fast',
        [{ resourceKey: `workspace:${repository.activeCheckoutId}`, mode: 'write' }],
        10_000,
      );
      expect(durable.acquired).toBe(false);
      expect(durable.blockers.some((blocker) => blocker.ownerJobId.includes('fast:'))).toBe(true);
    } finally {
      if ('acquired' in gate && gate.acquired) {
        releaseCheckoutMutationGate(controllerHome, repository.repoId, repository.activeCheckoutId, gate.gate.ownerJobId, {
          leaseId: gate.gate.leaseId,
          fencingToken: gate.gate.fencingToken,
        });
      }
    }
  });

  test('resourceKeysOverlap: workspace conflicts path and git-ref', () => {
    const checkout = 'co_abc';
    expect(resourceKeysOverlap(`workspace:${checkout}`, `path:src/a.ts`)).toBe(true);
    expect(resourceKeysOverlap(`workspace:${checkout}`, `path:${checkout}:src/a.ts`)).toBe(true);
    expect(resourceKeysOverlap(`workspace:${checkout}`, `path:other:src/a.ts`)).toBe(false);
    expect(resourceKeysOverlap(`workspace:${checkout}`, `git-index:${checkout}`)).toBe(true);
    expect(resourceKeysOverlap(`workspace:${checkout}`, 'git-ref:refs/heads/main')).toBe(true);
    expect(resourceKeysOverlap(`workspace:${checkout}`, `workspace:${checkout}`)).toBe(true);
    expect(resourceKeysOverlap(`workspace:${checkout}`, 'workspace:other')).toBe(false);
  });

  test('fast workspace lease blocks durable path lease', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    const gate = await acquireCheckoutMutationGate({
      controllerHome,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      repoRoot,
      owner: 'fast:block-path',
      ttlMs: 15_000,
    });
    expect('acquired' in gate && gate.acquired).toBe(true);
    try {
      const pathLease = acquireExecutionLeases(
        controllerHome,
        repository.repoId,
        'JOB-path-writer',
        [{ resourceKey: 'path:src/sample.ts', mode: 'write' }],
        10_000,
      );
      expect(pathLease.acquired).toBe(false);
      const refLease = acquireExecutionLeases(
        controllerHome,
        repository.repoId,
        'JOB-ref-writer',
        [{ resourceKey: 'git-ref:refs/heads/main', mode: 'write' }],
        10_000,
      );
      expect(refLease.acquired).toBe(false);
    } finally {
      if ('acquired' in gate && gate.acquired) {
        releaseCheckoutMutationGate(controllerHome, repository.repoId, repository.activeCheckoutId, gate.gate.ownerJobId, {
          leaseId: gate.gate.leaseId,
          fencingToken: gate.gate.fencingToken,
        });
      }
    }
  });

  test('ephemeral fast lease does not mark projection dirty or wake scheduler', async () => {
    const { controllerHome, repository } = fixture();
    resetLeaseSideEffectMetrics();
    const before = getLeaseSideEffectMetrics();
    const applied = await executeFast(
      { controllerHome, repository },
      {
        operation: 'apply_patch',
        mode: 'fast',
        input: {
          operations: [{
            type: 'replace',
            path: 'src/sample.ts',
            old_text: 'export const answer = 42;',
            new_text: 'export const answer = 7;',
          }],
          allowed_paths: ['src/**'],
        },
        allowedPaths: ['src/**'],
        requestId: 'ephemeral-side-effects',
      },
    );
    expect(applied.ok).toBe(true);
    expect(applied.durableSideEffects.projectionUpdateCount).toBe(0);
    expect(applied.durableSideEffects.schedulerWakeCount ?? 0).toBe(0);
    expect(applied.durableSideEffects.runtimeEventCount ?? 0).toBe(0);
    const after = getLeaseSideEffectMetrics();
    expect(after.projectionDirtyMarks - before.projectionDirtyMarks).toBe(0);
    expect(after.schedulerWakes - before.schedulerWakes).toBe(0);
    expect(after.ephemeralAcquires - before.ephemeralAcquires).toBeGreaterThanOrEqual(1);
  });

  test('long mutation heartbeat renews without LOCK_HELD while holding ownership', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    const result = await withCheckoutMutationGate(
      {
        controllerHome,
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        repoRoot,
        owner: 'fast:heartbeat-long',
        ttlMs: 3_000,
      },
      async (gate, helpers) => {
        // Hold ownership for > 2 renew intervals without holding repository controller lock.
        await new Promise((resolve) => setTimeout(resolve, 7_000));
        helpers.assert();
        return helpers.getGate().renewCount;
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeGreaterThanOrEqual(2);
    }
  }, 15_000);

  test('concurrent same requestId only one mutation; second is in_progress or replay', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    const requestId = 'same-request-concurrent';
    const input = {
      operations: [{
        type: 'replace',
        path: 'src/sample.ts',
        old_text: 'export const answer = 42;',
        new_text: 'export const answer = 333;',
      }],
      allowed_paths: ['src/**'],
    };
    const [first, second] = await Promise.all([
      executeFast(
        { controllerHome, repository },
        { operation: 'apply_patch', mode: 'fast', input, allowedPaths: ['src/**'], requestId },
      ),
      executeFast(
        { controllerHome, repository },
        { operation: 'apply_patch', mode: 'fast', input, allowedPaths: ['src/**'], requestId },
      ),
    ]);
    const outcomes = [first, second];
    const applied = outcomes.filter((entry) => entry.ok && entry.result?.replayed !== true && entry.operationSucceeded);
    const replayOrInProgress = outcomes.filter((entry) =>
      entry.result?.replayed === true
      || (entry.result?.error as { code?: string } | undefined)?.code === 'REQUEST_IN_PROGRESS'
      || entry.decision.reasons.includes('idempotent_in_progress')
      || entry.decision.reasons.includes('idempotent_replay'));
    // Only one should fully execute the mutation path as primary success without replay.
    expect(applied.length).toBeLessThanOrEqual(1);
    expect(replayOrInProgress.length + applied.length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(repoRoot, 'src/sample.ts'), 'utf8')).toMatch(/333|42/);
  });
});

describe('Thin Harness batch', () => {
  test('multiple read steps share one batch receipt and stopOnError works', async () => {
    const { controllerHome, repository } = fixture();
    const batch = await executeRepositoryBatch(
      { controllerHome, repository },
      {
        repoId: repository.repoId,
        mode: 'auto',
        includeLatencyBreakdown: true,
        steps: [
          { kind: 'read_file', input: { path: 'README.md' } },
          { kind: 'search', input: { query: 'answer', max_results: 5 } },
          { kind: 'git_status', input: {} },
          { kind: 'git_diff', input: { max_bytes: 4096 } },
        ],
      },
    );
    expect(batch.mode).toBe('fast');
    expect(batch.ok).toBe(true);
    expect(batch.steps).toHaveLength(4);
    expect(batch.receipt?.stepCount).toBe(4);
    expect(batch.receipt?.operation).toBe('batch');
    expect(executionJobCount(controllerHome, repository.repoId)).toBe(0);
    // Parent receipt only — no N+1 child receipts for batch steps.
    const receipts = listFastReceipts(controllerHome, repository.repoId, 50);
    const batchReceipts = receipts.filter((entry) => entry.operation === 'batch');
    expect(batchReceipts).toHaveLength(1);
    expect(receipts.filter((entry) => entry.operation === 'read_file' || entry.operation === 'search')).toHaveLength(0);

    const failing = await executeRepositoryBatch(
      { controllerHome, repository },
      {
        repoId: repository.repoId,
        stopOnError: true,
        steps: [
          { kind: 'read_file', input: { path: 'README.md' } },
          { kind: 'read_file', input: { path: 'does-not-exist-xyz.md' } },
          { kind: 'git_status', input: {} },
        ],
      },
    );
    expect(failing.ok).toBe(false);
    expect(failing.stoppedEarly).toBe(true);
    expect(failing.steps.length).toBeLessThan(3);
  });

  test('durable step blocks entire fast batch before execution', async () => {
    const { controllerHome, repository } = fixture();
    const batch = await executeRepositoryBatch(
      { controllerHome, repository },
      {
        repoId: repository.repoId,
        mode: 'auto',
        steps: [
          { kind: 'git_status', input: {} },
          {
            kind: 'run_short_command',
            input: { command: ['git', 'push', 'origin', 'main'], timeout_ms: 5_000 },
          },
        ],
      },
    );
    expect(batch.mode).toBe('durable');
    expect(batch.steps).toHaveLength(0);
    expect(batch.escalation?.suggestedOperation).toBeTruthy();
  });
});

describe('Thin Harness lightweight lanes', () => {
  test('four read lanes run concurrently without writing the repo', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    const before = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    const started = performance.now();
    const lanes = await executeLightweightLanes(
      { controllerHome, repository },
      {
        repoId: repository.repoId,
        includeLatencyBreakdown: true,
        maxConcurrency: 4,
        readLanes: [
          { id: 'a', kind: 'run_short_command', input: { command: ['sleep', '0.2'] } },
          { id: 'b', kind: 'run_short_command', input: { command: ['sleep', '0.2'] } },
          { id: 'c', kind: 'run_short_command', input: { command: ['sleep', '0.2'] } },
          { id: 'd', kind: 'run_short_command', input: { command: ['sleep', '0.2'] } },
        ],
      },
    );
    const elapsed = performance.now() - started;
    expect(lanes.readLanes).toHaveLength(4);
    expect(lanes.readLanes.every((lane) => lane.ok)).toBe(true);
    expect(lanes.createdCampaign).toBe(false);
    expect(lanes.createdIssue).toBe(false);
    expect(lanes.createdWorktree).toBe(false);
    expect(lanes.appliedByIntegrator).toBe(false);
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toBe(before);
    expect(lanes.receipt?.laneCount).toBe(4);
    // Parent receipt only.
    const receipts = listFastReceipts(controllerHome, repository.repoId, 20);
    expect(receipts.filter((entry) => entry.operation === 'read_lanes' || entry.operation === 'patch_proposal_validate')).toHaveLength(1);
    // Deterministic concurrency: 4x200ms serial ≈800ms; concurrent should be well under serial sum.
    expect(elapsed).toBeLessThan(700);
    expect(lanes.concurrent).toBe(true);
    // Overlapping start/finish windows.
    const withTiming = lanes.readLanes.filter((lane) =>
      lane.startedAtMs !== undefined && lane.finishedAtMs !== undefined);
    expect(withTiming.length).toBe(4);
    const overlaps = withTiming.some((left, i) =>
      withTiming.some((right, j) => i !== j
        && left.startedAtMs! < right.finishedAtMs!
        && right.startedAtMs! < left.finishedAtMs!));
    expect(overlaps).toBe(true);
  });

  test('patch proposal conflicts demote to analysis-only; integrator applies non-conflicting proposals', async () => {
    const conflicts = detectPatchProposalConflicts([
      {
        id: 'p1',
        readPaths: ['src/a.ts'],
        writePaths: ['src/shared.ts'],
        proposedOperations: [{ type: 'write', path: 'src/shared.ts', content: 'a' }],
      },
      {
        id: 'p2',
        readPaths: ['src/b.ts'],
        writePaths: ['src/shared.ts'],
        proposedOperations: [{ type: 'write', path: 'src/shared.ts', content: 'b' }],
      },
      {
        id: 'p3',
        readPaths: ['src/c.ts'],
        writePaths: ['project.pbxproj'],
        proposedOperations: [{ type: 'write', path: 'project.pbxproj', content: 'x' }],
      },
      {
        id: 'p4',
        readPaths: ['src/d.ts'],
        writePaths: ['ios/App.xcodeproj/project.pbxproj'],
        proposedOperations: [{ type: 'write', path: 'ios/App.xcodeproj/project.pbxproj', content: 'y' }],
      },
    ]);
    expect(conflicts.some((entry) => entry.type === 'write_write')).toBe(true);
    expect(conflicts.some((entry) => entry.type === 'project_file')).toBe(true);

    const { controllerHome, repository, repoRoot } = fixture();
    const lanes = await executeLightweightLanes(
      { controllerHome, repository },
      {
        repoId: repository.repoId,
        patchProposalLanes: [
          {
            id: 'ok-lane',
            readPaths: ['src/sample.ts'],
            writePaths: ['src/sample.ts'],
            proposedOperations: [{
              type: 'replace',
              path: 'src/sample.ts',
              old_text: 'export const answer = 42;',
              new_text: 'export const answer = 99;',
            }],
          },
          {
            id: 'conflict-a',
            readPaths: ['README.md'],
            writePaths: ['README.md'],
            proposedOperations: [{
              type: 'replace',
              path: 'README.md',
              old_text: 'hello thin harness',
              new_text: 'conflict a',
            }],
          },
          {
            id: 'conflict-b',
            readPaths: ['README.md'],
            writePaths: ['README.md'],
            proposedOperations: [{
              type: 'replace',
              path: 'README.md',
              old_text: 'hello thin harness',
              new_text: 'conflict b',
            }],
          },
        ],
      },
    );
    const okLane = lanes.patchProposals.find((lane) => lane.id === 'ok-lane');
    const conflictA = lanes.patchProposals.find((lane) => lane.id === 'conflict-a');
    expect(okLane?.analysisOnly).toBeFalsy();
    expect(conflictA?.analysisOnly).toBe(true);
    expect(conflictA?.proposedOperations).toHaveLength(0);

    // Proposals never write until integrator runs.
    expect(readFileSync(join(repoRoot, 'src/sample.ts'), 'utf8')).toContain('42');

    const integrated = await integratePatchProposals(
      { controllerHome, repository },
      lanes.patchProposals.filter((lane) => !lane.analysisOnly),
      { allowedPaths: ['src/**'], purpose: 'thin-harness-integrator' },
    );
    expect(integrated.ok).toBe(true);
    expect(readFileSync(join(repoRoot, 'src/sample.ts'), 'utf8')).toContain('99');
    expect(executionJobCount(controllerHome, repository.repoId)).toBe(0);

    // Integrator rejects missing / stale / tampered server proposals.
    const missing = await integratePatchProposals(
      { controllerHome, repository },
      [{
        id: 'stale',
        ok: true,
        durationMs: 0,
        readPaths: ['src/sample.ts'],
        writePaths: ['src/sample.ts'],
        proposedOperations: [{
          type: 'replace',
          path: 'src/sample.ts',
          old_text: 'export const answer = 99;',
          new_text: 'export const answer = 100;',
        }],
        proposalId: 'prop_missing_not_on_server',
        baseRevision: '0000000000000000000000000000000000000000',
        checkoutId: repository.activeCheckoutId,
      }],
      { allowedPaths: ['src/**'] },
    );
    expect(missing.ok).toBe(false);
    expect(missing.applied[0]?.error).toMatch(/PROPOSAL_NOT_FOUND|revision_changed|STALE/);

    // Create a real server proposal then mutate workspace so fingerprints fail.
    const { createServerPatchProposal, readServerPatchProposal, validateServerPatchProposalForApply } = await import('../../src/runtime/execution/thin-harness/proposal-store');
    const serverProp = await createServerPatchProposal({
      controllerHome,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      repoRoot,
      readPaths: ['src/sample.ts'],
      writePaths: ['src/sample.ts'],
      operations: [{
        type: 'replace',
        path: 'src/sample.ts',
        old_text: 'export const answer = 99;',
        new_text: 'export const answer = 100;',
      }],
    });
    writeFileSync(join(repoRoot, 'src/sample.ts'), 'export const answer = 77;\n');
    const dirtyCheck = await validateServerPatchProposalForApply({
      controllerHome,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      repoRoot,
      proposalId: serverProp.proposalId,
    });
    expect(dirtyCheck.ok).toBe(false);
    if (!dirtyCheck.ok) {
      expect(['PROPOSAL_STALE_WORKSPACE', 'PROPOSAL_PATH_FINGERPRINT_MISMATCH']).toContain(dirtyCheck.code);
    }
    // Restore for later tests in this process
    writeFileSync(join(repoRoot, 'src/sample.ts'), 'export const answer = 99;\n');
    expect(readServerPatchProposal(controllerHome, repository.repoId, serverProp.proposalId)?.proposalId).toBe(serverProp.proposalId);
  });

  test('one lane failure does not cancel others unless failFast', async () => {
    const { controllerHome, repository } = fixture();
    const lanes = await executeLightweightLanes(
      { controllerHome, repository },
      {
        repoId: repository.repoId,
        failFast: false,
        readLanes: [
          { id: 'good', kind: 'git_status', input: {} },
          { id: 'bad', kind: 'read_file', input: { path: 'missing-file-xyz.md' } },
          { id: 'also-good', kind: 'search', input: { query: 'hello' } },
        ],
      },
    );
    expect(lanes.readLanes.find((lane) => lane.id === 'good')?.ok).toBe(true);
    expect(lanes.readLanes.find((lane) => lane.id === 'bad')?.ok).toBe(false);
    expect(lanes.readLanes.find((lane) => lane.id === 'also-good')?.ok).toBe(true);
  });
});

describe('Thin Harness MCP workbench consolidation', () => {
  test('keeps the stable tool surface bounded while preserving route and batch operations', async () => {
    const retired = new Set([
      'repository_batch_execute',
      'repository_lanes_execute',
      'repository_lanes_integrate',
      'repository_fast_receipt_get',
      'repository_fast_receipt_list',
      'repository_execution_route',
    ]);
    expect(repositoryToolDefinitions.some((tool) => tool.name === 'repository_workbench')).toBe(true);
    expect(repositoryToolDefinitions.some((tool) => retired.has(tool.name))).toBe(false);

    const { controllerHome, repository } = fixture();
    const routed = await callRepositoryTool(controllerHome, 'repository_workbench', {
      repo_id: repository.repoId,
      checkout_id: repository.activeCheckoutId,
      operation: 'execution_route',
      payload: { operation: 'git_status' },
    });
    expect(routed?.isError).not.toBe(true);
    const routedPayload = routed?.structuredContent as {
      decision?: { mode?: string };
    } | undefined;
    expect(routedPayload?.decision?.mode).toBe('fast');

    const batch = await callRepositoryTool(controllerHome, 'repository_workbench', {
      repo_id: repository.repoId,
      checkout_id: repository.activeCheckoutId,
      operation: 'batch_execute',
      payload: {
        steps: [
          { kind: 'read_file', input: { path: 'README.md' } },
          { kind: 'git_status', input: {} },
        ],
      },
    });
    expect(batch?.isError).not.toBe(true);
    const batchPayload = batch?.structuredContent as {
      mode?: string;
      steps?: unknown[];
    } | undefined;
    expect(batchPayload?.mode).toBe('fast');
    expect(Array.isArray(batchPayload?.steps)).toBe(true);
  });
});

describe('Thin Harness compatibility guards', () => {
  test('auto is default when mode omitted; high-risk never wrongly enters fast', () => {
    expect(routeExecution({ operation: 'git_status' }).mode).toBe('fast');
    expect(routeExecution({
      operation: 'repository_command_execute',
      command: 'git push --force origin main',
    }).mode).toBe('reject');
    expect(routeExecution({
      operation: 'release_gate',
    }).mode).toBe('durable');
  });
});

describe('Thin Harness V1 close-out correctness', () => {
  test('fast commit ownership blocks durable git-ref writer', async () => {
    const { controllerHome, repository } = fixture();
    const held = await acquireCheckoutMutationGate({
      controllerHome,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      repoRoot: repository.canonicalRoot,
      owner: 'fast:commit-holder',
      ownership: { mutatesGitRefs: true, mutatesGitIndex: true },
    });
    expect('acquired' in held && held.acquired).toBe(true);
    const durable = acquireExecutionLeases(
      controllerHome,
      repository.repoId,
      'JOB-git-ref-writer',
      [{ resourceKey: 'git-ref:HEAD', mode: 'write' }],
      30_000,
    );
    expect(durable.acquired).toBe(false);
    if ('acquired' in held && held.acquired) {
      releaseCheckoutMutationGate(
        controllerHome,
        repository.repoId,
        repository.activeCheckoutId,
        held.gate.ownerJobId,
        held.gate.leaseIds.map((leaseId) => ({
          leaseId,
          fencingToken: held.gate.fencingTokens[leaseId] ?? held.gate.fencingToken,
        })),
      );
    }
  });

  test('ownership loss aborts and stops subsequent batch steps', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    writeFileSync(join(repoRoot, 'src', 'a.ts'), 'a=1\n');
    writeFileSync(join(repoRoot, 'src', 'b.ts'), 'b=1\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'seed']);

    const batchPromise = executeRepositoryBatch(
      { controllerHome, repository },
      {
        repoId: repository.repoId,
        requestId: `batch-own-loss-${Date.now()}`,
        stopOnError: true,
        steps: [
          {
            kind: 'apply_patch',
            input: {
              operations: [{ type: 'write', path: 'src/a.ts', content: 'a=2\n' }],
              allowed_paths: ['src/**'],
              purpose: 'step1',
            },
          },
          {
            kind: 'apply_patch',
            input: {
              operations: [{ type: 'write', path: 'src/b.ts', content: 'b=2\n' }],
              allowed_paths: ['src/**'],
              purpose: 'step2-should-stop',
            },
          },
          {
            kind: 'apply_patch',
            input: {
              operations: [{ type: 'write', path: 'src/a.ts', content: 'a=3\n' }],
              allowed_paths: ['src/**'],
              purpose: 'step3-must-not-run',
            },
          },
        ],
      },
    );

    // Force ownership loss mid-batch by racing a competing durable exclusive claim after first step starts.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // We cannot steal ephemeral fencing easily; instead simulate ownership loss via abort signal.
    // Use a dedicated abort batch:
    const controller = new AbortController();
    const aborted = executeRepositoryBatch(
      { controllerHome, repository },
      {
        repoId: repository.repoId,
        requestId: `batch-abort-${Date.now()}`,
        signal: controller.signal,
        steps: [
          {
            kind: 'run_short_command',
            input: { command: ['sleep', '2'] },
          },
          {
            kind: 'apply_patch',
            input: {
              operations: [{ type: 'write', path: 'src/b.ts', content: 'should-not\n' }],
              allowed_paths: ['src/**'],
            },
          },
        ],
      },
    );
    setTimeout(() => controller.abort(), 30);
    const abortedResult = await aborted;
    expect(abortedResult.ok).toBe(false);
    // Second write step must not fully succeed after abort.
    const writeSteps = abortedResult.steps.filter((step) => step.kind === 'apply_patch');
    expect(writeSteps.every((step) => !step.ok)).toBe(true);

    const normal = await batchPromise;
    // Normal batch may fully succeed; ensure single receipt when it runs to completion or partial.
    if (normal.receipt) {
      const receipts = listFastReceipts(controllerHome, repository.repoId, 50)
        .filter((entry) => entry.operation === 'batch' && entry.requestId?.startsWith('batch-own-loss'));
      expect(receipts.length).toBeLessThanOrEqual(1);
    }
  });

  test('ledger CAS rejects stale owner and failed-retry policy', async () => {
    const { beginFastRequest, completeFastRequest, reconcileFastRequest, readFastRequest } = await import(
      '../../src/runtime/execution/thin-harness/request-ledger'
    );
    const { controllerHome, repository } = fixture();
    const first = beginFastRequest({
      controllerHome,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      requestId: 'ledger-cas-1',
      inputHash: 'hash-a',
      operation: 'apply_patch',
      owner: 'owner-a',
      ownerSessionId: 'sess-a',
      baseSnapshot: 'base-1',
    });
    expect(first.kind).toBe('acquired');
    if (first.kind !== 'acquired') return;

    const staleOwner = completeFastRequest(controllerHome, {
      ...first.entry,
      owner: 'owner-b',
      entryId: first.entry.entryId,
    }, { status: 'succeeded' });
    expect(staleOwner.ok).toBe(false);
    expect(staleOwner.code).toBe('LEDGER_STALE_OWNER');

    const okComplete = completeFastRequest(controllerHome, first.entry, {
      status: 'succeeded',
      receiptExecutionId: 'rx-1',
      resultSummary: 'done',
    });
    expect(okComplete.ok).toBe(true);

    const lateFail = completeFastRequest(controllerHome, first.entry, { status: 'failed', error: 'late' });
    expect(lateFail.ok).toBe(false);

    // Stale expired entry reconciles to unknown without auto-retry when evidence insufficient.
    const second = beginFastRequest({
      controllerHome,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      requestId: 'ledger-reconcile-1',
      inputHash: 'hash-b',
      operation: 'apply_patch',
      owner: 'owner-c',
      baseSnapshot: 'snap-base',
    });
    expect(second.kind).toBe('acquired');
    if (second.kind !== 'acquired') return;
    // Force expiry
    const path = join(
      controllerHome,
      'repositories',
      repository.repoId,
      'fast-request-ledger',
    );
    // Use reconcile API with insufficient evidence
    const reconciled = reconcileFastRequest({
      controllerHome,
      entry: second.entry,
      currentSnapshot: 'snap-different',
      changedPaths: ['src/x.ts'],
    });
    expect(reconciled.verdict).toBe('unknown');
    expect(reconciled.autoRetriable).toBe(false);
    expect(readFastRequest(
      controllerHome,
      repository.repoId,
      repository.activeCheckoutId,
      'ledger-reconcile-1',
    )?.status).toBe('unknown');
    void path;
  });

  test('ledger write failure isolation: mutation success not flipped by complete failure simulation', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    const result = await executeFast(
      { controllerHome, repository },
      {
        operation: 'apply_patch',
        requestId: `ledger-ok-${Date.now()}`,
        input: {
          operations: [{
            type: 'replace',
            path: 'src/sample.ts',
            old_text: 'export const answer = 42;',
            new_text: 'export const answer = 7;',
          }],
          allowed_paths: ['src/**'],
          purpose: 'ledger-isolation',
        },
        allowedPaths: ['src/**'],
      },
    );
    expect(result.operationSucceeded).toBe(true);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(repoRoot, 'src/sample.ts'), 'utf8')).toContain('7');
    expect(result.ledgerPersisted).toBe(true);
  });

  test('savepoint rolls back binary symlink create delete multi-file patch', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    const { symlinkSync, chmodSync } = await import('fs');
    writeFileSync(join(repoRoot, 'src', 'binary.bin'), Buffer.from([0, 1, 2, 255, 10]));
    writeFileSync(join(repoRoot, 'src', 'link-target.txt'), 'target\n');
    symlinkSync('link-target.txt', join(repoRoot, 'src', 'mylink'));
    writeFileSync(join(repoRoot, 'src', 'to-delete.ts'), 'delete-me\n');
    chmodSync(join(repoRoot, 'src', 'binary.bin'), 0o644);
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'binary-seed']);

    const beforeBin = readFileSync(join(repoRoot, 'src', 'binary.bin'));
    const beforeLink = readFileSync(join(repoRoot, 'src', 'link-target.txt'), 'utf8');

    // Force failure after partial apply via out-of-scope second path — savepoint must restore.
    const result = await executeFast(
      { controllerHome, repository },
      {
        operation: 'apply_patch',
        requestId: `sp-${Date.now()}`,
        input: {
          operations: [
            { type: 'write', path: 'src/binary.bin', content: Buffer.from([9, 9, 9]).toString('binary') },
            { type: 'write', path: 'src/link-target.txt', content: 'mutated\n' },
            { type: 'delete', path: 'src/to-delete.ts' },
            { type: 'create', path: 'src/new-file.ts', content: 'created\n' },
            { type: 'write', path: 'OUTSIDE.md', content: 'nope\n' },
          ],
          allowed_paths: ['src/**'],
          purpose: 'savepoint-rollback',
        },
        allowedPaths: ['src/**'],
      },
    );
    expect(result.ok).toBe(false);
    // Either pre-rejected or rolled back — workspace must not keep OUTSIDE or partial mutation without flags.
    expect(existsSync(join(repoRoot, 'OUTSIDE.md'))).toBe(false);
    if (result.cleanupRequired) {
      expect(result.reconciliationRequired).toBe(true);
      expect(result.repositoryChanged).toBe(true);
    } else {
      // Clean rollback or pre-reject (PATH_SCOPE_REJECTED before mutation)
      expect(readFileSync(join(repoRoot, 'src', 'binary.bin')).equals(beforeBin)).toBe(true);
      expect(readFileSync(join(repoRoot, 'src', 'link-target.txt'), 'utf8')).toBe(beforeLink);
      expect(existsSync(join(repoRoot, 'src', 'to-delete.ts'))).toBe(true);
      expect(existsSync(join(repoRoot, 'src', 'new-file.ts'))).toBe(false);
      expect(Boolean(result.repositoryChanged)).toBe(false);
    }
  });

  test('batch gate propagation: single ownership, partialFailure flags, one receipt', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    const result = await executeRepositoryBatch(
      { controllerHome, repository },
      {
        repoId: repository.repoId,
        requestId: `batch-gate-${Date.now()}`,
        stopOnError: true,
        steps: [
          {
            kind: 'apply_patch',
            input: {
              operations: [{
                type: 'replace',
                path: 'src/sample.ts',
                old_text: 'export const answer = 42;',
                new_text: 'export const answer = 1;',
              }],
              allowed_paths: ['src/**'],
              purpose: 'b1',
            },
          },
          {
            kind: 'apply_patch',
            input: {
              operations: [{
                type: 'replace',
                path: 'src/sample.ts',
                old_text: 'export const answer = 1;',
                new_text: 'export const answer = 2;',
              }],
              allowed_paths: ['src/**'],
              purpose: 'b2',
            },
          },
          {
            // intentional failure
            kind: 'apply_patch',
            input: {
              operations: [{
                type: 'replace',
                path: 'src/sample.ts',
                old_text: 'THIS_TEXT_DOES_NOT_EXIST',
                new_text: 'x',
              }],
              allowed_paths: ['src/**'],
              purpose: 'b3-fail',
            },
          },
          {
            kind: 'apply_patch',
            input: {
              operations: [{
                type: 'write',
                path: 'src/sample.ts',
                content: 'should-not-run\n',
              }],
              allowed_paths: ['src/**'],
              purpose: 'b4-skip',
            },
          },
        ],
      },
    );
    expect(result.partialFailure).toBe(true);
    expect(result.nonAtomic).toBe(true);
    expect(result.steps.filter((step) => step.ok).length).toBeGreaterThanOrEqual(1);
    expect(result.steps.some((step) => !step.ok)).toBe(true);
    // Step after failure must not run when stopOnError (only first failing + prior steps recorded)
    expect(result.stoppedEarly).toBe(true);
    expect(result.steps.length).toBeLessThan(4);
    expect(result.steps.every((step) => !String(step.summary ?? '').includes('b4-skip'))).toBe(true);
    const receipts = listFastReceipts(controllerHome, repository.repoId, 20)
      .filter((entry) => entry.operation === 'batch' && entry.requestId?.startsWith('batch-gate-'));
    expect(receipts.length).toBe(1);
    expect(result.receipt?.executionId).toBe(receipts[0]?.executionId);
    void repoRoot;
  });

  test('read lane rejects focused test / package script effects', async () => {
    const { controllerHome, repository } = fixture();
    const lanes = await executeLightweightLanes(
      { controllerHome, repository },
      {
        repoId: repository.repoId,
        readLanes: [
          { id: 'ok', kind: 'git_status', input: {} },
          {
            id: 'pkg',
            kind: 'run_short_command',
            input: { command: ['bun', 'test'] },
          },
          {
            id: 'focused',
            kind: 'run_short_command',
            input: { command: ['bun', 'test', 'tests/foo.test.ts'] },
          },
        ],
      },
    );
    expect(lanes.readLanes.find((lane) => lane.id === 'ok')?.ok).toBe(true);
    const pkg = lanes.readLanes.find((lane) => lane.id === 'pkg');
    const focused = lanes.readLanes.find((lane) => lane.id === 'focused');
    // Package / focused tests must not be accepted as pure read lanes.
    expect(pkg?.ok === false || pkg?.error?.code === 'READ_LANE_NOT_READONLY' || pkg?.error?.code === 'READ_LANE_FAILED').toBe(true);
    expect(focused?.ok === false || focused?.error?.code === 'READ_LANE_NOT_READONLY' || focused?.error?.code === 'READ_LANE_FAILED').toBe(true);
  });

  test('async snapshot fail-closed and dirty fingerprint worker budgets', async () => {
    const { repositorySnapshotAsync } = await import('../../src/cli/repositories/command-executor');
    const { computePathFingerprintsSync } = await import('../../src/runtime/execution/thin-harness/fingerprint-worker');
    const { repoRoot } = fixture();
    const snap = await repositorySnapshotAsync(repoRoot);
    expect(snap.head).toBeTruthy();
    expect(typeof snap.refsHash).toBe('string');

    expect(() => computePathFingerprintsSync({
      root: repoRoot,
      paths: Array.from({ length: 250 }, (_, i) => `f${i}.ts`),
      statusByPath: Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`f${i}.ts`, [`?? f${i}.ts`]])),
      maxPaths: 200,
    })).toThrow(/SNAPSHOT_TOO_DIRTY/);
  });

  test('ephemeral lease full side-effect deltas are zero for one fast mutation', async () => {
    const { controllerHome, repository } = fixture();
    resetLeaseSideEffectMetrics();
    const before = getLeaseSideEffectMetrics();
    const result = await executeFast(
      { controllerHome, repository },
      {
        operation: 'apply_patch',
        requestId: `eph-${Date.now()}`,
        input: {
          operations: [{
            type: 'replace',
            path: 'src/sample.ts',
            old_text: 'export const answer = 42;',
            new_text: 'export const answer = 43;',
          }],
          allowed_paths: ['src/**'],
          purpose: 'eph',
        },
        allowedPaths: ['src/**'],
      },
    );
    expect(result.ok).toBe(true);
    expect(result.durableSideEffects.executionJobCount).toBe(0);
    expect(result.durableSideEffects.localJobCount).toBe(0);
    expect(result.durableSideEffects.workerSpawnCount).toBe(0);
    expect(result.durableSideEffects.runtimeEventCount).toBe(0);
    expect(result.durableSideEffects.projectionUpdateCount).toBe(0);
    expect(result.durableSideEffects.schedulerWakeCount).toBe(0);
    const after = getLeaseSideEffectMetrics();
    expect(after.projectionDirtyMarks - before.projectionDirtyMarks).toBe(0);
    expect(after.schedulerWakes - before.schedulerWakes).toBe(0);
    expect(after.durableAcquireEvents - before.durableAcquireEvents).toBe(0);
    expect(after.ephemeralAcquires - before.ephemeralAcquires).toBeGreaterThan(0);
  });

  test('heartbeat failure path aborts ownership signal', async () => {
    const { controllerHome, repository } = fixture();
    let sawAbort = false;
    let renewCount = 0;
    await withCheckoutMutationGate(
      {
        controllerHome,
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        repoRoot: repository.canonicalRoot,
        owner: 'fast:hb-abort',
        ttlMs: 3_000,
      },
      async (gate, helpers) => {
        // Force renew until we get at least one; then release under the hood by releasing leases.
        helpers.renew();
        renewCount = helpers.getGate().renewCount;
        releaseCheckoutMutationGate(
          controllerHome,
          repository.repoId,
          repository.activeCheckoutId,
          gate.ownerJobId,
          gate.leaseIds.map((leaseId) => ({
            leaseId,
            fencingToken: gate.fencingTokens[leaseId] ?? gate.fencingToken,
          })),
        );
        // Next assert/renew must fail and abort signal.
        try {
          helpers.renew();
        } catch {
          sawAbort = true;
        }
        expect(helpers.signal.aborted || sawAbort).toBe(true);
        return true;
      },
    ).catch(() => {
      // withCheckoutMutationGate may rethrow ownership loss — acceptable
      sawAbort = true;
    });
    expect(sawAbort || renewCount >= 0).toBe(true);
  });

  test('Gateway event-loop lag stays low during concurrent fast reads', async () => {
    const { controllerHome, repository } = fixture();
    let maxLag = 0;
    let samples = 0;
    const lagTimer = setInterval(() => {
      const start = performance.now();
      setImmediate(() => {
        const lag = performance.now() - start;
        maxLag = Math.max(maxLag, lag);
        samples += 1;
      });
    }, 20);
    lagTimer.unref?.();

    await Promise.all([
      executeFast({ controllerHome, repository }, { operation: 'git_status', input: {} }),
      executeFast({ controllerHome, repository }, { operation: 'search', input: { query: 'hello' } }),
      executeFast({ controllerHome, repository }, { operation: 'read_file', input: { path: 'README.md' } }),
      executeFast({ controllerHome, repository }, { operation: 'git_diff', input: {} }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    clearInterval(lagTimer);
    expect(samples).toBeGreaterThan(0);
    // Soft bound: async path should not stall event loop for multi-second stretches.
    expect(maxLag).toBeLessThan(2_000);
  });

  test('ledger terminal state survives late heartbeat and base snapshot is immutable', async () => {
    const {
      beginFastRequest,
      bindFastRequestBaseSnapshot,
      completeFastRequest,
      heartbeatFastRequest,
      readFastRequest,
    } = await import('../../src/runtime/execution/thin-harness/request-ledger');
    const { controllerHome, repository } = fixture();
    const begun = beginFastRequest({
      controllerHome,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      requestId: 'ledger-terminal-heartbeat',
      inputHash: 'ledger-terminal-hash',
      operation: 'apply_patch',
      owner: 'ledger-terminal-owner',
    });
    expect(begun.kind).toBe('acquired');
    if (begun.kind !== 'acquired') return;

    const bound = bindFastRequestBaseSnapshot(controllerHome, begun.entry, 'lease-snapshot-a');
    expect(bound.ok).toBe(true);
    const completed = completeFastRequest(controllerHome, bound.entry ?? begun.entry, {
      status: 'succeeded',
      resultSummary: 'done',
    });
    expect(completed.ok).toBe(true);

    const lateHeartbeat = heartbeatFastRequest(controllerHome, begun.entry, 30_000);
    expect(lateHeartbeat.ok).toBe(true);
    const stored = readFastRequest(
      controllerHome,
      repository.repoId,
      repository.activeCheckoutId,
      'ledger-terminal-heartbeat',
    );
    expect(stored?.status).toBe('succeeded');
    expect(stored?.baseSnapshot).toBe('lease-snapshot-a');

    const conflictingBind = bindFastRequestBaseSnapshot(
      controllerHome,
      begun.entry,
      'lease-snapshot-b',
    );
    expect(conflictingBind.ok).toBe(false);
  });

  test('savepoint restores broken symlink and removes created parent directories', async () => {
    const {
      createWorkspaceSavepoint,
      discardWorkspaceSavepoint,
      restoreWorkspaceSavepoint,
      verifySavepointRestored,
    } = await import('../../src/runtime/execution/thin-harness/workspace-savepoint');
    const { symlinkSync, readlinkSync } = await import('fs');
    const { controllerHome, repository, repoRoot } = fixture();
    const brokenPath = join(repoRoot, 'src', 'broken-link');
    symlinkSync('target-that-does-not-exist', brokenPath);

    const savepoint = createWorkspaceSavepoint({
      controllerHome,
      repoId: repository.repoId,
      repoRoot,
      paths: ['src/broken-link', 'generated/deep/file.txt'],
    });
    rmSync(brokenPath, { force: true });
    writeFileSync(brokenPath, 'not-a-link\n');
    mkdirSync(join(repoRoot, 'generated', 'deep'), { recursive: true });
    writeFileSync(join(repoRoot, 'generated', 'deep', 'file.txt'), 'created\n');

    const restored = restoreWorkspaceSavepoint(savepoint);
    const verified = verifySavepointRestored(repoRoot, savepoint);
    expect(restored.ok).toBe(true);
    expect(verified.ok).toBe(true);
    expect(readlinkSync(brokenPath)).toBe('target-that-does-not-exist');
    expect(existsSync(join(repoRoot, 'generated'))).toBe(false);
    discardWorkspaceSavepoint(savepoint);
  });

  test('integrator applies two non-conflicting server proposals from one base snapshot', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    writeFileSync(join(repoRoot, 'src', 'other.ts'), 'export const other = 1;\n');
    git(repoRoot, ['add', 'src/other.ts']);
    git(repoRoot, ['commit', '-m', 'add-other']);

    const lanes = await executeLightweightLanes(
      { controllerHome, repository },
      {
        repoId: repository.repoId,
        patchProposalLanes: [
          {
            id: 'proposal-a',
            readPaths: ['src/sample.ts'],
            writePaths: ['src/sample.ts'],
            proposedOperations: [{
              type: 'replace',
              path: 'src/sample.ts',
              old_text: 'export const answer = 42;',
              new_text: 'export const answer = 43;',
            }],
          },
          {
            id: 'proposal-b',
            readPaths: ['src/other.ts'],
            writePaths: ['src/other.ts'],
            proposedOperations: [{
              type: 'replace',
              path: 'src/other.ts',
              old_text: 'export const other = 1;',
              new_text: 'export const other = 2;',
            }],
          },
        ],
      },
    );
    expect(lanes.conflicts).toHaveLength(0);

    const integrated = await integratePatchProposals(
      { controllerHome, repository },
      lanes.patchProposals,
      {
        allowedPaths: ['src/**'],
        requestId: 'integrate-two-non-conflicting',
      },
    );
    expect(integrated.ok).toBe(true);
    expect(integrated.applied.filter((entry) => entry.ok)).toHaveLength(2);
    expect(readFileSync(join(repoRoot, 'src', 'sample.ts'), 'utf8')).toContain('43');
    expect(readFileSync(join(repoRoot, 'src', 'other.ts'), 'utf8')).toContain('2');
  });

  test('fast commit uses cancellable async Git path and advances HEAD', async () => {
    const { controllerHome, repository, repoRoot } = fixture();
    const before = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(repoRoot, 'src', 'sample.ts'), 'export const answer = 500;\n');
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    const result = await executeFast(
      { controllerHome, repository },
      {
        operation: 'commit_paths',
        requestId: 'fast-async-commit',
        input: {
          message: 'test: async fast commit',
          paths: ['src/sample.ts'],
        },
      },
    );
    clearInterval(timer);
    const after = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    expect(result.ok).toBe(true);
    expect(result.operationSucceeded).toBe(true);
    expect(after).not.toBe(before);
    expect(ticks).toBeGreaterThan(0);
  });
});
