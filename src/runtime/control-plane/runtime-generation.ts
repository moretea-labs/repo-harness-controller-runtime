import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { repositoryIdentity } from '../../cli/controller/runtime-config';
import { stableCheckoutId } from '../../cli/repositories/identity';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';

/** Explicit override for the Controller Runtime Source root (not an execution repository). */
export const CONTROLLER_RUNTIME_SOURCE_ROOT_ENV = 'REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT';
/** Compatibility alias used by some launchers and docs. */
export const CONTROLLER_RUNTIME_SOURCE_ROOT_ENV_ALIAS = 'REPO_HARNESS_SOURCE_ROOT';

export interface RuntimeSourceIdentity {
  repoId: string;
  checkoutId: string;
  repoRoot: string;
  canonicalRoot: string;
  branch: string | null;
  commit?: string;
  defaultBranch: string;
  defaultBranchCommit?: string;
  dirty: boolean;
  observedAt: string;
}

export interface RuntimeGenerationRecord {
  schemaVersion: 1;
  generation: string;
  revision: number;
  controllerHome: string;
  source: RuntimeSourceIdentity;
  createdAt: string;
  updatedAt: string;
}

export type RuntimeSourceDriftCode =
  | 'RUNTIME_SOURCE_OK'
  | 'RUNTIME_SOURCE_SNAPSHOT_MISSING'
  | 'RUNTIME_SOURCE_CURRENT_UNAVAILABLE'
  | 'RUNTIME_SOURCE_SNAPSHOT_STALE';

export interface RuntimeSourceDrift {
  restartRequired: boolean;
  reasons: string[];
  code: RuntimeSourceDriftCode;
}

export type RuntimeSourceResolveReason =
  | 'explicit'
  | 'env'
  | 'package-root'
  | 'process-cwd'
  | 'unavailable';

export interface ResolvedControllerRuntimeSourceRoot {
  root?: string;
  reason: RuntimeSourceResolveReason;
  detail?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function gitText(root: string, args: string[]): string | undefined {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  return result.status === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : undefined;
}

function gitOk(root: string, args: string[]): boolean {
  const result = spawnSync('git', ['-C', root, ...args], {
    stdio: 'ignore',
    timeout: 10_000,
  });
  return result.status === 0;
}

function detectDefaultBranch(root: string): string {
  const originHead = gitText(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead?.startsWith('origin/')) return originHead.slice('origin/'.length);
  if (gitOk(root, ['show-ref', '--verify', '--quiet', 'refs/heads/main'])) return 'main';
  if (gitOk(root, ['show-ref', '--verify', '--quiet', 'refs/heads/master'])) return 'master';
  return gitText(root, ['branch', '--show-current']) ?? 'main';
}

function runtimeSourceStatusPaths(root: string): string[] {
  const paths = [
    'src',
    'package.json',
    'bun.lock',
    'bun.lockb',
    'bunfig.toml',
  ].filter((entry) => existsSync(join(root, entry)));
  try {
    for (const entry of readdirSync(root)) {
      if (/^tsconfig(?:\..+)?\.json$/.test(entry) && existsSync(join(root, entry))) paths.push(entry);
    }
  } catch (_error) {
    return paths.length > 0 ? [...new Set(paths)] : ['.'];
  }
  return paths.length > 0 ? [...new Set(paths)] : ['.'];
}

function runtimeSourceDirty(root: string): boolean {
  return Boolean(gitText(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...runtimeSourceStatusPaths(root)]));
}

/**
 * Package/install root that owns Controller runtime code.
 * Derived from this module's location so ambient process.cwd() cannot redefine it.
 */
export function packageRuntimeSourceRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function readPackageName(root: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string };
    return typeof pkg.name === 'string' ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when `root` is a Controller runtime package checkout or install tree.
 * Does not hardcode absolute paths or require a specific clone name.
 */
export function looksLikeControllerRuntimePackage(root: string): boolean {
  if (!root || !existsSync(root)) return false;
  const name = readPackageName(root);
  if (name === '@moretea-labs/repo-harness-controller') return true;
  // Source checkout / worktree without install: entry + package markers.
  return existsSync(join(root, 'src', 'runtime', 'control-plane', 'daemon-entry.ts'))
    && existsSync(join(root, 'package.json'));
}

