import { realpathSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { resolveRepoPreferredControllerHome, resolveControllerHome } from '../repositories/controller-home';
import { listRepositories } from '../repositories/registry';

function gitText(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
  if (result.status !== 0 || result.error) return '';
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

function canonical(path: string): string {
  try { return realpathSync(path); }
  catch (_error) { return path; }
}

interface TargetBranchCacheEntry {
  branch: string;
  registryMtimeMs: number;
  expiresAt: number;
}

/**
 * Short-lived cache: invalidated by registry mtime or 30s TTL.
 *
 * Policy (do not rewrite without explicit design change):
 * - registry mtime 变化时立即失效；
 * - 未检测到 mtime 变化时，defaultBranch 变更最多存在 30 秒可见延迟。
 * - Cache keys include controllerHome + canonical repo root (no cross-repo bleed).
 * - Registry unavailable → Git fallback (origin/HEAD, main/master, current branch).
 */
const targetBranchCache = new Map<string, TargetBranchCacheEntry>();
const TARGET_BRANCH_TTL_MS = 30_000;

function registryMtimeMs(controllerHome: string): number {
  try {
    return statSync(join(resolveControllerHome(controllerHome), 'repositories.json')).mtimeMs;
  } catch {
    return 0;
  }
}

export function clearCompletionTargetCache(): void {
  targetBranchCache.clear();
}

export function resolveCompletionTargetBranch(repoRoot: string): string {
  const root = canonical(repoRoot);
  try {
    const home = resolveRepoPreferredControllerHome(repoRoot);
    const mtime = registryMtimeMs(home);
    const cacheKey = `${home}\0${root}`;
    const cached = targetBranchCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.registryMtimeMs === mtime && cached.expiresAt > now) {
      return cached.branch;
    }
    const registered = listRepositories(home, { includeRemoved: true }).find((record) => {
      if (canonical(record.canonicalRoot) === root || canonical(record.localRoot) === root) return true;
      return record.checkouts.some((checkout) => canonical(checkout.canonicalRoot) === root || canonical(checkout.localRoot) === root);
    });
    if (registered?.defaultBranch?.trim()) {
      const branch = registered.defaultBranch.trim();
      targetBranchCache.set(cacheKey, {
        branch,
        registryMtimeMs: mtime,
        expiresAt: now + TARGET_BRANCH_TTL_MS,
      });
      return branch;
    }
  } catch (_error) {
    // Temporary test repositories and unregistered clones fall through to Git discovery.
  }

  const remoteHead = gitText(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead.startsWith('origin/')) return remoteHead.slice('origin/'.length);
  for (const candidate of ['main', 'master']) {
    if (gitText(repoRoot, ['show-ref', '--verify', '--hash', `refs/heads/${candidate}`])) return candidate;
  }
  return gitText(repoRoot, ['branch', '--show-current']) || 'main';
}

export function currentCompletionTarget(repoRoot: string): {
  branch: string;
  revision: string;
  expectedBranch: string;
  onTargetBranch: boolean;
} {
  const branch = gitText(repoRoot, ['branch', '--show-current']);
  const revision = gitText(repoRoot, ['rev-parse', 'HEAD']);
  if (!branch) throw new Error('integration target must be an attached branch');
  if (!revision) throw new Error('integration target revision is unavailable');
  const expectedBranch = resolveCompletionTargetBranch(repoRoot);
  return { branch, revision, expectedBranch, onTargetBranch: branch === expectedBranch };
}
