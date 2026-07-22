import { getAgentJob, listAgentJobs } from '../agent-jobs/job-manager';
import type { AgentJobMeta } from '../agent-jobs/types';
import { getIssue, listIssues, projectIssueEffectiveView, updateTask } from './issue-store';
import { completionEvidenceComplete, taskExecutionPolicy } from './execution-policy';
import type { ControllerIssue, ControllerTask, TaskStatus } from './types';
import { finishTaskRun, type FinishTaskRunResult } from './completion-orchestrator';
import { resolveCompletionTargetBranch } from './completion-target';

export type CompletionBacklogAction =
  | 'auto_finish'
  | 'needs_human_review'
  | 'retry_required'
  | 'system_blocked'
  | 'already_terminal'
  | 'no_run_evidence';

export interface CompletionBacklogItem {
  issueId: string;
  taskId: string;
  title: string;
  taskStatus: TaskStatus;
  effectiveStatus?: string;
  verificationStatus?: string;
  runId?: string;
  runStatus?: AgentJobMeta['status'];
  executionClass: ReturnType<typeof taskExecutionPolicy>['executionClass'];
  action: CompletionBacklogAction;
  reason: string;
  canAutoFinish: boolean;
  suggestedDecision: 'auto' | 'approve_and_finish' | 'request_changes' | 'retry' | 'inspect';
}

export interface CompletionBacklogReport {
  scannedAt: string;
  counts: Record<CompletionBacklogAction, number>;
  finishableRunIds: string[];
  needsHumanReviewRunIds: string[];
  retryTaskRefs: Array<{ issueId: string; taskId: string; runId?: string }>;
  items: CompletionBacklogItem[];
  recommendations: string[];
}

export interface FinishCompletionBacklogOptions {
  dryRun?: boolean;
  limit?: number;
  commit?: boolean;
  cleanup?: boolean;
  reviewer?: string;
}

export interface FinishCompletionBacklogResult {
  dryRun: boolean;
  attempted: number;
  finished: number;
  needsDecision: number;
  blocked: number;
  errors: Array<{ runId: string; error: string }>;
  selected: CompletionBacklogItem[];
  results: FinishTaskRunResult[];
  report: CompletionBacklogReport;
}

const ACTIVE_REVIEW_STATUSES = new Set<TaskStatus>([
  'running',
  'blocked',
  'review',
  'verifying',
  'ready_to_integrate',
  'integrating',
  'integration_blocked',
  'integrated',
  'cleanup_pending',
  'cleanup_blocked',
  'verified',
  'changes_requested',
]);
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(['done', 'cancelled', 'superseded']);
const FINISHABLE_RUN_STATUSES = new Set<AgentJobMeta['status']>(['succeeded', 'waiting_for_user']);
const RETRY_RUN_STATUSES = new Set<AgentJobMeta['status']>(['failed', 'cancelled', 'unknown']);

function latestKnownRun(repoRoot: string, task: ControllerTask): AgentJobMeta | undefined {
  for (const runId of [...task.runIds].reverse()) {
    try {
      return getAgentJob(repoRoot, runId);
    } catch (_error) {
      // Run metadata can be pruned independently from task history; keep scanning older ids.
    }
  }
  return undefined;
}

function itemCounts(items: CompletionBacklogItem[]): Record<CompletionBacklogAction, number> {
  const counts: Record<CompletionBacklogAction, number> = {
    auto_finish: 0,
    needs_human_review: 0,
    retry_required: 0,
    system_blocked: 0,
    already_terminal: 0,
    no_run_evidence: 0,
  };
  for (const item of items) counts[item.action] += 1;
  return counts;
}

function effectiveTask(issue: ReturnType<typeof projectIssueEffectiveView>, taskId: string): (ControllerTask & Record<string, unknown>) | undefined {
  return issue.tasks.find((task) => task.id === taskId) as (ControllerTask & Record<string, unknown>) | undefined;
}

