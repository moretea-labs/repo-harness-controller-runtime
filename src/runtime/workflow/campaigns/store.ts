import { createHash, randomUUID } from 'crypto';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { withControllerLock } from '../../../cli/repositories/locks';
import { appendRuntimeEvent } from '../../evidence/event-ledger';
import { markRepositoryProjectionDirty } from '../../projections/invalidation';
import { touchSchedulerWakeSignal } from '../../control-plane/global-scheduler/wake-signal';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import type {
  Campaign,
  CampaignBudget,
  CampaignStatus,
  CampaignSupervisorConfig,
  CampaignTask,
  CreateCampaignInput,
  CreateCampaignTaskInput,
} from './types';

interface CampaignIndexEntry {
  campaignId: string;
  title: string;
  status: CampaignStatus;
  updatedAt: string;
}

interface CampaignIndex {
  schemaVersion: 1;
  updatedAt: string;
  active: CampaignIndexEntry[];
  recent: CampaignIndexEntry[];
}

interface CampaignRequestRecord {
  schemaVersion: 1;
  requestId: string;
  semanticKey: string;
  campaignId: string;
  repoId: string;
  createdAt: string;
}

interface CampaignMutationRecord {
  schemaVersion: 1;
  requestId: string;
  campaignId: string;
  repoId: string;
  fingerprint: string;
  revision: number;
  createdAt: string;
}

const ACTIVE_CAMPAIGN_STATUSES = new Set<CampaignStatus>(['active', 'waiting_for_supervisor']);

const DEFAULT_BUDGET: CampaignBudget = {
  maxParallelTasks: 2,
  maxExecutionJobs: 100,
  maxSupervisorReviews: 50,
  defaultTaskMaxAttempts: 3,
  taskTimeoutMs: 60 * 60_000,
  retryBaseDelayMs: 5_000,
  retryMaxDelayMs: 5 * 60_000,
  reviewPacketMaxBytes: 256 * 1024,
};

const DEFAULT_SUPERVISOR: CampaignSupervisorConfig = {
  mode: 'pull',
  triggerCooldownMs: 60_000,
  maxTriggerAttempts: 3,
  decisionTimeoutMs: 5 * 60_000,
};

function now(): string { return new Date().toISOString(); }

function root(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'campaigns');
}

function recordPath(controllerHome: string, repoId: string, campaignId: string): string {
  return join(root(controllerHome, repoId), 'records', `${sanitizeFileComponent(campaignId)}.json`);
}

function indexPath(controllerHome: string, repoId: string): string {
  return join(root(controllerHome, repoId), 'indexes', 'campaigns.json');
}

function requestPath(controllerHome: string, repoId: string, requestId: string): string {
  const hash = createHash('sha256').update(requestId).digest('hex');
  return join(root(controllerHome, repoId), 'indexes', 'requests', `${hash}.json`);
}

function mutationPath(controllerHome: string, repoId: string, requestId: string): string {
  const hash = createHash('sha256').update(requestId).digest('hex');
  return join(root(controllerHome, repoId), 'indexes', 'mutations', `${hash}.json`);
}

export function computeCampaignGoalHash(statement: string, acceptanceCriteria: string[], nonGoals: string[]): string {
  return createHash('sha256').update(JSON.stringify({ statement, acceptanceCriteria, nonGoals })).digest('hex');
}

function emptyIndex(): CampaignIndex {
  return { schemaVersion: 1, updatedAt: now(), active: [], recent: [] };
}

function readIndex(controllerHome: string, repoId: string): CampaignIndex {
  return readJsonFile<CampaignIndex>(indexPath(controllerHome, repoId), emptyIndex());
}

