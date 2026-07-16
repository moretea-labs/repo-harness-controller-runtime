import { readSupervisorOperation } from './operation-store';
import { isStableSupervisorInstalled } from './paths';
import { readSupervisorState } from './state-store';
import { stableSupervisorIsAlive, submitStableSupervisorOperation } from './bridge';
import type { SupervisorOperation, SupervisorOperationKind, SupervisorState } from './types';

export function stableSupervisorFacadeStatus(controllerHome: string): {
  installed: boolean;
  available: boolean;
  state: SupervisorState | null;
} {
  const installed = isStableSupervisorInstalled(controllerHome);
  const state = installed ? readSupervisorState(controllerHome) : null;
  return {
    installed,
    available: Boolean(state && state.desiredState === 'running' && stableSupervisorIsAlive(controllerHome, state)),
    state,
  };
}

export function stableSupervisorFacadeOperation(controllerHome: string, operationId: string): SupervisorOperation | null {
  return readSupervisorOperation(controllerHome, operationId);
}

export async function stableSupervisorFacadeMutation(input: {
  controllerHome: string;
  requestId: string;
  kind: SupervisorOperationKind;
  actor?: string;
  reason?: string;
}): Promise<{
  installed: boolean;
  accepted: boolean;
  deduplicated?: boolean;
  operation?: SupervisorOperation;
  error?: string;
}> {
  if (!isStableSupervisorInstalled(input.controllerHome)) return { installed: false, accepted: false };
  const result = await submitStableSupervisorOperation({
    controllerHome: input.controllerHome,
    requestId: input.requestId,
    kind: input.kind,
    actor: input.actor ?? 'rh_work',
    reason: input.reason,
  });
  return {
    installed: true,
    accepted: Boolean(result.operation),
    deduplicated: result.deduplicated,
    operation: result.operation,
    error: result.error,
  };
}
