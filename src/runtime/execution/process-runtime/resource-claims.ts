/**
 * Fine-grained resource claims for Process Runtime and MCP operations.
 * Prefer path / git-index / git-refs / build-cache over whole-repo exclusive locks.
 */

import type { ResourceClaimSpec } from '../jobs/types';
import { classifyRepositoryCommand } from '../../../cli/repositories/command-classifier';
import { normalizeRepositoryCommand } from '../../../cli/repositories/command-normalization';
import { isFocusedCheckCommand } from '../thin-harness/execution-router';
import type { ProcessResourceClaim } from './types';
import { normalizeClaimPath } from '../../resources/claims/conflicts';

export type ResourceClaimKind =
  | 'workspace_read'
  | 'path_write'
  | 'build_cache_write'
  | 'git_index'
  | 'git_refs'
  | 'integration'
  | 'migration'
  | 'release'
  | 'remote_mutation'
  | 'heavy_check'
  | 'workspace_write';

function checkoutScope(checkoutId?: string): string {
  return checkoutId?.trim() || 'active';
}

/**
 * Workspace read uses the same resource key as workspace write.
 * Conflict is expressed via mode (read vs write), not a separate key.
 * Legacy workspace-read:* keys are normalized in claims/conflicts.ts.
 */
export function claimWorkspaceRead(checkoutId?: string): ResourceClaimSpec {
  return { resourceKey: `workspace:${checkoutScope(checkoutId)}`, mode: 'read' };
}

export function claimPathWrite(path: string, checkoutId?: string): ResourceClaimSpec {
  const normalized = normalizeClaimPath(path);
  if (!normalized) {
    // Unsafe / ambiguous path → escalate to whole-checkout workspace write.
    return claimWorkspaceWrite(checkoutId);
  }
  return { resourceKey: `path:${checkoutScope(checkoutId)}:${normalized}`, mode: 'write' };
}

export function claimBuildCacheWrite(repoId: string): ResourceClaimSpec {
  return { resourceKey: `build-cache:${repoId}`, mode: 'write' };
}

export function claimGitIndex(checkoutId?: string): ResourceClaimSpec {
  return { resourceKey: `git-index:${checkoutScope(checkoutId)}`, mode: 'exclusive' };
}

export function claimGitRefs(repoId: string): ResourceClaimSpec {
  return { resourceKey: `git-refs:${repoId}`, mode: 'exclusive' };
}

export function claimIntegration(repoId: string): ResourceClaimSpec {
  return { resourceKey: `integration:${repoId}`, mode: 'exclusive' };
}

export function claimRelease(repoId: string): ResourceClaimSpec {
  return { resourceKey: `release:${repoId}`, mode: 'exclusive' };
}

export function claimRemoteMutation(repoId: string): ResourceClaimSpec {
  return { resourceKey: `remote:${repoId}`, mode: 'exclusive' };
}

export function claimWorkspaceWrite(checkoutId?: string): ResourceClaimSpec {
  return { resourceKey: `workspace:${checkoutScope(checkoutId)}`, mode: 'write' };
}

export function claimHeavyCheck(repoId: string): ResourceClaimSpec {
  return { resourceKey: `heavy-check:${repoId}`, mode: 'exclusive' };
}

function looksLikeBuildOrTest(command: string | readonly string[]): boolean {
  const text = Array.isArray(command) ? command.join(' ') : String(command);
  const lower = text.toLowerCase();
  return /\b(?:bun|npm|pnpm|yarn|node|cargo|go|swift|pytest|xcodebuild|tsc|eslint|biome)\b/.test(lower)
    && /\b(?:test|check|typecheck|lint|build|compile)\b/.test(lower);
}

