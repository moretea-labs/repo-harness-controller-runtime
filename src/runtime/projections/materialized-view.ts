import { createHash } from 'crypto';
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
import type { ProjectionObservation } from '../health';
import { RUNTIME_HEALTH_THRESHOLDS } from '../health';

export interface ProjectionMetadata {
  contentRevision: number;
  generatedFromRevision?: string;
  contentFingerprint?: string;
  lastSuccessfulBuildAt: string;
  lastBuildAttemptAt?: string;
  lastBuildError?: string;
  producerGeneration?: string;
}

export interface RepositoryRuntimeProjection {
  schemaVersion: 1;
  repoId: string;
  generatedAt: string;
  revision: number;
  /** Additive metadata; revision remains the compatibility field. */
  metadata?: ProjectionMetadata;
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

interface DirtyProjectionReadCacheEntry {
  dirtyNonce: string;
  persistedRevision: number | null;
  value: RepositoryRuntimeProjectionSnapshot;
}

const dirtyProjectionReadCache = new Map<string, DirtyProjectionReadCacheEntry>();

function projectionPath(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'projections', 'runtime.json');
}

function dirtyProjectionReadCacheKey(controllerHome: string, repoId: string): string {
  return `${controllerHome}::${repoId}`;
}

function buildRepositoryProjection(
  controllerHome: string,
  repoId: string,
  previous?: RepositoryRuntimeProjection,
  sourceRevision?: string,
): RepositoryRuntimeProjection {
  const generatedAt = new Date().toISOString();
  const revision = (previous?.revision ?? 0) + 1;
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
  const reviewableCampaigns = campaigns.filter((campaign) => ['active', 'waiting_for_supervisor'].includes(campaign.status));
  const repository = listRepositories(controllerHome).find((entry) => entry.repoId === repoId);
  const plugins = repository ? listAssistantPluginManifests(controllerHome, repository, {
    preferStored: true,
  }) : [];
  const projection: RepositoryRuntimeProjection = {
    schemaVersion: 1,
    repoId,
    generatedAt,
    revision,
    metadata: {
      contentRevision: revision,
      generatedFromRevision: sourceRevision,
      lastSuccessfulBuildAt: generatedAt,
      lastBuildAttemptAt: generatedAt,
      ...(previous?.metadata?.producerGeneration ? { producerGeneration: previous.metadata.producerGeneration } : {}),
    },
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
      pendingReviews: reviewableCampaigns.reduce((count, campaign) => count + campaign.checkpoints.filter((checkpoint) => checkpoint.status === 'open').length, 0),
      readyForHumanAcceptance: campaigns.filter((campaign) => campaign.status === 'ready_for_human_acceptance').length,
    },
  };
  projection.metadata = {
    ...projection.metadata!,
    contentFingerprint: createHash('sha256').update(JSON.stringify({
      repoId: projection.repoId,
      releaseFrozen: projection.releaseFrozen,
      activeJobs: projection.activeJobs,
      queueDepth: projection.queueDepth,
      runningWorkers: projection.runningWorkers,
      activeLeases: projection.activeLeases,
      currentAttention: projection.currentAttention,
      attention: projection.attention,
      plugins: projection.plugins,
      campaigns: projection.campaigns,
    })).digest('hex'),
  };
  return projection;
}

export function rebuildRepositoryProjection(controllerHome: string, repoId: string): RepositoryRuntimeProjection {
  dirtyProjectionReadCache.delete(dirtyProjectionReadCacheKey(controllerHome, repoId));
  const dirtyMarker = readRepositoryProjectionDirty(controllerHome, repoId);
  const previous = readJsonFile<RepositoryRuntimeProjection | undefined>(projectionPath(controllerHome, repoId), undefined);
  const projection = buildRepositoryProjection(controllerHome, repoId, previous, dirtyMarker?.nonce);
  writeJsonAtomic(projectionPath(controllerHome, repoId), projection);
  clearRepositoryProjectionDirty(controllerHome, repoId, dirtyMarker);
  return projection;
}

export interface RepositoryRuntimeProjectionSnapshot {
  projection: RepositoryRuntimeProjection;
  stale: boolean;
  persisted: boolean;
  dirtySinceAt?: string;
  buildError?: string;
}

