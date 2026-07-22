import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getAgentJob, markAgentJobClosure, markAgentJobReviewedCompletion, recordAgentJobIntegrationEvidence } from '../agent-jobs/job-manager';
import type { AgentJobMeta } from '../agent-jobs/types';
import { cleanupIntegratedWorktree, cleanupNoChangeWorktree, integrateAgentJob, IntegrationReviewRequiredError, taskRunDiff } from '../agent-jobs/integration';
import { finalizeEditSession, getEditSession, revalidateEditSessionOwnership, rollbackEditSession, verifyEditSession } from '../editing/edit-session';
import { getMcpPolicy } from '../mcp/policy';
import { resolveRepoPreferredControllerHome } from '../repositories/controller-home';
import { withControllerLock } from '../repositories/locks';
import { listActiveLeases } from '../../runtime/resources/leases/store';
import { acceptVerifiedTask, getIssue, projectIssueEffectiveView, recordTaskVerification, updateTask } from './issue-store';
import { cleanupEvidenceResourceBlockers, completionEvidenceComplete, taskExecutionPolicy } from './execution-policy';
import { currentCompletionTarget, resolveCompletionTargetBranch } from './completion-target';
import { runControllerCheck } from './check-runner';
import type { CleanupEvidence, ControllerIssue, ControllerTask, IntegrationEvidence, TaskCommandEvidence, TaskVerification } from './types';
import type { CompletionMaintenanceWarning, CompletionReceipt, CompletionReceiptSource, CompletionResourceBlocker } from './types';

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
  changeOutcome?: AgentJobMeta['changeOutcome'];
  integrationReviewPath?: string;
  reason?: string;
  commitSha?: string;
  commitError?: string;
  maintenanceWarnings?: CompletionMaintenanceWarning[];
}

export interface FinishEditSessionOptions {
  sessionId: string;
  decision?: TaskReviewDecision;
  reviewer?: string;
  note?: string;
  commit?: boolean;
  checkIds?: string[];
}

export interface FinishEditSessionResult {
  action: 'finished' | 'needs_decision' | 'changes_requested' | 'discarded' | 'already_done' | 'no_change' | 'blocked';
  sessionId: string;
  issueId: string;
  taskId: string;
  decision: TaskReviewDecision;
  taskStatus: string;
  issue: ReturnType<typeof projectIssueEffectiveView>;
  changedPaths?: string[];
  reason?: string;
  commitSha?: string;
  commitError?: string;
  completionReceipt?: CompletionReceipt;
  maintenanceWarnings?: CompletionMaintenanceWarning[];
}


function gitText(repoRoot: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
  return {
    ok: result.status === 0 && !result.error,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : (result.error?.message ?? ''),
  };
}

function safeCommitChangedPaths(repoRoot: string, input: { issueId: string; taskId: string; sourceLabel: string; sourceId: string; changedPaths?: string[] }): { commitSha?: string; reusedHead?: boolean; error?: string } {
  const paths = Array.from(new Set((input.changedPaths ?? []).filter(Boolean)));
  if (paths.length === 0) return {};
  const staged = gitText(repoRoot, ['diff', '--cached', '--name-only']);
  if (!staged.ok) return { error: staged.stderr || 'failed to inspect staged changes' };
  if (staged.stdout.trim()) return { error: 'index already has staged changes; refusing to mix completion commit with unrelated staged work' };
  const pending = gitText(repoRoot, ['status', '--porcelain', '--', ...paths]);
  if (!pending.ok) return { error: pending.stderr || 'failed to inspect selected-path changes' };
  if (!pending.stdout.trim()) {
    const existing = gitText(repoRoot, ['rev-parse', 'HEAD']);
    return existing.ok
      ? { commitSha: existing.stdout.trim(), reusedHead: true }
      : { error: existing.stderr || 'selected paths are clean but target HEAD could not be resolved' };
  }
  const add = gitText(repoRoot, ['add', '--', ...paths]);
  if (!add.ok) return { error: add.stderr || 'failed to stage changed paths' };
  const commit = gitText(repoRoot, [
    'commit',
    '--only',
    '-m',
    `Complete ${input.issueId}/${input.taskId}`,
    '-m',
    `${input.sourceLabel}: ${input.sourceId}`,
    '--',
    ...paths,
  ]);
  if (!commit.ok) {
    gitText(repoRoot, ['reset', '--', ...paths]);
    const output = `${commit.stderr}\n${commit.stdout}`.trim();
    if (/\bnothing to commit\b/i.test(output)) return {};
    return { error: commit.stderr || commit.stdout || 'failed to create completion commit' };
  }
  const rev = gitText(repoRoot, ['rev-parse', 'HEAD']);
  return rev.ok ? { commitSha: rev.stdout.trim() } : { error: rev.stderr || 'commit created but HEAD could not be resolved' };
}

function latestDirectEditOperations(session: ReturnType<typeof getEditSession>) {
  const latest = new Map<string, (typeof session.operations)[number]>();
  for (const operation of session.operations) latest.set(operation.path, operation);
  return latest;
}

