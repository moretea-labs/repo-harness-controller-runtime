import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { ensureRepositoryControllerLayout } from './controller-home';
import type { RepositoryRecord } from './types';

export type RuntimeStorageBindingStatus =
  | 'linked'
  | 'already-linked'
  | 'migrated'
  | 'merged'
  | 'quarantined'
  | 'legacy-active'
  | 'conflict';

export interface RuntimeStorageBinding {
  name: string;
  repositoryPath: string;
  controllerPath: string;
  status: RuntimeStorageBindingStatus;
  message?: string;
}

export interface RepositoryRuntimeStorageReport {
  repoId: string;
  controllerRoot: string;
  readyForExecution: boolean;
  bindings: RuntimeStorageBinding[];
  warnings: string[];
}

interface RuntimeStorageSpec {
  name: string;
  sourceName: string;
  controllerName: string;
  preserveNonEmpty?: boolean;
  detectActiveRuns?: boolean;
  detectActiveLocalJobs?: boolean;
}

const ACTIVE_RUN_STATUSES = new Set(['queued', 'starting', 'running', 'waiting_for_user']);
const ACTIVE_LOCAL_JOB_STATUSES = new Set(['pending_approval', 'approved', 'dispatched', 'running']);
const OWNER_MARKER = '.repo-harness-owner.json';

const RUNTIME_STORAGE_SPECS: RuntimeStorageSpec[] = [
  { name: 'runs', sourceName: 'jobs', controllerName: 'runs', detectActiveRuns: true },
  { name: 'worktrees', sourceName: 'worktrees', controllerName: 'worktrees', preserveNonEmpty: true },
  { name: 'edit-sessions', sourceName: 'edit-sessions', controllerName: 'edit-sessions' },
  { name: 'controller-state', sourceName: 'controller', controllerName: 'controller' },
  { name: 'artifacts', sourceName: 'artifacts', controllerName: 'artifacts' },
  { name: 'local-jobs', sourceName: 'local-jobs', controllerName: 'local-jobs', detectActiveLocalJobs: true },
  { name: 'mcp', sourceName: 'mcp', controllerName: 'mcp' },
  { name: 'local-bridge', sourceName: 'local-bridge', controllerName: 'local-bridge' },
  { name: 'ephemeral-issues', sourceName: 'ephemeral-issues', controllerName: 'ephemeral-issues' },
];

function directoryEntries(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path).filter((entry) => entry !== OWNER_MARKER);
}

