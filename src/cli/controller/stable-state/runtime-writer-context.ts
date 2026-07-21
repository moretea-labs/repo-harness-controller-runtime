/**
 * Per-process writer identity.
 *
 * A versioned runtime captures its authority (slot, generation, epoch,
 * fencing token) at startup / activation. Write paths MUST use this captured
 * claim — never re-read the current authority file and treat it as "mine".
 * After cutover, an old runtime still holding a stale claim is fenced out
 * even if it is still alive.
 */

import type { RuntimeSlotId } from '../runtime-slots';
import {
  assertActiveWriterForAction,
  assertWriterAuthority,
  readWriterAuthority,
  type PassiveForbiddenAction,
  type WriterAuthority,
  type WriterFenceCheck,
} from './writer-authority';
import { resolveStableControllerHome } from './stable-home';

export interface RuntimeWriterClaim {
  /** Root controller home (not a slot home). Authority files live here. */
  rootControllerHome: string;
  slot: RuntimeSlotId;
  generation?: string;
  epoch: string;
  fencingToken: string;
  /** When this process captured the claim. */
  capturedAt: string;
  /** true when claim was inherited from a missing-authority legacy bootstrap. */
  legacy?: boolean;
}

let processClaim: RuntimeWriterClaim | undefined;

export function getRuntimeWriterClaim(): RuntimeWriterClaim | undefined {
  return processClaim;
}

export function clearRuntimeWriterClaimForTests(): void {
  processClaim = undefined;
}

/**
 * Bind the explicit writer identity inherited by a Supervisor-managed CLI
 * child (the Gateway host). Authority presence with a partial/missing claim
 * fails closed; legacy homes without authority remain compatible.
 */
export function bindInheritedRuntimeWriterClaimFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeWriterClaim | undefined {
  if (env.REPO_HARNESS_SUPERVISOR_CHILD !== '1') return undefined;
  const controllerHome = env.REPO_HARNESS_CONTROLLER_HOME?.trim();
  if (!controllerHome) {
    throw new Error('WRITER_CLAIM_BIND_FAILED: supervised child missing controller home');
  }
  const rawSlot = env.REPO_HARNESS_WRITER_SLOT?.trim() ?? env.REPO_HARNESS_RUNTIME_SLOT?.trim();
  const slot = rawSlot === 'blue' || rawSlot === 'green' ? rawSlot : undefined;
  return bindRuntimeWriterClaim({
    controllerHome,
    slot,
    generation: env.REPO_HARNESS_WRITER_GENERATION?.trim(),
    epoch: env.REPO_HARNESS_WRITER_EPOCH?.trim(),
    fencingToken: env.REPO_HARNESS_WRITER_FENCING_TOKEN?.trim(),
    allowLegacyMissing: true,
  });
}

/**
 * Capture writer identity for this process. Prefer explicit values from
 * activation / spawn args (inherited parent claim). Subsequent write checks
 * use the captured claim only — never re-read authority and treat it as "mine".
 *
 * Fail-closed rules:
 * - When explicit epoch+fencingToken are provided, bind that inherited claim
 *   (even if it is already stale vs current authority — fencing happens at write time).
 * - When stable authority exists and the process did not inherit a full claim,
 *   refuse to bind by re-reading current authority (cutover fencing bypass).
 * - Legacy single-runtime homes without authority may still bind a synthetic claim.
 */
