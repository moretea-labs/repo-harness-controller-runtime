import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/cli/repositories/registry';
import { AssistantPluginError } from '../../src/runtime/plugins/errors';
import {
  buildBrowserPluginManifest,
  executeBrowserPluginAction,
  resetBrowserPluginRuntimeHooksForTest,
  setBrowserPluginRuntimeHooksForTest,
} from '../../src/runtime/plugins/browser-adapter';
import { submitAssistantPluginAction } from '../../src/runtime/plugins/store';

const roots: string[] = [];

afterEach(() => {
  resetBrowserPluginRuntimeHooksForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
});

function repoFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-browser-plugin-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-browser-plugin-controller-'));
  roots.push(repoRoot, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  mkdirSync(join(repoRoot, 'tasks'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai/harness'), { recursive: true });
  mkdirSync(join(repoRoot, '.repo-harness/plugins'), { recursive: true });
  writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 1;\n');
  writeFileSync(join(repoRoot, 'tasks/current.md'), '# Current\n');
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  const repository = registerRepository({ path: repoRoot, controllerHome });
  return { repoRoot, controllerHome, repository };
}

function writeBrowserConfig(repoRoot: string, value: Record<string, unknown>) {
  writeFileSync(join(repoRoot, '.repo-harness/plugins/browser.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function mockPlaywright(options: { finalUrl?: string; title?: string } = {}) {
  let currentUrl = 'https://example.com/';
  let currentTitle = options.title ?? 'Example';

  const page = {
    async goto(url: string) {
      currentUrl = url;
    },
    async title() {
      return currentTitle;
    },
    url() {
      return currentUrl;
    },
    async evaluate<T>() {
      return 'Example page text' as T;
    },
    async screenshot(args: Record<string, unknown>) {
      const path = typeof args.path === 'string' ? args.path : undefined;
      if (path) writeFileSync(path, 'png');
      return Buffer.from('png');
    },
    async click() {
      currentUrl = options.finalUrl ?? currentUrl;
      currentTitle = options.title ?? 'Clicked Example';
    },
    async fill() {
      currentTitle = options.title ?? 'Typed Example';
    },
    async press() {
      currentTitle = options.title ?? 'Pressed Example';
    },
    async waitForSelector() {
      currentTitle = options.title ?? 'Waiting Example';
      return {};
    },
  };

  return {
    chromium: {
      async launchPersistentContext() {
        return {
          pages() {
            return [page];
          },
          async newPage() {
            return page;
          },
          async close() {},
          async route() {},
        };
      },
    },
  } as never;
}

describe('browser plugin', () => {
  test('manifest keeps readonly actions readonly and only exposes the supported interaction surface', () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
    });

    const manifest = buildBrowserPluginManifest(0, undefined, repoRoot);
    const actions = Object.fromEntries(manifest.actions.map((action) => [action.actionId, action]));

    expect(manifest.pluginId).toBe('browser');
    expect(Object.keys(actions)).toEqual([
      'configure',
      'open_page',
      'get_text',
      'screenshot',
      'click',
      'type',
      'press',
      'wait_for_selector',
      'close_page',
    ]);

    for (const actionId of ['open_page', 'get_text', 'screenshot', 'close_page']) {
      expect(actions[actionId]?.readOnly).toBe(true);
      expect(actions[actionId]?.risk).toBe('readonly');
      expect(actions[actionId]?.confirmation).toBe('none');
    }

    expect(actions.click?.risk).toBe('remote_write');
    expect(actions.click?.confirmation).toBe('authorization');
    expect(actions.type?.risk).toBe('remote_write');
    expect(actions.type?.confirmation).toBe('authorization');
    expect(actions.press?.risk).toBe('remote_write');
    expect(actions.press?.confirmation).toBe('authorization');
    expect(actions.wait_for_selector?.risk).toBe('workspace_write');
    expect(actions.wait_for_selector?.confirmation).toBe('authorization');

    for (const unsupported of ['submit', 'delete', 'publish', 'payment', 'send', 'download', 'upload']) {
      expect(Object.keys(actions).some((actionId) => actionId.includes(unsupported))).toBe(false);
    }
  });

  test('interaction actions require explicit authorization before job submission', () => {
    const { repoRoot, controllerHome, repository } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
    });

    expect(() => submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'browser',
      actionId: 'click',
      requestId: 'browser-click-1',
      args: { url: 'https://example.com/', selector: '#cta' },
      origin: { surface: 'local-ui', actor: 'test' },
    })).toThrow('PLUGIN_CONFIRMATION_REQUIRED');

    const accepted = submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'browser',
      actionId: 'click',
      requestId: 'browser-click-1',
      args: { url: 'https://example.com/', selector: '#cta' },
      confirmAuthorization: true,
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(accepted.action.confirmation).toBe('authorization');
    expect(accepted.action.risk).toBe('remote_write');
  });

  test('returns a clear dependency error when playwright is missing', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => false,
      loadPlaywright: () => {
        throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', 'Browser plugin requires playwright. Run bun install before using browser actions.', {
          retryable: false,
        });
      },
    });

    const manifest = buildBrowserPluginManifest(0, undefined, repoRoot);
    expect(manifest.health.state).toBe('error');
    expect(manifest.health.errors[0]).toContain('Browser plugin requires playwright');

    await expect(executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'open_page',
      requestId: 'browser-open-missing-dep',
      args: { url: 'https://example.com/' },
      origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toThrow('PLUGIN_DEPENDENCY_MISSING');
  });

  test('click returns url, title, summary, and a saved screenshot without bypassing allowed domains', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => mockPlaywright({ title: 'Clicked Example' }),
    });

    const result = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'click',
      requestId: 'browser-click-success',
      args: { url: 'https://example.com/', selector: '#cta', post_action_wait_ms: 1 },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    expect(result.url).toBe('https://example.com/');
    expect(result.title).toBe('Clicked Example');
    expect((result.action as Record<string, unknown>).summary).toBe('Clicked #cta.');
    const screenshot = result.screenshot as Record<string, unknown>;
    expect(typeof screenshot.path).toBe('string');
    expect(readFileSync(String(screenshot.path), 'utf-8')).toBe('png');
    const session = result.session as Record<string, unknown>;
    expect(String(session.sessionId)).toContain('browser_');
  });

  test('blocks interaction results that leave the allowed domain set', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => mockPlaywright({ finalUrl: 'https://evil.test/' }),
    });

    await expect(executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'click',
      requestId: 'browser-click-blocked-domain',
      args: { url: 'https://example.com/', selector: '#cta', post_action_wait_ms: 1 },
      origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toThrow('PLUGIN_POLICY_BLOCKED');
  });
});
