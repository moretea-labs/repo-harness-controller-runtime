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
} from 'fs';
import { dirname, join, resolve } from 'path';
import { ensureRepositoryControllerLayout } from './controller-home';
import type { RepositoryRecord } from './types';

export type RuntimeStorageBindingStatus =
  | 'linked'
  | 'already-linked'
  | 'migrated'
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
  return readdirSync(path);
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

function bindRuntimeDirectory(
  harnessRoot: string,
  controllerRoot: string,
  spec: RuntimeStorageSpec,
): RuntimeStorageBinding {
  const repositoryPath = join(harnessRoot, spec.sourceName);
  const controllerPath = join(controllerRoot, spec.controllerName);
  mkdirSync(controllerPath, { recursive: true });

  if (!existsSync(repositoryPath)) {
    createDirectoryLink(controllerPath, repositoryPath);
    return { name: spec.name, repositoryPath, controllerPath, status: 'linked' };
  }

  const sourceStat = lstatSync(repositoryPath);
  if (sourceStat.isSymbolicLink()) {
    if (sameCanonicalPath(repositoryPath, controllerPath)) {
      return { name: spec.name, repositoryPath, controllerPath, status: 'already-linked' };
    }
    return {
      name: spec.name,
      repositoryPath,
      controllerPath,
      status: 'conflict',
      message: 'repository runtime path is already linked to a different target',
    };
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

  if (spec.preserveNonEmpty) {
    return {
      name: spec.name,
      repositoryPath,
      controllerPath,
      status: 'legacy-active',
      message: 'non-empty worktree storage cannot be moved safely; clean or integrate existing worktrees first',
    };
  }

  if (spec.detectActiveRuns && hasActiveRuns(repositoryPath)) {
    return {
      name: spec.name,
      repositoryPath,
      controllerPath,
      status: 'legacy-active',
      message: 'active or unreadable legacy Runs must finish before runtime storage can be relocated',
    };
  }

  if (spec.detectActiveLocalJobs && hasActiveLocalJobs(repositoryPath)) {
    return {
      name: spec.name,
      repositoryPath,
      controllerPath,
      status: 'legacy-active',
      message: 'active or unreadable Local Jobs must finish before runtime storage can be relocated',
    };
  }

  if (directoryEntries(controllerPath).length > 0) {
    return {
      name: spec.name,
      repositoryPath,
      controllerPath,
      status: 'conflict',
      message: 'both repository-local and Controller Home runtime directories contain data',
    };
  }

  moveDirectory(repositoryPath, controllerPath);
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

  const bindings = RUNTIME_STORAGE_SPECS.map((spec) => bindRuntimeDirectory(harnessRoot, controllerRoot, spec));
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
