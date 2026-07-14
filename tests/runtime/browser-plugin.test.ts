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
import {
  clearAssistantPluginManifestCacheForTest,
  getAssistantPluginManifest,
  submitAssistantPluginAction,
} from '../../src/runtime/plugins/store';

const roots: string[] = [];

afterEach(() => {
  resetBrowserPluginRuntimeHooksForTest();
  clearAssistantPluginManifestCacheForTest();
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

function mockPlaywright(options: { finalUrl?: string; title?: string; routeUrl?: string } = {}) {
  let currentUrl = 'https://example.com/';
  let currentTitle = options.title ?? 'Example';
  const routeDecisions: string[] = [];
  const launches: Array<{ userDataDir: string; options: Record<string, unknown> }> = [];

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
      async launchPersistentContext(userDataDir: string, launchOptions: Record<string, unknown>) {
        launches.push({ userDataDir, options: launchOptions });
        return {
          pages() {
            return [page];
          },
          async newPage() {
            return page;
          },
          async close() {},
          async route(_pattern: string, handler: (route: { request(): { url(): string }; continue(): Promise<void>; abort(code?: string): Promise<void> }) => Promise<void> | void) {
            if (!options.routeUrl) return;
            await handler({
              request: () => ({ url: () => options.routeUrl ?? '' }),
              continue: async () => { routeDecisions.push('continue'); },
              abort: async (code?: string) => { routeDecisions.push(`abort:${code ?? ''}`); },
            });
          },
        };
      },
    },
    routeDecisions,
    launches,
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
    expect(Object.keys(actions)).toEqual(expect.arrayContaining([
      'configure',
      'create_session',
      'list_sessions',
      'close_session',
      'open_page',
      'navigate',
      'get_text',
      'get_html',
      'query_selector',
      'screenshot',
      'extract_links',
      'click',
      'fill',
      'type',
      'press',
      'wait_for_selector',
      'close_page',
      'await_file_transfer',
    ]));

    for (const actionId of ['open_page', 'get_text', 'screenshot', 'list_sessions', 'extract_links']) {
      expect(actions[actionId]?.readOnly).toBe(true);
      expect(actions[actionId]?.risk).toBe('readonly');
      expect(actions[actionId]?.confirmation).toBe('none');
    }

    for (const actionId of ['create_session', 'close_session', 'close_page']) {
      expect(actions[actionId]?.readOnly).toBe(false);
      expect(actions[actionId]?.risk).toBe('workspace_write');
      expect(actions[actionId]?.confirmation).toBe('authorization');
      expect(actions[actionId]?.resourceClaims).toEqual(expect.arrayContaining([
        { resource: 'repo-state', mode: 'write' },
      ]));
    }

    expect(actions.click?.risk).toBe('remote_write');
    expect(actions.click?.confirmation).toBe('authorization');
    expect(actions.type?.risk).toBe('remote_write');
    expect(actions.type?.confirmation).toBe('authorization');
    expect(actions.fill?.risk).toBe('remote_write');
    expect(actions.press?.risk).toBe('remote_write');
    expect(actions.press?.confirmation).toBe('authorization');
    expect(actions.wait_for_selector?.risk).toBe('workspace_write');
    expect(actions.wait_for_selector?.confirmation).toBe('authorization');

    for (const unsupported of ['submit', 'delete', 'publish', 'payment', 'send']) {
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

  test('reuses a hot cached manifest instead of probing browser readiness on every read', () => {
    const { repoRoot, controllerHome, repository } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

    let moduleChecks = 0;
    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => {
        moduleChecks += 1;
        return true;
      },
    });

    const first = getAssistantPluginManifest(controllerHome, repository, 'browser');
    const second = getAssistantPluginManifest(controllerHome, repository, 'browser');

    expect(first.health.state).toBe('ready');
    expect(second.health.state).toBe('ready');
    expect(moduleChecks).toBe(1);
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

  test('requires explicit custom profile mode before using a configured profile path', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

    await expect(executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'configure',
      requestId: 'browser-config-reject-implicit-profile',
      args: { profile_dir: '/Users/example/Library/Application Support/Google/Chrome' },
      origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toThrow('profile_mode must be set to custom before profile_dir can be used');
  });

  test('custom profile mode can launch visible Chrome against an explicit user profile selection', async () => {
    const { repoRoot } = repoFixture();
    const chromeRoot = join(repoRoot, 'Chrome/User Data');
    const chromeProfile = join(chromeRoot, 'Profile 1');
    mkdirSync(chromeProfile, { recursive: true });
    writeFileSync(join(chromeRoot, 'Local State'), '{}\n');
    writeFileSync(join(chromeProfile, 'Preferences'), '{}\n');
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      profileMode: 'custom',
      profileDir: chromeProfile,
      browserChannel: 'chrome',
      allowedDomains: ['example.com'],
    });
    const runtime = mockPlaywright() as unknown as { launches: Array<{ userDataDir: string; options: Record<string, unknown> }> };

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => runtime as never,
    });

    await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'open_page',
      requestId: 'browser-open-custom-profile',
      args: { url: 'https://example.com/' },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    expect(runtime.launches).toHaveLength(1);
    expect(runtime.launches[0]?.userDataDir).toBe(chromeRoot);
    expect(runtime.launches[0]?.options).toMatchObject({
      headless: false,
      channel: 'chrome',
      args: ['--profile-directory=Profile 1'],
    });
  });

  test('wait_for_selector keeps authorization despite being read-only', () => {
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
      actionId: 'wait_for_selector',
      requestId: 'browser-wait-missing-confirm',
      args: { url: 'https://example.com/', selector: '#ready' },
      origin: { surface: 'local-ui', actor: 'test' },
    })).toThrow('PLUGIN_CONFIRMATION_REQUIRED');

    const accepted = submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'browser',
      actionId: 'wait_for_selector',
      requestId: 'browser-wait-confirmed',
      args: { url: 'https://example.com/', selector: '#ready' },
      confirmAuthorization: true,
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(accepted.action.readOnly).toBe(true);
    expect(accepted.action.risk).toBe('workspace_write');
    expect(accepted.action.confirmation).toBe('authorization');
  });

  test('rejects mismatched url when a session_id is supplied', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });
    mkdirSync(join(repoRoot, '.repo-harness/browser/sessions'), { recursive: true });
    writeFileSync(join(repoRoot, '.repo-harness/browser/sessions/browser_saved.json'), JSON.stringify({
      schemaVersion: 1,
      sessionId: 'browser_saved',
      url: 'https://example.com/',
      title: 'Saved',
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
    }));

    await expect(executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'get_text',
      requestId: 'browser-session-url-mismatch',
      args: { session_id: 'browser_saved', url: 'https://evil.test/' },
      origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toThrow('url does not match the saved session');
  });

  test('route guard aborts requests outside allowed domains', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });
    const runtime = mockPlaywright({ routeUrl: 'https://tracker.evil/pixel' }) as unknown as { routeDecisions: string[] };

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => runtime as never,
    });

    await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'open_page',
      requestId: 'browser-route-guard',
      args: { url: 'https://example.com/' },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    expect(runtime.routeDecisions).toEqual(['abort:blockedbyclient']);
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

  test('supports session reuse, fill, selector extraction, and diagnostics capture', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => mockPlaywright({ title: 'Extracted' }),
    });

    const opened = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'create_session',
      requestId: 'browser-session-create',
      args: { url: 'https://example.com/' },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    const sessionId = String((opened.session as Record<string, unknown>).sessionId);

    const listed = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'list_sessions',
      requestId: 'browser-session-list',
      args: {},
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect((listed.sessions as Array<Record<string, unknown>>).some((entry) => entry.sessionId === sessionId)).toBe(true);

    const filled = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'fill',
      requestId: 'browser-fill',
      args: { session_id: sessionId, selector: '#email', text: 'user@example.com', post_action_wait_ms: 1 },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect((filled.action as Record<string, unknown>).actionId).toBe('fill');
    expect(filled.screenshot).toBeDefined();

    const extracted = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'extract_links',
      requestId: 'browser-extract-links',
      args: { session_id: sessionId },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(extracted.actionId).toBe('extract_links');

    const consoleErrors = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'get_console_errors',
      requestId: 'browser-console',
      args: { session_id: sessionId },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(Array.isArray(consoleErrors.consoleErrors)).toBe(true);

    const closed = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'close_session',
      requestId: 'browser-session-close',
      args: { session_id: sessionId },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(closed.closed).toBe(true);
  });

  test('denies open_page outside allowed domains before launch', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });
    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => mockPlaywright(),
    });
    await expect(executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'open_page',
      requestId: 'browser-deny-domain',
      args: { url: 'https://evil.test/' },
      origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toThrow('PLUGIN_POLICY_BLOCKED');
  });
});