export function projectionBlocksReadiness(snapshot: RepositoryRuntimeProjectionSnapshot): boolean {
  const ageMs = snapshot.dirtySinceAt
    ? Math.max(0, Date.now() - Date.parse(snapshot.dirtySinceAt))
    : 0;
  const activeInvariantAtRisk = snapshot.projection.activeJobs.length > 0
    || snapshot.projection.queueDepth > 0
    || snapshot.projection.runningWorkers > 0
    || snapshot.projection.activeLeases > 0;
  return snapshot.stale && activeInvariantAtRisk && ageMs >= RUNTIME_HEALTH_THRESHOLDS.projectionRefreshGraceMs;
}

export function projectionObservation(snapshot: RepositoryRuntimeProjectionSnapshot): ProjectionObservation {
  const dirtyAgeMs = snapshot.dirtySinceAt
    ? Math.max(0, Date.now() - Date.parse(snapshot.dirtySinceAt))
    : undefined;
  const activeInvariantAtRisk = snapshot.projection.activeJobs.length > 0
    || snapshot.projection.queueDepth > 0
    || snapshot.projection.runningWorkers > 0
    || snapshot.projection.activeLeases > 0;
  return {
    readable: Boolean(snapshot.projection),
    persisted: snapshot.persisted,
    dirty: snapshot.stale,
    sourceRevisionChanged: snapshot.stale,
    refreshPending: snapshot.stale,
    refreshGraceElapsed: dirtyAgeMs !== undefined && dirtyAgeMs >= RUNTIME_HEALTH_THRESHOLDS.projectionRefreshGraceMs,
    activeInvariantAtRisk,
    lastBuildError: snapshot.buildError ?? snapshot.projection.metadata?.lastBuildError,
    contentRevision: snapshot.projection.metadata?.contentRevision ?? snapshot.projection.revision,
    generatedFromRevision: snapshot.projection.metadata?.generatedFromRevision,
  };
}

export function readRepositoryProjectionSnapshot(
  controllerHome: string,
  repoId: string,
): RepositoryRuntimeProjectionSnapshot {
  const dirtyMarker = readRepositoryProjectionDirty(controllerHome, repoId);
  const stale = Boolean(dirtyMarker);
  let persisted: RepositoryRuntimeProjection | undefined;
  try {
    persisted = readJsonFile<RepositoryRuntimeProjection>(projectionPath(controllerHome, repoId));
  } catch {
    // No persisted projection exists yet.
  }

  if (!stale && persisted) {
    dirtyProjectionReadCache.delete(dirtyProjectionReadCacheKey(controllerHome, repoId));
    return { projection: persisted, stale: false, persisted: true };
  }

  // A hot read must remain read-only. When persisted state is dirty (or absent),
  // build a bounded current snapshot in memory without clearing the dirty marker
  // or rewriting the projection file.
  const cacheKey = dirtyProjectionReadCacheKey(controllerHome, repoId);
  const persistedRevision = persisted?.revision ?? null;
  const cached = dirtyMarker ? dirtyProjectionReadCache.get(cacheKey) : undefined;
  if (
    cached
    && dirtyMarker
    && cached.dirtyNonce === dirtyMarker.nonce
    && cached.persistedRevision === persistedRevision
  ) {
    return cached.value;
  }
  const value: RepositoryRuntimeProjectionSnapshot = {
    projection: buildRepositoryProjection(controllerHome, repoId, persisted, dirtyMarker?.nonce),
    stale,
    persisted: Boolean(persisted),
    dirtySinceAt: dirtyMarker?.markedAt,
  };
  if (dirtyMarker) {
    dirtyProjectionReadCache.set(cacheKey, {
      dirtyNonce: dirtyMarker.nonce,
      persistedRevision,
      value,
    });
  }
  return value;
}

export function readRepositoryProjection(controllerHome: string, repoId: string): RepositoryRuntimeProjection {
  if (repositoryProjectionIsDirty(controllerHome, repoId)) return rebuildRepositoryProjection(controllerHome, repoId);
  try { return readJsonFile<RepositoryRuntimeProjection>(projectionPath(controllerHome, repoId)); }
  catch { return rebuildRepositoryProjection(controllerHome, repoId); }
}
