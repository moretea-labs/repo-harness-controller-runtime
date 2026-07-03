import type { ExecutionJobOrigin, ResourceClaimMode } from '../execution/jobs/types';

export type AssistantPluginLifecycleState = 'enabled' | 'disabled' | 'degraded' | 'error';
export type AssistantPluginHealthState = 'ready' | 'disabled' | 'degraded' | 'error';
export type AssistantPluginActionRisk = 'readonly' | 'workspace_write' | 'remote_write' | 'destructive';
export type AssistantPluginActionConfirmation = 'none' | 'authorization' | 'strong_confirmation';
export type AssistantPluginResource = 'repo-state' | 'workspace' | 'remote' | 'git-refs';

export interface AssistantPluginPermissionScope {
  scope: string;
  mode: 'read' | 'write';
  description: string;
  granted: boolean;
  required: boolean;
}

export interface AssistantPluginCapability {
  capabilityId: string;
  title: string;
  description: string;
  scopes: string[];
  actions: string[];
}

export interface AssistantPluginActionResourceClaim {
  resource: AssistantPluginResource;
  mode: ResourceClaimMode;
}

export interface AssistantPluginActionDescriptor {
  actionId: string;
  title: string;
  description: string;
  readOnly: boolean;
  risk: AssistantPluginActionRisk;
  confirmation: AssistantPluginActionConfirmation;
  requiredConfirmationText?: string;
  defaultTimeoutMs: number;
  cancellable: boolean;
  idempotent: boolean;
  scopes: string[];
  resourceClaims: AssistantPluginActionResourceClaim[];
  argumentsSchema: Record<string, unknown>;
}

export interface AssistantPluginHealth {
  state: AssistantPluginHealthState;
  checkedAt: string;
  ready: boolean;
  probed: boolean;
  errors: string[];
  warnings: string[];
  details?: Record<string, unknown>;
}

export interface AssistantPluginManifest {
  schemaVersion: 1;
  manifestVersion: 1;
  revision: number;
  pluginId: string;
  provider: string;
  displayName: string;
  pluginVersion: string;
  authority: {
    strategy: 'derived';
    duplicateStateAllowed: false;
    sourceOfTruth: string[];
  };
  enabled: boolean;
  lifecycle: {
    state: AssistantPluginLifecycleState;
    reason?: string;
  };
  health: AssistantPluginHealth;
  permissions: AssistantPluginPermissionScope[];
  capabilities: AssistantPluginCapability[];
  actions: AssistantPluginActionDescriptor[];
  updatedAt: string;
}

export interface AssistantPluginRegistryIndexEntry {
  pluginId: string;
  provider: string;
  displayName: string;
  enabled: boolean;
  lifecycleState: AssistantPluginLifecycleState;
  healthState: AssistantPluginHealthState;
  revision: number;
  manifestPath: string;
  updatedAt: string;
}

export interface AssistantPluginRegistryIndex {
  schemaVersion: 1;
  updatedAt: string;
  plugins: AssistantPluginRegistryIndexEntry[];
}

export interface AssistantPluginActionRequest {
  pluginId: string;
  actionId: string;
  requestId: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  confirmAuthorization?: boolean;
  confirmationText?: string;
  origin: ExecutionJobOrigin;
}

export interface AssistantPluginActionExecutionInput {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
  pluginId: string;
  actionId: string;
  requestId: string;
  args: Record<string, unknown>;
  origin: ExecutionJobOrigin;
  jobId?: string;
}