function upsertIndexUnlocked(controllerHome: string, campaign: Campaign): void {
  const index = readIndex(controllerHome, campaign.repoId);
  index.active = index.active.filter((entry) => entry.campaignId !== campaign.campaignId);
  index.recent = index.recent.filter((entry) => entry.campaignId !== campaign.campaignId);
  const entry: CampaignIndexEntry = {
    campaignId: campaign.campaignId,
    title: campaign.title,
    status: campaign.status,
    updatedAt: campaign.updatedAt,
  };
  if (ACTIVE_CAMPAIGN_STATUSES.has(campaign.status)) index.active.push(entry);
  index.recent.push(entry);
  index.active.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  index.recent.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  index.active = index.active.slice(-5_000);
  index.recent = index.recent.slice(0, 5_000);
  index.updatedAt = now();
  writeJsonAtomic(indexPath(controllerHome, campaign.repoId), index);
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value!)));
}

export function normalizeCampaignBudget(input: Partial<CampaignBudget> = {}): CampaignBudget {
  return {
    maxParallelTasks: boundedInteger(input.maxParallelTasks, DEFAULT_BUDGET.maxParallelTasks, 1, 16),
    maxExecutionJobs: boundedInteger(input.maxExecutionJobs, DEFAULT_BUDGET.maxExecutionJobs, 1, 10_000),
    maxSupervisorReviews: boundedInteger(input.maxSupervisorReviews, DEFAULT_BUDGET.maxSupervisorReviews, 1, 1_000),
    defaultTaskMaxAttempts: boundedInteger(input.defaultTaskMaxAttempts, DEFAULT_BUDGET.defaultTaskMaxAttempts, 1, 10),
    taskTimeoutMs: boundedInteger(input.taskTimeoutMs, DEFAULT_BUDGET.taskTimeoutMs, 1_000, 24 * 60 * 60_000),
    retryBaseDelayMs: boundedInteger(input.retryBaseDelayMs, DEFAULT_BUDGET.retryBaseDelayMs, 250, 60 * 60_000),
    retryMaxDelayMs: boundedInteger(input.retryMaxDelayMs, DEFAULT_BUDGET.retryMaxDelayMs, 250, 24 * 60 * 60_000),
    reviewPacketMaxBytes: boundedInteger(input.reviewPacketMaxBytes, DEFAULT_BUDGET.reviewPacketMaxBytes, 16 * 1024, 2 * 1024 * 1024),
  };
}

export function normalizeSupervisorConfig(input: Partial<CampaignSupervisorConfig> = {}): CampaignSupervisorConfig {
  const mode = input.mode === 'operation'
    ? 'operation'
    : input.mode === 'workspace_agent' ? 'workspace_agent' : 'pull';
  if (mode === 'operation' && !input.operation?.trim()) throw new Error('CAMPAIGN_SUPERVISOR_OPERATION_REQUIRED');
  const workspaceAgentId = input.workspaceAgentId?.trim();
  if (mode === 'workspace_agent' && !workspaceAgentId) throw new Error('CAMPAIGN_WORKSPACE_AGENT_ID_REQUIRED');
  if (workspaceAgentId && !/^agtch_[A-Za-z0-9_-]+$/.test(workspaceAgentId)) {
    throw new Error('CAMPAIGN_WORKSPACE_AGENT_ID_INVALID');
  }
  const conversationKey = input.conversationKey?.trim();
  return {
    mode,
    operation: mode === 'operation' ? input.operation!.trim() : undefined,
    workspaceAgentId: mode === 'workspace_agent' ? workspaceAgentId : undefined,
    conversationKey: mode === 'workspace_agent' && conversationKey ? conversationKey : undefined,
    arguments: mode === 'operation' && input.arguments && typeof input.arguments === 'object' ? input.arguments : undefined,
    priority: input.priority ?? 'P1',
    resourceClaims: mode === 'operation' ? input.resourceClaims ?? [] : [],
    triggerCooldownMs: boundedInteger(input.triggerCooldownMs, DEFAULT_SUPERVISOR.triggerCooldownMs, 1_000, 24 * 60 * 60_000),
    maxTriggerAttempts: boundedInteger(input.maxTriggerAttempts, DEFAULT_SUPERVISOR.maxTriggerAttempts, 1, 10),
    decisionTimeoutMs: boundedInteger(input.decisionTimeoutMs, DEFAULT_SUPERVISOR.decisionTimeoutMs, 1_000, 24 * 60 * 60_000),
  };
}

