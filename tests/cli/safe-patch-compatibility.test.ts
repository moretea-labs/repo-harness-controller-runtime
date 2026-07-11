import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applySafePatch, buildSafePatchPlan, normalizeSafePatchOperations } from '../../src/cli/repositories/safe-patch';
import type { RepositoryRecord } from '../../src/cli/repositories/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; repository: RepositoryRecord } {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-safe-patch-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/example.ts'), 'export const value = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Repo Harness Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: root });
  const repository = {
    schemaVersion: 1,
    repoId: 'repo-safe-patch',
    displayName: 'safe patch fixture',
    canonicalRoot: root,
    localRoot: root,
    defaultBranch: 'master',
    repositoryType: 'git',
    enabled: true,
    activeCheckoutId: 'checkout-safe-patch',
    checkouts: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastSeenAt: new Date(0).toISOString(),
  } as unknown as RepositoryRecord;
  return { root, repository };
}

describe('safe patch compatibility', () => {
  test('accepts one top-level old_text/new_text replacement', () => {
    const { root, repository } = fixture();
    const operations = [{
      type: 'replace',
      path: 'src/example.ts',
      old_text: 'value = 1',
      new_text: 'value = 2',
    }];
    expect(normalizeSafePatchOperations(operations)).toEqual([{
      type: 'replace',
      path: 'src/example.ts',
      expectedSha256: '',
      replacements: [{ oldText: 'value = 1', newText: 'value = 2', replaceAll: false }],
    }]);
    expect(buildSafePatchPlan(repository, { operations }).operationCount).toBe(1);
    const applied = applySafePatch(repository, { operations, allowedPaths: ['src/**'] });
    expect(applied.status).toBe('applied');
    expect(readFileSync(join(root, 'src/example.ts'), 'utf8')).toContain('value = 2');
  });

  test('rejects a replace operation with no replacement payload', () => {
    const { repository } = fixture();
    expect(() => buildSafePatchPlan(repository, {
      operations: [{ type: 'replace', path: 'src/example.ts' }],
    })).toThrow('replace requires replacements[] or old_text/new_text');
  });
});