function classifyTask(repoRoot: string, issue: ControllerIssue, task: ControllerTask): CompletionBacklogItem | undefined {
  const policy = taskExecutionPolicy(task);
  const view = projectIssueEffectiveView(repoRoot, issue);
  const effective = effectiveTask(view, task.id);
  const run = latestKnownRun(repoRoot, task);
  const base = {
    issueId: issue.id,
    taskId: task.id,
    title: task.title,
    taskStatus: task.status,
    effectiveStatus: typeof effective?.effectiveStatus === 'string' ? effective.effectiveStatus : undefined,
    verificationStatus: typeof effective?.verificationStatus === 'string' ? effective.verificationStatus : undefined,
    runId: run?.runId,
    runStatus: run?.status,
    executionClass: policy.executionClass,
  };

  if (task.status === 'done') {
    if (!completionEvidenceComplete(task.verification, {
      issueId: issue.id,
      taskId: task.id,
      targetBranch: resolveCompletionTargetBranch(repoRoot),
    })) {
      return {
        ...base,
        action: 'system_blocked',
        reason: 'Task is declared done without a complete delivery receipt; run the stuck-state migration before any new execution.',
        canAutoFinish: false,
        suggestedDecision: 'inspect',
      };
    }
  }

  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return { ...base, action: 'already_terminal', reason: `Task is ${task.status}.`, canAutoFinish: false, suggestedDecision: 'inspect' };
  }

  if (run && FINISHABLE_RUN_STATUSES.has(run.status)) {
    if (policy.requiresHumanAcceptance) {
      return {
        ...base,
        action: 'needs_human_review',
        reason: `${policy.executionClass} requires explicit review before finishing ${run.runId}.`,
        canAutoFinish: false,
        suggestedDecision: 'approve_and_finish',
      };
    }
    return {
      ...base,
      action: 'auto_finish',
      reason: `Run ${run.runId} is ${run.status} and policy allows automatic finish.`,
      canAutoFinish: true,
      suggestedDecision: 'auto',
    };
  }

  if (run && RETRY_RUN_STATUSES.has(run.status)) {
    return {
      ...base,
      action: 'retry_required',
      reason: `Latest Run ${run.runId} ended as ${run.status}; a retry or explicit changes request is required.`,
      canAutoFinish: false,
      suggestedDecision: 'retry',
    };
  }

  if (ACTIVE_REVIEW_STATUSES.has(task.status) && !run) {
    return {
      ...base,
      action: 'no_run_evidence',
      reason: `Task is ${task.status} but has no readable Run evidence.`,
      canAutoFinish: false,
      suggestedDecision: 'inspect',
    };
  }

  if (task.status === 'blocked') {
    return {
      ...base,
      action: 'system_blocked',
      reason: 'Task is blocked without a finishable latest Run.',
      canAutoFinish: false,
      suggestedDecision: 'inspect',
    };
  }

  return undefined;
}

