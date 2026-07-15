import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readLatestControllerCheckEvidence,
  runControllerCheck,
  runControllerCheckAsync,
} from '../../src/cli/controller/check-runner';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(checks: Record<string, { command: string[] }>) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-check-provenance-repo-'));
  roots.push(repoRoot);
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'check-provenance-fixture' }));
  mkdirSync(join(repoRoot, '.repo-harness'), { recursive: true });
  writeFileSync(join(repoRoot, '.repo-harness/checks.json'), JSON.stringify({ version: 1, checks }));
  spawnSync('git', ['add', 'package.json'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  return repoRoot;
}

describe('controller check provenance and failure classification', () => {
  test('exposes cache provenance, validated revision, and original execution time', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'repo-harness-check-marker-')), 'runs');
    roots.push(marker.replace(/\/runs$/, ''));
    const command = [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x')`];
    const repoRoot = fixture({ cached: { command } });

    const first = runControllerCheck(repoRoot, 'cached');
    const second = await runControllerCheckAsync(repoRoot, 'cached');
    expect(first.ok).toBe(true);
    expect(first.cacheHit).toBe(false);
    expect(first.validatedRevision).toBeTruthy();
    expect(first.originalExecutedAt).toBe(first.executedAt);
    expect(second.cacheHit).toBe(true);
    expect(second.validatedRevision).toBe(first.validatedRevision);
    expect(second.originalExecutedAt).toBe(first.executedAt);
    expect(readFileSync(marker, 'utf8')).toBe('x');

    const evidence = readLatestControllerCheckEvidence(repoRoot, 'cached');
    expect(evidence).toMatchObject({
      cacheHit: false,
      validatedRevision: first.validatedRevision,
      originalExecutedAt: first.executedAt,
    });
  });

  test('classifies a named nonzero check as acceptance and a missing runtime as infrastructure', async () => {
    const repoRoot = fixture({
      assertion: { command: [process.execPath, '-e', 'console.error("expected value mismatch"); process.exit(3)'] },
      missing: { command: ['repo-harness-runtime-that-does-not-exist', '--check'] },
    });

    const assertion = await runControllerCheckAsync(repoRoot, 'assertion');
    const missing = await runControllerCheckAsync(repoRoot, 'missing');
    expect(assertion.ok).toBe(false);
    expect(assertion.status).toBe(3);
    expect(assertion.failureClass).toBe('acceptance_failure');
    expect(assertion.timedOut).toBe(false);
    expect(missing.ok).toBe(false);
    expect(missing.failureClass).toBe('infrastructure_failure');
    expect(missing.timedOut).toBe(false);
    expect(missing.stderr).toContain('repo-harness-runtime-that-does-not-exist');
  });
});
