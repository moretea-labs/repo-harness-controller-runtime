import { createPrivateKey, sign } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
  AssistantPluginHealth,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError, toAssistantPluginError } from './errors';
import { buildQueryString, encodeBase64Url, stableMockId } from './google-shared';

const APP_STORE_CONNECT_PLUGIN_ID = 'app_store_connect';
const CONFIG_ROOT = '.repo-harness/plugins';
const API_BASE_URL = 'https://api.appstoreconnect.apple.com';
const DEFAULT_TIMEOUT_MS = 60_000;

type AppStoreConnectProviderKind = 'mock' | 'app-store-connect-api';

interface AppStoreConnectPluginConfig {
  schemaVersion: 1;
  enabled: boolean;
  provider: AppStoreConnectProviderKind;
  issuerId?: string;
  keyId?: string;
  teamId?: string;
  defaultAppId?: string;
  defaultLocale?: string;
  defaultTimeoutMs?: number;
}

interface AppStoreConnectAuthState {
  provider: AppStoreConnectProviderKind;
  ready: boolean;
  authenticated: boolean;
  probed: boolean;
  credentialSource?: string;
  issuerId?: string;
  keyId?: string;
  errors: string[];
  warnings: string[];
}

function now(): string {
  return new Date().toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function boundedTimeout(value: unknown): number | undefined {
  const normalized = positiveInteger(value);
  return normalized && normalized <= 10 * 60_000 ? normalized : undefined;
}

function configPath(repoRoot: string): string {
  return join(repoRoot, CONFIG_ROOT, 'app-store-connect.json');
}

function normalizeConfig(raw: Partial<AppStoreConnectPluginConfig>): AppStoreConnectPluginConfig {
  return {
    schemaVersion: 1,
    enabled: raw.enabled === true,
    provider: raw.provider === 'app-store-connect-api' ? 'app-store-connect-api' : 'mock',
    issuerId: stringValue(raw.issuerId),
    keyId: stringValue(raw.keyId),
    teamId: stringValue(raw.teamId),
    defaultAppId: stringValue(raw.defaultAppId),
    defaultLocale: stringValue(raw.defaultLocale) ?? 'en-US',
    defaultTimeoutMs: boundedTimeout(raw.defaultTimeoutMs),
  };
}

function loadConfig(repoRoot: string): AppStoreConnectPluginConfig {
  const path = configPath(repoRoot);
  if (!existsSync(path)) return normalizeConfig({});
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, 'utf-8')) as Partial<AppStoreConnectPluginConfig>);
  } catch {
    return normalizeConfig({});
  }
}

function saveConfig(repoRoot: string, patch: Partial<AppStoreConnectPluginConfig>): AppStoreConnectPluginConfig {
  const next = normalizeConfig({ ...loadConfig(repoRoot), ...patch });
  const path = configPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  return next;
}

function envValue(name: string): string | undefined {
  return stringValue(process.env[name]);
}

function privateKeyMaterial(): { key?: string; source?: string } {
  const inline = envValue('REPO_HARNESS_ASC_PRIVATE_KEY');
  if (inline) return { key: inline.replace(/\\n/g, '\n'), source: 'env:REPO_HARNESS_ASC_PRIVATE_KEY' };
  const keyPath = envValue('REPO_HARNESS_ASC_PRIVATE_KEY_PATH');
  if (keyPath && existsSync(keyPath)) return { key: readFileSync(keyPath, 'utf-8'), source: 'env:REPO_HARNESS_ASC_PRIVATE_KEY_PATH' };
  return {};
}

function resolveAuth(config: AppStoreConnectPluginConfig): AppStoreConnectAuthState {
  if (config.provider === 'mock') {
    return {
      provider: 'mock',
      ready: true,
      authenticated: true,
      probed: true,
      credentialSource: 'mock-provider',
      issuerId: config.issuerId,
      keyId: config.keyId,
      errors: [],
      warnings: ['Mock provider enabled. No Apple credentials are persisted or required.'],
    };
  }

  const issuerId = envValue('REPO_HARNESS_ASC_ISSUER_ID') ?? config.issuerId;
  const keyId = envValue('REPO_HARNESS_ASC_KEY_ID') ?? config.keyId;
  const key = privateKeyMaterial();
  const errors: string[] = [];
  if (!issuerId) errors.push('Set REPO_HARNESS_ASC_ISSUER_ID or configure issuer_id.');
  if (!keyId) errors.push('Set REPO_HARNESS_ASC_KEY_ID or configure key_id.');
  if (!key.key) errors.push('Set REPO_HARNESS_ASC_PRIVATE_KEY or REPO_HARNESS_ASC_PRIVATE_KEY_PATH.');

  return {
    provider: 'app-store-connect-api',
    ready: errors.length === 0,
    authenticated: errors.length === 0,
    probed: true,
    credentialSource: key.source,
    issuerId,
    keyId,
    errors,
    warnings: [],
  };
}