function extractLikelyPaths(command: string | readonly string[]): string[] {
  const words = Array.isArray(command)
    ? command.map(String)
    : String(command).split(/\s+/);
  return words.filter((word) => {
    if (!word || word.startsWith('-')) return false;
    return word.includes('/')
      || word.includes('\\')
      || /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|test|spec|json|md)$/i.test(word);
  }).map((word) => word.replace(/^\.\//, '').replace(/\\/g, '/'));
}

/**
 * Classify resource claims for a repository command without taking whole-repo exclusive locks
 * for ordinary readonly / focused validation commands.
 */
export function claimsForRepositoryCommand(
  command: string | readonly string[],
  repoId: string,
  checkoutId?: string,
  defaultBranch?: string,
): ResourceClaimSpec[] {
  const classification = classifyRepositoryCommand(command, defaultBranch);
  const canonical = normalizeRepositoryCommand(command);
  const focused = isFocusedCheckCommand(command);

  if (classification.risk === 'readonly') {
    return [claimWorkspaceRead(checkoutId)];
  }
  if (classification.risk === 'remote_write') {
    return [claimRemoteMutation(repoId), claimGitRefs(repoId)];
  }
  if (classification.risk === 'destructive') {
    return [
      claimWorkspaceWrite(checkoutId),
      claimGitIndex(checkoutId),
      claimGitRefs(repoId),
    ];
  }

  // workspace_write — refine
  if (focused || looksLikeBuildOrTest(command)) {
    const paths = extractLikelyPaths(command);
    const claims: ResourceClaimSpec[] = [claimWorkspaceRead(checkoutId), claimBuildCacheWrite(repoId)];
    // Focused tests may write snapshots next to sources.
    for (const path of paths.slice(0, 16)) {
      claims.push(claimPathWrite(path, checkoutId));
    }
    if (paths.length === 0) {
      // Unknown output paths — conservative path-less workspace write, not heavy-check exclusive.
      claims.push(claimWorkspaceWrite(checkoutId));
    }
    return claims;
  }

  const program = canonical.kind === 'argv'
    ? (canonical.executable ?? '').split(/[\\/]/).at(-1)?.toLowerCase()
    : undefined;
  const sub = canonical.kind === 'argv' ? canonical.args?.[0]?.toLowerCase() : undefined;
  if (program === 'git') {
    if (sub === 'add' || sub === 'rm' || sub === 'mv' || sub === 'restore' || sub === 'apply') {
      return [claimGitIndex(checkoutId), claimWorkspaceWrite(checkoutId)];
    }
    if (sub === 'commit' || sub === 'merge' || sub === 'rebase' || sub === 'cherry-pick' || sub === 'revert') {
      return [claimGitIndex(checkoutId), claimGitRefs(repoId), claimWorkspaceWrite(checkoutId)];
    }
    if (sub === 'checkout' || sub === 'switch' || sub === 'branch' || sub === 'tag') {
      return [claimGitRefs(repoId), claimWorkspaceWrite(checkoutId)];
    }
  }

  // Unknown mutating command — workspace write, not heavy-check exclusive.
  return [claimWorkspaceWrite(checkoutId)];
}

/**
 * Claims for run_check by check id / command.
 * Only full CI / release / multi-phase checks take heavy-check exclusive.
 */
export function claimsForCheck(
  checkId: string,
  command: readonly string[] | undefined,
  repoId: string,
  checkoutId?: string,
): ResourceClaimSpec[] {
  // Self-hosting controller-v8 spawns nested jobs; exclusive heavy-check would deadlock.
  if (/(?:^|:)(?:check:controller-v8|package:check:controller-v8|controller-v8)(?:$|:)/i.test(checkId)) {
    return [claimWorkspaceRead(checkoutId), claimBuildCacheWrite(repoId)];
  }
  const heavy = /(?:^|:)(?:test(?::coverage)?|check:(?:ci|public-export|release(?:-[a-z0-9-]+)?))$/.test(checkId)
    || /release|migration|integrate/i.test(checkId);
  if (heavy) {
    return [claimHeavyCheck(repoId)];
  }
  if (command && command.length > 0) {
    return claimsForRepositoryCommand(command, repoId, checkoutId);
  }
  // Light package scripts (typecheck, lint, focused test) share build-cache write + workspace read.
  return [claimWorkspaceRead(checkoutId), claimBuildCacheWrite(repoId)];
}

export function toProcessClaims(claims: ResourceClaimSpec[]): ProcessResourceClaim[] {
  return claims.map((claim) => ({
    resourceKey: claim.resourceKey,
    mode: claim.mode,
  }));
}
