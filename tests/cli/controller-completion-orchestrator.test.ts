import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createIssue, getIssue, projectBoard, recordTaskVerification, updateTask } from '../../src/cli/controller/issue-store';
import { finishEditSession, finishTaskRun } from '../../src/cli/controller/completion-orchestrator';
import { applyCompletionDecision, completionDecisionQueues, finishCompletionBacklog, inspectCompletionBacklog } from '../../src/cli/controller/completion-backlog';
import { prepareCodexContinuation } from '../../src/cli/controller/codex-continuation';
import { applyStuckStateMigration, inspectStuckControllerStates } from '../../src/cli/controller/stuck-state-migration';
import { getAgentJob, markAgentJobReviewedCompletion } from '../../src/cli/agent-jobs/job-manager';
import type { AgentJobMeta } from '../../src/cli/agent-jobs/types';
import { applyEditOperations, beginEditSession } from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../src/cli/mcp/policy';

function withRepo<T>(fn: (repoRoot: string) => T): T {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-finish-'));
  try {
    mkdirSync(join(repoRoot, '.ai/harness/jobs'), { recursive: true });
    mkdirSync(join(repoRoot, 'tasks'), { recursive: true });
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 1;\n');
    writeFileSync(join(repoRoot, 'tasks/current.md'), '# Current\n');
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'Initial commit'], { cwd: repoRoot });
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

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('completion orchestrator', () => {
  test('finishes a Direct Edit Task without any Agent Run evidence', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Direct edit completion',
      tasks: [{ title: 'Patch source', objective: 'Apply a bounded direct edit.', allowedPaths: ['src/**'], risk: 'medium' }],
      allowDuplicate: true,
    });
    const session = beginEditSession(repoRoot, {
      purpose: 'Direct edit task',
      issueId: issue.id,
      taskId: 'T1',
      allowedPaths: ['src/**'],
    });
    const path = join(repoRoot, 'src/example.ts');
    const initial = readFileSync(path, 'utf-8');
    applyEditOperations(repoRoot, getMcpPolicy('controller', { repoRoot }), session.sessionId, [{
      type: 'replace',
      path: 'src/example.ts',
      expectedSha256: sha(initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }]);

    const result = finishEditSession(repoRoot, { sessionId: session.sessionId, reviewer: 'test' });

    expect(result.action).toBe('finished');
    expect(result.taskStatus).toBe('done');
    expect(result.commitSha).toBeTruthy();
    const completedTask = getIssue(repoRoot, issue.id).tasks[0]!;
    expect(completedTask.runIds).toEqual([]);
    expect(completedTask.verification?.runId).toBeUndefined();
    expect(completedTask.verification?.completionReceipt?.source).toBe('direct_edit');
    expect(completedTask.verification?.completionReceipt?.targetRevision).toBe(result.commitSha);
    expect(execFileSync('git', ['status', '--porcelain', '--', 'src/example.ts'], { cwd: repoRoot, encoding: 'utf-8' }).trim()).toBe('');
  }));

  test('does not let unrelated dirty files block Direct Edit completion', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Direct edit with unrelated dirty file',
      tasks: [{ title: 'Patch one source file', objective: 'Only own the edited path.', allowedPaths: ['src/**'], risk: 'medium' }],
      allowDuplicate: true,
    });
    const session = beginEditSession(repoRoot, {
      purpose: 'Direct edit task',
      issueId: issue.id,
      taskId: 'T1',
      allowedPaths: ['src/**'],
    });
    const path = join(repoRoot, 'src/example.ts');
    const initial = readFileSync(path, 'utf-8');
    applyEditOperations(repoRoot, getMcpPolicy('controller', { repoRoot }), session.sessionId, [{
      type: 'replace',
      path: 'src/example.ts',
      expectedSha256: sha(initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 3' }],
    }]);
    writeFileSync(join(repoRoot, 'src/unrelated-user-work.ts'), 'export const userWork = true;\n');

    const result = finishEditSession(repoRoot, { sessionId: session.sessionId, reviewer: 'test' });

    expect(result.action).toBe('finished');
    expect(getIssue(repoRoot, issue.id).tasks[0]?.status).toBe('done');
    expect(execFileSync('git', ['status', '--porcelain', '--', 'src/unrelated-user-work.ts'], { cwd: repoRoot, encoding: 'utf-8' }).trim()).toBe('?? src/unrelated-user-work.ts');
  }));

  test('auto-finishes a low/medium workspace run without human review', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Finishable task',
      tasks: [{ title: 'Change code', objective: 'Update a normal source file.', allowedPaths: ['src/**'], risk: 'medium' }],
      allowDuplicate: true,
    });
    updateTask(repoRoot, issue.id, 'T1', { status: 'review', runId: 'RUN-finishable' });
    seedRun(repoRoot, { runId: 'RUN-finishable', issueId: issue.id, taskId: 'T1' });
    writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 2;\n');

    const result = finishTaskRun(repoRoot, { runId: 'RUN-finishable' });

    expect(result.action).toBe('finished');
    expect(result.taskStatus).toBe('done');
    expect(result.issue.tasks[0].status).toBe('done');
    expect(result.commitSha).toBeTruthy();
    const completedRun = getAgentJob(repoRoot, 'RUN-finishable');
    const completedTask = getIssue(repoRoot, issue.id).tasks[0]!;
    expect(completedRun.status).toBe('succeeded');
    expect(completedRun.cleanupEvidence?.runTerminal).toBe(true);
    expect(completedRun.integrationEvidence?.runId).toBe(completedRun.runId);
    expect(completedRun.cleanupEvidence?.runId).toBe(completedRun.runId);
    expect(completedTask.verification?.runId).toBe(completedRun.runId);
    expect(completedTask.verification?.integrationEvidence?.runId).toBe(completedRun.runId);
    expect(completedTask.verification?.cleanupEvidence?.runId).toBe(completedRun.runId);
    expect(completedTask.verification?.completionReceipt?.source).toBe('workspace_run');
  }));

  test('does not let unrelated dirty files block a workspace Run with owned changed files', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Workspace owned paths',
      tasks: [{ title: 'Change one file', objective: 'Commit only the Run-owned file.', allowedPaths: ['src/**'], risk: 'medium' }],
      allowDuplicate: true,
    });
    updateTask(repoRoot, issue.id, 'T1', { status: 'review', runId: 'RUN-owned-paths' });
    seedRun(repoRoot, {
      runId: 'RUN-owned-paths',
      issueId: issue.id,
      taskId: 'T1',
      changedFiles: ['src/example.ts'],
      changeOutcome: 'changed',
    });
    writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 4;\n');
    writeFileSync(join(repoRoot, 'src/unrelated-user-work.ts'), 'export const userWork = true;\n');

    const result = finishTaskRun(repoRoot, { runId: 'RUN-owned-paths' });

    expect(result.action).toBe('finished');
    expect(getIssue(repoRoot, issue.id).tasks[0]?.status).toBe('done');
    expect(getIssue(repoRoot, issue.id).tasks[0]?.verification?.completionReceipt?.source).toBe('workspace_run');
    expect(execFileSync('git', ['status', '--porcelain', '--', 'src/unrelated-user-work.ts'], { cwd: repoRoot, encoding: 'utf-8' }).trim()).toBe('?? src/unrelated-user-work.ts');
  }));

  test('blocks Direct Edit completion when owned modifications were superseded', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Superseded direct edit',
      tasks: [{ title: 'Patch source', objective: 'Apply one direct edit.', allowedPaths: ['src/**'], risk: 'medium' }],
      allowDuplicate: true,
    });
    const session = beginEditSession(repoRoot, {
      purpose: 'Direct edit task',
      issueId: issue.id,
      taskId: 'T1',
      allowedPaths: ['src/**'],
    });
    const path = join(repoRoot, 'src/example.ts');
    const initial = readFileSync(path, 'utf-8');
    applyEditOperations(repoRoot, getMcpPolicy('controller', { repoRoot }), session.sessionId, [{
      type: 'replace',
      path: 'src/example.ts',
      expectedSha256: sha(initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 5' }],
    }]);
    writeFileSync(path, 'export const value = 6;\n');

    const result = finishEditSession(repoRoot, { sessionId: session.sessionId, reviewer: 'test' });

    expect(result.action).toBe('blocked');
    expect(result.taskStatus).toBe('integration_blocked');
    expect(getIssue(repoRoot, issue.id).tasks[0]?.status).toBe('integration_blocked');
  }));

  test('rejects completion evidence assembled from different Runs', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Cross-run evidence',
      tasks: [{ title: 'Keep evidence scoped', objective: 'Reject mixed evidence.', allowedPaths: ['src/**'], risk: 'medium' }],
      allowDuplicate: true,
    });
    seedRun(repoRoot, { runId: 'RUN-cross-evidence', issueId: issue.id, taskId: 'T1' });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).trim();

    const closure = markAgentJobReviewedCompletion(repoRoot, 'RUN-cross-evidence', {
      integrationEvidence: {
        runId: 'RUN-cross-evidence', kind: 'commit', targetBranch: 'main', targetRevision: head,
        strategy: 'already_integrated', reachable: true, recordedAt: new Date().toISOString(),
      },
      cleanupEvidence: {
        runId: 'RUN-other', worktreeRemovedOrNotCreated: true, branchDeletedOrRetained: true,
        leasesReleased: true, runTerminal: false, editSessionClosedOrNotCreated: true,
        noActiveProcess: true, noDirtyDiff: true, recordedAt: new Date().toISOString(),
      },
    });

    expect(closure.status).toBe('waiting_for_user');
    expect(closure.closureState).toBe('cleanup_blocked');
    expect(closure.preservationDetails).toContain('cleanup evidence is incomplete: runId');
  }));

  test('classifies Run-backed verification without integration evidence as integration blocked', () => withRepo((repoRoot) => {
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
    expect(closure.closureState).toBe('integration_blocked');
    expect(getAgentJob(repoRoot, 'RUN-evidence-gate').status).toBe('waiting_for_user');
    const boardTask = (projectBoard(repoRoot).issues[0].tasks as Array<Record<string, unknown>>)[0];
    expect(boardTask.latestRunClosureState).toBe('integration_blocked');
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
    expect(closure.closureState).toBe('integration_blocked');
    expect(getAgentJob(repoRoot, 'RUN-evidence-gate').status).toBe('waiting_for_user');
    const boardTask = (projectBoard(repoRoot).issues[0].tasks as Array<Record<string, unknown>>)[0];
    expect(boardTask.latestRunClosureState).toBe('integration_blocked');
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

  test('keeps high-risk and destructive Direct Edits behind explicit approval', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Direct edit risk gates',
      tasks: [
        { title: 'High risk edit', objective: 'Change high risk runtime code.', allowedPaths: ['src/**'], risk: 'high' },
        { title: 'Destructive edit', objective: 'Delete all generated state irreversibly.', allowedPaths: ['src/**'], risk: 'destructive' },
      ],
      allowDuplicate: true,
    });
    const session = beginEditSession(repoRoot, {
      purpose: 'High risk direct edit',
      issueId: issue.id,
      taskId: 'T1',
      allowedPaths: ['src/**'],
    });
    const path = join(repoRoot, 'src/example.ts');
    const initial = readFileSync(path, 'utf-8');
    applyEditOperations(repoRoot, getMcpPolicy('controller', { repoRoot }), session.sessionId, [{
      type: 'replace',
      path: 'src/example.ts',
      expectedSha256: sha(initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 7' }],
    }]);

    const automatic = finishEditSession(repoRoot, { sessionId: session.sessionId });
    expect(automatic.action).toBe('needs_decision');
    expect(getIssue(repoRoot, issue.id).tasks[0]?.status).not.toBe('done');

    const destructiveSession = beginEditSession(repoRoot, {
      purpose: 'Destructive direct edit',
      issueId: issue.id,
      taskId: 'T2',
      allowedPaths: ['src/**'],
    });
    const destructiveAutomatic = finishEditSession(repoRoot, { sessionId: destructiveSession.sessionId });
    expect(destructiveAutomatic.action).toBe('needs_decision');
    expect(getIssue(repoRoot, issue.id).tasks[1]?.status).not.toBe('done');
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

  test('reopens legacy done tasks that lack integration and cleanup evidence', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Legacy false completion',
      tasks: [{ title: 'Legacy done', objective: 'Recover honest lifecycle state.', allowedPaths: ['src/**'], risk: 'medium' }],
      allowDuplicate: true,
    });
    updateTask(repoRoot, issue.id, 'T1', { status: 'done', note: 'Legacy completion without closure evidence.' });

    const before = inspectStuckControllerStates(repoRoot);
    expect(before.counts.false_completed).toBe(1);
    const migrated = applyStuckStateMigration(repoRoot, { dryRun: false });
    expect(migrated.errors).toEqual([]);
    expect(getIssue(repoRoot, issue.id).tasks[0]?.status).toBe('integration_blocked');
    expect(getIssue(repoRoot, issue.id).status).toBe('in_progress');
  }));

  test('reconciles legacy done tasks with passing verification and reachable revision', () => withRepo((repoRoot) => {
    const issue = createIssue(repoRoot, {
      title: 'Legacy reachable completion',
      tasks: [{ title: 'Legacy direct completion', objective: 'Recover receipt for already delivered work.', allowedPaths: ['src/**'], risk: 'medium' }],
      allowDuplicate: true,
    });
    writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 9;\n');
    execFileSync('git', ['add', 'src/example.ts'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'Delivered legacy direct edit'], { cwd: repoRoot });
    const deliveredRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).trim();
    updateTask(repoRoot, issue.id, 'T1', {
      status: 'done',
      verification: {
        reviewer: 'legacy',
        checkResults: [],
        commandEvidence: [{ command: ['true'], ok: true, source: 'reported' }],
        acceptanceResults: [],
        integratedRevision: deliveredRevision,
        verifiedAt: new Date().toISOString(),
      },
      note: 'Legacy completion had verification and reachable revision but no Run evidence.',
    });

    const before = inspectStuckControllerStates(repoRoot);
    expect(before.counts.false_completed).toBe(1);
    const migrated = applyStuckStateMigration(repoRoot, { dryRun: false });

    expect(migrated.errors).toEqual([]);
    const task = getIssue(repoRoot, issue.id).tasks[0]!;
    expect(task.status).toBe('done');
    expect(task.verification?.completionReceipt?.targetRevision).toBe(deliveredRevision);
    expect(task.verification?.completionReceipt?.source).toBe('remote_no_change_execution');
    expect(inspectStuckControllerStates(repoRoot).counts.false_completed).toBe(0);
  }));

  test('writes a Codex continuation packet without launching by default', () => withRepo((repoRoot) => {
    const result = prepareCodexContinuation(repoRoot, { objective: 'Continue safely.' });

    expect(result.launched).toBe(false);
    expect(result.packet.objective).toBe('Continue safely.');
    expect(result.promptPath).toContain('.ai/harness/continuations/');
  }));
});
