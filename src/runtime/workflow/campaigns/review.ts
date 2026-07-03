import { randomUUID } from 'crypto';
import type {
  Campaign,
  CampaignCheckpoint,
  CampaignCheckpointKind,
  CampaignReviewPacket,
  CampaignReviewPacketTask,
  CampaignSupervisorDecision,
} from './types';
import { computeCampaignGoalHash, updateCampaign } from './store';
import { campaignSupervisorAdapter } from './supervisor';

function now(): string { return new Date().toISOString(); }

export function currentCampaignGoal(campaign: Campaign) {
  const goal = campaign.goals.at(-1);
  if (!goal) throw new Error('CAMPAIGN_GOAL_MISSING');
  return goal;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 3))}...`;
}

function taskPacket(task: Campaign['tasks'][number] | undefined): CampaignReviewPacketTask | undefined {
  if (!task) return undefined;
  return {
    taskId: task.taskId,
    title: truncate(task.title, 512),
    objective: truncate(task.objective, 4_000),
    status: task.status,
    attempt: task.attempt,
    operation: task.operation,
    jobId: task.jobId,
    runId: task.runId,
    error: task.error ? { ...task.error, message: truncate(task.error.message, 4_000) } : undefined,
    evidenceIds: task.evidenceIds.slice(-50),
  };
}

export function campaignProgress(campaign: Campaign): CampaignReviewPacket['progress'] {
  return {
    total: campaign.tasks.length,
    succeeded: campaign.tasks.filter((task) => ['succeeded', 'succeeded_no_change', 'skipped'].includes(task.status)).length,
    running: campaign.tasks.filter((task) => ['queued', 'running'].includes(task.status)).length,
    waitingReview: campaign.tasks.filter((task) => task.status === 'waiting_review').length,
    failed: campaign.tasks.filter((task) => ['failed', 'failed_no_effect'].includes(task.status)).length,
    blocked: campaign.tasks.filter((task) => task.status === 'blocked').length,
  };
}

function packetBytes(packet: CampaignReviewPacket): number {
  return Buffer.byteLength(JSON.stringify(packet));
}

function boundedReviewPacket(packet: CampaignReviewPacket, maximumBytes: number): CampaignReviewPacket {
  if (packetBytes(packet) <= maximumBytes) return packet;
  const reduced: CampaignReviewPacket = {
    ...packet,
    acceptanceCriteria: packet.acceptanceCriteria.slice(0, 30).map((value) => truncate(value, 1_000)),
    nonGoals: packet.nonGoals.slice(0, 20).map((value) => truncate(value, 1_000)),
    recentEvidenceIds: packet.recentEvidenceIds.slice(-20),
    task: packet.task ? {
      ...packet.task,
      title: truncate(packet.task.title, 256),
      objective: truncate(packet.task.objective, 1_500),
      evidenceIds: packet.task.evidenceIds.slice(-20),
      error: packet.task.error ? { ...packet.task.error, message: truncate(packet.task.error.message, 1_500) } : undefined,
    } : undefined,
    goal: truncate(packet.goal, 4_000),
    title: truncate(packet.title, 256),
  };
  if (packetBytes(reduced) <= maximumBytes) return reduced;
  return {
    ...reduced,
    acceptanceCriteria: reduced.acceptanceCriteria.slice(0, 10),
    nonGoals: reduced.nonGoals.slice(0, 5),
    recentEvidenceIds: reduced.recentEvidenceIds.slice(-5),
    task: reduced.task ? { ...reduced.task, objective: truncate(reduced.task.objective, 500), evidenceIds: reduced.task.evidenceIds.slice(-5) } : undefined,
    goal: truncate(reduced.goal, 1_500),
  };
}

export function buildCampaignReviewPacket(
  campaign: Campaign,
  checkpointId: string,
  kind: CampaignCheckpointKind,
  nonce: string,
  taskId?: string,
): CampaignReviewPacket {
  const goal = currentCampaignGoal(campaign);
  const task = taskId ? campaign.tasks.find((entry) => entry.taskId === taskId) : undefined;
  const evidence = campaign.tasks.flatMap((entry) => entry.evidenceIds).slice(-100);
  const packet: CampaignReviewPacket = {
    schemaVersion: 1,
    campaignId: campaign.campaignId,
    checkpointId,
    checkpointKind: kind,
    nonce,
    goalRevision: goal.revision,
    goalHash: goal.goalHash,
    title: campaign.title,
    goal: goal.statement,
    acceptanceCriteria: goal.acceptanceCriteria,
    nonGoals: goal.nonGoals,
    task: taskPacket(task),
    progress: campaignProgress(campaign),
    recentEvidenceIds: evidence,
    createdAt: now(),
    maxResponseBytes: campaign.budget.reviewPacketMaxBytes,
    workspace: {
      mode: campaign.workspace.mode,
      checkoutId: campaign.workspace.checkoutId,
      branch: campaign.workspace.branch,
      baseRevision: campaign.workspace.baseRevision,
      managed: campaign.workspace.managed,
    },
  };
  return boundedReviewPacket(packet, campaign.budget.reviewPacketMaxBytes);
}

export function openCampaignCheckpoint(
  campaign: Campaign,
  kind: CampaignCheckpointKind,
  taskId?: string,
): { campaign: Campaign; checkpoint: CampaignCheckpoint; created: boolean } {
  const existing = campaign.checkpoints.find((entry) => entry.status === 'open' && entry.kind === kind && entry.taskId === taskId);
  if (existing) return { campaign, checkpoint: existing, created: false };
  if (campaign.counters.supervisorReviewsOpened >= campaign.budget.maxSupervisorReviews) {
    campaign.status = 'paused';
    campaign.pauseReason = 'Supervisor review budget exhausted.';
    throw new Error('CAMPAIGN_SUPERVISOR_BUDGET_EXHAUSTED');
  }
  const checkpointId = `CP-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const nonce = randomUUID();
  const goal = currentCampaignGoal(campaign);
  const checkpoint: CampaignCheckpoint = {
    checkpointId,
    kind,
    status: 'open',
    nonce,
    goalRevision: goal.revision,
    taskId,
    packet: buildCampaignReviewPacket(campaign, checkpointId, kind, nonce, taskId),
    triggerAttempts: 0,
    createdAt: now(),
  };
  campaign.checkpoints.push(checkpoint);
  campaign.counters.supervisorReviewsOpened += 1;
  if (taskId) {
    const task = campaign.tasks.find((entry) => entry.taskId === taskId);
    if (task) {
      task.checkpointId = checkpointId;
      task.status = 'waiting_review';
    }
  }
  return { campaign, checkpoint, created: true };
}

