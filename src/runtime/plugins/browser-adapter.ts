import { createHash, randomUUID } from 'crypto';
import { createRequire } from 'module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
  AssistantPluginHealth,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError, toAssistantPluginError } from './errors';

const BROWSER_PLUGIN_ID = 'browser';
const CONFIG_ROOT = '.repo-harness/plugins';
const STATE_ROOT = '.repo-harness/browser';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TEXT_CHARS = 20_000;
const DEFAULT_POST_ACTION_WAIT_MS = 750;

type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle';
type WaitForSelectorState = 'attached' | 'detached' | 'visible' | 'hidden';

interface BrowserPluginConfig {
  schemaVersion: 1;
  enabled: boolean;
  provider: 'playwright';
  profileDir?: string;
  defaultTimeoutMs?: number;
  allowedDomains?: string[];
}

interface BrowserSessionState {
  schemaVersion: 1;
  sessionId: string;
  url: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

interface BrowserActionTarget {
  sessionId: string;
  url: string;
  existingSession?: BrowserSessionState;
}

interface BrowserActionScreenshot {
  path: string;
  bytes: number;
}

type BrowserContextLike = {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  route(pattern: string, handler: (route: RouteLike) => Promise<void> | void): Promise<void>;
};

type PageLike = {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  evaluate<T>(expression: string): Promise<T>;
  screenshot(options: Record<string, unknown>): Promise<Buffer>;
  click(selector: string, options?: Record<string, unknown>): Promise<void>;
  fill(selector: string, value: string, options?: Record<string, unknown>): Promise<void>;
  press(selector: string, key: string, options?: Record<string, unknown>): Promise<void>;
  waitForSelector(selector: string, options?: Record<string, unknown>): Promise<unknown>;
};

type RequestLike = { url(): string };
type RouteLike = {
  request(): RequestLike;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
};

type PlaywrightRuntime = {
  chromium: {
    launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<BrowserContextLike>;
  };
};

interface BrowserPluginRuntimeHooks {
  now(): string;
  moduleAvailable(name: string): boolean;
  loadPlaywright(): PlaywrightRuntime;
}

const defaultRuntimeHooks: BrowserPluginRuntimeHooks = {
  now: () => new Date().toISOString(),
  moduleAvailable: (name: string) => {
    try {
      createRequire(import.meta.url).resolve(name);
      return true;
    } catch {
      return false;
    }
  },
  loadPlaywright: () => {
    try {
      return createRequire(import.meta.url)('playwright') as PlaywrightRuntime;
    } catch {
      throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', 'Browser plugin requires playwright. Run bun install before using browser actions.', {
        retryable: false,
      });
    }
  },
};

let runtimeHooks: BrowserPluginRuntimeHooks = { ...defaultRuntimeHooks };

export function setBrowserPluginRuntimeHooksForTest(hooks: Partial<BrowserPluginRuntimeHooks>): void {
  runtimeHooks = { ...defaultRuntimeHooks, ...hooks };
}

export function resetBrowserPluginRuntimeHooksForTest(): void {
  runtimeHooks = { ...defaultRuntimeHooks };
}

