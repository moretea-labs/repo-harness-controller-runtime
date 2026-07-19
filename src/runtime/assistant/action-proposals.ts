import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { withControllerLock } from '../../cli/repositories/locks';
import { findExecutionJob } from '../execution/jobs/store';
import { appendRuntimeEvent } from '../evidence/event-ledger';
import { getAssistantPluginManifest, submitAssistantPluginAction } from '../plugins/store';

export type AssistantActionProposalStatus =
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'failed'
  | 'expired';

export interface AssistantActionProposal {
  schemaVersion: 1;
  proposalId: string;
  routineId: string;
  runId: string;
  pluginId: string;
  actionId: string;
  arguments: Record<string, unknown>;
  evidenceMessageIds: string[];
  context?: { sender?: string; subject?: string; protected?: boolean };
  reason: string;
  confidence: number;
  risk: 'remote_write' | 'destructive';
  executable: boolean;
  status: AssistantActionProposalStatus;
  expiresAt: string;
  executionJobId?: string;
  standingGrantId?: string;
  rejectionReason?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantActionProposalInput {
  pluginId: string;
  actionId: string;
  arguments?: Record<string, unknown>;
  evidenceMessageIds: string[];
  context?: { sender?: string; subject?: string; protected?: boolean };
  reason: string;
  confidence?: number;
  risk?: 'remote_write' | 'destructive';
  executable?: boolean;
  expiresInHours?: number;
}

interface ProposalStore {
  schemaVersion: 1;
  updatedAt: string;
  proposals: AssistantActionProposal[];
}

function now(): string { return new Date().toISOString(); }
function proposalsPath(repoRoot: string): string { return join(repoRoot, '.repo-harness', 'assistant', 'action-proposals.json'); }

function readStore(repoRoot: string): ProposalStore {
  const path = proposalsPath(repoRoot);
  if (!existsSync(path)) return { schemaVersion: 1, updatedAt: now(), proposals: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ProposalStore>;
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now(),
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals as AssistantActionProposal[] : [],
    };
  } catch {
    return { schemaVersion: 1, updatedAt: now(), proposals: [] };
  }
}

function writeStore(repoRoot: string, store: ProposalStore): void {
  const path = proposalsPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...store, schemaVersion: 1, updatedAt: now() }, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

