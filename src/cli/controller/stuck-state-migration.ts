import { getAgentJob } from '../agent-jobs/job-manager';
import { inspectCompletionBacklog, type CompletionBacklogItem } from './completion-backlog';
import { getIssue, listIssues, updateTask } from './issue-store';
import type { ControllerIssue, ControllerTask } from './types';

export type StuckStateKind =
  | 'finishable_run'
  | 'manual_review_required'
  | 'retry_required'
  | 'review_without_run'
  | 'blocked_without_run'
  | 'running_without_active_run'
  | 'terminal_with_open_issue';

export interface StuckStateFinding {
  kind: StuckStateKind;
  issueId: string;
  taskId: string;
  title: string;
  taskStatus: string;
  runId?: string;
  runStatus?: string;
  safeAutomaticAction: 'finish' | 'note_only' | 'none';
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
};

function countFindings(findings: StuckStateFinding[]): Record<StuckStateKind, number> {
  const counts = { ...ZERO_COUNTS };
  for (const finding of findings) counts[finding.kind] += 1;
  return counts;
}

function backlogFinding(item: CompletionBacklogItem): StuckStateFinding | undefined {
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
  if (item.action === 'system_blocked') return {
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

function extraFindings(repoRoot: string, issue: ControllerIssue, task: ControllerTask): StuckStateFinding[] {
  const findings: StuckStateFinding[] = [];
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
  if (counts.review_without_run || counts.running_without_active_run) recommendations.push('Use controller migrate-stuck-states --apply to annotate stale review/running states before retrying them.');
  return { scannedAt: new Date().toISOString(), counts, findings: trimmed, recommendations };
}

export function applyStuckStateMigration(repoRoot: string, options: ApplyStuckStateMigrationOptions = {}): ApplyStuckStateMigrationResult {
  const report = inspectStuckControllerStates(repoRoot, { limit: options.limit ?? 100 });
  const dryRun = options.dryRun !== false;
  const reviewer = options.reviewer?.trim() || 'repo-harness-stuck-state-migration';
  const selected = report.findings.filter((finding) => finding.safeAutomaticAction === 'note_only');
  let applied = 0;
  let skipped = 0;
  const errors: Array<{ issueId: string; taskId: string; error: string }> = [];
  if (!dryRun) {
    for (const finding of selected) {
      try {
        getIssue(repoRoot, finding.issueId);
        const note = `${reviewer}: ${finding.kind} inspected. ${finding.reason}`;
        if (finding.kind === 'retry_required' && options.markRetryRequired === true) {
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
