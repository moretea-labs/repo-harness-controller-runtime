import { getAgentJob } from '../agent-jobs/job-manager';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { inspectCompletionBacklog, type CompletionBacklogItem } from './completion-backlog';
import { getIssue, listIssues, updateIssue, updateTask } from './issue-store';
import { completionEvidenceComplete, taskExecutionPolicy, verificationEvidencePassed } from './execution-policy';
import type { CompletionReceipt, ControllerIssue, ControllerTask } from './types';

export type StuckStateKind =
  | 'finishable_run'
  | 'manual_review_required'
  | 'retry_required'
  | 'review_without_run'
  | 'blocked_without_run'
  | 'running_without_active_run'
  | 'terminal_with_open_issue'
  | 'false_completed'
  | 'pending_integration'
  | 'integration_blocked'
  | 'cleanup_pending'
  | 'cleanup_blocked';

export interface StuckStateFinding {
  kind: StuckStateKind;
  issueId: string;
  taskId: string;
  title: string;
  taskStatus: string;
  runId?: string;
  runStatus?: string;
  safeAutomaticAction: 'finish' | 'reconcile' | 'reopen' | 'note_only' | 'none';
  reason: string;
}

export interface StuckControllerStateReport {
  scannedAt: string;
  counts: Record<StuckStateKind, number>;
  findings: StuckStateFinding[];
  recommendations: string[];
}

export interface ApplyStuckStateMigrationOptions {
  dryRun?: boolean;
  limit?: number;
  reviewer?: string;
  markRetryRequired?: boolean;
  markNoRunEvidence?: boolean;
}

export interface ApplyStuckStateMigrationResult {
  dryRun: boolean;
  attempted: number;
  applied: number;
  skipped: number;
  errors: Array<{ issueId: string; taskId: string; error: string }>;
  findings: StuckStateFinding[];
  after?: StuckControllerStateReport;
}

const ZERO_COUNTS: Record<StuckStateKind, number> = {
  finishable_run: 0,
  manual_review_required: 0,
  retry_required: 0,
  review_without_run: 0,
  blocked_without_run: 0,
  running_without_active_run: 0,
  terminal_with_open_issue: 0,
  false_completed: 0,
  pending_integration: 0,
  integration_blocked: 0,
  cleanup_pending: 0,
  cleanup_blocked: 0,
};

function countFindings(findings: StuckStateFinding[]): Record<StuckStateKind, number> {
  const counts = { ...ZERO_COUNTS };
  for (const finding of findings) counts[finding.kind] += 1;
  return counts;
}

function backlogFinding(item: CompletionBacklogItem): StuckStateFinding | undefined {
  if (['ready_to_integrate', 'integration_blocked', 'cleanup_pending', 'cleanup_blocked'].includes(item.taskStatus)) return undefined;
  if (item.action === 'auto_finish') return {
    kind: 'finishable_run',
    issueId: item.issueId,
    taskId: item.taskId,
    title: item.title,
    taskStatus: item.taskStatus,
    runId: item.runId,
    runStatus: item.runStatus,
    safeAutomaticAction: 'finish',
    reason: item.reason,
  };
  if (item.action === 'needs_human_review') return {
    kind: 'manual_review_required',
    issueId: item.issueId,
    taskId: item.taskId,
    title: item.title,
    taskStatus: item.taskStatus,
    runId: item.runId,
    runStatus: item.runStatus,
    safeAutomaticAction: 'none',
    reason: item.reason,
  };
  if (item.action === 'retry_required') return {
    kind: 'retry_required',
    issueId: item.issueId,
    taskId: item.taskId,
    title: item.title,
    taskStatus: item.taskStatus,
    runId: item.runId,
    runStatus: item.runStatus,
    safeAutomaticAction: 'note_only',
    reason: item.reason,
  };
  if (item.action === 'no_run_evidence') return {
    kind: item.taskStatus === 'blocked' ? 'blocked_without_run' : 'review_without_run',
    issueId: item.issueId,
    taskId: item.taskId,
    title: item.title,
    taskStatus: item.taskStatus,
    runId: item.runId,
    runStatus: item.runStatus,
    safeAutomaticAction: 'note_only',
    reason: item.reason,
  };
  if (item.action === 'system_blocked') {
    if (item.taskStatus === 'done') return undefined;
    return {
      kind: 'blocked_without_run',
      issueId: item.issueId,
      taskId: item.taskId,
      title: item.title,
      taskStatus: item.taskStatus,
      runId: item.runId,
      runStatus: item.runStatus,
      safeAutomaticAction: 'note_only',
      reason: item.reason,
    };
  }
  return undefined;
}