function directEditRevisionMismatches(repoRoot: string, revision: string, session: ReturnType<typeof getEditSession>): string[] {
  const mismatches: string[] = [];
  for (const operation of latestDirectEditOperations(session).values()) {
    const object = `${revision}:${operation.path}`;
    if (operation.type === 'delete') {
      if (gitText(repoRoot, ['cat-file', '-e', object]).ok) mismatches.push(operation.path);
      continue;
    }
    const content = gitText(repoRoot, ['show', object]);
    if (!content.ok || !operation.afterSha256 || createHash('sha256').update(content.stdout).digest('hex') !== operation.afterSha256) {
      mismatches.push(operation.path);
    }
  }
  return mismatches;
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

function verificationForRun(
  repoRoot: string,
  run: AgentJobMeta,
  task: ControllerTask,
  reviewer: string,
  evidence: { integrationEvidence?: IntegrationEvidence; cleanupEvidence?: CleanupEvidence; completionReceipt?: CompletionReceipt; acceptanceConfirmed?: boolean } = {},
): TaskVerification {
  const policy = taskExecutionPolicy(task);
  const acceptanceResults = task.acceptanceCriteria.map((criterion) => evidence.acceptanceConfirmed
    ? {
      criterion,
      ok: true,
      outcome: 'passed' as const,
      source: 'human_review' as const,
      evidence: `Explicitly accepted by ${reviewer} for successful Run ${run.runId}.`,
    }
    : {
      criterion,
      ok: false,
      outcome: 'not_evaluated' as const,
      source: 'run_completion' as const,
      evidence: `Successful Run ${run.runId}${run.integratedSessionId ? ` integrated by ${run.integratedSessionId}` : ''}; acceptance was not independently evaluated.`,
    });
  return {
    runId: run.runId,
    integratedRevision: evidence.integrationEvidence?.targetRevision,
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
    ...evidence,
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
  allowCompletion?: boolean;
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
    : recordTaskVerification(repoRoot, run.issueId, run.taskId, verificationForRun(repoRoot, run, currentTask, reviewer, {
      acceptanceConfirmed: allowHumanAcceptance,
    }));
  const verifiedTask = taskForRun(verified, run.taskId);
  if (verifiedTask.status === 'done') return { issue: verified, taskStatus: 'done' };
  if (input.allowCompletion !== false && verifiedTask.status === 'verified' && (allowHumanAcceptance || canAutoFinish(verifiedTask))) {
    const accepted = acceptVerifiedTask(repoRoot, run.issueId, run.taskId, input.note ?? `Accepted by ${reviewer} through completion orchestrator.`);
    return { issue: accepted, taskStatus: taskForRun(accepted, run.taskId).status };
  }
  return { issue: verified, taskStatus: verifiedTask.status };
}

function editResult(repoRoot: string, input: Omit<FinishEditSessionResult, 'issue'>): FinishEditSessionResult {
  const issue = projectIssueEffectiveView(repoRoot, getIssue(repoRoot, input.issueId));
  return { ...input, issue };
}

function directEditCheckIds(task: ControllerTask, session: ReturnType<typeof getEditSession>, override: readonly string[] | undefined): string[] {
  return Array.from(new Set([
    ...task.checks,
    ...session.requestedChecks,
    ...(override ?? []),
  ].map((entry) => entry.trim()).filter(Boolean)));
}

function directEditChangedPaths(session: ReturnType<typeof getEditSession>): string[] {
  return Array.from(new Set(session.operations.map((operation) => operation.path).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
}

function directEditAcceptanceResults(task: ControllerTask, decision: TaskReviewDecision, reviewer: string): TaskVerification['acceptanceResults'] {
  if (task.acceptanceCriteria.length === 0) return [];
  const accepted = decision === 'approve_and_finish';
  return task.acceptanceCriteria.map((criterion) => ({
    criterion,
    ok: accepted,
    outcome: accepted ? 'passed' as const : 'not_evaluated' as const,
    source: accepted ? 'human_review' as const : 'reported' as const,
    evidence: accepted
      ? `Explicitly accepted by ${reviewer} for direct edit completion.`
      : 'Direct edit checks passed; acceptance was not independently evaluated.',
  }));
}

function finishEditSessionUnlocked(repoRoot: string, options: FinishEditSessionOptions): FinishEditSessionResult {
  const decision = options.decision ?? 'auto';
  const reviewer = options.reviewer?.trim() || (decision === 'auto' ? 'repo-harness-direct-edit-completion' : 'controller-review');
  const shouldCommit = options.commit !== false;
  const initialSession = getEditSession(repoRoot, options.sessionId);
  if (!initialSession.issueId || !initialSession.taskId) {
    throw new Error('Direct Edit completion requires a session bound to an Issue and Task.');
  }

  const issue = getIssue(repoRoot, initialSession.issueId);
  const task = taskForRun(issue, initialSession.taskId);
  if (task.status === 'done') {
    if (!completionEvidenceComplete(task.verification, {
      issueId: issue.id,
      taskId: task.id,
      targetBranch: resolveCompletionTargetBranch(repoRoot),
    })) {
      return editResult(repoRoot, {
        action: 'blocked',
        sessionId: initialSession.sessionId,
        issueId: issue.id,
        taskId: task.id,
        decision,
        taskStatus: task.status,
        reason: 'Task is declared done without a complete delivery receipt; run reconciliation before accepting it.',
      });
    }
    return editResult(repoRoot, {
      action: 'already_done',
      sessionId: initialSession.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: task.status,
    });
  }

  if (decision === 'request_changes') {
    const updated = updateTask(repoRoot, issue.id, task.id, {
      status: 'changes_requested',
      note: options.note ?? `Changes requested for direct edit ${initialSession.sessionId}.`,
    });
    return editResult(repoRoot, {
      action: 'changes_requested',
      sessionId: initialSession.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: taskForRun(updated, task.id).status,
    });
  }

  if (decision === 'discard') {
    let discardSession = revalidateEditSessionOwnership(repoRoot, initialSession.sessionId, {
      reviewer,
      note: options.note ?? `Validated direct edit before discard for ${issue.id}/${task.id}.`,
    });
    const discardPaths = directEditChangedPaths(discardSession);
    if (discardSession.status === 'superseded') {
      const updated = updateTask(repoRoot, issue.id, task.id, {
        status: 'integration_blocked',
        note: `Cannot discard superseded direct edit ${discardSession.sessionId}; newer changes are preserved.`,
      });
      return editResult(repoRoot, {
        action: 'blocked', sessionId: discardSession.sessionId, issueId: issue.id, taskId: task.id, decision,
        taskStatus: taskForRun(updated, task.id).status, changedPaths: discardPaths,
        reason: 'Direct Edit was superseded and cannot be safely rolled back.',
      });
    }
    if (discardPaths.length > 0) {
      const stagedOwned = gitText(repoRoot, ['diff', '--cached', '--name-only', '--', ...discardPaths]);
      if (!stagedOwned.ok || stagedOwned.stdout.trim()) {
        return editResult(repoRoot, {
          action: 'blocked', sessionId: discardSession.sessionId, issueId: issue.id, taskId: task.id, decision,
          taskStatus: task.status, changedPaths: discardPaths,
          reason: stagedOwned.ok
            ? `Direct Edit discard requires owned paths to be unstaged first: ${stagedOwned.stdout.trim().split('\n').join(', ')}`
            : stagedOwned.stderr || 'Unable to inspect staged Direct Edit paths before discard.',
        });
      }
    }
    if (discardSession.status === 'finalized') {
      const dirtyPaths = new Set(workspaceChangesForPaths(repoRoot, discardPaths));
      const cleanOwnedPaths = discardPaths.filter((path) => !dirtyPaths.has(path));
      if (cleanOwnedPaths.length > 0) {
        return editResult(repoRoot, {
          action: 'blocked', sessionId: discardSession.sessionId, issueId: issue.id, taskId: task.id, decision,
          taskStatus: task.status, changedPaths: discardPaths,
          reason: `Finalized Direct Edit has clean or integrated owned paths and requires an explicit revert: ${cleanOwnedPaths.join(', ')}`,
        });
      }
      discardSession = rollbackEditSession(repoRoot, discardSession.sessionId, { allowFinalized: true });
    } else if (discardSession.status !== 'rolled_back') {
      discardSession = rollbackEditSession(repoRoot, discardSession.sessionId);
    }
    const retained = ownedWorkspaceChanges(repoRoot, discardPaths, discardSession.allowedPaths);
    if (discardSession.status !== 'rolled_back' || retained.length > 0) {
      return editResult(repoRoot, {
        action: 'blocked', sessionId: discardSession.sessionId, issueId: issue.id, taskId: task.id, decision,
        taskStatus: task.status, changedPaths: discardPaths,
        reason: retained.length > 0
          ? `Direct Edit discard retained owned changes: ${retained.join(', ')}`
          : `Direct Edit discard did not close the session (current: ${discardSession.status}).`,
      });
    }
    const updated = updateTask(repoRoot, issue.id, task.id, {
      status: 'cancelled',
      note: options.note ?? `Discarded and rolled back direct edit ${initialSession.sessionId}.`,
    });
    return editResult(repoRoot, {
      action: 'discarded',
      sessionId: discardSession.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: taskForRun(updated, task.id).status,
      changedPaths: discardPaths,
      reason: 'Direct edit was rolled back and discarded.',
    });
  }

  const policy = taskExecutionPolicy(task);
  if (policy.requiresHumanAcceptance && decision !== 'approve_and_finish') {
    return editResult(repoRoot, {
      action: 'needs_decision',
      sessionId: initialSession.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: task.status,
      reason: `${policy.executionClass} requires approve_and_finish, request_changes, or discard.`,
    });
  }

  const completionTarget = currentCompletionTarget(repoRoot);
  if (!completionTarget.onTargetBranch) {
    return editResult(repoRoot, {
      action: 'blocked', sessionId: initialSession.sessionId, issueId: issue.id, taskId: task.id, decision,
      taskStatus: task.status,
      reason: `Direct Edit completion must run on integration target ${completionTarget.expectedBranch}; current branch is ${completionTarget.branch}.`,
    });
  }

  const checkIds = directEditCheckIds(task, initialSession, options.checkIds);
  let session = revalidateEditSessionOwnership(repoRoot, initialSession.sessionId, {
    reviewer,
    note: options.note ?? `Revalidated direct edit ownership before Task completion for ${issue.id}/${task.id}.`,
  });
  let standaloneCheckResults: TaskVerification['checkResults'] = [];
  if (!['finalized', 'superseded', 'rolled_back'].includes(session.status)) {
    const emptyOpenSession = session.status === 'open' && session.operations.length === 0;
    if (emptyOpenSession) {
      standaloneCheckResults = checkIds.map((checkId) => {
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
      });
      if (standaloneCheckResults.some((result) => !result.ok)) {
        const failedVerification: TaskVerification = {
          reviewer,
          checkResults: standaloneCheckResults,
          commandEvidence: [{
            command: ['repo-harness', 'controller', 'finish-edit', session.sessionId],
            cwd: repoRoot,
            ok: false,
            reportedBy: reviewer,
            executedAt: nowIso(),
            source: 'controller',
          }],
          acceptanceResults: directEditAcceptanceResults(task, decision, reviewer),
          reviewedDiffHash: session.diffSha256,
          verifiedAt: nowIso(),
        };
        const updated = recordTaskVerification(repoRoot, issue.id, task.id, failedVerification);
        return editResult(repoRoot, {
          action: 'changes_requested',
          sessionId: session.sessionId,
          issueId: issue.id,
          taskId: task.id,
          decision,
          taskStatus: taskForRun(updated, task.id).status,
          changedPaths: [],
          reason: 'Direct Edit checks failed.',
        });
      }
    } else {
      const missingPassedCheck = checkIds.some((checkId) => !session.checkResults.some((result) => result.checkId === checkId && result.ok));
      if (session.status !== 'checked' || missingPassedCheck) {
        try {
          session = verifyEditSession(repoRoot, session.sessionId, {
            checkIds,
            reviewer,
            note: options.note,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes('edited file changed outside the session')) throw error;
          session = finalizeEditSession(repoRoot, session.sessionId, {
            reviewer,
            note: options.note ?? `Closed superseded direct edit before Task completion for ${issue.id}/${task.id}.`,
          });
        }
        if (session.checkResults.some((result) => !result.ok)) {
          const failedVerification: TaskVerification = {
            reviewer,
            checkResults: session.checkResults.map((result) => ({
              checkId: result.checkId,
              ok: result.ok,
              summary: result.summary,
            })),
            commandEvidence: [{
              command: ['repo-harness', 'controller', 'finish-edit', session.sessionId],
              cwd: repoRoot,
              ok: false,
              reportedBy: reviewer,
              executedAt: nowIso(),
              source: 'controller',
            }],
            acceptanceResults: directEditAcceptanceResults(task, decision, reviewer),
            reviewedDiffHash: session.diffSha256,
            verifiedAt: nowIso(),
          };
          const updated = recordTaskVerification(repoRoot, issue.id, task.id, failedVerification);
          return editResult(repoRoot, {
            action: 'changes_requested',
            sessionId: session.sessionId,
            issueId: issue.id,
            taskId: task.id,
            decision,
            taskStatus: taskForRun(updated, task.id).status,
            changedPaths: directEditChangedPaths(session),
            reason: 'Direct Edit checks failed.',
          });
        }
      }
    }
    if (session.status !== 'superseded') {
      session = finalizeEditSession(repoRoot, session.sessionId, {
        reviewer,
        note: options.note ?? `Finalized direct edit before Task completion for ${issue.id}/${task.id}.`,
      });
    }
  }

  if (session.status === 'rolled_back') {
    return editResult(repoRoot, {
      action: 'blocked',
      sessionId: session.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: task.status,
      reason: 'Direct Edit session was rolled back and has no deliverable change.',
    });
  }
  if (session.status === 'superseded') {
    updateTask(repoRoot, issue.id, task.id, {
      status: 'integration_blocked',
      note: `Direct Edit session ${session.sessionId} was superseded by newer workspace changes in ${(session.supersededPaths ?? []).join(', ') || 'owned paths'}.`,
    });
    return editResult(repoRoot, {
      action: 'blocked',
      sessionId: session.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: 'integration_blocked',
      changedPaths: directEditChangedPaths(session),
      reason: 'Direct Edit session was superseded before completion.',
    });
  }
  if (session.status !== 'finalized') {
    return editResult(repoRoot, {
      action: 'blocked',
      sessionId: session.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: task.status,
      reason: `Direct Edit session is not finalized (current: ${session.status}).`,
    });
  }

  const changedPaths = directEditChangedPaths(session);
  let commitSha: string | undefined;
  let commitError: string | undefined;
  let reusedHead = false;
  if (changedPaths.length > 0) {
    if (!shouldCommit) {
      return editResult(repoRoot, {
        action: 'blocked',
        sessionId: session.sessionId,
        issueId: issue.id,
        taskId: task.id,
        decision,
        taskStatus: task.status,
        changedPaths,
        reason: 'Direct Edit changed paths require a target-branch commit before Task completion.',
      });
    }
    const committed = safeCommitChangedPaths(repoRoot, {
      issueId: issue.id,
      taskId: task.id,
      sourceLabel: 'Direct Edit',
      sourceId: session.sessionId,
      changedPaths,
    });
    commitSha = committed.commitSha;
    reusedHead = committed.reusedHead === true;
    commitError = committed.error;
    if (commitError || !commitSha) {
      return editResult(repoRoot, {
        action: 'blocked',
        sessionId: session.sessionId,
        issueId: issue.id,
        taskId: task.id,
        decision,
        taskStatus: task.status,
        changedPaths,
        commitError: commitError ?? 'direct edit changes did not produce a target-branch commit',
        reason: commitError ?? 'direct edit changes did not produce a target-branch commit',
      });
    }
  }

  const after = currentCompletionTarget(repoRoot);
  if (!after.onTargetBranch) {
    return editResult(repoRoot, {
      action: 'blocked', sessionId: session.sessionId, issueId: issue.id, taskId: task.id, decision,
      taskStatus: task.status, changedPaths, commitSha,
      reason: `Integration target changed during completion; expected ${after.expectedBranch}, current ${after.branch}.`,
    });
  }
  const targetRevision = commitSha ?? after.revision;
  const revisionMismatches = directEditRevisionMismatches(repoRoot, targetRevision, session);
  if (revisionMismatches.length > 0) {
    const reason = `Target revision ${targetRevision} does not contain finalized Direct Edit content for: ${revisionMismatches.join(', ')}`;
    updateTask(repoRoot, issue.id, task.id, { status: 'integration_blocked', note: reason });
    return editResult(repoRoot, {
      action: 'blocked', sessionId: session.sessionId, issueId: issue.id, taskId: task.id, decision,
      taskStatus: 'integration_blocked', changedPaths, commitSha, reason,
    });
  }
  const integrationEvidence = {
    kind: commitSha ? 'commit' as const : 'no_change' as const,
    targetBranch: after.branch,
    targetRevision,
    sourceRevision: targetRevision,
    baseRevision: session.baseRevision,
    strategy: commitSha && !reusedHead ? 'edit_session_commit' as const : changedPaths.length === 0 ? 'no_change' as const : 'already_integrated' as const,
    editSessionId: session.sessionId,
    reachable: revisionReachable(repoRoot, targetRevision, after.branch),
    recordedAt: nowIso(),
  };
  const dirtyOwnedPaths = ownedWorkspaceChanges(repoRoot, changedPaths, session.allowedPaths);
  const cleanupBlockers = dirtyOwnedPaths.length > 0
    ? [blocker('dirty_owned_paths', `Direct Edit owned paths still have uncommitted changes: ${dirtyOwnedPaths.join(', ')}`, 'workspace')]
    : [];
  const completionReceipt = buildCompletionReceipt({
    source: 'direct_edit',
    issueId: issue.id,
    taskId: task.id,
    editSessionId: session.sessionId,
    integrationEvidence,
    changedPaths,
    cleanupBlockers,
  });
  if (completionReceipt.cleanup.status === 'blocked') {
    updateTask(repoRoot, issue.id, task.id, {
      status: 'cleanup_blocked',
      note: completionReceipt.cleanup.blockers.map((entry) => entry.message).join(' '),
    });
    return editResult(repoRoot, {
      action: 'blocked',
      sessionId: session.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: 'cleanup_blocked',
      changedPaths,
      completionReceipt,
      reason: completionReceipt.cleanup.blockers.map((entry) => entry.message).join(' '),
      commitSha,
    });
  }

  const verification: TaskVerification = {
    reviewer,
    checkResults: (session.checkResults.length > 0 ? session.checkResults : standaloneCheckResults).map((result) => ({
      checkId: result.checkId,
      ok: result.ok,
      summary: result.summary,
    })),
    commandEvidence: [{
      command: ['repo-harness', 'controller', 'finish-edit', session.sessionId],
      cwd: repoRoot,
      ok: true,
      reportedBy: reviewer,
      executedAt: nowIso(),
      source: 'controller',
    }],
    acceptanceResults: directEditAcceptanceResults(task, decision, reviewer),
    reviewedDiffHash: session.diffSha256,
    integratedRevision: targetRevision,
    completionReceipt,
    verifiedAt: nowIso(),
  };
  const verified = recordTaskVerification(repoRoot, issue.id, task.id, verification);
  const verifiedTask = taskForRun(verified, task.id);
  if (verifiedTask.status === 'changes_requested') {
    return editResult(repoRoot, {
      action: 'changes_requested',
      sessionId: session.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: verifiedTask.status,
      changedPaths,
      completionReceipt,
      commitSha,
    });
  }
  if (verifiedTask.status !== 'verified') {
    return editResult(repoRoot, {
      action: 'needs_decision',
      sessionId: session.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: verifiedTask.status,
      changedPaths,
      completionReceipt,
      commitSha,
      reason: 'Direct Edit verification is incomplete.',
    });
  }
  const accepted = (decision === 'approve_and_finish' || canAutoFinish(verifiedTask))
    ? acceptVerifiedTask(repoRoot, issue.id, task.id, options.note ?? `Accepted direct edit receipt ${completionReceipt.receiptId}.`)
    : verified;
  const finalStatus = taskForRun(accepted, task.id).status;
  return editResult(repoRoot, {
    action: finalStatus === 'done' ? (changedPaths.length === 0 ? 'no_change' : 'finished') : 'needs_decision',
    sessionId: session.sessionId,
    issueId: issue.id,
    taskId: task.id,
    decision,
    taskStatus: finalStatus,
    changedPaths,
    commitSha,
    completionReceipt,
  });
}

function currentTarget(repoRoot: string): { branch: string; revision: string } {
  const branch = gitText(repoRoot, ['branch', '--show-current']);
  const revision = gitText(repoRoot, ['rev-parse', 'HEAD']);
  if (!branch.ok || !branch.stdout.trim()) throw new Error(branch.stderr || 'integration target must be an attached branch');
  if (!revision.ok || !revision.stdout.trim()) throw new Error(revision.stderr || 'integration target revision is unavailable');
  return { branch: branch.stdout.trim(), revision: revision.stdout.trim() };
}

function revisionReachable(repoRoot: string, revision: string, branch: string): boolean {
  return gitText(repoRoot, ['merge-base', '--is-ancestor', revision, branch]).ok;
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (_error) { return false; }
}

function runLeasesReleased(repoRoot: string, run: AgentJobMeta): boolean {
  if (!run.repoId) return true;
  try {
    const owners = new Set([run.runId, run.requestId].filter((value): value is string => Boolean(value)));
    return listActiveLeases(resolveRepoPreferredControllerHome(repoRoot), run.repoId)
      .every((lease) => !owners.has(lease.ownerJobId));
  } catch (_error) {
    return false;
  }
}

function scopedWorkspaceChanges(repoRoot: string, allowedPaths: string[]): string[] {
  const status = gitText(repoRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (!status.ok) return [];
  const prefixes = allowedPaths.map((path) => path.replace(/\\/g, '/').split(/[?*{\[]/, 1)[0].replace(/\/+$/, ''));
  return Array.from(new Set(status.stdout.split('\n').flatMap((line) => {
    const path = line.length >= 4 ? line.slice(3).trim().replace(/^"|"$/g, '') : '';
    if (!path || !prefixes.some((prefix) => prefix && (path === prefix || path.startsWith(`${prefix}/`)))) return [];
    return [path];
  })));
}

function workspaceChangesForPaths(repoRoot: string, paths: readonly string[]): string[] {
  const selected = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
  if (selected.length === 0) return [];
  const status = gitText(repoRoot, ['status', '--porcelain', '--untracked-files=all', '--', ...selected]);
  if (!status.ok) return [];
  return Array.from(new Set(status.stdout.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    const raw = line.length >= 4 ? line.slice(3).trim().replace(/^"|"$/g, '') : '';
    if (!raw) return [];
    const renamed = raw.includes(' -> ') ? raw.split(' -> ').at(-1)?.trim() : raw;
    return renamed ? [renamed] : [];
  })));
}

function ownedWorkspaceChanges(repoRoot: string, ownedPaths: readonly string[], fallbackAllowedPaths: readonly string[] = []): string[] {
  if (ownedPaths.length > 0) return workspaceChangesForPaths(repoRoot, ownedPaths);
  return scopedWorkspaceChanges(repoRoot, [...fallbackAllowedPaths]);
}

function receiptId(source: CompletionReceiptSource, ownerId: string, targetRevision: string): string {
  return `REC-${source}-${createHash('sha256').update(`${source}\0${ownerId}\0${targetRevision}`).digest('hex').slice(0, 16)}`;
}

function receiptSourceForRun(run: AgentJobMeta, changeOutcome: AgentJobMeta['changeOutcome'] | undefined): CompletionReceiptSource {
  if (run.provider !== 'local' || changeOutcome === 'no_change') return 'remote_no_change_execution';
  return run.executionMode === 'worktree' ? 'isolated_agent_run' : 'workspace_run';
}

function cleanupStatus(warnings: readonly CompletionMaintenanceWarning[], blockers: readonly CompletionResourceBlocker[]): CompletionReceipt['cleanup']['status'] {
  if (blockers.length > 0) return 'blocked';
  return warnings.length > 0 ? 'maintenance_warning' : 'complete';
}

function maintenanceWarningFromCleanup(run: AgentJobMeta, message: string | undefined, at = nowIso()): CompletionMaintenanceWarning {
  const mentionsBranch = Boolean(run.branch && message?.includes(run.branch));
  return {
    code: mentionsBranch ? 'branch_cleanup_failed' : 'worktree_cleanup_failed',
    message: message?.trim() || 'Verified resource cleanup failed; retained for maintenance.',
    resourceKind: mentionsBranch ? 'branch' : 'worktree',
    resourceId: mentionsBranch ? run.branch ?? undefined : run.worktree,
    recordedAt: at,
  };
}

function blocker(code: CompletionResourceBlocker['code'], message: string, resourceKind?: CompletionResourceBlocker['resourceKind'], resourceId?: string, at = nowIso()): CompletionResourceBlocker {
  return { code, message, resourceKind, resourceId, recordedAt: at };
}

function cleanupBlockersForEvidence(cleanup: CleanupEvidence): CompletionResourceBlocker[] {
  return cleanupEvidenceResourceBlockers(cleanup, { includeRunTerminal: false });
}

function buildCompletionReceipt(input: {
  source: CompletionReceiptSource;
  issueId: string;
  taskId: string;
  runId?: string;
  editSessionId?: string;
  integrationEvidence: Omit<IntegrationEvidence, 'runId'> & { runId?: string };
  changedPaths: readonly string[];
  cleanupWarnings?: CompletionMaintenanceWarning[];
  cleanupBlockers?: CompletionResourceBlocker[];
  verifiedAt?: string;
}): CompletionReceipt {
  const warnings = [...(input.cleanupWarnings ?? [])];
  const blockers = [
    ...(input.cleanupBlockers ?? []),
    ...(input.integrationEvidence.reachable ? [] : [blocker('target_revision_unreachable', `Target revision ${input.integrationEvidence.targetRevision} is not reachable from ${input.integrationEvidence.targetBranch}.`, 'workspace')]),
  ];
  const recordedAt = nowIso();
  return {
    schemaVersion: 1,
    receiptId: receiptId(input.source, input.runId ?? input.editSessionId ?? `${input.issueId}/${input.taskId}`, input.integrationEvidence.targetRevision),
    source: input.source,
    issueId: input.issueId,
    taskId: input.taskId,
    runId: input.runId,
    editSessionId: input.editSessionId,
    targetBranch: input.integrationEvidence.targetBranch,
    targetRevision: input.integrationEvidence.targetRevision,
    sourceRevision: input.integrationEvidence.sourceRevision,
    baseRevision: input.integrationEvidence.baseRevision,
    changedPaths: Array.from(new Set(input.changedPaths)).sort((left, right) => left.localeCompare(right)),
    delivery: {
      kind: input.integrationEvidence.kind,
      status: blockers.some((entry) => entry.code === 'target_revision_unreachable') ? 'blocked' : 'integrated',
      strategy: input.integrationEvidence.strategy === 'already_integrated' ? 'already_integrated'
        : input.integrationEvidence.strategy === 'no_change' ? 'no_change'
          : input.source === 'remote_no_change_execution' && input.integrationEvidence.strategy !== 'edit_session_commit' ? 'remote'
            : 'edit_session_commit',
      reachable: input.integrationEvidence.reachable,
      recordedAt: input.integrationEvidence.recordedAt,
    },
    cleanup: {
      status: cleanupStatus(warnings, blockers),
      warnings,
      blockers,
      recordedAt,
    },
    verifiedAt: input.verifiedAt ?? recordedAt,
    recordedAt,
  };
}

function buildCleanupEvidence(input: {
  run: AgentJobMeta;
  worktreeRemovedOrNotCreated: boolean;
  branchDeletedOrRetained: boolean;
  editSessionClosedOrNotCreated: boolean;
  noDirtyDiff: boolean;
  maintenanceWarnings?: CompletionMaintenanceWarning[];
}): CleanupEvidence {
  const evidence: CleanupEvidence = {
    runId: input.run.runId,
    worktreeRemovedOrNotCreated: input.worktreeRemovedOrNotCreated,
    branchDeletedOrRetained: input.branchDeletedOrRetained,
    leasesReleased: runLeasesReleased(input.run.repoRoot, input.run),
    // markAgentJobReviewedCompletion flips this to true in the same atomic
    // metadata write that makes the Run terminal.
    runTerminal: false,
    editSessionClosedOrNotCreated: input.editSessionClosedOrNotCreated,
    noActiveProcess: !processAlive(input.run.agentPid),
    noDirtyDiff: input.noDirtyDiff,
    maintenanceWarnings: input.maintenanceWarnings ?? [],
    recordedAt: nowIso(),
  };
  evidence.resourceBlockers = cleanupBlockersForEvidence(evidence);
  return evidence;
}

function persistVerification(
  repoRoot: string,
  run: AgentJobMeta,
  reviewer: string,
  evidence: { integrationEvidence?: IntegrationEvidence; cleanupEvidence?: CleanupEvidence; completionReceipt?: CompletionReceipt } = {},
): { issue: ControllerIssue; task: ControllerTask } {
  const issue = getIssue(repoRoot, run.issueId);
  const task = taskForRun(issue, run.taskId);
  const updated = recordTaskVerification(
    repoRoot,
    issue.id,
    task.id,
    verificationForRun(repoRoot, run, task, reviewer, evidence),
    { completingRunId: run.runId },
  );
  return { issue: updated, task: taskForRun(updated, task.id) };
}

function finishTaskRunUnlocked(repoRoot: string, options: FinishTaskRunOptions): FinishTaskRunResult {
  const decision = options.decision ?? 'auto';
  const reviewer = options.reviewer?.trim() || (decision === 'auto' ? 'repo-harness-completion-orchestrator' : 'controller-review');
  const cleanup = options.cleanup !== false;
  const shouldCommit = options.commit !== false;
  const run = getAgentJob(repoRoot, options.runId);
  const issue = getIssue(repoRoot, run.issueId);
  const task = taskForRun(issue, run.taskId);
  if (task.status === 'done') {
    if (!completionEvidenceComplete(task.verification, {
      issueId: issue.id,
      taskId: task.id,
      targetBranch: resolveCompletionTargetBranch(repoRoot),
    })) {
      return result(repoRoot, {
        action: 'blocked', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
        taskStatus: task.status, reason: 'Task is declared done without a complete delivery receipt; run lifecycle migration before accepting it.',
      });
    }
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

  const ownedAutoFinalization = run.status === 'running'
    && run.autoIntegrate === true
    && run.executionMode === 'worktree'
    && (run.progress?.phase === 'finalizing' || run.closureState === 'ready_to_integrate');
  if (!['succeeded', 'waiting_for_user'].includes(run.status) && !ownedAutoFinalization) {
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
  let integrated = Boolean(run.integrationEvidence?.reachable) || run.worktree === repoRoot || run.provider === 'github';
  let cleaned = Boolean(run.worktreeCleanedAt);
  let branchDeleted = false;
  let changedPaths = run.changedFiles;
  let changeOutcome = run.changeOutcome;
  let commitSha: string | undefined;
  let commitError: string | undefined;
  let reusedHead = false;

  const completionTarget = currentCompletionTarget(repoRoot);
  if (!completionTarget.onTargetBranch) {
    return result(repoRoot, {
      action: 'blocked', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
      taskStatus: task.status,
      reason: `Run completion must execute on integration target ${completionTarget.expectedBranch}; current branch is ${completionTarget.branch}.`,
    });
  }
  const target = { branch: completionTarget.branch, revision: completionTarget.revision };

  if (run.provider === 'local' && run.executionMode === 'workspace' && !changedPaths) {
    changedPaths = scopedWorkspaceChanges(repoRoot, task.allowedPaths);
    changeOutcome = changedPaths.length > 0 ? 'changed' : 'no_change';
  }

  updateTask(repoRoot, issue.id, task.id, {
    status: 'verifying',
    runId: run.runId,
    transition: 'run_sync',
    note: `Run ${run.runId} entered completion verification before integration.`,
  });

  if (run.provider === 'local' && run.executionMode === 'worktree' && !run.integratedSessionId) {
    const diff = taskRunDiff(repoRoot, run.runId, 1024 * 1024);
    const hasChanges = Boolean(diff.status || diff.diff || diff.untracked.length > 0);
    if (!hasChanges) {
      const preflight = persistVerification(repoRoot, run, reviewer);
      if (preflight.task.status === 'changes_requested') {
        return result(repoRoot, {
          action: 'changes_requested', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
          taskStatus: preflight.task.status, changedPaths: [], changeOutcome: 'no_change',
        });
      }
      updateTask(repoRoot, issue.id, task.id, {
        status: 'ready_to_integrate',
        note: `Run ${run.runId} has no repository changes; recording explicit no-change integration evidence.`,
      });
      const noChangeIntegration: IntegrationEvidence = {
        runId: run.runId, kind: 'no_change', targetBranch: target.branch, targetRevision: target.revision,
        sourceRevision: run.baseRevision ?? undefined, baseRevision: run.baseRevision ?? undefined,
        strategy: 'no_change', reachable: revisionReachable(repoRoot, target.revision, target.branch), recordedAt: nowIso(),
      };
      if (!noChangeIntegration.reachable) {
        const reason = `No-change target revision ${target.revision} is not reachable from ${target.branch}.`;
        markAgentJobClosure(repoRoot, run.runId, { state: 'integration_blocked', preservationReason: 'target_branch_drift', details: reason });
        updateTask(repoRoot, issue.id, task.id, { status: 'integration_blocked', note: reason });
        return result(repoRoot, {
          action: 'blocked', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
          taskStatus: 'integration_blocked', integrated: false, cleaned: false, changedPaths: [], changeOutcome: 'no_change', reason,
        });
      }
      currentRun = recordAgentJobIntegrationEvidence(repoRoot, run.runId, noChangeIntegration);
      updateTask(repoRoot, issue.id, task.id, { status: 'cleanup_pending', note: `${run.runId} has durable no-change evidence; cleanup finalizer is running.` });
      const cleanupResult = cleanup ? cleanupNoChangeWorktree(repoRoot, run.runId) : { removed: false, branchDeleted: false };
      const maintenanceWarnings: CompletionMaintenanceWarning[] = [];
      if (cleanupResult.preserved) {
        if (cleanupResult.preservationReason === 'cleanup_failed') {
          maintenanceWarnings.push(maintenanceWarningFromCleanup(currentRun, cleanupResult.message));
        } else {
        markAgentJobClosure(repoRoot, run.runId, {
          state: 'cleanup_blocked',
          preservationReason: cleanupResult.preservationReason ?? 'cleanup_failed',
          details: cleanupResult.message,
        });
        updateTask(repoRoot, issue.id, task.id, { status: 'cleanup_blocked', note: cleanupResult.message });
        return result(repoRoot, {
          action: 'blocked',
          runId: run.runId,
          issueId: issue.id,
          taskId: task.id,
          decision,
          taskStatus: 'cleanup_blocked',
          integrated: true,
          cleaned: false,
          branchDeleted: false,
          changedPaths: [],
          changeOutcome: 'no_change',
          reason: cleanupResult.message,
        });
        }
      }
      if (!cleanupResult.removed && run.worktree !== repoRoot) {
        if (maintenanceWarnings.length > 0) {
          cleaned = false;
          branchDeleted = cleanupResult.branchDeleted;
        } else {
        updateTask(repoRoot, issue.id, task.id, { status: 'cleanup_pending', note: `Cleanup remains pending for ${run.runId}.` });
        return result(repoRoot, {
          action: 'blocked', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
          taskStatus: 'cleanup_pending', integrated: true, cleaned: false, branchDeleted: false,
          changedPaths: [], changeOutcome: 'no_change', reason: 'No-change Run cannot complete before worktree cleanup.',
        });
        }
      }
      const noChangeCleanup = buildCleanupEvidence({
        run: currentRun, worktreeRemovedOrNotCreated: cleanupResult.removed || run.worktree === repoRoot,
        branchDeletedOrRetained: cleanupResult.removed || run.worktree === repoRoot,
        editSessionClosedOrNotCreated: true, noDirtyDiff: true,
        maintenanceWarnings,
      });
      changeOutcome = 'no_change';
      cleaned = cleanupResult.removed;
      branchDeleted = cleanupResult.branchDeleted;
      const completionReceipt = buildCompletionReceipt({
        source: receiptSourceForRun(currentRun, 'no_change'),
        issueId: issue.id,
        taskId: task.id,
        runId: run.runId,
        integrationEvidence: noChangeIntegration,
        changedPaths: [],
        cleanupWarnings: maintenanceWarnings,
        cleanupBlockers: noChangeCleanup.resourceBlockers,
      });
      currentRun = markAgentJobReviewedCompletion(repoRoot, run.runId, {
        changeOutcome: 'no_change',
        changedFiles: [],
        worktreeCleaned: cleanupResult.removed,
        branchDeleted: cleanupResult.branchDeleted,
        integrationEvidence: noChangeIntegration,
        cleanupEvidence: noChangeCleanup,
      });
      if (currentRun.status !== 'succeeded' || !currentRun.cleanupEvidence?.runTerminal) {
        return result(repoRoot, {
          action: 'blocked', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
          taskStatus: 'cleanup_blocked', integrated: true, cleaned, branchDeleted,
          changedPaths: [], changeOutcome, reason: currentRun.preservationDetails ?? 'Run terminal cleanup evidence was not persisted.',
        });
      }
      const verified = persistVerification(repoRoot, currentRun, reviewer, {
        integrationEvidence: noChangeIntegration,
        cleanupEvidence: currentRun.cleanupEvidence,
        completionReceipt,
      });
      const accepted = (decision === 'approve_and_finish' || canAutoFinish(verified.task))
        ? acceptVerifiedTask(repoRoot, issue.id, task.id, options.note ?? `Accepted explicit no-change evidence for ${run.runId}.`)
        : verified.issue;
      const finalStatus = taskForRun(accepted, task.id).status;
      return result(repoRoot, {
        action: finalStatus === 'done' ? 'no_change' : 'needs_decision',
        runId: run.runId,
        issueId: issue.id,
        taskId: task.id,
        decision,
        taskStatus: finalStatus,
        integrated: true,
        cleaned,
        branchDeleted,
        changedPaths: [],
        changeOutcome,
        maintenanceWarnings,
      });
    }

    try {
      updateTask(repoRoot, issue.id, task.id, { status: 'ready_to_integrate', note: `${run.runId} is verified as ready for serialized integration.` });
      updateTask(repoRoot, issue.id, task.id, { status: 'integrating', note: `${run.runId} entered the integration executor.` });
      const integratedSession = integrateAgentJob(repoRoot, getMcpPolicy('controller', { repoRoot }), run.runId);
      integrated = true;
      changedPaths = integratedSession.changedPaths;
      changeOutcome = integratedSession.changeOutcome;
      currentRun = getAgentJob(repoRoot, run.runId);
    } catch (error) {
      if (error instanceof IntegrationReviewRequiredError) {
        markAgentJobClosure(repoRoot, run.runId, {
          state: 'integration_blocked',
          preservationReason: 'integration_review_required',
          details: `Integration conflict requires review packet ${error.reviewPath}; both sides were preserved.`,
        });
        const updated = updateTask(repoRoot, issue.id, task.id, {
          status: 'integration_blocked',
          note: options.note ?? `Integration review is required for ${run.runId}: ${error.reviewPath}`,
        });
        return result(repoRoot, {
          action: 'blocked',
          runId: run.runId,
          issueId: issue.id,
          taskId: task.id,
          decision,
          taskStatus: taskForRun(updated, task.id).status,
          integrated: false,
          cleaned: false,
          branchDeleted: false,
          changedPaths: error.packet.changedPaths,
          changeOutcome,
          integrationReviewPath: error.reviewPath,
          reason: error.message,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      markAgentJobClosure(repoRoot, run.runId, {
        state: 'integration_blocked', preservationReason: 'integration_failed', details: message,
      });
      const updated = updateTask(repoRoot, issue.id, task.id, { status: 'integration_blocked', note: `Integration blocked for ${run.runId}: ${message}` });
      return result(repoRoot, {
        action: 'blocked', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
        taskStatus: taskForRun(updated, task.id).status, integrated: false, cleaned: false,
        changedPaths, changeOutcome, reason: message,
      });
    }
  }

  if (integrated || currentRun.integratedSessionId || run.provider === 'github') {
    updateTask(repoRoot, issue.id, task.id, { status: 'integrated', note: `${run.runId} integration applied; focused verification is running.` });
    updateTask(repoRoot, issue.id, task.id, { status: 'verifying', note: `${run.runId} is verifying the integrated target workspace.` });
    const verified = persistVerification(repoRoot, currentRun, reviewer);
    if (verified.task.status === 'changes_requested') {
      markAgentJobClosure(repoRoot, run.runId, {
        state: 'integration_blocked', preservationReason: 'verification_stale',
        details: `Integrated changes from ${run.runId} failed required verification; workspace and worktree are preserved.`,
      });
      return result(repoRoot, {
        action: 'changes_requested', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
        taskStatus: verified.task.status, integrated: true, cleaned: false, changedPaths, changeOutcome,
      });
    }
    if (changedPaths && changedPaths.length > 0) {
      if (!shouldCommit) {
        const reason = 'Changed Runs require a target-branch commit before cleanup; completion was invoked with commit disabled.';
        markAgentJobClosure(repoRoot, run.runId, { state: 'integration_blocked', preservationReason: 'integration_failed', details: reason });
        updateTask(repoRoot, issue.id, task.id, { status: 'integration_blocked', note: reason });
        return result(repoRoot, {
          action: 'blocked', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
          taskStatus: 'integration_blocked', integrated: true, cleaned: false, changedPaths, changeOutcome, reason,
        });
      }
      const committed = safeCommitChangedPaths(repoRoot, {
        issueId: issue.id,
        taskId: task.id,
        sourceLabel: 'Run',
        sourceId: run.runId,
        changedPaths,
      });
      commitSha = committed.commitSha;
      reusedHead = committed.reusedHead === true;
      commitError = committed.error;
      if (commitError || !commitSha) {
        commitError = commitError ?? 'integrated changes did not produce a target-branch commit';
        markAgentJobClosure(repoRoot, run.runId, {
          state: 'integration_blocked',
          preservationReason: commitError.includes('index already has staged changes') ? 'main_workspace_occupied' : 'cleanup_failed',
          details: commitError,
        });
        return result(repoRoot, {
          action: 'blocked',
          runId: run.runId,
          issueId: issue.id,
          taskId: task.id,
          decision,
          taskStatus: 'integration_blocked',
          integrated,
          cleaned: false,
          branchDeleted: false,
          changedPaths,
          changeOutcome,
          commitError,
          reason: commitError,
        });
      }
    }
    const afterIntegration = currentCompletionTarget(repoRoot);
    if (!afterIntegration.onTargetBranch) {
      const reason = `Integration target changed during Run completion; expected ${afterIntegration.expectedBranch}, current ${afterIntegration.branch}.`;
      markAgentJobClosure(repoRoot, run.runId, { state: 'integration_blocked', preservationReason: 'target_branch_drift', details: reason });
      updateTask(repoRoot, issue.id, task.id, { status: 'integration_blocked', note: reason });
      return result(repoRoot, {
        action: 'blocked', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
        taskStatus: 'integration_blocked', integrated: true, cleaned: false, changedPaths, changeOutcome, reason, commitSha,
      });
    }
    const noTargetChanges = (changedPaths ?? []).length === 0;
    const integrationEvidence: IntegrationEvidence = {
      runId: run.runId,
      kind: commitSha ? 'commit' : noTargetChanges ? 'no_change' : 'superseded',
      targetBranch: target.branch,
      targetRevision: commitSha ?? afterIntegration.revision,
      sourceRevision: run.branch ? gitText(run.worktree, ['rev-parse', 'HEAD']).stdout.trim() || undefined : undefined,
      baseRevision: run.baseRevision ?? undefined,
      strategy: commitSha && !reusedHead ? 'edit_session_commit' : noTargetChanges ? 'no_change' : 'already_integrated',
      editSessionId: currentRun.integratedSessionId,
      reachable: revisionReachable(repoRoot, commitSha ?? afterIntegration.revision, target.branch),
      recordedAt: nowIso(),
    };
    if (!integrationEvidence.reachable) {
      const reason = `Integrated revision ${integrationEvidence.targetRevision} is not reachable from ${integrationEvidence.targetBranch}.`;
      markAgentJobClosure(repoRoot, run.runId, { state: 'integration_blocked', preservationReason: 'target_branch_drift', details: reason });
      updateTask(repoRoot, issue.id, task.id, { status: 'integration_blocked', note: reason });
      return result(repoRoot, {
        action: 'blocked', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
        taskStatus: 'integration_blocked', integrated: true, cleaned: false, changedPaths, changeOutcome, reason, commitSha,
      });
    }
    currentRun = recordAgentJobIntegrationEvidence(repoRoot, run.runId, integrationEvidence);
    let editSessionClosed = !currentRun.integratedSessionId;
    if (currentRun.integratedSessionId) {
      try {
        const session = getEditSession(repoRoot, currentRun.integratedSessionId);
        if (!['finalized', 'superseded', 'rolled_back'].includes(session.status)) {
          const finalized = finalizeEditSession(repoRoot, session.sessionId, {
            reviewer,
            note: `Finalized after verification and target commit ${integrationEvidence.targetRevision} for ${run.runId}.`,
          });
          editSessionClosed = ['finalized', 'superseded', 'rolled_back'].includes(finalized.status);
        } else editSessionClosed = true;
      } catch (error) {
        const reason = `Edit-session finalization blocked cleanup for ${run.runId}: ${error instanceof Error ? error.message : String(error)}`;
        markAgentJobClosure(repoRoot, run.runId, { state: 'cleanup_blocked', preservationReason: 'cleanup_failed', details: reason });
        updateTask(repoRoot, issue.id, task.id, { status: 'cleanup_blocked', note: reason });
        return result(repoRoot, {
          action: 'blocked', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
          taskStatus: 'cleanup_blocked', integrated: true, cleaned: false, changedPaths, changeOutcome, reason, commitSha,
        });
      }
    }
    updateTask(repoRoot, issue.id, task.id, { status: 'cleanup_pending', note: `${run.runId} has durable integration evidence; cleanup finalizer is running.` });
    const maintenanceWarnings: CompletionMaintenanceWarning[] = [];
    if (
      cleanup &&
      integrated &&
      run.provider === 'local' &&
      run.executionMode === 'worktree' &&
      !commitError
    ) {
      const cleanupResult = cleanupIntegratedWorktree(repoRoot, run.runId);
      if (cleanupResult.preserved) {
        if (cleanupResult.preservationReason === 'cleanup_failed') {
          maintenanceWarnings.push(maintenanceWarningFromCleanup(currentRun, cleanupResult.message));
        } else {
        markAgentJobClosure(repoRoot, run.runId, {
          state: 'cleanup_blocked', preservationReason: cleanupResult.preservationReason ?? 'cleanup_failed', details: cleanupResult.message,
        });
        updateTask(repoRoot, issue.id, task.id, { status: 'cleanup_blocked', note: cleanupResult.message });
        return result(repoRoot, {
          action: 'blocked',
          runId: run.runId,
          issueId: issue.id,
          taskId: task.id,
          decision,
          taskStatus: 'cleanup_blocked',
          integrated,
          cleaned: false,
          branchDeleted: false,
          changedPaths,
          changeOutcome,
          reason: cleanupResult.message,
        });
        }
      }
      cleaned = cleanupResult.removed;
      branchDeleted = cleanupResult.branchDeleted;
    }
    const completionEligible = run.provider !== 'local' || run.executionMode !== 'worktree' || integrated && (cleaned || maintenanceWarnings.length > 0);
    if (!completionEligible) {
      return result(repoRoot, {
        action: 'blocked', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
        taskStatus: 'cleanup_pending', integrated, cleaned, branchDeleted, changedPaths, changeOutcome,
        reason: 'Cleanup was deferred; Task remains cleanup_pending.', commitSha,
      });
    }
    const finalCleanupEvidence = buildCleanupEvidence({
      run: currentRun,
      worktreeRemovedOrNotCreated: cleaned || run.provider !== 'local' || run.executionMode !== 'worktree',
      branchDeletedOrRetained: cleaned || run.provider !== 'local' || run.executionMode !== 'worktree',
      editSessionClosedOrNotCreated: editSessionClosed,
      noDirtyDiff: ownedWorkspaceChanges(repoRoot, changedPaths ?? [], task.allowedPaths).length === 0,
      maintenanceWarnings,
    });
    const completionReceipt = buildCompletionReceipt({
      source: receiptSourceForRun(currentRun, changeOutcome),
      issueId: issue.id,
      taskId: task.id,
      runId: run.runId,
      integrationEvidence,
      changedPaths: changedPaths ?? [],
      cleanupWarnings: maintenanceWarnings,
      cleanupBlockers: finalCleanupEvidence.resourceBlockers,
    });
    currentRun = markAgentJobReviewedCompletion(repoRoot, run.runId, {
      changeOutcome,
      changedFiles: changedPaths,
      worktreeCleaned: cleaned,
      branchDeleted,
      integrationEvidence,
      cleanupEvidence: finalCleanupEvidence,
    });
    if (currentRun.status !== 'succeeded' || !currentRun.cleanupEvidence?.runTerminal) {
      return result(repoRoot, {
        action: 'blocked', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
        taskStatus: 'cleanup_blocked', integrated, cleaned, branchDeleted, changedPaths, changeOutcome,
        commitSha, commitError, reason: currentRun.preservationDetails ?? 'Run terminal cleanup evidence was not persisted.',
      });
    }
    const finalVerification = persistVerification(repoRoot, currentRun, reviewer, {
      integrationEvidence,
      cleanupEvidence: currentRun.cleanupEvidence,
      completionReceipt,
    });
    const finalIssue = (decision === 'approve_and_finish' || canAutoFinish(finalVerification.task))
      ? acceptVerifiedTask(repoRoot, issue.id, task.id, options.note ?? `Accepted verified integration and cleanup evidence for ${run.runId}.`)
      : finalVerification.issue;
    const finalStatus = taskForRun(finalIssue, task.id).status;
    return result(repoRoot, {
      action: finalStatus === 'done' ? 'finished' : 'needs_decision',
      runId: run.runId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: finalStatus,
      integrated,
      cleaned,
      branchDeleted,
      changedPaths,
      changeOutcome,
      commitSha,
      commitError,
      maintenanceWarnings,
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

export function finishTaskRun(repoRoot: string, options: FinishTaskRunOptions): FinishTaskRunResult {
  const targetBranch = resolveCompletionTargetBranch(repoRoot);
  const resource = `integration-${createHash('sha256').update(`${repoRoot}\0${targetBranch}`).digest('hex').slice(0, 24)}`;
  return withControllerLock(
    resolveRepoPreferredControllerHome(repoRoot),
    { scope: 'global', resource },
    `completion:${options.runId}`,
    () => finishTaskRunUnlocked(repoRoot, options),
    30 * 60_000,
  );
}

export function finishEditSession(repoRoot: string, options: FinishEditSessionOptions): FinishEditSessionResult {
  const targetBranch = resolveCompletionTargetBranch(repoRoot);
  const resource = `integration-${createHash('sha256').update(`${repoRoot}\0${targetBranch}`).digest('hex').slice(0, 24)}`;
  return withControllerLock(
    resolveRepoPreferredControllerHome(repoRoot),
    { scope: 'global', resource },
    `completion:${options.sessionId}`,
    () => finishEditSessionUnlocked(repoRoot, options),
    30 * 60_000,
  );
}
