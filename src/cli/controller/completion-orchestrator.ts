import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getAgentJob, markAgentJobClosure, markAgentJobReviewedCompletion, recordAgentJobIntegrationEvidence } from '../agent-jobs/job-manager';
import type { AgentJobMeta } from '../agent-jobs/types';
import { cleanupIntegratedWorktree, cleanupNoChangeWorktree, integrateAgentJob, IntegrationReviewRequiredError, taskRunDiff } from '../agent-jobs/integration';
import { finalizeEditSession, getEditSession } from '../editing/edit-session';
import { getMcpPolicy } from '../mcp/policy';
import { resolveRepoPreferredControllerHome } from '../repositories/controller-home';
import { withControllerLock } from '../repositories/locks';
import { listActiveLeases } from '../../runtime/resources/leases/store';
import { acceptVerifiedTask, getIssue, projectIssueEffectiveView, recordTaskVerification, updateTask } from './issue-store';
import { taskExecutionPolicy } from './execution-policy';
import { runControllerCheck } from './check-runner';
import type { CleanupEvidence, ControllerIssue, ControllerTask, IntegrationEvidence, TaskCommandEvidence, TaskVerification } from './types';

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
}


function gitText(repoRoot: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
  return {
    ok: result.status === 0 && !result.error,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : (result.error?.message ?? ''),
  };
}