export function inspectCompletionBacklog(repoRoot: string, options: { includeTerminal?: boolean; limit?: number } = {}): CompletionBacklogReport {
  const limit = Math.max(1, Math.min(options.limit ?? 500, 5000));
  const issues = listIssues(repoRoot, { includeEphemeral: false });
  const items: CompletionBacklogItem[] = [];
  for (const issue of issues) {
    for (const task of issue.tasks) {
      const item = classifyTask(repoRoot, issue, task);
      if (!item) continue;
      if (!options.includeTerminal && item.action === 'already_terminal') continue;
      items.push(item);
      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }
  const counts = itemCounts(items);
  const finishableRunIds = items.filter((item) => item.action === 'auto_finish' && item.runId).map((item) => item.runId!);
  const needsHumanReviewRunIds = items.filter((item) => item.action === 'needs_human_review' && item.runId).map((item) => item.runId!);
  const retryTaskRefs = items
    .filter((item) => item.action === 'retry_required')
    .map((item) => ({ issueId: item.issueId, taskId: item.taskId, runId: item.runId }));
  const recommendations: string[] = [];
  if (finishableRunIds.length) recommendations.push(`Run controller finish-ready-runs --apply to close ${finishableRunIds.length} low/medium completed Run(s).`);
  if (needsHumanReviewRunIds.length) recommendations.push(`${needsHumanReviewRunIds.length} high/destructive Run(s) still need an explicit approve_and_finish/request_changes/discard decision.`);
  if (retryTaskRefs.length) recommendations.push(`${retryTaskRefs.length} task(s) need retry or changes_requested before they can progress.`);
  if (counts.no_run_evidence) recommendations.push(`${counts.no_run_evidence} task(s) have review-like status but no readable Run evidence; inspect or mark them explicitly.`);

  return {
    scannedAt: new Date().toISOString(),
    counts,
    finishableRunIds,
    needsHumanReviewRunIds,
    retryTaskRefs,
    items,
    recommendations,
  };
}

export function finishCompletionBacklog(repoRoot: string, options: FinishCompletionBacklogOptions = {}): FinishCompletionBacklogResult {
  const report = inspectCompletionBacklog(repoRoot, { limit: options.limit ?? 100 });
  const selected = report.items
    .filter((item) => item.action === 'auto_finish' && item.runId)
    .slice(0, Math.max(1, Math.min(options.limit ?? 25, 100)));
  const dryRun = options.dryRun !== false;
  const results: FinishTaskRunResult[] = [];
  const errors: Array<{ runId: string; error: string }> = [];

  if (!dryRun) {
    for (const item of selected) {
      try {
        results.push(finishTaskRun(repoRoot, {
          runId: item.runId!,
          decision: 'auto',
          reviewer: options.reviewer ?? 'repo-harness-completion-backlog',
          cleanup: options.cleanup !== false,
          commit: options.commit !== false,
        }));
      } catch (error) {
        errors.push({ runId: item.runId!, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return {
    dryRun,
    attempted: selected.length,
    finished: results.filter((entry) => ['finished', 'no_change', 'already_done'].includes(entry.action)).length,
    needsDecision: results.filter((entry) => entry.action === 'needs_decision').length,
    blocked: results.filter((entry) => entry.action === 'blocked').length,
    errors,
    selected,
    results,
    report,
  };
}

export function markBacklogTaskInspected(repoRoot: string, issueId: string, taskId: string, note: string): CompletionBacklogReport {
  getIssue(repoRoot, issueId); // preserve existing not-found errors and issue normalization.
  updateTask(repoRoot, issueId, taskId, { note });
  return inspectCompletionBacklog(repoRoot);
}

export function recentFinishableRuns(repoRoot: string, limit = 50): AgentJobMeta[] {
  return listAgentJobs(repoRoot, limit).filter((run) => FINISHABLE_RUN_STATUSES.has(run.status));
}

export interface CompletionDecisionQueues {
  scannedAt: string;
  counts: CompletionBacklogReport['counts'];
  autoFinish: CompletionBacklogItem[];
  needsHumanReview: CompletionBacklogItem[];
  retryRequired: CompletionBacklogItem[];
  noRunEvidence: CompletionBacklogItem[];
  systemBlocked: CompletionBacklogItem[];
  recentlyTerminal: CompletionBacklogItem[];
  recommendations: string[];
}

export type CompletionDecisionAction =
  | 'finish'
  | 'approve_and_finish'
  | 'request_changes'
  | 'discard'
  | 'mark_inspected'
  | 'retry_later';

export interface ApplyCompletionDecisionOptions {
  action: CompletionDecisionAction;
  runId?: string;
  issueId?: string;
  taskId?: string;
  note?: string;
  reviewer?: string;
  commit?: boolean;
  cleanup?: boolean;
}

export interface ApplyCompletionDecisionResult {
  action: CompletionDecisionAction;
  result: FinishTaskRunResult | CompletionBacklogReport;
}

export function completionDecisionQueues(repoRoot: string, options: { includeTerminal?: boolean; limit?: number } = {}): CompletionDecisionQueues {
  const report = inspectCompletionBacklog(repoRoot, options);
  return {
    scannedAt: report.scannedAt,
    counts: report.counts,
    autoFinish: report.items.filter((item) => item.action === 'auto_finish'),
    needsHumanReview: report.items.filter((item) => item.action === 'needs_human_review'),
    retryRequired: report.items.filter((item) => item.action === 'retry_required'),
    noRunEvidence: report.items.filter((item) => item.action === 'no_run_evidence'),
    systemBlocked: report.items.filter((item) => item.action === 'system_blocked'),
    recentlyTerminal: report.items.filter((item) => item.action === 'already_terminal'),
    recommendations: report.recommendations,
  };
}

export function applyCompletionDecision(repoRoot: string, options: ApplyCompletionDecisionOptions): ApplyCompletionDecisionResult {
  const reviewer = options.reviewer?.trim() || 'repo-harness-completion-decision';
  if (options.action === 'finish' || options.action === 'approve_and_finish' || options.action === 'request_changes' || options.action === 'discard') {
    if (!options.runId) throw new Error(`${options.action} requires runId`);
    const decision = options.action === 'finish' ? 'auto' : options.action;
    return {
      action: options.action,
      result: finishTaskRun(repoRoot, {
        runId: options.runId,
        decision,
        reviewer,
        note: options.note,
        commit: options.commit !== false,
        cleanup: options.cleanup !== false,
      }),
    };
  }
  if (!options.issueId || !options.taskId) throw new Error(`${options.action} requires issueId and taskId`);
  const note = options.note?.trim() || `${reviewer}: ${options.action === 'retry_later' ? 'retry deferred for explicit follow-up' : 'inspected from completion decision queue'}.`;
  if (options.action === 'retry_later') {
    updateTask(repoRoot, options.issueId, options.taskId, { status: 'changes_requested', note });
  } else {
    updateTask(repoRoot, options.issueId, options.taskId, { note });
  }
  return { action: options.action, result: inspectCompletionBacklog(repoRoot) };
}
