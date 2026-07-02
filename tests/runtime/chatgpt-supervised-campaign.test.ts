import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCampaign, getCampaign, setCampaignStatus, updateCampaign } from '../../src/runtime/workflow/campaigns/store';
import { reconcileCampaign } from '../../src/runtime/workflow/campaigns/engine';
import { submitCampaignReview } from '../../src/runtime/workflow/campaigns/review';
import { getExecutionJob, listExecutionJobs, transitionExecutionJob } from '../../src/runtime/execution/jobs/store';
import { listActiveLeases } from '../../src/runtime/resources/leases/store';
import { acquireControllerLock, releaseControllerLock } from '../../src/cli/repositories/locks';

const homes: string[] = [];
function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'repo-harness-campaign-'));
  homes.push(value);
  return value;
}
afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

function campaignInput(overrides: Record<string, unknown> = {}) {
  return {
    repoId: 'repo-a',
    checkoutId: 'checkout-a',
    requestId: 'campaign-request-1',
    semanticKey: 'campaign:test',
    title: 'Supervised campaign',
    goal: 'Reach a reviewable repository state.',
    acceptanceCriteria: ['All tasks reviewed'],
    tasks: [
      { taskId: 'T1', title: 'First', operation: 'record_candidate_finding', arguments: { semantic_key: 'one', title: 'One' } },
    ],
    ...overrides,
  } as any;
}

function forceReconcile(controllerHome: string, campaignId: string) {
  const current = getCampaign(controllerHome, 'repo-a', campaignId);
  if (current.nextReconcileAt) {
    updateCampaign(controllerHome, 'repo-a', campaignId, `force:${current.revision}`, (campaign) => {
      campaign.nextReconcileAt = undefined;
      return campaign;
    }, { wakeScheduler: false });
  }
  return reconcileCampaign(controllerHome, 'repo-a', campaignId);
}

function finishJob(controllerHome: string, jobId: string, status: 'succeeded' | 'failed', retryable = false) {
  transitionExecutionJob(controllerHome, 'repo-a', jobId, 'running');
  transitionExecutionJob(controllerHome, 'repo-a', jobId, status, status === 'failed'
    ? { error: { code: 'TEST_FAILURE', message: 'fixture failed', retryable } }
    : { result: { ok: true } });
}

