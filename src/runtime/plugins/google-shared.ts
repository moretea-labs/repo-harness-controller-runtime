import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type {
  AssistantPluginHealth,
  AssistantPluginLifecycleState,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError, toAssistantPluginError } from './errors';
import { bootstrapManagedRuntimeEnv } from '../shared/managed-env';
import { readStoredGoogleRefreshToken } from '../safe-tooling/google-credential-store';

export type GoogleProviderKind = 'mock' | 'google-workspace';
export type GoogleService = 'gmail' | 'calendar' | 'tasks';

export interface GooglePluginBaseConfig {
  schemaVersion: 1;
  enabled: boolean;
  provider: GoogleProviderKind;
  accountEmail?: string;
  defaultTimeoutMs?: number;
}

export interface GmailPluginConfig extends GooglePluginBaseConfig {
  defaultQuery?: string;
}

export interface GoogleCalendarPluginConfig extends GooglePluginBaseConfig {
  calendarId?: string;
  timezone?: string;
}

export interface GoogleTasksPluginConfig extends GooglePluginBaseConfig {
  taskListId?: string;
  includeCompleted?: boolean;
}

export type GooglePluginConfig = GmailPluginConfig | GoogleCalendarPluginConfig | GoogleTasksPluginConfig;

export interface GoogleAuthState {
  provider: GoogleProviderKind;
  ready: boolean;
  authenticated: boolean;
  probed: boolean;
  credentialSource?: string;
  accessToken?: string;
  refreshReady?: boolean;
  errors: string[];
  warnings: string[];
}

export interface GoogleApiRequestOptions {
  service: GoogleService;
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  accessToken: string;
  timeoutMs?: number;
}

const CONFIG_ROOT = '.repo-harness/plugins';
const REFRESH_REQUIRED_ACCESS_TOKEN = '__repo_harness_refresh_required__';

interface CachedGoogleCredential {
  accessToken: string;
  expiresAt: number;
  source: string;
}

const GOOGLE_ACCESS_TOKEN_CACHE = new Map<GoogleService, CachedGoogleCredential>();
const VERIFIED_GOOGLE_TOKEN_FINGERPRINTS = new Map<string, number>();

function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function verifiedToken(token: string): boolean {
  const verifiedAt = VERIFIED_GOOGLE_TOKEN_FINGERPRINTS.get(tokenFingerprint(token));
  return Boolean(verifiedAt && Date.now() - verifiedAt < 24 * 60 * 60_000);
}

function cachedGoogleToken(service: GoogleService): CachedGoogleCredential | undefined {
  const cached = GOOGLE_ACCESS_TOKEN_CACHE.get(service);
  if (!cached || cached.expiresAt <= Date.now() + 30_000) return undefined;
  return cached;
}

function firstEnv(names: string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return { name, value };
  }
  return undefined;
}

function refreshTokenEnvNames(service: GoogleService): string[] {
  return [
    `REPO_HARNESS_${service.toUpperCase()}_REFRESH_TOKEN`,
    service === 'gmail' ? 'REPO_HARNESS_GMAIL_REFRESH_TOKEN' : '',
    'REPO_HARNESS_GOOGLE_WORKSPACE_REFRESH_TOKEN',
    'REPO_HARNESS_GOOGLE_REFRESH_TOKEN',
  ].filter(Boolean);
}

function clientIdEnvNames(service: GoogleService): string[] {
  return [`REPO_HARNESS_${service.toUpperCase()}_CLIENT_ID`, 'REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_ID', 'REPO_HARNESS_GOOGLE_CLIENT_ID'];
}

function clientSecretEnvNames(service: GoogleService): string[] {
  return [`REPO_HARNESS_${service.toUpperCase()}_CLIENT_SECRET`, 'REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_SECRET', 'REPO_HARNESS_GOOGLE_CLIENT_SECRET'];
}

function refreshCredential(service: GoogleService): { name: string; value: string } | undefined {
  const fromEnv = firstEnv(refreshTokenEnvNames(service));
  if (fromEnv) return fromEnv;
  const stored = readStoredGoogleRefreshToken(service);
  return stored ? { name: stored.source, value: stored.token } : undefined;
}

