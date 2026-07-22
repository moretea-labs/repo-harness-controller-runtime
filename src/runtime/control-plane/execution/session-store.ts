import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ensureControllerHome } from '../../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import type { GoalDelegation } from '../governance/authorization';

export interface ExecutionSessionContext {
  schemaVersion: 1;
  sessionId: string;
  principalId: string;
  activeRepositoryId?: string;
  activeCheckoutId?: string;
  activeWorkId?: string;
  permissionSnapshotVersion: number;
  capabilitySnapshotVersion?: number;
  goalDelegation?: GoalDelegation;
  controllerInstanceId: string;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface SessionIdentity {
  sessionId?: string;
  principalId: string;
  controllerInstanceId?: string;
}

const PROCESS_INSTANCE_ID = `controller-${process.pid}-${randomUUID().slice(0, 12)}`;

export function currentControllerInstanceId(): string {
  return process.env.REPO_HARNESS_MCP_INSTANCE_ID?.trim()
    || process.env.REPO_HARNESS_CONTROLLER_INSTANCE_ID?.trim()
    || PROCESS_INSTANCE_ID;
}

function sessionsRoot(controllerHome: string): string {
  const root = join(ensureControllerHome(controllerHome), 'sessions');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function sessionPath(controllerHome: string, sessionId: string): string {
  return join(sessionsRoot(controllerHome), `${sanitizeFileComponent(sessionId)}.json`);
}

function now(): string {
  return new Date().toISOString();
}

function normalizedPrincipal(value: string | undefined): string {
  const principal = value?.trim();
  if (!principal) throw new Error('SESSION_PRINCIPAL_REQUIRED: authenticated or controller-issued principal is required');
  return principal.slice(0, 512);
}

function newSessionId(): string {
  return `sess_${randomUUID().replace(/-/g, '')}`;
}

export function readExecutionSession(controllerHome: string, identity: SessionIdentity): ExecutionSessionContext | undefined {
  const sessionId = identity.sessionId?.trim();
  if (!sessionId) return undefined;
  const path = sessionPath(controllerHome, sessionId);
  if (!existsSync(path)) return undefined;
  const session = readJsonFile<ExecutionSessionContext>(path);
  if (session.sessionId !== sessionId) throw new Error('SESSION_IDENTITY_MISMATCH');
  if (session.principalId !== normalizedPrincipal(identity.principalId)) throw new Error('SESSION_PRINCIPAL_MISMATCH');
  if (session.invalidatedAt) throw new Error(`SESSION_INVALIDATED: ${session.invalidationReason ?? 'session is no longer valid'}`);
  const instanceId = identity.controllerInstanceId ?? currentControllerInstanceId();
  if (session.controllerInstanceId !== instanceId) {
    const recovered = {
      ...session,
      controllerInstanceId: instanceId,
      updatedAt: now(),
      lastValidatedAt: now(),
    };
    writeJsonAtomic(sessionPath(controllerHome, session.sessionId), recovered);
    return recovered;
  }
  return session;
}

export function startExecutionSession(
  controllerHome: string,
  input: SessionIdentity & { permissionSnapshotVersion?: number; capabilitySnapshotVersion?: number },
): ExecutionSessionContext {
  const principalId = normalizedPrincipal(input.principalId);
  const controllerInstanceId = input.controllerInstanceId ?? currentControllerInstanceId();
  const existing = readExecutionSession(controllerHome, {
    sessionId: input.sessionId,
    principalId,
    controllerInstanceId,
  });
  if (existing) {
    const updated = {
      ...existing,
      updatedAt: now(),
      lastValidatedAt: now(),
      ...(input.permissionSnapshotVersion !== undefined ? { permissionSnapshotVersion: input.permissionSnapshotVersion } : {}),
      ...(input.capabilitySnapshotVersion !== undefined ? { capabilitySnapshotVersion: input.capabilitySnapshotVersion } : {}),
    };
    writeJsonAtomic(sessionPath(controllerHome, existing.sessionId), updated);
    return updated;
  }

  const at = now();
  const session: ExecutionSessionContext = {
    schemaVersion: 1,
    sessionId: input.sessionId?.trim() || newSessionId(),
    principalId,
    permissionSnapshotVersion: Math.max(0, Math.trunc(input.permissionSnapshotVersion ?? 0)),
    ...(input.capabilitySnapshotVersion !== undefined ? { capabilitySnapshotVersion: Math.max(0, Math.trunc(input.capabilitySnapshotVersion)) } : {}),
    controllerInstanceId,
    createdAt: at,
    updatedAt: at,
    lastValidatedAt: at,
  };
  writeJsonAtomic(sessionPath(controllerHome, session.sessionId), session);
  return session;
}

export function requireExecutionSession(controllerHome: string, identity: SessionIdentity): ExecutionSessionContext {
  const session = readExecutionSession(controllerHome, identity);
  if (!session) throw new Error('SESSION_NOT_FOUND: call session_start before using session/work tools');
  return session;
}

export function updateExecutionSession(
  controllerHome: string,
  identity: SessionIdentity,
  patch: Partial<Omit<ExecutionSessionContext, 'schemaVersion' | 'sessionId' | 'principalId' | 'createdAt'>>,
): ExecutionSessionContext {
  const current = requireExecutionSession(controllerHome, identity);
  const updated: ExecutionSessionContext = {
    ...current,
    ...patch,
    sessionId: current.sessionId,
    principalId: current.principalId,
    createdAt: current.createdAt,
    updatedAt: now(),
  };
  writeJsonAtomic(sessionPath(controllerHome, current.sessionId), updated);
  return updated;
}
