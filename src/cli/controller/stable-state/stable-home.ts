/**
 * Dual-home resolution:
 *   rootControllerHome  — durable repository state, authority, bootstrap
 *   slotRuntimeHome     — PID, logs, generation, release identity only
 *
 * When a process is given a slot home (.../runtime-slots/green), durable
 * repository reads/writes must still target the stable root.
 */

import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { ensureControllerHome, resolveControllerHome } from '../../repositories/controller-home';

const SLOT_HOME_RE = /^(.*)\/runtime-slots\/(blue|green)$/;

export interface DualHomePaths {
  /** Absolute root controller home (stable state authority). */
  rootControllerHome: string;
  /** Slot runtime home when input was a slot path; otherwise same as root. */
  slotRuntimeHome: string;
  /** blue | green when input is/under a slot home. */
  slot?: 'blue' | 'green';
  /** True when durable repository state must use root, not slot. */
  usesStableRoot: boolean;
}

/**
 * Resolve the stable root controller home from either a root or a slot path.
 */
export function resolveStableControllerHome(controllerHome: string): string {
  const normalized = resolve(controllerHome).replace(/\\/g, '/');
  const match = SLOT_HOME_RE.exec(normalized);
  if (match?.[1]) return resolve(match[1]);
  // Also handle nested paths under a slot home (e.g. .../runtime-slots/green/mcp)
  const nested = normalized.match(/^(.*)\/runtime-slots\/(blue|green)(?:\/|$)/);
  if (nested?.[1]) return resolve(nested[1]);
  return resolveControllerHome(controllerHome);
}

export function resolveDualHome(controllerHome: string): DualHomePaths {
  const resolved = resolve(controllerHome);
  const normalized = resolved.replace(/\\/g, '/');
  const match = SLOT_HOME_RE.exec(normalized);
  if (match?.[1] && (match[2] === 'blue' || match[2] === 'green')) {
    const root = resolve(match[1]);
    return {
      rootControllerHome: root,
      slotRuntimeHome: resolved,
      slot: match[2],
      usesStableRoot: true,
    };
  }
  const nested = normalized.match(/^(.*)\/runtime-slots\/(blue|green)(?:\/|$)/);
  if (nested?.[1] && (nested[2] === 'blue' || nested[2] === 'green')) {
    const root = resolve(nested[1]);
    const slotHome = join(root, 'runtime-slots', nested[2]);
    return {
      rootControllerHome: root,
      slotRuntimeHome: slotHome,
      slot: nested[2] as 'blue' | 'green',
      usesStableRoot: true,
    };
  }
  const root = resolveControllerHome(controllerHome);
  return {
    rootControllerHome: root,
    slotRuntimeHome: root,
    usesStableRoot: existsSync(join(root, 'stable-state.json'))
      || existsSync(join(root, 'repositories')),
  };
}

/**
 * Durable repository state path parent: always stable root repositories/.
 * Accepts either root or slot controllerHome.
 */
export function durableControllerHome(controllerHome: string): string {
  return resolveStableControllerHome(controllerHome);
}

/**
 * Ensure stable root layout exists and return its path.
 */
export function ensureDurableControllerHome(controllerHome: string): string {
  return ensureControllerHome(resolveStableControllerHome(controllerHome));
}

export function isSlotRuntimeHome(controllerHome: string): boolean {
  return SLOT_HOME_RE.test(resolve(controllerHome).replace(/\\/g, '/'));
}

/**
 * Parent of a path for journal/tmp files.
 */
export function parentDir(path: string): string {
  return dirname(path);
}
