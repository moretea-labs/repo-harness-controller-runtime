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
  privateKeyPath?: string;
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
    privateKeyPath: stringValue(raw.privateKeyPath),
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

function privateKeyMaterial(config: AppStoreConnectPluginConfig): { key?: string; source?: string; warning?: string } {
  const inline = envValue('REPO_HARNESS_ASC_PRIVATE_KEY');
  if (inline) return { key: inline.replace(/\\n/g, '\n'), source: 'env:REPO_HARNESS_ASC_PRIVATE_KEY' };
  const envKeyPath = envValue('REPO_HARNESS_ASC_PRIVATE_KEY_PATH');
  if (envKeyPath) {
    return existsSync(envKeyPath)
      ? { key: readFileSync(envKeyPath, 'utf-8'), source: 'env:REPO_HARNESS_ASC_PRIVATE_KEY_PATH' }
      : { source: 'env:REPO_HARNESS_ASC_PRIVATE_KEY_PATH', warning: 'Configured App Store Connect private key path does not exist.' };
  }
  if (config.privateKeyPath) {
    return existsSync(config.privateKeyPath)
      ? { key: readFileSync(config.privateKeyPath, 'utf-8'), source: 'config:privateKeyPath' }
      : { source: 'config:privateKeyPath', warning: 'Configured App Store Connect private key path does not exist.' };
  }
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
  const key = privateKeyMaterial(config);
  const errors: string[] = [];
  const warnings: string[] = key.warning ? [key.warning] : [];
  if (!issuerId) errors.push('Set REPO_HARNESS_ASC_ISSUER_ID or configure issuer_id.');
  if (!keyId) errors.push('Set REPO_HARNESS_ASC_KEY_ID or configure key_id.');
  if (!key.key) errors.push('Set REPO_HARNESS_ASC_PRIVATE_KEY, REPO_HARNESS_ASC_PRIVATE_KEY_PATH, or configure private_key_path.');

  return {
    provider: 'app-store-connect-api',
    ready: errors.length === 0,
    authenticated: errors.length === 0,
    probed: true,
    credentialSource: key.source,
    issuerId,
    keyId,
    errors,
    warnings,
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
  const key = privateKeyMaterial(config).key;
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

function userFacingAscStatus(config: AppStoreConnectPluginConfig, auth: AppStoreConnectAuthState): string {
  if (!config.enabled) return 'auth missing';
  if (config.provider === 'mock' && auth.ready) return 'ready';
  if (!auth.ready) return 'auth missing';
  return 'write gated';
}

function pluginState(config: AppStoreConnectPluginConfig, auth: AppStoreConnectAuthState): { lifecycleState: 'enabled' | 'disabled' | 'degraded' | 'error'; health: AssistantPluginHealth } {
  const missingAuth = config.enabled && config.provider !== 'mock' && !auth.ready;
  const lifecycleState = !config.enabled ? 'disabled' : auth.ready ? 'enabled' : missingAuth ? 'degraded' : 'error';
  const healthState = !config.enabled ? 'disabled' : auth.ready ? 'ready' : missingAuth ? 'degraded' : 'error';
  return {
    lifecycleState,
    health: {
      state: healthState,
      checkedAt: now(),
      ready: config.enabled && auth.ready,
      probed: config.enabled ? auth.probed : false,
      errors: config.enabled && !missingAuth ? [...auth.errors] : [],
      warnings: !config.enabled
        ? ['Plugin is disabled. Enable it before using App Store Connect actions.']
        : [...auth.warnings, ...(missingAuth ? auth.errors : [])],
      details: {
        provider: config.provider,
        issuerId: auth.issuerId ? 'configured' : undefined,
        keyId: auth.keyId ? 'configured' : undefined,
        teamId: config.teamId,
        defaultAppId: config.defaultAppId,
        defaultLocale: config.defaultLocale,
        credentialSource: auth.credentialSource,
        credentialPersistence: 'private keys are read from environment or local path and are never persisted by repo-harness',
        userFacingStatus: userFacingAscStatus(config, auth),
        readinessMode: !config.enabled
          ? 'disabled'
          : config.provider === 'mock'
            ? 'mock_provider_ready'
            : auth.ready
              ? 'live_provider_ready'
              : 'auth_missing',
        writePolicy: 'remote writes require confirmAuthorization; production actions require strong confirmation text',
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
    permission('appstoreconnect.metadata.write', 'write', 'Patch App Store Connect metadata after dry-run review and authorization.', ready),
    permission('appstoreconnect.testflight.write', 'write', 'Assign builds to TestFlight groups and prepare beta review submissions.', ready),
    permission('appstoreconnect.release.write', 'write', 'Create App Store versions and gated review submissions.', ready),
  ];
}

function capabilities(): AssistantPluginCapability[] {
  return [
    {
      capabilityId: 'app-store-read',
      title: 'App Store Status',
      description: 'Query apps, versions, localizations, builds, TestFlight groups/testers, and review submissions.',
      scopes: ['appstoreconnect.apps.read'],
      actions: [
        'auth_status', 'list_apps', 'list_app_store_versions', 'list_app_store_version_localizations',
        'get_app_info', 'list_app_infos', 'list_builds', 'list_testflight_builds', 'get_build_detail',
        'list_beta_groups', 'list_beta_testers', 'list_review_submissions',
      ],
    },
    {
      capabilityId: 'app-store-metadata',
      title: 'App Metadata Update',
      description: 'Preview and apply metadata localization updates with dry-run support.',
      scopes: ['appstoreconnect.metadata.write'],
      actions: [
        'preview_app_info_localization_update', 'update_app_info_localization',
        'preview_app_store_version_metadata_update', 'update_app_store_version_metadata',
      ],
    },
    {
      capabilityId: 'app-store-testflight',
      title: 'TestFlight Operations',
      description: 'Assign builds to beta groups and prepare beta App Review submissions with strong confirmation.',
      scopes: ['appstoreconnect.testflight.write'],
      actions: ['assign_build_to_beta_group', 'submit_beta_app_review'],
    },
    {
      capabilityId: 'app-store-release',
      title: 'Release Operations',
      description: 'Create App Store versions and gated review submissions with strong confirmation.',
      scopes: ['appstoreconnect.release.write'],
      actions: ['create_app_store_version', 'create_review_submission', 'submit_for_review'],
    },
  ];
}

function actions(): AssistantPluginActionDescriptor[] {
  const readRemote = [{ resource: 'remote' as const, mode: 'read' as const }];
  const writeRemote = [{ resource: 'remote' as const, mode: 'exclusive' as const }];
  return [
    {
      actionId: 'configure', title: 'Configure App Store Connect plugin', description: 'Enable official App Store Connect API access and save non-secret defaults.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true,
      scopes: ['appstoreconnect.apps.read', 'appstoreconnect.metadata.write', 'appstoreconnect.testflight.write', 'appstoreconnect.release.write'], resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: { type: 'object', properties: { enabled: { type: 'boolean' }, provider: { type: 'string', enum: ['mock', 'app-store-connect-api'] }, issuer_id: { type: 'string' }, key_id: { type: 'string' }, private_key_path: { type: 'string' }, clear_private_key_path: { type: 'boolean' }, clear_api_identity: { type: 'boolean' }, team_id: { type: 'string' }, clear_team_id: { type: 'boolean' }, default_app_id: { type: 'string' }, clear_default_app_id: { type: 'boolean' }, default_locale: { type: 'string' }, default_timeout_ms: { type: 'number' } }, additionalProperties: false },
    },
    { actionId: 'auth_status', title: 'Check App Store Connect auth', description: 'Report API readiness without returning secrets.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { actionId: 'list_apps', title: 'List apps', description: 'List App Store Connect apps, optionally filtered by bundle ID or name.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { bundle_id: { type: 'string' }, name: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_app_store_versions', title: 'List App Store versions', description: 'List App Store versions for one app.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_app_store_version_localizations', title: 'List App Store version localizations', description: 'List localizations for one App Store version.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { version_id: { type: 'string' }, limit: { type: 'number' } }, required: ['version_id'], additionalProperties: false } },
    { actionId: 'get_app_info', title: 'Get app info', description: 'Get App Info records and localizations for one app.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' } }, additionalProperties: false } },
    { actionId: 'list_app_infos', title: 'List app infos', description: 'List App Info records for one app.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_builds', title: 'List builds', description: 'List recent builds for one app with processing state fields.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_testflight_builds', title: 'List TestFlight builds', description: 'List builds with TestFlight processing/export compliance fields.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'get_build_detail', title: 'Get build detail', description: 'Get one build record with processing and TestFlight attributes.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { build_id: { type: 'string' } }, required: ['build_id'], additionalProperties: false } },
    { actionId: 'list_beta_groups', title: 'List TestFlight beta groups', description: 'List TestFlight beta groups for one app.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_beta_testers', title: 'List beta testers', description: 'List TestFlight beta testers for one app.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'list_review_submissions', title: 'List review submissions', description: 'List App Store review submissions for one app when available.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 45_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.apps.read'], resourceClaims: readRemote, argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
    { actionId: 'preview_app_info_localization_update', title: 'Preview app metadata update', description: 'Build the App Info Localization PATCH payload without sending it.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.metadata.write'], resourceClaims: [], argumentsSchema: { type: 'object', properties: { localization_id: { type: 'string' }, name: { type: 'string' }, subtitle: { type: 'string' }, privacy_policy_url: { type: 'string' }, privacy_policy_text: { type: 'string' } }, required: ['localization_id'], additionalProperties: false } },
    { actionId: 'update_app_info_localization', title: 'Update app metadata localization', description: 'Patch App Store Connect App Info Localization metadata through the official API. Use dry_run=true before applying.', readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.metadata.write'], resourceClaims: writeRemote, argumentsSchema: { type: 'object', properties: { localization_id: { type: 'string' }, name: { type: 'string' }, subtitle: { type: 'string' }, privacy_policy_url: { type: 'string' }, privacy_policy_text: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['localization_id'], additionalProperties: false } },
    { actionId: 'preview_app_store_version_metadata_update', title: 'Preview version metadata update', description: 'Build the App Store Version Localization PATCH payload without sending it.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true, scopes: ['appstoreconnect.metadata.write'], resourceClaims: [], argumentsSchema: { type: 'object', properties: { localization_id: { type: 'string' }, description: { type: 'string' }, keywords: { type: 'string' }, marketing_url: { type: 'string' }, promotional_text: { type: 'string' }, support_url: { type: 'string' }, whats_new: { type: 'string' } }, required: ['localization_id'], additionalProperties: false } },
    { actionId: 'update_app_store_version_metadata', title: 'Update version metadata localization', description: 'Patch App Store Version Localization metadata. Use dry_run=true before applying.', readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.metadata.write'], resourceClaims: writeRemote, argumentsSchema: { type: 'object', properties: { localization_id: { type: 'string' }, description: { type: 'string' }, keywords: { type: 'string' }, marketing_url: { type: 'string' }, promotional_text: { type: 'string' }, support_url: { type: 'string' }, whats_new: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['localization_id'], additionalProperties: false } },
    {
      actionId: 'create_app_store_version', title: 'Create App Store version', description: 'Create a new App Store version for an app platform. Requires strong confirmation.',
      readOnly: false, risk: 'remote_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'create-app-store-version',
      defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.release.write'], resourceClaims: writeRemote,
      argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, version_string: { type: 'string' }, platform: { type: 'string', enum: ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'] }, copyright: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['version_string'], additionalProperties: false },
    },
    {
      actionId: 'assign_build_to_beta_group', title: 'Assign build to TestFlight group', description: 'Add a build to a TestFlight beta group. Requires strong confirmation.',
      readOnly: false, risk: 'remote_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'assign-testflight-build',
      defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.testflight.write'], resourceClaims: writeRemote,
      argumentsSchema: { type: 'object', properties: { build_id: { type: 'string' }, beta_group_id: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['build_id', 'beta_group_id'], additionalProperties: false },
    },
    {
      actionId: 'submit_beta_app_review', title: 'Submit beta App Review', description: 'Create a beta app review submission for a build. Requires strong confirmation.',
      readOnly: false, risk: 'remote_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'submit-beta-review',
      defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.testflight.write'], resourceClaims: writeRemote,
      argumentsSchema: { type: 'object', properties: { build_id: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['build_id'], additionalProperties: false },
    },
    {
      actionId: 'create_review_submission', title: 'Create review submission', description: 'Create an App Store review submission shell for an app. Requires strong confirmation.',
      readOnly: false, risk: 'remote_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'submit-app-review',
      defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.release.write'], resourceClaims: writeRemote,
      argumentsSchema: { type: 'object', properties: { app_id: { type: 'string' }, platform: { type: 'string', enum: ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'] }, dry_run: { type: 'boolean' } }, additionalProperties: false },
    },
    {
      actionId: 'submit_for_review', title: 'Submit for App Review', description: 'Submit an existing review submission. Requires strong confirmation. Prefer dry_run first.',
      readOnly: false, risk: 'remote_write', confirmation: 'strong_confirmation', requiredConfirmationText: 'submit-app-review',
      defaultTimeoutMs: 60_000, cancellable: true, idempotent: false, scopes: ['appstoreconnect.release.write'], resourceClaims: writeRemote,
      argumentsSchema: { type: 'object', properties: { review_submission_id: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['review_submission_id'], additionalProperties: false },
    },
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

function versionLocalizationPatch(args: Record<string, unknown>): Record<string, unknown> {
  const attributes: Record<string, string> = {};
  const mapping = new Map([
    ['description', 'description'],
    ['keywords', 'keywords'],
    ['marketing_url', 'marketingUrl'],
    ['promotional_text', 'promotionalText'],
    ['support_url', 'supportUrl'],
    ['whats_new', 'whatsNew'],
  ]);
  for (const [argName, attributeName] of mapping) {
    const value = stringValue(args[argName]);
    if (value !== undefined) attributes[attributeName] = value;
  }
  if (Object.keys(attributes).length === 0) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Provide at least one version metadata field to update.', { retryable: false });
  const id = stringValue(args.localization_id);
  if (!id) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'localization_id is required.', { retryable: false });
  return { data: { type: 'appStoreVersionLocalizations', id, attributes } };
}

function requiredArg(args: Record<string, unknown>, name: string): string {
  const value = stringValue(args[name]);
  if (!value) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${name} is required.`, { retryable: false });
  return value;
}

function mockBuild(id: string) {
  return {
    type: 'builds',
    id: stableMockId('build', { id }),
    attributes: {
      version: '42',
      uploadedDate: now(),
      processingState: 'VALID',
      expired: false,
      usesNonExemptEncryption: false,
      minOsVersion: '17.0',
    },
  };
}

function mockResponse(actionId: string, args: Record<string, unknown>, config: AppStoreConnectPluginConfig): Record<string, unknown> {
  const id = stringValue(args.app_id) ?? config.defaultAppId ?? stableMockId('app', args);
  if (actionId === 'auth_status') {
    return {
      ready: true,
      provider: 'mock',
      warnings: ['Mock provider enabled.'],
      userFacingStatus: 'ready',
      readinessMode: 'mock_provider_ready',
    };
  }
  if (actionId === 'list_apps') return { data: [{ type: 'apps', id, attributes: { name: 'Mock App', bundleId: stringValue(args.bundle_id) ?? 'com.example.app', sku: 'MOCK' } }], meta: { provider: 'mock' } };
  if (actionId === 'list_app_store_versions') return { data: [{ type: 'appStoreVersions', id: stableMockId('version', { id }), attributes: { versionString: '1.0.0', appStoreState: 'PREPARE_FOR_SUBMISSION', platform: 'IOS' } }] };
  if (actionId === 'list_app_store_version_localizations') {
    return {
      data: [{
        type: 'appStoreVersionLocalizations',
        id: stableMockId('vloc', { version: args.version_id }),
        attributes: { locale: config.defaultLocale, description: 'Mock description', keywords: 'mock,app', whatsNew: 'Bug fixes' },
      }],
    };
  }
  if (actionId === 'get_app_info' || actionId === 'list_app_infos') {
    return {
      data: [{ type: 'appInfos', id: stableMockId('info', { id }) }],
      included: [{ type: 'appInfoLocalizations', id: stableMockId('loc', { id }), attributes: { locale: config.defaultLocale, name: 'Mock App' } }],
    };
  }
  if (actionId === 'list_builds' || actionId === 'list_testflight_builds') {
    return {
      data: [mockBuild(id)],
      meta: {
        provider: 'mock',
        testFlightFields: ['processingState', 'usesNonExemptEncryption', 'expired', 'uploadedDate'],
      },
    };
  }
  if (actionId === 'get_build_detail') {
    const buildId = stringValue(args.build_id) ?? stableMockId('build', args);
    return { data: { ...mockBuild(id), id: buildId } };
  }
  if (actionId === 'list_beta_groups') return { data: [{ type: 'betaGroups', id: stableMockId('beta', { id }), attributes: { name: 'Internal Testers', isInternalGroup: true } }] };
  if (actionId === 'list_beta_testers') {
    return {
      data: [{
        type: 'betaTesters',
        id: stableMockId('tester', { id }),
        attributes: { firstName: 'Mock', lastName: 'Tester', email: 'tester@example.com', state: 'ACCEPTED' },
      }],
    };
  }
  if (actionId === 'list_review_submissions') {
    return {
      data: [{
        type: 'reviewSubmissions',
        id: stableMockId('review', { id }),
        attributes: { state: 'READY_FOR_REVIEW', platform: 'IOS', submittedDate: null },
      }],
    };
  }
  if (actionId === 'preview_app_info_localization_update' || (actionId === 'update_app_info_localization' && args.dry_run === true)) {
    return { dryRun: true, request: { method: 'PATCH', path: `/v1/appInfoLocalizations/${stringValue(args.localization_id) ?? ''}`, body: localizationPatch(args) }, provider: 'mock' };
  }
  if (actionId === 'update_app_info_localization') {
    return { dryRun: false, provider: 'mock', data: localizationPatch(args).data, applied: true };
  }
  if (actionId === 'preview_app_store_version_metadata_update' || (actionId === 'update_app_store_version_metadata' && args.dry_run === true)) {
    return { dryRun: true, request: { method: 'PATCH', path: `/v1/appStoreVersionLocalizations/${stringValue(args.localization_id) ?? ''}`, body: versionLocalizationPatch(args) }, provider: 'mock' };
  }
  if (actionId === 'update_app_store_version_metadata') {
    return { dryRun: false, provider: 'mock', data: versionLocalizationPatch(args).data, applied: true };
  }
  if (actionId === 'create_app_store_version') {
    const body = {
      data: {
        type: 'appStoreVersions',
        attributes: {
          platform: stringValue(args.platform) ?? 'IOS',
          versionString: requiredArg(args, 'version_string'),
          copyright: stringValue(args.copyright),
        },
        relationships: { app: { data: { type: 'apps', id } } },
      },
    };
    if (args.dry_run === true) return { dryRun: true, request: { method: 'POST', path: '/v1/appStoreVersions', body }, provider: 'mock' };
    return { dryRun: false, provider: 'mock', data: { ...body.data, id: stableMockId('version', body) }, applied: true };
  }
  if (actionId === 'assign_build_to_beta_group') {
    const buildId = requiredArg(args, 'build_id');
    const betaGroupId = requiredArg(args, 'beta_group_id');
    const body = { data: [{ type: 'builds', id: buildId }] };
    if (args.dry_run === true) {
      return { dryRun: true, request: { method: 'POST', path: `/v1/betaGroups/${betaGroupId}/relationships/builds`, body }, provider: 'mock' };
    }
    return { dryRun: false, provider: 'mock', assigned: true, buildId, betaGroupId };
  }
  if (actionId === 'submit_beta_app_review') {
    const buildId = requiredArg(args, 'build_id');
    const body = { data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: buildId } } } } };
    if (args.dry_run === true) return { dryRun: true, request: { method: 'POST', path: '/v1/betaAppReviewSubmissions', body }, provider: 'mock' };
    return { dryRun: false, provider: 'mock', data: { type: 'betaAppReviewSubmissions', id: stableMockId('beta_review', { buildId }), attributes: { betaReviewState: 'WAITING_FOR_REVIEW' } }, applied: true };
  }
  if (actionId === 'create_review_submission') {
    const body = {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: stringValue(args.platform) ?? 'IOS' },
        relationships: { app: { data: { type: 'apps', id } } },
      },
    };
    if (args.dry_run === true) return { dryRun: true, request: { method: 'POST', path: '/v1/reviewSubmissions', body }, provider: 'mock' };
    return { dryRun: false, provider: 'mock', data: { ...body.data, id: stableMockId('review', body) }, applied: true };
  }
  if (actionId === 'submit_for_review') {
    const reviewSubmissionId = requiredArg(args, 'review_submission_id');
    const body = { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: reviewSubmissionId } } } } };
    if (args.dry_run === true) {
      return {
        dryRun: true,
        request: { method: 'PATCH', path: `/v1/reviewSubmissions/${reviewSubmissionId}`, body: { data: { type: 'reviewSubmissions', id: reviewSubmissionId, attributes: { submitted: true } } } },
        provider: 'mock',
        note: 'Production submit is gated; dry_run never calls Apple.',
      };
    }
    return {
      dryRun: false,
      provider: 'mock',
      data: { type: 'reviewSubmissions', id: reviewSubmissionId, attributes: { state: 'WAITING_FOR_REVIEW', submittedDate: now() } },
      applied: true,
      related: body,
    };
  }
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
      privateKeyPath: args.clear_private_key_path === true ? '' : stringValue(args.private_key_path),
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
      return {
        ready: auth.ready,
        provider: auth.provider,
        issuerId: auth.issuerId ? 'configured' : undefined,
        keyId: auth.keyId ? 'configured' : undefined,
        credentialSource: auth.credentialSource,
        errors: auth.errors,
        warnings: auth.warnings,
        userFacingStatus: userFacingAscStatus(config, auth),
      };
    case 'list_apps':
      return apiRequest(config, { path: '/v1/apps', query: { 'filter[bundleId]': stringValue(input.args.bundle_id), 'filter[name]': stringValue(input.args.name), limit: limit(input.args.limit) } });
    case 'list_app_store_versions':
      return apiRequest(config, { path: '/v1/appStoreVersions', query: { 'filter[app]': appId(input.args, config), limit: limit(input.args.limit) } });
    case 'list_app_store_version_localizations':
      return apiRequest(config, {
        path: `/v1/appStoreVersions/${encodeURIComponent(requiredArg(input.args, 'version_id'))}/appStoreVersionLocalizations`,
        query: { limit: limit(input.args.limit) },
      });
    case 'get_app_info':
    case 'list_app_infos':
      return apiRequest(config, { path: `/v1/apps/${encodeURIComponent(appId(input.args, config))}/appInfos`, query: { include: 'appInfoLocalizations', limit: limit(input.args.limit) } });
    case 'list_builds':
    case 'list_testflight_builds':
      return apiRequest(config, {
        path: '/v1/builds',
        query: {
          'filter[app]': appId(input.args, config),
          limit: limit(input.args.limit),
          'fields[builds]': 'version,uploadedDate,expirationDate,expired,processingState,usesNonExemptEncryption,minOsVersion,iconAssetToken',
        },
      });
    case 'get_build_detail':
      return apiRequest(config, {
        path: `/v1/builds/${encodeURIComponent(requiredArg(input.args, 'build_id'))}`,
        query: {
          'fields[builds]': 'version,uploadedDate,expirationDate,expired,processingState,usesNonExemptEncryption,minOsVersion,iconAssetToken',
          include: 'buildBetaDetail,preReleaseVersion',
        },
      });
    case 'list_beta_groups':
      return apiRequest(config, { path: '/v1/betaGroups', query: { 'filter[app]': appId(input.args, config), limit: limit(input.args.limit) } });
    case 'list_beta_testers':
      return apiRequest(config, { path: '/v1/betaTesters', query: { 'filter[apps]': appId(input.args, config), limit: limit(input.args.limit) } });
    case 'list_review_submissions':
      return apiRequest(config, { path: '/v1/reviewSubmissions', query: { 'filter[app]': appId(input.args, config), limit: limit(input.args.limit) } });
    case 'preview_app_info_localization_update':
      return { dryRun: true, request: { method: 'PATCH', path: `/v1/appInfoLocalizations/${stringValue(input.args.localization_id) ?? ''}`, body: localizationPatch(input.args) } };
    case 'update_app_info_localization': {
      const body = localizationPatch(input.args);
      const localizationId = stringValue(input.args.localization_id) ?? '';
      if (input.args.dry_run === true) return { dryRun: true, request: { method: 'PATCH', path: `/v1/appInfoLocalizations/${localizationId}`, body } };
      return apiRequest(config, { path: `/v1/appInfoLocalizations/${encodeURIComponent(localizationId)}`, method: 'PATCH', body });
    }
    case 'preview_app_store_version_metadata_update':
      return { dryRun: true, request: { method: 'PATCH', path: `/v1/appStoreVersionLocalizations/${stringValue(input.args.localization_id) ?? ''}`, body: versionLocalizationPatch(input.args) } };
    case 'update_app_store_version_metadata': {
      const body = versionLocalizationPatch(input.args);
      const localizationId = stringValue(input.args.localization_id) ?? '';
      if (input.args.dry_run === true) return { dryRun: true, request: { method: 'PATCH', path: `/v1/appStoreVersionLocalizations/${localizationId}`, body } };
      return apiRequest(config, { path: `/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}`, method: 'PATCH', body });
    }
    case 'create_app_store_version': {
      const body = {
        data: {
          type: 'appStoreVersions',
          attributes: {
            platform: stringValue(input.args.platform) ?? 'IOS',
            versionString: requiredArg(input.args, 'version_string'),
            copyright: stringValue(input.args.copyright),
          },
          relationships: { app: { data: { type: 'apps', id: appId(input.args, config) } } },
        },
      };
      if (input.args.dry_run === true) return { dryRun: true, request: { method: 'POST', path: '/v1/appStoreVersions', body } };
      return apiRequest(config, { path: '/v1/appStoreVersions', method: 'POST', body });
    }
    case 'assign_build_to_beta_group': {
      const buildId = requiredArg(input.args, 'build_id');
      const betaGroupId = requiredArg(input.args, 'beta_group_id');
      const body = { data: [{ type: 'builds', id: buildId }] };
      if (input.args.dry_run === true) {
        return { dryRun: true, request: { method: 'POST', path: `/v1/betaGroups/${betaGroupId}/relationships/builds`, body } };
      }
      return apiRequest(config, { path: `/v1/betaGroups/${encodeURIComponent(betaGroupId)}/relationships/builds`, method: 'POST', body });
    }
    case 'submit_beta_app_review': {
      const buildId = requiredArg(input.args, 'build_id');
      const body = {
        data: {
          type: 'betaAppReviewSubmissions',
          relationships: { build: { data: { type: 'builds', id: buildId } } },
        },
      };
      if (input.args.dry_run === true) return { dryRun: true, request: { method: 'POST', path: '/v1/betaAppReviewSubmissions', body } };
      return apiRequest(config, { path: '/v1/betaAppReviewSubmissions', method: 'POST', body });
    }
    case 'create_review_submission': {
      const body = {
        data: {
          type: 'reviewSubmissions',
          attributes: { platform: stringValue(input.args.platform) ?? 'IOS' },
          relationships: { app: { data: { type: 'apps', id: appId(input.args, config) } } },
        },
      };
      if (input.args.dry_run === true) return { dryRun: true, request: { method: 'POST', path: '/v1/reviewSubmissions', body } };
      return apiRequest(config, { path: '/v1/reviewSubmissions', method: 'POST', body });
    }
    case 'submit_for_review': {
      const reviewSubmissionId = requiredArg(input.args, 'review_submission_id');
      const body = {
        data: {
          type: 'reviewSubmissions',
          id: reviewSubmissionId,
          attributes: { submitted: true },
        },
      };
      if (input.args.dry_run === true) {
        return { dryRun: true, request: { method: 'PATCH', path: `/v1/reviewSubmissions/${reviewSubmissionId}`, body } };
      }
      return apiRequest(config, { path: `/v1/reviewSubmissions/${encodeURIComponent(reviewSubmissionId)}`, method: 'PATCH', body });
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
