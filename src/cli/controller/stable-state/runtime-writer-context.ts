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
 * Capture writer identity for this process. Prefer explicit values from
 * activation / spawn args; fall back to reading authority once at bind time.
 * Subsequent write checks use the captured claim only.
 */
export function bindRuntimeWriterClaim(input: {
  controllerHome: string;
  slot?: RuntimeSlotId;
  generation?: string;
  epoch?: string;
  fencingToken?: string;
  /** When true and authority is missing, bind a synthetic legacy claim. */
  allowLegacyMissing?: boolean;
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
    else if (authority) slot = authority.activeSlot;
  }
  if (!slot) slot = authority?.activeSlot ?? 'green';

  if (input.epoch && input.fencingToken) {
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

  if (authority) {
    processClaim = {
      rootControllerHome: root,
      slot: input.slot ?? authority.activeSlot,
      generation: input.generation ?? authority.generation,
      epoch: authority.epoch,
      fencingToken: authority.fencingToken,
      capturedAt: new Date().toISOString(),
    };
    return processClaim;
  }

  if (input.allowLegacyMissing) {
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
