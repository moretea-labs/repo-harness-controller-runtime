/**
 * Binary-safe workspace savepoint for Fast Path patch rollback.
 * Captures content, symlink targets, file modes, and presence for create/delete/rename paths.
 * restore failure must surface repositoryChanged + cleanupRequired + reconciliationRequired.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  type Stats,
} from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { randomUUID } from 'crypto';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';

export interface SavepointEntry {
  path: string;
  kind: 'missing' | 'file' | 'symlink' | 'directory';
  mode?: number;
  /** Absolute path to backup blob (file content) or empty for symlink/missing. */
  backupAbsolute?: string;
  symlinkTarget?: string;
}

export interface WorkspaceSavepoint {
  savepointId: string;
  repoRoot: string;
  createdAt: string;
  entries: SavepointEntry[];
  backupDir: string;
}

export interface RestoreResult {
  ok: boolean;
  restoredPaths: string[];
  failedPaths: string[];
  repositoryChanged: boolean;
  cleanupRequired: boolean;
  reconciliationRequired: boolean;
  error?: string;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function normalizeRepoPath(repoRoot: string, rawPath: string): string {
  const root = resolve(repoRoot);
  const absolute = resolve(root, rawPath.replace(/\\/g, '/'));
  const normalized = relative(root, absolute).replace(/\\/g, '/');
  if (!normalized || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`SAVEPOINT_PATH_DENIED: ${rawPath} escapes the repository`);
  }
  return normalized;
}

function pathsIncludingAncestors(repoRoot: string, paths: string[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of paths) {
    const target = normalizeRepoPath(repoRoot, rawPath);
    const ancestors: string[] = [];
    let current = dirname(target).replace(/\\/g, '/');
    while (current && current !== '.') {
      ancestors.push(current);
      const next = dirname(current).replace(/\\/g, '/');
      if (next === current) break;
      current = next;
    }
    for (const path of [...ancestors.reverse(), target]) {
      if (seen.has(path)) continue;
      seen.add(path);
      ordered.push(path);
    }
  }
  return ordered;
}

function captureEntry(repoRoot: string, relativePath: string, backupDir: string): SavepointEntry {
  const absolute = join(repoRoot, relativePath);
  const stat = lstatIfPresent(absolute);
  if (!stat) return { path: relativePath, kind: 'missing' };
  if (stat.isSymbolicLink()) {
    return {
      path: relativePath,
      kind: 'symlink',
      mode: stat.mode,
      symlinkTarget: readlinkSync(absolute),
    };
  }
  if (stat.isDirectory()) {
    return {
      path: relativePath,
      kind: 'directory',
      mode: stat.mode,
    };
  }
  if (!stat.isFile()) {
    throw new Error(`SAVEPOINT_UNSUPPORTED_ENTRY: ${relativePath}`);
  }
  const backupName = `${relativePath.replace(/[\\/]/g, '__')}__${randomUUID().slice(0, 8)}.bin`;
  const backupAbsolute = join(backupDir, backupName);
  ensureDir(dirname(backupAbsolute));
  copyFileSync(absolute, backupAbsolute);
  return {
    path: relativePath,
    kind: 'file',
    mode: stat.mode,
    backupAbsolute,
  };
}

/**
 * Create a workspace savepoint for the given relative paths (and optional rename sources).
 */
