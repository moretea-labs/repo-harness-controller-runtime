export type CapabilityState = 'ready' | 'degraded' | 'blocked' | 'unavailable' | 'unknown';

export type RecoveryClass =
  | 'local_recoverable'
  | 'auth_required'
  | 'policy_denied'
  | 'platform_blocked'
  | 'dirty_worktree_conflict'
  | 'stale_runtime_state'
  | 'runtime_storage_not_ready'
  | 'browser_domain_grant_required'
  | 'external_filesystem_grant_required'
  | 'local_jobs_legacy_active'
  | 'local_jobs_unreadable'
  | 'local_jobs_reconciliation_required'
  | 'maintenance_executor_required'
  | 'agent_runtime_failure'
  | 'plugin_configuration_error'
  | 'source_defect_suspected'
  | 'user_action_required'
  | 'unknown';

export type RecoveryRisk = 'readonly' | 'low' | 'medium' | 'high' | 'destructive';
export type RecoveryConfirmation = 'none' | 'authorization' | 'strong_confirmation';

export interface RecoveryEvidence {
  source: string;
  message: string;
  at: string;
  details?: Record<string, unknown>;
}

export interface RecoveryActionDescriptor {
  id: string;
  title: string;
  description: string;
  class: RecoveryClass;
  risk: RecoveryRisk;
  confirmation: RecoveryConfirmation;
  localOnly: boolean;
  boundedTo: string[];
}

export interface CapabilityStatus {
  id: string;
  label: string;
  state: CapabilityState;
  class: RecoveryClass;
  reason: string;
  evidence: RecoveryEvidence[];
  suggestedActions: RecoveryActionDescriptor[];
}

export interface CapabilityRecoveryInput {
  generatedAt?: string;
  daemonStatus?: string;
  daemonError?: string;
  schedulerStatus?: string;
  schedulerHeartbeatAgeMs?: number;
  schedulerDispatchHeartbeatAgeMs?: number;
  queueDepth?: number;
  runningWorkers?: number;
  activeLeases?: number;
  localBridgeRunning?: boolean;
  localBridgeError?: string;
  connectorHealthy?: boolean;
  connectorMismatch?: string;
  runtimeProjectionStale?: boolean;
  runtimeProjectionPersisted?: boolean;
  contextProjectionStale?: boolean;
  commandPreviewAvailable?: boolean;
  commandExecuteAvailable?: boolean;
  issueToolsAvailable?: boolean;
  jobToolsAvailable?: boolean;
  checksAvailable?: boolean;
  runtimeStorageReady?: boolean;
  runtimeStorageWarnings?: string[];
  pluginStates?: Array<{ pluginId: string; enabled: boolean; healthState?: string; ready?: boolean; errors?: string[]; warnings?: string[] }>;
  recentErrors?: string[];
  dirtyPaths?: string[];
  localJobs?: Array<{ status?: string; error?: string; updatedAt?: string }>;
  executionJobs?: Array<{ status?: string; error?: unknown; updatedAt?: string; operation?: string }>;
  assistant?: {
    inboxCount?: number;
    routineCount?: number;
    memoryCount?: number;
  };
}

export interface CapabilityRecoverySummary {
  ready: number;
  degraded: number;
  blocked: number;
  unavailable: number;
  unknown: number;
  topRisks: RecoveryClass[];
  nextBestAction?: RecoveryActionDescriptor;
}

export interface CapabilityRecoverySnapshot {
  schemaVersion: 1;
  generatedAt: string;
  overallState: CapabilityState;
  fallbackRequired: boolean;
  platformBlocked: boolean;
  capabilities: CapabilityStatus[];
  recommendedActions: RecoveryActionDescriptor[];
  summary: CapabilityRecoverySummary;
  notes: string[];
}

export interface RecoveryAuditRecord {
  schemaVersion: 1;
  id: string;
  at: string;
  actor: string;
  actionId: string;
  risk: RecoveryRisk;
  confirmation: RecoveryConfirmation;
  result: 'planned' | 'skipped' | 'succeeded' | 'failed';
  reason: string;
  affectedPaths: string[];
  evidence: RecoveryEvidence[];
}

export interface PatchHandoffArtifact {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  issueId?: string;
  taskId?: string;
  baseHead: string;
  branch: string;
  touchedPaths: string[];
  diffHash: string;
  checks: Array<{ id: string; status: 'passed' | 'failed' | 'skipped'; summary?: string }>;
  provenance: {
    actor: string;
    workspace: 'isolated_worktree' | 'sandbox';
    source: string;
  };
  integration: {
    safeToApply: boolean;
    conflicts: string[];
    notes: string[];
  };
}
