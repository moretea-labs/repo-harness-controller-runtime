import { existsSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { writeJsonAtomic } from '../shared/json-files';
import { readActiveSlotAuthority } from '../../cli/controller/runtime-slots';
import { readRuntimeGeneration } from '../control-plane/runtime-generation';
import { ensureStableSupervisorLayout, supervisorStatePath } from './paths';
import type { ProcessIdentity, SupervisorState } from './types';

export function readSupervisorState(controllerHome: string): SupervisorState | null {
  const path = supervisorStatePath(controllerHome);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as SupervisorState;
    if (value?.schemaVersion !== 1 || !value.supervisor || !value.ingress || !value.restartBudget) return null;
    return value;
  } catch {
    return null;
  }
}

export function writeSupervisorState(controllerHome: string, state: SupervisorState): SupervisorState {
  ensureStableSupervisorLayout(controllerHome);
  writeJsonAtomic(supervisorStatePath(controllerHome), state);
  return state;
}

export function updateSupervisorState(
  controllerHome: string,
  patch: Partial<SupervisorState>,
): SupervisorState {
  const current = readSupervisorState(controllerHome);
  if (!current) throw new Error('SUPERVISOR_STATE_NOT_FOUND');
  return writeSupervisorState(controllerHome, { ...current, ...patch, updatedAt: new Date().toISOString() });
}

export function createSupervisorState(
  controllerHome: string,
  identity: ProcessIdentity,
  input: { releaseRevision?: string; startedAt?: string } = {},
): SupervisorState {
  const authority = readActiveSlotAuthority(controllerHome);
  const generation = readRuntimeGeneration(controllerHome);
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    supervisor: {
      ...identity,
      epoch: identity.ownerEpoch,
      startedAt: input.startedAt ?? now,
      ...(input.releaseRevision ? { releaseRevision: input.releaseRevision } : {}),
    },
    desiredState: 'running',
    observedState: 'starting',
    activeSlot: authority.activeSlot,
    ...(authority.previousSlot ? { previousSlot: authority.previousSlot } : {}),
    ...(authority.generation ?? generation?.generation ? { activeGeneration: authority.generation ?? generation?.generation } : {}),
    ingress: {
      state: 'stopped',
      activeUpstreamSlot: authority.activeSlot,
    },
    restartBudget: {},
    currentOperationId: null,
    lastIncident: null,
    updatedAt: now,
  };
}

export function supervisorEpoch(controllerHome: string): number | undefined {
  return readSupervisorState(controllerHome)?.supervisor.epoch;
}

export function isSupervisorOwnerProcess(controllerHome: string, pid = process.pid): boolean {
  return readSupervisorState(controllerHome)?.supervisor.pid === pid;
}

export function freshSupervisorInstanceId(): string {
  return `sup-${randomUUID()}`;
}