describe('ChatGPT-supervised campaigns', () => {
  test('deduplicates campaign creation and validates the task DAG', () => {
    const controllerHome = home();
    const first = createCampaign(controllerHome, campaignInput());
    const second = createCampaign(controllerHome, campaignInput());
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.campaign.campaignId).toBe(first.campaign.campaignId);
    expect(() => createCampaign(controllerHome, campaignInput({
      requestId: 'cycle-request',
      semanticKey: 'cycle',
      tasks: [
        { taskId: 'A', title: 'A', operation: 'record_candidate_finding', dependsOn: ['B'] },
        { taskId: 'B', title: 'B', operation: 'record_candidate_finding', dependsOn: ['A'] },
      ],
    }))).toThrow('CAMPAIGN_TASK_CYCLE');
  });

  test('dispatches independent tasks up to capacity without duplicate Jobs', () => {
    const controllerHome = home();
    const created = createCampaign(controllerHome, campaignInput({
      budget: { maxParallelTasks: 2 },
      tasks: ['T1', 'T2', 'T3'].map((taskId) => ({
        taskId,
        title: taskId,
        operation: 'record_candidate_finding',
        arguments: { semantic_key: taskId, title: taskId },
      })),
    })).campaign;
    const first = reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    const second = reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    expect(first.dispatched).toBe(2);
    expect(second.dispatched).toBe(0);
    expect(listExecutionJobs(controllerHome, 'repo-a', 20)).toHaveLength(2);
    const campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    expect(campaign.tasks.filter((task) => task.status === 'queued')).toHaveLength(2);
    expect(campaign.tasks.filter((task) => task.status === 'pending')).toHaveLength(1);
  });

  test('keeps unrelated work moving when another task fails', () => {
    const controllerHome = home();
    const created = createCampaign(controllerHome, campaignInput({
      budget: { maxParallelTasks: 2, defaultTaskMaxAttempts: 1 },
      tasks: ['T1', 'T2', 'T3'].map((taskId) => ({
        taskId,
        title: taskId,
        operation: 'record_candidate_finding',
        arguments: { semantic_key: taskId, title: taskId },
        maxAttempts: 1,
      })),
    })).campaign;
    reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    let campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    finishJob(controllerHome, campaign.tasks[0].jobId!, 'failed');
    finishJob(controllerHome, campaign.tasks[1].jobId!, 'succeeded');
    const result = forceReconcile(controllerHome, created.campaignId);
    campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    expect(result.dispatched).toBe(1);
    expect(campaign.tasks[2].status).toBe('queued');
    expect(campaign.checkpoints.some((checkpoint) => checkpoint.kind === 'failure' && checkpoint.taskId === 'T1')).toBe(true);
    expect(campaign.checkpoints.some((checkpoint) => checkpoint.kind === 'task_review' && checkpoint.taskId === 'T2')).toBe(true);
  });

  test('forces agent tasks into an isolated worktree claim', () => {
    const controllerHome = home();
    const created = createCampaign(controllerHome, campaignInput({
      tasks: [{
        taskId: 'T1',
        title: 'Implement feature',
        operation: 'dispatch_task',
        arguments: { issue_id: 'ISS-1', task_id: 'T1', agent: 'codex' },
      }],
    })).campaign;
    reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    const campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    const job = getExecutionJob(controllerHome, 'repo-a', campaign.tasks[0].jobId!);
    expect(job.payload.arguments?.isolate).toBe(true);
    expect(job.resourceClaims).toEqual([{ resourceKey: 'worktree:ISS-1-T1', mode: 'write' }]);
  });

  test('review waiting holds no campaign lease and rejects stale decisions', () => {
    const controllerHome = home();
    const created = createCampaign(controllerHome, campaignInput()).campaign;
    reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    let campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    finishJob(controllerHome, campaign.tasks[0].jobId!, 'succeeded');
    forceReconcile(controllerHome, created.campaignId);
    campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    const checkpoint = campaign.checkpoints.find((entry) => entry.kind === 'task_review')!;
    expect(campaign.tasks[0].status).toBe('waiting_review');
    expect(listActiveLeases(controllerHome, 'repo-a')).toHaveLength(0);
    expect(() => submitCampaignReview(controllerHome, {
      repoId: 'repo-a', campaignId: campaign.campaignId, checkpointId: checkpoint.checkpointId,
      nonce: 'wrong', goalRevision: checkpoint.goalRevision, requestId: 'stale-review',
      decision: { action: 'accept', summary: 'Looks good.', submittedBy: 'chatgpt' },
    })).toThrow('CAMPAIGN_CHECKPOINT_NONCE_MISMATCH');
  });

  test('completes the supervisor loop and stops at human acceptance', () => {
    const controllerHome = home();
    const created = createCampaign(controllerHome, campaignInput()).campaign;
    reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    let campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    finishJob(controllerHome, campaign.tasks[0].jobId!, 'succeeded');
    forceReconcile(controllerHome, created.campaignId);
    campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    let checkpoint = campaign.checkpoints.find((entry) => entry.kind === 'task_review')!;
    campaign = submitCampaignReview(controllerHome, {
      repoId: 'repo-a', campaignId: campaign.campaignId, checkpointId: checkpoint.checkpointId,
      nonce: checkpoint.nonce, goalRevision: checkpoint.goalRevision, expectedCampaignRevision: campaign.revision,
      requestId: 'accept-task', decision: { action: 'accept', summary: 'Implementation is aligned.', submittedBy: 'chatgpt' },
    });
    forceReconcile(controllerHome, campaign.campaignId);
    campaign = getCampaign(controllerHome, 'repo-a', campaign.campaignId);
    checkpoint = campaign.checkpoints.find((entry) => entry.kind === 'final' && entry.status === 'open')!;
    expect(campaign.status).toBe('waiting_for_supervisor');
    campaign = submitCampaignReview(controllerHome, {
      repoId: 'repo-a', campaignId: campaign.campaignId, checkpointId: checkpoint.checkpointId,
      nonce: checkpoint.nonce, goalRevision: checkpoint.goalRevision, expectedCampaignRevision: campaign.revision,
      requestId: 'approve-final', decision: { action: 'approve_final', summary: 'Ready for human acceptance.', submittedBy: 'chatgpt' },
    });
    expect(campaign.status).toBe('ready_for_human_acceptance');
    campaign = setCampaignStatus(controllerHome, 'repo-a', campaign.campaignId, 'human-accept', 'completed', 'Accepted by human.', campaign.revision);
    expect(campaign.status).toBe('completed');
  });

  test('explicit change requests permit one bounded retry without a hot loop', () => {
    const controllerHome = home();
    const created = createCampaign(controllerHome, campaignInput({
      budget: { defaultTaskMaxAttempts: 1 },
      tasks: [{ taskId: 'T1', title: 'T1', operation: 'record_candidate_finding', maxAttempts: 1 }],
    })).campaign;
    reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    let campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    finishJob(controllerHome, campaign.tasks[0].jobId!, 'succeeded');
    forceReconcile(controllerHome, campaign.campaignId);
    campaign = getCampaign(controllerHome, 'repo-a', campaign.campaignId);
    const checkpoint = campaign.checkpoints.find((entry) => entry.kind === 'task_review')!;
    campaign = submitCampaignReview(controllerHome, {
      repoId: 'repo-a', campaignId: campaign.campaignId, checkpointId: checkpoint.checkpointId,
      nonce: checkpoint.nonce, goalRevision: checkpoint.goalRevision, expectedCampaignRevision: campaign.revision,
      requestId: 'request-changes', decision: { action: 'request_changes', summary: 'Add one missing case.', instructions: 'Cover the edge case.', submittedBy: 'chatgpt' },
    });
    expect(campaign.tasks[0].maxAttempts).toBe(2);
    forceReconcile(controllerHome, campaign.campaignId);
    campaign = getCampaign(controllerHome, 'repo-a', campaign.campaignId);
    expect(campaign.tasks[0].attempt).toBe(2);
    expect(listExecutionJobs(controllerHome, 'repo-a', 20)).toHaveLength(2);
  });

  test('treats duplicate supervisor submissions as idempotent and rejects conflicting reuse', () => {
    const controllerHome = home();
    const created = createCampaign(controllerHome, campaignInput()).campaign;
    reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    let campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    finishJob(controllerHome, campaign.tasks[0].jobId!, 'succeeded');
    forceReconcile(controllerHome, created.campaignId);
    campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    const checkpoint = campaign.checkpoints.find((entry) => entry.kind === 'task_review')!;
    const first = submitCampaignReview(controllerHome, {
      repoId: 'repo-a', campaignId: campaign.campaignId, checkpointId: checkpoint.checkpointId,
      nonce: checkpoint.nonce, goalRevision: checkpoint.goalRevision, requestId: 'same-review',
      decision: { action: 'accept', summary: 'Accepted.', submittedBy: 'chatgpt' },
    });
    const duplicate = submitCampaignReview(controllerHome, {
      repoId: 'repo-a', campaignId: campaign.campaignId, checkpointId: checkpoint.checkpointId,
      nonce: checkpoint.nonce, goalRevision: checkpoint.goalRevision, requestId: 'same-review',
      decision: { action: 'accept', summary: 'Accepted.', submittedBy: 'chatgpt' },
    });
    expect(duplicate.revision).toBe(first.revision);
    expect(() => submitCampaignReview(controllerHome, {
      repoId: 'repo-a', campaignId: campaign.campaignId, checkpointId: checkpoint.checkpointId,
      nonce: checkpoint.nonce, goalRevision: checkpoint.goalRevision, requestId: 'same-review',
      decision: { action: 'skip', summary: 'Different decision.', submittedBy: 'chatgpt' },
    })).toThrow('CAMPAIGN_REQUEST_ID_CONFLICT');
  });

  test('goal revision supersedes stale checkpoints and reopens bounded reviews', () => {
    const controllerHome = home();
    const created = createCampaign(controllerHome, campaignInput({
      budget: { maxParallelTasks: 2 },
      tasks: ['T1', 'T2'].map((taskId) => ({ taskId, title: taskId, operation: 'record_candidate_finding' })),
    })).campaign;
    reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    let campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    finishJob(controllerHome, campaign.tasks[0].jobId!, 'succeeded');
    finishJob(controllerHome, campaign.tasks[1].jobId!, 'succeeded');
    forceReconcile(controllerHome, campaign.campaignId);
    campaign = getCampaign(controllerHome, 'repo-a', campaign.campaignId);
    const oldOpen = campaign.checkpoints.filter((entry) => entry.status === 'open');
    const target = oldOpen[0];
    campaign = submitCampaignReview(controllerHome, {
      repoId: 'repo-a', campaignId: campaign.campaignId, checkpointId: target.checkpointId,
      nonce: target.nonce, goalRevision: target.goalRevision, requestId: 'revise-goal',
      decision: {
        action: 'revise_goal', summary: 'Clarify acceptance.', submittedBy: 'chatgpt',
        revisedGoal: { statement: 'Reach a reviewable and documented repository state.' },
      },
    });
    expect(campaign.goals).toHaveLength(2);
    expect(campaign.goals[1].goalHash).not.toBe(campaign.goals[0].goalHash);
    expect(campaign.checkpoints.filter((entry) => entry.status === 'open')).toHaveLength(2);
    expect(campaign.checkpoints.filter((entry) => entry.status === 'open').every((entry) => entry.goalRevision === 2)).toBe(true);
    expect(campaign.checkpoints.some((entry) => entry.status === 'superseded')).toBe(true);
  });

  test('uses per-campaign locks so one locked campaign does not block another', () => {
    const controllerHome = home();
    const first = createCampaign(controllerHome, campaignInput()).campaign;
    const second = createCampaign(controllerHome, campaignInput({ requestId: 'campaign-request-2', semanticKey: 'campaign:test:2' })).campaign;
    const key = { scope: 'task' as const, repoId: 'repo-a', taskId: `campaign-${first.campaignId}` };
    const lock = acquireControllerLock(controllerHome, key, 'test-owner', 60_000);
    try {
      expect(() => reconcileCampaign(controllerHome, 'repo-a', second.campaignId)).not.toThrow();
      expect(() => reconcileCampaign(controllerHome, 'repo-a', first.campaignId)).toThrow('LOCK_HELD');
    } finally {
      releaseControllerLock(controllerHome, key, lock.lockId);
    }
  });


  test('pauses instead of waiting forever when an operation supervisor never submits a decision', () => {
    const controllerHome = home();
    const created = createCampaign(controllerHome, campaignInput({
      supervisor: {
        mode: 'operation', operation: 'record_candidate_finding', maxTriggerAttempts: 1,
        triggerCooldownMs: 1_000, decisionTimeoutMs: 1_000,
      },
    })).campaign;
    reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    let campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    finishJob(controllerHome, campaign.tasks[0].jobId!, 'succeeded');
    forceReconcile(controllerHome, campaign.campaignId);
    campaign = getCampaign(controllerHome, 'repo-a', campaign.campaignId);
    const checkpoint = campaign.checkpoints.find((entry) => entry.kind === 'task_review')!;
    expect(checkpoint.triggerJobId).toBeTruthy();
    finishJob(controllerHome, checkpoint.triggerJobId!, 'succeeded');
    campaign = updateCampaign(controllerHome, 'repo-a', campaign.campaignId, 'expire-supervisor-response', (current) => {
      const currentCheckpoint = current.checkpoints.find((entry) => entry.checkpointId === checkpoint.checkpointId)!;
      currentCheckpoint.triggeredAt = new Date(Date.now() - 10_000).toISOString();
      current.nextReconcileAt = undefined;
      return current;
    }, { requestFingerprint: 'expire-supervisor-response', wakeScheduler: false });
    reconcileCampaign(controllerHome, 'repo-a', campaign.campaignId);
    campaign = getCampaign(controllerHome, 'repo-a', campaign.campaignId);
    expect(campaign.status).toBe('paused');
    expect(campaign.pauseReason).toContain('Supervisor unavailable');
  });

});

