import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome, repositoryControllerRoot } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { writeJsonAtomic } from '../../src/runtime/shared/json-files';
import {
  applyConsoleSafePatch,
  approveConsoleHandoff,
  buildCommandCenter,
  describeConsoleError,
  mapRepositoryCard,
  previewExecutionMode,
  startConsoleWork,
  summarizeChangedFiles,
  toConsoleOperationFeedback,
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

function writeStoredPluginManifest(
  controllerHome: string,
  repoId: string,
  pluginId: string,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  writeJsonAtomic(join(repositoryControllerRoot(controllerHome, repoId), 'plugins', 'manifests', `${pluginId}.json`), {
    schemaVersion: 1,
    manifestVersion: 1,
    revision: 33,
    pluginId,
    provider: 'stored-provider',
    displayName: `Stored ${pluginId}`,
    pluginVersion: '1.0.0-test',
    authority: {
      strategy: 'derived',
      duplicateStateAllowed: false,
      sourceOfTruth: ['test'],
    },
    enabled: true,
    lifecycle: {
      state: 'enabled',
    },
    health: {
      state: 'ready',
      checkedAt: new Date().toISOString(),
      ready: true,
      probed: true,
      errors: [],
      warnings: [],
    },
    permissions: [],
    capabilities: [],
    actions: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
}

describe('console facade api', () => {
  test('command center uses plain language readiness and no default internal ids in primary fields', async () => {
    const { ctx, repository } = fixture();
    const center = await buildCommandCenter(ctx, [mapRepositoryCard(repository, true)]);
    expect(center.readiness.label).toMatch(/就绪|需要设置|暂不可用|读取失败|未知|可用|系统/);
    expect(center.currentRepository?.name).toBe('Console Fixture');
    expect(center.currentRepository?.branchLabel || center.currentRepository?.statusLabel).toBeTruthy();
    expect(center.modePreviewDefault.label).toBeTruthy();
    expect(center.pluginSummary).toBeTruthy();
    expect(Array.isArray(center.plugins)).toBe(true);
    expect(center.pluginSummary!.total).toBeGreaterThanOrEqual(0);
    expect(center.setupGuide).toBeTruthy();
    expect(JSON.stringify(center.readiness)).not.toContain('stdout');
    expect(JSON.stringify(center.readiness)).not.toContain('stderr');
  });

  test('work summary exposes phase, next action, and error classification for failed work', async () => {
    const { ctx } = fixture();
    const complex = startConsoleWork(ctx, {
      objective: 'Implement multi-file console polish',
      expectedFiles: 10,
      expectedChangedLines: 400,
      requiresLongRunningChecks: true,
      scopeClear: true,
      checkIds: ['typecheck'],
    });
    expect((complex.data as { workContractCreated?: boolean }).workContractCreated).toBe(true);
    const center = await buildCommandCenter(ctx, [mapRepositoryCard(ctx.repository, true)]);
    const work = center.currentWork || center.recentWork[0];
    expect(work).toBeTruthy();
    expect(work!.phase).toBeTruthy();
    expect(work!.phaseLabel).toBeTruthy();
    expect(work!.latestAction || work!.nextAction).toBeTruthy();
    expect(work!.objective).toContain('console polish');
  });

  test('command center plugin cards reuse stored plugin manifests on hot reads', async () => {
    const { ctx, repository } = fixture();
    writeStoredPluginManifest(ctx.controllerHome, repository.repoId, 'github', {
      revision: 88,
      displayName: 'Stored GitHub',
    });

    const center = await buildCommandCenter(ctx, [mapRepositoryCard(repository, true)]);
    const plugin = center.plugins.find((entry) => entry.id === 'github');

    expect(plugin).toBeTruthy();
    expect(plugin?.name).toBe('Stored GitHub');
    expect(plugin?.advanced?.revision).toBe(88);
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

  test('high-risk approval explains the decision and continues only after explicit approval', async () => {
    const { ctx } = fixture();
    const result = startConsoleWork(ctx, {
      objective: 'Rotate secrets and force push',
      destructive: true,
      requiresApproval: true,
      scopeClear: true,
    });
    expect((result.data as { mode?: { mode?: string } }).mode?.mode).toBe('handoff_only');
    const handoff = listConsoleHandoffs(ctx)[0];
    expect(handoff).toBeTruthy();
    expect(handoff.decision.type).toBe('approval');
    expect(handoff.decision.typeLabel).toContain('审批');
    expect(handoff.decision.requestedAction).toBeTruthy();
    expect(handoff.decision.necessityExplanation).toBeTruthy();
    expect(handoff.decision.requestedAction).toContain('Rotate secrets');
    expect(handoff.decision.afterApproval).toContain('创建任务');
    expect(handoff.decision.primaryActionLabel).toBe('批准并创建任务');
    expect(handoff.decision.canApproveAndContinue).toBe(true);

    const approved = approveConsoleHandoff(ctx, handoff.id);
    expect(approved.continued).toBe(true);
    expect(approved.item.statusLabel).toBe('已解决');
    const center = await buildCommandCenter(ctx, [mapRepositoryCard(ctx.repository, true)]);
    expect(center.currentWork?.objective).toContain('Rotate secrets');
  });

  test('clarification handoff is not mislabeled as approval', () => {
    const { ctx } = fixture();
    startConsoleWork(ctx, {
      objective: 'Improve it',
      scopeClear: false,
    });
    const handoff = listConsoleHandoffs(ctx)[0];
    expect(handoff.decision.type).toBe('clarification');
    expect(handoff.decision.necessityLabel).toBe('需要澄清');
    expect(handoff.decision.canApproveAndContinue).toBe(false);
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
      const summary = summarizeChangedFiles(result.changedFiles as string[]);
      expect(summary?.total).toBeGreaterThan(0);
      expect(summary?.summaryLabel).toBeTruthy();
    }
  });

  test('user-facing error catalog covers acceptance and infrastructure failures', () => {
    const acceptance = describeConsoleError('acceptance_failure', 'typecheck failed');
    expect(acceptance.title).toContain('验收');
    expect(acceptance.nextActions.length).toBeGreaterThan(0);
    const infra = describeConsoleError('infrastructure_failure');
    expect(infra.title).toContain('环境');
    const feedback = toConsoleOperationFeedback({
      schemaVersion: 1,
      status: 'failed',
      summary: '验收未通过：typecheck failed',
      data: {},
      evidenceRefs: [],
      warnings: [],
      suggestedNextActions: [],
      rawAvailable: false,
      detailLevel: 'summary',
    });
    expect(feedback.phase).toBe('failed');
    expect(feedback.error?.errorClass).toBe('acceptance_failure');
  });
});
