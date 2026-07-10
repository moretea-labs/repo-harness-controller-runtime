import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { resolveControllerHome } from '../../../cli/repositories/controller-home';
import { readJsonFile, writeJsonAtomic } from '../../shared/json-files';
import type {
  ExecutorRoutingConfigFile,
  GoalLoopPolicyConfigFile,
  LocalToolConfigFile,
  LocalToolPreference,
  ProviderConfigFile,
  ProviderPreference,
  ProviderSecretEntry,
  ProviderSecretsFile,
  RoutingIntentKey,
} from './config-types';

/** Default remote API endpoints / models (non-secret). */
export const REMOTE_API_DEFAULTS: Record<string, { baseUrl: string; model: string; envVars: string[] }> = {
  grok_api: {
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-3',
    envVars: ['XAI_API_KEY', 'REPO_HARNESS_XAI_API_KEY', 'GROK_API_KEY'],
  },
  openai_api: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    envVars: ['OPENAI_API_KEY', 'REPO_HARNESS_OPENAI_API_KEY'],
  },
  deepseek_api: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    envVars: ['DEEPSEEK_API_KEY', 'REPO_HARNESS_DEEPSEEK_API_KEY'],
  },
};

export const REMOTE_API_PROVIDER_IDS = Object.keys(REMOTE_API_DEFAULTS);
export interface GoalLoopConfigLocation {
  controllerHome?: string;
  root?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function globalConfigRoot(location: GoalLoopConfigLocation): string {
  if (location.root) {
    mkdirSync(location.root, { recursive: true });
    return location.root;
  }
  if (!location.controllerHome) {
    throw new Error('goal-loop config requires controllerHome or root');
  }
  const root = join(resolveControllerHome(location.controllerHome), 'global');
  mkdirSync(root, { recursive: true });
  return root;
}

export function defaultProviderConfig(updatedAt = nowIso()): ProviderConfigFile {
  const defaults: Array<Omit<ProviderPreference, 'updatedAt'>> = [
    { providerId: 'direct_edit', enabled: true, priority: 10 },
    { providerId: 'codex_cli', enabled: true, priority: 100 },
    { providerId: 'grok_cli', enabled: true, priority: 100 },
    { providerId: 'claude_cli', enabled: true, priority: 100 },
    {
      providerId: 'grok_api',
      enabled: true,
      priority: 200,
      credentialEnvVars: REMOTE_API_DEFAULTS.grok_api!.envVars,
      baseUrl: REMOTE_API_DEFAULTS.grok_api!.baseUrl,
      model: REMOTE_API_DEFAULTS.grok_api!.model,
    },
    {
      providerId: 'openai_api',
      enabled: true,
      priority: 200,
      credentialEnvVars: REMOTE_API_DEFAULTS.openai_api!.envVars,
      baseUrl: REMOTE_API_DEFAULTS.openai_api!.baseUrl,
      model: REMOTE_API_DEFAULTS.openai_api!.model,
    },
    {
      providerId: 'deepseek_api',
      enabled: true,
      priority: 200,
      credentialEnvVars: REMOTE_API_DEFAULTS.deepseek_api!.envVars,
      baseUrl: REMOTE_API_DEFAULTS.deepseek_api!.baseUrl,
      model: REMOTE_API_DEFAULTS.deepseek_api!.model,
    },
    { providerId: 'github_copilot_cloud', enabled: true, priority: 300 },
    {
      providerId: 'chatgpt_handoff',
      enabled: true,
      priority: 900,
      notes: 'Handoff-only supervisor; never direct-invokable.',
    },
  ];
  return {
    schemaVersion: 1,
    updatedAt,
    preferLiveModelProviders: false,
    goalLoopEnabled: true,
    providers: defaults.map((entry) => ({ ...entry, updatedAt })),
  };
}

export function defaultLocalToolConfig(updatedAt = nowIso()): LocalToolConfigFile {
  const ids = [
    'direct_edit',
    'codex_cli',
    'grok_cli',
    'claude_cli',
    'git',
    'gh',
    'bun',
    'npm',
    'xcodebuild',
    'xcrun',
    'simctl',
    'playwright',
    'app_store_connect',
    'gmail_workspace',
  ];
  return {
    schemaVersion: 1,
    updatedAt,
    tools: ids.map((toolId) => ({ toolId, enabled: true, updatedAt })),
  };
}

function neutralProviderOrder(providerConfig: ProviderConfigFile): string[] {
  return providerConfig.providers
    .filter((provider) => provider.enabled)
    .filter((provider) => !['direct_edit', 'chatgpt_handoff'].includes(provider.providerId))
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      return left.providerId.localeCompare(right.providerId);
    })
    .map((provider) => provider.providerId);
}

