import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';
import { assertThisRuntimeMayWrite } from '../../cli/controller/stable-state/runtime-writer-context';

export interface ProjectionDirtyMarker {
  schemaVersion: 1;
  repoId: string;
  reason: string;
  markedAt: string;
  nonce: string;
}

function dirtyPath(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'projections', 'runtime.dirty.json');
}

export function markRepositoryProjectionDirty(controllerHome: string, repoId: string, reason: string): void {
  try {
    const fence = assertThisRuntimeMayWrite('update_active_projection', controllerHome);
    if (!fence.allowed) {
      // Passive candidates must not mutate projections.
      return;
    }
  } catch {
    /* unbound / legacy */
  }
  writeJsonAtomic(dirtyPath(controllerHome, repoId), {
    schemaVersion: 1,
    repoId,
    reason,
    markedAt: new Date().toISOString(),
    nonce: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  } satisfies ProjectionDirtyMarker);
}

export function readRepositoryProjectionDirty(controllerHome: string, repoId: string): ProjectionDirtyMarker | undefined {
  const path = dirtyPath(controllerHome, repoId);
  if (!existsSync(path)) return undefined;
  try { return readJsonFile<ProjectionDirtyMarker>(path); } catch { return undefined; }
}

export function repositoryProjectionIsDirty(controllerHome: string, repoId: string): boolean {
  return existsSync(dirtyPath(controllerHome, repoId));
}

export function clearRepositoryProjectionDirty(
  controllerHome: string,
  repoId: string,
  expected?: ProjectionDirtyMarker,
): void {
  if (!expected) return;
  const current = readRepositoryProjectionDirty(controllerHome, repoId);
  if (current?.nonce === expected.nonce) rmSync(dirtyPath(controllerHome, repoId), { force: true });
}
