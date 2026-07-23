import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { writeJsonAtomic } from '../shared/json-files';
import { supervisorRoot } from './paths';

export type ActivationPhase =
  | 'prepared'
  | 'stopping_previous'
  | 'waiting_previous_exit'
  | 'installing_service'
  | 'bootstrapping'
  | 'waiting_service_registration'
  | 'waiting_supervisor_ready'
  | 'waiting_stable_endpoint'
  | 'succeeded'
  | 'rolling_back'
  | 'failed';

export const ACTIVATION_PHASE_ORDER: ActivationPhase[] = [
  'prepared',
  'stopping_previous',
  'waiting_previous_exit',
  'installing_service',
  'bootstrapping',
  'waiting_service_registration',
  'waiting_supervisor_ready',
  'waiting_stable_endpoint',
  'succeeded',
];

export interface PhaseRecord {
  phase: ActivationPhase;
  timestamp: string;
  expectedReleaseRevision?: string;
  expectedReleasePath?: string;
  previousReleaseRevision?: string;
  previousReleasePath?: string;
  serviceLabel?: string;
  plistPath?: string;
  oldPid?: number;
  newPid?: number;
  bootstrapAttempt?: number;
  exitCode?: number;
  stderr?: string;
  readinessResult?: unknown;
  error?: string;
}

export interface ActivationStateRecord {
  schemaVersion: 2;
  activationId: string;
  phase: ActivationPhase;
  repoRoot: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  expectedReleaseRevision?: string;
  expectedReleasePath?: string;
  previousReleaseRevision?: string;
  previousReleasePath?: string;
  serviceLabel?: string;
  pid?: number;
  oldPid?: number;
  newPid?: number;
  bootstrapAttempts?: number;
  error?: string;
  recovery?: unknown;
  serviceCoherence?: unknown;
  phases: PhaseRecord[];
  [key: string]: unknown;
}

export function activationStatePath(home: string): string {
  return join(supervisorRoot(home), 'activation.json');
}

