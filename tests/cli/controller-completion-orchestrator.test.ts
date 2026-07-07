import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createIssue, updateTask } from '../../src/cli/controller/issue-store';
import { finishTaskRun } from '../../src/cli/controller/completion-orchestrator';
import type { AgentJobMeta } from '../../src/cli/agent-jobs/types';

function withRepo<T>(fn: (repoRoot: string) => T): T {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-finish-'));
  try {
    mkdirSync(join(repoRoot, '.ai/harness/jobs'), { recursive: true });
    mkdirSync(join(repoRoot, 'tasks'), { recursive: true });
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 1;\n');
    writeFileSync(join(repoRoot, 'tasks/current.md'), '# Current\n');
    return fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function seedRun(repoRoot: string, meta: Partial<AgentJobMeta> & Pick<AgentJobMeta, 'runId' | 'issueId' | 'taskId'>): AgentJobMeta {
  const { runId, issueId, taskId, ...overrides } = meta;
  const runDir = join(repoRoot, '.ai/harness/jobs', runId);
  mkdirSync(runDir, { recursive: true });
  const now = new Date().toISOString();
  const full: AgentJobMeta = {
    schemaVersion: 3,
    runId,
    issueId,
    taskId,
    agent: overrides.agent ?? 'codex',
    provider: overrides.provider ?? 'local',
    executionMode: overrides.executionMode ?? 'workspace',
    status: overrides.status ?? 'succeeded',
    repoRoot,
    worktree: overrides.worktree ?? repoRoot,
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
  if (full.diffArtifactPath) {
    const artifactPath = join(repoRoot, full.diffArtifactPath);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, JSON.stringify({ runId: full.runId, diff: 'diff --git a/src/example.ts b/src/example.ts' }, null, 2));
  }
  writeFileSync(join(runDir, 'meta.json'), `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

describe('completion orchestrator', () => {
  test('auto-finishes a low/medium workspace run without human review', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Finishable task',
      tasks: [{ title: 'Change code', objective: 'Update a normal source file.', allowedPaths: ['src/**'], risk: 'medium' }],
      allowDuplicate: true,
    });
    updateTask(repoRoot, issue.id, 'T1', { status: 'review', runId: 'RUN-finishable' });
    seedRun(repoRoot, { runId: 'RUN-finishable', issueId: issue.id, taskId: 'T1' });

    const result = finishTaskRun(repoRoot, { runId: 'RUN-finishable' });

    expect(result.action).toBe('finished');
    expect(result.taskStatus).toBe('done');
    expect(result.issue.tasks[0].status).toBe('done');
  }));

  test('keeps high-risk runs behind an explicit approve_and_finish decision', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'High risk task',
      tasks: [{ title: 'Change runtime', objective: 'Refactor high risk runtime code.', allowedPaths: ['src/runtime/**'], risk: 'high' }],
      allowDuplicate: true,
    });
    updateTask(repoRoot, issue.id, 'T1', { status: 'review', runId: 'RUN-high-risk' });
    seedRun(repoRoot, {
      runId: 'RUN-high-risk',
      issueId: issue.id,
      taskId: 'T1',
      diffArtifactPath: '.ai/harness/jobs/RUN-high-risk/worktree-diff.json',
    });

    const automatic = finishTaskRun(repoRoot, { runId: 'RUN-high-risk' });
    expect(automatic.action).toBe('needs_decision');
    expect(automatic.taskStatus).toBe('review');

    const approved = finishTaskRun(repoRoot, {
      runId: 'RUN-high-risk',
      decision: 'approve_and_finish',
      reviewer: 'test-reviewer',
    });
    expect(approved.taskStatus).toBe('done');
  }));
});
