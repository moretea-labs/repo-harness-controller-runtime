import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { repositoryIdentity } from '../../cli/controller/runtime-config';
import { stableCheckoutId } from '../../cli/repositories/identity';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';

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

export interface RuntimeSourceDrift {
  restartRequired: boolean;
  reasons: string[];
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

export function evaluateRuntimeSourceDrift(
  active: RuntimeSourceIdentity | undefined,
  current: RuntimeSourceIdentity,
): RuntimeSourceDrift {
  if (!active) return { restartRequired: false, reasons: [] };
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
  }
  return {
    restartRequired: reasons.length > 0,
    reasons,
  };
}