export function readActivationState(home: string): ActivationStateRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(activationStatePath(home), 'utf8'));
    if (parsed?.schemaVersion === 2 && typeof parsed.activationId === 'string' && typeof parsed.phase === 'string') {
      return parsed as ActivationStateRecord;
    }
    // Migrate schema v1 → v2
    if (parsed?.schemaVersion === 1 && typeof parsed.activationId === 'string' && typeof parsed.phase === 'string') {
      return migrateV1State(parsed);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function migrateV1State(v1: Record<string, unknown>): ActivationStateRecord {
  const phase = (v1.phase as string) as ActivationPhase;
  const phases: PhaseRecord[] = phase === 'succeeded' || phase === 'failed'
    ? [{ phase, timestamp: (v1.updatedAt as string) ?? new Date().toISOString(), expectedReleaseRevision: v1.expectedReleaseRevision as string, expectedReleasePath: v1.expectedReleasePath as string }]
    : [];
  return {
    schemaVersion: 2,
    activationId: v1.activationId as string,
    phase,
    repoRoot: (v1.repoRoot as string) ?? '',
    startedAt: (v1.startedAt as string) ?? (v1.updatedAt as string) ?? new Date().toISOString(),
    updatedAt: (v1.updatedAt as string) ?? new Date().toISOString(),
    completedAt: v1.completedAt as string | undefined,
    expectedReleaseRevision: v1.expectedReleaseRevision as string | undefined,
    expectedReleasePath: v1.expectedReleasePath as string | undefined,
    previousReleaseRevision: v1.releaseRevision as string | undefined,
    previousReleasePath: v1.releasePath as string | undefined,
    serviceLabel: (v1.service as Record<string, unknown> | undefined)?.label as string | undefined,
    pid: v1.pid as number | undefined,
    error: v1.error as string | undefined,
    recovery: v1.recovery,
    serviceCoherence: v1.serviceCoherence,
    phases,
  };
}

export function initActivationState(input: {
  home: string;
  activationId: string;
  repoRoot: string;
  expectedReleaseRevision?: string;
  expectedReleasePath?: string;
  previousReleaseRevision?: string;
  previousReleasePath?: string;
  serviceLabel?: string;
  plistPath?: string;
}): ActivationStateRecord {
  const now = new Date().toISOString();
  const state: ActivationStateRecord = {
    schemaVersion: 2,
    activationId: input.activationId,
    phase: 'prepared',
    repoRoot: input.repoRoot,
    startedAt: now,
    updatedAt: now,
    expectedReleaseRevision: input.expectedReleaseRevision,
    expectedReleasePath: input.expectedReleasePath,
    previousReleaseRevision: input.previousReleaseRevision,
    previousReleasePath: input.previousReleasePath,
    serviceLabel: input.serviceLabel,
    plistPath: input.plistPath,
    phases: [],
  };
  persistActivationState(input.home, state);
  return state;
}

export function transitionPhase(
  home: string,
  activationId: string,
  phase: ActivationPhase,
  extra?: Partial<Omit<PhaseRecord, 'phase' | 'timestamp'>>,
): ActivationStateRecord {
  const existing = readActivationState(home);
  if (!existing || existing.activationId !== activationId) {
    throw new Error(`ACTIVATION_STATE_MISMATCH: expected ${activationId}, found ${existing?.activationId ?? 'none'}`);
  }
  const now = new Date().toISOString();
  const record: PhaseRecord = {
    phase,
    timestamp: now,
    ...extra,
  };
  const updated: ActivationStateRecord = {
    ...existing,
    phase,
    updatedAt: now,
    ...(extra?.expectedReleaseRevision ? { expectedReleaseRevision: extra.expectedReleaseRevision } : {}),
    ...(extra?.expectedReleasePath ? { expectedReleasePath: extra.expectedReleasePath } : {}),
    ...(extra?.serviceLabel ? { serviceLabel: extra.serviceLabel } : {}),
    ...(extra?.plistPath ? { plistPath: extra.plistPath } : {}),
    ...(extra?.oldPid !== undefined ? { oldPid: extra.oldPid } : {}),
    ...(extra?.newPid !== undefined ? { newPid: extra.newPid } : {}),
    ...(extra?.bootstrapAttempt !== undefined ? { bootstrapAttempts: extra.bootstrapAttempt } : {}),
    ...(extra?.error ? { error: extra.error } : {}),
    ...(phase === 'succeeded' || phase === 'failed' ? { completedAt: now } : {}),
    phases: [...existing.phases, record],
  };
  persistActivationState(home, updated);
  return updated;
}

export function failActivation(
  home: string,
  activationId: string,
  error: string,
  recovery?: unknown,
): ActivationStateRecord {
  return transitionPhase(home, activationId, 'failed', { error, readinessResult: recovery });
}

function persistActivationState(home: string, state: ActivationStateRecord): void {
  const path = activationStatePath(home);
  const dir = join(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJsonAtomic(path, state);
}

/**
 * Check if an activation is idempotent — if the same activationId is already
 * in a terminal state (succeeded/failed), return that state without re-running.
 */
export function resolveExistingActivation(
  home: string,
  activationId: string,
): ActivationStateRecord | undefined {
  const existing = readActivationState(home);
  if (!existing || existing.activationId !== activationId) return undefined;
  if (existing.phase === 'succeeded' || existing.phase === 'failed') return existing;
  return undefined;
}

/**
 * Determine if a phase has already been completed for this activation,
 * allowing resumption after coordinator restart.
 */
export function hasCompletedPhase(home: string, activationId: string, phase: ActivationPhase): boolean {
  const existing = readActivationState(home);
  if (!existing || existing.activationId !== activationId) return false;
  return existing.phases.some((r) => r.phase === phase);
}

/**
 * Get the last recorded phase record for a specific phase.
 */
export function lastPhaseRecord(home: string, activationId: string, phase: ActivationPhase): PhaseRecord | undefined {
  const existing = readActivationState(home);
  if (!existing || existing.activationId !== activationId) return undefined;
  const records = existing.phases.filter((r) => r.phase === phase);
  return records.length > 0 ? records[records.length - 1] : undefined;
}