function latestRunIsActive(repoRoot: string, task: ControllerTask): boolean {
  for (const runId of [...task.runIds].reverse()) {
    try {
      const run = getAgentJob(repoRoot, runId);
      return ['queued', 'starting', 'running'].includes(run.status);
    } catch (_error) {
      // keep scanning older ids
    }
  }
  return false;
}

function gitText(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
  if (result.status !== 0 || result.error) return '';
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

function currentTarget(repoRoot: string): { branch: string; revision: string } | undefined {
  const branch = gitText(repoRoot, ['branch', '--show-current']);
  const revision = gitText(repoRoot, ['rev-parse', 'HEAD']);
  return branch && revision ? { branch, revision } : undefined;
}

function reachable(repoRoot: string, revision: string, branch: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', revision, branch], { cwd: repoRoot, encoding: 'utf-8' });
  return result.status === 0 && !result.error;
}

function historicalCompletionReceipt(repoRoot: string, issue: ControllerIssue, task: ControllerTask): CompletionReceipt | undefined {
  if (!task.verification) return undefined;
  const policy = taskExecutionPolicy(task);
  const outcome = verificationEvidencePassed(task, task.verification, policy);
  if (!outcome.ok) return undefined;
  const target = currentTarget(repoRoot);
  if (!target) return undefined;
  const targetRevision = task.verification.integratedRevision
    ?? task.verification.integrationEvidence?.targetRevision;
  if (!targetRevision) return undefined;
  const targetBranch = task.verification.integrationEvidence?.targetBranch ?? target.branch;
  if (!reachable(repoRoot, targetRevision, targetBranch)) return undefined;
  const recordedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    receiptId: `REC-reconciled-${createHash('sha256').update(`${issue.id}\0${task.id}\0${targetRevision}`).digest('hex').slice(0, 16)}`,
    source: task.verification.runId ? 'workspace_run' : 'remote_no_change_execution',
    issueId: issue.id,
    taskId: task.id,
    runId: task.verification.runId,
    editSessionId: task.verification.integrationEvidence?.editSessionId,
    targetBranch,
    targetRevision,
    sourceRevision: task.verification.integrationEvidence?.sourceRevision ?? targetRevision,
    baseRevision: task.verification.integrationEvidence?.baseRevision,
    changedPaths: [],
    delivery: {
      kind: task.verification.integrationEvidence?.kind ?? 'commit',
      status: 'integrated',
      strategy: task.verification.integrationEvidence?.strategy === 'no_change' ? 'no_change'
        : task.verification.integrationEvidence?.strategy === 'already_integrated' ? 'already_integrated'
          : task.verification.runId ? 'already_integrated' : 'remote',
      reachable: true,
      recordedAt,
    },
    cleanup: {
      status: 'complete',
      warnings: [],
      blockers: [],
      recordedAt,
    },
    verifiedAt: task.verification.verifiedAt,
    recordedAt,
  };
}

