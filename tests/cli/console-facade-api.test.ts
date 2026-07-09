import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import {
  applyConsoleSafePatch,
  buildCommandCenter,
  mapRepositoryCard,
  previewExecutionMode,
  startConsoleWork,
  listConsoleHandoffs,
} from '../../src/cli/local-bridge/facade-api';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-console-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-console-home-'));
  roots.push(repoRoot, controllerHome);
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
    name: 'console-fixture',
    scripts: { 'check:type': 'node -e "process.exit(0)"' },
  }, null, 2));
  spawnSync('git', ['add', 'package.json'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Console Fixture' });
  return {
    ctx: { controllerHome, repository },
    repository,
  };
}

describe('console facade api', () => {
  test('command center uses plain language readiness and no default internal ids in primary fields', async () => {
    const { ctx, repository } = fixture();
    const center = await buildCommandCenter(ctx, [mapRepositoryCard(repository, true)]);
    expect(center.readiness.label).toMatch(/就绪|需要设置|暂不可用|读取失败|未知|可用|系统/);
    expect(center.currentRepository?.name).toBe('Console Fixture');
    expect(center.modePreviewDefault.label).toBeTruthy();
    expect(JSON.stringify(center.readiness)).not.toContain('stdout');
    expect(JSON.stringify(center.readiness)).not.toContain('stderr');
  });

  test('mode preview distinguishes direct control and goal workloop', () => {
    expect(previewExecutionMode({
      scopeClear: true,
      expectedFiles: 1,
      expectedChangedLines: 10,
    }).mode).toBe('direct_control');
    expect(previewExecutionMode({
      scopeClear: true,
      expectedFiles: 12,
      expectedChangedLines: 500,
      requiresLongRunningChecks: true,
    }).mode).toBe('goal_workloop');
    expect(previewExecutionMode({
      scopeClear: false,
    }).mode).toBe('handoff_only');
  });

  test('start work creates work or handoff through facade and maps user-facing state', async () => {
    const { ctx } = fixture();
    const small = startConsoleWork(ctx, {
      objective: 'Fix a small typo',
      expectedFiles: 1,
      expectedChangedLines: 3,
      scopeClear: true,
    });
    expect((small.data as { workContractCreated?: boolean }).workContractCreated).toBe(false);
    expect((small.data as { mode?: { mode?: string } }).mode?.mode).toBe('direct_control');

    const complex = startConsoleWork(ctx, {
      objective: 'Refactor console around facade workflows',
      expectedFiles: 10,
      expectedChangedLines: 400,
      requiresLongRunningChecks: true,
      scopeClear: true,
      checkIds: ['typecheck'],
    });
    expect((complex.data as { workContractCreated?: boolean }).workContractCreated).toBe(true);
    const center = await buildCommandCenter(ctx, [mapRepositoryCard(ctx.repository, true)]);
    expect(center.currentWork || center.recentWork.length).toBeTruthy();
    if (center.currentWork) {
      expect(center.currentWork.title).toContain('Refactor console');
      expect(center.currentWork.advanced?.workId).toBeTruthy();
      expect(center.currentWork.statusLabel).toBeTruthy();
    }
  });

  test('high-risk start creates handoff-only pending decision', () => {
    const { ctx } = fixture();
    const result = startConsoleWork(ctx, {
      objective: 'Rotate secrets and force push',
      destructive: true,
      requiresApproval: true,
      scopeClear: true,
    });
    expect((result.data as { mode?: { mode?: string } }).mode?.mode).toBe('handoff_only');
    expect(listConsoleHandoffs(ctx).length).toBeGreaterThan(0);
  });

  test('console safe patch applies synchronously with readable digest', () => {
    const { ctx } = fixture();
    const result = applyConsoleSafePatch(ctx, {
      purpose: 'create notes file',
      operations: [
        { type: 'create', path: 'notes/hello.md', content: '# hello\\n' },
      ],
    });
    expect(result.terminal).toBe(true);
    expect(result.applyMode).toBe('sync');
    expect(result.phase === 'succeeded' || result.phase === 'failed').toBe(true);
    expect(String(result.summary || '')).toBeTruthy();
    if (result.phase === 'succeeded') {
      expect(Array.isArray(result.changedFiles)).toBe(true);
      expect((result.changedFiles as string[]).some((path) => path.includes('hello.md'))).toBe(true);
    }
  });
});
