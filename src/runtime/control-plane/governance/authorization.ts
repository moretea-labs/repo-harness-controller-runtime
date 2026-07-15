import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join, relative, resolve } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import type { AccessMode } from './access-policy';

export type AuthorizationRiskClass =
  | 'readonly'
  | 'local_repo_write'
  | 'workspace_write'
  | 'local_command'
  | 'dependency_change'
  | 'local_git'
  | 'remote_write'
  | 'destructive'
  | 'secret_access'
  | 'outside_repository';

export type AuthorizationDecision =
  | { decision: 'allow'; source: 'policy' | 'full_access' | 'goal_delegation' | 'gpt_risk_delegate' | 'user_confirmation'; reason: string }
  | { decision: 'user_confirmation_required'; approvalRequestId: string; humanSummary: string; consequences: string[]; continuation: string }
  | { decision: 'deny'; reason: string };

export interface GoalDelegation {
  schemaVersion: 1;
  sessionId: string;
  repositoryId: string;
  workId?: string;
  goalId?: string;
  allowedRiskClasses: AuthorizationRiskClass[];
  deniedRiskClasses: AuthorizationRiskClass[];
  permissionSnapshotVersion: number;
  source: 'goal_delegation' | 'gpt_risk_delegate';
  createdAt: string;
  expiresAt?: string;
  version: number;
}

export interface AuthorizationRequestRecord {
  schemaVersion: 1;
  approvalRequestId: string;
  repositoryId: string;
  sessionId?: string;
  principalId?: string;
  workId?: string;
  goalId?: string;
  command?: string | string[];
  approvalToken?: string;
  risk: AuthorizationRiskClass;
  permissionSnapshotVersion: number;
  humanSummary: string;
  consequences: string[];
  continuation: string;
  status: 'pending' | 'resolved' | 'invalidated';
  createdAt: string;
  resolvedAt?: string;
  invalidatedReason?: string;
}

export interface AuthorizationContext {
  controllerHome?: string;
  accessMode: AccessMode;
  risk: AuthorizationRiskClass;
  repositoryId: string;
  currentRepositoryId?: string;
  workId?: string;
  boundWorkId?: string;
  goalId?: string;
  boundGoalId?: string;
  sessionId?: string;
  principalId?: string;
  permissionSnapshotVersion: number;
  delegation?: GoalDelegation;
  worktreePath?: string;
  cwd?: string;
  command?: string | string[];
  approvalRequestId?: string;
  approvalToken?: string;
  approvedByUser?: boolean;
}

function requestRoot(controllerHome: string, repoId: string): string {
  const root = join(repositoryControllerRoot(controllerHome, repoId), 'controller', 'approval-requests');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function requestPath(controllerHome: string, repoId: string, requestId: string): string {
  return join(requestRoot(controllerHome, repoId), `${sanitizeFileComponent(requestId)}.json`);
}

function scopeMatches(context: AuthorizationContext): boolean {
  if (context.currentRepositoryId && context.repositoryId !== context.currentRepositoryId) return false;
  if (context.workId && context.boundWorkId && context.workId !== context.boundWorkId) return false;
  if (context.goalId && context.boundGoalId && context.goalId !== context.boundGoalId) return false;
  if (context.worktreePath && context.cwd) {
    const cwd = resolve(context.worktreePath, context.cwd);
    const rel = relative(resolve(context.worktreePath), cwd);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) return false;
  }
  return true;
}

function delegationMatches(context: AuthorizationContext): boolean {
  const delegation = context.delegation;
  if (!delegation || delegation.sessionId !== context.sessionId || delegation.repositoryId !== context.repositoryId) return false;
  if (delegation.workId && delegation.workId !== context.workId) return false;
  if (delegation.goalId && delegation.goalId !== context.goalId && delegation.goalId !== context.boundGoalId) return false;
  if (delegation.permissionSnapshotVersion !== context.permissionSnapshotVersion) return false;
  if (delegation.expiresAt && Date.parse(delegation.expiresAt) <= Date.now()) return false;
  if (delegation.deniedRiskClasses.includes(context.risk) || !delegation.allowedRiskClasses.includes(context.risk)) return false;
  return scopeMatches(context);
}

function requestDecision(context: AuthorizationContext, reason: string): AuthorizationDecision {
  if (!context.controllerHome) {
    return { decision: 'deny', reason: `${reason} Controller Home is unavailable for a resumable approval request.` };
  }
  const approvalRequestId = `apr_${randomUUID().replace(/-/g, '')}`;
  const record: AuthorizationRequestRecord = {
    schemaVersion: 1,
    approvalRequestId,
    repositoryId: context.repositoryId,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.principalId ? { principalId: context.principalId } : {}),
    ...(context.workId ? { workId: context.workId } : {}),
    ...(context.goalId ? { goalId: context.goalId } : {}),
    ...(context.command ? { command: context.command } : {}),
    ...(context.approvalToken ? { approvalToken: context.approvalToken } : {}),
    risk: context.risk,
    permissionSnapshotVersion: context.permissionSnapshotVersion,
    humanSummary: reason,
    consequences: [
      `Operation risk class: ${context.risk}`,
      `Repository: ${context.repositoryId}`,
      ...(context.workId ? [`Work handle: ${context.workId}`] : []),
    ],
    continuation: context.command
      ? `After confirming approvalRequestId=${approvalRequestId}, retry the same command with the returned approval request; changed commands require a new approval.`
      : `After confirming approvalRequestId=${approvalRequestId}, retry the original operation in this session.`,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(requestPath(context.controllerHome, context.repositoryId, approvalRequestId), record);
  return { decision: 'user_confirmation_required', approvalRequestId, humanSummary: record.humanSummary, consequences: record.consequences, continuation: record.continuation };
}

