import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { withControllerLock } from '../../cli/repositories/locks';
import { appendRuntimeEvent } from '../evidence/event-ledger';
import {
  approveAssistantActionProposal,
  listAssistantActionProposals,
  type AssistantActionProposal,
} from './action-proposals';

export type AssistantStandingGrantStatus = 'active' | 'revoked' | 'expired';
export type AssistantStandingGrantSurface = 'mcp' | 'local-ui';

export interface AssistantStandingGrantConstraints {
  routineIds: string[];
  senderAllowlist: string[];
  subjectContains: string[];
  minConfidence: number;
  maxPerRun: number;
}

export interface AssistantStandingGrant {
  schemaVersion: 1;
  grantId: string;
  name: string;
  pluginId: string;
  actionId: string;
  status: AssistantStandingGrantStatus;
  constraints: AssistantStandingGrantConstraints;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  createdBy: { surface: AssistantStandingGrantSurface; actor: string };
  revokedAt?: string;
  revokedBy?: { surface: AssistantStandingGrantSurface; actor: string };
  revokeReason?: string;
}

export interface CreateAssistantStandingGrantInput {
  name?: string;
  pluginId: string;
  actionId: string;
  routineIds?: string[];
  senderAllowlist?: string[];
  subjectContains?: string[];
  minConfidence?: number;
  maxPerRun?: number;
  expiresInDays?: number;
  confirmAuthorization: boolean;
  origin: { surface: AssistantStandingGrantSurface; actor: string };
}

interface StandingGrantStore {
  schemaVersion: 1;
  updatedAt: string;
  grants: AssistantStandingGrant[];
}

export interface StandingGrantExecutionResult {
  grantId: string;
  proposalId: string;
  status: 'submitted' | 'skipped' | 'failed';
  executionJobId?: string;
  reason?: string;
}

const ELIGIBLE_ACTIONS = new Set([
  'gmail/create_draft',
  'gmail/archive_message',
  'gmail/mark_message_read',
  'gmail/mark_message_unread',
  'google_tasks/create_task',
]);

function now(): string { return new Date().toISOString(); }
function storePath(repoRoot: string): string { return join(repoRoot, '.repo-harness', 'assistant', 'standing-grants.json'); }

function uniqueStrings(value: unknown, max = 100): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry).trim()).filter(Boolean))].slice(0, max);
}

function normalizeEmailRule(value: string): string {
  return value.trim().toLowerCase().replace(/^mailto:/, '');
}

function normalizeGrant(raw: unknown): AssistantStandingGrant | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const grantId = typeof value.grantId === 'string' && value.grantId.trim() ? value.grantId.trim() : undefined;
  const pluginId = typeof value.pluginId === 'string' && value.pluginId.trim() ? value.pluginId.trim() : undefined;
  const actionId = typeof value.actionId === 'string' && value.actionId.trim() ? value.actionId.trim() : undefined;
  const expiresAt = typeof value.expiresAt === 'string' ? value.expiresAt : undefined;
  if (!grantId || !pluginId || !actionId || !expiresAt) return undefined;
  const constraints = value.constraints && typeof value.constraints === 'object' && !Array.isArray(value.constraints)
    ? value.constraints as Record<string, unknown>
    : {};
  const createdBy = value.createdBy && typeof value.createdBy === 'object' && !Array.isArray(value.createdBy)
    ? value.createdBy as Record<string, unknown>
    : {};
  const status: AssistantStandingGrantStatus = value.status === 'revoked' || value.status === 'expired' ? value.status : 'active';
  return {
    schemaVersion: 1,
    grantId,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : `${pluginId}.${actionId}`,
    pluginId,
    actionId,
    status,
    constraints: {
      routineIds: uniqueStrings(constraints.routineIds, 100),
      senderAllowlist: uniqueStrings(constraints.senderAllowlist, 100).map(normalizeEmailRule),
      subjectContains: uniqueStrings(constraints.subjectContains, 50),
      minConfidence: typeof constraints.minConfidence === 'number' && Number.isFinite(constraints.minConfidence)
        ? Math.max(0, Math.min(1, constraints.minConfidence))
        : 0.8,
      maxPerRun: typeof constraints.maxPerRun === 'number' && Number.isFinite(constraints.maxPerRun)
        ? Math.max(1, Math.min(50, Math.trunc(constraints.maxPerRun)))
        : 1,
    },
    expiresAt,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now(),
    createdBy: {
      surface: createdBy.surface === 'mcp' ? 'mcp' : 'local-ui',
      actor: typeof createdBy.actor === 'string' && createdBy.actor.trim() ? createdBy.actor.trim() : 'unknown',
    },
    revokedAt: typeof value.revokedAt === 'string' ? value.revokedAt : undefined,
    revokedBy: value.revokedBy && typeof value.revokedBy === 'object' && !Array.isArray(value.revokedBy)
      ? {
          surface: (value.revokedBy as Record<string, unknown>).surface === 'mcp' ? 'mcp' : 'local-ui',
          actor: String((value.revokedBy as Record<string, unknown>).actor ?? 'unknown'),
        }
      : undefined,
    revokeReason: typeof value.revokeReason === 'string' ? value.revokeReason : undefined,
  };
}

