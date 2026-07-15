import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';

export const ACCESS_MODES = ['request', 'full_access'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export type AccessEffect =
  | 'read'
  | 'local_repo_write'
  | 'workspace_write'
  | 'local_command'
  | 'dependency_change'
  | 'local_git'
  | 'external_network'
  | 'remote_write'
  | 'destructive'
  | 'secret_access'
  | 'outside_repository';

export type AccessDecision = 'allow' | 'request' | 'deny';

export interface RepositoryAccessPolicy {
  schemaVersion: 1;
  repoId: string;
  mode: AccessMode;
  /** Monotonic effective-policy version used to invalidate cached execution state. */
  revision: number;
  updatedAt: string;
  updatedBy: 'user' | 'system';
}

export interface AccessModeDescriptor {
  mode: AccessMode;
  label: string;
  shortLabel: string;
  description: string;
  automaticallyAllowed: string[];
  stillRequiresApproval: string[];
  alwaysDenied: string[];
}

export const ACCESS_MODE_DESCRIPTORS: Record<AccessMode, AccessModeDescriptor> = {
  request: {
    mode: 'request',
    label: 'Compatibility mode — host permissions are authoritative',
    shortLabel: 'Compatibility',
    description: 'Legacy Request settings are retained for stored-state compatibility only. Normal repository and remote operations follow the host AI permission model.',
    automaticallyAllowed: ['Repository reads and writes', 'Repository-scoped commands and Git', 'Dependencies, network access, and ordinary remote writes'],
    stillRequiresApproval: ['Outside-repository access', 'Irreversible or destructive operations'],
    alwaysDenied: ['Raw secrets or credentials', 'Bypassing controller safety boundaries'],
  },
  full_access: {
    mode: 'full_access',
    label: 'Host-managed execution — normal work proceeds',
    shortLabel: 'Host managed',
    description: 'Normal work follows the host AI permission model. Repo Harness only keeps hard safety gates for secrets, outside-repository access, and destructive operations.',
    automaticallyAllowed: ['Repository file reads/writes', 'Repository-scoped commands and Git', 'Dependencies, network access, and ordinary remote writes'],
    stillRequiresApproval: ['Outside-repository access', 'Irreversible or destructive operations'],
    alwaysDenied: ['Raw secrets or credentials', 'Bypassing controller safety boundaries'],
  },
};

export function isAccessMode(value: unknown): value is AccessMode {
  return value === 'request' || value === 'full_access';
}

export function normalizeAccessMode(value: unknown, fallback: AccessMode = 'full_access'): AccessMode {
  return isAccessMode(value) ? value : fallback;
}

export function repositoryAccessPolicyPath(controllerHome: string, repoId: string): string {
  return join(resolve(controllerHome), 'repositories', repoId, 'controller', 'access-policy.json');
}

function defaultPolicy(repoId: string): RepositoryAccessPolicy {
  return {
    schemaVersion: 1,
    repoId,
    mode: 'full_access',
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'system',
  };
}

export function readRepositoryAccessPolicy(controllerHome: string, repoId: string): RepositoryAccessPolicy {
  const path = repositoryAccessPolicyPath(controllerHome, repoId);
  if (!existsSync(path)) return defaultPolicy(repoId);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RepositoryAccessPolicy>;
    return {
      schemaVersion: 1,
      repoId,
      // Legacy values remain readable, but malformed policy no longer creates
      // a user-facing approval mode. Hard safety gates are evaluated separately.
      mode: normalizeAccessMode(parsed.mode, 'full_access'),
      revision: typeof parsed.revision === 'number' && Number.isFinite(parsed.revision)
        ? Math.max(1, Math.trunc(parsed.revision))
        : 1,
      updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim()
        ? parsed.updatedAt
        : new Date(0).toISOString(),
      updatedBy: parsed.updatedBy === 'user' ? 'user' : 'system',
    };
  } catch {
    return defaultPolicy(repoId);
  }
}

export function writeRepositoryAccessPolicy(
  controllerHome: string,
  repoId: string,
  mode: AccessMode,
  updatedBy: RepositoryAccessPolicy['updatedBy'] = 'user',
): RepositoryAccessPolicy {
  const path = repositoryAccessPolicyPath(controllerHome, repoId);
  mkdirSync(dirname(path), { recursive: true });
  const previous = readRepositoryAccessPolicy(controllerHome, repoId);
  const policy: RepositoryAccessPolicy = {
    schemaVersion: 1,
    repoId,
    mode,
    revision: previous.mode === mode ? previous.revision : previous.revision + 1,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(policy, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tempPath, path);
  return policy;
}

export function evaluateAccessMode(_mode: AccessMode, effect: AccessEffect): AccessDecision {
  if (effect === 'secret_access') return 'deny';
  if (effect === 'outside_repository' || effect === 'destructive') return 'request';
  return 'allow';
}

export function accessModeDescriptor(mode: AccessMode): AccessModeDescriptor {
  return ACCESS_MODE_DESCRIPTORS[mode];
}
