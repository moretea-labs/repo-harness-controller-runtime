import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireControllerLock, releaseControllerLock } from '../src/cli/repositories/locks';
import { createCampaign, getCampaign, updateCampaign } from '../src/runtime/workflow/campaigns/store';
import { reconcileCampaign } from '../src/runtime/workflow/campaigns/engine';
import { submitCampaignReview } from '../src/runtime/workflow/campaigns/review';
import { createExecutionJob, listExecutionJobs, transitionExecutionJob } from '../src/runtime/execution/jobs/store';
import { listActiveLeases } from '../src/runtime/resources/leases/store';
import { getRepository, registerRepository, selectRepositoryCheckout } from '../src/cli/repositories/registry';
import { ensureCampaignWorkspace } from '../src/runtime/workflow/campaigns/workspace';
import { executeExecutionJob } from '../src/runtime/execution/workers/executor';

const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-supervised-smoke-'));
const repoId = 'smoke-repo';
const workspaceFixtureRoot = mkdtempSync(join(tmpdir(), 'repo-harness-supervised-workspace-smoke-'));

function forceReconcile(campaignId: string) {
  const current = getCampaign(controllerHome, repoId, campaignId);
  if (current.nextReconcileAt) {
    updateCampaign(controllerHome, repoId, campaignId, `force:${campaignId}:${current.revision}`, (campaign) => {
      campaign.nextReconcileAt = undefined;
      return campaign;
    }, { wakeScheduler: false, requestFingerprint: `force:${campaignId}:${current.revision}` });
  }
  return reconcileCampaign(controllerHome, repoId, campaignId);
}

function finish(jobId: string, status: 'succeeded' | 'failed') {
  transitionExecutionJob(controllerHome, repoId, jobId, 'running');
  transitionExecutionJob(controllerHome, repoId, jobId, status, status === 'failed'
    ? { error: { code: 'SMOKE_FAILURE', message: 'intentional failure', retryable: false } }
    : { result: { ok: true } });
}

