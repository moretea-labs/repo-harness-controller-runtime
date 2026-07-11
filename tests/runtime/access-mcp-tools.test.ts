import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { callAccessTool } from '../../src/cli/mcp/access-tools';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { exposedControllerToolDefinitions } from '../../src/cli/mcp/toolset';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';

const roots: string[] = [];

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-access-mcp-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-access-mcp-home-'));
  roots.push(repoRoot, controllerHome);
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'README.md'), '# fixture\n');
  spawnSync('git', ['add', 'README.md'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  ensureControllerHome(controllerHome);
  const repository = registerRepository({
    path: repoRoot,
    controllerHome,
    displayName: 'permission fixture',
    repoIdOverride: 'repo-permissions',
  });
  const ctx = {
    repoRoot,
    controllerHome,
    policy: getMcpPolicy('controller', { repoRoot }),
    toolset: 'core' as const,
    enableChatgptBrowser: false,
    explicitRepository: repository,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
  return { ctx, repository };
}

function payload(result: ReturnType<typeof callAccessTool>): Record<string, unknown> {
  expect(result).toBeTruthy();
  return result!.structuredContent as Record<string, unknown>;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository access MCP tools', () => {
  test('core toolset exposes get and set tools', () => {
    const { ctx } = fixture();
    const names = exposedControllerToolDefinitions(ctx).map((tool) => tool.name);
    expect(names).toContain('repository_access_get');
    expect(names).toContain('repository_access_set');
  });

  test('get returns Request by default', () => {
    const { ctx, repository } = fixture();
    const value = payload(callAccessTool(ctx, 'repository_access_get', { repo_id: repository.repoId }));
    expect(value).toMatchObject({
      policy: { mode: 'request', updatedBy: 'system' },
      descriptor: { shortLabel: 'Request' },
      scope: 'repository',
      storage: 'controllerHome',
    });
  });

  test('Full Access requires explicit strong confirmation', () => {
    const { ctx, repository } = fixture();
    const missing = callAccessTool(ctx, 'repository_access_set', {
      repo_id: repository.repoId,
      mode: 'full_access',
      confirm_authorization: true,
    });
    expect(missing?.isError).toBe(true);
    expect(payload(missing)).toMatchObject({
      error: { code: 'FULL_ACCESS_STRONG_CONFIRMATION_REQUIRED' },
    });

    const enabled = callAccessTool(ctx, 'repository_access_set', {
      repo_id: repository.repoId,
      mode: 'full_access',
      confirm_authorization: true,
      confirmation_text: 'enable-full-access',
    });
    expect(enabled?.isError).not.toBe(true);
    expect(payload(enabled)).toMatchObject({
      policy: { mode: 'full_access', updatedBy: 'user' },
      descriptor: { shortLabel: 'Full Access' },
    });

    expect(payload(callAccessTool(ctx, 'repository_access_get', { repo_id: repository.repoId }))).toMatchObject({
      policy: { mode: 'full_access' },
    });
  });

  test('downgrading to Request remains an explicit write action', () => {
    const { ctx, repository } = fixture();
    const denied = callAccessTool(ctx, 'repository_access_set', {
      repo_id: repository.repoId,
      mode: 'request',
    });
    expect(denied?.isError).toBe(true);
    expect(payload(denied)).toMatchObject({
      error: { code: 'ACCESS_MODE_AUTHORIZATION_REQUIRED' },
    });
  });
});