export function bindRuntimeWriterClaim(input: {
  controllerHome: string;
  slot?: RuntimeSlotId;
  generation?: string;
  epoch?: string;
  fencingToken?: string;
  /** When true and authority is missing, bind a synthetic legacy claim. */
  allowLegacyMissing?: boolean;
  /**
   * When true, process is allowed to adopt the current authority once at bind
   * (daemon / bootstrap that IS the active writer). Workers must not set this —
   * they must inherit the parent's captured claim explicitly.
   */
  adoptCurrentAuthority?: boolean;
}): RuntimeWriterClaim {
  const root = resolveStableControllerHome(input.controllerHome);
  const authority = readWriterAuthority(root);

  let slot = input.slot;
  if (!slot) {
    // Infer slot from path .../runtime-slots/<slot>
    const match = root === input.controllerHome
      ? undefined
      : /\/runtime-slots\/(blue|green)(?:\/|$)/.exec(input.controllerHome.replace(/\\/g, '/'));
    if (match?.[1] === 'blue' || match?.[1] === 'green') slot = match[1];
    else if (authority && input.adoptCurrentAuthority) slot = authority.activeSlot;
  }
  if (!slot) {
    if (authority && input.adoptCurrentAuthority) slot = authority.activeSlot;
    else if (!authority) slot = 'green';
  }

  // Explicit inherited claim always wins — never overwrite with current authority.
  if (input.epoch && input.fencingToken) {
    if (!slot) {
      throw new Error('WRITER_CLAIM_BIND_FAILED: inherited claim missing slot');
    }
    processClaim = {
      rootControllerHome: root,
      slot,
      generation: input.generation ?? authority?.generation,
      epoch: input.epoch,
      fencingToken: input.fencingToken,
      capturedAt: new Date().toISOString(),
    };
    return processClaim;
  }

  // Partial claim while authority exists → fail closed (worker must inherit full claim).
  if (authority && !input.adoptCurrentAuthority) {
    throw new Error(
      'WRITER_CLAIM_BIND_FAILED: stable authority present but process did not inherit full writer claim '
      + '(slot/epoch/fencingToken); refusing to adopt current active authority',
    );
  }

  if (authority && input.adoptCurrentAuthority) {
    if (!slot) slot = authority.activeSlot;
    processClaim = {
      rootControllerHome: root,
      slot,
      generation: input.generation ?? authority.generation,
      epoch: authority.epoch,
      fencingToken: authority.fencingToken,
      capturedAt: new Date().toISOString(),
    };
    return processClaim;
  }

  if (input.allowLegacyMissing && !authority) {
    if (!slot) slot = 'green';
    processClaim = {
      rootControllerHome: root,
      slot,
      generation: input.generation,
      epoch: `legacy-${process.pid}`,
      fencingToken: `legacy-${process.pid}`,
      capturedAt: new Date().toISOString(),
      legacy: true,
    };
    return processClaim;
  }

  throw new Error('WRITER_CLAIM_BIND_FAILED: no writer authority and legacy not allowed');
}

export function requireRuntimeWriterClaim(): RuntimeWriterClaim {
  if (!processClaim) {
    throw new Error('WRITER_CLAIM_UNBOUND: call bindRuntimeWriterClaim at runtime startup');
  }
  return processClaim;
}

/**
 * Assert this process still holds active write authority.
 * Always compares the *captured* claim against the current authority file.
 */
export function assertThisRuntimeMayWrite(
  action?: PassiveForbiddenAction,
  controllerHomeOverride?: string,
): WriterFenceCheck {
  const claim = processClaim;
  if (!claim) {
    // Unbound: allow only when authority is missing (single-process / tests).
    const home = controllerHomeOverride
      ? resolveStableControllerHome(controllerHomeOverride)
      : undefined;
    if (!home) return { allowed: true, reason: 'unbound_no_home' };
    const authority = readWriterAuthority(home);
    if (!authority) return { allowed: true, reason: 'unbound_legacy_missing_authority' };
    return { allowed: false, reason: 'writer_claim_unbound_while_authority_present', authority };
  }

  const home = controllerHomeOverride
    ? resolveStableControllerHome(controllerHomeOverride)
    : claim.rootControllerHome;

  if (action) {
    return assertActiveWriterForAction(home, {
      slot: claim.slot,
      epoch: claim.epoch,
      fencingToken: claim.fencingToken,
      allowLegacyMissing: claim.legacy === true,
    }, action);
  }
  return assertWriterAuthority(home, {
    slot: claim.slot,
    epoch: claim.epoch,
    fencingToken: claim.fencingToken,
    allowLegacyMissing: claim.legacy === true,
  });
}

export function assertThisRuntimeMayWriteOrThrow(
  action: PassiveForbiddenAction,
  controllerHomeOverride?: string,
): WriterAuthority | undefined {
  const check = assertThisRuntimeMayWrite(action, controllerHomeOverride);
  if (!check.allowed) {
    throw new Error(
      `WRITER_FENCED:${action}:${check.reason ?? 'denied'}`,
    );
  }
  return check.authority;
}