function extraFindings(repoRoot: string, issue: ControllerIssue, task: ControllerTask): StuckStateFinding[] {
  const findings: StuckStateFinding[] = [];
  if (['ready_to_integrate', 'integration_blocked', 'cleanup_pending', 'cleanup_blocked'].includes(task.status)) {
    const kind: StuckStateKind = task.status === 'ready_to_integrate' ? 'pending_integration'
      : task.status === 'cleanup_pending' ? 'cleanup_pending'
        : task.status === 'cleanup_blocked' ? 'cleanup_blocked'
          : 'integration_blocked';
    let run;
    for (const runId of [...task.runIds].reverse()) {
      try { run = getAgentJob(repoRoot, runId); break; }
      catch (_error) { /* keep scanning */ }
    }
    findings.push({
      kind,
      issueId: issue.id,
      taskId: task.id,
      title: task.title,
      taskStatus: task.status,
      runId: run?.runId,
      runStatus: run?.status,
      safeAutomaticAction: 'none',
      reason: `Task is explicitly ${task.status}; preserve its evidence and resolve this lifecycle blocker before new overlapping work.`,
    });
  }
  if (task.status === 'done') {
    if (!completionEvidenceComplete(task.verification)) {
      const safeReceipt = historicalCompletionReceipt(repoRoot, issue, task);
      let run;
      for (const runId of [...task.runIds].reverse()) {
        try { run = getAgentJob(repoRoot, runId); break; }
        catch (_error) { /* keep scanning */ }
      }
      const closure = run?.closureState;
      const kind: StuckStateKind = closure === 'cleanup_blocked' || closure === 'preserved' && Boolean(run?.integratedSessionId)
        ? 'cleanup_blocked'
        : closure === 'cleanup_pending' || closure === 'cleaning' || closure === 'integrated'
          ? 'cleanup_pending'
          : closure === 'integration_blocked' || closure === 'preserved'
            ? 'integration_blocked'
            : closure === 'ready_to_integrate' || closure === 'integration_pending' || closure === 'integrating'
              ? 'pending_integration'
              : 'false_completed';
      findings.push({
        kind,
        issueId: issue.id,
        taskId: task.id,
        title: task.title,
        taskStatus: task.status,
        runId: run?.runId,
        runStatus: run?.status,
        safeAutomaticAction: safeReceipt ? 'reconcile' : 'reopen',
        reason: safeReceipt
          ? `Task is declared done with passing verification and reachable target revision ${safeReceipt.targetRevision}, but lacks a completion receipt.`
          : `Task is declared done without complete integration and cleanup evidence${closure ? `; latest Run closure is ${closure}` : ''}.`,
      });
    }
  }
  if (task.status === 'running' && !latestRunIsActive(repoRoot, task)) {
    findings.push({
      kind: 'running_without_active_run',
      issueId: issue.id,
      taskId: task.id,
      title: task.title,
      taskStatus: task.status,
      safeAutomaticAction: 'note_only',
      reason: 'Task is marked running, but no readable active Run remains.',
    });
  }
  if (['done', 'cancelled', 'superseded'].includes(task.status) && !['done', 'cancelled'].includes(issue.status)) {
    findings.push({
      kind: 'terminal_with_open_issue',
      issueId: issue.id,
      taskId: task.id,
      title: task.title,
      taskStatus: task.status,
      safeAutomaticAction: 'none',
      reason: `Task is terminal while Issue ${issue.id} is still ${issue.status}; inspect whether the Issue can be closed or has remaining work.`,
    });
  }
  return findings;
}

export function inspectStuckControllerStates(repoRoot: string, options: { limit?: number } = {}): StuckControllerStateReport {
  const limit = Math.max(1, Math.min(options.limit ?? 500, 5000));
  const backlog = inspectCompletionBacklog(repoRoot, { includeTerminal: false, limit });
  const findings: StuckStateFinding[] = backlog.items
    .map(backlogFinding)
    .filter((entry): entry is StuckStateFinding => Boolean(entry));
  for (const issue of listIssues(repoRoot, { includeEphemeral: false })) {
    for (const task of issue.tasks) findings.push(...extraFindings(repoRoot, issue, task));
    if (findings.length >= limit) break;
  }
  const trimmed = findings.slice(0, limit);
  const counts = countFindings(trimmed);
  const recommendations: string[] = [];
  if (counts.finishable_run) recommendations.push(`Run controller finish-ready-runs --apply to close ${counts.finishable_run} safe completed Run(s).`);
  if (counts.manual_review_required) recommendations.push(`${counts.manual_review_required} high-risk Run(s) require explicit user decision in Local Bridge or finish-run --decision.`);
  if (counts.retry_required) recommendations.push(`${counts.retry_required} failed/cancelled Run(s) should be retried or marked changes_requested with a reason.`);
  const falseTerminal = counts.false_completed + counts.pending_integration + counts.integration_blocked + counts.cleanup_pending + counts.cleanup_blocked;
  if (falseTerminal) recommendations.push(`${falseTerminal} Task(s) require completion receipt reconciliation or explicit integration/cleanup resolution; use migrate-stuck-states --apply only for entries still declared done.`);
  if (counts.review_without_run || counts.running_without_active_run) recommendations.push('Use controller migrate-stuck-states --apply to annotate stale review/running states before retrying them.');
  return { scannedAt: new Date().toISOString(), counts, findings: trimmed, recommendations };
}

