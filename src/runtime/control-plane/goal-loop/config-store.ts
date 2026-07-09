import { mkdirSync } from 'fs';
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
  RoutingIntentKey,
} from './config-types';

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
    { providerId: 'codex_cli', enabled: true, priority: 20 },
    { providerId: 'grok_cli', enabled: true, priority: 25 },
    { providerId: 'claude_cli', enabled: true, priority: 30 },
    { providerId: 'grok_api', enabled: true, priority: 40, credentialEnvVars: ['XAI_API_KEY', 'REPO_HARNESS_XAI_API_KEY'] },
    { providerId: 'openai_api', enabled: true, priority: 50, credentialEnvVars: ['OPENAI_API_KEY', 'REPO_HARNESS_OPENAI_API_KEY'] },
    { providerId: 'deepseek_api', enabled: true, priority: 60, credentialEnvVars: ['DEEPSEEK_API_KEY', 'REPO_HARNESS_DEEPSEEK_API_KEY'] },
    { providerId: 'github_copilot_cloud', enabled: true, priority: 70 },
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

export function defaultRoutingConfig(updatedAt = nowIso()): ExecutorRoutingConfigFile {
  const orders: Record<RoutingIntentKey, string[]> = {
    deterministic_edit: ['direct_edit', 'codex_cli', 'grok_cli', 'chatgpt_handoff'],
    implementation: ['codex_cli', 'grok_cli', 'claude_cli', 'grok_api', 'openai_api', 'deepseek_api', 'github_copilot_cloud', 'chatgpt_handoff'],
    repair: ['grok_cli', 'grok_api', 'claude_cli', 'codex_cli', 'deepseek_api', 'openai_api', 'chatgpt_handoff'],
    planning: ['chatgpt_handoff', 'grok_cli', 'grok_api', 'openai_api', 'deepseek_api', 'claude_cli'],
    review: ['codex_cli', 'grok_cli', 'claude_cli', 'grok_api', 'openai_api', 'chatgpt_handoff'],
    browser_planning: ['codex_cli', 'grok_cli', 'claude_cli', 'grok_api', 'openai_api', 'chatgpt_handoff'],
    ios_analysis: ['codex_cli', 'grok_cli', 'claude_cli', 'grok_api', 'openai_api', 'chatgpt_handoff'],
    fallback: ['direct_edit', 'codex_cli', 'grok_cli', 'claude_cli', 'grok_api', 'openai_api', 'deepseek_api', 'github_copilot_cloud', 'chatgpt_handoff'],
  };
  return {
    schemaVersion: 1,
    updatedAt,
    orders,
    defaultImplementationProvider: 'codex_cli',
    defaultRepairProvider: 'grok_cli',
    defaultPlanningProvider: 'chatgpt_handoff',
    defaultReviewProvider: 'codex_cli',
    defaultBrowserPlanningProvider: 'codex_cli',
    defaultIosAnalysisProvider: 'codex_cli',
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
function localToolConfigPath(location: GoalLoopConfigLocation): string {
  return join(globalConfigRoot(location), 'local-tool-config.json');
}
function routingConfigPath(location: GoalLoopConfigLocation): string {
  return join(globalConfigRoot(location), 'executor-routing.json');
}
function policyConfigPath(location: GoalLoopConfigLocation): string {
  return join(globalConfigRoot(location), 'goal-loop-policy.json');
}

function mergeProviderDefaults(stored: ProviderConfigFile | undefined): ProviderConfigFile {
  const base = defaultProviderConfig(stored?.updatedAt ?? nowIso());
  if (!stored) return base;
  const byId = new Map(stored.providers.map((p) => [p.providerId, p]));
  const providers = base.providers.map((def) => {
    const existing = byId.get(def.providerId);
    if (!existing) return def;
    return {
      ...def,
      ...existing,
      providerId: def.providerId,
      // ChatGPT can never be "disabled" from handoff role; enabled only controls whether packets are preferred.
      enabled: def.providerId === 'chatgpt_handoff' ? true : existing.enabled !== false,
      priority: typeof existing.priority === 'number' ? existing.priority : def.priority,
    };
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

function mergeRoutingDefaults(stored: ExecutorRoutingConfigFile | undefined): ExecutorRoutingConfigFile {
  const base = defaultRoutingConfig(stored?.updatedAt ?? nowIso());
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
    providers: config.providers.map((p) => ({
      ...p,
      // Never persist secret-like fields if a buggy client sent them.
      credentialEnvVars: (p.credentialEnvVars ?? []).filter((name) => !/value|token|secret|password/i.test(name)),
      updatedAt: at,
    })),
  };
  writeJsonAtomic(providerConfigPath(location), next);
  return next;
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
  return mergeRoutingDefaults(readJsonFile(routingConfigPath(location), undefined));
}

export function writeRoutingConfig(location: GoalLoopConfigLocation, config: ExecutorRoutingConfigFile): ExecutorRoutingConfigFile {
  const at = nowIso();
  // Strip handoff-only from non-terminal direct slots? Allow handoff only at end — validated by facade.
  const next = { ...mergeRoutingDefaults(config), updatedAt: at };
  writeJsonAtomic(routingConfigPath(location), next);
  return next;
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
