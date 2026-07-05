import { createHash } from 'crypto';
import type { PatchHandoffArtifact } from './types';

export interface BuildPatchHandoffArtifactInput {
  issueId?: string;
  taskId?: string;
  baseHead: string;
  branch: string;
  diff: string;
  touchedPaths: string[];
  checks?: PatchHandoffArtifact['checks'];
  actor: string;
  source: string;
  conflicts?: string[];
  notes?: string[];
  createdAt?: string;
}

export function buildPatchHandoffArtifact(input: BuildPatchHandoffArtifactInput): PatchHandoffArtifact {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const diffHash = createHash('sha256').update(input.diff).digest('hex');
  const conflicts = [...new Set(input.conflicts ?? [])].sort();
  return {
    schemaVersion: 1,
    id: `PATCH-${diffHash.slice(0, 16)}`,
    createdAt,
    issueId: input.issueId,
    taskId: input.taskId,
    baseHead: input.baseHead,
    branch: input.branch,
    touchedPaths: [...new Set(input.touchedPaths)].sort(),
    diffHash,
    checks: input.checks ?? [],
    provenance: {
      actor: input.actor,
      workspace: 'isolated_worktree',
      source: input.source,
    },
    integration: {
      safeToApply: conflicts.length === 0,
      conflicts,
      notes: input.notes ?? [],
    },
  };
}

export function detectDirtyPathConflicts(touchedPaths: readonly string[], dirtyPaths: readonly string[]): string[] {
  const dirty = new Set(dirtyPaths);
  return [...new Set(touchedPaths)].filter((path) => dirty.has(path)).sort();
}