function refreshCredentialsReady(service: GoogleService): boolean {
  return Boolean(refreshCredential(service) && firstEnv(clientIdEnvNames(service)) && firstEnv(clientSecretEnvNames(service)));
}

export function installGoogleAccessToken(service: GoogleService, accessToken: string, expiresInSeconds = 3600, source = 'oauth'): void {
  const token = accessToken.trim();
  if (!token) throw new Error('GOOGLE_ACCESS_TOKEN_REQUIRED');
  GOOGLE_ACCESS_TOKEN_CACHE.set(service, {
    accessToken: token,
    expiresAt: Date.now() + Math.max(60, expiresInSeconds) * 1000,
    source,
  });
}

function repoPluginConfigPath(repoRoot: string, pluginId: string): string {
  return join(repoRoot, CONFIG_ROOT, `${pluginId}.json`);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function defaultTimeoutMs(value: unknown): number | undefined {
  const normalized = positiveInteger(value);
  return normalized && normalized <= 10 * 60_000 ? normalized : undefined;
}

function normalizeBaseConfig(raw: Partial<GooglePluginBaseConfig>): GooglePluginBaseConfig {
  return {
    schemaVersion: 1,
    enabled: raw.enabled === true,
    provider: raw.provider === 'google-workspace' ? 'google-workspace' : 'mock',
    accountEmail: stringValue(raw.accountEmail),
    defaultTimeoutMs: defaultTimeoutMs(raw.defaultTimeoutMs),
  };
}

export function defaultGmailPluginConfig(): GmailPluginConfig {
  return {
    ...normalizeBaseConfig({}),
    defaultQuery: undefined,
  };
}

export function normalizeGmailPluginConfig(raw: Partial<GmailPluginConfig>): GmailPluginConfig {
  return {
    ...normalizeBaseConfig(raw),
    defaultQuery: stringValue(raw.defaultQuery),
  };
}

export function defaultGoogleCalendarPluginConfig(): GoogleCalendarPluginConfig {
  return {
    ...normalizeBaseConfig({}),
    calendarId: 'primary',
    timezone: undefined,
  };
}

export function normalizeGoogleCalendarPluginConfig(raw: Partial<GoogleCalendarPluginConfig>): GoogleCalendarPluginConfig {
  return {
    ...normalizeBaseConfig(raw),
    calendarId: stringValue(raw.calendarId) ?? 'primary',
    timezone: stringValue(raw.timezone),
  };
}

export function defaultGoogleTasksPluginConfig(): GoogleTasksPluginConfig {
  return {
    ...normalizeBaseConfig({}),
    taskListId: '@default',
    includeCompleted: false,
  };
}

export function normalizeGoogleTasksPluginConfig(raw: Partial<GoogleTasksPluginConfig>): GoogleTasksPluginConfig {
  return {
    ...normalizeBaseConfig(raw),
    taskListId: stringValue(raw.taskListId) ?? '@default',
    includeCompleted: raw.includeCompleted === true,
  };
}

function loadPluginConfig<T extends GooglePluginConfig>(
  repoRoot: string,
  pluginId: string,
  normalize: (raw: Partial<T>) => T,
  defaults: () => T,
): T {
  const path = repoPluginConfigPath(repoRoot, pluginId);
  if (!existsSync(path)) return defaults();
  try {
    return normalize(JSON.parse(readFileSync(path, 'utf-8')) as Partial<T>);
  } catch {
    return defaults();
  }
}

function writePluginConfig<T extends GooglePluginConfig>(
  repoRoot: string,
  pluginId: string,
  config: T,
): T {
  const path = repoPluginConfigPath(repoRoot, pluginId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return config;
}

export function gmailPluginConfigPath(): string {
  return `${CONFIG_ROOT}/gmail.json`;
}

export function googleCalendarPluginConfigPath(): string {
  return `${CONFIG_ROOT}/google-calendar.json`;
}

export function googleTasksPluginConfigPath(): string {
  return `${CONFIG_ROOT}/google-tasks.json`;
}

export function loadGmailPluginConfig(repoRoot: string): GmailPluginConfig {
  return loadPluginConfig(repoRoot, 'gmail', normalizeGmailPluginConfig, defaultGmailPluginConfig);
}

export function loadGoogleCalendarPluginConfig(repoRoot: string): GoogleCalendarPluginConfig {
  return loadPluginConfig(repoRoot, 'google-calendar', normalizeGoogleCalendarPluginConfig, defaultGoogleCalendarPluginConfig);
}

export function loadGoogleTasksPluginConfig(repoRoot: string): GoogleTasksPluginConfig {
  return loadPluginConfig(repoRoot, 'google-tasks', normalizeGoogleTasksPluginConfig, defaultGoogleTasksPluginConfig);
}

export type GooglePluginConfigPatch<T extends GooglePluginConfig> = Partial<Omit<T, 'schemaVersion'>>;

export function saveGmailPluginConfig(repoRoot: string, patch: GooglePluginConfigPatch<GmailPluginConfig>): GmailPluginConfig {
  const current = loadGmailPluginConfig(repoRoot);
  return writePluginConfig(repoRoot, 'gmail', normalizeGmailPluginConfig({ ...current, ...patch }));
}

export function saveGoogleCalendarPluginConfig(
  repoRoot: string,
  patch: GooglePluginConfigPatch<GoogleCalendarPluginConfig>,
): GoogleCalendarPluginConfig {
  const current = loadGoogleCalendarPluginConfig(repoRoot);
  return writePluginConfig(repoRoot, 'google-calendar', normalizeGoogleCalendarPluginConfig({ ...current, ...patch }));
}

export function saveGoogleTasksPluginConfig(
  repoRoot: string,
  patch: GooglePluginConfigPatch<GoogleTasksPluginConfig>,
): GoogleTasksPluginConfig {
  const current = loadGoogleTasksPluginConfig(repoRoot);
  return writePluginConfig(repoRoot, 'google-tasks', normalizeGoogleTasksPluginConfig({ ...current, ...patch }));
}

function tokenEnvNames(service: GoogleService): string[] {
  switch (service) {
    case 'gmail':
      return ['REPO_HARNESS_GMAIL_ACCESS_TOKEN', 'REPO_HARNESS_GOOGLE_WORKSPACE_ACCESS_TOKEN', 'REPO_HARNESS_GOOGLE_ACCESS_TOKEN'];
    case 'calendar':
      return ['REPO_HARNESS_GOOGLE_CALENDAR_ACCESS_TOKEN', 'REPO_HARNESS_GOOGLE_WORKSPACE_ACCESS_TOKEN', 'REPO_HARNESS_GOOGLE_ACCESS_TOKEN'];
    case 'tasks':
      return ['REPO_HARNESS_GOOGLE_TASKS_ACCESS_TOKEN', 'REPO_HARNESS_GOOGLE_WORKSPACE_ACCESS_TOKEN', 'REPO_HARNESS_GOOGLE_ACCESS_TOKEN'];
  }
}

export function resolveGoogleAuth(
  service: GoogleService,
  config: GooglePluginConfig,
  options: { repoRoot?: string } = {},
): GoogleAuthState {
  bootstrapManagedRuntimeEnv({ repoRoot: options.repoRoot });
  if (config.provider === 'mock') {
    return {
      provider: 'mock', ready: true, authenticated: true, probed: true,
      credentialSource: 'mock', refreshReady: false, errors: [],
      warnings: ['Mock provider enabled. No external credentials are persisted or required.'],
    };
  }
  const cached = cachedGoogleToken(service);
  const configured = firstEnv(tokenEnvNames(service));
  const token = cached?.accessToken ?? configured?.value;
  const probed = Boolean(token && verifiedToken(token));
  const refreshReady = refreshCredentialsReady(service);
  if (token) {
    return {
      provider: 'google-workspace',
      ready: true,
      authenticated: true,
      probed,
      credentialSource: cached?.source ?? `env:${configured?.name}`,
      accessToken: token,
      refreshReady,
      errors: [],
      warnings: probed ? [] : ['Google access token is configured but has not passed a live provider probe yet.'],
    };
  }
  if (refreshReady) {
    const refresh = refreshCredential(service);
    return {
      provider: 'google-workspace', ready: true, authenticated: true, probed: false, refreshReady: true,
      credentialSource: refresh?.name,
      accessToken: REFRESH_REQUIRED_ACCESS_TOKEN,
      errors: [],
      warnings: ['A stored refresh credential is available; the next provider request will refresh and verify an access token.'],
    };
  }
  return {
    provider: 'google-workspace', ready: false, authenticated: false, probed: false, refreshReady: false,
    errors: [`Complete workspace_auth_login_prepare or set one of ${tokenEnvNames(service).join(', ')}.`],
    warnings: [],
  };
}

export type GoogleReadinessMode =
  | 'disabled'
  | 'missing_token'
  | 'live_token_unverified'
  | 'mock_provider_ready'
  | 'live_provider_ready';

export function resolveGoogleReadinessMode(config: GooglePluginConfig, auth: GoogleAuthState): GoogleReadinessMode {
  if (!config.enabled) return 'disabled';
  if (config.provider === 'mock' && auth.ready) return 'mock_provider_ready';
  if (config.provider === 'google-workspace' && auth.ready && auth.probed) return 'live_provider_ready';
  if (config.provider === 'google-workspace' && auth.authenticated) return 'live_token_unverified';
  return 'missing_token';
}

export function pluginStateFromGoogleAuth(config: GooglePluginConfig, auth: GoogleAuthState): {
  lifecycleState: AssistantPluginLifecycleState;
  health: AssistantPluginHealth;
} {
  const readinessMode = resolveGoogleReadinessMode(config, auth);
  const ready = readinessMode === 'mock_provider_ready' || readinessMode === 'live_provider_ready';
  const lifecycleState: AssistantPluginLifecycleState = !config.enabled ? 'disabled' : ready ? 'enabled' : 'degraded';
  const userFacingStatus = readinessMode === 'disabled'
    ? 'disabled'
    : readinessMode === 'mock_provider_ready'
      ? 'mock ready'
      : readinessMode === 'live_provider_ready'
        ? 'ready'
        : readinessMode === 'live_token_unverified'
          ? 'live token unverified'
          : 'live token missing';
  return {
    lifecycleState,
    health: {
      state: !config.enabled ? 'disabled' : ready ? 'ready' : 'degraded',
      checkedAt: new Date().toISOString(),
      ready: config.enabled && ready,
      probed: config.enabled ? auth.probed : false,
      errors: [],
      warnings: !config.enabled
        ? ['Plugin is disabled. Enable it before using Google provider actions.']
        : [...auth.warnings, ...(!auth.authenticated ? auth.errors : [])],
      details: {
        provider: config.provider,
        accountEmail: config.accountEmail,
        credentialSource: auth.credentialSource,
        credentialPersistence: 'tokens are loaded from managed process secrets and are never written to repository state',
        refreshReady: auth.refreshReady === true,
        readinessMode,
        userFacingStatus,
      },
    },
  };
}

export function googlePermission(
  scope: string,
  mode: 'read' | 'write',
  description: string,
  granted: boolean,
): AssistantPluginPermissionScope {
  return {
    scope,
    mode,
    description,
    granted,
    required: true,
  };
}

export function buildQueryString(query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

function serviceBaseUrl(service: GoogleService): string {
  switch (service) {
    case 'gmail':
      return 'https://gmail.googleapis.com';
    case 'calendar':
      return 'https://www.googleapis.com';
    case 'tasks':
      return 'https://tasks.googleapis.com';
  }
}

async function refreshGoogleAccessToken(service: GoogleService, timeoutMs: number): Promise<string | undefined> {
  const refreshToken = refreshCredential(service);
  const clientId = firstEnv(clientIdEnvNames(service));
  const clientSecret = firstEnv(clientSecretEnvNames(service));
  if (!refreshToken || !clientId || !clientSecret) return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken.value,
      client_id: clientId.value,
      client_secret: clientSecret.value,
    });
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { parsed = { raw }; }
    const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token.trim() : '';
    if (!response.ok || !accessToken) {
      throw new AssistantPluginError('PLUGIN_AUTH_FAILED', 'Google refresh token exchange failed.', {
        retryable: false,
        details: { service, status: response.status, providerError: parsed },
      });
    }
    const expiresIn = typeof parsed.expires_in === 'number' ? Math.max(60, parsed.expires_in) : 3600;
    installGoogleAccessToken(service, accessToken, expiresIn, `refresh:${refreshToken.name}`);
    return accessToken;
  } finally {
    clearTimeout(timeout);
  }
}

