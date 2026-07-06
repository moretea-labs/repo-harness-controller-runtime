import { createHash } from 'crypto';
import { getRepository, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { getAgentJob } from '../../../cli/agent-jobs/job-manager';
import { createExecutionJob, findExecutionJob, getExecutionJob } from '../../execution/jobs/store';
import type { ExecutionJob, ExecutionJobType, ResourceClaimSpec } from '../../execution/jobs/types';
import { claimsForMcpOperation } from '../../gateway/mcp/resource-policy';
import { assertAutomatedOperationAllowed } from '../../control-plane/governance/external-effects';
import type { AgentJobMeta } from '../../../cli/agent-jobs/types';
import type {
  Campaign,
  CampaignCheckpoint,
  CampaignReconcileResult,
  CampaignTask,
} from './types';
import { campaignProgress, openCampaignCheckpoint } from './review';
import { campaignSupervisorAdapter } from './supervisor';
import { getCampaign, listActiveCampaigns, updateCampaign } from './store';
import { assertCampaignOperationSupported, normalizeCampaignOperationName } from './normalize';

const AGENT_OPERATIONS = new Set(['dispatch_task', 'launch_issue', 'dispatch_ready_tasks', 'retry_task_run', 'quick_agent_session']);
const CAMPAIGN_CONTROL_OPERATIONS = new Set(['create_campaign', 'add_campaign_task', 'pause_campaign', 'resume_campaign', 'cancel_campaign', 'submit_campaign_review', 'accept_campaign', 'reconcile_campaign']);
const TERMINAL_JOB_FAILURES = new Set(['failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required']);
const ACTIVE_TASK_STATUSES = new Set<CampaignTask['status']>(['queued', 'running']);
const SUCCESS_TASK_STATUSES = new Set<CampaignTask['status']>(['succeeded', 'succeeded_no_change', 'skipped']);

function now(): string { return new Date().toISOString(); }

function operationJobType(operation: string): ExecutionJobType {
  operation = normalizeCampaignOperationName(operation);
  if (AGENT_OPERATIONS.has(operation)) return 'dispatch-task';
  if (operation === 'run_check' || operation === 'verify_edit_session') return 'check';
  if (operation === 'integrate_task_run') return 'integration';
  if (operation === 'repository_command_execute') return 'repository-command';
  return 'mcp-tool';
}

function deterministicJitter(taskId: string, attempt: number, upperBound: number): number {
  if (upperBound <= 0) return 0;
  const digest = createHash('sha256').update(`${taskId}:${attempt}`).digest();
  return digest.readUInt32BE(0) % upperBound;
}

function retryDelayMs(campaign: Campaign, task: CampaignTask): number {
  const exponential = Math.min(
    campaign.budget.retryMaxDelayMs,
    campaign.budget.retryBaseDelayMs * (2 ** Math.max(0, task.attempt - 1)),
  );
  return Math.min(campaign.budget.retryMaxDelayMs, exponential + deterministicJitter(task.taskId, task.attempt, Math.max(1, Math.floor(exponential / 4))));
}

function readNestedString(value: unknown, key: string, depth = 0): string | undefined {
  if (depth > 5 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 100)) {
      const found = readNestedString(entry, key, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  for (const entry of Object.values(record).slice(0, 100)) {
    const found = readNestedString(entry, key, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function agentRunForTask(controllerHome: string, campaign: Campaign, task: CampaignTask, job: ExecutionJob): AgentJobMeta | undefined {
  const runId = task.runId ?? readNestedString(job.result, 'runId');
  if (!runId) return undefined;
  task.runId = runId;
  try {
    const repository = selectRepositoryCheckout(
      getRepository(campaign.repoId, controllerHome, { includeRemoved: true }),
      campaign.checkoutId,
    );
    return getAgentJob(repository.canonicalRoot, runId);
  } catch {
    return undefined;
  }
}

function mergeEvidence(task: CampaignTask, values: Array<string | undefined>): void {
  task.evidenceIds = [...new Set([...task.evidenceIds, ...values.filter((value): value is string => Boolean(value))])].slice(-200);
}

function markExecutionFailure(campaign: Campaign, task: CampaignTask, code: string, message: string, retryable: boolean): number {
  task.error = { code, message, retryable };
  task.jobId = undefined;
  task.executionFinishedAt = now();
  if (retryable && task.attempt < task.maxAttempts) {
    task.status = 'pending';
    task.nextAttemptAt = new Date(Date.now() + retryDelayMs(campaign, task)).toISOString();
    return 0;
  }
  task.status = 'failed';
  task.nextAttemptAt = undefined;
  if (!task.checkpointId) {
    if (campaign.counters.supervisorReviewsOpened >= campaign.budget.maxSupervisorReviews) {
      campaign.status = 'paused';
      campaign.pauseReason = 'Supervisor review budget exhausted after task failure.';
      return 0;
    }
    const opened = openCampaignCheckpoint(campaign, 'failure', task.taskId);
    return opened.created ? 1 : 0;
  }
  return 0;
}

function taskExecutionCompleted(campaign: Campaign, task: CampaignTask, outcome: 'changed' | 'no_change' = 'changed'): number {
  task.executionFinishedAt = now();
  task.error = undefined;
  task.nextAttemptAt = undefined;
  if (outcome === 'no_change') {
    if (task.requiresChanges) {
      task.status = 'failed_no_effect';
      task.outcome = 'no_effect';
      task.error = {
        code: 'CAMPAIGN_NO_EFFECT',
        message: 'Task required repository changes but the completed Run produced no diff.',
        retryable: false,
      };
      task.completedAt = task.executionFinishedAt;
      return 0;
    }
    task.status = 'succeeded_no_change';
    task.outcome = 'already_satisfied';
    task.completedAt = task.executionFinishedAt;
    return 0;
  }
  task.outcome = 'changed';
  const requiresReview = task.reviewRequired && campaign.reviewPolicy === 'every_task';
  if (!requiresReview) {
    task.status = 'succeeded';
    task.completedAt = task.executionFinishedAt;
    return 0;
  }
  if (campaign.counters.supervisorReviewsOpened >= campaign.budget.maxSupervisorReviews) {
    campaign.status = 'paused';
    campaign.pauseReason = 'Supervisor review budget exhausted.';
    return 0;
  }
  const opened = openCampaignCheckpoint(campaign, 'task_review', task.taskId);
  return opened.created ? 1 : 0;
}

function synchronizeTask(controllerHome: string, campaign: Campaign, task: CampaignTask): { changed: boolean; checkpointsOpened: number } {
  if (!task.jobId || !ACTIVE_TASK_STATUSES.has(task.status)) return { changed: false, checkpointsOpened: 0 };
  const job = findExecutionJob(controllerHome, task.jobId);
  if (!job) {
    const checkpointsOpened = markExecutionFailure(campaign, task, 'CAMPAIGN_JOB_MISSING', `Execution Job ${task.jobId} is missing.`, false);
    return { changed: true, checkpointsOpened };
  }
  mergeEvidence(task, job.evidenceIds);
  if (['queued', 'waiting_for_dependency', 'waiting_for_workspace', 'waiting_for_heavy_check', 'waiting_for_integration', 'waiting_for_release_barrier', 'dispatched'].includes(job.status)) {
    if (task.status !== 'queued') { task.status = 'queued'; return { changed: true, checkpointsOpened: 0 }; }
    return { changed: false, checkpointsOpened: 0 };
  }
  if (job.status === 'running') {
    if (task.status !== 'running') { task.status = 'running'; task.startedAt ??= job.startedAt ?? now(); return { changed: true, checkpointsOpened: 0 }; }
    return { changed: false, checkpointsOpened: 0 };
  }
  if (TERMINAL_JOB_FAILURES.has(job.status)) {
    const checkpointsOpened = markExecutionFailure(
      campaign,
      task,
      job.error?.code ?? `CAMPAIGN_JOB_${job.status.toUpperCase()}`,
      job.error?.message ?? `Execution Job ended as ${job.status}.`,
      job.error?.retryable === true,
    );
    return { changed: true, checkpointsOpened };
  }
  if (job.status !== 'succeeded') return { changed: false, checkpointsOpened: 0 };

  const operation = normalizeCampaignOperationName(task.operation);
  if (AGENT_OPERATIONS.has(operation) || task.runId || readNestedString(job.result, 'runId')) {
    const run = agentRunForTask(controllerHome, campaign, task, job);
    if (!run) {
      const checkpointsOpened = markExecutionFailure(campaign, task, 'CAMPAIGN_AGENT_RUN_MISSING', 'Agent operation completed without a readable Task Run.', true);
      return { changed: true, checkpointsOpened };
    }
    mergeEvidence(task, [run.runId, run.diffArtifactPath]);
    if (['queued', 'starting', 'running'].includes(run.status)) {
      if (task.status !== 'running') { task.status = 'running'; task.startedAt ??= run.startedAt ?? now(); return { changed: true, checkpointsOpened: 0 }; }
      return { changed: false, checkpointsOpened: 0 };
    }
    if (run.status === 'waiting_for_user') {
      const checkpointsOpened = markExecutionFailure(
        campaign,
        task,
        'CAMPAIGN_AGENT_WAITING_FOR_USER',
        run.autoIntegrationError ?? run.error ?? 'Agent Run requires user attention.',
        false,
      );
      return { changed: true, checkpointsOpened };
    }
    if (run.status === 'failed' || run.status === 'cancelled' || run.status === 'unknown') {
      const checkpointsOpened = markExecutionFailure(
        campaign,
        task,
        `CAMPAIGN_AGENT_${run.status.toUpperCase()}`,
        run.error ?? `Agent Run ended as ${run.status}.`,
        run.status === 'failed',
      );
      return { changed: true, checkpointsOpened };
    }
    if (run.status !== 'succeeded') return { changed: false, checkpointsOpened: 0 };
    const checkpointsOpened = taskExecutionCompleted(campaign, task, run.changeOutcome === 'no_change' ? 'no_change' : 'changed');
    return { changed: true, checkpointsOpened };
  }

  const changeOutcome = readNestedString(job.result, 'changeOutcome');
  const checkpointsOpened = taskExecutionCompleted(campaign, task, changeOutcome === 'no_change' ? 'no_change' : 'changed');
  return { changed: true, checkpointsOpened };
}

function dependencyState(campaign: Campaign, task: CampaignTask): 'ready' | 'waiting' | 'blocked' {
  for (const dependencyId of task.dependsOn) {
    const dependency = campaign.tasks.find((entry) => entry.taskId === dependencyId);
    if (!dependency) return 'blocked';
    if (SUCCESS_TASK_STATUSES.has(dependency.status)) continue;
    if (['failed', 'failed_no_effect', 'blocked', 'cancelled'].includes(dependency.status)) return 'blocked';
    return 'waiting';
  }
  return 'ready';
}

function taskOperation(task: CampaignTask): { operation: string; arguments: Record<string, unknown> } {
  const operation = assertCampaignOperationSupported(task.operation);
  const base = { ...(task.arguments ?? {}) };
  if (AGENT_OPERATIONS.has(operation)) base.isolate = true;
  if (task.supervisorInstructions) base.supervisor_instructions = task.supervisorInstructions;
  if (task.runId && operation === 'dispatch_task') {
    return {
      operation: 'retry_task_run',
      arguments: {
        run_id: task.runId,
        isolate: true,
        timeout_ms: task.executor?.runnerTimeoutMs,
        supervisor_instructions: task.supervisorInstructions,
      },
    };
  }
  return { operation, arguments: base };
}

function taskClaims(campaign: Campaign, task: CampaignTask, operation: string, args: Record<string, unknown>): ResourceClaimSpec[] {
  if (task.resourceClaims.length > 0) return task.resourceClaims;
  return claimsForMcpOperation(operation, args, campaign.repoId, campaign.checkoutId);
}

function dispatchTask(controllerHome: string, campaign: Campaign, task: CampaignTask): boolean {
  if (campaign.counters.executionJobsCreated >= campaign.budget.maxExecutionJobs) {
    campaign.status = 'paused';
    campaign.pauseReason = 'Campaign execution Job budget exhausted.';
    return false;
  }
  const nextAttempt = task.attempt + 1;
  let execution: ReturnType<typeof taskOperation>;
  try {
    execution = taskOperation(task);
  } catch (error) {
    task.status = 'blocked';
    task.executionFinishedAt = now();
    task.nextAttemptAt = undefined;
    task.error = {
      code: error instanceof Error && error.message.startsWith('CAMPAIGN_OPERATION_OBSOLETE')
        ? 'CAMPAIGN_OPERATION_OBSOLETE'
        : 'CAMPAIGN_OPERATION_INVALID',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
    return false;
  }
  if (CAMPAIGN_CONTROL_OPERATIONS.has(execution.operation)) throw new Error(`CAMPAIGN_RECURSIVE_OPERATION_DENIED: ${execution.operation}`);
  assertAutomatedOperationAllowed(execution.operation, execution.arguments);
  const requestId = `${campaign.requestId}:task:${task.taskId}:attempt:${nextAttempt}`;
  const created = createExecutionJob(controllerHome, {
    repoId: campaign.repoId,
    checkoutId: campaign.checkoutId,
    type: operationJobType(execution.operation),
    requestId,
    semanticKey: `campaign:${campaign.campaignId}:task:${task.taskId}:attempt:${nextAttempt}:${execution.operation}`,
    origin: { surface: 'system', actor: campaign.campaignId, correlationId: campaign.campaignId },
    payload: {
      operation: execution.operation,
      arguments: { ...execution.arguments, request_id: requestId },
      target: 'mcp-tool',
      profile: 'controller',
      enableDevRunner: task.executor?.enableDevRunner ?? true,
      enableChatgptBrowser: task.executor?.enableChatgptBrowser ?? false,
      allowedAgents: task.executor?.allowedAgents ?? (typeof execution.arguments.agent === 'string' ? [execution.arguments.agent] : ['codex']),
      runnerTimeoutMs: task.executor?.runnerTimeoutMs ?? campaign.budget.taskTimeoutMs,
      runnerMaxTimeoutMs: task.executor?.runnerMaxTimeoutMs ?? Math.max(campaign.budget.taskTimeoutMs, 12 * 60 * 60_000),
      campaignId: campaign.campaignId,
      campaignTaskId: task.taskId,
    },
    priority: task.priority,
    resourceClaims: taskClaims(campaign, task, execution.operation, execution.arguments),
    timeoutMs: campaign.budget.taskTimeoutMs,
    maxAttempts: 1,
  });
  task.attempt = nextAttempt;
  task.jobId = created.job.jobId;
  task.status = created.job.status === 'running' ? 'running' : 'queued';
  task.startedAt ??= now();
  task.nextAttemptAt = undefined;
  task.error = undefined;
  campaign.counters.executionJobsCreated += created.deduplicated ? 0 : 1;
  return true;
}

function openFinalCheckpointIfReady(campaign: Campaign): number {
  if (!campaign.tasks.every((task) => SUCCESS_TASK_STATUSES.has(task.status))) return 0;
  if (campaign.tasks.length > 0 && campaign.tasks.every((task) => task.status === 'succeeded_no_change' || task.status === 'skipped')) {
    campaign.status = 'ready_for_human_acceptance';
    campaign.completionOutcome = 'already_satisfied';
    return 0;
  }
  campaign.completionOutcome = 'changed';
  const currentGoalRevision = campaign.goals.at(-1)?.revision;
  const existing = campaign.checkpoints.find((checkpoint) => checkpoint.kind === 'final' && checkpoint.goalRevision === currentGoalRevision);
  if (existing?.status === 'open') {
    campaign.status = 'waiting_for_supervisor';
    return 0;
  }
  if (existing?.status === 'submitted' && campaign.status === 'ready_for_human_acceptance') return 0;
  if (campaign.counters.supervisorReviewsOpened >= campaign.budget.maxSupervisorReviews) {
    campaign.status = 'paused';
    campaign.pauseReason = 'Supervisor review budget exhausted before final review.';
    return 0;
  }
  const opened = openCampaignCheckpoint(campaign, 'final');
  campaign.status = 'waiting_for_supervisor';
  return opened.created ? 1 : 0;
}

function triggerSupervisor(controllerHome: string, campaign: Campaign, checkpoint: CampaignCheckpoint): boolean {
  if (campaign.supervisor.mode === 'pull') return false;
  if (campaign.supervisor.mode === 'operation' && !campaign.supervisor.operation) return false;
  if (campaign.supervisor.mode === 'workspace_agent' && !campaign.supervisor.workspaceAgentId) return false;
  if (checkpoint.status !== 'open') return false;
  if (checkpoint.nextTriggerAt && Date.parse(checkpoint.nextTriggerAt) > Date.now()) return false;
  if (checkpoint.triggerJobId) {
    const current = findExecutionJob(controllerHome, checkpoint.triggerJobId);
    const terminal = current?.status === 'succeeded' || (current ? TERMINAL_JOB_FAILURES.has(current.status) : false);
    if (current && !terminal) return false;
    if (current?.status === 'succeeded') {
      const triggeredAt = Date.parse(checkpoint.triggeredAt ?? current.finishedAt ?? current.updatedAt);
      const responseDeadline = Number.isFinite(triggeredAt)
        ? triggeredAt + campaign.supervisor.decisionTimeoutMs
        : Date.now();
      if (responseDeadline > Date.now()) {
        checkpoint.nextTriggerAt = new Date(responseDeadline).toISOString();
        return true;
      }
      checkpoint.triggerError = 'Supervisor trigger completed but no review decision was submitted before the response deadline.';
    } else {
      checkpoint.triggerError = current?.error?.message ?? 'Supervisor trigger Job is unavailable.';
      const permanentFailure = current?.error?.code === 'WORKSPACE_AGENT_OUTCOME_AMBIGUOUS'
        || current?.error?.code === 'WORKSPACE_AGENT_TOKEN_REQUIRED'
        || current?.error?.code === 'WORKSPACE_AGENT_ID_INVALID'
        || ['WORKSPACE_AGENT_HTTP_401', 'WORKSPACE_AGENT_HTTP_403', 'WORKSPACE_AGENT_HTTP_404', 'WORKSPACE_AGENT_HTTP_409']
          .includes(current?.error?.code ?? '');
      if (permanentFailure) {
        campaign.status = 'paused';
        campaign.pauseReason = `Supervisor trigger requires attention: ${checkpoint.triggerError}`;
        checkpoint.nextTriggerAt = undefined;
        return true;
      }
    }
    checkpoint.triggerJobId = undefined;
    checkpoint.triggeredAt = undefined;
    if (checkpoint.triggerAttempts >= campaign.supervisor.maxTriggerAttempts) {
      campaign.status = 'paused';
      campaign.pauseReason = `Supervisor unavailable after ${checkpoint.triggerAttempts} trigger attempt(s): ${checkpoint.triggerError}`;
      checkpoint.nextTriggerAt = undefined;
      return true;
    }
    checkpoint.nextTriggerAt = new Date(Date.now() + campaign.supervisor.triggerCooldownMs).toISOString();
    return true;
  }
  if (checkpoint.triggerAttempts >= campaign.supervisor.maxTriggerAttempts) {
    campaign.status = 'paused';
    campaign.pauseReason = `Supervisor trigger budget exhausted for checkpoint ${checkpoint.checkpointId}.`;
    checkpoint.nextTriggerAt = undefined;
    return true;
  }
  let trigger: ReturnType<ReturnType<typeof campaignSupervisorAdapter>['triggerSpec']>;
  try {
    trigger = campaignSupervisorAdapter(campaign).triggerSpec(campaign, checkpoint);
  } catch (error) {
    campaign.status = 'paused';
    campaign.pauseReason = `Supervisor trigger requires attention: ${error instanceof Error ? error.message : String(error)}`;
    checkpoint.nextTriggerAt = undefined;
    return true;
  }
  if (!trigger) return false;
  if ((trigger.target ?? 'mcp-tool') === 'mcp-tool') {
    assertAutomatedOperationAllowed(trigger.operation, trigger.arguments);
  }
  const attempt = checkpoint.triggerAttempts + 1;
  const requestId = `${campaign.requestId}:checkpoint:${checkpoint.checkpointId}:trigger:${attempt}`;
  const created = createExecutionJob(controllerHome, {
    repoId: campaign.repoId,
    checkoutId: campaign.checkoutId,
    type: 'mcp-tool',
    requestId,
    semanticKey: `campaign-supervisor:${campaign.campaignId}:${checkpoint.checkpointId}:${attempt}`,
    origin: { surface: 'system', actor: campaign.campaignId, correlationId: checkpoint.checkpointId },
    payload: {
      operation: trigger.operation,
      arguments: trigger.arguments,
      target: trigger.target ?? 'mcp-tool',
      profile: 'controller',
      campaignSupervisorTrigger: true,
    },
    priority: trigger.priority,
    resourceClaims: trigger.resourceClaims,
    timeoutMs: Math.min(campaign.budget.taskTimeoutMs, trigger.timeoutMs ?? 15 * 60_000),
    maxAttempts: 1,
  });
  checkpoint.triggerJobId = created.job.jobId;
  checkpoint.triggerAttempts = attempt;
  checkpoint.triggeredAt = now();
  checkpoint.nextTriggerAt = undefined;
  checkpoint.triggerError = undefined;
  campaign.counters.executionJobsCreated += created.deduplicated ? 0 : 1;
  return true;
}

function campaignHasRunnableTask(campaign: Campaign): boolean {
  return campaign.tasks.some((task) => {
    if (!['pending', 'changes_requested'].includes(task.status)) return false;
    if (task.nextAttemptAt && Date.parse(task.nextAttemptAt) > Date.now()) return false;
    return dependencyState(campaign, task) === 'ready';
  });
}

function setDerivedCampaignStatus(campaign: Campaign): void {
  if (['paused', 'ready_for_human_acceptance', 'completed', 'failed', 'cancelling', 'cancelled', 'cancelled_with_leaks'].includes(campaign.status)) return;
  const openCheckpoints = campaign.checkpoints.some((checkpoint) => checkpoint.status === 'open');
  const activeTasks = campaign.tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status));
  const runnable = campaignHasRunnableTask(campaign);
  if (!activeTasks && !runnable && campaign.tasks.some((task) => task.status === 'failed_no_effect')) {
    campaign.status = 'failed';
    campaign.failureReason = 'At least one task required repository changes but completed with no effect.';
  } else if (openCheckpoints && !activeTasks && !runnable) campaign.status = 'waiting_for_supervisor';
  else campaign.status = 'active';
}

function campaignNeedsReconcile(campaign: Campaign, timestamp = Date.now()): boolean {
  if (!['active', 'waiting_for_supervisor'].includes(campaign.status)) return false;
  if (campaign.nextReconcileAt && Date.parse(campaign.nextReconcileAt) > timestamp) return false;
  if (campaign.status === 'active') return true;
  if (campaign.tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status)) || campaignHasRunnableTask(campaign)) return true;
  if (campaign.supervisor.mode === 'pull') return false;
  return campaign.checkpoints.some((checkpoint) => {
    if (checkpoint.status !== 'open') return false;
    if (checkpoint.triggerJobId) return true;
    if (checkpoint.triggerAttempts >= campaign.supervisor.maxTriggerAttempts) return false;
    return !checkpoint.nextTriggerAt || Date.parse(checkpoint.nextTriggerAt) <= timestamp;
  });
}

export function reconcileCampaign(controllerHome: string, repoId: string, campaignId: string): CampaignReconcileResult {
  let dispatched = 0;
  let checkpointsOpened = 0;
  let changed = false;
  const before = getCampaign(controllerHome, repoId, campaignId);
  if (!campaignNeedsReconcile(before)) {
    return { campaignId, changed: false, dispatched: 0, checkpointsOpened: 0, status: before.status };
  }
  const updated = updateCampaign(controllerHome, repoId, campaignId, `reconcile:${campaignId}:${before.revision}`, (campaign) => {
    if (!campaignNeedsReconcile(campaign)) return campaign;

    for (const task of campaign.tasks) {
      const synchronized = synchronizeTask(controllerHome, campaign, task);
      changed ||= synchronized.changed;
      checkpointsOpened += synchronized.checkpointsOpened;
    }

    for (const task of campaign.tasks) {
      const dependency = dependencyState(campaign, task);
      if (task.status === 'blocked' && task.error?.code === 'CAMPAIGN_DEPENDENCY_BLOCKED' && dependency !== 'blocked') {
        task.status = 'pending';
        task.error = undefined;
        changed = true;
      }
      if (!['pending', 'changes_requested'].includes(task.status)) continue;
      if (dependency === 'blocked') {
        task.status = 'blocked';
        task.error = { code: 'CAMPAIGN_DEPENDENCY_BLOCKED', message: 'A required campaign task failed or is blocked.', retryable: false };
        changed = true;
      }
    }

    const running = campaign.tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status)).length;
    let capacity = Math.max(0, campaign.budget.maxParallelTasks - running);
    const candidates = campaign.tasks
      .filter((task) => ['pending', 'changes_requested'].includes(task.status))
      .filter((task) => !task.nextAttemptAt || Date.parse(task.nextAttemptAt) <= Date.now())
      .filter((task) => dependencyState(campaign, task) === 'ready')
      .sort((left, right) => left.priority.localeCompare(right.priority) || left.taskId.localeCompare(right.taskId));
    for (const task of candidates) {
      if (capacity <= 0 || campaign.status === 'paused') break;
      if (dispatchTask(controllerHome, campaign, task)) {
        capacity -= 1;
        dispatched += 1;
        changed = true;
      }
    }

    checkpointsOpened += openFinalCheckpointIfReady(campaign);
    if (checkpointsOpened > 0) changed = true;

    for (const checkpoint of campaign.checkpoints.filter((entry) => entry.status === 'open')) {
      if (triggerSupervisor(controllerHome, campaign, checkpoint)) changed = true;
    }

    setDerivedCampaignStatus(campaign);
    const active = campaign.tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status));
    const retryTimes = campaign.tasks
      .map((task) => task.nextAttemptAt)
      .filter((value): value is string => Boolean(value))
      .map((value) => Date.parse(value))
      .filter(Number.isFinite);
    if (active) campaign.nextReconcileAt = new Date(Date.now() + 2_000).toISOString();
    else if (retryTimes.length > 0) campaign.nextReconcileAt = new Date(Math.min(...retryTimes)).toISOString();
    else if (campaign.status === 'waiting_for_supervisor' && campaign.supervisor.mode !== 'pull') {
      const open = campaign.checkpoints.filter((checkpoint) => checkpoint.status === 'open');
      const explicitTimes = open.flatMap((checkpoint) => checkpoint.nextTriggerAt ? [Date.parse(checkpoint.nextTriggerAt)] : []);
      const monitorsActiveTrigger = open.some((checkpoint) => Boolean(checkpoint.triggerJobId));
      campaign.nextReconcileAt = explicitTimes.length > 0
        ? new Date(Math.min(...explicitTimes)).toISOString()
        : monitorsActiveTrigger ? new Date(Date.now() + 2_000).toISOString() : undefined;
    } else campaign.nextReconcileAt = undefined;
    return campaign;
  }, {
    eventType: 'campaign_reconciled',
    eventData: { dispatched, checkpointsOpened, progress: campaignProgress(before) },
    wakeScheduler: dispatched > 0,
  });
  return { campaignId, changed: changed || updated.revision !== before.revision, dispatched, checkpointsOpened, status: updated.status };
}

export interface TickCampaignsOptions {
  maxCampaigns?: number;
}

export function tickCampaigns(controllerHome: string, repoIds: string[], options: TickCampaignsOptions = {}): CampaignReconcileResult[] {
  const maximum = Math.max(1, Math.min(options.maxCampaigns ?? 64, 1_000));
  const campaigns = repoIds
    .flatMap((repoId) => listActiveCampaigns(controllerHome, repoId, maximum))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.campaignId.localeCompare(right.campaignId))
    .slice(0, maximum);
  const results: CampaignReconcileResult[] = [];
  for (const campaign of campaigns) {
    try {
      results.push(reconcileCampaign(controllerHome, campaign.repoId, campaign.campaignId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('LOCK_HELD:')) continue;
      try {
        updateCampaign(controllerHome, campaign.repoId, campaign.campaignId, `reconcile-error:${campaign.campaignId}:${campaign.revision}`, (current) => {
          current.nextReconcileAt = new Date(Date.now() + 5_000).toISOString();
          return current;
        }, { eventType: 'campaign_reconcile_failed', eventData: { message }, wakeScheduler: false });
      } catch { /* preserve the original campaign for the next bounded tick */ }
    }
  }
  return results;
}
