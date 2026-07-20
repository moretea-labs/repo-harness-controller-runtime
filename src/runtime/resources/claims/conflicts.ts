import type { ResourceClaimSpec } from '../../execution/jobs/types';
import type { ExecutionLease } from '../leases/types';

function pathValue(key: string): string | undefined {
  if (!key.startsWith('path:')) return undefined;
  const raw = key.slice('path:'.length).replace(/^\.\//, '');
  // Support path:<checkoutId>:<relative> and legacy path:<relative>
  const parts = raw.split(':');
  if (parts.length >= 2 && !parts[0]!.includes('/') && !parts[0]!.includes('.')) {
    // checkout-scoped: return relative path portion for overlap checks
    return parts.slice(1).join(':').replace(/^\.\//, '');
  }
  return raw;
}

function pathCheckoutId(key: string): string | undefined {
  if (!key.startsWith('path:')) return undefined;
  const raw = key.slice('path:'.length);
  const parts = raw.split(':');
  if (parts.length >= 2 && !parts[0]!.includes('/') && !parts[0]!.includes('.')) {
    return parts[0];
  }
  return undefined;
}

function workspaceCheckoutId(key: string): string | undefined {
  return key.startsWith('workspace:') ? key.slice('workspace:'.length) : undefined;
}

function gitIndexCheckoutId(key: string): string | undefined {
  if (key.startsWith('git-index:')) return key.slice('git-index:'.length);
  if (key.startsWith('git-head:')) return key.slice('git-head:'.length);
  return undefined;
}

function isGitRefKey(key: string): boolean {
  return key.startsWith('git-ref:') || key.startsWith('git-refs:');
}

function pathOverlaps(left: string, right: string): boolean {
  const a = left.replace(/\*\*?$/, '').replace(/\/$/, '');
  const b = right.replace(/\*\*?$/, '').replace(/\/$/, '');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Resource key overlap for mutation ownership.
 * workspace:<checkoutId> conflicts with same-checkout path/index/head and with
 * unscoped path:/git-ref claims (legacy keys lack checkout identity).
 */
export function resourceKeysOverlap(left: string, right: string): boolean {
  if (left === right) return true;

  if (left === 'repo-content:*') {
    return right === 'repo-content:*'
      || right.startsWith('path:')
      || right.startsWith('workspace:')
      || isGitRefKey(right)
      || right.startsWith('git-index:')
      || right.startsWith('git-head:');
  }
  if (right === 'repo-content:*') {
    return left.startsWith('path:')
      || left.startsWith('workspace:')
      || isGitRefKey(left)
      || left.startsWith('git-index:')
      || left.startsWith('git-head:');
  }

  const leftWs = workspaceCheckoutId(left);
  const rightWs = workspaceCheckoutId(right);
  if (leftWs && rightWs) return leftWs === rightWs;

  // workspace vs path (checkout-scoped or legacy unscoped)
  if (leftWs && right.startsWith('path:')) {
    const pathCheckout = pathCheckoutId(right);
    return pathCheckout === undefined || pathCheckout === leftWs;
  }
  if (rightWs && left.startsWith('path:')) {
    const pathCheckout = pathCheckoutId(left);
    return pathCheckout === undefined || pathCheckout === rightWs;
  }

  // workspace vs git-index/head for same checkout
  if (leftWs) {
    const indexCheckout = gitIndexCheckoutId(right);
    if (indexCheckout !== undefined) return indexCheckout === leftWs;
    if (isGitRefKey(right)) return true; // refs are repo-scoped; conflict with any checkout mutation
  }
  if (rightWs) {
    const indexCheckout = gitIndexCheckoutId(left);
    if (indexCheckout !== undefined) return indexCheckout === rightWs;
    if (isGitRefKey(left)) return true;
  }

  const leftPath = pathValue(left);
  const rightPath = pathValue(right);
  if (leftPath !== undefined && rightPath !== undefined) {
    const leftCheckout = pathCheckoutId(left);
    const rightCheckout = pathCheckoutId(right);
    if (leftCheckout && rightCheckout && leftCheckout !== rightCheckout) return false;
    return pathOverlaps(leftPath, rightPath);
  }

  if (isGitRefKey(left) && isGitRefKey(right)) return true;

  return false;
}

export function claimsConflict(claim: ResourceClaimSpec, lease: ExecutionLease): boolean {
  const claimRelease = claim.resourceKey.startsWith('release:');
  const leaseRelease = lease.resourceKey.startsWith('release:');
  if (claimRelease || leaseRelease) {
    if (claimRelease && leaseRelease) return true;
    // Release Freeze blocks mutations and external effects but intentionally
    // allows read-only observation and Schedule triage to remain available.
    const nonReleaseMode = claimRelease ? lease.mode : claim.mode;
    return nonReleaseMode !== 'read';
  }
  if (!resourceKeysOverlap(claim.resourceKey, lease.resourceKey)) return false;
  return claim.mode !== 'read' || lease.mode !== 'read';
}

export function normalizeClaims(claims: ResourceClaimSpec[], options: { readOnly?: boolean } = {}): ResourceClaimSpec[] {
  if (claims.length === 0) {
    return options.readOnly ? [] : [{ resourceKey: 'repo-content:*', mode: 'write' }];
  }
  const map = new Map<string, ResourceClaimSpec>();
  for (const claim of claims) {
    const key = claim.resourceKey.trim();
    if (!key) continue;
    const existing = map.get(key);
    if (!existing || existing.mode === 'read' && claim.mode !== 'read' || existing.mode === 'write' && claim.mode === 'exclusive') {
      map.set(key, { ...claim, resourceKey: key });
    }
  }
  return [...map.values()];
}
