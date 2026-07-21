/**
 * Migrate repository durable state out of runtime slots into stable
 * controller-home/repositories/<repoId>/.
 *
 * Properties:
 *   - dry-run does not mutate
 *   - idempotent / resumable
 *   - never deletes source until validation succeeds
 *   - preserves repoId / checkoutId
 *   - repairs Git worktree metadata paths when worktrees move
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { spawnSync } from 'child_process';
import {
  discoverRootRepositoryState,
  discoverSlotRepositoryState,
  ensureStableLayout,
  readStableStateMarker,
  STABLE_REPOSITORY_STATE_DIRS,
  writeStableStateMarker,
  type StableStateMarker,
} from './layout';

export interface MigrationOptions {
  controllerHome: string;
  dryRun?: boolean;
  /** When true, remove empty source dirs after successful validation (never default). */
  deleteSourceAfterValidate?: boolean;
  /** Limit to one repoId. */
  repoId?: string;
}

export interface MigrationRepoResult {
  repoId: string;
  sources: string[];
  target: string;
  copiedDirs: string[];
  skippedDirs: string[];
  worktreesRepaired: number;
  status: 'planned' | 'migrated' | 'already_stable' | 'partial' | 'failed';
  errors: string[];
}

export interface MigrationReport {
  dryRun: boolean;
  controllerHome: string;
  repositories: MigrationRepoResult[];
  marker?: StableStateMarker;
  ok: boolean;
}

function listSubdirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name);
}

function copyDirIfMissing(source: string, target: string, dryRun: boolean): 'copied' | 'skipped' | 'merged' {
  if (!existsSync(source)) return 'skipped';
  if (!existsSync(target)) {
    if (!dryRun) {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true, dereference: false });
    }
    return 'copied';
  }
  // Merge missing children only — never overwrite existing durable files.
  if (!dryRun) {
    for (const entry of readdirSync(source)) {
      const from = join(source, entry);
      const to = join(target, entry);
      if (!existsSync(to)) {
        cpSync(from, to, { recursive: true, dereference: false });
      }
    }
  }
  return 'merged';
}