function writeOwnerMarker(path: string, repoId: string, binding: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, OWNER_MARKER), `${JSON.stringify({
    schemaVersion: 1,
    repoId,
    binding,
    managedBy: 'repo-harness',
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf-8');
}

function quarantinePath(controllerRoot: string, spec: RuntimeStorageSpec, entry: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(controllerRoot, 'quarantine', 'runtime-storage', spec.name, `${stamp}-${entry}`);
}

const QUARANTINE_GENERATED_DIRECTORY_NAMES = new Set(['node_modules']);

function pruneQuarantineGeneratedDirectories(path: string): void {
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryPath = join(path, entry.name);
    if (QUARANTINE_GENERATED_DIRECTORY_NAMES.has(entry.name)) {
      rmSync(entryPath, { recursive: true, force: true });
      continue;
    }
    pruneQuarantineGeneratedDirectories(entryPath);
  }
}

function mergeRuntimeDirectory(
  source: string,
  target: string,
  controllerRoot: string,
  spec: RuntimeStorageSpec,
): { merged: number; quarantined: string[] } {
  let merged = 0;
  const quarantined: string[] = [];
  for (const entry of directoryEntries(source)) {
    const sourceEntry = join(source, entry);
    const targetEntry = join(target, entry);
    if (!existsSync(targetEntry)) {
      renameSync(sourceEntry, targetEntry);
      merged += 1;
      continue;
    }
    const quarantine = quarantinePath(controllerRoot, spec, entry);
    mkdirSync(dirname(quarantine), { recursive: true });
    renameSync(sourceEntry, quarantine);
    if (spec.name === 'worktrees') pruneQuarantineGeneratedDirectories(quarantine);
    quarantined.push(quarantine);
  }
  return { merged, quarantined };
}

function sameCanonicalPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch (_error) {
    return resolve(left) === resolve(right);
  }
}

function createDirectoryLink(target: string, source: string): void {
  mkdirSync(dirname(source), { recursive: true });
  symlinkSync(target, source, process.platform === 'win32' ? 'junction' : 'dir');
}

function hasActiveRuns(path: string): boolean {
  if (!existsSync(path)) return false;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(path, entry.name, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { status?: string };
      if (meta.status && ACTIVE_RUN_STATUSES.has(meta.status)) return true;
    } catch (_error) {
      return true;
    }
  }
  return false;
}

function hasActiveLocalJobs(path: string): boolean {
  if (!existsSync(path)) return false;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jobPath = join(path, entry.name, 'job.json');
    if (!existsSync(jobPath)) return true;
    try {
      const job = JSON.parse(readFileSync(jobPath, 'utf-8')) as { status?: string };
      if (job.status && ACTIVE_LOCAL_JOB_STATUSES.has(job.status)) return true;
    } catch (_error) {
      return true;
    }
  }
  return false;
}

function moveDirectory(source: string, target: string): void {
  rmSync(target, { recursive: true, force: true });
  try {
    renameSync(source, target);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
    if (code !== 'EXDEV') throw error;
    mkdirSync(target, { recursive: true });
    cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
    rmSync(source, { recursive: true, force: true });
  }
}

function gitWorktreeEntries(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(path, entry.name, '.git')))
    .map((entry) => entry.name)
    .sort();
}

function preservedWorktreeStorageBlocker(
  sourcePath: string,
  controllerPath: string,
  spec: RuntimeStorageSpec,
): string | undefined {
  if (!spec.preserveNonEmpty) return undefined;
  const sourceWorktrees = gitWorktreeEntries(sourcePath);
  if (sourceWorktrees.length > 0) {
    return `live Git worktrees must not be relocated automatically: ${sourceWorktrees.join(', ')}`;
  }
  if (directoryEntries(sourcePath).length > 0) {
    const controllerWorktrees = gitWorktreeEntries(controllerPath);
    if (controllerWorktrees.length > 0) {
      return `runtime worktree storage cannot be merged while Controller Home contains live Git worktrees: ${controllerWorktrees.join(', ')}`;
    }
  }
  return undefined;
}

function legacyRuntimeBlocker(repositoryPath: string, spec: RuntimeStorageSpec): string | undefined {
  const sourceEntries = directoryEntries(repositoryPath);
  if (sourceEntries.length === 0) return undefined;

  if (spec.detectActiveRuns && hasActiveRuns(repositoryPath)) {
    return 'active or unreadable legacy Runs must finish before runtime storage can be relocated';
  }

  if (spec.detectActiveLocalJobs && hasActiveLocalJobs(repositoryPath)) {
    return 'active or unreadable Local Jobs must finish before runtime storage can be relocated';
  }

  return undefined;
}

function bindRuntimeDirectory(
  harnessRoot: string,
  controllerRoot: string,
  repoId: string,
  spec: RuntimeStorageSpec,
): RuntimeStorageBinding {
  const repositoryPath = join(harnessRoot, spec.sourceName);
  const controllerPath = join(controllerRoot, spec.controllerName);
  mkdirSync(controllerPath, { recursive: true });
  writeOwnerMarker(controllerPath, repoId, spec.name);

  if (!existsSync(repositoryPath)) {
    createDirectoryLink(controllerPath, repositoryPath);
    return { name: spec.name, repositoryPath, controllerPath, status: 'linked' };
  }

  const sourceStat = lstatSync(repositoryPath);
  if (sourceStat.isSymbolicLink()) {
    if (sameCanonicalPath(repositoryPath, controllerPath)) {
      return { name: spec.name, repositoryPath, controllerPath, status: 'already-linked' };
    }

    let legacyTarget: string;
    try {
      legacyTarget = realpathSync(repositoryPath);
    } catch (_error) {
      return {
        name: spec.name,
        repositoryPath,
        controllerPath,
        status: 'conflict',
        message: 'repository runtime symlink target is missing',
      };
    }

    const blocker = preservedWorktreeStorageBlocker(legacyTarget, controllerPath, spec)
      ?? legacyRuntimeBlocker(repositoryPath, spec);
    if (blocker) {
      return {
        name: spec.name,
        repositoryPath,
        controllerPath,
        status: 'legacy-active',
        message: blocker,
      };
    }

    if (directoryEntries(repositoryPath).length > 0) {
      const targetHasData = directoryEntries(controllerPath).length > 0;
      if (targetHasData) {
        const outcome = mergeRuntimeDirectory(legacyTarget, controllerPath, controllerRoot, spec);
        rmSync(repositoryPath, { recursive: true, force: true });
        createDirectoryLink(controllerPath, repositoryPath);
        return {
          name: spec.name, repositoryPath, controllerPath,
          status: outcome.quarantined.length > 0 ? 'quarantined' : 'merged',
          message: outcome.quarantined.length > 0
            ? `merged ${outcome.merged} entry(s); quarantined ${outcome.quarantined.length} conflicting entry(s)`
            : `merged ${outcome.merged} legacy entry(s)`,
        };
      }
      moveDirectory(legacyTarget, controllerPath);
      writeOwnerMarker(controllerPath, repoId, spec.name);
      rmSync(repositoryPath, { recursive: true, force: true });
      createDirectoryLink(controllerPath, repositoryPath);
      return { name: spec.name, repositoryPath, controllerPath, status: 'migrated' };
    }

    rmSync(repositoryPath, { recursive: true, force: true });
    createDirectoryLink(controllerPath, repositoryPath);
    return { name: spec.name, repositoryPath, controllerPath, status: 'linked' };
  }

  if (!sourceStat.isDirectory()) {
    return {
      name: spec.name,
      repositoryPath,
      controllerPath,
      status: 'conflict',
      message: 'repository runtime path exists but is not a directory',
    };
  }

  const sourceEntries = directoryEntries(repositoryPath);
  if (sourceEntries.length === 0) {
    rmSync(repositoryPath, { recursive: true, force: true });
    createDirectoryLink(controllerPath, repositoryPath);
    return { name: spec.name, repositoryPath, controllerPath, status: 'linked' };
  }

  const blocker = preservedWorktreeStorageBlocker(repositoryPath, controllerPath, spec)
    ?? legacyRuntimeBlocker(repositoryPath, spec);
  if (blocker) {
    return {
      name: spec.name,
      repositoryPath,
      controllerPath,
      status: 'legacy-active',
      message: blocker,
    };
  }

  if (directoryEntries(controllerPath).length > 0) {
    const outcome = mergeRuntimeDirectory(repositoryPath, controllerPath, controllerRoot, spec);
    rmSync(repositoryPath, { recursive: true, force: true });
    createDirectoryLink(controllerPath, repositoryPath);
    return {
      name: spec.name, repositoryPath, controllerPath,
      status: outcome.quarantined.length > 0 ? 'quarantined' : 'merged',
      message: outcome.quarantined.length > 0
        ? `merged ${outcome.merged} entry(s); quarantined ${outcome.quarantined.length} conflicting entry(s)`
        : `merged ${outcome.merged} legacy entry(s)`,
    };
  }

  moveDirectory(repositoryPath, controllerPath);
  writeOwnerMarker(controllerPath, repoId, spec.name);
  createDirectoryLink(controllerPath, repositoryPath);
  return { name: spec.name, repositoryPath, controllerPath, status: 'migrated' };
}

export function ensureRepositoryRuntimeStorage(
  repository: RepositoryRecord,
  controllerHome?: string,
): RepositoryRuntimeStorageReport {
  const controllerRoot = ensureRepositoryControllerLayout(controllerHome ?? '', repository.repoId);
  const harnessRoot = join(repository.canonicalRoot, '.ai', 'harness');
  mkdirSync(harnessRoot, { recursive: true });

  const bindings = RUNTIME_STORAGE_SPECS.map((spec) => bindRuntimeDirectory(harnessRoot, controllerRoot, repository.repoId, spec));
  const warnings = bindings
    .filter((binding) => binding.status === 'legacy-active' || binding.status === 'conflict')
    .map((binding) => `${binding.name}: ${binding.message ?? binding.status}`);

  return {
    repoId: repository.repoId,
    controllerRoot,
    readyForExecution: warnings.length === 0,
    bindings,
    warnings,
  };
}