function now(): string {
  return runtimeHooks.now();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function configPath(repoRoot: string): string {
  return join(repoRoot, CONFIG_ROOT, 'browser.json');
}

function stateDir(repoRoot: string, name: 'sessions' | 'screenshots' | 'profiles'): string {
  return join(repoRoot, STATE_ROOT, name);
}

function defaultProfileDir(repoRoot: string): string {
  return join(stateDir(repoRoot, 'profiles'), 'default');
}

function normalizeConfig(raw: Partial<BrowserPluginConfig>): BrowserPluginConfig {
  return {
    schemaVersion: 1,
    enabled: raw.enabled === true,
    provider: 'playwright',
    profileDir: stringValue(raw.profileDir),
    defaultTimeoutMs: typeof raw.defaultTimeoutMs === 'number' ? positiveNumber(raw.defaultTimeoutMs, DEFAULT_TIMEOUT_MS) : undefined,
    allowedDomains: stringArray(raw.allowedDomains),
  };
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function loadConfig(repoRoot: string): BrowserPluginConfig {
  return normalizeConfig(readJson<Partial<BrowserPluginConfig>>(configPath(repoRoot)) ?? {});
}

function saveConfig(repoRoot: string, patch: Partial<BrowserPluginConfig>): BrowserPluginConfig {
  const next = normalizeConfig({ ...loadConfig(repoRoot), ...patch });
  writeJson(configPath(repoRoot), next);
  return next;
}

function sessionPath(repoRoot: string, sessionId: string): string {
  return join(stateDir(repoRoot, 'sessions'), `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

function saveSession(repoRoot: string, session: BrowserSessionState): void {
  writeJson(sessionPath(repoRoot, session.sessionId), session);
}

function loadSession(repoRoot: string, sessionId: string): BrowserSessionState {
  const state = readJson<BrowserSessionState>(sessionPath(repoRoot, sessionId));
  if (!state) {
    throw new AssistantPluginError('PLUGIN_SESSION_NOT_FOUND', `Browser session not found: ${sessionId}`, { retryable: false });
  }
  return state;
}

function normalizedUrl(value: unknown): string {
  const raw = stringValue(value);
  if (!raw) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'url is required.', { retryable: false });
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'url must be absolute.', { retryable: false });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Only http and https URLs are supported.', { retryable: false });
  }
  return parsed.toString();
}

function isRemoteHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isUrlAllowed(url: string, config: BrowserPluginConfig): boolean {
  if (!config.allowedDomains || config.allowedDomains.length === 0) return true;
  if (!isRemoteHttpUrl(url)) return true;
  const hostname = new URL(url).hostname.toLowerCase();
  return config.allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function assertUrlAllowed(url: string, config: BrowserPluginConfig): void {
  if (isUrlAllowed(url, config)) return;
  const hostname = new URL(url).hostname.toLowerCase();
  throw new AssistantPluginError('PLUGIN_POLICY_BLOCKED', `Domain is not allowed: ${hostname}`, { retryable: false });
}

function waitUntil(value: unknown): WaitUntil {
  return value === 'load' || value === 'networkidle' || value === 'domcontentloaded' ? value : 'domcontentloaded';
}

function waitForSelectorState(value: unknown): WaitForSelectorState {
  return value === 'attached' || value === 'detached' || value === 'hidden' || value === 'visible' ? value : 'visible';
}

function truncateText(value: string, maxChars: number): Record<string, unknown> {
  const clean = value.replace(/[\t\r ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return {
    text: clean.slice(0, maxChars),
    truncated: clean.length > maxChars,
    charCount: clean.length,
  };
}

function sessionIdFor(url: string): string {
  const digest = createHash('sha256')
    .update(`${Date.now()}:${randomUUID()}:${url}`)
    .digest('hex')
    .slice(0, 16);
  return `browser_${digest}`;
}

function requiredString(value: unknown, field: string): string {
  const normalized = stringValue(value);
  if (!normalized) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${field} is required.`, { retryable: false });
  }
  return normalized;
}

function scriptText(selector?: string): string {
  if (!selector) {
    return 'document.body ? document.body.innerText : (document.documentElement ? document.documentElement.textContent : "")';
  }
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || el.textContent || '') : ''; })()`;
}

function resolveActionTarget(repoRoot: string, args: Record<string, unknown>): BrowserActionTarget {
  const directUrl = stringValue(args.url);
  const providedSessionId = stringValue(args.session_id);
  if (!directUrl && !providedSessionId) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Provide either url or session_id.', { retryable: false });
  }
  if (providedSessionId) {
    const existingSession = loadSession(repoRoot, providedSessionId);
    const sessionUrl = normalizedUrl(existingSession.url);
    if (directUrl) {
      const explicitUrl = normalizedUrl(directUrl);
      if (explicitUrl !== sessionUrl) {
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'url does not match the saved session.', { retryable: false });
      }
    }
    return { sessionId: providedSessionId, url: sessionUrl, existingSession };
  }
  const url = normalizedUrl(directUrl);
  return { sessionId: sessionIdFor(url), url };
}

function sessionFromPage(target: BrowserActionTarget, pageUrl: string, title: string): BrowserSessionState {
  return {
    schemaVersion: 1,
    sessionId: target.sessionId,
    url: pageUrl,
    title,
    createdAt: target.existingSession?.createdAt ?? now(),
    updatedAt: now(),
  };
}

function screenshotFilePath(repoRoot: string, actionId: string, sessionId: string, url: string): string {
  const screenshotDir = stateDir(repoRoot, 'screenshots');
  mkdirSync(screenshotDir, { recursive: true });
  const digest = createHash('sha256').update(url).digest('hex').slice(0, 10);
  const actionLabel = actionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const sessionLabel = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(screenshotDir, `${Date.now()}-${actionLabel}-${sessionLabel}-${digest}.png`);
}

async function captureActionScreenshot(page: PageLike, repoRoot: string, actionId: string, sessionId: string, url: string): Promise<BrowserActionScreenshot | undefined> {
  const path = screenshotFilePath(repoRoot, actionId, sessionId, url);
  const bytes = (await page.screenshot({ path, fullPage: true })).length;
  return { path, bytes };
}

function responseWithWarnings(base: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  return warnings.length > 0 ? { ...base, warnings } : base;
}

function interactionResult(
  actionId: string,
  session: BrowserSessionState,
  summary: string,
  screenshot: BrowserActionScreenshot | undefined,
  warnings: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return responseWithWarnings({
    provider: 'playwright',
    session,
    url: session.url,
    title: session.title,
    action: {
      actionId,
      summary,
      ...extra,
    },
    ...(screenshot ? { screenshot } : {}),
  }, warnings);
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyDomainGuard(context: BrowserContextLike, config: BrowserPluginConfig): Promise<void> {
  if (!config.allowedDomains || config.allowedDomains.length === 0) return;
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (isUrlAllowed(url, config)) {
      await route.continue();
      return;
    }
    await route.abort('blockedbyclient');
  });
}

async function withPage<T>(
  repoRoot: string,
  config: BrowserPluginConfig,
  url: string,
  args: Record<string, unknown>,
  run: (page: PageLike) => Promise<T>,
): Promise<T> {
  assertUrlAllowed(url, config);
  const profileDir = resolve(config.profileDir ?? defaultProfileDir(repoRoot));
  mkdirSync(profileDir, { recursive: true });
  const context = await runtimeHooks.loadPlaywright().chromium.launchPersistentContext(profileDir, {
    headless: false,
    acceptDownloads: false,
    viewport: { width: 1280, height: 900 },
  });
  try {
    await applyDomainGuard(context, config);
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(url, {
      waitUntil: waitUntil(args.wait_until),
      timeout: positiveNumber(args.timeout_ms, config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return await run(page);
  } finally {
    await context.close();
  }
}

async function extractText(page: PageLike, selector: string | undefined, maxChars: number): Promise<Record<string, unknown>> {
  const raw = await page.evaluate<string>(scriptText(selector));
  return truncateText(raw, maxChars);
}

async function finalizeInteractiveAction(
  repoRoot: string,
  config: BrowserPluginConfig,
  page: PageLike,
  target: BrowserActionTarget,
  actionId: string,
  summary: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const warnings: string[] = [];
  const pageUrl = normalizedUrl(page.url());
  assertUrlAllowed(pageUrl, config);
  const title = await page.title();
  const session = sessionFromPage(target, pageUrl, title);
  saveSession(repoRoot, session);
  let screenshot: BrowserActionScreenshot | undefined;
  try {
    screenshot = await captureActionScreenshot(page, repoRoot, actionId, session.sessionId, session.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Screenshot capture failed: ${message}`);
  }
  return interactionResult(actionId, session, summary, screenshot, warnings, extra);
}

