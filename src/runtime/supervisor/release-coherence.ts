import { resolve } from 'path';
import type { ActiveSlotAuthority, SlotIdentity } from '../../cli/controller/runtime-slots';
import type { SupervisorState } from './types';

export interface RuntimeReleaseCoherence {
  ok: boolean;
  legacyReleaseMetadata: boolean;
  releasePathCoherent: boolean;
  releaseRevisionCoherent: boolean;
  releaseCoherent: boolean;
  generationCoherent: boolean;
  slotCoherent: boolean;
  failures: string[];
}

function normalizedPath(value: string | undefined): string | undefined {
  return value ? resolve(value) : undefined;
}

function compareRequiredValues(
  label: string,
  values: Array<{ name: string; value: string | undefined }>,
  failures: string[],
  options: { allowAllMissing?: boolean } = {},
): { coherent: boolean; allMissing: boolean } {
  const present = values.filter((entry) => entry.value !== undefined);
  if (present.length === 0) {
    if (options.allowAllMissing) return { coherent: true, allMissing: true };
    failures.push(`${label} metadata is missing`);
    return { coherent: false, allMissing: true };
  }
  if (present.length !== values.length) {
    const missing = values.filter((entry) => entry.value === undefined).map((entry) => entry.name);
    failures.push(`${label} metadata is partial; missing ${missing.join(', ')}`);
    return { coherent: false, allMissing: false };
  }
  const expected = present[0]!.value;
  const mismatched = present.filter((entry) => entry.value !== expected);
  if (mismatched.length > 0) {
    failures.push(`${label} mismatch: ${present.map((entry) => `${entry.name}=${entry.value}`).join(' ')}`);
    return { coherent: false, allMissing: false };
  }
  return { coherent: true, allMissing: false };
}

/**
 * Evaluate the exact immutable release and runtime generation owned by the
 * active Stable Supervisor slot. Legacy runtimes are accepted only when every
 * release metadata field is absent; partially populated metadata fails closed.
 */
export function evaluateRuntimeReleaseCoherence(input: {
  supervisorState: SupervisorState | null | undefined;
  authority: ActiveSlotAuthority;
  slotIdentity?: SlotIdentity;
}): RuntimeReleaseCoherence {
  const state = input.supervisorState;
  if (!state) {
    return {
      ok: true,
      legacyReleaseMetadata: true,
      releasePathCoherent: true,
      releaseRevisionCoherent: true,
      releaseCoherent: true,
      generationCoherent: true,
      slotCoherent: true,
      failures: [],
    };
  }

  const failures: string[] = [];
  const releasePaths = compareRequiredValues('release path', [
    { name: 'supervisor', value: normalizedPath(state.supervisor.releasePath) },
    { name: 'daemon', value: normalizedPath(state.controllerDaemon?.releasePath) },
    { name: 'gateway', value: normalizedPath(state.gatewayHost?.releasePath) },
    { name: 'slot', value: normalizedPath(input.slotIdentity?.releasePath) },
  ], failures, { allowAllMissing: true });
  const releaseRevisions = compareRequiredValues('release revision', [
    { name: 'supervisor', value: state.supervisor.releaseRevision },
    { name: 'daemon', value: state.controllerDaemon?.releaseRevision },
    { name: 'gateway', value: state.gatewayHost?.releaseRevision },
    { name: 'slot', value: input.slotIdentity?.releaseRevision },
  ], failures, { allowAllMissing: true });
  const generations = compareRequiredValues('runtime generation', [
    { name: 'supervisor-state', value: state.activeGeneration },
    { name: 'daemon', value: state.controllerDaemon?.generation },
    { name: 'gateway', value: state.gatewayHost?.generation },
    { name: 'authority', value: input.authority.generation },
    { name: 'slot', value: input.slotIdentity?.generation },
  ], failures);
  const slots = compareRequiredValues('active slot', [
    { name: 'supervisor-state', value: state.activeSlot },
    { name: 'daemon', value: state.controllerDaemon?.slot },
    { name: 'gateway', value: state.gatewayHost?.slot },
    { name: 'authority', value: input.authority.activeSlot },
    { name: 'slot-identity', value: input.slotIdentity?.slot },
  ], failures);

  const legacyReleaseMetadata = releasePaths.allMissing && releaseRevisions.allMissing;
  if (releasePaths.allMissing !== releaseRevisions.allMissing) {
    failures.push('release metadata is partial across path and revision fields');
  }
  const releasePathCoherent = releasePaths.coherent;
  const releaseRevisionCoherent = releaseRevisions.coherent;
  const releaseCoherent = releasePathCoherent
    && releaseRevisionCoherent
    && releasePaths.allMissing === releaseRevisions.allMissing;
  const generationCoherent = generations.coherent;
  const slotCoherent = slots.coherent;

  return {
    ok: releaseCoherent && generationCoherent && slotCoherent,
    legacyReleaseMetadata,
    releasePathCoherent,
    releaseRevisionCoherent,
    releaseCoherent,
    generationCoherent,
    slotCoherent,
    failures,
  };
}
