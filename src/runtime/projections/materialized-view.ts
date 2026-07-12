import { join } from 'path';
import { listActiveExecutionJobs, listExecutionJobs } from '../execution/jobs/store';
import type { ExecutionJob } from '../execution/jobs/types';
import { listActiveLeases } from '../resources/leases/store';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { listRepositories } from '../../cli/repositories/registry';
import { clearRepositoryProjectionDirty, readRepositoryProjectionDirty, repositoryProjectionIsDirty } from './invalidation';
import { listCampaigns } from '../workflow/campaigns/store';
import { listAssistantPluginManifests } from '../plugins/store';

export interface RepositoryRuntimeProjection {
  schemaVersion: 1;
  repoId: string;
  generatedAt: string;
  revision: number;
  releaseFrozen: boolean;
  activeJobs: Array<Pick<ExecutionJob, 'jobId' | 'type' | 'status' | 'priority' | 'updatedAt' | 'workerPid'>>;
  queueDepth: number;
  runningWorkers: number;
  activeLeases: number;
  currentAttention: Array<{ jobId: string; status: string; message?: string }>;
  attention: Array<{ jobId: string; status: string; message?: string }>;
  plugins?: {
    total: number;
    enabled: number;
    ready: number;
    degraded: number;
    error: number;
  };
  campaigns?: {
    active: number;
    waitingForSupervisor: number;
    pendingReviews: number;
    readyForHumanAcceptance: number;
  };
}

function projectionPath(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'projections', 'runtime.json');
}

function buildRepositoryProjection(
  controllerHome: string,
  repoId: string,
  previous?: RepositoryRuntimeProjection,
): RepositoryRuntimeProjection {
  const activeJobs = listActiveExecutionJobs(controllerHome, repoId);
  const activeJobIds = new Set(activeJobs.map((job) => job.jobId));
  const leases = listActiveLeases(controllerHome, repoId);
  const attentionJobs = listExecutionJobs(controllerHome, repoId, 100)
    .filter((job) => {
      if (!['orphaned', 'human_attention_required', 'stale'].includes(job.status)) return false;
      return true;
    });
  // Terminal attention records remain in history for diagnosis and audit, but only
  // active/unresolved records should influence "current readiness" decisions.
  const currentAttentionJobs = attentionJobs.filter((job) => !job.finishedAt || activeJobIds.has(job.jobId));
  const campaigns = listCampaigns(controllerHome, repoId, 1_000);
  const repository = listRepositories(controllerHome).find((entry) => entry.repoId === repoId);
  const plugins = repository ? listAssistantPluginManifests(controllerHome, repository) : [];
  return {
    schemaVersion: 1,
    repoId,
    generatedAt: new Date().toISOString(),
    revision: (previous?.revision ?? 0) + 1,
    releaseFrozen: leases.some((lease) => lease.resourceKey.startsWith('release:')),
    activeJobs: activeJobs.map((job) => ({
      jobId: job.jobId,
      type: job.type,
      status: job.status,
      priority: job.priority,
      updatedAt: job.updatedAt,
      workerPid: job.workerPid,
    })),
    queueDepth: activeJobs.filter((job) => job.status !== 'running' && job.status !== 'dispatched').length,
    runningWorkers: activeJobs.filter((job) => job.status === 'running').length,
    activeLeases: leases.length,
    currentAttention: currentAttentionJobs
      .map((job) => ({ jobId: job.jobId, status: job.status, message: job.error?.message })),
    attention: attentionJobs
      .map((job) => ({ jobId: job.jobId, status: job.status, message: job.error?.message })),
    plugins: {
      total: plugins.length,
      enabled: plugins.filter((plugin) => plugin.enabled).length,
      ready: plugins.filter((plugin) => plugin.health.state === 'ready').length,
      degraded: plugins.filter((plugin) => plugin.health.state === 'degraded').length,
      error: plugins.filter((plugin) => plugin.health.state === 'error').length,
    },
    campaigns: {
      active: campaigns.filter((campaign) => campaign.status === 'active').length,
      waitingForSupervisor: campaigns.filter((campaign) => campaign.status === 'waiting_for_supervisor').length,
      pendingReviews: campaigns.reduce((count, campaign) => count + campaign.checkpoints.filter((checkpoint) => checkpoint.status === 'open').length, 0),
      readyForHumanAcceptance: campaigns.filter((campaign) => campaign.status === 'ready_for_human_acceptance').length,
    },
  };
}

export function rebuildRepositoryProjection(controllerHome: string, repoId: string): RepositoryRuntimeProjection {
  const dirtyMarker = readRepositoryProjectionDirty(controllerHome, repoId);
  const previous = readJsonFile<RepositoryRuntimeProjection | undefined>(projectionPath(controllerHome, repoId), undefined);
  const projection = buildRepositoryProjection(controllerHome, repoId, previous);
  writeJsonAtomic(projectionPath(controllerHome, repoId), projection);
  clearRepositoryProjectionDirty(controllerHome, repoId, dirtyMarker);
  return projection;
}

export interface RepositoryRuntimeProjectionSnapshot {
  projection: RepositoryRuntimeProjection;
  stale: boolean;
  persisted: boolean;
}

export function projectionBlocksReadiness(snapshot: RepositoryRuntimeProjectionSnapshot): boolean {
  return snapshot.stale && (
    snapshot.projection.activeJobs.length > 0
    || snapshot.projection.queueDepth > 0
    || snapshot.projection.runningWorkers > 0
    || snapshot.projection.activeLeases > 0
  );
}

export function readRepositoryProjectionSnapshot(
  controllerHome: string,
  repoId: string,
): RepositoryRuntimeProjectionSnapshot {
  const stale = repositoryProjectionIsDirty(controllerHome, repoId);
  let persisted: RepositoryRuntimeProjection | undefined;
  try {
    persisted = readJsonFile<RepositoryRuntimeProjection>(projectionPath(controllerHome, repoId));
  } catch {
    // No persisted projection exists yet.
  }

  if (!stale && persisted) {
    return { projection: persisted, stale: false, persisted: true };
  }

  // A hot read must remain read-only. When persisted state is dirty (or absent),
  // build a bounded current snapshot in memory without clearing the dirty marker
  // or rewriting the projection file.
  return {
    projection: buildRepositoryProjection(controllerHome, repoId, persisted),
    stale,
    persisted: Boolean(persisted),
  };
}

export function readRepositoryProjection(controllerHome: string, repoId: string): RepositoryRuntimeProjection {
  if (repositoryProjectionIsDirty(controllerHome, repoId)) return rebuildRepositoryProjection(controllerHome, repoId);
  try { return readJsonFile<RepositoryRuntimeProjection>(projectionPath(controllerHome, repoId)); }
  catch { return rebuildRepositoryProjection(controllerHome, repoId); }
}