export function applyStuckStateMigration(repoRoot: string, options: ApplyStuckStateMigrationOptions = {}): ApplyStuckStateMigrationResult {
  const report = inspectStuckControllerStates(repoRoot, { limit: options.limit ?? 100 });
  const dryRun = options.dryRun !== false;
  const reviewer = options.reviewer?.trim() || 'repo-harness-stuck-state-migration';
  const selected = report.findings.filter((finding) => ['note_only', 'reconcile', 'reopen'].includes(finding.safeAutomaticAction));
  let applied = 0;
  let skipped = 0;
  const errors: Array<{ issueId: string; taskId: string; error: string }> = [];
  if (!dryRun) {
    for (const finding of selected) {
      try {
        getIssue(repoRoot, finding.issueId);
        const note = `${reviewer}: ${finding.kind} inspected. ${finding.reason}`;
        if (finding.safeAutomaticAction === 'reconcile') {
          const currentIssue = getIssue(repoRoot, finding.issueId);
          const task = currentIssue.tasks.find((entry) => entry.id === finding.taskId);
          if (!task) throw new Error(`task not found: ${finding.issueId}/${finding.taskId}`);
          const receipt = historicalCompletionReceipt(repoRoot, currentIssue, task);
          if (!receipt || !task.verification) throw new Error('completion receipt reconciliation is no longer safe');
          updateTask(repoRoot, finding.issueId, finding.taskId, {
            verification: { ...task.verification, completionReceipt: receipt },
            note: `${note} Reconciled completion receipt ${receipt.receiptId}.`,
          });
        } else if (finding.safeAutomaticAction === 'reopen') {
          const currentIssue = getIssue(repoRoot, finding.issueId);
          if (currentIssue.status === 'done') updateIssue(repoRoot, finding.issueId, { status: 'in_progress' });
          const status = finding.kind === 'cleanup_blocked' ? 'cleanup_blocked'
            : finding.kind === 'cleanup_pending' ? 'cleanup_pending'
              : finding.kind === 'integration_blocked' ? 'integration_blocked'
                : finding.kind === 'pending_integration' ? 'ready_to_integrate'
                  : 'integration_blocked';
          updateTask(repoRoot, finding.issueId, finding.taskId, { status, note, transition: 'restore' });
        } else if (finding.kind === 'retry_required' && options.markRetryRequired === true) {
          updateTask(repoRoot, finding.issueId, finding.taskId, { status: 'changes_requested', note });
        } else if ((finding.kind === 'review_without_run' || finding.kind === 'running_without_active_run' || finding.kind === 'blocked_without_run') && options.markNoRunEvidence === true) {
          updateTask(repoRoot, finding.issueId, finding.taskId, { status: 'changes_requested', note });
        } else {
          updateTask(repoRoot, finding.issueId, finding.taskId, { note });
        }
        applied += 1;
      } catch (error) {
        errors.push({ issueId: finding.issueId, taskId: finding.taskId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } else {
    skipped = selected.length;
  }
  return {
    dryRun,
    attempted: selected.length,
    applied,
    skipped,
    errors,
    findings: selected,
    after: dryRun ? undefined : inspectStuckControllerStates(repoRoot, { limit: options.limit ?? 100 }),
  };
}
