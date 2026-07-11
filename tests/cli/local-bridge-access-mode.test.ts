import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { localBridgeDashboardHtml } from '../../src/cli/local-bridge/dashboard';
import {
  buildCommandCenter,
  getConsoleAccessPolicy,
  setConsoleAccessPolicy,
  startConsoleWork,
  type ConsoleFacadeContext,
} from '../../src/cli/local-bridge/facade-api';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { getWorkContract } from '../../src/runtime/control-plane/facade';

const roots: string[] = [];

function fixture(): ConsoleFacadeContext {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-console-access-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-console-access-home-'));
  roots.push(repoRoot, controllerHome);
  Bun.spawnSync(['git', 'init', '-b', 'main'], { cwd: repoRoot });
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'console access', repoIdOverride: 'repo-console-access' });
  return { controllerHome, repository };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local bridge access mode', () => {
  test('dashboard exposes Request and Full Access controls', () => {
    const html = localBridgeDashboardHtml();
    expect(html).toContain('权限等级');
    expect(html).toContain('Request');
    expect(html).toContain('Full Access');
    expect(html).toContain('/api/console/access-policy');
  });

  test('console defaults to Full Access and access changes never require reconnect', () => {
    const ctx = fixture();
    const initial = getConsoleAccessPolicy(ctx);
    expect(initial.policy.mode).toBe('full_access');
    expect(initial.access.reconnectRequired).toBe(false);
    expect(initial.access.schemaRefreshRequired).toBe(false);
    expect(initial.access.toolSchemaStable).toBe(true);
    const request = setConsoleAccessPolicy(ctx, { mode: 'request', confirmAuthorization: true });
    expect(request.policy.mode).toBe('request');
    expect(request.access.reconnectRequired).toBe(false);
    const full = setConsoleAccessPolicy(ctx, { mode: 'full_access', confirmAuthorization: true });
    expect(full.policy.mode).toBe('full_access');
    expect(full.access.toolGroups).toEqual(request.access.toolGroups);
  });

  test('console task captures selected access mode', () => {
    const ctx = fixture();
    const result = startConsoleWork(ctx, {
      objective: 'Update four local files',
      expectedFiles: 4,
      scopeClear: true,
      accessMode: 'full_access',
      requiresApproval: true,
    });
    expect(result.status).toBe('ok');
    const workId = String((result.data.work as { workId?: string }).workId ?? '');
    expect(getWorkContract({ controllerHome: ctx.controllerHome, repoId: ctx.repository.repoId }, workId)?.constraints.accessMode).toBe('full_access');
  });

  test('command center reports the repository default', async () => {
    const ctx = fixture();
    setConsoleAccessPolicy(ctx, { mode: 'full_access', confirmAuthorization: true });
    const commandCenter = await buildCommandCenter(ctx, []);
    expect(commandCenter.accessMode).toBe('full_access');
    expect(commandCenter.accessModeLabel).toBe('Full Access');
  });
});
