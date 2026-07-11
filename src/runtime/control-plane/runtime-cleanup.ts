import { execFileSync } from 'child_process';
import {
  existsSync,
  lstatSync,
  opendirSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Dirent,
} from 'fs';
import { join, relative, resolve } from 'path';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { appendJsonLine, readJsonFile, writeJsonAtomic } from '../shared/json-files';

function numericSetting(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
}

const ORPHAN_WORKTREE_TTL_MS = numericSetting(
  process.env.REPO_HARNESS_ORPHAN_WORKTREE_TTL_MS,
  6 * 60 * 60_000,
  60_000,
);
const TEMP_STATE_TTL_MS = numericSetting(
  process.env.REPO_HARNESS_TEMP_STATE_TTL_MS,
  15 * 60_000,
  60_000,
);
const DEFAULT_SCAN_BUDGET = numericSetting(
  process.env.REPO_HARNESS_RUNTIME_CLEANUP_SCAN_BUDGET,
  2_000,
  1,
);
const TEMP_SCAN_MAX_DEPTH = numericSetting(
  process.env.REPO_HARNESS_RUNTIME_CLEANUP_MAX_DEPTH,
  10,
  1,
);

/** Terminal / abandoned runs that no longer need their worktree for integration/review. */
const WORKTREE_RELEASE_STATUSES = new Set([
  'failed',
  'cancelled',
  'timed_out',
  'orphaned',
  'stale',
  'unknown',
]);

/**
 * High-cardinality permanent state directories. Cleanup only scans them one
 * level deep for stale `*.tmp` siblings and does not recurse further.
 */
const TEMP_SCAN_LEAF_DIR_NAMES = new Set([
  'records',
  'receipts',
  'events',
  'evidence',
  'edit-sessions',
  'indexes',
  'audit',
  'local-jobs',
  'runs',
  'campaigns',
  'schedules',
  'leases',
  'projections',
]);

const TEMP_SCAN_SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'worktrees',
]);

interface DaemonStateSnapshot {
  schemaVersion?: number;
  status?: string;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  error?: string;
  gatewaySeparated?: boolean;
  workerIsolation?: boolean;
}

interface AgentRunSnapshot {
  executionMode?: unknown;
  worktree?: unknown;
  worktreePath?: unknown;
  worktreeCleanedAt?: unknown;
  status?: unknown;
  workerPid?: unknown;
  agentPid?: unknown;
  launchPid?: unknown;
  lastHeartbeatAt?: unknown;
  integratedSessionId?: unknown;
  integratedAt?: unknown;
}

export interface RuntimeProcessSnapshot {
  alive: boolean;
  commandLine?: string;
}

export interface RuntimeCleanupOptions {
  reason?: RuntimeCleanupReport['reason'];
  nowMs?: number;
  protectedControllerPid?: number;
  maxEntries?: number;
  inspectProcess?: (pid: number) => RuntimeProcessSnapshot;
}

export interface RuntimeCleanupReport {
  at: string;
  reason: 'startup' | 'periodic' | 'manual';
  removedPidFiles: string[];
  skippedPidFiles: string[];
  removedWorktrees: string[];
  removedTemporaryPaths: string[];
  skippedActiveWorktrees: string[];
  inspectedPaths: number;
  budgetExhausted: boolean;
  errors: string[];
  logPath: string;
}

interface ScanBudget {
  remaining: number;
  inspected: number;
  exhausted: boolean;
}

interface WorktreeReferences {
  referenced: Set<string>;
  unsafeRepositories: Set<string>;
  complete: boolean;
}

export function runtimeCleanupLogPath(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'audit', 'runtime-cleanup.jsonl');
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function relativeHomePath(controllerHome: string, path: string): string {
  return relative(controllerHome, path).replace(/\\/g, '/');
}

function errorText(scope: string, error: unknown): string {
  return `${scope}: ${error instanceof Error ? error.message : String(error)}`;
}

function inspectProcessDefault(pid: number): RuntimeProcessSnapshot {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false };
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return { alive: false };
  }
  if (process.platform === 'win32') return { alive: true };
  try {
    const commandLine = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 64 * 1024,
    }).trim();
    return { alive: true, commandLine: commandLine || undefined };
  } catch {
    return { alive: true };
  }
}

function expectedDaemonCommand(controllerHome: string, commandLine: string | undefined): boolean {
  if (!commandLine) return false;
  const home = canonicalPath(controllerHome);
  const referencesHome = commandLine.includes(controllerHome) || commandLine.includes(home);
  return referencesHome && /(?:^|[\\/])daemon-entry\.(?:ts|js)(?:\s|$)/.test(commandLine);
}