/**
 * Unique Controller Runtime Source root resolver.
 *
 * Authority order:
 * 1. explicit root (daemon/lifecycle handoff)
 * 2. REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT / REPO_HARNESS_SOURCE_ROOT
 * 3. package root derived from this module (source checkout, global install, worktree)
 * 4. process.cwd() only when it itself looks like the controller package
 *
 * Execution repository roots must never be passed here for drift evaluation.
 */
export function resolveControllerRuntimeSourceRoot(options: {
  explicitRoot?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): ResolvedControllerRuntimeSourceRoot {
  const env = options.env ?? process.env;
  const explicit = options.explicitRoot?.trim();
  if (explicit) {
    return { root: resolve(explicit), reason: 'explicit' };
  }

  const fromEnv = env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV]?.trim()
    || env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV_ALIAS]?.trim();
  if (fromEnv) {
    return { root: resolve(fromEnv), reason: 'env' };
  }

  const packageRoot = packageRuntimeSourceRoot();
  if (looksLikeControllerRuntimePackage(packageRoot)) {
    return { root: packageRoot, reason: 'package-root' };
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  if (looksLikeControllerRuntimePackage(cwd)) {
    return {
      root: cwd,
      reason: 'process-cwd',
      detail: 'ambient cwd matches controller runtime package markers',
    };
  }

  return {
    reason: 'unavailable',
    detail: `Unable to resolve controller runtime source root (packageRoot=${packageRoot}, cwd=${cwd})`,
  };
}

export function runtimeGenerationPath(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'system', 'runtime-generation.json');
}

export function collectRuntimeSourceIdentity(repoRoot: string): RuntimeSourceIdentity {
  const canonicalRoot = realpathSync(repoRoot);
  const repoId = `repo_${repositoryIdentity(canonicalRoot)}`;
  const defaultBranch = detectDefaultBranch(canonicalRoot);
  return {
    repoId,
    checkoutId: stableCheckoutId(repoId, canonicalRoot),
    repoRoot,
    canonicalRoot,
    branch: gitText(canonicalRoot, ['branch', '--show-current']) ?? null,
    commit: gitText(canonicalRoot, ['rev-parse', '--verify', 'HEAD']),
    defaultBranch,
    defaultBranchCommit: gitText(canonicalRoot, ['rev-parse', '--verify', defaultBranch]),
    dirty: runtimeSourceDirty(canonicalRoot),
    observedAt: nowIso(),
  };
}

/**
 * Safe identity collection: missing/unreadable roots return undefined instead of throwing.
 */
export function tryCollectRuntimeSourceIdentity(repoRoot: string | undefined): RuntimeSourceIdentity | undefined {
  if (!repoRoot?.trim()) return undefined;
  try {
    if (!existsSync(repoRoot)) return undefined;
    return collectRuntimeSourceIdentity(repoRoot);
  } catch {
    return undefined;
  }
}

/**
 * Current Controller Runtime Source identity from the unique authority resolver.
 * Never accepts an execution repository root.
 */
