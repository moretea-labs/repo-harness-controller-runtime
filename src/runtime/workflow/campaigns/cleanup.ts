import { existsSync, realpathSync } from 'fs';
import { resolve } from 'path';
import { getRepository, setRepositoryCheckoutLifecycle } from '../../../cli/repositories/registry';
import { runProcess } from '../../../effects/process-runner';
import { cancelExecutionJob, findExecutionJob } from '../../execution/jobs/store';
import type { Campaign, CampaignCleanupReport, CampaignCleanupResource } from './types';
import { getCampaign, updateCampaign } from './store';

function now(): string { return new Date().toISOString(); }

function git(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = runProcess('git', ['-C', root, ...args], {
    timeoutMs: 120_000,
    maxOutputBytes: 256 * 1024,
  });
  return { ok: result.ok, stdout: result.stdout.trim(), stderr: result.stderr || result.error || '' };
}

function samePath(left: string, right: string): boolean {
  try { return realpathSync(left) === realpathSync(right); }
  catch { return resolve(left) === resolve(right); }
}

function cleanupManagedWorkspace(
  controllerHome: string,
  campaign: Campaign,
): { resources: CampaignCleanupResource[]; leaks: string[] } {
  const resources: CampaignCleanupResource[] = [];
  const leaks: string[] = [];
  const workspace = campaign.workspace;
  if (!workspace.managed || workspace.mode !== 'isolated' || !workspace.root) return { resources, leaks };

  const repository = getRepository(campaign.repoId, controllerHome);
  const sourceRoot = repository.canonicalRoot;
  const worktree = workspace.root;
  const branch = workspace.branch ?? undefined;
  const baseRevision = workspace.baseRevision ?? undefined;

  if (samePath(sourceRoot, worktree)) {
    const message = 'Managed Campaign workspace resolved to the repository root; refusing cleanup.';
    resources.push({ kind: 'worktree', id: worktree, status: 'preserved', message });
    leaks.push(message);
    return { resources, leaks };
  }

  if (existsSync(worktree)) {
    const top = git(worktree, ['rev-parse', '--show-toplevel']);
    const currentBranch = git(worktree, ['branch', '--show-current']);
    const status = git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (!top.ok || !samePath(top.stdout, worktree) || (branch && currentBranch.stdout !== branch)) {
      const message = `Workspace ownership mismatch; preserved ${worktree}.`;
      resources.push({ kind: 'worktree', id: worktree, status: 'preserved', message });
      leaks.push(message);
      return { resources, leaks };
    }
    if (!status.ok || status.stdout.trim()) {
      const message = `Workspace contains unintegrated or unreadable changes; preserved ${worktree}.`;
      resources.push({ kind: 'worktree', id: worktree, status: 'preserved', message });
      leaks.push(message);
      return { resources, leaks };
    }
    const removed = git(sourceRoot, ['worktree', 'remove', '--force', worktree]);
    if (!removed.ok) {
      const message = `Failed to remove managed worktree: ${removed.stderr}`;
      resources.push({ kind: 'worktree', id: worktree, status: 'failed', message });
      leaks.push(message);
      return { resources, leaks };
    }
    resources.push({ kind: 'worktree', id: worktree, status: 'cleaned' });
  } else {
    resources.push({ kind: 'worktree', id: worktree, status: 'missing' });
    git(sourceRoot, ['worktree', 'prune', '--expire', 'now']);
  }

  const checkoutId = workspace.checkoutId;
  if (!checkoutId) {
    const message = `Managed Campaign ${campaign.campaignId} workspace has no checkout identity.`;
    resources.push({ kind: 'checkout', id: worktree, status: 'failed', message });
    leaks.push(message);
  } else {
    try {
      setRepositoryCheckoutLifecycle({
        repoId: campaign.repoId,
        checkoutId,
        lifecycle: 'removed',
        reason: `Campaign ${campaign.campaignId} workspace cleanup completed.`,
        controllerHome,
      });
      resources.push({ kind: 'checkout', id: checkoutId, status: 'cleaned' });
    } catch (error) {
      const message = `Failed to update checkout lifecycle: ${error instanceof Error ? error.message : String(error)}`;
      resources.push({ kind: 'checkout', id: checkoutId, status: 'failed', message });
      leaks.push(message);
    }
  }

  if (branch) {
    const branchRevision = git(sourceRoot, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    if (!branchRevision.ok) {
      resources.push({ kind: 'branch', id: branch, status: 'missing' });
    } else if (baseRevision && branchRevision.stdout !== baseRevision) {
      const message = `Campaign branch has commits beyond its base revision; preserved ${branch}.`;
      resources.push({ kind: 'branch', id: branch, status: 'preserved', message });
      leaks.push(message);
    } else {
      const deleted = git(sourceRoot, ['branch', '-D', branch]);
      if (deleted.ok) resources.push({ kind: 'branch', id: branch, status: 'cleaned' });
      else {
        const message = `Failed to delete managed branch: ${deleted.stderr}`;
        resources.push({ kind: 'branch', id: branch, status: 'failed', message });
        leaks.push(message);
      }
    }
  }
  return { resources, leaks };
}

/**
 * Two-phase, idempotent Campaign cancellation. A Campaign is not terminal
 * until child Jobs and managed workspace resources have been reconciled.
 */
export async function cancelCampaign(
  controllerHome: string,
  repoId: string,
  campaignId: string,
  requestId: string,
  reason = 'Cancelled by user',
  expectedRevision?: number,
): Promise<Campaign> {
  const initial = getCampaign(controllerHome, repoId, campaignId);
  if (initial.status === 'completed') throw new Error('CAMPAIGN_ALREADY_COMPLETED');
  if (initial.status === 'cancelled') return initial;

  const startedAt = now();
  let campaign = updateCampaign(controllerHome, repoId, campaignId, `${requestId}:begin`, (current) => {
    current.status = 'cancelling';
    current.pauseReason = reason;
    current.nextReconcileAt = undefined;
    current.cleanup = { schemaVersion: 1, startedAt, resources: [], leaks: [] };
    for (const checkpoint of current.checkpoints) {
      if (checkpoint.status === 'open') checkpoint.status = 'superseded';
    }
    for (const task of current.tasks) {
      if (!['succeeded', 'succeeded_no_change', 'skipped', 'failed', 'failed_no_effect', 'blocked', 'cancelled'].includes(task.status)) {
        task.status = 'cancelled';
        task.completedAt = startedAt;
      }
    }
    return current;
  }, {
    expectedRevision,
    eventType: 'campaign_cancelling',
    eventData: { reason },
    requestFingerprint: reason,
  });

  const report: CampaignCleanupReport = { schemaVersion: 1, startedAt, resources: [], leaks: [] };
  const childJobIds = new Set([
    ...campaign.tasks.map((task) => task.jobId),
    ...campaign.checkpoints.map((checkpoint) => checkpoint.triggerJobId),
  ].filter((jobId): jobId is string => Boolean(jobId)));
  for (const jobId of childJobIds) {
    const job = findExecutionJob(controllerHome, jobId);
    if (!job) {
      report.resources.push({ kind: 'job', id: jobId, status: 'missing' });
      continue;
    }
    try {
      const cancelled = await cancelExecutionJob(controllerHome, repoId, jobId, `Campaign ${campaignId}: ${reason}`);
      report.resources.push({
        kind: 'job',
        id: jobId,
        status: ['cancelled', 'succeeded', 'failed', 'timed_out', 'orphaned', 'stale', 'human_attention_required'].includes(cancelled.status)
          ? 'cleaned'
          : 'failed',
        message: `Execution Job ended as ${cancelled.status}.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.resources.push({ kind: 'job', id: jobId, status: 'failed', message });
      report.leaks.push(`job ${jobId}: ${message}`);
    }
  }

  for (const checkpoint of campaign.checkpoints) {
    report.resources.push({
      kind: 'checkpoint', id: checkpoint.checkpointId,
      status: checkpoint.status === 'superseded' || checkpoint.status === 'submitted' ? 'cleaned' : 'preserved',
    });
  }

  const workspace = cleanupManagedWorkspace(controllerHome, campaign);
  report.resources.push(...workspace.resources);
  report.leaks.push(...workspace.leaks);
  report.finishedAt = now();

  campaign = updateCampaign(controllerHome, repoId, campaignId, `${requestId}:finalize`, (current) => {
    current.cleanup = report;
    current.status = report.leaks.length > 0 ? 'cancelled_with_leaks' : 'cancelled';
    current.completedAt = report.finishedAt;
    current.nextReconcileAt = undefined;
    return current;
  }, {
    eventType: report.leaks.length > 0 ? 'campaign_cancelled_with_leaks' : 'campaign_cancelled',
    eventData: { reason, cleanup: report },
    requestFingerprint: JSON.stringify({ reason, leaks: report.leaks }),
  });
  return campaign;
}
