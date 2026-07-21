/**
 * Stable Bootstrap — version-independent control plane.
 *
 * Responsibilities:
 *   - stable ingress ownership metadata
 *   - Unix control socket path resolution (socket activation friendly)
 *   - rescue / status endpoint metadata
 *   - active runtime pointer + writer authority epoch
 *   - versioned runtime start/stop coordination hooks
 *
 * Ordinary application releases replace versioned Gateway/Daemon only.
 * Bootstrap itself upgrades through a separate process.
 *
 * Platform socket activation:
 *   macOS: launchd socket activation (SOCKET keys in plist)
 *   Linux: systemd socket activation (LISTEN_FDS)
 *
 * Versioned runtimes must NOT bind fixed public port 8770; they receive
 * ephemeral local ports and are fronted by stable ingress.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isProcessAlive } from '../shared/process-tree';
import { defaultProcessIdentityProbe, processIdentityMatches, type ProcessIdentityProbe } from '../supervisor/identity';
import type { ProcessIdentity } from '../supervisor/types';
import {
  publishWriterAuthority,
  readWriterAuthority,
  type WriterAuthority,
} from '../../cli/controller/stable-state/writer-authority';
import { ensureStableLayout, type StableLayoutPaths } from '../../cli/controller/stable-state/layout';
import type { RuntimeSlotId } from '../../cli/controller/runtime-slots';

export interface BootstrapIdentity {
  schemaVersion: 1;
  pid: number;
  instanceId: string;
  processStartTime: string;
  executableFingerprint: string;
  controllerHome: string;
  startedAt: string;
  /** Public stable ingress port (e.g. 8765) — owned by bootstrap/ingress, not versioned runtime. */
  stableIngressPort?: number;
  /** Control socket path (Unix domain). */
  controlSocketPath: string;
  /** Rescue HTTP bind (loopback only). */
  rescueBind?: string;
}

export interface ActiveRuntimePointer {
  schemaVersion: 1;
  activeSlot: RuntimeSlotId;
  generation?: string;
  releaseRevision?: string;
  releasePath?: string;
  writerEpoch?: string;
  fencingToken?: string;
  /** Versioned runtime local ports — NOT the stable public ingress port. */
  daemonPort?: number;
  gatewayPort?: number;
  updatedAt: string;
}