function readLength(buffer: Buffer, offset: number): { length: number; next: number } {
  const first = buffer[offset];
  if (first < 0x80) return { length: first, next: offset + 1 };
  const bytes = first & 0x7f;
  let length = 0;
  for (let index = 0; index < bytes; index += 1) length = (length << 8) + buffer[offset + 1 + index];
  return { length, next: offset + 1 + bytes };
}

function derIntegerToJose(buffer: Buffer): Buffer {
  let value = buffer;
  while (value.length > 32 && value[0] === 0) value = value.subarray(1);
  if (value.length > 32) throw new Error('Invalid ES256 signature integer length.');
  if (value.length === 32) return value;
  return Buffer.concat([Buffer.alloc(32 - value.length), value]);
}

function derSignatureToJose(signature: Buffer): string {
  if (signature[0] !== 0x30) throw new Error('Invalid DER signature sequence.');
  let cursor = readLength(signature, 1).next;
  if (signature[cursor] !== 0x02) throw new Error('Invalid DER signature R marker.');
  const rLength = readLength(signature, cursor + 1);
  const r = signature.subarray(rLength.next, rLength.next + rLength.length);
  cursor = rLength.next + rLength.length;
  if (signature[cursor] !== 0x02) throw new Error('Invalid DER signature S marker.');
  const sLength = readLength(signature, cursor + 1);
  const s = signature.subarray(sLength.next, sLength.next + sLength.length);
  return Buffer.concat([derIntegerToJose(r), derIntegerToJose(s)]).toString('base64url');
}

