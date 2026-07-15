import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/cli/repositories/registry';
import {
  buildAppStoreConnectPluginManifest,
  executeAppStoreConnectPluginAction,
} from '../../src/runtime/plugins/app-store-connect-adapter';
import { submitAssistantPluginAction } from '../../src/runtime/plugins/store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_ASC_PRIVATE_KEY;
  delete process.env.REPO_HARNESS_ASC_PRIVATE_KEY_PATH;
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
});

function repoFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-asc-plugin-'));
  roots.push(repoRoot);
  mkdirSync(join(repoRoot, '.repo-harness/plugins'), { recursive: true });
  return repoRoot;
}

function fullFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-asc-full-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-asc-controller-'));
  roots.push(repoRoot, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  mkdirSync(join(repoRoot, '.repo-harness/plugins'), { recursive: true });
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'README.md'), '# t\n');
  const repository = registerRepository({ path: repoRoot, controllerHome });
  return { repoRoot, controllerHome, repository };
}

async function enableMock(repoRoot: string) {
  return executeAppStoreConnectPluginAction({
    controllerHome: repoRoot,
    repoId: 'repo_1',
    repoRoot,
    pluginId: 'app_store_connect',
    actionId: 'configure',
    requestId: 'cfg',
    args: { enabled: true, provider: 'mock', default_app_id: 'app-1' },
    origin: { surface: 'mcp', actor: 'test' },
  });
}

describe('app store connect plugin', () => {
  test('configure persists private key path without exposing key material or path in manifest', async () => {
    const repoRoot = repoFixture();
    const keyPath = join(repoRoot, 'AuthKey_ABC123DEFG.p8');
    writeFileSync(keyPath, 'not-a-real-key-for-auth-status-only\n', 'utf-8');

    const result = await executeAppStoreConnectPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo_1',
      repoRoot,
      pluginId: 'app_store_connect',
      actionId: 'configure',
      requestId: 'test',
      args: {
        enabled: true,
        provider: 'app-store-connect-api',
        issuer_id: '00000000-0000-0000-0000-000000000000',
        key_id: 'ABC123DEFG',
        private_key_path: keyPath,
      },
      origin: { surface: 'mcp', actor: 'test' },
    });

    expect(result.config).toMatchObject({ privateKeyPath: keyPath });
    expect(JSON.stringify(result)).not.toContain('not-a-real-key-for-auth-status-only');

    const manifest = buildAppStoreConnectPluginManifest(0, undefined, repoRoot);
    expect(manifest.health.ready).toBe(true);
    expect(manifest.health.details).toMatchObject({ issuerId: 'configured', keyId: 'configured' });
    expect(JSON.stringify(manifest)).not.toContain(keyPath);
    expect(JSON.stringify(manifest)).not.toContain('not-a-real-key-for-auth-status-only');
  });

  test('mock provider supports read, metadata preview, and gated testflight writes', async () => {
    const repoRoot = repoFixture();
    await enableMock(repoRoot);

    const auth = await executeAppStoreConnectPluginAction({
      controllerHome: repoRoot, repoId: 'r', repoRoot, pluginId: 'app_store_connect',
      actionId: 'auth_status', requestId: 'a1', args: {}, origin: { surface: 'mcp', actor: 'test' },
    });
    expect(auth.ready).toBe(true);

    const apps = await executeAppStoreConnectPluginAction({
      controllerHome: repoRoot, repoId: 'r', repoRoot, pluginId: 'app_store_connect',
      actionId: 'list_apps', requestId: 'a2', args: {}, origin: { surface: 'mcp', actor: 'test' },
    });
    expect(Array.isArray(apps.data)).toBe(true);

    const builds = await executeAppStoreConnectPluginAction({
      controllerHome: repoRoot, repoId: 'r', repoRoot, pluginId: 'app_store_connect',
      actionId: 'list_testflight_builds', requestId: 'a3', args: {}, origin: { surface: 'mcp', actor: 'test' },
    });
    expect(Array.isArray(builds.data)).toBe(true);
    expect((builds.data as Array<Record<string, unknown>>)[0]).toBeDefined();

    const preview = await executeAppStoreConnectPluginAction({
      controllerHome: repoRoot, repoId: 'r', repoRoot, pluginId: 'app_store_connect',
      actionId: 'preview_app_info_localization_update', requestId: 'a4',
      args: { localization_id: 'loc-1', name: 'New Name' },
      origin: { surface: 'mcp', actor: 'test' },
    });
    expect(preview.dryRun).toBe(true);

    const dryAssign = await executeAppStoreConnectPluginAction({
      controllerHome: repoRoot, repoId: 'r', repoRoot, pluginId: 'app_store_connect',
      actionId: 'assign_build_to_beta_group', requestId: 'a5',
      args: { build_id: 'b1', beta_group_id: 'g1', dry_run: true },
      origin: { surface: 'mcp', actor: 'test' },
    });
    expect(dryAssign.dryRun).toBe(true);
    expect(dryAssign.request).toBeDefined();
  });

  test('ordinary writes inherit host authorization at the submission boundary', async () => {
    const { repoRoot, controllerHome, repository } = fullFixture();
    await enableMock(repoRoot);
    const accepted = submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'app_store_connect',
      actionId: 'update_app_info_localization',
      requestId: 'asc-write-1',
      args: { localization_id: 'loc-1', name: 'X' },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(accepted.action.confirmation).toBe('authorization');
    expect(accepted.job.status).toBe('queued');
  });

  test('strong confirmation mismatch fails for production actions', async () => {
    const { repoRoot, controllerHome, repository } = fullFixture();
    await enableMock(repoRoot);
    expect(() => submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'app_store_connect',
      actionId: 'submit_beta_app_review',
      requestId: 'asc-beta-1',
      args: { build_id: 'b1' },
      confirmAuthorization: true,
      confirmationText: 'wrong-text',
      origin: { surface: 'local-ui', actor: 'test' },
    })).toThrow('PLUGIN_CONFIRMATION_TEXT_REQUIRED');

    const accepted = submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'app_store_connect',
      actionId: 'submit_beta_app_review',
      requestId: 'asc-beta-2',
      args: { build_id: 'b1', dry_run: true },
      confirmAuthorization: true,
      confirmationText: 'submit-beta-review',
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(accepted.action.requiredConfirmationText).toBe('submit-beta-review');
  });

  test('dry_run metadata update does not require remote write side effects beyond payload', async () => {
    const repoRoot = repoFixture();
    await enableMock(repoRoot);
    const result = await executeAppStoreConnectPluginAction({
      controllerHome: repoRoot, repoId: 'r', repoRoot, pluginId: 'app_store_connect',
      actionId: 'update_app_store_version_metadata', requestId: 'dry',
      args: { localization_id: 'loc-1', whats_new: 'Fixes', dry_run: true },
      origin: { surface: 'mcp', actor: 'test' },
    });
    expect(result.dryRun).toBe(true);
    expect(result.request).toMatchObject({ method: 'PATCH' });
  });
});
