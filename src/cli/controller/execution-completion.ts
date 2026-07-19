import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentJobMeta } from '../agent-jobs/types';
import { runControllerCheck } from './check-runner';
import { taskExecutionPolicy } from './execution-policy';
import { acceptVerifiedTask, getIssue, recordTaskVerification, updateTask } from './issue-store';
import type { TaskCommandEvidence, TaskVerification } from './types';

export interface CompletionContinuationResult {
  continued: boolean;
  status?: string;
  reason?: string;
  checkCount?: number;
}

function diffHash(repoRoot: string, run: AgentJobMeta): string | undefined {
  if (!run.diffArtifactPath) return undefined;
  const absolute = join(repoRoot, run.diffArtifactPath);
  if (!existsSync(absolute)) return undefined;
  return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

/**
 * Continue the controller lifecycle after a successful Run. This is deliberately
 * task-local: unrelated Issue readiness never participates.
 */
export function continueTaskAfterSuccessfulRun(
  repoRoot: string,
  run: AgentJobMeta,
): CompletionContinuationResult {
  if (run.status !== 'succeeded') return { continued: false, reason: `Run status is ${run.status}.` };
  if (run.provider === 'local' && run.worktree !== repoRoot && !run.integratedSessionId) {
    return { continued: false, reason: 'Isolated Run is awaiting integration.' };
  }

  const issue = getIssue(repoRoot, run.issueId);
  const task = issue.tasks.find((entry) => entry.id === run.taskId);
  if (!task) return { continued: false, reason: 'Task no longer exists.' };
  if (['done', 'cancelled', 'superseded'].includes(task.status)) {
    return { continued: false, status: task.status, reason: 'Task is already terminal.' };
  }
  const policy = taskExecutionPolicy(task);
  const checkResults = policy.autoRunDeclaredChecks
    ? task.checks.map((checkId) => {
        try {
          const result = runControllerCheck(repoRoot, checkId);
          return {
            checkId,
            ok: result.ok,
            summary: `${result.ok ? 'Passed' : 'Failed'} with persisted evidence: ${result.artifactPath}`,
          };
        } catch (error) {
          return { checkId, ok: false, summary: error instanceof Error ? error.message : String(error) };
        }
      })
    : [];

  const commandEvidence: TaskCommandEvidence[] = [{
    command: ['repo-harness', 'agent-run', run.runId],
    cwd: run.executionMode === 'worktree' ? run.worktree : repoRoot,
    ok: true,
    exitCode: run.exitCode ?? 0,
    artifactPath: run.resultPath,
    reportedBy: run.agent,
    executedAt: run.finishedAt ?? new Date().toISOString(),
    source: 'controller',
  }];
  const acceptanceResults = task.acceptanceCriteria.map((criterion) => ({
    criterion,
    ok: false,
    outcome: 'not_evaluated' as const,
    source: 'run_completion' as const,
    evidence: `Successful Run ${run.runId}${run.integratedSessionId ? ` integrated by ${run.integratedSessionId}` : ''}; acceptance was not independently evaluated.`,
  }));
  const verification: TaskVerification = {
    runId: run.runId,
    integratedRevision: run.integrationEvidence?.targetRevision,
    reviewedDiffHash: diffHash(repoRoot, run),
    reviewer: 'repo-harness-controller',
    checkResults,
    commandEvidence,
    acceptanceResults,
    verifiedAt: new Date().toISOString(),
    integrationEvidence: run.integrationEvidence,
    cleanupEvidence: run.cleanupEvidence,
  };

  // A failed real check is authoritative and moves the Task to changes_requested.
  const updated = recordTaskVerification(repoRoot, issue.id, task.id, verification);
  const status = updated.tasks.find((entry) => entry.id === task.id)?.status;
  if (status === 'changes_requested') {
    updateTask(repoRoot, issue.id, task.id, {
      note: `Automatic continuation stopped because required completion evidence failed for ${run.runId}.`,
    });
    return { continued: true, status, checkCount: checkResults.length };
  }
  if (status === 'verified' && policy.autoCompleteAfterSuccessfulRun && !policy.requiresHumanAcceptance) {
    const closureComplete = run.closureState === 'completed'
      && run.integrationEvidence?.runId === run.runId
      && run.cleanupEvidence?.runId === run.runId
      && Boolean(run.integrationEvidence.reachable)
      && Boolean(run.cleanupEvidence.worktreeRemovedOrNotCreated
        && run.cleanupEvidence.branchDeletedOrRetained
        && run.cleanupEvidence.leasesReleased
        && run.cleanupEvidence.runTerminal
        && run.cleanupEvidence.editSessionClosedOrNotCreated
        && run.cleanupEvidence.noActiveProcess
        && run.cleanupEvidence.noDirtyDiff);
    if (!closureComplete) {
      return {
        continued: true,
        status,
        reason: `Verification passed, but Run closure is ${run.closureState ?? 'none'}; integration and cleanup evidence are still required.`,
        checkCount: checkResults.length,
      };
    }
    const accepted = acceptVerifiedTask(
      repoRoot,
      issue.id,
      task.id,
      `Verification, integration, and cleanup evidence passed for ${run.runId}.`,
    );
    return { continued: true, status: accepted.tasks.find((entry) => entry.id === task.id)?.status ?? 'done', checkCount: checkResults.length };
  }
  return { continued: true, status, checkCount: checkResults.length };
}