function createJwt(config: AppStoreConnectPluginConfig): string {
  const issuerId = envValue('REPO_HARNESS_ASC_ISSUER_ID') ?? config.issuerId;
  const keyId = envValue('REPO_HARNESS_ASC_KEY_ID') ?? config.keyId;
  const key = privateKeyMaterial().key;
  if (!issuerId || !keyId || !key) throw new AssistantPluginError('PLUGIN_AUTH_REQUIRED', 'App Store Connect API credentials are incomplete.', { retryable: false });

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = encodeBase64Url(JSON.stringify({ iss: issuerId, iat: issuedAt, exp: issuedAt + 20 * 60, aud: 'appstoreconnect-v1' }));
  const signingInput = `${header}.${payload}`;
  const privateKey = createPrivateKey({ key, format: 'pem' });
  const der = sign('sha256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${derSignatureToJose(der)}`;
}

async function apiRequest<T>(config: AppStoreConnectPluginConfig, options: {
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const url = `${API_BASE_URL}${options.path}${buildQueryString(options.query ?? {})}`;
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${createJwt(config)}`,
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const raw = await response.text();
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
    if (response.status === 401 || response.status === 403) {
      throw new AssistantPluginError('PLUGIN_AUTH_FAILED', 'App Store Connect rejected the API token.', { retryable: false, details: { status: response.status, providerError: parsed } });
    }
    if (response.status === 429) {
      throw new AssistantPluginError('PLUGIN_RATE_LIMITED', 'App Store Connect rate limited the request.', { retryable: true, details: { status: response.status, retryAfter: response.headers.get('retry-after') ?? undefined, providerError: parsed } });
    }
    if (response.status >= 500) {
      throw new AssistantPluginError('PLUGIN_PROVIDER_UNAVAILABLE', 'App Store Connect is temporarily unavailable.', { retryable: true, details: { status: response.status, providerError: parsed } });
    }
    if (!response.ok) {
      throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', `App Store Connect returned HTTP ${response.status}.`, { retryable: false, details: { status: response.status, providerError: parsed } });
    }
    return (parsed ?? {}) as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AssistantPluginError('PLUGIN_PROVIDER_TIMEOUT', 'App Store Connect request timed out.', { retryable: true, details: { timeoutMs: options.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS } });
    }
    throw toAssistantPluginError(error, { code: 'PLUGIN_PROVIDER_ERROR', message: 'App Store Connect request failed.', retryable: true });
  } finally {
    clearTimeout(timeout);
  }
}

function pluginState(config: AppStoreConnectPluginConfig, auth: AppStoreConnectAuthState): { lifecycleState: 'enabled' | 'disabled' | 'degraded' | 'error'; health: AssistantPluginHealth } {
  const lifecycleState = !config.enabled ? 'disabled' : auth.ready ? 'enabled' : auth.errors.length > 0 ? 'error' : 'degraded';
  const healthState = !config.enabled ? 'disabled' : auth.ready ? 'ready' : auth.errors.length > 0 ? 'error' : 'degraded';
  return {
    lifecycleState,
    health: {
      state: healthState,
      checkedAt: now(),
      ready: config.enabled && auth.ready,
      probed: config.enabled ? auth.probed : false,
      errors: config.enabled ? [...auth.errors] : [],
      warnings: !config.enabled ? ['Plugin is disabled. Enable it before using App Store Connect actions.'] : [...auth.warnings],
      details: {
        provider: config.provider,
        issuerId: auth.issuerId ? 'configured' : undefined,
        keyId: auth.keyId ? 'configured' : undefined,
        teamId: config.teamId,
        defaultAppId: config.defaultAppId,
        defaultLocale: config.defaultLocale,
        credentialSource: auth.credentialSource,
        credentialPersistence: 'private keys are read from environment or local path and are never persisted by repo-harness',
      },
    },
  };
}

function permission(scope: string, mode: 'read' | 'write', description: string, granted: boolean): AssistantPluginPermissionScope {
  return { scope, mode, description, granted, required: true };
}

function permissions(ready: boolean): AssistantPluginPermissionScope[] {
  return [
    permission('appstoreconnect.apps.read', 'read', 'Read App Store Connect apps, versions, localizations, builds, and TestFlight groups.', ready),
    permission('appstoreconnect.metadata.write', 'write', 'Patch App Store Connect app info localizations after dry-run review and authorization.', ready),
  ];
}

function capabilities(): AssistantPluginCapability[] {
  return [
    { capabilityId: 'app-store-read', title: 'App Store Status', description: 'Query apps, App Store versions, localization metadata, builds, and TestFlight groups through the official API.', scopes: ['appstoreconnect.apps.read'], actions: ['auth_status', 'list_apps', 'list_app_store_versions', 'get_app_info', 'list_builds', 'list_beta_groups'] },
    { capabilityId: 'app-store-metadata', title: 'App Metadata Update', description: 'Prepare and apply App Info Localization metadata changes through the official API, with dry-run support.', scopes: ['appstoreconnect.metadata.write'], actions: ['preview_app_info_localization_update', 'update_app_info_localization'] },
  ];
}

function actions(): AssistantPluginActionDescriptor[] {
  const readRemote = [{ resource: 'remote' as const, mode: 'read' as const }];
  const writeRemote = [{ resource: 'remote' as const, mode: 'exclusive' as const }];
  return [
    {
      actionId: 'configure', title: 'Configure App Store Connect plugin', description: 'Enable official App Store Connect API access and save non-secret defaults.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true,
      scopes: ['appstoreconnect.apps.read', 'appstoreconnect.metadata.write'], resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: { type: 'object', properties: { enabled: { type: 'boolean' }, provider: { type: 'string', enum: ['mock', 'app-store-connect-api'] }, issuer_id: { type: 'string' }, key_id: { type: 'string' }, clear_api_identity: { type: 'boolean' }, team_id: { type: 'string' }, clear_team_id: { type: 'boolean' }, default_app_id: { type: 'string' }, clear_default_app_id: { type: 'boolean' }, default_locale: { type: 'string' }, default_timeout_ms: { type: 'number' } }, additionalProperties: false },
    },
    { actionId: 'auth_status', title: 'Check App Store Connect auth', description: 'Report API readiness without returning secrets.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { actionId: 'list_apps', title: 'List apps', description: 'List App Store Connect apps, optionally filtered by bundle ID or name.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { bundle_id: { type: 'string' }, name: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_app_store_versions', title: 'List App Store versions', description: 'List App Store versions for one app.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'get_app_info', title: 'Get app info', description: 'Get App Info records and localizations for one app.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' } }, additionalProperties: false } },
    { actionId: 'list_builds', title: 'List builds', description: 'List recent builds for one app.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_beta_groups', title: 'List TestFlight beta groups', description: 'List TestFlight beta groups for one app.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'preview_app_info_localization_update', title: 'Preview app metadata update', description: 'Build the App Info Localization PATCH payload without sending it.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.metadata.write'], resourceClaims: [], argumentsSchema: { type: 'object', properties: { localization_id: { type: 'string' }, name: { type: 'string' }, subtitle: { type: 'string' }, privacy_policy_url: { type: 'string' }, privacy_policy_text: { type: 'string' } }, required: ['localization_id'], additionalProperties: false } },
    { actionId: 'update_app_info_localization', title: 'Update app metadata localization', description: 'Patch App Store Connect App Info Localization metadata through the official API. Use dry_run=true before applying.', readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.metadata.write'], resourceClaims: writeRemote, argumentsSchema: { type: 'object', properties: { localization_id: { type: 'string' }, name: { type: 'string' }, subtitle: { type: 'string' }, privacy_policy_url: { type: 'string' }, privacy_policy_text: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['localization_id'], additionalProperties: false } },
  ];
}

function appId(args: Record<string, unknown>, config: AppStoreConnectPluginConfig): string {
  const value = stringValue(args.app_id) ?? config.defaultAppId;
  if (!value) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'app_id is required when no default_app_id is configured.', { retryable: false });
  return value;
}

function limit(value: unknown, fallback = 25): number {
  const normalized = positiveInteger(value) ?? fallback;
  return Math.min(Math.max(normalized, 1), 200);
}

function localizationPatch(args: Record<string, unknown>): Record<string, unknown> {
  const attributes: Record<string, string> = {};
  const mapping = new Map([
    ['name', 'name'],
    ['subtitle', 'subtitle'],
    ['privacy_policy_url', 'privacyPolicyUrl'],
    ['privacy_policy_text', 'privacyPolicyText'],
  ]);
  for (const [argName, attributeName] of mapping) {
    const value = stringValue(args[argName]);
    if (value !== undefined) attributes[attributeName] = value;
  }
  if (Object.keys(attributes).length === 0) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Provide at least one metadata field to update.', { retryable: false });
  const id = stringValue(args.localization_id);
  if (!id) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'localization_id is required.', { retryable: false });
  return { data: { type: 'appInfoLocalizations', id, attributes } };
}

function mockResponse(actionId: string, args: Record<string, unknown>, config: AppStoreConnectPluginConfig): Record<string, unknown> {
  const id = stringValue(args.app_id) ?? config.defaultAppId ?? stableMockId('app', args);
  if (actionId === 'auth_status') return { ready: true, provider: 'mock', warnings: ['Mock provider enabled.'] };
  if (actionId === 'list_apps') return { data: [{ type: 'apps', id, attributes: { name: 'Mock App', bundleId: stringValue(args.bundle_id) ?? 'com.example.app', sku: 'MOCK' } }], meta: { provider: 'mock' } };
  if (actionId === 'list_app_store_versions') return { data: [{ type: 'appStoreVersions', id: stableMockId('version', { id }), attributes: { versionString: '1.0.0', appStoreState: 'PREPARE_FOR_SUBMISSION', platform: 'IOS' } }] };
  if (actionId === 'get_app_info') return { data: [{ type: 'appInfos', id: stableMockId('info', { id }) }], included: [{ type: 'appInfoLocalizations', id: stableMockId('loc', { id }), attributes: { locale: config.defaultLocale, name: 'Mock App' } }] };
  if (actionId === 'list_builds') return { data: [{ type: 'builds', id: stableMockId('build', { id }), attributes: { version: '1.0.0', processingState: 'VALID' } }] };
  if (actionId === 'list_beta_groups') return { data: [{ type: 'betaGroups', id: stableMockId('beta', { id }), attributes: { name: 'Internal Testers', isInternalGroup: true } }] };
  if (actionId === 'preview_app_info_localization_update' || actionId === 'update_app_info_localization') return { dryRun: true, request: { method: 'PATCH', path: `/v1/appInfoLocalizations/${stringValue(args.localization_id) ?? ''}`, body: localizationPatch(args) }, provider: 'mock' };
  throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `app_store_connect/${actionId} is not supported.`, { retryable: false });
}

export function buildAppStoreConnectPluginManifest(previousRevision = 0, previousUpdatedAt?: string, repoRoot?: string): AssistantPluginManifest {
  const config = loadConfig(repoRoot ?? process.cwd());
  const auth = resolveAuth(config);
  const state = pluginState(config, auth);
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    revision: Math.max(1, previousRevision || 1),
    pluginId: APP_STORE_CONNECT_PLUGIN_ID,
    provider: 'apple',
    displayName: 'App Store Connect API Plugin',
    pluginVersion: '1.0.0',
    authority: { strategy: 'derived', duplicateStateAllowed: false, sourceOfTruth: [`repo-local:${CONFIG_ROOT}/app-store-connect.json`, 'env:REPO_HARNESS_ASC_*'] },
    enabled: config.enabled,
    lifecycle: { state: state.lifecycleState, reason: !config.enabled ? 'App Store Connect plugin is disabled.' : auth.ready ? 'App Store Connect API credentials are ready.' : auth.errors[0] ?? auth.warnings[0] },
    health: state.health,
    permissions: permissions(config.enabled && auth.ready),
    capabilities: capabilities(),
    actions: actions(),
    updatedAt: previousUpdatedAt ?? now(),
  };
}

export async function executeAppStoreConnectPluginAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  const config = loadConfig(input.repoRoot);
  if (input.actionId === 'configure') {
    const args = input.args;
    const next = saveConfig(input.repoRoot, {
      enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
      provider: args.provider === 'app-store-connect-api' ? 'app-store-connect-api' : args.provider === 'mock' ? 'mock' : undefined,
      issuerId: args.clear_api_identity === true ? '' : stringValue(args.issuer_id),
      keyId: args.clear_api_identity === true ? '' : stringValue(args.key_id),
      teamId: args.clear_team_id === true ? '' : stringValue(args.team_id),
      defaultAppId: args.clear_default_app_id === true ? '' : stringValue(args.default_app_id),
      defaultLocale: stringValue(args.default_locale),
      defaultTimeoutMs: boundedTimeout(args.default_timeout_ms),
    });
    return { config: next, auth: resolveAuth(next) };
  }

  if (config.provider === 'mock') return mockResponse(input.actionId, input.args, config);
  const auth = resolveAuth(config);
  if (!config.enabled || !auth.ready) throw new AssistantPluginError('PLUGIN_NOT_READY', 'App Store Connect plugin is not ready.', { retryable: false, details: { enabled: config.enabled, errors: auth.errors } });

  switch (input.actionId) {
    case 'auth_status':
      return { ready: auth.ready, provider: auth.provider, issuerId: auth.issuerId ? 'configured' : undefined, keyId: auth.keyId ? 'configured' : undefined, credentialSource: auth.credentialSource, errors: auth.errors, warnings: auth.warnings };
    case 'list_apps':
      return apiRequest(config, { path: '/v1/apps', query: { 'filter[bundleId]': stringValue(input.args.bundle_id), 'filter[name]': stringValue(input.args.name), limit: limit(input.args.limit) } });
    case 'list_app_store_versions':
      return apiRequest(config, { path: '/v1/appStoreVersions', query: { 'filter[app]': appId(input.args, config), limit: limit(input.args.limit) } });
    case 'get_app_info':
      return apiRequest(config, { path: `/v1/apps/${encodeURIComponent(appId(input.args, config))}/appInfos`, query: { include: 'appInfoLocalizations' } });
    case 'list_builds':
      return apiRequest(config, { path: '/v1/builds', query: { 'filter[app]': appId(input.args, config), limit: limit(input.args.limit) } });
    case 'list_beta_groups':
      return apiRequest(config, { path: '/v1/betaGroups', query: { 'filter[app]': appId(input.args, config), limit: limit(input.args.limit) } });
    case 'preview_app_info_localization_update':
      return { dryRun: true, request: { method: 'PATCH', path: `/v1/appInfoLocalizations/${stringValue(input.args.localization_id) ?? ''}`, body: localizationPatch(input.args) } };
    case 'update_app_info_localization': {
      const body = localizationPatch(input.args);
      const localizationId = stringValue(input.args.localization_id) ?? '';
      if (input.args.dry_run === true) return { dryRun: true, request: { method: 'PATCH', path: `/v1/appInfoLocalizations/${localizationId}`, body } };
      return apiRequest(config, { path: `/v1/appInfoLocalizations/${encodeURIComponent(localizationId)}`, method: 'PATCH', body });
    }
    default:
      throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `app_store_connect/${input.actionId} is not supported.`, { retryable: false });
  }
}

export const appStoreConnectPluginAdapter = {
  pluginId: APP_STORE_CONNECT_PLUGIN_ID,
  buildManifest: buildAppStoreConnectPluginManifest,
  executeAction: executeAppStoreConnectPluginAction,
};
