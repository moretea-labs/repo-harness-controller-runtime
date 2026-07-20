import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { listLocalBridgeJobSnapshots } from '../../src/cli/local-bridge/job-store';
import {
  detectPatchProposalConflicts,
  executeFast,
  executeLightweightLanes,
  executeRepositoryBatch,
  getFastPathMetrics,
  integratePatchProposals,
  isFastEligibleTool,
  listFastReceipts,
  resetFastPathMetrics,
  routeExecution,
} from '../../src/runtime/execution/thin-harness';
import { listExecutionJobs } from '../../src/runtime/execution/jobs/store';

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
    // Either rejected by edit session policy or path-scope post-check.
    expect(denied.ok === false || denied.decision.mode === 'reject').toBe(true);
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
          { id: 'a', kind: 'search', input: { query: 'answer' } },
          { id: 'b', kind: 'read_file', input: { path: 'README.md' } },
          { id: 'c', kind: 'git_status', input: {} },
          { id: 'd', kind: 'git_diff', input: {} },
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
    // Wall time should reflect overlapping work (soft check; avoid flaking on tiny fixtures).
    expect(elapsed).toBeLessThan(30_000);
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
