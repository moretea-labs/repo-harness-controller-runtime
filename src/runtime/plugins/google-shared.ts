import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type {
  AssistantPluginHealth,
  AssistantPluginLifecycleState,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError, toAssistantPluginError } from './errors';

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

export function resolveGoogleAuth(service: GoogleService, config: GooglePluginConfig): GoogleAuthState {
  if (config.provider === 'mock') {
    return {
      provider: 'mock',
      ready: true,
      authenticated: true,
      probed: true,
      credentialSource: 'mock',
      errors: [],
      warnings: ['Mock provider enabled. No external credentials are persisted or required.'],
    };
  }

  for (const envName of tokenEnvNames(service)) {
    const token = process.env[envName]?.trim();
    if (token) {
      return {
        provider: 'google-workspace',
        ready: true,
        authenticated: true,
        probed: true,
        credentialSource: `env:${envName}`,
        accessToken: token,
        errors: [],
        warnings: [],
      };
    }
  }

  return {
    provider: 'google-workspace',
    ready: false,
    authenticated: false,
    probed: true,
    errors: [`Set one of ${tokenEnvNames(service).join(', ')} before invoking ${service} Google Workspace actions.`],
    warnings: [],
  };
}

export type GoogleReadinessMode =
  | 'disabled'
  | 'missing_token'
  | 'missing_scopes'
  | 'mock_provider_ready'
  | 'live_provider_ready';

export function resolveGoogleReadinessMode(config: GooglePluginConfig, auth: GoogleAuthState): GoogleReadinessMode {
  if (!config.enabled) return 'disabled';
  if (config.provider === 'mock' && auth.ready) return 'mock_provider_ready';
  if (config.provider === 'google-workspace' && auth.ready) return 'live_provider_ready';
  if (config.provider === 'google-workspace' && !auth.authenticated) return 'missing_token';
  return 'missing_scopes';
}

export function pluginStateFromGoogleAuth(config: GooglePluginConfig, auth: GoogleAuthState): {
  lifecycleState: AssistantPluginLifecycleState;
  health: AssistantPluginHealth;
} {
  const readinessMode = resolveGoogleReadinessMode(config, auth);
  // Missing live credentials is a setup state, not a broken plugin, when mock is not selected.
  const lifecycleState: AssistantPluginLifecycleState = !config.enabled
    ? 'disabled'
    : auth.ready
      ? 'enabled'
      : readinessMode === 'missing_token' || readinessMode === 'missing_scopes'
        ? 'degraded'
        : 'error';
  const healthState = !config.enabled
    ? 'disabled'
    : auth.ready
      ? 'ready'
      : readinessMode === 'missing_token' || readinessMode === 'missing_scopes'
        ? 'degraded'
        : 'error';
  const userFacingStatus = readinessMode === 'disabled'
    ? 'disabled'
    : readinessMode === 'mock_provider_ready'
      ? 'mock ready'
      : readinessMode === 'live_provider_ready'
        ? 'ready'
        : readinessMode === 'missing_token'
          ? 'live token missing'
          : 'missing scopes';
  return {
    lifecycleState,
    health: {
      state: healthState,
      checkedAt: new Date().toISOString(),
      ready: config.enabled && auth.ready,
      probed: config.enabled ? auth.probed : false,
      // Keep auth setup messages in warnings when only the token is missing so UIs
      // classify the plugin as authorization_required instead of generically failed.
      errors: config.enabled && readinessMode !== 'missing_token' && readinessMode !== 'missing_scopes'
        ? [...auth.errors]
        : [],
      warnings: !config.enabled
        ? ['Plugin is disabled. Enable it before using Google provider actions.']
        : [
            ...auth.warnings,
            ...(readinessMode === 'missing_token' || readinessMode === 'missing_scopes' ? auth.errors : []),
          ],
      details: {
        provider: config.provider,
        accountEmail: config.accountEmail,
        credentialSource: auth.credentialSource,
        credentialPersistence: 'credentials are never persisted by repo-harness',
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

export async function googleApiRequest<T>(options: GoogleApiRequestOptions): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  const url = `${serviceBaseUrl(options.service)}${options.path}${buildQueryString(options.query ?? {})}`;
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const raw = await response.text();
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
    if (response.status === 401 || response.status === 403) {
      throw new AssistantPluginError('PLUGIN_AUTH_FAILED', 'Google provider rejected the access token.', {
        retryable: false,
        details: {
          service: options.service,
          status: response.status,
          providerError: parsed,
        },
      });
    }
    if (response.status === 429) {
      throw new AssistantPluginError('PLUGIN_RATE_LIMITED', 'Google provider rate limited the request.', {
        retryable: true,
        details: {
          service: options.service,
          status: response.status,
          retryAfter: response.headers.get('retry-after') ?? undefined,
          providerError: parsed,
        },
      });
    }
    if (response.status >= 500) {
      throw new AssistantPluginError('PLUGIN_PROVIDER_UNAVAILABLE', 'Google provider is temporarily unavailable.', {
        retryable: true,
        details: {
          service: options.service,
          status: response.status,
          providerError: parsed,
        },
      });
    }
    if (!response.ok) {
      throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', `Google provider returned HTTP ${response.status}.`, {
        retryable: false,
        details: {
          service: options.service,
          status: response.status,
          providerError: parsed,
        },
      });
    }
    return (parsed ?? {}) as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AssistantPluginError('PLUGIN_PROVIDER_TIMEOUT', 'Google provider request timed out.', {
        retryable: true,
        details: { service: options.service, timeoutMs: options.timeoutMs ?? 60_000 },
      });
    }
    throw toAssistantPluginError(error, {
      code: 'PLUGIN_PROVIDER_ERROR',
      message: 'Google provider request failed.',
      retryable: true,
      details: { service: options.service },
    });
  } finally {
    clearTimeout(timeout);
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
