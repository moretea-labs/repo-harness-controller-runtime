import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { ensureControllerHome } from '../repositories/controller-home';
import { managedResource, type ManagedResource } from '../../runtime/resources';

export type RuntimeSlotId = 'blue' | 'green';

export interface ActiveSlotAuthority {
  schemaVersion: 1;
  activeSlot: RuntimeSlotId;
  previousSlot?: RuntimeSlotId;
  generation?: string;
  updatedAt: string;
  reason?: string;
  /** ISO timestamp until which the previous slot may be used for rollback. */
  rollbackUntil?: string;
}

export interface SlotIdentity {
  schemaVersion: 1;
  slot: RuntimeSlotId;
  role: 'active' | 'inactive' | 'candidate' | 'standby' | 'failed';
  controllerHome: string;
  slotHome: string;
  mcpPort: number;
  localControllerPort: number;
  generation?: string;
  sourceCommit?: string;
  releasePath?: string;
  releaseRevision?: string;
  startedAt?: string;
  updatedAt: string;
  processGroupLeader?: number;
  logDir: string;
  /** Additive ownership metadata for slot-home cleanup protection. */
  resources?: ManagedResource[];
}

export interface SlotPortAllocation {
  mcpPort: number;
  localControllerPort: number;
}

const DEFAULT_MCP_PORT = 8765;
const DEFAULT_LOCAL_PORT = 8766;
const SLOT_PORT_STRIDE = 10;
const DEFAULT_ROLLBACK_WINDOW_MS = 15 * 60_000;

function nowIso(): string {
  return new Date().toISOString();
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function activeSlotAuthorityPath(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'active-slot.json');
}

export function runtimeSlotsRoot(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'runtime-slots');
}

export function slotHomePath(controllerHome: string, slot: RuntimeSlotId): string {
  return join(runtimeSlotsRoot(controllerHome), slot);
}

export function slotIdentityPath(controllerHome: string, slot: RuntimeSlotId): string {
  return join(slotHomePath(controllerHome, slot), 'slot.json');
}

export function slotLogDir(controllerHome: string, slot: RuntimeSlotId): string {
  return join(slotHomePath(controllerHome, slot), 'logs');
}

export function oppositeSlot(slot: RuntimeSlotId): RuntimeSlotId {
  return slot === 'blue' ? 'green' : 'blue';
}

/** Returns the slot encoded by a dedicated slot home without reading or writing state. */
export function runtimeSlotForHome(controllerHome: string): RuntimeSlotId | undefined {
  const normalized = resolve(controllerHome).replace(/\\/g, '/');
  const match = normalized.match(/\/runtime-slots\/(blue|green)$/);
  return match?.[1] === 'blue' || match?.[1] === 'green' ? match[1] : undefined;
}

export function readActiveSlotAuthority(controllerHome: string): ActiveSlotAuthority {
  const path = activeSlotAuthorityPath(controllerHome);
  const value = readJson<ActiveSlotAuthority>(path);
  if (value?.schemaVersion === 1 && (value.activeSlot === 'blue' || value.activeSlot === 'green')) {
    return value;
  }
  return {
    schemaVersion: 1,
    activeSlot: 'blue',
    updatedAt: nowIso(),
    reason: 'default-bootstrap',
  };
}

export function writeActiveSlotAuthority(
  controllerHome: string,
  patch: Omit<ActiveSlotAuthority, 'schemaVersion' | 'updatedAt'> & { updatedAt?: string },
): ActiveSlotAuthority {
  const next: ActiveSlotAuthority = {
    schemaVersion: 1,
    activeSlot: patch.activeSlot,
    previousSlot: patch.previousSlot,
    generation: patch.generation,
    reason: patch.reason,
    rollbackUntil: patch.rollbackUntil,
    updatedAt: patch.updatedAt ?? nowIso(),
  };
  atomicWrite(activeSlotAuthorityPath(controllerHome), next);
  return next;
}

export function ensureSlotHome(controllerHome: string, slot: RuntimeSlotId): string {
  const home = ensureControllerHome(slotHomePath(controllerHome, slot));
  mkdirSync(slotLogDir(controllerHome, slot), { recursive: true });
  return home;
}

export function readSlotIdentity(controllerHome: string, slot: RuntimeSlotId): SlotIdentity | null {
  const value = readJson<SlotIdentity>(slotIdentityPath(controllerHome, slot));
  if (!value || value.schemaVersion !== 1) return null;
  if (value.slot !== slot) return null;
  return value;
}

export function writeSlotIdentity(controllerHome: string, identity: SlotIdentity): SlotIdentity {
  ensureSlotHome(controllerHome, identity.slot);
  const resourceCreatedAt = identity.resources?.[0]?.createdAt ?? identity.startedAt ?? nowIso();
  const next: SlotIdentity = {
    ...identity,
    schemaVersion: 1,
    updatedAt: nowIso(),
    resources: identity.resources ?? [managedResource({
      resourceId: `runtime-slot:${resolve(identity.controllerHome)}:${identity.slot}`,
      type: 'runtime_slot',
      owner: { kind: 'runtime_slot', id: `${resolve(identity.controllerHome)}:${identity.slot}` },
      createdAt: resourceCreatedAt,
      state: identity.role === 'failed' ? 'retained' : 'active',
      path: identity.slotHome,
      ...(identity.role === 'failed' ? { retentionReason: 'slot marked failed; cleanup requires explicit authority and rollback checks.' } : {}),
    })],
  };
  atomicWrite(slotIdentityPath(controllerHome, identity.slot), next);
  return next;
}

