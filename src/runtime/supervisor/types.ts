import type { RuntimeSlotId } from '../../cli/controller/runtime-slots';

export const STABLE_SUPERVISOR_SCHEMA_VERSION = 1 as const;

export type SupervisorDesiredState = 'running' | 'stopped';
export type SupervisorObservedState = 'starting' | 'healthy' | 'degraded' | 'stopped' | 'locked_out';
export type SupervisorComponentName = 'controllerDaemon' | 'gatewayHost';
export type SupervisorComponentState = 'starting' | 'running' | 'stopped' | 'failed' | 'locked_out' | 'unknown';

export type SupervisorOperationKind =
  | 'restart_controller'
  | 'restart_gateway'
  | 'restart_full'
  | 'rollout'
  | 'rollback'
  | 'unlock_and_recover';

export type SupervisorOperationPhase =
  | 'accepted'
  | 'scheduled'
  | 'stopping'
  | 'starting'
  | 'verifying'
  | 'switching_ingress'
  | 'cutover'
  | 'rolling_back'
  | 'succeeded'
  | 'failed'
  | 'locked_out';

export const TERMINAL_SUPERVISOR_OPERATION_PHASES: readonly SupervisorOperationPhase[] = [
  'succeeded',
  'failed',
  'locked_out',
];

export interface ProcessIdentity {
  pid: number;
  instanceId: string;
  processStartTime: string;
  executableFingerprint: string;
  controllerHome: string;
  slot?: RuntimeSlotId;
  generation?: string;
  ownerEpoch: number;
}

export interface SupervisorManagedProcess extends ProcessIdentity {
  state: SupervisorComponentState;
  lastLivenessAt?: string;
  restartCount: number;
  consecutiveFailures: number;
  lastExit?: string;
  lastFailureAt?: string;
}

export interface RestartBudgetRecord {
  key: string;
  component: SupervisorComponentName;
  generation?: string;
  windowStartedAt: string;
  attempts: number;
  consecutiveFailures: number;
  lastRestartAt?: string;
  lastFailureAt?: string;
  stableSinceAt?: string;
  lockedOut: boolean;
  autoRollbackCount: number;
  reason?: string;
}

export interface SupervisorState {
  schemaVersion: typeof STABLE_SUPERVISOR_SCHEMA_VERSION;
  supervisor: ProcessIdentity & {
    epoch: number;
    startedAt: string;
    releaseRevision?: string;
  };
  desiredState: SupervisorDesiredState;
  observedState: SupervisorObservedState;
  activeSlot: RuntimeSlotId;
  previousSlot?: RuntimeSlotId;
  activeGeneration?: string;
  controllerDaemon?: SupervisorManagedProcess;
  gatewayHost?: SupervisorManagedProcess;
  ingress: {
    state: 'running' | 'degraded' | 'stopped';
    activeUpstreamSlot: RuntimeSlotId;
    activeUpstreamPort?: number;
    lastHealthyAt?: string;
  };
  control?: {
    host: string;
    port: number;
    socketPath: string;
    rescueEndpoint: string;
  };
  restartBudget: Record<string, RestartBudgetRecord>;
  currentOperationId?: string | null;
  lastIncident?: {
    at: string;
    component?: SupervisorComponentName;
    reason: string;
    operationId?: string;
  } | null;
  updatedAt: string;
}

export interface SupervisorOperation {
  schemaVersion: typeof STABLE_SUPERVISOR_SCHEMA_VERSION;
  operationId: string;
  requestId: string;
  kind: SupervisorOperationKind;
  controllerHome: string;
  repoRoot?: string;
  requestedBy: string;
  actor: string;
  reason?: string;
  phase: SupervisorOperationPhase;
  acceptedAt: string;
  scheduledAt?: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  reconnectContract: 'stable_domain_retry';
  failureClass?: 'identity' | 'budget' | 'startup' | 'readiness' | 'ingress' | 'authorization' | 'unknown';
  error?: string;
  evidence?: Array<{ kind: string; summary: string; at: string }>;
  result?: Record<string, unknown>;
}

export interface SupervisorCommandRequest {
  command: 'status' | 'operation_submit' | 'operation_get' | 'stop' | 'ping';
  requestId?: string;
  actor?: string;
  requestedBy?: string;
  kind?: SupervisorOperationKind;
  operationId?: string;
  repoRoot?: string;
  reason?: string;
}

export interface SupervisorCommandResponse {
  ok: boolean;
  deduplicated?: boolean;
  error?: { code: string; message: string };
  state?: SupervisorState;
  operation?: SupervisorOperation;
}