function readStore(repoRoot: string): StandingGrantStore {
  const path = storePath(repoRoot);
  if (!existsSync(path)) return { schemaVersion: 1, updatedAt: now(), grants: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<StandingGrantStore>;
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now(),
      grants: Array.isArray(parsed.grants) ? parsed.grants.flatMap((entry) => normalizeGrant(entry) ?? []) : [],
    };
  } catch {
    return { schemaVersion: 1, updatedAt: now(), grants: [] };
  }
}

function writeStore(repoRoot: string, store: StandingGrantStore): void {
  const path = storePath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...store, schemaVersion: 1, updatedAt: now() }, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

function expireGrant(grant: AssistantStandingGrant): AssistantStandingGrant {
  if (grant.status === 'active' && Date.parse(grant.expiresAt) <= Date.now()) {
    return { ...grant, status: 'expired', updatedAt: now() };
  }
  return grant;
}

export function isStandingGrantEligibleAction(pluginId: string, actionId: string): boolean {
  return ELIGIBLE_ACTIONS.has(`${pluginId}/${actionId}`);
}

export function createAssistantStandingGrant(
  controllerHome: string,
  repository: RepositoryRecord,
  input: CreateAssistantStandingGrantInput,
): AssistantStandingGrant {
  if (input.confirmAuthorization !== true) throw new Error('ASSISTANT_STANDING_GRANT_AUTHORIZATION_REQUIRED');
  const pluginId = input.pluginId.trim();
  const actionId = input.actionId.trim();
  if (!isStandingGrantEligibleAction(pluginId, actionId)) {
    throw new Error(`ASSISTANT_STANDING_GRANT_ACTION_NOT_ALLOWED: ${pluginId}/${actionId}`);
  }
  return withControllerLock(controllerHome, { scope: 'repository', repoId: repository.repoId }, `assistant-standing-grant-create:${pluginId}:${actionId}`, () => {
    const store = readStore(repository.canonicalRoot);
    const at = now();
    const expiresInDays = Math.max(1, Math.min(365, Math.trunc(input.expiresInDays ?? 30)));
    const grant: AssistantStandingGrant = {
      schemaVersion: 1,
      grantId: `grant-${Date.now()}-${randomUUID().slice(0, 8)}`,
      name: input.name?.trim() || `${pluginId}.${actionId}`,
      pluginId,
      actionId,
      status: 'active',
      constraints: {
        routineIds: uniqueStrings(input.routineIds, 100),
        senderAllowlist: uniqueStrings(input.senderAllowlist, 100).map(normalizeEmailRule),
        subjectContains: uniqueStrings(input.subjectContains, 50),
        minConfidence: Math.max(0, Math.min(1, input.minConfidence ?? 0.8)),
        maxPerRun: Math.max(1, Math.min(50, Math.trunc(input.maxPerRun ?? 1))),
      },
      expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60_000).toISOString(),
      createdAt: at,
      updatedAt: at,
      createdBy: { surface: input.origin.surface, actor: input.origin.actor.trim() || 'unknown' },
    };
    store.grants.unshift(grant);
    store.grants = store.grants.slice(0, 500);
    writeStore(repository.canonicalRoot, store);
    appendRuntimeEvent(controllerHome, {
      repoId: repository.repoId,
      entityType: 'assistant-standing-grant',
      entityId: grant.grantId,
      eventType: 'assistant_standing_grant_created',
      requestId: grant.grantId,
      revision: 1,
      data: {
        pluginId: grant.pluginId,
        actionId: grant.actionId,
        expiresAt: grant.expiresAt,
        constraints: grant.constraints,
        surface: grant.createdBy.surface,
      },
    });
    return grant;
  }, 10_000);
}

export function listAssistantStandingGrants(
  controllerHome: string,
  repository: RepositoryRecord,
  input: { status?: AssistantStandingGrantStatus; limit?: number } = {},
): { grants: AssistantStandingGrant[] } {
  const store = readStore(repository.canonicalRoot);
  let changed = false;
  store.grants = store.grants.map((grant) => {
    const next = expireGrant(grant);
    if (next.status !== grant.status) changed = true;
    return next;
  });
  if (changed) writeStore(repository.canonicalRoot, store);
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
  return {
    grants: store.grants
      .filter((grant) => !input.status || grant.status === input.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit),
  };
}