export interface ControlSocketOwner {
  schemaVersion: 1;
  path: string;
  pid: number;
  processStartTime: string;
  executableFingerprint: string;
  instanceId: string;
  updatedAt: string;
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function bootstrapRoot(controllerHome: string): string {
  return join(ensureStableLayout(controllerHome).bootstrap);
}

export function controlSocketPath(controllerHome: string): string {
  return join(bootstrapRoot(controllerHome), 'control.sock');
}

export function controlSocketOwnerPath(controllerHome: string): string {
  return join(bootstrapRoot(controllerHome), 'control-socket-owner.json');
}

export function activeRuntimePointerPath(controllerHome: string): string {
  return join(bootstrapRoot(controllerHome), 'active-runtime.json');
}

export function bootstrapIdentityPath(controllerHome: string): string {
  return join(bootstrapRoot(controllerHome), 'bootstrap-identity.json');
}

export function readActiveRuntimePointer(controllerHome: string): ActiveRuntimePointer | undefined {
  const value = readJson<ActiveRuntimePointer>(activeRuntimePointerPath(controllerHome));
  if (!value || value.schemaVersion !== 1) return undefined;
  if (value.activeSlot !== 'blue' && value.activeSlot !== 'green') return undefined;
  return value;
}

export function writeActiveRuntimePointer(
  controllerHome: string,
  pointer: Omit<ActiveRuntimePointer, 'schemaVersion' | 'updatedAt'> & { updatedAt?: string },
): ActiveRuntimePointer {
  const next: ActiveRuntimePointer = {
    schemaVersion: 1,
    activeSlot: pointer.activeSlot,
    generation: pointer.generation,
    releaseRevision: pointer.releaseRevision,
    releasePath: pointer.releasePath,
    writerEpoch: pointer.writerEpoch,
    fencingToken: pointer.fencingToken,
    daemonPort: pointer.daemonPort,
    gatewayPort: pointer.gatewayPort,
    updatedAt: pointer.updatedAt ?? new Date().toISOString(),
  };
  atomicWrite(activeRuntimePointerPath(controllerHome), next);
  return next;
}

/**
 * Atomically switch active runtime pointer + writer authority.
 * Old runtime loses write permission even if still alive.
 */
export function atomicActivateRuntime(
  controllerHome: string,
  input: {
    activeSlot: RuntimeSlotId;
    generation?: string;
    releaseRevision?: string;
    releasePath?: string;
    daemonPort?: number;
    gatewayPort?: number;
    reason?: string;
    previousEpoch?: string;
  },
): { pointer: ActiveRuntimePointer; authority: WriterAuthority } {
  const authority = publishWriterAuthority(controllerHome, {
    activeSlot: input.activeSlot,
    generation: input.generation,
    releaseRevision: input.releaseRevision,
    releasePath: input.releasePath,
    reason: input.reason ?? 'atomic-activate',
    previousEpoch: input.previousEpoch,
  });
  const pointer = writeActiveRuntimePointer(controllerHome, {
    activeSlot: input.activeSlot,
    generation: input.generation,
    releaseRevision: input.releaseRevision,
    releasePath: input.releasePath,
    writerEpoch: authority.epoch,
    fencingToken: authority.fencingToken,
    daemonPort: input.daemonPort,
    gatewayPort: input.gatewayPort,
  });
  return { pointer, authority };
}

/**
 * Safe control socket cleanup: only remove a stale socket when the recorded
 * owner is dead or identity no longer matches. Never delete solely because
 * a file exists at the path.
 */
export function ensureControlSocketReady(
  controllerHome: string,
  self: ProcessIdentity,
  probe: ProcessIdentityProbe = defaultProcessIdentityProbe,
): { path: string; removedStale: boolean; reason?: string } {
  const path = controlSocketPath(controllerHome);
  const ownerPath = controlSocketOwnerPath(controllerHome);
  mkdirSync(dirname(path), { recursive: true });

  if (!existsSync(path)) {
    atomicWrite(ownerPath, {
      schemaVersion: 1,
      path,
      pid: self.pid,
      processStartTime: self.processStartTime,
      executableFingerprint: self.executableFingerprint,
      instanceId: self.instanceId,
      updatedAt: new Date().toISOString(),
    } satisfies ControlSocketOwner);
    return { path, removedStale: false };
  }

  // Socket exists — check owner.
  const owner = readJson<ControlSocketOwner>(ownerPath);
  if (owner && owner.schemaVersion === 1) {
    const match = processIdentityMatches(
      {
        pid: owner.pid,
        processStartTime: owner.processStartTime,
        executableFingerprint: owner.executableFingerprint,
        instanceId: owner.instanceId,
        controllerHome,
        ownerEpoch: 0,
      },
      owner.pid,
      probe,
    );
    if (match.matches) {
      // Live owner — do not steal.
      if (owner.pid === self.pid && owner.instanceId === self.instanceId) {
        return { path, removedStale: false, reason: 'already_owner' };
      }
      throw new Error(`CONTROL_SOCKET_OWNED: pid=${owner.pid} instance=${owner.instanceId}`);
    }
  } else if (isProcessAlive(self.pid) === false) {
    // unreachable
  }

  // Stale socket: owner dead or missing identity — safe to remove.
  try {
    const stat = statSync(path);
    // Only unlink socket-like files; refuse to remove regular unexpected files blindly.
    if (stat.isSocket() || stat.isFIFO() || !stat.isDirectory()) {
      unlinkSync(path);
    }
  } catch (error) {
    throw new Error(`CONTROL_SOCKET_CLEANUP_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  atomicWrite(ownerPath, {
    schemaVersion: 1,
    path,
    pid: self.pid,
    processStartTime: self.processStartTime,
    executableFingerprint: self.executableFingerprint,
    instanceId: self.instanceId,
    updatedAt: new Date().toISOString(),
  } satisfies ControlSocketOwner);
  return { path, removedStale: true, reason: 'stale_owner_removed' };
}

/**
 * Versioned Gateway/Daemon must bind ephemeral/local ports, never compete for
 * the stable public ingress port (historically 8770 / 8765).
 */
export const STABLE_PUBLIC_PORTS = new Set([8765, 8770]);

export function assertVersionedRuntimePort(port: number, label: string): void {
  if (STABLE_PUBLIC_PORTS.has(port)) {
    throw new Error(
      `VERSIONED_RUNTIME_MUST_NOT_BIND_STABLE_PORT: ${label} attempted to bind ${port}; use ephemeral local ports behind stable ingress`,
    );
  }
}

export function detectSocketActivation(): {
  activated: boolean;
  platform: 'launchd' | 'systemd' | 'none';
  listenFds?: number;
} {
  // systemd: LISTEN_FDS / LISTEN_PID
  const listenFds = process.env.LISTEN_FDS ? Number.parseInt(process.env.LISTEN_FDS, 10) : 0;
  if (listenFds > 0 && process.env.LISTEN_PID === String(process.pid)) {
    return { activated: true, platform: 'systemd', listenFds };
  }
  // launchd: LAUNCH_JOB_NAME or XPC (heuristic)
  if (process.env.LAUNCH_JOB_NAME || process.env.XPC_SERVICE_NAME) {
    return { activated: true, platform: 'launchd' };
  }
  return { activated: false, platform: 'none' };
}

export function readBootstrapIdentity(controllerHome: string): BootstrapIdentity | undefined {
  return readJson<BootstrapIdentity>(bootstrapIdentityPath(controllerHome));
}

export function writeBootstrapIdentity(controllerHome: string, identity: BootstrapIdentity): void {
  atomicWrite(bootstrapIdentityPath(controllerHome), identity);
}

export function bootstrapStatus(controllerHome: string): {
  layout: StableLayoutPaths;
  pointer?: ActiveRuntimePointer;
  authority?: WriterAuthority;
  controlSocketPath: string;
  controlSocketExists: boolean;
  socketActivation: ReturnType<typeof detectSocketActivation>;
} {
  const layout = ensureStableLayout(controllerHome);
  return {
    layout,
    pointer: readActiveRuntimePointer(controllerHome),
    authority: readWriterAuthority(controllerHome),
    controlSocketPath: controlSocketPath(controllerHome),
    controlSocketExists: existsSync(controlSocketPath(controllerHome)),
    socketActivation: detectSocketActivation(),
  };
}