function updateDaemonStateForStalePid(controllerHome: string, stalePid: number | undefined, nowIso: string): void {
  const statePath = join(controllerHome, 'daemon', 'state.json');
  if (!existsSync(statePath)) return;
  try {
    const current = readJsonFile<DaemonStateSnapshot>(statePath);
    if (!['ready', 'starting'].includes(String(current.status ?? ''))) return;
    if (!stalePid && current.pid) return;
    if (stalePid && current.pid && current.pid !== stalePid) return;
    writeJsonAtomic(statePath, {
      ...current,
      schemaVersion: typeof current.schemaVersion === 'number' ? current.schemaVersion : 1,
      status: 'stopped',
      stoppedAt: nowIso,
    } satisfies DaemonStateSnapshot);
  } catch {
    // A malformed daemon state must not make cleanup destructive.
  }
}

function cleanupDaemonPidFile(
  controllerHome: string,
  nowIso: string,
  options: RuntimeCleanupOptions,
  errors: string[],
): { removed: string[]; skipped: string[] } {
  const pidPath = join(controllerHome, 'daemon', 'controller.pid');
  if (!existsSync(pidPath)) return { removed: [], skipped: [] };
  let parsedPid: number | undefined;
  try {
    const candidate = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    parsedPid = Number.isInteger(candidate) && candidate > 0 ? candidate : undefined;
  } catch (error) {
    errors.push(errorText('daemon/controller.pid read failed', error));
  }

  if (parsedPid) {
    const snapshot = (options.inspectProcess ?? inspectProcessDefault)(parsedPid);
    if (snapshot.alive) {
      if (parsedPid === options.protectedControllerPid || expectedDaemonCommand(controllerHome, snapshot.commandLine)) {
        return { removed: [], skipped: [relativeHomePath(controllerHome, pidPath)] };
      }
      if (!snapshot.commandLine) {
        errors.push(`daemon/controller.pid: live PID ${parsedPid} command identity is unavailable`);
        return { removed: [], skipped: [relativeHomePath(controllerHome, pidPath)] };
      }
      // PID reuse or an unrelated live process: remove only the stale reference.
      // Never signal a process whose daemon identity is not proven.
    }
  }

  try {
    rmSync(pidPath, { force: true });
    updateDaemonStateForStalePid(controllerHome, parsedPid, nowIso);
    return { removed: [relativeHomePath(controllerHome, pidPath)], skipped: [] };
  } catch (error) {
    errors.push(errorText('daemon/controller.pid removal failed', error));
    return { removed: [], skipped: [] };
  }
}

function visitDirectoryEntries(
  directory: string,
  budget: ScanBudget,
  errors: string[],
  visitor: (entry: Dirent) => void,
): void {
  if (budget.exhausted || !existsSync(directory)) return;
  let handle: ReturnType<typeof opendirSync> | undefined;
  try {
    handle = opendirSync(directory);
    while (true) {
      if (budget.remaining <= 0) {
        budget.exhausted = true;
        break;
      }
      const entry = handle.readSync();
      if (!entry) break;
      budget.remaining -= 1;
      budget.inspected += 1;
      visitor(entry);
      if (budget.exhausted) break;
    }
  } catch (error) {
    errors.push(errorText(`scan ${directory}`, error));
  } finally {
    try {
      handle?.closeSync();
    } catch {
      // The directory may already be closed after reaching EOF.
    }
  }
}

function createScanBudget(maxEntries: number): ScanBudget {
  return {
    remaining: numericSetting(String(maxEntries), DEFAULT_SCAN_BUDGET, 1),
    inspected: 0,
    exhausted: false,
  };
}

function shouldProtectWorktreeReference(meta: AgentRunSnapshot): boolean {
  if (meta.executionMode !== 'worktree' || meta.worktreeCleanedAt) return false;
  const status = typeof meta.status === 'string' ? meta.status.trim().toLowerCase() : '';
  // Terminal failure/cancel statuses no longer need the worktree. Keep protecting
  // active, waiting_for_user, succeeded-awaiting-integration, and unknown runs.
  if (status && WORKTREE_RELEASE_STATUSES.has(status)) return false;
  return true;
}