/**
 * Fresh-install routing is vendor-neutral: execution kind first, then user
 * priority, then provider id as a deterministic tie-breaker. Persisted routing
 * files remain authoritative and are never rewritten by a read.
 */
export function defaultRoutingConfig(
  updatedAt = nowIso(),
  providerConfig = defaultProviderConfig(updatedAt),
): ExecutorRoutingConfigFile {
  const executors = neutralProviderOrder(providerConfig);
  const withHandoff = [...executors, 'chatgpt_handoff'];
  const orders: Record<RoutingIntentKey, string[]> = {
    deterministic_edit: ['direct_edit', ...withHandoff],
    implementation: [...withHandoff],
    repair: [...withHandoff],
    planning: [...withHandoff],
    review: [...withHandoff],
    browser_planning: [...withHandoff],
    ios_analysis: [...withHandoff],
    fallback: ['direct_edit', ...withHandoff],
  };
  return {
    schemaVersion: 1,
    updatedAt,
    orders,
  };
}

export function defaultGoalLoopPolicy(updatedAt = nowIso()): GoalLoopPolicyConfigFile {
  return {
    schemaVersion: 1,
    updatedAt,
    requireApprovalForExternalWrites: true,
    requireApprovalForDestructiveChanges: true,
    requireApprovalForBroadRefactors: true,
    requireApprovalForBrowserFormSubmit: true,
    requireApprovalForGmailSendOrTrash: true,
    requireApprovalForAppStoreConnectWrites: true,
    requireApprovalBeforeFinalMerge: true,
    maxChangedFilesWithoutConfirmation: 40,
    maxChangedLinesWithoutConfirmation: 2_000,
    defaultRetryBudget: 5,
    maxRepairAttemptsPerProvider: 3,
  };
}

function providerConfigPath(location: GoalLoopConfigLocation): string {
  return join(globalConfigRoot(location), 'provider-config.json');
}
function providerSecretsPath(location: GoalLoopConfigLocation): string {
  return join(globalConfigRoot(location), 'provider-secrets.json');
}
function localToolConfigPath(location: GoalLoopConfigLocation): string {
  return join(globalConfigRoot(location), 'local-tool-config.json');
}
function routingConfigPath(location: GoalLoopConfigLocation): string {
  return join(globalConfigRoot(location), 'executor-routing.json');
}
function policyConfigPath(location: GoalLoopConfigLocation): string {
  return join(globalConfigRoot(location), 'goal-loop-policy.json');
}

function sanitizeBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  if (trimmed.length > 500) return undefined;
  return trimmed;
}

function sanitizeModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return undefined;
  if (!/^[a-zA-Z0-9._:/-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function stripSecretFields(pref: ProviderPreference): ProviderPreference {
  const clone = { ...pref } as ProviderPreference & Record<string, unknown>;
  for (const key of Object.keys(clone)) {
    if (/api[_-]?key|token|secret|password|authorization|bearer/i.test(key)) {
      delete clone[key];
    }
  }
  return clone;
}

function mergeProviderDefaults(stored: ProviderConfigFile | undefined): ProviderConfigFile {
  const base = defaultProviderConfig(stored?.updatedAt ?? nowIso());
  if (!stored) return base;
  const byId = new Map(stored.providers.map((p) => [p.providerId, p]));
  const providers = base.providers.map((def) => {
    const existing = byId.get(def.providerId);
    if (!existing) return def;
    const defaults = REMOTE_API_DEFAULTS[def.providerId];
    return stripSecretFields({
      ...def,
      ...existing,
      providerId: def.providerId,
      // ChatGPT can never be "disabled" from handoff role; enabled only controls whether packets are preferred.
      enabled: def.providerId === 'chatgpt_handoff' ? true : existing.enabled !== false,
      priority: typeof existing.priority === 'number' ? existing.priority : def.priority,
      baseUrl: sanitizeBaseUrl(existing.baseUrl) ?? def.baseUrl ?? defaults?.baseUrl,
      model: sanitizeModel(existing.model) ?? def.model ?? defaults?.model,
      credentialEnvVars: existing.credentialEnvVars ?? def.credentialEnvVars ?? defaults?.envVars,
    });
  });
  // Keep any unknown custom provider prefs (forward-compat).
  for (const entry of stored.providers) {
    if (!providers.some((p) => p.providerId === entry.providerId)) {
      providers.push(entry);
    }
  }
  return {
    schemaVersion: 1,
    updatedAt: stored.updatedAt ?? base.updatedAt,
    preferLiveModelProviders: stored.preferLiveModelProviders === true,
    goalLoopEnabled: stored.goalLoopEnabled !== false,
    providers: providers.sort((a, b) => a.priority - b.priority),
  };
}

function mergeToolDefaults(stored: LocalToolConfigFile | undefined): LocalToolConfigFile {
  const base = defaultLocalToolConfig(stored?.updatedAt ?? nowIso());
  if (!stored) return base;
  const byId = new Map(stored.tools.map((t) => [t.toolId, t]));
  const tools: LocalToolPreference[] = base.tools.map((def) => {
    const existing = byId.get(def.toolId);
    if (!existing) return def;
    return { ...def, ...existing, toolId: def.toolId, enabled: existing.enabled !== false };
  });
  for (const entry of stored.tools) {
    if (!tools.some((t) => t.toolId === entry.toolId)) tools.push(entry);
  }
  return { schemaVersion: 1, updatedAt: stored.updatedAt ?? base.updatedAt, tools };
}

function mergeRoutingDefaults(
  stored: ExecutorRoutingConfigFile | undefined,
  providerConfig: ProviderConfigFile = defaultProviderConfig(stored?.updatedAt ?? nowIso()),
): ExecutorRoutingConfigFile {
  const base = defaultRoutingConfig(stored?.updatedAt ?? nowIso(), providerConfig);
  if (!stored) return base;
  const orders = { ...base.orders };
  for (const key of Object.keys(base.orders) as RoutingIntentKey[]) {
    if (Array.isArray(stored.orders?.[key]) && stored.orders[key]!.length > 0) {
      orders[key] = stored.orders[key]!.map(String);
    }
  }
  return {
    schemaVersion: 1,
    updatedAt: stored.updatedAt ?? base.updatedAt,
    orders,
    defaultImplementationProvider: stored.defaultImplementationProvider ?? base.defaultImplementationProvider,
    defaultRepairProvider: stored.defaultRepairProvider ?? base.defaultRepairProvider,
    defaultPlanningProvider: stored.defaultPlanningProvider ?? base.defaultPlanningProvider,
    defaultReviewProvider: stored.defaultReviewProvider ?? base.defaultReviewProvider,
    defaultBrowserPlanningProvider: stored.defaultBrowserPlanningProvider ?? base.defaultBrowserPlanningProvider,
    defaultIosAnalysisProvider: stored.defaultIosAnalysisProvider ?? base.defaultIosAnalysisProvider,
  };
}

function mergePolicyDefaults(stored: GoalLoopPolicyConfigFile | undefined): GoalLoopPolicyConfigFile {
  const base = defaultGoalLoopPolicy(stored?.updatedAt ?? nowIso());
  if (!stored) return base;
  return {
    ...base,
    ...stored,
    schemaVersion: 1,
    // Never allow a "disable all safety" collapse via missing fields.
    requireApprovalForExternalWrites: stored.requireApprovalForExternalWrites !== false,
    requireApprovalForDestructiveChanges: stored.requireApprovalForDestructiveChanges !== false,
    requireApprovalForBroadRefactors: stored.requireApprovalForBroadRefactors !== false,
    requireApprovalForBrowserFormSubmit: stored.requireApprovalForBrowserFormSubmit !== false,
    requireApprovalForGmailSendOrTrash: stored.requireApprovalForGmailSendOrTrash !== false,
    requireApprovalForAppStoreConnectWrites: stored.requireApprovalForAppStoreConnectWrites !== false,
    requireApprovalBeforeFinalMerge: stored.requireApprovalBeforeFinalMerge !== false,
    maxChangedFilesWithoutConfirmation: Math.max(1, Number(stored.maxChangedFilesWithoutConfirmation ?? base.maxChangedFilesWithoutConfirmation)),
    maxChangedLinesWithoutConfirmation: Math.max(1, Number(stored.maxChangedLinesWithoutConfirmation ?? base.maxChangedLinesWithoutConfirmation)),
    defaultRetryBudget: Math.max(0, Number(stored.defaultRetryBudget ?? base.defaultRetryBudget)),
    maxRepairAttemptsPerProvider: Math.max(1, Number(stored.maxRepairAttemptsPerProvider ?? base.maxRepairAttemptsPerProvider)),
  };
}

export function readProviderConfig(location: GoalLoopConfigLocation): ProviderConfigFile {
  const raw = readJsonFile<ProviderConfigFile | undefined>(providerConfigPath(location), undefined);
  return mergeProviderDefaults(raw);
}

export function writeProviderConfig(location: GoalLoopConfigLocation, config: ProviderConfigFile): ProviderConfigFile {
  const at = nowIso();
  const next: ProviderConfigFile = {
    ...mergeProviderDefaults(config),
    updatedAt: at,
    providers: config.providers.map((p) => {
      const cleaned = stripSecretFields(p);
      const defaults = REMOTE_API_DEFAULTS[cleaned.providerId];
      return {
        ...cleaned,
        // Never persist secret-like fields if a buggy client sent them.
        credentialEnvVars: (cleaned.credentialEnvVars ?? defaults?.envVars ?? [])
          .filter((name) => !/value|token|secret|password/i.test(name)),
        baseUrl: sanitizeBaseUrl(cleaned.baseUrl) ?? defaults?.baseUrl,
        model: sanitizeModel(cleaned.model) ?? defaults?.model,
        updatedAt: at,
      };
    }),
  };
  writeJsonAtomic(providerConfigPath(location), next);
  return next;
}

export function emptyProviderSecrets(updatedAt = nowIso()): ProviderSecretsFile {
  return { schemaVersion: 1, updatedAt, providers: {} };
}

export function readProviderSecrets(location: GoalLoopConfigLocation): ProviderSecretsFile {
  const raw = readJsonFile<ProviderSecretsFile | undefined>(providerSecretsPath(location), undefined);
  if (!raw || typeof raw !== 'object') return emptyProviderSecrets();
  const providers: Record<string, ProviderSecretEntry> = {};
  if (raw.providers && typeof raw.providers === 'object') {
    for (const [id, entry] of Object.entries(raw.providers)) {
      if (!entry || typeof entry !== 'object') continue;
      const apiKey = typeof entry.apiKey === 'string' ? entry.apiKey.trim() : undefined;
      if (apiKey) providers[id] = { apiKey, updatedAt: entry.updatedAt };
    }
  }
  return { schemaVersion: 1, updatedAt: raw.updatedAt ?? nowIso(), providers };
}

export function writeProviderSecrets(location: GoalLoopConfigLocation, secrets: ProviderSecretsFile): ProviderSecretsFile {
  const at = nowIso();
  const next: ProviderSecretsFile = {
    schemaVersion: 1,
    updatedAt: at,
    providers: {},
  };
  for (const [id, entry] of Object.entries(secrets.providers ?? {})) {
    if (!REMOTE_API_PROVIDER_IDS.includes(id)) continue;
    const apiKey = typeof entry?.apiKey === 'string' ? entry.apiKey.trim() : '';
    if (!apiKey) continue;
    if (apiKey.length > 8_000) continue;
    next.providers[id] = { apiKey, updatedAt: at };
  }
  writeJsonAtomic(providerSecretsPath(location), next);
  return next;
}

export function getStoredProviderApiKey(location: GoalLoopConfigLocation, providerId: string): string | undefined {
  const secrets = readProviderSecrets(location);
  const key = secrets.providers[providerId]?.apiKey?.trim();
  return key || undefined;
}

export function hasStoredProviderApiKey(location: GoalLoopConfigLocation, providerId: string): boolean {
  return Boolean(getStoredProviderApiKey(location, providerId));
}

/** Last 4 chars only — safe for GUI status. */
export function maskApiKeyHint(apiKey: string | undefined): string | undefined {
  if (!apiKey || apiKey.length < 4) return apiKey ? '••••' : undefined;
  return `…${apiKey.slice(-4)}`;
}

export function setStoredProviderApiKey(
  location: GoalLoopConfigLocation,
  providerId: string,
  apiKey: string | null | undefined,
): ProviderSecretsFile {
  if (!REMOTE_API_PROVIDER_IDS.includes(providerId)) {
    throw new Error(`PROVIDER_NOT_REMOTE_API: ${providerId} does not support stored API keys`);
  }
  const secrets = readProviderSecrets(location);
  if (apiKey === null || apiKey === undefined || String(apiKey).trim() === '') {
    delete secrets.providers[providerId];
  } else {
    secrets.providers[providerId] = { apiKey: String(apiKey).trim(), updatedAt: nowIso() };
  }
  return writeProviderSecrets(location, secrets);
}

/**
 * Update non-secret API settings (baseUrl, model) on a remote provider preference.
 */
export function updateProviderApiPreference(
  location: GoalLoopConfigLocation,
  providerId: string,
  patch: { baseUrl?: string; model?: string },
): ProviderConfigFile {
  if (!REMOTE_API_PROVIDER_IDS.includes(providerId)) {
    throw new Error(`PROVIDER_NOT_REMOTE_API: ${providerId}`);
  }
  const config = readProviderConfig(location);
  const defaults = REMOTE_API_DEFAULTS[providerId]!;
  const providers = config.providers.map((p) => {
    if (p.providerId !== providerId) return p;
    return {
      ...p,
      baseUrl: patch.baseUrl !== undefined
        ? (sanitizeBaseUrl(patch.baseUrl) ?? defaults.baseUrl)
        : (p.baseUrl ?? defaults.baseUrl),
      model: patch.model !== undefined
        ? (sanitizeModel(patch.model) ?? defaults.model)
        : (p.model ?? defaults.model),
      updatedAt: nowIso(),
    };
  });
  if (!providers.some((p) => p.providerId === providerId)) {
    providers.push({
      providerId,
      enabled: true,
      priority: 50,
      baseUrl: sanitizeBaseUrl(patch.baseUrl) ?? defaults.baseUrl,
      model: sanitizeModel(patch.model) ?? defaults.model,
      credentialEnvVars: defaults.envVars,
      updatedAt: nowIso(),
    });
  }
  return writeProviderConfig(location, { ...config, providers });
}

export function resolveProviderAuthPresent(
  location: GoalLoopConfigLocation | undefined,
  providerId: string,
  env: NodeJS.ProcessEnv,
  envVarNames: string[],
): { envAuth: boolean; storedAuth: boolean; authPresent: boolean; apiKey?: string } {
  const envAuth = envVarNames.some((name) => Boolean(env[name]?.trim()));
  let storedKey: string | undefined;
  if (location) {
    try {
      storedKey = getStoredProviderApiKey(location, providerId);
    } catch {
      storedKey = undefined;
    }
  }
  const storedAuth = Boolean(storedKey);
  // Prefer env key when both present (ops convention).
  const apiKey = envVarNames.map((n) => env[n]?.trim()).find(Boolean) || storedKey;
  return { envAuth, storedAuth, authPresent: envAuth || storedAuth, apiKey };
}

export function readLocalToolConfig(location: GoalLoopConfigLocation): LocalToolConfigFile {
  return mergeToolDefaults(readJsonFile(localToolConfigPath(location), undefined));
}

export function writeLocalToolConfig(location: GoalLoopConfigLocation, config: LocalToolConfigFile): LocalToolConfigFile {
  const at = nowIso();
  const next = { ...mergeToolDefaults(config), updatedAt: at };
  writeJsonAtomic(localToolConfigPath(location), next);
  return next;
}

export function readRoutingConfig(location: GoalLoopConfigLocation): ExecutorRoutingConfigFile {
  return mergeRoutingDefaults(
    readJsonFile(routingConfigPath(location), undefined),
    readProviderConfig(location),
  );
}

export function writeRoutingConfig(location: GoalLoopConfigLocation, config: ExecutorRoutingConfigFile): ExecutorRoutingConfigFile {
  const at = nowIso();
  // Strip handoff-only from non-terminal direct slots? Allow handoff only at end — validated by facade.
  const next = { ...mergeRoutingDefaults(config, readProviderConfig(location)), updatedAt: at };
  writeJsonAtomic(routingConfigPath(location), next);
  return next;
}

/** Remove explicit routing overrides and resume generated provider-priority routing. */
export function resetRoutingConfig(location: GoalLoopConfigLocation): ExecutorRoutingConfigFile {
  rmSync(routingConfigPath(location), { force: true });
  return readRoutingConfig(location);
}

export function readGoalLoopPolicyConfig(location: GoalLoopConfigLocation): GoalLoopPolicyConfigFile {
  return mergePolicyDefaults(readJsonFile(policyConfigPath(location), undefined));
}

export function writeGoalLoopPolicyConfig(location: GoalLoopConfigLocation, config: GoalLoopPolicyConfigFile): GoalLoopPolicyConfigFile {
  const at = nowIso();
  const next = { ...mergePolicyDefaults(config), updatedAt: at };
  writeJsonAtomic(policyConfigPath(location), next);
  return next;
}

export function isProviderEnabledInConfig(config: ProviderConfigFile, providerId: string): boolean {
  const entry = config.providers.find((p) => p.providerId === providerId);
  if (!entry) return true;
  return entry.enabled !== false;
}

export function isLocalToolEnabledInConfig(config: LocalToolConfigFile, toolId: string): boolean {
  const entry = config.tools.find((t) => t.toolId === toolId);
  if (!entry) return true;
  return entry.enabled !== false;
}

export function providerPriorityMap(config: ProviderConfigFile): Map<string, number> {
  return new Map(config.providers.map((p) => [p.providerId, p.priority]));
}

export function sortProvidersByPriority<T extends { providerId: string }>(
  providers: T[],
  config: ProviderConfigFile,
): T[] {
  const priorities = providerPriorityMap(config);
  return [...providers].sort((a, b) => {
    const pa = priorities.get(a.providerId) ?? 500;
    const pb = priorities.get(b.providerId) ?? 500;
    if (pa !== pb) return pa - pb;
    return a.providerId.localeCompare(b.providerId);
  });
}

/** Effective live mode: env flag AND GUI preference. */
export function isLiveModelProvidersEffective(
  config: ProviderConfigFile,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const envEnabled = env.REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS === '1'
    || env.REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS === 'true';
  return envEnabled && config.preferLiveModelProviders === true;
}

export function liveModelProvidersEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS === '1'
    || env.REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS === 'true';
}