function taskForCheckpoint(campaign: Campaign, checkpoint: CampaignCheckpoint) {
  if (!checkpoint.taskId) return undefined;
  const task = campaign.tasks.find((entry) => entry.taskId === checkpoint.taskId);
  if (!task) throw new Error(`CAMPAIGN_CHECKPOINT_TASK_MISSING: ${checkpoint.taskId}`);
  return task;
}

export interface SubmitCampaignReviewInput {
  repoId: string;
  campaignId: string;
  checkpointId: string;
  nonce: string;
  goalRevision: number;
  expectedCampaignRevision?: number;
  requestId: string;
  decision: Omit<CampaignSupervisorDecision, 'submittedAt'> & { submittedAt?: string };
}

export function submitCampaignReview(controllerHome: string, input: SubmitCampaignReviewInput): Campaign {
  return updateCampaign(controllerHome, input.repoId, input.campaignId, input.requestId, (campaign) => {
    const checkpoint = campaign.checkpoints.find((entry) => entry.checkpointId === input.checkpointId);
    if (!checkpoint) throw new Error(`CAMPAIGN_CHECKPOINT_NOT_FOUND: ${input.checkpointId}`);
    if (checkpoint.status !== 'open') throw new Error(`CAMPAIGN_CHECKPOINT_ALREADY_SUBMITTED: ${input.checkpointId}`);
    if (checkpoint.nonce !== input.nonce) throw new Error('CAMPAIGN_CHECKPOINT_NONCE_MISMATCH');
    if (checkpoint.goalRevision !== input.goalRevision || currentCampaignGoal(campaign).revision !== input.goalRevision) {
      throw new Error('CAMPAIGN_GOAL_REVISION_STALE');
    }
    const allowedActions = new Set(['accept', 'request_changes', 'retry', 'skip', 'pause', 'resume', 'approve_final', 'revise_goal', 'escalate']);
    if (!allowedActions.has(input.decision.action)) throw new Error(`CAMPAIGN_REVIEW_ACTION_INVALID: ${input.decision.action}`);
    const decision: CampaignSupervisorDecision = {
      ...input.decision,
      summary: input.decision.summary.trim(),
      submittedBy: input.decision.submittedBy.trim() || 'chatgpt',
      submittedAt: input.decision.submittedAt ?? now(),
    };
    if (!decision.summary) throw new Error('CAMPAIGN_REVIEW_SUMMARY_REQUIRED');
    campaignSupervisorAdapter(campaign).validateDecision(campaign, checkpoint, decision);
    checkpoint.status = 'submitted';
    checkpoint.decision = decision;
    checkpoint.submittedAt = decision.submittedAt;
    campaign.counters.supervisorDecisionsAccepted += 1;

    const task = taskForCheckpoint(campaign, checkpoint);
    const action = decision.action;
    if (action === 'revise_goal') {
      if (!decision.revisedGoal?.statement.trim()) throw new Error('CAMPAIGN_REVISED_GOAL_REQUIRED');
      const currentGoal = currentCampaignGoal(campaign);
      const statement = decision.revisedGoal.statement.trim();
      const acceptanceCriteria = decision.revisedGoal.acceptanceCriteria ?? currentGoal.acceptanceCriteria;
      const nonGoals = decision.revisedGoal.nonGoals ?? currentGoal.nonGoals;
      const nextGoalRevision = currentGoal.revision + 1;
      campaign.goals.push({
        revision: nextGoalRevision,
        goalHash: computeCampaignGoalHash(statement, acceptanceCriteria, nonGoals),
        statement,
        acceptanceCriteria,
        nonGoals,
        changedBy: decision.submittedBy,
        changedAt: decision.submittedAt,
        reason: decision.revisedGoal.reason ?? decision.summary,
      });
      const checkpointsToReopen = campaign.checkpoints.filter((entry) =>
        entry.goalRevision === currentGoal.revision
        && (entry.status === 'open' || entry.checkpointId === checkpoint.checkpointId),
      );
      for (const stale of checkpointsToReopen) {
        if (stale.checkpointId !== checkpoint.checkpointId) stale.status = 'superseded';
        const staleTask = taskForCheckpoint(campaign, stale);
        if (staleTask) {
          staleTask.checkpointId = undefined;
          staleTask.status = 'waiting_review';
        }
      }
      for (const stale of checkpointsToReopen) openCampaignCheckpoint(campaign, stale.kind, stale.taskId);
      campaign.status = 'waiting_for_supervisor';
      campaign.pauseReason = undefined;
      campaign.nextReconcileAt = undefined;
      return campaign;
    }

    if (checkpoint.kind === 'task_review' && task) {
      if (action === 'accept') {
        task.status = 'succeeded';
        task.completedAt = decision.submittedAt;
        task.error = undefined;
        task.supervisorInstructions = undefined;
        campaign.status = 'active';
      } else if (action === 'request_changes' || action === 'retry') {
        task.status = 'changes_requested';
        task.jobId = undefined;
        task.maxAttempts = Math.min(10, Math.max(task.maxAttempts, task.attempt + 1));
        task.checkpointId = undefined;
        task.nextAttemptAt = undefined;
        task.error = undefined;
        task.supervisorInstructions = decision.instructions ?? decision.summary;
        campaign.status = 'active';
      } else if (action === 'skip') {
        task.status = 'skipped';
        task.completedAt = decision.submittedAt;
        campaign.status = 'active';
      } else if (action === 'pause' || action === 'escalate') {
        campaign.status = 'paused';
        campaign.pauseReason = decision.summary;
      } else {
        throw new Error(`CAMPAIGN_REVIEW_ACTION_INVALID: ${action} for task_review`);
      }
    } else if (checkpoint.kind === 'failure' && task) {
      if (action === 'retry' || action === 'request_changes') {
        task.status = 'changes_requested';
        task.jobId = undefined;
        task.maxAttempts = Math.min(10, Math.max(task.maxAttempts, task.attempt + 1));
        task.checkpointId = undefined;
        task.nextAttemptAt = undefined;
        task.error = undefined;
        task.supervisorInstructions = decision.instructions ?? decision.summary;
        campaign.status = 'active';
      } else if (action === 'skip') {
        task.status = 'skipped';
        task.completedAt = decision.submittedAt;
        campaign.status = 'active';
      } else if (action === 'pause' || action === 'escalate') {
        campaign.status = 'paused';
        campaign.pauseReason = decision.summary;
      } else {
        throw new Error(`CAMPAIGN_REVIEW_ACTION_INVALID: ${action} for failure`);
      }
    } else if (checkpoint.kind === 'final') {
      if (action === 'approve_final' || action === 'accept') {
        campaign.status = 'ready_for_human_acceptance';
        campaign.pauseReason = undefined;
      } else if (action === 'request_changes' || action === 'pause' || action === 'escalate') {
        campaign.status = 'paused';
        campaign.pauseReason = decision.instructions ?? decision.summary;
      } else {
        throw new Error(`CAMPAIGN_REVIEW_ACTION_INVALID: ${action} for final`);
      }
    } else {
      if (action === 'accept' || action === 'resume') {
        campaign.status = 'active';
        campaign.pauseReason = undefined;
      } else if (action === 'pause' || action === 'escalate') {
        campaign.status = 'paused';
        campaign.pauseReason = decision.summary;
      } else {
        throw new Error(`CAMPAIGN_REVIEW_ACTION_INVALID: ${action} for ${checkpoint.kind}`);
      }
    }
    campaign.nextReconcileAt = undefined;
    return campaign;
  }, {
    expectedRevision: input.expectedCampaignRevision,
    eventType: 'campaign_review_submitted',
    eventData: { checkpointId: input.checkpointId, action: input.decision.action, goalRevision: input.goalRevision },
    requestFingerprint: JSON.stringify({ checkpointId: input.checkpointId, nonce: input.nonce, goalRevision: input.goalRevision, decision: input.decision }),
  });
}