describe('Workspace Agent campaign supervisor', () => {
  test('creates a lease-free, idempotent Workspace Agent trigger Job', () => {
    const controllerHome = home();
    const created = createCampaign(controllerHome, campaignInput({
      supervisor: {
        mode: 'workspace_agent',
        workspaceAgentId: 'agtch_repo_supervisor_1',
        conversationKey: 'repo-harness-review',
        maxTriggerAttempts: 2,
      },
    })).campaign;
    reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    let campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    finishJob(controllerHome, campaign.tasks[0].jobId!, 'succeeded');
    forceReconcile(controllerHome, campaign.campaignId);
    campaign = getCampaign(controllerHome, 'repo-a', campaign.campaignId);
    const checkpoint = campaign.checkpoints.find((entry) => entry.kind === 'task_review')!;
    const triggerJob = getExecutionJob(controllerHome, 'repo-a', checkpoint.triggerJobId!);
    expect(triggerJob.payload.target).toBe('workspace-agent');
    expect(triggerJob.payload.operation).toBe('trigger-workspace-agent');
    expect(triggerJob.payload.arguments?.agent_id).toBe('agtch_repo_supervisor_1');
    expect(triggerJob.payload.arguments?.conversation_key).toBe('repo-harness-review');
    expect(triggerJob.payload.arguments?.idempotency_key).toBe(`${checkpoint.checkpointId}:1`);
    expect(String(triggerJob.payload.arguments?.input)).toContain('submit_campaign_review');
    expect(triggerJob.resourceClaims).toEqual([]);
    expect(JSON.stringify(campaign)).not.toContain('ACCESS_TOKEN');
    expect(listActiveLeases(controllerHome, 'repo-a')).toHaveLength(0);
  });

  test('pauses on an ambiguous Workspace Agent outcome instead of risking a duplicate trigger', () => {
    const controllerHome = home();
    const created = createCampaign(controllerHome, campaignInput({
      supervisor: { mode: 'workspace_agent', workspaceAgentId: 'agtch_repo_supervisor_2' },
    })).campaign;
    reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    let campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    finishJob(controllerHome, campaign.tasks[0].jobId!, 'succeeded');
    forceReconcile(controllerHome, campaign.campaignId);
    campaign = getCampaign(controllerHome, 'repo-a', campaign.campaignId);
    const checkpoint = campaign.checkpoints.find((entry) => entry.kind === 'task_review')!;
    transitionExecutionJob(controllerHome, 'repo-a', checkpoint.triggerJobId!, 'running');
    transitionExecutionJob(controllerHome, 'repo-a', checkpoint.triggerJobId!, 'failed', {
      error: {
        code: 'WORKSPACE_AGENT_OUTCOME_AMBIGUOUS',
        message: 'The trigger may have been accepted before the network disconnected.',
        retryable: false,
      },
    });
    forceReconcile(controllerHome, campaign.campaignId);
    campaign = getCampaign(controllerHome, 'repo-a', campaign.campaignId);
    expect(campaign.status).toBe('paused');
    expect(campaign.pauseReason).toContain('requires attention');
  });

});
