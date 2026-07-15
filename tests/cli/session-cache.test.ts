import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  clearAllSessionCachesForTest,
  collectSessionIdentity,
  getOrCreateSessionCache,
} from '../../src/cli/repository/session-cache';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { readRepositoryRange, searchRepository } from '../../src/cli/repository/inspector';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  clearAllSessionCachesForTest();
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function initRepo(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  writeFileSync(join(root, 'src', 'b.ts'), 'export const findme = true;\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Repo Harness Test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
}

describe('repository session cache (level 1)', () => {
  test('repeated range reads with unchanged SHA hit cache', () => {
    const root = temp('repo-harness-session-range-');
    initRepo(root);
    const identity = collectSessionIdentity({
      repoRoot: root,
      repoId: 'repo_test',
      checkoutId: 'checkout_test',
    });
    const session = {
      sessionId: 'sess-1',
      repoId: identity.repoId,
      checkoutId: identity.checkoutId,
    };
    const policy = getMcpPolicy('controller', { repoRoot: root });
    const first = readRepositoryRange(root, policy, 'src/a.ts', 1, 2, session);
    const second = readRepositoryRange(root, policy, 'src/a.ts', 1, 2, session);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.content).toBe(first.content);
    const cache = getOrCreateSessionCache('sess-1', root, identity);
    expect(cache.getMetrics().cacheHit).toBeGreaterThan(0);
  });

  test('search with same HEAD reuses results and avoids full scan metrics', () => {
    const root = temp('repo-harness-session-search-');
    initRepo(root);
    const identity = collectSessionIdentity({
      repoRoot: root,
      repoId: 'repo_search',
      checkoutId: 'checkout_search',
    });
    const session = {
      sessionId: 'sess-search',
      repoId: identity.repoId,
      checkoutId: identity.checkoutId,
    };
    const policy = getMcpPolicy('controller', { repoRoot: root });
    const first = searchRepository(root, policy, { query: 'findme', session });
    const second = searchRepository(root, policy, { query: 'findme', session });
    expect(first.cacheHit).toBeFalsy();
    expect(second.cacheHit).toBe(true);
    expect(second.results.length).toBe(first.results.length);
  });

  test('file change invalidates only related content after refresh', () => {
    const root = temp('repo-harness-session-invalidate-');
    initRepo(root);
    let identity = collectSessionIdentity({
      repoRoot: root,
      repoId: 'repo_inv',
      checkoutId: 'checkout_inv',
    });
    const session = {
      sessionId: 'sess-inv',
      repoId: identity.repoId,
      checkoutId: identity.checkoutId,
    };
    const policy = getMcpPolicy('controller', { repoRoot: root });
    const first = readRepositoryRange(root, policy, 'src/a.ts', 1, 3, session);
    expect(first.cacheHit).toBe(false);

    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 99;\n');
    identity = collectSessionIdentity({
      repoRoot: root,
      repoId: 'repo_inv',
      checkoutId: 'checkout_inv',
    });
    const cache = getOrCreateSessionCache('sess-inv', root, identity);
    cache.invalidateFile('src/a.ts');
    const second = readRepositoryRange(root, policy, 'src/a.ts', 1, 3, session);
    expect(second.cacheHit).toBe(false);
    expect(second.content).toContain('99');
    expect(cache.getMetrics().invalidations).toBeGreaterThan(0);
  });

  test('checkout change clears checkout-scoped cache entries', () => {
    const root = temp('repo-harness-session-checkout-');
    initRepo(root);
    const identityA = collectSessionIdentity({
      repoRoot: root,
      repoId: 'repo_co',
      checkoutId: 'checkout_a',
    });
    const cacheA = getOrCreateSessionCache('sess-co', root, identityA);
    cacheA.putRange({
      path: 'src/a.ts',
      fileSha: 'abc',
      startLine: 1,
      endLine: 1,
      content: '1: stale',
      totalLines: 1,
      bytes: 8,
    });
    const identityB = {
      ...identityA,
      checkoutId: 'checkout_b',
    };
    const cacheB = getOrCreateSessionCache('sess-co', root, identityB);
    expect(cacheB.getRange('src/a.ts', 1, 1)).toBeNull();
  });
});