function collectReferencedWorktrees(
  controllerHome: string,
  budget: ScanBudget,
  errors: string[],
): WorktreeReferences {
  const referenced = new Set<string>();
  const unsafeRepositories = new Set<string>();
  const repositoriesRoot = join(controllerHome, 'repositories');
  visitDirectoryEntries(repositoriesRoot, budget, errors, (repoEntry) => {
    if (!repoEntry.isDirectory()) return;
    const repoId = repoEntry.name;
    const runsRoot = join(repositoriesRoot, repoId, 'runs');
    visitDirectoryEntries(runsRoot, budget, errors, (runEntry) => {
      if (!runEntry.isDirectory()) return;
      const metaPath = join(runsRoot, runEntry.name, 'meta.json');
      if (!existsSync(metaPath)) {
        unsafeRepositories.add(repoId);
        return;
      }
      try {
        const meta = readJsonFile<AgentRunSnapshot>(metaPath);
        if (!shouldProtectWorktreeReference(meta)) return;
        const worktree = typeof meta.worktree === 'string' && meta.worktree.trim()
          ? meta.worktree.trim()
          : typeof meta.worktreePath === 'string' && meta.worktreePath.trim()
            ? meta.worktreePath.trim()
            : undefined;
        if (!worktree) {
          // Missing path on a still-protected Run is unsafe only when the Run
          // still expects a worktree (active / succeeded / waiting).
          unsafeRepositories.add(repoId);
          return;
        }
        // Protect active Runs and succeeded Runs awaiting integration/cleanup.
        referenced.add(canonicalPath(worktree));
      } catch (error) {
        unsafeRepositories.add(repoId);
        errors.push(errorText(`unreadable Run metadata ${relativeHomePath(controllerHome, metaPath)}`, error));
      }
    });
    if (budget.exhausted) unsafeRepositories.add(repoId);
  });
  return { referenced, unsafeRepositories, complete: !budget.exhausted };
}

function resolveWorktreeSourceRoot(worktreePath: string): string | undefined {
  const gitMarker = join(worktreePath, '.git');
  if (!existsSync(gitMarker)) return undefined;
  try {
    const stats = lstatSync(gitMarker);
    if (stats.isDirectory()) return undefined;
    const content = readFileSync(gitMarker, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/i.exec(content);
    if (!match) return undefined;
    const gitDir = resolve(worktreePath, match[1].trim()).replace(/\\/g, '/');
    const marker = '/.git/worktrees/';
    const index = gitDir.lastIndexOf(marker);
    if (index <= 0) return undefined;
    return gitDir.slice(0, index);
  } catch {
    return undefined;
  }
}

function removeOrphanWorktreeDirectory(path: string, errors: string[], relativePath: string): boolean {
  const sourceRoot = resolveWorktreeSourceRoot(path);
  if (sourceRoot) {
    try {
      execFileSync('git', ['-C', sourceRoot, 'worktree', 'remove', '--force', path], {
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 256 * 1024,
      });
      if (!existsSync(path)) return true;
    } catch {
      // Fall through to filesystem removal + prune.
    }
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    errors.push(errorText(`worktree cleanup ${relativePath}`, error));
    return false;
  }
  if (sourceRoot) {
    try {
      execFileSync('git', ['-C', sourceRoot, 'worktree', 'prune', '--expire', 'now'], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 64 * 1024,
      });
    } catch {
      // Prune is best-effort; directory removal is the primary goal.
    }
  }
  return !existsSync(path);
}

function cleanupOrphanWorktrees(
  controllerHome: string,
  references: WorktreeReferences,
  budget: ScanBudget,
  nowMs: number,
  errors: string[],
): { removed: string[]; skippedActive: string[] } {
  const removed: string[] = [];
  const skippedActive: string[] = [];
  const repositoriesRoot = join(controllerHome, 'repositories');
  visitDirectoryEntries(repositoriesRoot, budget, errors, (repoEntry) => {
    if (!repoEntry.isDirectory()) return;
    const repoId = repoEntry.name;
    const worktreesRoot = join(repositoriesRoot, repoId, 'worktrees');
    visitDirectoryEntries(worktreesRoot, budget, errors, (entry) => {
      if (!entry.isDirectory()) return;
      const path = join(worktreesRoot, entry.name);
      const relativePath = relativeHomePath(controllerHome, path);
      const canonical = canonicalPath(path);
      if (!references.complete || references.unsafeRepositories.has(repoId) || references.referenced.has(canonical)) {
        skippedActive.push(relativePath);
        return;
      }
      try {
        if (nowMs - lstatSync(path).mtimeMs < ORPHAN_WORKTREE_TTL_MS) return;
        if (removeOrphanWorktreeDirectory(path, errors, relativePath)) {
          removed.push(relativePath);
        }
      } catch (error) {
        errors.push(errorText(`worktree cleanup ${relativePath}`, error));
      }
    });
  });
  return { removed, skippedActive };
}

function worktreeContentPath(relativePath: string): boolean {
  return /^repositories\/[^/]+\/worktrees(?:\/|$)/.test(relativePath);
}