function safeCommitChangedPaths(repoRoot: string, input: { issueId: string; taskId: string; runId: string; changedPaths?: string[] }): { commitSha?: string; reusedHead?: boolean; error?: string } {
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
    '-m',
    `Complete ${input.issueId}/${input.taskId}`,
    '-m',
    `Run: ${input.runId}`,
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
  evidence: { integrationEvidence?: IntegrationEvidence; cleanupEvidence?: CleanupEvidence } = {},
): TaskVerification {
  const policy = taskExecutionPolicy(task);
  const acceptanceResults = task.acceptanceCriteria.map((criterion) => ({
    criterion,
    ok: true,
    evidence: `Accepted from successful Run ${run.runId}${run.integratedSessionId ? ` integrated by ${run.integratedSessionId}` : ''}.`,
  }));
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
    : recordTaskVerification(repoRoot, run.issueId, run.taskId, verificationForRun(repoRoot, run, currentTask, reviewer));
  const verifiedTask = taskForRun(verified, run.taskId);
  if (verifiedTask.status === 'done') return { issue: verified, taskStatus: 'done' };
  if (input.allowCompletion !== false && verifiedTask.status === 'verified' && (allowHumanAcceptance || canAutoFinish(verifiedTask))) {
    const accepted = acceptVerifiedTask(repoRoot, run.issueId, run.taskId, input.note ?? `Accepted by ${reviewer} through completion orchestrator.`);
    return { issue: accepted, taskStatus: taskForRun(accepted, run.taskId).status };
  }
  return { issue: verified, taskStatus: verifiedTask.status };
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

function buildCleanupEvidence(input: {
  run: AgentJobMeta;
  worktreeRemovedOrNotCreated: boolean;
  branchDeletedOrRetained: boolean;
  editSessionClosedOrNotCreated: boolean;
  noDirtyDiff: boolean;
}): CleanupEvidence {
  return {
    worktreeRemovedOrNotCreated: input.worktreeRemovedOrNotCreated,
    branchDeletedOrRetained: input.branchDeletedOrRetained,
    leasesReleased: runLeasesReleased(input.run.repoRoot, input.run),
    runTerminal: true,
    editSessionClosedOrNotCreated: input.editSessionClosedOrNotCreated,
    noActiveProcess: !processAlive(input.run.agentPid),
    noDirtyDiff: input.noDirtyDiff,
    recordedAt: nowIso(),
  };
}

function persistVerification(
  repoRoot: string,
  run: AgentJobMeta,
  reviewer: string,
  evidence: { integrationEvidence?: IntegrationEvidence; cleanupEvidence?: CleanupEvidence } = {},
): { issue: ControllerIssue; task: ControllerTask } {
  const issue = getIssue(repoRoot, run.issueId);
  const task = taskForRun(issue, run.taskId);
  const updated = recordTaskVerification(
    repoRoot,
    issue.id,
    task.id,
    verificationForRun(repoRoot, run, task, reviewer, evidence),
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
    const evidence = task.verification;
    if (!evidence?.integrationEvidence || !evidence.cleanupEvidence) {
      return result(repoRoot, {
        action: 'blocked', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
        taskStatus: task.status, reason: 'Task is declared done without integration and cleanup evidence; run lifecycle migration before accepting it.',
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
  let integrated = Boolean(run.integrationEvidence?.reachable) || run.worktree === repoRoot || run.provider === 'github';
  let cleaned = Boolean(run.worktreeCleanedAt);
  let branchDeleted = false;
  let changedPaths = run.changedFiles;
  let changeOutcome = run.changeOutcome;
  let commitSha: string | undefined;
  let commitError: string | undefined;
  let reusedHead = false;

  const target = currentTarget(repoRoot);

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
        kind: 'no_change', targetBranch: target.branch, targetRevision: target.revision,
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
      if (cleanupResult.preserved) {
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
      if (!cleanupResult.removed && run.worktree !== repoRoot) {
        updateTask(repoRoot, issue.id, task.id, { status: 'cleanup_pending', note: `Cleanup remains pending for ${run.runId}.` });
        return result(repoRoot, {
          action: 'blocked', runId: run.runId, issueId: issue.id, taskId: task.id, decision,
          taskStatus: 'cleanup_pending', integrated: true, cleaned: false, branchDeleted: false,
          changedPaths: [], changeOutcome: 'no_change', reason: 'No-change Run cannot complete before worktree cleanup.',
        });
      }
      const noChangeCleanup = buildCleanupEvidence({
        run: currentRun, worktreeRemovedOrNotCreated: cleanupResult.removed || run.worktree === repoRoot,
        branchDeletedOrRetained: cleanupResult.removed || run.worktree === repoRoot,
        editSessionClosedOrNotCreated: true, noDirtyDiff: true,
      });
      currentRun = markAgentJobReviewedCompletion(repoRoot, run.runId, {
        changeOutcome: 'no_change',
        changedFiles: [],
        worktreeCleaned: cleanupResult.removed,
        branchDeleted: cleanupResult.branchDeleted,
        integrationEvidence: noChangeIntegration,
        cleanupEvidence: noChangeCleanup,
      });
      changeOutcome = 'no_change';
      cleaned = cleanupResult.removed;
      branchDeleted = cleanupResult.branchDeleted;
      const verified = persistVerification(repoRoot, currentRun, reviewer, {
        integrationEvidence: noChangeIntegration,
        cleanupEvidence: noChangeCleanup,
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
        runId: run.runId,
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
    const afterIntegration = currentTarget(repoRoot);
    const noTargetChanges = (changedPaths ?? []).length === 0;
    const integrationEvidence: IntegrationEvidence = {
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
    if (
      cleanup &&
      integrated &&
      run.provider === 'local' &&
      run.executionMode === 'worktree' &&
      !commitError
    ) {
      const cleanupResult = cleanupIntegratedWorktree(repoRoot, run.runId);
      if (cleanupResult.preserved) {
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
      cleaned = cleanupResult.removed;
      branchDeleted = cleanupResult.branchDeleted;
    }
    const completionEligible = run.provider !== 'local' || run.executionMode !== 'worktree' || integrated && cleaned;
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
      noDirtyDiff: scopedWorkspaceChanges(repoRoot, task.allowedPaths).length === 0,
    });
    currentRun = markAgentJobReviewedCompletion(repoRoot, run.runId, {
      changeOutcome,
      changedFiles: changedPaths,
      worktreeCleaned: cleaned,
      branchDeleted,
      integrationEvidence,
      cleanupEvidence: finalCleanupEvidence,
    });
    const finalVerification = persistVerification(repoRoot, currentRun, reviewer, {
      integrationEvidence,
      cleanupEvidence: finalCleanupEvidence,
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
  const target = currentTarget(repoRoot);
  const resource = `integration-${createHash('sha256').update(`${repoRoot}\0${target.branch}`).digest('hex').slice(0, 24)}`;
  return withControllerLock(
    resolveRepoPreferredControllerHome(repoRoot),
    { scope: 'global', resource },
    `completion:${options.runId}`,
    () => finishTaskRunUnlocked(repoRoot, options),
    30 * 60_000,
  );
}
