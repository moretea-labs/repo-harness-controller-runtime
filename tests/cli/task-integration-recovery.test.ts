import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getAgentJob } from '../../src/cli/agent-jobs/job-manager';
import type { AgentJobMeta } from '../../src/cli/agent-jobs/types';
import { finishTaskRun } from '../../src/cli/controller/completion-orchestrator';
import { createIssue, updateTask } from '../../src/cli/controller/issue-store';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function branchExists(repoRoot: string, branch: string): boolean {
  return git(repoRoot, ['branch', '--list', branch]).trim().length > 0;
}

function withRepo<T>(fn: (repoRoot: string, registerCleanupPath: (path: string) => void) => T): T {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-integration-'));
  const extraPaths: string[] = [];
  try {
    mkdirSync(join(repoRoot, '.ai/harness/jobs'), { recursive: true });
    mkdirSync(join(repoRoot, 'tasks'), { recursive: true });
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'tasks/current.md'), '# Current\n');
    writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 1;\n');
    git(repoRoot, ['init', '-q']);
    git(repoRoot, ['config', 'user.name', 'Test User']);
    git(repoRoot, ['config', 'user.email', 'test@example.com']);
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'Initial commit']);
    return fn(repoRoot, (path) => extraPaths.push(path));
  } finally {
    extraPaths.forEach((path) => rmSync(path, { recursive: true, force: true }));
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function seedRun(
  repoRoot: string,
  meta: Partial<AgentJobMeta> & Pick<AgentJobMeta, 'runId' | 'issueId' | 'taskId'>,
): AgentJobMeta {
  const { runId, issueId, taskId, ...overrides } = meta;
  const now = new Date().toISOString();
  const runDir = join(repoRoot, '.ai/harness/jobs', runId);
  mkdirSync(runDir, { recursive: true });
  const full: AgentJobMeta = {
    schemaVersion: 3,
    runId,
    issueId,
    taskId,
    agent: overrides.agent ?? 'codex',
    provider: overrides.provider ?? 'local',
    executionMode: overrides.executionMode ?? 'worktree',
    status: overrides.status ?? 'succeeded',
    repoRoot: overrides.repoRoot ?? realpathSync(repoRoot),
    worktree: overrides.worktree ?? realpathSync(repoRoot),
    branch: overrides.branch ?? null,
    baseRevision: overrides.baseRevision ?? null,
    promptPath: `.ai/harness/jobs/${runId}/prompt.md`,
    stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`,
    stderrPath: `.ai/harness/jobs/${runId}/stderr.log`,
    resultPath: `.ai/harness/jobs/${runId}/result.json`,
    eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`,
    exitCode: overrides.exitCode ?? 0,
    createdAt: overrides.createdAt ?? now,
    startedAt: overrides.startedAt ?? now,
    finishedAt: overrides.finishedAt ?? now,
    ...overrides,
  };
  writeFileSync(join(repoRoot, full.promptPath), 'test prompt\n');
  writeFileSync(join(repoRoot, full.stdoutPath), 'ok\n');
  writeFileSync(join(repoRoot, full.stderrPath), '');
  writeFileSync(join(repoRoot, full.resultPath), JSON.stringify({ ok: true, exitCode: 0, finishedAt: now }, null, 2));
  writeFileSync(join(runDir, 'meta.json'), `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

function prepareWorktreeRun(repoRoot: string, runId: string, registerCleanupPath: (path: string) => void): {
  issueId: string;
  taskId: string;
  worktree: string;
  branch: string;
  baseRevision: string;
} {
  const issue = createIssue(repoRoot, {
    title: `Integration recovery ${runId}`,
    tasks: [{
      title: 'Recover isolated integration',
      objective: 'Recover isolated Task Run integration safely.',
      allowedPaths: ['src/**'],
      risk: 'medium',
    }],
    allowDuplicate: true,
  });
  updateTask(repoRoot, issue.id, 'T1', { status: 'review', runId });
  const branch = `controller/${runId.toLowerCase()}`;
  const baseRevision = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  const worktree = mkdtempSync(join(tmpdir(), `repo-harness-${runId}-wt-`));
  rmSync(worktree, { recursive: true, force: true });
  registerCleanupPath(worktree);
  git(repoRoot, ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
  seedRun(repoRoot, {
    runId,
    issueId: issue.id,
    taskId: 'T1',
    repoRoot: realpathSync(repoRoot),
    worktree: realpathSync(worktree),
    branch,
    baseRevision,
    executionMode: 'worktree',
    status: 'succeeded',
  });
  return { issueId: issue.id, taskId: 'T1', worktree: realpathSync(worktree), branch, baseRevision };
}

describe('task integration recovery', () => {
  test('marks an isolated run as already_integrated, commits selected paths, and cleans the worktree', () => withRepo((repoRoot, registerCleanupPath) => {
    const runId = 'RUN-already-integrated';
    const prepared = prepareWorktreeRun(repoRoot, runId, registerCleanupPath);
    writeFileSync(join(prepared.worktree, 'src/example.ts'), 'export const value = 2;\n');
    git(prepared.worktree, ['add', 'src/example.ts']);
    git(prepared.worktree, ['commit', '-m', 'Worktree change']);

    writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 2;\n');

    const result = finishTaskRun(repoRoot, { runId, commit: true });

    expect(result.action).toBe('finished');
    expect(result.taskStatus).toBe('done');
    expect(result.changeOutcome).toBe('already_integrated');
    expect(result.commitSha).toBeTruthy();
    expect(result.cleaned).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(existsSync(prepared.worktree)).toBe(false);
    expect(branchExists(repoRoot, prepared.branch)).toBe(false);
    expect(result.commitSha).toBeTruthy();
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(result.commitSha!);
    expect(git(repoRoot, ['status', '--porcelain', '--', 'src/example.ts']).trim()).toBe('');

    const meta = getAgentJob(repoRoot, runId);
    expect(meta.changeOutcome).toBe('already_integrated');
    expect(meta.integratedSessionId).toBeTruthy();
    expect(meta.worktreeCleanedAt).toBeTruthy();
  }));

  test('preserves both sides and writes a bounded review packet when main changed concurrently', () => withRepo((repoRoot, registerCleanupPath) => {
    const runId = 'RUN-concurrent-main';
    const prepared = prepareWorktreeRun(repoRoot, runId, registerCleanupPath);
    writeFileSync(join(prepared.worktree, 'src/example.ts'), 'export const value = 2;\n');
    writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 3;\n');

    const result = finishTaskRun(repoRoot, { runId });

    expect(result.action).toBe('blocked');
    expect(result.integrationReviewPath).toBeTruthy();
    expect(result.reason).toContain('review packet');
    expect(readFileSync(join(repoRoot, 'src/example.ts'), 'utf-8')).toBe('export const value = 3;\n');
    expect(readFileSync(join(prepared.worktree, 'src/example.ts'), 'utf-8')).toBe('export const value = 2;\n');
    expect(existsSync(prepared.worktree)).toBe(true);
    expect(branchExists(repoRoot, prepared.branch)).toBe(true);

    const meta = getAgentJob(repoRoot, runId);
    expect(meta.integrationReviewPath).toBe(result.integrationReviewPath);

    const packet = JSON.parse(
      readFileSync(join(repoRoot, result.integrationReviewPath!), 'utf-8'),
    ) as {
      kind: string;
      changedPaths: string[];
      conflicts: Array<{ path: string; reason: string; mergePreview?: string }>;
    };
    expect(packet.kind).toBe('concurrent_main_conflict');
    expect(packet.changedPaths).toContain('src/example.ts');
    expect(packet.conflicts).toHaveLength(1);
    expect(packet.conflicts[0]?.path).toBe('src/example.ts');
    expect(packet.conflicts[0]?.reason).toBe('merge_conflict');
    expect(packet.conflicts[0]?.mergePreview).toContain('<<<<<<<');
  }));
});
