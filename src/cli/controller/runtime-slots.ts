import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { ensureControllerHome } from '../repositories/controller-home';

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
  startedAt?: string;
  updatedAt: string;
  processGroupLeader?: number;
  logDir: string;
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
  const next: SlotIdentity = {
    ...identity,
    schemaVersion: 1,
    updatedAt: nowIso(),
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
  if (current.activeSlot === nextActive) {
    return writeActiveSlotAuthority(controllerHome, {
      ...current,
      generation: generation ?? current.generation,
      reason: 'cutover-idempotent',
    });
  }
  return writeActiveSlotAuthority(controllerHome, {
    activeSlot: nextActive,
    previousSlot: current.activeSlot,
    generation,
    reason: 'cutover',
    rollbackUntil: new Date(Date.now() + Math.max(0, rollbackWindowMs)).toISOString(),
  });
}

export function markRollbackAuthority(
  controllerHome: string,
  generation: string | undefined,
): ActiveSlotAuthority {
  const current = readActiveSlotAuthority(controllerHome);
  const previous = current.previousSlot ?? oppositeSlot(current.activeSlot);
  return writeActiveSlotAuthority(controllerHome, {
    activeSlot: previous,
    previousSlot: current.activeSlot,
    generation,
    reason: 'rollback',
    rollbackUntil: undefined,
  });
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