export function createWorkspaceSavepoint(input: {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
  paths: string[];
}): WorkspaceSavepoint {
  const savepointId = `sp_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const backupDir = join(
    repositoryControllerRoot(input.controllerHome, input.repoId),
    'workspace-savepoints',
    savepointId,
  );
  ensureDir(backupDir);
  const capturedPaths = pathsIncludingAncestors(input.repoRoot, input.paths);
  const entries = capturedPaths.map((path) => captureEntry(input.repoRoot, path, backupDir));
  const meta: WorkspaceSavepoint = {
    savepointId,
    repoRoot: input.repoRoot,
    createdAt: new Date().toISOString(),
    entries,
    backupDir,
  };
  writeFileSync(join(backupDir, 'manifest.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return meta;
}

function restoreOne(repoRoot: string, entry: SavepointEntry): void {
  const absolute = join(repoRoot, entry.path);
  if (entry.kind === 'missing') {
    const stat = lstatIfPresent(absolute);
    if (stat) {
      if (stat.isDirectory() && !stat.isSymbolicLink()) rmSync(absolute, { recursive: true, force: true });
      else unlinkSync(absolute);
    }
    return;
  }
  if (entry.kind === 'symlink') {
    const stat = lstatIfPresent(absolute);
    if (stat) {
      if (stat.isDirectory() && !stat.isSymbolicLink()) rmSync(absolute, { recursive: true, force: true });
      else unlinkSync(absolute);
    } else {
      ensureDir(dirname(absolute));
    }
    symlinkSync(entry.symlinkTarget ?? '', absolute);
    return;
  }
  if (entry.kind === 'directory') {
    ensureDir(absolute);
    if (entry.mode !== undefined) {
      try {
        chmodSync(absolute, entry.mode);
      } catch {
        /* best effort */
      }
    }
    return;
  }
  // file
  if (!entry.backupAbsolute || !existsSync(entry.backupAbsolute)) {
    throw new Error(`SAVEPOINT_BACKUP_MISSING: ${entry.path}`);
  }
  ensureDir(dirname(absolute));
  const current = lstatIfPresent(absolute);
  if (current) {
    if (current.isDirectory() && !current.isSymbolicLink()) rmSync(absolute, { recursive: true, force: true });
    else unlinkSync(absolute);
  }
  copyFileSync(entry.backupAbsolute, absolute);
  if (entry.mode !== undefined) {
    try {
      chmodSync(absolute, entry.mode);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Restore workspace to savepoint. Never claims success when restore is incomplete.
 */
export function restoreWorkspaceSavepoint(savepoint: WorkspaceSavepoint): RestoreResult {
  const restoredPaths: string[] = [];
  const failedPaths: string[] = [];
  // Restore in reverse order so renames/creates unwind cleanly.
  for (const entry of [...savepoint.entries].reverse()) {
    try {
      restoreOne(savepoint.repoRoot, entry);
      restoredPaths.push(entry.path);
    } catch {
      failedPaths.push(entry.path);
    }
  }
  const ok = failedPaths.length === 0;
  return {
    ok,
    restoredPaths,
    failedPaths,
    repositoryChanged: !ok,
    cleanupRequired: !ok,
    reconciliationRequired: !ok,
    error: ok ? undefined : `failed to restore: ${failedPaths.join(', ')}`,
  };
}

/**
 * Drop savepoint backups after successful commit of mutation (best-effort).
 */
export function discardWorkspaceSavepoint(savepoint: WorkspaceSavepoint): void {
  try {
    if (existsSync(savepoint.backupDir)) {
      rmSync(savepoint.backupDir, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
}

/**
 * Collect actual changed paths after apply (existence / content vs savepoint).
 */
export function diffAgainstSavepoint(
  repoRoot: string,
  savepoint: WorkspaceSavepoint,
  candidatePaths: string[],
): string[] {
  const changed: string[] = [];
  const set = new Set([
    ...savepoint.entries.map((entry) => entry.path),
    ...candidatePaths.map((path) => path.replace(/^\.\//, '')),
  ]);
  for (const path of set) {
    const absolute = join(repoRoot, path);
    const entry = savepoint.entries.find((item) => item.path === path);
    let stat: Stats | undefined;
    try {
      stat = lstatIfPresent(absolute);
    } catch {
      changed.push(path);
      continue;
    }
    if (!entry) {
      if (stat) changed.push(path);
      continue;
    }
    if (entry.kind === 'missing') {
      if (stat) changed.push(path);
      continue;
    }
    if (!stat) {
      changed.push(path);
      continue;
    }
    try {
      if (entry.kind === 'symlink') {
        if (!stat.isSymbolicLink() || readlinkSync(absolute) !== entry.symlinkTarget) {
          changed.push(path);
        }
        continue;
      }
      if (entry.kind === 'directory') {
        if (!stat.isDirectory() || stat.isSymbolicLink()
          || (entry.mode !== undefined && (stat.mode & 0o777) !== (entry.mode & 0o777))) {
          changed.push(path);
        }
        continue;
      }
      if (entry.kind === 'file' && entry.backupAbsolute && existsSync(entry.backupAbsolute)) {
        const before = readFileSync(entry.backupAbsolute);
        const after = readFileSync(absolute);
        if (!before.equals(after) || (entry.mode !== undefined && (stat.mode & 0o777) !== (entry.mode & 0o777))) {
          changed.push(path);
        }
        continue;
      }
    } catch {
      changed.push(path);
    }
  }
  return [...new Set(changed)].sort();
}

/** Verify restore brought workspace fully back (no residual changes vs savepoint). */
export function verifySavepointRestored(
  repoRoot: string,
  savepoint: WorkspaceSavepoint,
): { ok: boolean; residual: string[] } {
  const residual = diffAgainstSavepoint(repoRoot, savepoint, []);
  // residual empty means current matches savepoint capture
  // For missing entries residual means file still exists (not fully removed).
  // For file/symlink residual means content still differs.
  return { ok: residual.length === 0, residual };
}

export function listSavepointBackups(controllerHome: string, repoId: string): string[] {
  const root = join(repositoryControllerRoot(controllerHome, repoId), 'workspace-savepoints');
  if (!existsSync(root)) return [];
  return readdirSync(root);
}
