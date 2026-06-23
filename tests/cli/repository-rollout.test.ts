import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runRepositoryRollout } from '../../src/cli/repositories/rollout';
import { repositoryFixture } from './repository-v81-fixture';

describe('repository rollout', () => {
  test('rolls out all enabled repositories and restarts only repos with MCP config', async () => {
    const fixture = repositoryFixture();
    const adopted: string[] = [];
    const restarted: string[] = [];
    try {
      mkdirSync(join(fixture.repoA.canonicalRoot, '.repo-harness'), { recursive: true });
      writeFileSync(
        join(fixture.repoA.canonicalRoot, '.repo-harness', 'mcp.local.json'),
        JSON.stringify({ chatgpt: { serverName: 'repo-a' } }),
        'utf-8',
      );

      const result = await runRepositoryRollout({
        controllerHome: fixture.controllerHome,
      }, {
        refresh: (repoId) => repoId === fixture.repoA.repoId ? fixture.repoA : fixture.repoB,
        adopt: (repoRoot) => {
          adopted.push(repoRoot);
          return { exitCode: 0, repoRoot, steps: [], lines: ['ok'] };
        },
        restart: async (opts) => {
          restarted.push(String(opts.repo));
          return { status: 'ok' };
        },
      });

      expect(result.ok).toBe(true);
      expect(result.total).toBe(2);
      expect(adopted).toEqual([
        fixture.repoA.canonicalRoot,
        fixture.repoB.canonicalRoot,
      ]);
      expect(restarted).toEqual([fixture.repoA.canonicalRoot]);
      expect(result.repositories[0]?.steps.some((step) => step.kind === 'restart' && step.status === 'ok')).toBe(true);
      expect(result.repositories[1]?.steps.some((step) => step.kind === 'restart' && step.status === 'skipped')).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('supports dry-run without adopting or restarting', async () => {
    const fixture = repositoryFixture();
    try {
      const result = await runRepositoryRollout({
        controllerHome: fixture.controllerHome,
        dryRun: true,
      }, {
        adopt: () => {
          throw new Error('adopt should not run during dry-run');
        },
        restart: async () => {
          throw new Error('restart should not run during dry-run');
        },
      });

      expect(result.ok).toBe(true);
      expect(result.total).toBe(2);
      expect(result.repositories.every((entry) => entry.steps.every((step) => step.status === 'skipped'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