export function revokeAssistantStandingGrant(
  controllerHome: string,
  repository: RepositoryRecord,
  input: {
    grantId: string;
    reason?: string;
    confirmAuthorization: boolean;
    origin: { surface: AssistantStandingGrantSurface; actor: string };
  },
): AssistantStandingGrant {
  if (input.confirmAuthorization !== true) throw new Error('ASSISTANT_STANDING_GRANT_AUTHORIZATION_REQUIRED');
  return withControllerLock(controllerHome, { scope: 'repository', repoId: repository.repoId }, `assistant-standing-grant-revoke:${input.grantId}`, () => {
    const store = readStore(repository.canonicalRoot);
    const grant = store.grants.find((entry) => entry.grantId === input.grantId);
    if (!grant) throw new Error(`ASSISTANT_STANDING_GRANT_NOT_FOUND: ${input.grantId}`);
    if (grant.status === 'revoked') return grant;
    grant.status = 'revoked';
    grant.revokedAt = now();
    grant.updatedAt = grant.revokedAt;
    grant.revokedBy = { surface: input.origin.surface, actor: input.origin.actor.trim() || 'unknown' };
    grant.revokeReason = input.reason?.trim() || 'Revoked by user.';
    writeStore(repository.canonicalRoot, store);
    appendRuntimeEvent(controllerHome, {
      repoId: repository.repoId,
      entityType: 'assistant-standing-grant',
      entityId: grant.grantId,
      eventType: 'assistant_standing_grant_revoked',
      requestId: grant.grantId,
      revision: 1,
      data: { reason: grant.revokeReason, surface: grant.revokedBy.surface },
    });
    return grant;
  }, 10_000);
}

function normalizedSender(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.match(/<([^>]+@[^>]+)>/)?.[1]?.trim().toLowerCase()
    ?? value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase();
}

function senderMatches(sender: string | undefined, rules: string[]): boolean {
  if (rules.length === 0) return true;
  if (!sender) return false;
  return rules.some((rule) => {
    const normalized = normalizeEmailRule(rule);
    if (!normalized) return false;
    if (normalized.startsWith('@')) return sender.endsWith(normalized);
    if (!normalized.includes('@')) return sender.endsWith(`@${normalized}`);
    return sender === normalized;
  });
}

function subjectMatches(subject: string | undefined, fragments: string[]): boolean {
  if (fragments.length === 0) return true;
  if (!subject) return false;
  const normalized = subject.toLowerCase();
  return fragments.some((fragment) => normalized.includes(fragment.toLowerCase()));
}

function grantMatches(grant: AssistantStandingGrant, proposal: AssistantActionProposal, routineId: string): boolean {
  if (grant.status !== 'active') return false;
  if (grant.pluginId !== proposal.pluginId || grant.actionId !== proposal.actionId) return false;
  if (proposal.status !== 'proposed' || !proposal.executable || proposal.executionJobId) return false;
  if (proposal.confidence < grant.constraints.minConfidence) return false;
  if (grant.constraints.routineIds.length > 0 && !grant.constraints.routineIds.includes(routineId)) return false;
  const sender = normalizedSender(proposal.context?.sender);
  if (!senderMatches(sender, grant.constraints.senderAllowlist)) return false;
  return subjectMatches(proposal.context?.subject, grant.constraints.subjectContains);
}

export function applyAssistantStandingGrants(
  controllerHome: string,
  repository: RepositoryRecord,
  input: { routineId: string; runId: string; proposals: AssistantActionProposal[] },
): { results: StandingGrantExecutionResult[]; warnings: string[] } {
  const active = listAssistantStandingGrants(controllerHome, repository, { status: 'active', limit: 500 }).grants;
  const current = listAssistantActionProposals(controllerHome, repository, { limit: 500 }).proposals;
  const byId = new Map(current.map((proposal) => [proposal.proposalId, proposal]));
  const results: StandingGrantExecutionResult[] = [];
  const warnings: string[] = [];
  for (const grant of active) {
    let applied = 0;
    for (const supplied of input.proposals) {
      if (applied >= grant.constraints.maxPerRun) break;
      const proposal = byId.get(supplied.proposalId) ?? supplied;
      if (proposal.runId !== input.runId || !grantMatches(grant, proposal, input.routineId)) continue;
      try {
        const approved = approveAssistantActionProposal(controllerHome, repository, {
          proposalId: proposal.proposalId,
          requestId: `standing-grant:${grant.grantId}:${proposal.proposalId}`,
          origin: { surface: 'standing-grant', actor: `standing-grant:${grant.grantId}` },
          standingGrantId: grant.grantId,
        });
        applied += 1;
        results.push({
          grantId: grant.grantId,
          proposalId: proposal.proposalId,
          status: 'submitted',
          executionJobId: approved.executionJobId,
        });
        appendRuntimeEvent(controllerHome, {
          repoId: repository.repoId,
          entityType: 'assistant-standing-grant',
          entityId: grant.grantId,
          eventType: 'assistant_standing_grant_applied',
          requestId: input.runId,
          revision: 1,
          data: { proposalId: proposal.proposalId, executionJobId: approved.executionJobId },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        results.push({ grantId: grant.grantId, proposalId: proposal.proposalId, status: 'failed', reason });
        warnings.push(`Standing Grant ${grant.grantId} could not apply proposal ${proposal.proposalId}: ${reason}`);
      }
    }
  }
  return { results, warnings };
}
