import { describe, expect, test } from 'bun:test';
import { symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { callMultiRepositoryTool, createMcpToolContext } from '../../src/cli/mcp/server';
import { repositoryFixture } from './repository-v81-fixture';

describe('v8.1 MCP repository routing', () => {
  test('routes each request by repoId and rejects ambiguous calls', async () => {
    const fixture = repositoryFixture();
    try {
      const ctx = createMcpToolContext({ controllerHome: fixture.controllerHome, profile: 'controller' });
      const ambiguous = await callMultiRepositoryTool(ctx, 'project_snapshot', {});
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.content[0].text).toContain('REPOSITORY_AMBIGUOUS');

      const statusA = await callMultiRepositoryTool(ctx, 'harness_status', { repo_id: fixture.repoA.repoId });
      const statusB = await callMultiRepositoryTool(ctx, 'harness_status', { repo_id: fixture.repoB.repoId });
      expect((statusA.structuredContent as { repoId: string }).repoId).toBe(fixture.repoA.repoId);
      expect((statusB.structuredContent as { repoId: string }).repoId).toBe(fixture.repoB.repoId);
      expect((statusA.structuredContent as { repoRoot: string }).repoRoot).toBe(fixture.repoA.canonicalRoot);
      expect((statusB.structuredContent as { repoRoot: string }).repoRoot).toBe(fixture.repoB.canonicalRoot);
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects a symlink that resolves into a different repository', async () => {
    const fixture = repositoryFixture();
    try {
      writeFileSync(join(fixture.repoB.canonicalRoot, 'outside.txt'), 'outside repository\n', 'utf-8');
      symlinkSync(
        join(fixture.repoB.canonicalRoot, 'outside.txt'),
        join(fixture.repoA.canonicalRoot, 'cross-repo-link.txt'),
      );
      const ctx = createMcpToolContext({ controllerHome: fixture.controllerHome, profile: 'controller' });
      const result = await callMultiRepositoryTool(ctx, 'read_repository_file', {
        repo_id: fixture.repoA.repoId,
        path: 'cross-repo-link.txt',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('path escapes repository root');
    } finally {
      fixture.cleanup();
    }
  });
});
