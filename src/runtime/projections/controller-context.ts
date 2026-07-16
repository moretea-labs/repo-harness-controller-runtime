import { join } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';

export interface ControllerContextProjection {
  schemaVersion: 1;
  repoId: string;
  generatedAt: string;
  /** Source identity is additive and is not a heartbeat. */
  sourceRevision?: string;
  contentFingerprint?: string;
  lastSuccessfulBuildAt?: string;
  payload: Record<string, unknown>;
}

function contextProjectionPath(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'projections', 'controller-context.json');
}

export function writeControllerContextProjection(
  controllerHome: string,
  repoId: string,
  payload: Record<string, unknown>,
  options: { sourceRevision?: string; contentFingerprint?: string } = {},
): ControllerContextProjection {
  const generatedAt = new Date().toISOString();
  const projection: ControllerContextProjection = {
    schemaVersion: 1,
    repoId,
    generatedAt,
    ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    ...(options.contentFingerprint ? { contentFingerprint: options.contentFingerprint } : {}),
    lastSuccessfulBuildAt: generatedAt,
    payload,
  };
  writeJsonAtomic(contextProjectionPath(controllerHome, repoId), projection);
  return projection;
}

export function readControllerContextProjection(
  controllerHome: string,
  repoId: string,
): ControllerContextProjection | undefined {
  try {
    const projection = readJsonFile<ControllerContextProjection>(contextProjectionPath(controllerHome, repoId));
    if (projection.schemaVersion !== 1 || projection.repoId !== repoId || !projection.payload) return undefined;
    return projection;
  } catch {
    return undefined;
  }
}

export function controllerContextProjectionAgeMs(projection: ControllerContextProjection | undefined): number {
  if (!projection) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(projection.generatedAt);
  return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : Number.POSITIVE_INFINITY;
}

export function controllerContextProjectionNeedsRefresh(
  projection: ControllerContextProjection | undefined,
  sourceRevision?: string,
): boolean {
  if (!projection) return true;
  if (!sourceRevision) return false;
  return projection.sourceRevision !== sourceRevision;
}