try {
  const campaign = createCampaign(controllerHome, {
    repoId,
    checkoutId: 'checkout-smoke',
    requestId: 'smoke-campaign',
    semanticKey: 'smoke:campaign',
    title: 'ChatGPT supervised smoke',
    goal: 'Reach human acceptance without blocking unrelated work.',
    acceptanceCriteria: ['Independent work continues after one failure'],
    reviewPolicy: 'every_task',
    budget: { maxParallelTasks: 2, defaultTaskMaxAttempts: 1 },
    tasks: [
      { taskId: 'T1', title: 'Fail independently', operation: 'record_candidate_finding', maxAttempts: 1 },
      { taskId: 'T2', title: 'Succeed independently', operation: 'record_candidate_finding', maxAttempts: 1 },
      { taskId: 'T3', title: 'Continue after failure', operation: 'record_candidate_finding', maxAttempts: 1 },
    ],
  }).campaign;

  const first = reconcileCampaign(controllerHome, repoId, campaign.campaignId);
  assert.equal(first.dispatched, 2);
  assert.equal(reconcileCampaign(controllerHome, repoId, campaign.campaignId).dispatched, 0);
  let current = getCampaign(controllerHome, repoId, campaign.campaignId);
  finish(current.tasks[0].jobId!, 'failed');
  finish(current.tasks[1].jobId!, 'succeeded');
  assert.equal(forceReconcile(campaign.campaignId).dispatched, 1);
  current = getCampaign(controllerHome, repoId, campaign.campaignId);
  assert.equal(current.tasks[2].status, 'queued');
  assert.equal(listActiveLeases(controllerHome, repoId).length, 0);

  const taskReview = current.checkpoints.find((checkpoint) => checkpoint.kind === 'task_review' && checkpoint.taskId === 'T2');
  assert.ok(taskReview);
  const reviewed = submitCampaignReview(controllerHome, {
    repoId,
    campaignId: current.campaignId,
    checkpointId: taskReview.checkpointId,
    nonce: taskReview.nonce,
    goalRevision: taskReview.goalRevision,
    expectedCampaignRevision: current.revision,
    requestId: 'smoke-accept-t2',
    decision: { action: 'accept', summary: 'Aligned.', submittedBy: 'chatgpt' },
  });
  const duplicate = submitCampaignReview(controllerHome, {
    repoId,
    campaignId: current.campaignId,
    checkpointId: taskReview.checkpointId,
    nonce: taskReview.nonce,
    goalRevision: taskReview.goalRevision,
    requestId: 'smoke-accept-t2',
    decision: { action: 'accept', summary: 'Aligned.', submittedBy: 'chatgpt' },
  });
  assert.equal(duplicate.revision, reviewed.revision);

  const second = createCampaign(controllerHome, {
    repoId,
    requestId: 'smoke-lock-campaign',
    semanticKey: 'smoke:lock',
    title: 'Lock isolation',
    goal: 'Prove per-campaign locking.',
    tasks: [{ taskId: 'L1', title: 'Lock test', operation: 'record_candidate_finding' }],
  }).campaign;
  const lock = acquireControllerLock(controllerHome, {
    scope: 'task', repoId, taskId: `campaign-${campaign.campaignId}`,
  }, 'smoke-lock-owner', 60_000);
  try {
    assert.doesNotThrow(() => reconcileCampaign(controllerHome, repoId, second.campaignId));
    assert.throws(() => reconcileCampaign(controllerHome, repoId, campaign.campaignId), /LOCK_HELD/);
  } finally {
    releaseControllerLock(controllerHome, { scope: 'task', repoId, taskId: `campaign-${campaign.campaignId}` }, lock.lockId);
  }

  const agentCampaign = createCampaign(controllerHome, {
    repoId,
    requestId: 'smoke-agent-campaign',
    semanticKey: 'smoke:agent',
    title: 'Agent isolation',
    goal: 'Dispatch Codex in an isolated worktree.',
    tasks: [{
      taskId: 'A1',
      title: 'Implement safely',
      operation: 'dispatch_task',
      arguments: { issue_id: 'ISS-SMOKE', task_id: 'A1', agent: 'codex' },
    }],
  }).campaign;
  reconcileCampaign(controllerHome, repoId, agentCampaign.campaignId);
  const agentState = getCampaign(controllerHome, repoId, agentCampaign.campaignId);
  const agentJob = listExecutionJobs(controllerHome, repoId, 100).find((job) => job.jobId === agentState.tasks[0].jobId)!;
  assert.equal(agentJob.payload.arguments?.isolate, true);
  assert.deepEqual(agentJob.resourceClaims, [{ resourceKey: 'worktree:ISS-SMOKE-A1', mode: 'write' }]);

  const workspaceSupervisorCampaign = createCampaign(controllerHome, {
    repoId,
    requestId: 'smoke-workspace-supervisor',
    semanticKey: 'smoke:workspace-supervisor',
    title: 'Workspace Agent supervisor',
    goal: 'Trigger ChatGPT without holding repository resources.',
    supervisor: { mode: 'workspace_agent', workspaceAgentId: 'agtch_smoke_supervisor' },
    tasks: [{ taskId: 'W1', title: 'Prepare review', operation: 'record_candidate_finding' }],
  }).campaign;
  reconcileCampaign(controllerHome, repoId, workspaceSupervisorCampaign.campaignId);
  let workspaceState = getCampaign(controllerHome, repoId, workspaceSupervisorCampaign.campaignId);
  finish(workspaceState.tasks[0].jobId!, 'succeeded');
  forceReconcile(workspaceState.campaignId);
  workspaceState = getCampaign(controllerHome, repoId, workspaceState.campaignId);
  const workspaceCheckpoint = workspaceState.checkpoints.find((checkpoint) => checkpoint.kind === 'task_review')!;
  const workspaceTrigger = listExecutionJobs(controllerHome, repoId, 100).find((job) => job.jobId === workspaceCheckpoint.triggerJobId)!;
  assert.equal(workspaceTrigger.payload.target, 'workspace-agent');
  assert.equal(workspaceTrigger.payload.arguments?.idempotency_key, `${workspaceCheckpoint.checkpointId}:1`);
  assert.equal(workspaceTrigger.resourceClaims.length, 0);
  transitionExecutionJob(controllerHome, repoId, workspaceTrigger.jobId, 'running');
  transitionExecutionJob(controllerHome, repoId, workspaceTrigger.jobId, 'failed', {
    error: { code: 'WORKSPACE_AGENT_OUTCOME_AMBIGUOUS', message: 'network outcome is uncertain', retryable: false },
  });
  forceReconcile(workspaceState.campaignId);
  workspaceState = getCampaign(controllerHome, repoId, workspaceState.campaignId);
  assert.equal(workspaceState.status, 'paused');

  const workspaceRepoRoot = join(workspaceFixtureRoot, 'repo');
  mkdirSync(workspaceRepoRoot, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', workspaceRepoRoot, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'smoke@example.com');
  git('config', 'user.name', 'Smoke Test');
  writeFileSync(join(workspaceRepoRoot, '.gitignore'), '.ai/\n');
  writeFileSync(join(workspaceRepoRoot, 'marker.txt'), 'source checkout\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const registered = registerRepository({ path: workspaceRepoRoot, controllerHome });
  const campaignWorkspace = ensureCampaignWorkspace(controllerHome, registered, {
    requestId: 'smoke-campaign-workspace',
    title: 'Campaign workspace isolation',
  });
  const repeatedWorkspace = ensureCampaignWorkspace(controllerHome, registered, {
    requestId: 'smoke-campaign-workspace',
    title: 'Campaign workspace isolation',
  });
  assert.deepEqual(repeatedWorkspace, campaignWorkspace);
  const repositoryAfterWorkspace = getRepository(registered.repoId, controllerHome);
  assert.equal(repositoryAfterWorkspace.activeCheckoutId, registered.activeCheckoutId);
  assert.equal(repositoryAfterWorkspace.checkouts.length, 2);
  assert.equal(selectRepositoryCheckout(repositoryAfterWorkspace, campaignWorkspace.checkoutId).canonicalRoot, campaignWorkspace.root);
  writeFileSync(join(campaignWorkspace.root!, 'marker.txt'), 'campaign checkout\n');
  const checkoutJob = createExecutionJob(controllerHome, {
    repoId: registered.repoId,
    checkoutId: campaignWorkspace.checkoutId,
    type: 'mcp-tool',
    requestId: 'smoke-checkout-routing',
    semanticKey: 'smoke:checkout-routing',
    origin: { surface: 'system', actor: 'smoke' },
    payload: {
      operation: 'read_repository_file',
      arguments: { path: 'marker.txt', start_line: 1, end_line: 2 },
      target: 'mcp-tool',
      profile: 'controller',
    },
    resourceClaims: [],
  });
  const checkoutResult = await executeExecutionJob(controllerHome, checkoutJob.job);
  assert.equal(checkoutResult.ok, true);
  assert.equal(checkoutResult.repoRoot, campaignWorkspace.root);
  assert.match(JSON.stringify(checkoutResult.result), /campaign checkout/);

  console.log(JSON.stringify({
    ok: true,
    campaigns: 4,
    jobs: listExecutionJobs(controllerHome, repoId, 100).length,
    invariants: ['idempotency', 'per-campaign-locking', 'failure-isolation', 'task-worktree-isolation', 'campaign-workspace-isolation', 'checkout-routing', 'lease-free-review', 'workspace-agent-trigger', 'ambiguous-trigger-stop'],
  }, null, 2));
} finally {
  rmSync(controllerHome, { recursive: true, force: true });
  rmSync(workspaceFixtureRoot, { recursive: true, force: true });
}