function permissions(ready: boolean): AssistantPluginPermissionScope[] {
  return [
    {
      scope: 'browser.read',
      mode: 'read',
      description: 'Open pages, extract text, and capture screenshots.',
      granted: ready,
      required: true,
    },
    {
      scope: 'browser.interact',
      mode: 'write',
      description: 'Click, type, press keys, and wait on allowed browser pages after explicit authorization.',
      granted: ready,
      required: true,
    },
    {
      scope: 'browser.profile',
      mode: 'write',
      description: 'Persist the dedicated local browser profile, session metadata, and screenshots.',
      granted: ready,
      required: true,
    },
  ];
}

function capabilities(): AssistantPluginCapability[] {
  return [
    {
      capabilityId: 'browser-readonly',
      title: 'Read-only Browser',
      description: 'Open allowed pages, extract text, capture screenshot evidence, and close saved sessions.',
      scopes: ['browser.read', 'browser.profile'],
      actions: ['open_page', 'get_text', 'screenshot', 'close_page'],
    },
    {
      capabilityId: 'browser-interaction',
      title: 'Browser Interaction',
      description: 'Perform explicit interactions on allowed domains through the persistent Playwright profile.',
      scopes: ['browser.interact', 'browser.profile'],
      actions: ['click', 'type', 'press', 'wait_for_selector'],
    },
  ];
}

