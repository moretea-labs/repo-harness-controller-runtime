import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getAgentJob, markAgentJobReviewedCompletion } from '../agent-jobs/job-manager';
import type { AgentJobMeta } from '../agent-jobs/types';
import { cleanupIntegratedWorktree, cleanupNoChangeWorktree, integrateAgentJob, taskRunDiff } from '../agent-jobs/integration';
import { getMcpPolicy } from '../mcp/policy';
import { acceptVerifiedTask, getIssue, projectIssueEffectiveView, recordTaskVerification, updateTask } from './issue-store';
import { taskExecutionPolicy } from './execution-policy';
import { runControllerCheck } from './check-runner';
import type { ControllerIssue, ControllerTask, TaskCommandEvidence, TaskVerification } from './types';

export type TaskReviewDecision =
  | 'auto'
  | 'approve_and_finish'
  | 'request_changes'
  | 'discard';

export interface FinishTaskRunOptions {
  runId: string;
  decision?: TaskReviewDecision;
  reviewer?: string;
  note?: string;
  cleanup?: boolean;
  commit?: boolean;
}

export interface FinishTaskRunResult {
  action: 'finished' | 'needs_decision' | 'changes_requested' | 'discarded' | 'already_done' | 'no_change' | 'blocked';
  runId: string;
  issueId: string;
  taskId: string;
  decision: TaskReviewDecision;
  taskStatus: string;
  issue: ReturnType<typeof projectIssueEffectiveView>;
  integrated?: boolean;
  cleaned?: boolean;
  branchDeleted?: boolean;
  changedPaths?: string[];
  reason?: string;
  commitSha?: string;
  commitError?: string;
}


function gitText(repoRoot: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
  return {
    ok: result.status === 0 && !result.error,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : (result.error?.message ?? ''),
  };
}

function safeCommitChangedPaths(repoRoot: string, input: { issueId: string; taskId: string; runId: string; changedPaths?: string[] }): { commitSha?: string; error?: string } {
  const paths = Array.from(new Set((input.changedPaths ?? []).filter(Boolean)));
  if (paths.length === 0) return {};
  const staged = gitText(repoRoot, ['diff', '--cached', '--name-only']);
  if (!staged.ok) return { error: staged.stderr || 'failed to inspect staged changes' };
  if (staged.stdout.trim()) return { error: 'index already has staged changes; refusing to mix completion commit with unrelated staged work' };
  const add = gitText(repoRoot, ['add', '--', ...paths]);
  if (!add.ok) return { error: add.stderr || 'failed to stage changed paths' };
  const commit = gitText(repoRoot, [
    'commit',
    '-m',
    `Complete ${input.issueId}/${input.taskId}`,
    '-m',
    `Run: ${input.runId}`,
  ]);
  if (!commit.ok) {
    gitText(repoRoot, ['reset', '--', ...paths]);
    return { error: commit.stderr || commit.stdout || 'failed to create completion commit' };
  }
  const rev = gitText(repoRoot, ['rev-parse', 'HEAD']);
  return rev.ok ? { commitSha: rev.stdout.trim() } : { error: rev.stderr || 'commit created but HEAD could not be resolved' };
}

function nowIso(): string {
  return new Date().toISOString();
}

function taskForRun(issue: ControllerIssue, taskId: string): ControllerTask {
  const task = issue.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`task not found: ${issue.id}/${taskId}`);
  return task;
}

function commandEvidenceForRun(run: AgentJobMeta): TaskCommandEvidence[] {
  return [{
    command: ['repo-harness', 'agent-run', run.runId],
    cwd: run.executionMode === 'worktree' ? run.worktree : run.repoRoot,
    ok: true,
    exitCode: run.exitCode ?? 0,
    artifactPath: run.resultPath,
    reportedBy: run.agent,
    executedAt: run.finishedAt ?? nowIso(),
    source: 'controller',
  }];
}