function refreshStatus(controllerHome: string, proposal: AssistantActionProposal): AssistantActionProposal {
  if (!proposal.executionJobId || !['approved', 'proposed'].includes(proposal.status)) return proposal;
  const job = findExecutionJob(controllerHome, proposal.executionJobId);
  if (!job) return proposal;
  if (job.status === 'succeeded') return { ...proposal, status: 'executed', updatedAt: now() };
  if (['failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(job.status)) {
    return { ...proposal, status: 'failed', error: job.error?.message ?? `Execution Job ended as ${job.status}`, updatedAt: now() };
  }
  return proposal;
}

function expire(proposal: AssistantActionProposal): AssistantActionProposal {
  if (proposal.status === 'proposed' && Date.parse(proposal.expiresAt) <= Date.now()) {
    return { ...proposal, status: 'expired', updatedAt: now() };
  }
  return proposal;
}

export function createAssistantActionProposals(
  controllerHome: string,
  repository: RepositoryRecord,
  input: { routineId: string; runId: string; proposals: AssistantActionProposalInput[] },
): AssistantActionProposal[] {
  return withControllerLock(controllerHome, { scope: 'repository', repoId: repository.repoId }, `assistant-proposals:${input.runId}`, () => {
    const store = readStore(repository.canonicalRoot);
    const existing = store.proposals.filter((entry) => entry.runId === input.runId);
    if (existing.length > 0) return existing;
    const at = now();
    const proposals = input.proposals.slice(0, 100).map((proposal) => ({
      schemaVersion: 1 as const,
      proposalId: `proposal-${Date.now()}-${randomUUID().slice(0, 8)}`,
      routineId: input.routineId,
      runId: input.runId,
      pluginId: proposal.pluginId,
      actionId: proposal.actionId,
      arguments: proposal.arguments ?? {},
      evidenceMessageIds: [...new Set(proposal.evidenceMessageIds)].slice(0, 50),
      context: proposal.context ? {
        sender: typeof proposal.context.sender === 'string' ? proposal.context.sender.slice(0, 500) : undefined,
        subject: typeof proposal.context.subject === 'string' ? proposal.context.subject.slice(0, 1_000) : undefined,
        protected: proposal.context.protected === true,
      } : undefined,
      reason: proposal.reason,
      confidence: Math.max(0, Math.min(1, proposal.confidence ?? 0.5)),
      risk: proposal.risk ?? 'remote_write',
      executable: proposal.executable !== false,
      status: 'proposed' as const,
      expiresAt: new Date(Date.now() + Math.max(1, Math.min(24 * 30, proposal.expiresInHours ?? 72)) * 60 * 60_000).toISOString(),
      createdAt: at,
      updatedAt: at,
    }));
    store.proposals = [...proposals, ...store.proposals].slice(0, 2_000);
    writeStore(repository.canonicalRoot, store);
    for (const proposal of proposals) {
      appendRuntimeEvent(controllerHome, {
        repoId: repository.repoId,
        entityType: 'assistant-action-proposal',
        entityId: proposal.proposalId,
        eventType: 'assistant_action_proposed',
        requestId: proposal.runId,
        revision: 1,
        data: { pluginId: proposal.pluginId, actionId: proposal.actionId, risk: proposal.risk, executable: proposal.executable },
      });
    }
    return proposals;
  }, 10_000);
}

export function listAssistantActionProposals(
  controllerHome: string,
  repository: RepositoryRecord,
  input: { status?: AssistantActionProposalStatus; limit?: number } = {},
): { proposals: AssistantActionProposal[] } {
  const store = readStore(repository.canonicalRoot);
  let changed = false;
  store.proposals = store.proposals.map((proposal) => {
    const next = refreshStatus(controllerHome, expire(proposal));
    if (next.status !== proposal.status || next.updatedAt !== proposal.updatedAt) changed = true;
    return next;
  });
  if (changed) writeStore(repository.canonicalRoot, store);
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
  return {
    proposals: store.proposals
      .filter((proposal) => !input.status || proposal.status === input.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit),
  };
}

export function getAssistantActionProposal(
  controllerHome: string,
  repository: RepositoryRecord,
  proposalId: string,
): AssistantActionProposal {
  const proposal = listAssistantActionProposals(controllerHome, repository, { limit: 500 }).proposals
    .find((entry) => entry.proposalId === proposalId);
  if (!proposal) throw new Error(`ASSISTANT_ACTION_PROPOSAL_NOT_FOUND: ${proposalId}`);
  return proposal;
}

export function rejectAssistantActionProposal(
  controllerHome: string,
  repository: RepositoryRecord,
  proposalId: string,
  reason?: string,
): AssistantActionProposal {
  return withControllerLock(controllerHome, { scope: 'repository', repoId: repository.repoId }, `assistant-proposal-reject:${proposalId}`, () => {
    const store = readStore(repository.canonicalRoot);
    const proposal = store.proposals.find((entry) => entry.proposalId === proposalId);
    if (!proposal) throw new Error(`ASSISTANT_ACTION_PROPOSAL_NOT_FOUND: ${proposalId}`);
    if (proposal.executionJobId) throw new Error('ASSISTANT_ACTION_PROPOSAL_ALREADY_SUBMITTED');
    if (proposal.status === 'rejected') return proposal;
    if (proposal.status !== 'proposed') throw new Error(`ASSISTANT_ACTION_PROPOSAL_NOT_REJECTABLE: ${proposal.status}`);
    proposal.status = 'rejected';
    proposal.rejectionReason = reason?.trim() || 'Rejected by user.';
    proposal.updatedAt = now();
    writeStore(repository.canonicalRoot, store);
    appendRuntimeEvent(controllerHome, {
      repoId: repository.repoId,
      entityType: 'assistant-action-proposal',
      entityId: proposal.proposalId,
      eventType: 'assistant_action_rejected',
      requestId: proposal.runId,
      revision: 1,
      data: { reason: proposal.rejectionReason },
    });
    return proposal;
  }, 10_000);
}

export function approveAssistantActionProposal(
  controllerHome: string,
  repository: RepositoryRecord,
  input: {
    proposalId: string;
    requestId: string;
    confirmationText?: string;
    origin?: { surface: 'mcp' | 'local-ui' | 'standing-grant'; actor: string };
    standingGrantId?: string;
  },
): AssistantActionProposal {
  return withControllerLock(controllerHome, { scope: 'repository', repoId: repository.repoId }, `assistant-proposal-approve:${input.proposalId}`, () => {
    const store = readStore(repository.canonicalRoot);
    const proposal = store.proposals.find((entry) => entry.proposalId === input.proposalId);
    if (!proposal) throw new Error(`ASSISTANT_ACTION_PROPOSAL_NOT_FOUND: ${input.proposalId}`);
    const refreshed = expire(proposal);
    Object.assign(proposal, refreshed);
    if (proposal.executionJobId) return refreshStatus(controllerHome, proposal);
    if (proposal.status !== 'proposed') throw new Error(`ASSISTANT_ACTION_PROPOSAL_NOT_APPROVABLE: ${proposal.status}`);
    if (!proposal.executable) throw new Error('ASSISTANT_ACTION_PROPOSAL_NOT_EXECUTABLE');
    const manifest = getAssistantPluginManifest(controllerHome, repository, proposal.pluginId);
    const action = manifest.actions.find((entry) => entry.actionId === proposal.actionId);
    if (!action) throw new Error(`PLUGIN_ACTION_NOT_FOUND: ${proposal.pluginId}/${proposal.actionId}`);
    if (action.confirmation === 'strong_confirmation' && input.confirmationText !== action.requiredConfirmationText) {
      throw new Error(`ASSISTANT_ACTION_STRONG_CONFIRMATION_REQUIRED: ${action.requiredConfirmationText}`);
    }
    const submitted = submitAssistantPluginAction(controllerHome, repository, {
      pluginId: proposal.pluginId,
      actionId: proposal.actionId,
      requestId: input.requestId.trim() || `assistant-proposal:${proposal.proposalId}`,
      args: proposal.arguments,
      confirmAuthorization: true,
      confirmationText: input.confirmationText,
      origin: {
        surface: input.origin?.surface ?? 'local-ui',
        actor: input.origin?.actor ?? 'assistant-action-approval',
        correlationId: proposal.proposalId,
      },
    });
    proposal.status = 'approved';
    proposal.executionJobId = submitted.job.jobId;
    proposal.standingGrantId = input.standingGrantId;
    proposal.updatedAt = now();
    writeStore(repository.canonicalRoot, store);
    appendRuntimeEvent(controllerHome, {
      repoId: repository.repoId,
      entityType: 'assistant-action-proposal',
      entityId: proposal.proposalId,
      eventType: 'assistant_action_approved',
      requestId: input.requestId,
      revision: 1,
      data: {
        executionJobId: proposal.executionJobId,
        pluginId: proposal.pluginId,
        actionId: proposal.actionId,
        standingGrantId: proposal.standingGrantId,
        surface: input.origin?.surface ?? 'local-ui',
      },
    });
    return proposal;
  }, 10_000);
}