function normalizeTask(input: CreateCampaignTaskInput, budget: CampaignBudget): CampaignTask {
  const taskId = input.taskId.trim();
  const title = input.title.trim();
  const operation = input.operation.trim();
  if (!taskId) throw new Error('CAMPAIGN_TASK_ID_REQUIRED');
  if (!title) throw new Error(`CAMPAIGN_TASK_TITLE_REQUIRED: ${taskId}`);
  if (!operation) throw new Error(`CAMPAIGN_TASK_OPERATION_REQUIRED: ${taskId}`);
  return {
    taskId,
    title,
    objective: input.objective?.trim() || title,
    operation,
    arguments: input.arguments ? structuredClone(input.arguments) : undefined,
    dependsOn: [...new Set((input.dependsOn ?? []).map((value) => value.trim()).filter(Boolean))],
    priority: input.priority ?? 'P1',
    resourceClaims: structuredClone(input.resourceClaims ?? []),
    reviewRequired: input.reviewRequired ?? true,
    maxAttempts: boundedInteger(input.maxAttempts, budget.defaultTaskMaxAttempts, 1, 10),
    status: 'pending',
    attempt: 0,
    evidenceIds: [],
    executor: input.executor ? structuredClone(input.executor) : undefined,
  };
}

export function validateCampaignTasks(tasks: CampaignTask[]): void {
  if (tasks.length === 0) throw new Error('CAMPAIGN_TASKS_REQUIRED');
  const byId = new Map<string, CampaignTask>();
  for (const task of tasks) {
    if (byId.has(task.taskId)) throw new Error(`CAMPAIGN_TASK_DUPLICATE: ${task.taskId}`);
    byId.set(task.taskId, task);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.taskId) throw new Error(`CAMPAIGN_TASK_SELF_DEPENDENCY: ${task.taskId}`);
      if (!byId.has(dependency)) throw new Error(`CAMPAIGN_TASK_DEPENDENCY_MISSING: ${task.taskId} -> ${dependency}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) throw new Error(`CAMPAIGN_TASK_CYCLE: ${taskId}`);
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)!.dependsOn) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of byId.keys()) visit(taskId);
}

export function validateCreateCampaignTasks(
  inputs: CreateCampaignTaskInput[],
  budgetInput: Partial<CampaignBudget> = {},
): void {
  const budget = normalizeCampaignBudget(budgetInput);
  validateCampaignTasks(inputs.map((input) => normalizeTask(input, budget)));
}

export function getCampaign(controllerHome: string, repoId: string, campaignId: string): Campaign {
  const campaign = readJsonFile<Campaign>(recordPath(controllerHome, repoId, campaignId));
  if (campaign.repoId !== repoId || campaign.campaignId !== campaignId) throw new Error('CAMPAIGN_IDENTITY_MISMATCH');
  if (!campaign.workspace) {
    campaign.workspace = {
      mode: 'current',
      checkoutId: campaign.checkoutId,
      managed: false,
    };
  }
  return campaign;
}

function findCampaignByRequestId(controllerHome: string, repoId: string, requestId: string): Campaign | undefined {
  try {
    for (const name of readdirSync(join(root(controllerHome, repoId), 'records'))) {
      if (!name.endsWith('.json')) continue;
      const campaign = readJsonFile<Campaign>(join(root(controllerHome, repoId), 'records', name));
      if (campaign.requestId === requestId) return campaign;
    }
  } catch { /* no campaign directory yet */ }
  return undefined;
}

export function createCampaign(controllerHome: string, input: CreateCampaignInput): { campaign: Campaign; deduplicated: boolean } {
  const repoId = input.repoId.trim();
  const requestId = input.requestId.trim();
  const semanticKey = input.semanticKey.trim();
  const title = input.title.trim();
  const goal = input.goal.trim();
  if (!repoId) throw new Error('CAMPAIGN_REPO_ID_REQUIRED');
  if (!requestId) throw new Error('CAMPAIGN_REQUEST_ID_REQUIRED');
  if (!semanticKey) throw new Error('CAMPAIGN_SEMANTIC_KEY_REQUIRED');
  if (!title) throw new Error('CAMPAIGN_TITLE_REQUIRED');
  if (!goal) throw new Error('CAMPAIGN_GOAL_REQUIRED');
  const budget = normalizeCampaignBudget(input.budget);
  const tasks = input.tasks.map((task) => normalizeTask(task, budget));
  validateCampaignTasks(tasks);
  const requestLock = createHash('sha256').update(`${repoId}:${requestId}`).digest('hex').slice(0, 24);
  return withControllerLock(controllerHome, { scope: 'global', resource: `campaign-request-${requestLock}` }, `create-campaign:${requestId}`, () => {
    const existingPath = requestPath(controllerHome, repoId, requestId);
    if (existsSync(existingPath)) {
      const record = readJsonFile<CampaignRequestRecord>(existingPath);
      if (record.semanticKey !== semanticKey) throw new Error(`CAMPAIGN_REQUEST_ID_CONFLICT: ${requestId}`);
      return { campaign: getCampaign(controllerHome, repoId, record.campaignId), deduplicated: true };
    }
    const recovered = findCampaignByRequestId(controllerHome, repoId, requestId);
    if (recovered) {
      if (recovered.semanticKey !== semanticKey) throw new Error(`CAMPAIGN_REQUEST_ID_CONFLICT: ${requestId}`);
      writeJsonAtomic(existingPath, {
        schemaVersion: 1, requestId, semanticKey, campaignId: recovered.campaignId, repoId, createdAt: recovered.createdAt,
      } satisfies CampaignRequestRecord);
      return { campaign: recovered, deduplicated: true };
    }
    const timestamp = now();
    const workspace = input.workspace ? structuredClone(input.workspace) : {
      mode: 'current' as const,
      checkoutId: input.checkoutId,
      managed: false,
    };
    const campaign: Campaign = {
      schemaVersion: 1,
      revision: 1,
      campaignId: `CMP-${Date.now()}-${randomUUID().slice(0, 8)}`,
      repoId,
      checkoutId: workspace.checkoutId ?? input.checkoutId,
      workspace,
      requestId,
      semanticKey,
      title,
      status: 'active',
      goals: (() => {
        const acceptanceCriteria = [...new Set((input.acceptanceCriteria ?? []).map((value) => value.trim()).filter(Boolean))];
        const nonGoals = [...new Set((input.nonGoals ?? []).map((value) => value.trim()).filter(Boolean))];
        return [{
          revision: 1,
          goalHash: computeCampaignGoalHash(goal, acceptanceCriteria, nonGoals),
          statement: goal,
          acceptanceCriteria,
          nonGoals,
          changedBy: input.createdBy?.trim() || 'user',
          changedAt: timestamp,
        }];
      })(),
      tasks,
      checkpoints: [],
      budget,
      supervisor: normalizeSupervisorConfig(input.supervisor),
      reviewPolicy: input.reviewPolicy ?? 'every_task',
      counters: { executionJobsCreated: 0, supervisorReviewsOpened: 0, supervisorDecisionsAccepted: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    writeJsonAtomic(recordPath(controllerHome, repoId, campaign.campaignId), campaign);
    writeJsonAtomic(existingPath, {
      schemaVersion: 1,
      requestId,
      semanticKey,
      campaignId: campaign.campaignId,
      repoId,
      createdAt: timestamp,
    } satisfies CampaignRequestRecord);
    upsertIndexUnlocked(controllerHome, campaign);
    appendRuntimeEvent(controllerHome, {
      repoId,
      entityType: 'campaign',
      entityId: campaign.campaignId,
      eventType: 'campaign_created',
      requestId,
      revision: campaign.revision,
      data: { title, taskCount: tasks.length, reviewPolicy: campaign.reviewPolicy, workspace: campaign.workspace },
    });
    markRepositoryProjectionDirty(controllerHome, repoId, `campaign:${campaign.campaignId}:created`);
    touchSchedulerWakeSignal(controllerHome, `campaign-created:${campaign.campaignId}`);
    return { campaign, deduplicated: false };
  }, 10_000);
}

export interface UpdateCampaignOptions {
  expectedRevision?: number;
  eventType?: string;
  eventData?: Record<string, unknown>;
  wakeScheduler?: boolean;
  requestFingerprint?: string;
}

export function updateCampaign(
  controllerHome: string,
  repoId: string,
  campaignId: string,
  requestId: string,
  updater: (current: Campaign) => Campaign,
  options: UpdateCampaignOptions = {},
): Campaign {
  return withControllerLock(controllerHome, { scope: 'task', repoId, taskId: `campaign-${campaignId}` }, `update-campaign:${campaignId}`, () => {
    const mutationFingerprint = createHash('sha256').update(options.requestFingerprint ?? JSON.stringify({
      campaignId,
      eventType: options.eventType ?? 'campaign_updated',
      eventData: options.eventData ?? null,
    })).digest('hex');
    const mutationRecordPath = mutationPath(controllerHome, repoId, requestId);
    const current = getCampaign(controllerHome, repoId, campaignId);
    const embeddedReceipt = current.mutationReceipts?.find((receipt) => receipt.requestId === requestId);
    if (embeddedReceipt) {
      if (embeddedReceipt.fingerprint !== mutationFingerprint) throw new Error(`CAMPAIGN_REQUEST_ID_CONFLICT: ${requestId}`);
      return current;
    }
    if (existsSync(mutationRecordPath)) {
      const record = readJsonFile<CampaignMutationRecord>(mutationRecordPath);
      if (record.repoId !== repoId || record.campaignId !== campaignId || record.fingerprint !== mutationFingerprint) {
        throw new Error(`CAMPAIGN_REQUEST_ID_CONFLICT: ${requestId}`);
      }
      return current;
    }
    if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
      throw new Error(`CAMPAIGN_REVISION_CONFLICT: expected ${options.expectedRevision}, current ${current.revision}`);
    }
    const next = updater(structuredClone(current));
    if (
      next.campaignId !== current.campaignId
      || next.repoId !== current.repoId
      || next.requestId !== current.requestId
      || next.semanticKey !== current.semanticKey
      || next.checkoutId !== current.checkoutId
      || JSON.stringify(next.workspace) !== JSON.stringify(current.workspace)
    ) {
      throw new Error('CAMPAIGN_IDENTITY_IMMUTABLE');
    }
    validateCampaignTasks(next.tasks);
    next.revision = current.revision + 1;
    next.updatedAt = now();
    next.mutationReceipts = [
      ...(current.mutationReceipts ?? []).filter((receipt) => receipt.requestId !== requestId),
      { requestId, fingerprint: mutationFingerprint, revision: next.revision, appliedAt: next.updatedAt },
    ].slice(-1_000);
    writeJsonAtomic(recordPath(controllerHome, repoId, campaignId), next);
    writeJsonAtomic(mutationRecordPath, {
      schemaVersion: 1,
      requestId,
      campaignId,
      repoId,
      fingerprint: mutationFingerprint,
      revision: next.revision,
      createdAt: next.updatedAt,
    } satisfies CampaignMutationRecord);
    upsertIndexUnlocked(controllerHome, next);
    appendRuntimeEvent(controllerHome, {
      repoId,
      entityType: 'campaign',
      entityId: campaignId,
      eventType: options.eventType ?? 'campaign_updated',
      requestId,
      revision: next.revision,
      data: options.eventData ?? { status: next.status },
    });
    markRepositoryProjectionDirty(controllerHome, repoId, `campaign:${campaignId}:${next.status}`);
    if (options.wakeScheduler !== false) touchSchedulerWakeSignal(controllerHome, `campaign-updated:${campaignId}`);
    return next;
  }, 10_000);
}

function readIndexedCampaigns(controllerHome: string, repoId: string, entries: CampaignIndexEntry[], limit: number): Campaign[] {
  return entries.slice(0, limit).flatMap((entry) => {
    try { return [getCampaign(controllerHome, repoId, entry.campaignId)]; } catch { return []; }
  });
}

export function listActiveCampaigns(controllerHome: string, repoId: string, limit = 500): Campaign[] {
  const bounded = Math.max(1, Math.min(limit, 5_000));
  const indexed = readIndexedCampaigns(controllerHome, repoId, readIndex(controllerHome, repoId).active, bounded)
    .filter((campaign) => ACTIVE_CAMPAIGN_STATUSES.has(campaign.status));
  if (indexed.length > 0) return indexed;
  try {
    return readdirSync(join(root(controllerHome, repoId), 'records'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJsonFile<Campaign>(join(root(controllerHome, repoId), 'records', name)))
      .filter((campaign) => ACTIVE_CAMPAIGN_STATUSES.has(campaign.status))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, bounded);
  } catch { return []; }
}

export function listCampaigns(controllerHome: string, repoId: string, limit = 100): Campaign[] {
  const bounded = Math.max(1, Math.min(limit, 1_000));
  const indexed = readIndexedCampaigns(controllerHome, repoId, readIndex(controllerHome, repoId).recent, bounded);
  if (indexed.length > 0) return indexed;
  try {
    return readdirSync(join(root(controllerHome, repoId), 'records'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJsonFile<Campaign>(join(root(controllerHome, repoId), 'records', name)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, bounded);
  } catch { return []; }
}

export function addCampaignTask(
  controllerHome: string,
  repoId: string,
  campaignId: string,
  requestId: string,
  input: CreateCampaignTaskInput,
  expectedRevision?: number,
): Campaign {
  return updateCampaign(controllerHome, repoId, campaignId, requestId, (campaign) => {
    if (['completed', 'cancelled'].includes(campaign.status)) throw new Error(`CAMPAIGN_TERMINAL: ${campaign.status}`);
    const task = normalizeTask(input, campaign.budget);
    if (campaign.tasks.some((entry) => entry.taskId === task.taskId)) throw new Error(`CAMPAIGN_TASK_DUPLICATE: ${task.taskId}`);
    campaign.tasks.push(task);
    if (campaign.status === 'ready_for_human_acceptance' || campaign.status === 'failed') campaign.status = 'active';
    campaign.nextReconcileAt = undefined;
    return campaign;
  }, { expectedRevision, eventType: 'campaign_task_added', eventData: { taskId: input.taskId }, requestFingerprint: JSON.stringify(input) });
}

export function setCampaignStatus(
  controllerHome: string,
  repoId: string,
  campaignId: string,
  requestId: string,
  status: CampaignStatus,
  reason?: string,
  expectedRevision?: number,
): Campaign {
  return updateCampaign(controllerHome, repoId, campaignId, requestId, (campaign) => {
    if (campaign.status === 'completed' && status !== 'completed') throw new Error('CAMPAIGN_ALREADY_COMPLETED');
    campaign.status = status;
    campaign.pauseReason = status === 'paused' ? reason || 'Paused by supervisor.' : undefined;
    campaign.failureReason = status === 'failed' ? reason || 'Campaign failed.' : campaign.failureReason;
    if (status === 'completed') campaign.completedAt = now();
    if (status === 'active') campaign.nextReconcileAt = undefined;
    return campaign;
  }, { expectedRevision, eventType: `campaign_${status}`, eventData: { reason } });
}
