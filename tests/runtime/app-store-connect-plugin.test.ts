import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildAppStoreConnectPluginManifest, executeAppStoreConnectPluginAction } from '../../src/runtime/plugins/app-store-connect-adapter';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_ASC_PRIVATE_KEY;
  delete process.env.REPO_HARNESS_ASC_PRIVATE_KEY_PATH;
});

function repoFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-asc-plugin-'));
  roots.push(repoRoot);
  mkdirSync(join(repoRoot, '.repo-harness/plugins'), { recursive: true });
  return repoRoot;
}

describe('app store connect plugin', () => {
  test('configure persists private key path without exposing key material or path in manifest', async () => {
    const repoRoot = repoFixture();
    const keyPath = join(repoRoot, 'AuthKey_ABC123DEFG.p8');
    writeFileSync(keyPath, 'not-a-real-key-for-auth-status-only\n', 'utf-8');

    const result = await executeAppStoreConnectPluginAction({
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
      origin: { surface: 'test', actor: 'test' },
    });

    expect(result.config).toMatchObject({ privateKeyPath: keyPath });
    expect(JSON.stringify(result)).not.toContain('not-a-real-key-for-auth-status-only');

    const manifest = buildAppStoreConnectPluginManifest(0, undefined, repoRoot);
    expect(manifest.health.ready).toBe(true);
    expect(manifest.health.details).toMatchObject({ issuerId: 'configured', keyId: 'configured' });
    expect(JSON.stringify(manifest)).not.toContain(keyPath);
    expect(JSON.stringify(manifest)).not.toContain('not-a-real-key-for-auth-status-only');
  });
});