/**
 * Allocate ports for a slot. Active (or sole) slot keeps base ports.
 * Inactive slot offsets by SLOT_PORT_STRIDE unless overrides are provided.
 */
export function allocateSlotPorts(
  slot: RuntimeSlotId,
  activeSlot: RuntimeSlotId,
  base: SlotPortAllocation = { mcpPort: DEFAULT_MCP_PORT, localControllerPort: DEFAULT_LOCAL_PORT },
  overrides?: Partial<SlotPortAllocation>,
): SlotPortAllocation {
  if (overrides?.mcpPort && overrides?.localControllerPort) {
    return {
      mcpPort: overrides.mcpPort,
      localControllerPort: overrides.localControllerPort,
    };
  }
  const isActive = slot === activeSlot;
  const offset = isActive ? 0 : SLOT_PORT_STRIDE;
  return {
    mcpPort: overrides?.mcpPort ?? base.mcpPort + offset,
    localControllerPort: overrides?.localControllerPort ?? base.localControllerPort + offset,
  };
}

export function resolveSlotControllerHome(
  controllerHome: string,
  slot?: RuntimeSlotId,
): { authority: ActiveSlotAuthority; slot: RuntimeSlotId; slotHome: string } {
  const home = ensureControllerHome(controllerHome);
  const authority = readActiveSlotAuthority(home);
  const resolved = slot ?? authority.activeSlot;
  return {
    authority,
    slot: resolved,
    slotHome: ensureSlotHome(home, resolved),
  };
}

/**
 * Public lifecycle still receives a single controllerHome. When slots are enabled,
 * managed processes run under the active slot home while authority stays at the root.
 */
export function resolveLifecycleControllerHome(
  controllerHome: string,
  options: { slot?: RuntimeSlotId; useSlots?: boolean } = {},
): {
  rootHome: string;
  slot: RuntimeSlotId;
  slotHome: string;
  authority: ActiveSlotAuthority;
} {
  const rootHome = ensureControllerHome(controllerHome);
  if (options.useSlots === false) {
    const authority = readActiveSlotAuthority(rootHome);
    return {
      rootHome,
      slot: options.slot ?? authority.activeSlot,
      slotHome: rootHome,
      authority,
    };
  }
  const resolved = resolveSlotControllerHome(rootHome, options.slot);
  return {
    rootHome,
    slot: resolved.slot,
    slotHome: resolved.slotHome,
    authority: resolved.authority,
  };
}

export function markCutoverAuthority(
  controllerHome: string,
  nextActive: RuntimeSlotId,
  generation: string | undefined,
  rollbackWindowMs = DEFAULT_ROLLBACK_WINDOW_MS,
): ActiveSlotAuthority {
  const current = readActiveSlotAuthority(controllerHome);
  let authority: ActiveSlotAuthority;
  if (current.activeSlot === nextActive) {
    authority = writeActiveSlotAuthority(controllerHome, {
      ...current,
      generation: generation ?? current.generation,
      reason: 'cutover-idempotent',
    });
  } else {
    authority = writeActiveSlotAuthority(controllerHome, {
      activeSlot: nextActive,
      previousSlot: current.activeSlot,
      generation,
      reason: 'cutover',
      rollbackUntil: new Date(Date.now() + Math.max(0, rollbackWindowMs)).toISOString(),
    });
  }
  // Stable Bootstrap writer fencing via activation transaction.
  // Failures must surface — silent ignore would leave split-brain authority.
  const { atomicActivateRuntime } = require('../../runtime/bootstrap/stable-bootstrap') as typeof import('../../runtime/bootstrap/stable-bootstrap');
  const activated = atomicActivateRuntime(controllerHome, {
    activeSlot: authority.activeSlot,
    generation: authority.generation,
    reason: authority.reason,
    previousSlot: authority.previousSlot,
    rollbackUntil: authority.rollbackUntil,
  });
  // Re-read projection written by the transaction (authoritative slot fields).
  return {
    ...authority,
    activeSlot: activated.authority.activeSlot,
    generation: activated.authority.generation ?? authority.generation,
    updatedAt: activated.authority.updatedAt,
  };
}

export function markRollbackAuthority(
  controllerHome: string,
  generation: string | undefined,
): ActiveSlotAuthority {
  const current = readActiveSlotAuthority(controllerHome);
  const previous = current.previousSlot ?? oppositeSlot(current.activeSlot);
  const { atomicActivateRuntime } = require('../../runtime/bootstrap/stable-bootstrap') as typeof import('../../runtime/bootstrap/stable-bootstrap');
  const activated = atomicActivateRuntime(controllerHome, {
    activeSlot: previous,
    previousSlot: current.activeSlot,
    generation,
    reason: 'rollback',
  });
  return {
    schemaVersion: 1,
    activeSlot: activated.authority.activeSlot,
    previousSlot: current.activeSlot,
    generation: activated.authority.generation ?? generation,
    reason: 'rollback',
    rollbackUntil: undefined,
    updatedAt: activated.authority.updatedAt,
  };
}

export function isRollbackWindowOpen(authority: ActiveSlotAuthority, now = Date.now()): boolean {
  if (!authority.rollbackUntil) return Boolean(authority.previousSlot);
  const until = Date.parse(authority.rollbackUntil);
  return Number.isFinite(until) && until >= now;
}

export function slotPortDefaults(): SlotPortAllocation {
  return { mcpPort: DEFAULT_MCP_PORT, localControllerPort: DEFAULT_LOCAL_PORT };
}

export function slotsShareRuntimeState(leftHome: string, rightHome: string): boolean {
  return resolve(leftHome) === resolve(rightHome);
}