function removeStaleTempEntry(
  path: string,
  relativePath: string,
  isDirectory: boolean,
  mtimeMs: number,
  nowMs: number,
  removed: string[],
  errors: string[],
): void {
  if (nowMs - mtimeMs < TEMP_STATE_TTL_MS) return;
  try {
    rmSync(path, { recursive: isDirectory, force: true });
    removed.push(relativePath);
  } catch (error) {
    errors.push(errorText(`temp-state cleanup ${relativePath}`, error));
  }
}

function cleanupTemporaryStatePaths(
  controllerHome: string,
  budget: ScanBudget,
  nowMs: number,
  errors: string[],
): string[] {
  const removed: string[] = [];
  const visit = (directory: string, depth: number, leafOnly = false): void => {
    if (budget.exhausted || depth > TEMP_SCAN_MAX_DEPTH) return;
    visitDirectoryEntries(directory, budget, errors, (entry) => {
      const path = join(directory, entry.name);
      const relativePath = relativeHomePath(controllerHome, path);
      if (worktreeContentPath(relativePath)) return;
      if (entry.isDirectory() && TEMP_SCAN_SKIP_DIR_NAMES.has(entry.name)) return;

      let stats;
      try {
        stats = lstatSync(path);
      } catch (error) {
        errors.push(errorText(`temp-state stat ${relativePath}`, error));
        return;
      }

      if (entry.name.endsWith('.tmp')) {
        removeStaleTempEntry(path, relativePath, entry.isDirectory(), stats.mtimeMs, nowMs, removed, errors);
        return;
      }

      if (!entry.isDirectory() || leafOnly) return;

      // High-cardinality permanent state: only look for sibling *.tmp files.
      if (TEMP_SCAN_LEAF_DIR_NAMES.has(entry.name)) {
        visit(path, depth + 1, true);
        return;
      }
      visit(path, depth + 1, false);
    });
  };

  // Only known runtime-state roots are scanned. Worktree contents and other
  // high-volume permanent trees are bounded above so periodic cleanup cannot
  // burn its entire budget walking historical job records.
  visit(join(controllerHome, 'daemon'), 0);
  visit(join(controllerHome, 'repositories'), 0);
  return removed;
}

function shouldPersistCleanupAudit(report: RuntimeCleanupReport): boolean {
  // Avoid unbounded audit growth from no-op periodic passes that only report
  // budgetExhausted, skippedActiveWorktrees, or a live protected PID skip.
  const hadMutations = Boolean(
    report.removedPidFiles.length
    || report.removedWorktrees.length
    || report.removedTemporaryPaths.length,
  );
  if (hadMutations || report.errors.length) return true;
  // Startup/manual may record defensive skips (live PID protected, budget).
  if (report.reason === 'periodic') return false;
  return Boolean(report.skippedPidFiles.length || report.budgetExhausted);
}

export function cleanupControllerRuntimeState(
  controllerHome: string,
  options: RuntimeCleanupOptions = {},
): RuntimeCleanupReport {
  const home = ensureControllerHome(controllerHome);
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const maxEntries = numericSetting(String(options.maxEntries ?? DEFAULT_SCAN_BUDGET), DEFAULT_SCAN_BUDGET, 1);
  // Separate phase budgets so a huge permanent-state tree cannot starve
  // worktree reference collection or orphan worktree removal.
  const referenceBudget = createScanBudget(maxEntries);
  const worktreeBudget = createScanBudget(maxEntries);
  const tempBudget = createScanBudget(maxEntries);
  const errors: string[] = [];
  const pidFiles = cleanupDaemonPidFile(home, nowIso, options, errors);
  const references = collectReferencedWorktrees(home, referenceBudget, errors);
  const worktrees = cleanupOrphanWorktrees(home, references, worktreeBudget, nowMs, errors);
  const removedTemporaryPaths = cleanupTemporaryStatePaths(home, tempBudget, nowMs, errors).sort();
  const inspectedPaths = referenceBudget.inspected + worktreeBudget.inspected + tempBudget.inspected;
  const budgetExhausted = referenceBudget.exhausted || worktreeBudget.exhausted || tempBudget.exhausted;
  const report: RuntimeCleanupReport = {
    at: nowIso,
    reason: options.reason ?? 'manual',
    removedPidFiles: pidFiles.removed.sort(),
    skippedPidFiles: pidFiles.skipped.sort(),
    removedWorktrees: worktrees.removed.sort(),
    removedTemporaryPaths,
    skippedActiveWorktrees: worktrees.skippedActive.sort(),
    inspectedPaths,
    budgetExhausted,
    errors: errors.sort(),
    logPath: runtimeCleanupLogPath(home),
  };
  if (shouldPersistCleanupAudit(report)) {
    try {
      appendJsonLine(report.logPath, { schemaVersion: 1, ...report });
    } catch (error) {
      report.errors.push(errorText('runtime cleanup audit write failed', error));
    }
  }
  return report;
}