function hashArtifact(repoRoot: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const absolute = join(repoRoot, path);
  if (!existsSync(absolute)) return undefined;
  return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

function verificationForRun(repoRoot: string, run: AgentJobMeta, task: ControllerTask, reviewer: string): TaskVerification {
  const policy = taskExecutionPolicy(task);
  const acceptanceResults = task.acceptanceCriteria.map((criterion) => ({
    criterion,
    ok: true,
    evidence: `Accepted from successful Run ${run.runId}${run.integratedSessionId ? ` integrated by ${run.integratedSessionId}` : ''}.`,
  }));
  return {
    runId: run.runId,
    integratedRevision: run.integratedSessionId,
    reviewedDiffHash: hashArtifact(repoRoot, run.diffArtifactPath),
    reviewer,
    checkResults: policy.autoRunDeclaredChecks
      ? task.checks.map((checkId) => {
        try {
          const result = runControllerCheck(repoRoot, checkId);
          return {
            checkId,
            ok: result.ok,
            summary: result.ok
              ? `Passed with persisted evidence: ${result.artifactPath}`
              : `Failed with persisted evidence: ${result.artifactPath}; ${(result.stderr || result.stdout).slice(0, 500)}`,
          };
        } catch (error) {
          return { checkId, ok: false, summary: error instanceof Error ? error.message : String(error) };
        }
      })
      : [],
    commandEvidence: commandEvidenceForRun(run),
    acceptanceResults,
    verifiedAt: nowIso(),
  };
}

function result(repoRoot: string, input: Omit<FinishTaskRunResult, 'issue'>): FinishTaskRunResult {
  const issue = projectIssueEffectiveView(repoRoot, getIssue(repoRoot, input.issueId));
  return { ...input, issue };
}

function canAutoFinish(task: ControllerTask): boolean {
  const policy = taskExecutionPolicy(task);
  return policy.autoCompleteAfterSuccessfulRun && !policy.requiresHumanAcceptance;
}

function verifyAndMaybeAccept(input: {
  repoRoot: string;
  run: AgentJobMeta;
  task: ControllerTask;
  decision: TaskReviewDecision;
  reviewer: string;
  note?: string;
}): { issue: ControllerIssue; taskStatus: string } {
  const { repoRoot, run, task, decision, reviewer } = input;
  const policy = taskExecutionPolicy(task);
  const allowHumanAcceptance = decision === 'approve_and_finish';
  if (policy.requiresHumanAcceptance && !allowHumanAcceptance) {
    updateTask(repoRoot, run.issueId, run.taskId, {
      status: task.status === 'verified' ? 'verified' : task.status,
      note: input.note ?? `Run ${run.runId} is ready but ${policy.executionClass} requires an explicit review decision.`,
    });
    const waiting = getIssue(repoRoot, run.issueId);
    return { issue: waiting, taskStatus: taskForRun(waiting, run.taskId).status };
  }

  const current = getIssue(repoRoot, run.issueId);
  const currentTask = taskForRun(current, run.taskId);
  const verified = currentTask.status === 'verified' || currentTask.status === 'done'
    ? current
    : recordTaskVerification(repoRoot, run.issueId, run.taskId, verificationForRun(repoRoot, run, currentTask, reviewer));
  const verifiedTask = taskForRun(verified, run.taskId);
  if (verifiedTask.status === 'done') return { issue: verified, taskStatus: 'done' };
  if (verifiedTask.status === 'verified' && (allowHumanAcceptance || canAutoFinish(verifiedTask))) {
    const accepted = acceptVerifiedTask(repoRoot, run.issueId, run.taskId, input.note ?? `Accepted by ${reviewer} through completion orchestrator.`);
    return { issue: accepted, taskStatus: taskForRun(accepted, run.taskId).status };
  }
  return { issue: verified, taskStatus: verifiedTask.status };
}

export function finishTaskRun(repoRoot: string, options: FinishTaskRunOptions): FinishTaskRunResult {
  const decision = options.decision ?? 'auto';
  const reviewer = options.reviewer?.trim() || (decision === 'auto' ? 'repo-harness-completion-orchestrator' : 'controller-review');
  const cleanup = options.cleanup !== false;
  const shouldCommit = options.commit === true;
  const run = getAgentJob(repoRoot, options.runId);
  const issue = getIssue(repoRoot, run.issueId);
  const task = taskForRun(issue, run.taskId);
  if (task.status === 'done') {
    return result(repoRoot, {
      action: 'already_done',
      runId: run.runId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: task.status,
    });
  }

  if (decision === 'request_changes') {
    const updated = updateTask(repoRoot, issue.id, task.id, {
      status: 'changes_requested',
      note: options.note ?? `Changes requested for ${run.runId}.`,
    });
    return result(repoRoot, {
      action: 'changes_requested',
      runId: run.runId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: taskForRun(updated, task.id).status,
    });
  }

  if (decision === 'discard') {
    const updated = updateTask(repoRoot, issue.id, task.id, {
      status: 'cancelled',
      note: options.note ?? `Discarded review output from ${run.runId}.`,
    });
    return result(repoRoot, {
      action: 'discarded',
      runId: run.runId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: taskForRun(updated, task.id).status,
    });
  }

  const policy = taskExecutionPolicy(task);
  if (policy.requiresHumanAcceptance && decision !== 'approve_and_finish') {
    return result(repoRoot, {
      action: 'needs_decision',
      runId: run.runId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: task.status,
      reason: `${policy.executionClass} requires approve_and_finish, request_changes, or discard.`,
    });
  }

  if (!['succeeded', 'waiting_for_user'].includes(run.status)) {
    return result(repoRoot, {
      action: 'blocked',
      runId: run.runId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: task.status,
      reason: `Run status ${run.status} is not finishable.`,
    });
  }

  let currentRun: AgentJobMeta = run;
  let integrated = Boolean(run.integratedSessionId) || run.worktree === repoRoot || run.provider === 'github';
  let cleaned = Boolean(run.worktreeCleanedAt);
  let branchDeleted = false;
  let changedPaths = run.changedFiles;
  let commitSha: string | undefined;
  let commitError: string | undefined;

  if (run.provider === 'local' && run.executionMode === 'worktree' && !run.integratedSessionId) {
    const diff = taskRunDiff(repoRoot, run.runId, 1024 * 1024);
    const hasChanges = Boolean(diff.status || diff.diff || diff.untracked.length > 0);
    if (!hasChanges) {
      const cleanupResult = cleanup ? cleanupNoChangeWorktree(repoRoot, run.runId) : { removed: false, branchDeleted: false };
      currentRun = markAgentJobReviewedCompletion(repoRoot, run.runId, {
        changeOutcome: 'no_change',
        changedFiles: [],
        worktreeCleaned: cleanupResult.removed,
      });
      cleaned = cleanupResult.removed;
      branchDeleted = cleanupResult.branchDeleted;
      const final = verifyAndMaybeAccept({ repoRoot, run: currentRun, task, decision, reviewer, note: options.note });
      return result(repoRoot, {
        action: final.taskStatus === 'done' ? 'no_change' : 'needs_decision',
        runId: run.runId,
        issueId: issue.id,
        taskId: task.id,
        decision,
        taskStatus: final.taskStatus,
        integrated: false,
        cleaned,
        branchDeleted,
        changedPaths: [],
      });
    }

    const integratedSession = integrateAgentJob(repoRoot, getMcpPolicy('controller', { repoRoot }), run.runId);
    const cleanupResult = cleanup ? cleanupIntegratedWorktree(repoRoot, run.runId) : { removed: false, branchDeleted: false };
    currentRun = markAgentJobReviewedCompletion(repoRoot, run.runId, {
      changeOutcome: 'changed',
      changedFiles: integratedSession.changedPaths,
      worktreeCleaned: cleanupResult.removed,
    });
    integrated = true;
    cleaned = cleanupResult.removed;
    branchDeleted = cleanupResult.branchDeleted;
    changedPaths = integratedSession.changedPaths;
  }

  if (task.status === 'integrated' || task.status === 'review' || task.status === 'verified' || currentRun.status === 'succeeded') {
    const latestIssue = getIssue(repoRoot, issue.id);
    const latestTask = taskForRun(latestIssue, task.id);
    const final = verifyAndMaybeAccept({ repoRoot, run: currentRun, task: latestTask, decision, reviewer, note: options.note });
    if (shouldCommit && final.taskStatus === 'done' && changedPaths && changedPaths.length > 0) {
      const committed = safeCommitChangedPaths(repoRoot, {
        issueId: issue.id,
        taskId: task.id,
        runId: run.runId,
        changedPaths,
      });
      commitSha = committed.commitSha;
      commitError = committed.error;
    }
    return result(repoRoot, {
      action: final.taskStatus === 'done' ? 'finished' : 'needs_decision',
      runId: run.runId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: final.taskStatus,
      integrated,
      cleaned,
      branchDeleted,
      changedPaths,
      commitSha,
      commitError,
    });
  }

  return result(repoRoot, {
    action: 'blocked',
    runId: run.runId,
    issueId: issue.id,
    taskId: task.id,
    decision,
    taskStatus: task.status,
    reason: `Task status ${task.status} is not finishable.`,
  });
}
