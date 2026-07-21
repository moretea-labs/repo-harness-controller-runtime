/**
 * Stable controller-home layout.
 *
 * Repository durable state lives outside blue/green runtime slots.
 * Slot homes only hold runtime process identity, generation, logs, and PID files.
 *
 * Target:
 *   controller-home/
 *   ├─ bootstrap/
 *   ├─ repositories/<repoId>/
 *   ├─ runtime-slots/blue|green/   (runtime-only)
 *   └─ releases/
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { ensureControllerHome } from '../../repositories/controller-home';

export const STABLE_STATE_MARKER = 'stable-state.json';

export interface StableStateMarker {
  schemaVersion: 1;
  layout: 'stable-v1';
  migratedAt: string;
  sourceLayout?: string;
  repositoryCount: number;
}

export interface StableLayoutPaths {
  controllerHome: string;
  bootstrap: string;
  repositories: string;
  runtimeSlots: string;
  releases: string;
  writerAuthority: string;
  activeSlot: string;
}

/** Repository-scoped durable directories that must not live only inside a slot. */
export const STABLE_REPOSITORY_STATE_DIRS = [
  'runs',
  'jobs',
  'execution-jobs',
  'worktrees',
  'edit-sessions',
  'artifacts',
  'local-jobs',
  'local-bridge',
  'processes',
  'leases',
  'workflows',
  'projections',
  'sessions',
  'approvals',
  'mcp',
  'controller',
  'results',
  'audit',
  'evidence',
  'work-handles',
  'work-contracts',
  'goal-contracts',
  'ephemeral-issues',
  'indexes',
  'locks',
] as const;

/** Slot-only runtime files/directories. */
export const SLOT_RUNTIME_ONLY = [
  'slot.json',
  'logs',
  'pids',
  'generation.json',
  'release-pointer.json',
] as const;

export function stableLayoutPaths(controllerHome: string): StableLayoutPaths {
  const home = ensureControllerHome(controllerHome);
  return {
    controllerHome: home,
    bootstrap: join(home, 'bootstrap'),
    repositories: join(home, 'repositories'),
    runtimeSlots: join(home, 'runtime-slots'),
    releases: join(home, 'releases'),
    writerAuthority: join(home, 'bootstrap', 'writer-authority.json'),
    activeSlot: join(home, 'active-slot.json'),
  };
}

export function ensureStableLayout(controllerHome: string): StableLayoutPaths {
  const paths = stableLayoutPaths(controllerHome);
  for (const dir of [paths.bootstrap, paths.repositories, paths.runtimeSlots, paths.releases, join(paths.runtimeSlots, 'blue'), join(paths.runtimeSlots, 'green')]) {
    mkdirSync(dir, { recursive: true });
  }
  // Slot runtime-only subdirs
  for (const slot of ['blue', 'green'] as const) {
    mkdirSync(join(paths.runtimeSlots, slot, 'logs'), { recursive: true });
    mkdirSync(join(paths.runtimeSlots, slot, 'pids'), { recursive: true });
  }
  return paths;
}

export function readStableStateMarker(controllerHome: string): StableStateMarker | undefined {
  const path = join(ensureControllerHome(controllerHome), STABLE_STATE_MARKER);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as StableStateMarker;
    return value?.schemaVersion === 1 && value.layout === 'stable-v1' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeStableStateMarker(controllerHome: string, marker: StableStateMarker): void {
  const path = join(ensureControllerHome(controllerHome), STABLE_STATE_MARKER);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

/**
 * Discover repository state that still lives under a runtime slot
 * (legacy layout: runtime-slots/<slot>/repositories/<repoId>/...).
 */
export function discoverSlotRepositoryState(controllerHome: string): Array<{
  slot: 'blue' | 'green';
  repoId: string;
  sourcePath: string;
}> {
  const root = join(ensureControllerHome(controllerHome), 'runtime-slots');
  const found: Array<{ slot: 'blue' | 'green'; repoId: string; sourcePath: string }> = [];
  for (const slot of ['blue', 'green'] as const) {
    const reposRoot = join(root, slot, 'repositories');
    if (!existsSync(reposRoot)) continue;
    for (const entry of readdirSync(reposRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      found.push({
        slot,
        repoId: entry.name,
        sourcePath: resolve(reposRoot, entry.name),
      });
    }
  }
  return found;
}

export function discoverRootRepositoryState(controllerHome: string): Array<{
  repoId: string;
  path: string;
}> {
  const reposRoot = join(ensureControllerHome(controllerHome), 'repositories');
  if (!existsSync(reposRoot)) return [];
  return readdirSync(reposRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      repoId: entry.name,
      path: resolve(reposRoot, entry.name),
    }));
}