function actions(): AssistantPluginActionDescriptor[] {
  return [
    {
      actionId: 'configure',
      title: 'Configure browser plugin',
      description: 'Enable or update the local browser plugin configuration.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['browser.profile'],
      resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          profile_dir: { type: 'string' },
          clear_profile_dir: { type: 'boolean' },
          default_timeout_ms: { type: 'number' },
          allowed_domains: { type: 'array', items: { type: 'string' } },
          clear_allowed_domains: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'open_page',
      title: 'Open page',
      description: 'Open an allowed URL with the persistent profile and save a lightweight session.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: false,
      scopes: ['browser.read'],
      resourceClaims: [
        { resource: 'remote', mode: 'read' },
        { resource: 'repo-state', mode: 'write' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
          timeout_ms: { type: 'number' },
          extract_text: { type: 'boolean' },
          max_chars: { type: 'number' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'get_text',
      title: 'Get text',
      description: 'Extract text from a URL or saved browser session.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: true,
      scopes: ['browser.read'],
      resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          url: { type: 'string' },
          selector: { type: 'string' },
          wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
          timeout_ms: { type: 'number' },
          max_chars: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'screenshot',
      title: 'Screenshot',
      description: 'Capture a screenshot to .repo-harness/browser/screenshots.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: false,
      scopes: ['browser.read'],
      resourceClaims: [
        { resource: 'remote', mode: 'read' },
        { resource: 'repo-state', mode: 'write' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          url: { type: 'string' },
          full_page: { type: 'boolean' },
          wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
          timeout_ms: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'click',
      title: 'Click element',
      description: 'Click a selector on an allowed page after authorization.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: false,
      scopes: ['browser.interact', 'browser.profile'],
      resourceClaims: [
        { resource: 'remote', mode: 'exclusive' },
        { resource: 'repo-state', mode: 'write' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          url: { type: 'string' },
          selector: { type: 'string' },
          wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
          timeout_ms: { type: 'number' },
          post_action_wait_ms: { type: 'number' },
        },
        required: ['selector'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'type',
      title: 'Type into element',
      description: 'Fill a selector on an allowed page after authorization.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: false,
      scopes: ['browser.interact', 'browser.profile'],
      resourceClaims: [
        { resource: 'remote', mode: 'exclusive' },
        { resource: 'repo-state', mode: 'write' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          url: { type: 'string' },
          selector: { type: 'string' },
          text: { type: 'string' },
          wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
          timeout_ms: { type: 'number' },
          post_action_wait_ms: { type: 'number' },
        },
        required: ['selector', 'text'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'press',
      title: 'Press key',
      description: 'Press a key on a selector on an allowed page after authorization.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: false,
      scopes: ['browser.interact', 'browser.profile'],
      resourceClaims: [
        { resource: 'remote', mode: 'exclusive' },
        { resource: 'repo-state', mode: 'write' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          url: { type: 'string' },
          selector: { type: 'string' },
          key: { type: 'string' },
          wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
          timeout_ms: { type: 'number' },
          post_action_wait_ms: { type: 'number' },
        },
        required: ['selector', 'key'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'wait_for_selector',
      title: 'Wait for selector',
      description: 'Wait for a selector state on an allowed page after authorization.',
      readOnly: true,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: true,
      scopes: ['browser.interact', 'browser.profile'],
      resourceClaims: [
        { resource: 'remote', mode: 'read' },
        { resource: 'repo-state', mode: 'write' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          url: { type: 'string' },
          selector: { type: 'string' },
          state: { type: 'string', enum: ['attached', 'detached', 'visible', 'hidden'] },
          wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
          timeout_ms: { type: 'number' },
        },
        required: ['selector'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'close_page',
      title: 'Close session',
      description: 'Remove saved session metadata while keeping the persistent profile.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 15_000,
      cancellable: true,
      idempotent: true,
      scopes: ['browser.read', 'browser.profile'],
      resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
        },
        required: ['session_id'],
        additionalProperties: false,
      },
    },
  ];
}

function health(config: BrowserPluginConfig): AssistantPluginHealth {
  const dependencyReady = runtimeHooks.moduleAvailable('playwright');
  if (!config.enabled) {
    return {
      state: 'disabled',
      checkedAt: now(),
      ready: false,
      probed: false,
      errors: [],
      warnings: ['Browser plugin is disabled.'],
      details: { dependencyReady },
    };
  }
  if (!dependencyReady) {
    return {
      state: 'error',
      checkedAt: now(),
      ready: false,
      probed: true,
      errors: ['Browser plugin requires playwright. Run bun install before using browser actions.'],
      warnings: [],
      details: { dependencyReady, install: 'bun install' },
    };
  }
  return {
    state: 'ready',
    checkedAt: now(),
    ready: true,
    probed: true,
    errors: [],
    warnings: config.allowedDomains && config.allowedDomains.length > 0 ? [] : ['allowedDomains is empty; browser actions can target any domain.'],
    details: {
      dependencyReady,
      profileDir: config.profileDir,
      allowedDomains: config.allowedDomains,
      provider: 'playwright-persistent-context',
    },
  };
}

export function buildBrowserPluginManifest(previousRevision = 0, previousUpdatedAt?: string, repoRoot?: string): AssistantPluginManifest {
  const config = loadConfig(repoRoot ?? process.cwd());
  const state = health(config);
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    revision: Math.max(1, previousRevision || 1),
    pluginId: BROWSER_PLUGIN_ID,
    provider: 'local-browser',
    displayName: 'Controller Browser Plugin',
    pluginVersion: '1.0.0',
    authority: {
      strategy: 'derived',
      duplicateStateAllowed: false,
      sourceOfTruth: ['repo-local:.repo-harness/plugins/browser.json', 'repo-local:.repo-harness/browser/'],
    },
    enabled: config.enabled,
    lifecycle: {
      state: !config.enabled ? 'disabled' : state.ready ? 'enabled' : 'error',
      reason: !config.enabled
        ? 'Browser plugin is disabled.'
        : state.ready
          ? 'Browser plugin is ready via Playwright persistent context.'
          : state.errors[0],
    },
    health: state,
    permissions: permissions(state.ready),
    capabilities: capabilities(),
    actions: actions(),
    updatedAt: previousUpdatedAt ?? now(),
  };
}

export async function executeBrowserPluginAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  const current = loadConfig(input.repoRoot);
  if (!current.enabled && input.actionId !== 'configure') {
    throw new AssistantPluginError('PLUGIN_DISABLED', 'Browser plugin is disabled.', { retryable: false });
  }
  try {
    switch (input.actionId) {
      case 'configure': {
        const args = input.args;
        const config = saveConfig(input.repoRoot, {
          enabled: typeof args.enabled === 'boolean' ? args.enabled : current.enabled,
          profileDir: args.clear_profile_dir === true ? undefined : stringValue(args.profile_dir) ?? current.profileDir,
          defaultTimeoutMs: typeof args.default_timeout_ms === 'number'
            ? positiveNumber(args.default_timeout_ms, DEFAULT_TIMEOUT_MS)
            : current.defaultTimeoutMs,
          allowedDomains: args.clear_allowed_domains === true ? undefined : stringArray(args.allowed_domains) ?? current.allowedDomains,
        });
        return { config, health: health(config) };
      }
      case 'open_page': {
        const url = normalizedUrl(input.args.url);
        const target: BrowserActionTarget = { sessionId: sessionIdFor(url), url };
        return await withPage(input.repoRoot, current, url, input.args, async (page) => {
          const session = sessionFromPage(target, normalizedUrl(page.url()), await page.title());
          saveSession(input.repoRoot, session);
          return {
            provider: 'playwright',
            session,
            ...(input.args.extract_text === true
              ? { text: await extractText(page, undefined, positiveNumber(input.args.max_chars, DEFAULT_MAX_TEXT_CHARS)) }
              : {}),
          };
        });
      }
      case 'get_text': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        return {
          provider: 'playwright',
          sessionId: target.sessionId,
          url: target.url,
          ...(await withPage(input.repoRoot, current, target.url, input.args, (page) =>
            extractText(page, stringValue(input.args.selector), positiveNumber(input.args.max_chars, DEFAULT_MAX_TEXT_CHARS)))),
        };
      }
      case 'screenshot': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const screenshotDir = stateDir(input.repoRoot, 'screenshots');
        mkdirSync(screenshotDir, { recursive: true });
        const file = screenshotFilePath(input.repoRoot, 'screenshot', target.sessionId, target.url);
        const screenshot = await withPage(input.repoRoot, current, target.url, input.args, async (page) => ({
          url: normalizedUrl(page.url()),
          title: await page.title(),
          path: file,
          bytes: (await page.screenshot({ path: file, fullPage: input.args.full_page === true })).length,
        }));
        return { provider: 'playwright', screenshot };
      }
      case 'click': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        return await withPage(input.repoRoot, current, target.url, input.args, async (page) => {
          await page.click(selector, { timeout: positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS) });
          await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
          return finalizeInteractiveAction(input.repoRoot, current, page, target, 'click', `Clicked ${selector}.`, { selector });
        });
      }
      case 'type': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const text = requiredString(input.args.text, 'text');
        return await withPage(input.repoRoot, current, target.url, input.args, async (page) => {
          await page.fill(selector, text, { timeout: positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS) });
          await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
          return finalizeInteractiveAction(input.repoRoot, current, page, target, 'type', `Filled ${selector} with ${text.length} characters.`, {
            selector,
            textLength: text.length,
          });
        });
      }
      case 'press': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const key = requiredString(input.args.key, 'key');
        return await withPage(input.repoRoot, current, target.url, input.args, async (page) => {
          await page.press(selector, key, { timeout: positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS) });
          await delay(positiveNumber(input.args.post_action_wait_ms, DEFAULT_POST_ACTION_WAIT_MS));
          return finalizeInteractiveAction(input.repoRoot, current, page, target, 'press', `Pressed ${key} on ${selector}.`, {
            selector,
            key,
          });
        });
      }
      case 'wait_for_selector': {
        const target = resolveActionTarget(input.repoRoot, input.args);
        const selector = requiredString(input.args.selector, 'selector');
        const state = waitForSelectorState(input.args.state);
        return await withPage(input.repoRoot, current, target.url, input.args, async (page) => {
          await page.waitForSelector(selector, {
            state,
            timeout: positiveNumber(input.args.timeout_ms, current.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS),
          });
          return finalizeInteractiveAction(input.repoRoot, current, page, target, 'wait_for_selector', `Observed ${selector} in state ${state}.`, {
            selector,
            state,
          });
        });
      }
      case 'close_page': {
        const sessionId = requiredString(input.args.session_id, 'session_id');
        rmSync(sessionPath(input.repoRoot, sessionId), { force: true });
        return { closed: true, sessionId };
      }
      default:
        throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `browser/${input.actionId} is not supported.`, { retryable: false });
    }
  } catch (error) {
    throw toAssistantPluginError(error, {
      code: 'PLUGIN_ACTION_FAILED',
      message: `Browser action ${input.actionId} failed.`,
      retryable: true,
      details: { pluginId: BROWSER_PLUGIN_ID, actionId: input.actionId },
    });
  }
}

export const browserPluginAdapter = {
  pluginId: BROWSER_PLUGIN_ID,
  buildManifest: buildBrowserPluginManifest,
  executeAction: executeBrowserPluginAction,
};