async function googleFetch(options: GoogleApiRequestOptions, accessToken: string): Promise<{ response: Response; parsed: Record<string, unknown> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  const url = `${serviceBaseUrl(options.service)}${options.path}${buildQueryString(options.query ?? {})}`;
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { parsed = { raw }; }
    return { response, parsed };
  } finally {
    clearTimeout(timeout);
  }
}

export function clearGoogleAuthCachesForTest(): void {
  GOOGLE_ACCESS_TOKEN_CACHE.clear();
  VERIFIED_GOOGLE_TOKEN_FINGERPRINTS.clear();
}

export async function googleApiRequest<T>(options: GoogleApiRequestOptions): Promise<T> {
  try {
    const cached = cachedGoogleToken(options.service);
    let accessToken = cached?.accessToken ?? options.accessToken;
    if (accessToken === REFRESH_REQUIRED_ACCESS_TOKEN && refreshCredentialsReady(options.service)) {
      accessToken = await refreshGoogleAccessToken(options.service, options.timeoutMs ?? 60_000) ?? accessToken;
    }
    let attempt = await googleFetch(options, accessToken);
    if ((attempt.response.status === 401 || attempt.response.status === 403) && refreshCredentialsReady(options.service)) {
      const refreshed = await refreshGoogleAccessToken(options.service, options.timeoutMs ?? 60_000);
      if (refreshed) {
        accessToken = refreshed;
        attempt = await googleFetch(options, accessToken);
      }
    }
    const { response, parsed } = attempt;
    if (response.status === 401 || response.status === 403) {
      throw new AssistantPluginError('PLUGIN_AUTH_FAILED', 'Google provider rejected the access token.', {
        retryable: false,
        details: { service: options.service, status: response.status, providerError: parsed, refreshReady: refreshCredentialsReady(options.service) },
      });
    }
    if (response.status === 429) {
      throw new AssistantPluginError('PLUGIN_RATE_LIMITED', 'Google provider rate limited the request.', {
        retryable: true,
        details: { service: options.service, status: response.status, retryAfter: response.headers.get('retry-after') ?? undefined, providerError: parsed },
      });
    }
    if (response.status >= 500) {
      throw new AssistantPluginError('PLUGIN_PROVIDER_UNAVAILABLE', 'Google provider is temporarily unavailable.', {
        retryable: true,
        details: { service: options.service, status: response.status, providerError: parsed },
      });
    }
    if (!response.ok) {
      throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', `Google provider returned HTTP ${response.status}.`, {
        retryable: false,
        details: { service: options.service, status: response.status, providerError: parsed },
      });
    }
    VERIFIED_GOOGLE_TOKEN_FINGERPRINTS.set(tokenFingerprint(accessToken), Date.now());
    const current = cachedGoogleToken(options.service);
    if (current?.accessToken === accessToken) GOOGLE_ACCESS_TOKEN_CACHE.set(options.service, { ...current, expiresAt: Math.max(current.expiresAt, Date.now() + 60_000) });
    return parsed as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AssistantPluginError('PLUGIN_PROVIDER_TIMEOUT', 'Google provider request timed out.', {
        retryable: true,
        details: { service: options.service, timeoutMs: options.timeoutMs ?? 60_000 },
      });
    }
    throw toAssistantPluginError(error, {
      code: 'PLUGIN_PROVIDER_ERROR', message: 'Google provider request failed.', retryable: true, details: { service: options.service },
    });
  }
}

export function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function stableMockId(prefix: string, payload: Record<string, unknown>): string {
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
  return `${prefix}_${digest}`;
}
