import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createIssue, getIssue, projectBoard, recordTaskVerification, updateTask } from '../../src/cli/controller/issue-store';
import { finishTaskRun } from '../../src/cli/controller/completion-orchestrator';
import { applyCompletionDecision, completionDecisionQueues, finishCompletionBacklog, inspectCompletionBacklog } from '../../src/cli/controller/completion-backlog';
import { prepareCodexContinuation } from '../../src/cli/controller/codex-continuation';
import { applyStuckStateMigration, inspectStuckControllerStates } from '../../src/cli/controller/stuck-state-migration';
import { getAgentJob, markAgentJobReviewedCompletion } from '../../src/cli/agent-jobs/job-manager';
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

  test('keeps Run-backed verification out of done until integration and cleanup evidence exist', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Evidence gated completion',
      tasks: [{ title: 'Change code', objective: 'Update source.', allowedPaths: ['src/**'], risk: 'medium' }],
      allowDuplicate: true,
    });
    updateTask(repoRoot, issue.id, 'T1', { status: 'review', runId: 'RUN-evidence-gate' });
    seedRun(repoRoot, {
      runId: 'RUN-evidence-gate',
      issueId: issue.id,
      taskId: 'T1',
      executionMode: 'worktree',
      worktree: join(repoRoot, '.ai/harness/worktrees/RUN-evidence-gate'),
      branch: 'agent/RUN-evidence-gate',
    });

    const verified = recordTaskVerification(repoRoot, issue.id, 'T1', {
      runId: 'RUN-evidence-gate',
      reviewer: 'test',
      checkResults: [],
      commandEvidence: [{ command: ['true'], ok: true, reportedBy: 'test', source: 'controller' }],
      acceptanceResults: [],
      verifiedAt: new Date().toISOString(),
    });
    expect(verified.tasks[0].status).toBe('verified');

    const closure = markAgentJobReviewedCompletion(repoRoot, 'RUN-evidence-gate');
    expect(closure.closureState).toBe('ready_to_integrate');
    expect(getAgentJob(repoRoot, 'RUN-evidence-gate').status).toBe('waiting_for_user');
    const boardTask = (projectBoard(repoRoot).issues[0].tasks as Array<Record<string, unknown>>)[0];
    expect(boardTask.latestRunClosureState).toBe('ready_to_integrate');
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


describe('completion backlog', () => {
  test('classifies auto-finishable and human-review completion work', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Mixed completion backlog',
      tasks: [
        { title: 'Safe code change', objective: 'Update normal source code.', allowedPaths: ['src/**'], risk: 'medium' },
        { title: 'Risky runtime change', objective: 'Change high risk runtime internals.', allowedPaths: ['src/runtime/**'], risk: 'high' },
      ],
      allowDuplicate: true,
    });
    updateTask(repoRoot, issue.id, 'T1', { status: 'review', runId: 'RUN-auto' });
    updateTask(repoRoot, issue.id, 'T2', { status: 'review', runId: 'RUN-human' });
    seedRun(repoRoot, { runId: 'RUN-auto', issueId: issue.id, taskId: 'T1' });
    seedRun(repoRoot, { runId: 'RUN-human', issueId: issue.id, taskId: 'T2' });

    const report = inspectCompletionBacklog(repoRoot);

    expect(report.counts.auto_finish).toBe(1);
    expect(report.counts.needs_human_review).toBe(1);
    expect(report.finishableRunIds).toEqual(['RUN-auto']);
    expect(report.needsHumanReviewRunIds).toEqual(['RUN-human']);
  }));

  test('batch-finishes only auto-finishable completion work', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Batch finish backlog',
      tasks: [
        { title: 'Safe code change', objective: 'Update normal source code.', allowedPaths: ['src/**'], risk: 'medium' },
        { title: 'Risky runtime change', objective: 'Change high risk runtime internals.', allowedPaths: ['src/runtime/**'], risk: 'high' },
      ],
      allowDuplicate: true,
    });
    updateTask(repoRoot, issue.id, 'T1', { status: 'review', runId: 'RUN-auto-batch' });
    updateTask(repoRoot, issue.id, 'T2', { status: 'review', runId: 'RUN-human-batch' });
    seedRun(repoRoot, { runId: 'RUN-auto-batch', issueId: issue.id, taskId: 'T1' });
    seedRun(repoRoot, { runId: 'RUN-human-batch', issueId: issue.id, taskId: 'T2' });

    const dryRun = finishCompletionBacklog(repoRoot, { dryRun: true });
    expect(dryRun.attempted).toBe(1);
    expect(dryRun.results).toHaveLength(0);

    const applied = finishCompletionBacklog(repoRoot, { dryRun: false });
    expect(applied.attempted).toBe(1);
    expect(applied.finished).toBe(1);

    const after = inspectCompletionBacklog(repoRoot);
    expect(after.counts.auto_finish).toBe(0);
    expect(after.counts.needs_human_review).toBe(1);
  }));
});