export function collectCurrentControllerRuntimeSourceIdentity(options: {
  explicitRoot?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): RuntimeSourceIdentity | undefined {
  const resolved = resolveControllerRuntimeSourceRoot(options);
  return tryCollectRuntimeSourceIdentity(resolved.root);
}

export function readRuntimeGeneration(controllerHome: string): RuntimeGenerationRecord | undefined {
  const path = runtimeGenerationPath(controllerHome);
  if (!existsSync(path)) return undefined;
  return readJsonFile<RuntimeGenerationRecord>(path, undefined);
}

export function rotateRuntimeGeneration(
  controllerHome: string,
  source: RuntimeSourceIdentity,
): RuntimeGenerationRecord {
  const path = runtimeGenerationPath(controllerHome);
  mkdirSync(join(ensureControllerHome(controllerHome), 'system'), { recursive: true });
  const current = readRuntimeGeneration(controllerHome);
  const timestamp = nowIso();
  const next: RuntimeGenerationRecord = {
    schemaVersion: 1,
    generation: `runtime-${Date.now()}-${randomUUID().slice(0, 8)}`,
    revision: Math.max(0, current?.revision ?? 0) + 1,
    controllerHome: ensureControllerHome(controllerHome),
    source,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  writeJsonAtomic(path, next);
  return next;
}

export function ensureRuntimeGeneration(
  controllerHome: string,
  source: RuntimeSourceIdentity,
): RuntimeGenerationRecord {
  return readRuntimeGeneration(controllerHome) ?? rotateRuntimeGeneration(controllerHome, source);
}

/**
 * Compare startup Runtime Source snapshot against the current Controller Runtime Source.
 * Missing active snapshot is fail-closed (restart required), never silent pass.
 */
export function evaluateRuntimeSourceDrift(
  active: RuntimeSourceIdentity | undefined,
  current: RuntimeSourceIdentity | undefined,
): RuntimeSourceDrift {
  if (!active) {
    return {
      restartRequired: true,
      reasons: ['Controller runtime source snapshot is missing'],
      code: 'RUNTIME_SOURCE_SNAPSHOT_MISSING',
    };
  }
  if (!current) {
    return {
      restartRequired: true,
      reasons: ['Controller runtime source is unavailable for drift evaluation'],
      code: 'RUNTIME_SOURCE_CURRENT_UNAVAILABLE',
    };
  }

  const reasons: string[] = [];
  if (active.canonicalRoot !== current.canonicalRoot) {
    reasons.push(`runtime source root moved from ${active.canonicalRoot} to ${current.canonicalRoot}`);
  }
  if (active.checkoutId !== current.checkoutId) {
    reasons.push(`runtime checkout changed from ${active.checkoutId} to ${current.checkoutId}`);
  }
  if ((active.branch ?? '') !== (current.branch ?? '')) {
    reasons.push(`runtime branch changed from ${active.branch ?? 'detached'} to ${current.branch ?? 'detached'}`);
  }
  if (current.defaultBranchCommit && active.commit && active.commit !== current.defaultBranchCommit) {
    reasons.push(`runtime commit ${active.commit} is not at ${current.defaultBranch} ${current.defaultBranchCommit}`);
  } else if (active.commit && current.commit && active.commit !== current.commit) {
    reasons.push(`runtime commit changed from ${active.commit} to ${current.commit}`);
  }
  if (active.dirty) {
    reasons.push('runtime was started from a dirty source checkout');
  } else if (current.dirty) {
    reasons.push('runtime source files changed after startup');
  }

  return {
    restartRequired: reasons.length > 0,
    reasons,
    code: reasons.length > 0 ? 'RUNTIME_SOURCE_SNAPSHOT_STALE' : 'RUNTIME_SOURCE_OK',
  };
}

/**
 * Shared drift evaluation used by MCP, CLI, Local Bridge, and restart verification.
 * Always resolves "current" from the Controller Runtime Source authority — never from
 * the selected execution repository.
 */
export function evaluateActiveRuntimeSourceDrift(
  active: RuntimeSourceIdentity | undefined,
  options: {
    explicitRoot?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    /** Test-only override of the current runtime source root (not an execution repo). */
    currentRuntimeRoot?: string;
  } = {},
): RuntimeSourceDrift & { current?: RuntimeSourceIdentity } {
  const current = options.currentRuntimeRoot
    ? tryCollectRuntimeSourceIdentity(options.currentRuntimeRoot)
    : collectCurrentControllerRuntimeSourceIdentity(options);
  return {
    current,
    ...evaluateRuntimeSourceDrift(active, current),
  };
}

export function formatRuntimeSourceDriftMessage(drift: RuntimeSourceDrift): string {
  if (drift.code === 'RUNTIME_SOURCE_SNAPSHOT_MISSING' || (
    drift.restartRequired
    && drift.reasons.length === 1
    && drift.reasons[0] === 'Controller runtime source snapshot is missing'
  )) {
    return 'Controller runtime source snapshot is missing. Restart the controller from an authoritative runtime source before mutating work.';
  }
  if (drift.code === 'RUNTIME_SOURCE_CURRENT_UNAVAILABLE') {
    return 'Controller runtime source is unavailable for drift evaluation. Restore the authoritative runtime source and restart the controller before mutating work.';
  }
  if (drift.restartRequired) {
    const reasons = drift.reasons.length > 0 ? drift.reasons.join('; ') : 'unknown runtime source drift';
    return `Controller runtime source changed after startup: ${reasons}. Restore the authoritative runtime source and restart the controller before mutating work.`;
  }
  return '';
}
