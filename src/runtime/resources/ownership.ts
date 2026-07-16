export type ResourceOwnerKind =
  | 'execution_job'
  | 'agent_run'
  | 'campaign'
  | 'work_contract'
  | 'edit_session'
  | 'controller_generation'
  | 'runtime_slot'
  | 'repository'
  | 'schedule';

export interface ResourceOwner {
  kind: ResourceOwnerKind;
  id: string;
}

export type ManagedResourceType =
  | 'temp_dir'
  | 'worktree'
  | 'branch'
  | 'artifact'
  | 'edit_session'
  | 'runtime_slot';

export type ManagedResourceState =
  | 'active'
  | 'retained'
  | 'completed'
  | 'abandoned'
  | 'cleanup_eligible'
  | 'removing'
  | 'removed'
  | 'cleanup_failed';

/**
 * Ownership is embedded in the lifecycle record that created a resource.
 * This is deliberately not a global registry: a missing descriptor remains
 * unknown and therefore protected by cleanup collectors.
 */
export interface ManagedResource {
  resourceId: string;
  type: ManagedResourceType;
  owner: ResourceOwner;
  createdAt: string;
  lastSeenAt: string;
  state: ManagedResourceState;
  retentionReason?: string;
  cleanupAfter?: string;
  path?: string;
  branch?: string;
}

export function managedResource(input: Omit<ManagedResource, 'lastSeenAt'> & { lastSeenAt?: string }): ManagedResource {
  return {
    ...input,
    lastSeenAt: input.lastSeenAt ?? input.createdAt,
  };
}

export function isKnownManagedResource(value: unknown): value is ManagedResource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const resource = value as Record<string, unknown>;
  return typeof resource.resourceId === 'string'
    && typeof resource.type === 'string'
    && typeof resource.owner === 'object'
    && resource.owner !== null
    && typeof (resource.owner as Record<string, unknown>).kind === 'string'
    && typeof (resource.owner as Record<string, unknown>).id === 'string'
    && typeof resource.createdAt === 'string'
    && typeof resource.lastSeenAt === 'string'
    && typeof resource.state === 'string';
}