describe('completion decision queues and stuck-state migration', () => {
  test('exposes Local Bridge friendly decision queues', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Queue decisions',
      tasks: [
        { title: 'Safe done run', objective: 'Safe code.', allowedPaths: ['src/**'], risk: 'medium' },
        { title: 'Manual high risk', objective: 'Risky code.', allowedPaths: ['src/runtime/**'], risk: 'high' },
      ],
      allowDuplicate: true,
    });
    updateTask(repoRoot, issue.id, 'T1', { status: 'review', runId: 'RUN-q-safe' });
    updateTask(repoRoot, issue.id, 'T2', { status: 'review', runId: 'RUN-q-human' });
    seedRun(repoRoot, { runId: 'RUN-q-safe', issueId: issue.id, taskId: 'T1' });
    seedRun(repoRoot, { runId: 'RUN-q-human', issueId: issue.id, taskId: 'T2' });

    const queues = completionDecisionQueues(repoRoot);

    expect(queues.autoFinish.map((item) => item.runId)).toEqual(['RUN-q-safe']);
    expect(queues.needsHumanReview.map((item) => item.runId)).toEqual(['RUN-q-human']);
  }));

  test('applies explicit completion decisions without requiring direct task status edits', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Apply completion decision',
      tasks: [{ title: 'Safe decision', objective: 'Safe code.', allowedPaths: ['src/**'], risk: 'medium' }],
      allowDuplicate: true,
    });
    updateTask(repoRoot, issue.id, 'T1', { status: 'review', runId: 'RUN-decision' });
    seedRun(repoRoot, { runId: 'RUN-decision', issueId: issue.id, taskId: 'T1' });

    const decision = applyCompletionDecision(repoRoot, { action: 'finish', runId: 'RUN-decision' });

    expect(decision.action).toBe('finish');
    expect('action' in decision.result ? decision.result.action : '').toBe('finished');
  }));

  test('detects and annotates stale review states', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Stale states',
      tasks: [{ title: 'Review without run', objective: 'Stuck state.', allowedPaths: ['src/**'], risk: 'medium' }],
      allowDuplicate: true,
    });
    updateTask(repoRoot, issue.id, 'T1', { status: 'review' });

    const report = inspectStuckControllerStates(repoRoot);
    expect(report.counts.review_without_run).toBe(1);

    const applied = applyStuckStateMigration(repoRoot, { dryRun: false });
    expect(applied.applied).toBe(1);
    const after = getIssue(repoRoot, issue.id);
    expect(after.tasks[0].notes.at(-1)).toContain('review_without_run inspected');
  }));

  test('writes a Codex continuation packet without launching by default', () => withRepo((repoRoot) => {
    const result = prepareCodexContinuation(repoRoot, { objective: 'Continue safely.' });

    expect(result.launched).toBe(false);
    expect(result.packet.objective).toBe('Continue safely.');
    expect(result.promptPath).toContain('.ai/harness/continuations/');
  }));
});
