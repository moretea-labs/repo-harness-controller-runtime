import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildControllerContextPack } from '../../src/cli/controller/context-pack';
import { getMcpPolicy } from '../../src/cli/mcp/policy';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-context-dir-'));
  roots.push(root);
  mkdirSync(join(root, 'src/nested'), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), 'export const alpha = 1;\n');
  writeFileSync(join(root, 'src/nested/b.ts'), 'export const beta = 2;\n');
  writeFileSync(join(root, 'outside.txt'), 'outside\n');
  symlinkSync(join(root, 'outside.txt'), join(root, 'src/nested/link.txt'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Repo Harness Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: root });
  return root;
}

describe('controller context pack directory expansion', () => {
  test('recursively expands an explicit known directory inside policy bounds', () => {
    const root = fixture();
    const pack = buildControllerContextPack(root, getMcpPolicy('controller', { repoRoot: root }), {
      description: 'Inspect source directory',
      knownPaths: ['src'],
      maxFiles: 10,
      maxSnippets: 10,
    });
    expect(pack.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/nested/b.ts']);
    expect(pack.search.scannedFiles).toBeGreaterThanOrEqual(2);
    expect(pack.files.every((file) => file.reasons.some((reason) => reason.startsWith('explicit-known-directory:src')))).toBe(true);
    expect(pack.deniedPaths).toContainEqual({ path: 'src/nested/link.txt', reason: 'symbolic links are not followed' });
  });

  test('keeps enumeration bounded and reports truncation instead of silently dropping files', () => {
    const root = fixture();
    for (let index = 0; index < 50; index += 1) {
      writeFileSync(join(root, 'src', `generated-${String(index).padStart(2, '0')}.ts`), `export const n${index} = ${index};\n`);
    }
    const pack = buildControllerContextPack(root, getMcpPolicy('controller', { repoRoot: root }), {
      knownPaths: ['src'],
      maxFiles: 2,
      maxSnippets: 2,
    });
    expect(pack.files).toHaveLength(2);
    expect(pack.search.truncated).toBe(true);
    expect(pack.omitted.length).toBeGreaterThan(0);
  });
});