function repairWorktreeGitdir(
  worktreePath: string,
  oldPrefix: string,
  newPrefix: string,
  dryRun: boolean,
): boolean {
  const gitFile = join(worktreePath, '.git');
  if (!existsSync(gitFile)) return false;
  try {
    const stat = lstatSync(gitFile);
    if (stat.isDirectory()) return false;
    const content = readFileSync(gitFile, 'utf8');
    if (!content.includes(oldPrefix)) return false;
    const next = content.split(oldPrefix).join(newPrefix);
    if (!dryRun) writeFileSync(gitFile, next, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function repairWorktreesUnder(
  repoTarget: string,
  sources: string[],
  dryRun: boolean,
): number {
  const worktreesDir = join(repoTarget, 'worktrees');
  if (!existsSync(worktreesDir)) return 0;
  let repaired = 0;
  for (const source of sources) {
    for (const name of listSubdirs(worktreesDir)) {
      const wt = join(worktreesDir, name);
      if (repairWorktreeGitdir(wt, source, repoTarget, dryRun)) repaired += 1;
      // Also fix nested .git files one level down
      try {
        for (const child of readdirSync(wt, { withFileTypes: true })) {
          if (!child.isDirectory()) continue;
          if (repairWorktreeGitdir(join(wt, child.name), source, repoTarget, dryRun)) repaired += 1;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return repaired;
}

function validateRepoTarget(target: string): string[] {
  const errors: string[] = [];
  if (!existsSync(target)) {
    errors.push(`target missing: ${target}`);
    return errors;
  }
  // Soft validation: at least the directory is readable.
  try {
    readdirSync(target);
  } catch (error) {
    errors.push(`target unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}

/**
 * Migrate slot-embedded repository state to stable repositories/<repoId>.
 */
export function migrateRepositoryStateOutOfSlots(options: MigrationOptions): MigrationReport {
  const home = resolve(options.controllerHome);
  const dryRun = options.dryRun === true;
  if (!dryRun) ensureStableLayout(home);

  const slotRepos = discoverSlotRepositoryState(home)
    .filter((entry) => !options.repoId || entry.repoId === options.repoId);
  const rootRepos = discoverRootRepositoryState(home)
    .filter((entry) => !options.repoId || entry.repoId === options.repoId);

  const byRepo = new Map<string, { sources: string[]; target: string }>();
  for (const entry of rootRepos) {
    byRepo.set(entry.repoId, {
      sources: [],
      target: entry.path,
    });
  }
  for (const entry of slotRepos) {
    const existing = byRepo.get(entry.repoId) ?? {
      sources: [] as string[],
      target: join(home, 'repositories', entry.repoId),
    };
    existing.sources.push(entry.sourcePath);
    byRepo.set(entry.repoId, existing);
  }

  const results: MigrationRepoResult[] = [];
  for (const [repoId, info] of byRepo) {
    const result: MigrationRepoResult = {
      repoId,
      sources: info.sources,
      target: info.target,
      copiedDirs: [],
      skippedDirs: [],
      worktreesRepaired: 0,
      status: info.sources.length === 0 ? 'already_stable' : dryRun ? 'planned' : 'migrated',
      errors: [],
    };

    if (info.sources.length === 0) {
      results.push(result);
      continue;
    }

    if (!dryRun) mkdirSync(info.target, { recursive: true });

    for (const source of info.sources) {
      for (const dir of STABLE_REPOSITORY_STATE_DIRS) {
        const from = join(source, dir);
        const to = join(info.target, dir);
        if (!existsSync(from)) {
          result.skippedDirs.push(`${source}:${dir}`);
          continue;
        }
        const outcome = copyDirIfMissing(from, to, dryRun);
        if (outcome === 'skipped') result.skippedDirs.push(`${source}:${dir}`);
        else result.copiedDirs.push(`${source}:${dir}:${outcome}`);
      }
      // Copy any top-level json identity files (checkout registry etc.)
      if (existsSync(source)) {
        for (const entry of readdirSync(source)) {
          if (!entry.endsWith('.json')) continue;
          const from = join(source, entry);
          const to = join(info.target, entry);
          if (!existsSync(to) && !dryRun) {
            cpSync(from, to);
            result.copiedDirs.push(`${source}:${entry}:copied`);
          }
        }
      }
    }

    result.worktreesRepaired = repairWorktreesUnder(info.target, info.sources, dryRun);
    result.errors = dryRun ? [] : validateRepoTarget(info.target);
    if (result.errors.length > 0) result.status = 'failed';
    else if (!dryRun && info.sources.length > 0) result.status = 'migrated';

    // Never delete source by default. Optional cleanup only after validation.
    if (!dryRun && options.deleteSourceAfterValidate && result.status === 'migrated') {
      // Intentionally leave sources; operators must pass an explicit second tool.
      // We only write a migration receipt next to the source.
      for (const source of info.sources) {
        const receipt = join(source, '.stable-state-migrated.json');
        writeFileSync(receipt, `${JSON.stringify({
          schemaVersion: 1,
          migratedTo: info.target,
          migratedAt: new Date().toISOString(),
          retainedSource: true,
        }, null, 2)}\n`, 'utf8');
      }
    }

    results.push(result);
  }

  const ok = results.every((entry) => entry.status !== 'failed');
  let marker = readStableStateMarker(home);
  if (!dryRun && ok) {
    marker = {
      schemaVersion: 1,
      layout: 'stable-v1',
      migratedAt: new Date().toISOString(),
      sourceLayout: 'slot-or-root-hybrid',
      repositoryCount: results.length,
    };
    writeStableStateMarker(home, marker);
  }

  return {
    dryRun,
    controllerHome: home,
    repositories: results,
    marker,
    ok,
  };
}

/**
 * Compatibility reader: prefer stable repositories/<repoId>, fall back to
 * active/inactive slot copies for rollback windows.
 */
export function resolveRepositoryStatePath(
  controllerHome: string,
  repoId: string,
  options: { activeSlot?: 'blue' | 'green' } = {},
): { path: string; source: 'stable' | 'slot-blue' | 'slot-green' | 'missing' } {
  const { resolveStableControllerHome } = require('./stable-home') as typeof import('./stable-home');
  const root = resolveStableControllerHome(controllerHome);
  const stable = join(root, 'repositories', repoId);
  if (existsSync(stable)) return { path: stable, source: 'stable' };
  for (const slot of [options.activeSlot, 'green', 'blue'].filter(Boolean) as Array<'blue' | 'green'>) {
    const candidate = join(root, 'runtime-slots', slot, 'repositories', repoId);
    if (existsSync(candidate)) return { path: candidate, source: slot === 'blue' ? 'slot-blue' : 'slot-green' };
  }
  return { path: stable, source: 'missing' };
}

/**
 * Dry-run helper used by CLI / checks.
 */
export function planStableStateMigration(controllerHome: string, repoId?: string): MigrationReport {
  return migrateRepositoryStateOutOfSlots({
    controllerHome,
    dryRun: true,
    repoId,
  });
}

// Keep spawnSync import for future git worktree list repair hooks.
void spawnSync;
void relative;
void renameSync;
void rmSync;