export function decideAuthorization(context: AuthorizationContext): AuthorizationDecision {
  if (context.risk === 'secret_access') return { decision: 'deny', reason: 'Credential, keychain, token, and raw secret access is always denied.' };
  if (!scopeMatches(context)) return requestDecision(context, 'The operation is outside the active repository, worktree, or Goal scope.');
  if (['outside_repository', 'destructive'].includes(context.risk)) {
    return context.approvedByUser ? { decision: 'allow', source: 'user_confirmation', reason: 'The user explicitly confirmed the scoped catastrophic operation.' } : requestDecision(context, `Explicit user confirmation is required for ${context.risk}.`);
  }
  if (delegationMatches(context)) {
    return { decision: 'allow', source: context.delegation?.source ?? 'gpt_risk_delegate', reason: 'The operation is within the current Goal and repository scope.' };
  }
  return { decision: 'allow', source: 'policy', reason: 'Normal scoped operations follow the host AI permission model; Repo Harness only gates catastrophic effects.' };
}

export function createGoalDelegation(input: Omit<GoalDelegation, 'schemaVersion' | 'createdAt' | 'version'> & { expiresAt?: string }): GoalDelegation {
  return { schemaVersion: 1, ...input, createdAt: new Date().toISOString(), version: 1 };
}

export function readAuthorizationRequest(controllerHome: string, repositoryId: string, approvalRequestId: string): AuthorizationRequestRecord {
  const path = requestPath(controllerHome, repositoryId, approvalRequestId);
  if (!existsSync(path)) throw new Error(`APPROVAL_REQUEST_NOT_FOUND: ${approvalRequestId}`);
  const request = readJsonFile<AuthorizationRequestRecord>(path);
  if (request.repositoryId !== repositoryId || request.approvalRequestId !== approvalRequestId) throw new Error('APPROVAL_REQUEST_IDENTITY_MISMATCH');
  return request;
}

export function resolveAuthorizationRequest(input: { controllerHome: string; repositoryId: string; approvalRequestId: string; sessionId?: string; principalId?: string; workId?: string; permissionSnapshotVersion: number; confirm: boolean }): AuthorizationRequestRecord {
  const request = readAuthorizationRequest(input.controllerHome, input.repositoryId, input.approvalRequestId);
  if (!input.confirm) throw new Error('USER_CONFIRMATION_REQUIRED: confirm_authorization=true is required to resolve the approval request');
  if (request.status === 'invalidated') throw new Error(`APPROVAL_REQUEST_INVALIDATED: ${request.invalidatedReason ?? 'approval request is stale'}`);
  if (request.sessionId && request.sessionId !== input.sessionId) throw new Error('APPROVAL_REQUEST_SESSION_MISMATCH');
  if (request.principalId && request.principalId !== input.principalId) throw new Error('APPROVAL_REQUEST_PRINCIPAL_MISMATCH');
  if (request.workId && request.workId !== input.workId) throw new Error('APPROVAL_REQUEST_WORK_MISMATCH');
  if (request.permissionSnapshotVersion !== input.permissionSnapshotVersion) throw new Error('APPROVAL_REQUEST_STALE_PERMISSION');
  const resolved = { ...request, status: 'resolved' as const, resolvedAt: new Date().toISOString() };
  writeJsonAtomic(requestPath(input.controllerHome, input.repositoryId, input.approvalRequestId), resolved);
  return resolved;
}

export function assertResolvedAuthorization(input: { controllerHome: string; repositoryId: string; approvalRequestId: string; sessionId?: string; principalId?: string; workId?: string; permissionSnapshotVersion: number; command?: string | string[] }): AuthorizationRequestRecord {
  const request = readAuthorizationRequest(input.controllerHome, input.repositoryId, input.approvalRequestId);
  if (request.status !== 'resolved') throw new Error('APPROVAL_REQUEST_NOT_RESOLVED: confirm the approval request in the current conversation first');
  if (request.sessionId && request.sessionId !== input.sessionId) throw new Error('APPROVAL_REQUEST_SESSION_MISMATCH');
  if (request.principalId && request.principalId !== input.principalId) throw new Error('APPROVAL_REQUEST_PRINCIPAL_MISMATCH');
  if (request.workId && request.workId !== input.workId) throw new Error('APPROVAL_REQUEST_WORK_MISMATCH');
  if (request.permissionSnapshotVersion !== input.permissionSnapshotVersion) throw new Error('APPROVAL_REQUEST_STALE_PERMISSION');
  if (request.command && input.command && JSON.stringify(request.command) !== JSON.stringify(input.command)) throw new Error('APPROVAL_REQUEST_COMMAND_CHANGED: request a new approval for changed parameters');
  return request;
}
