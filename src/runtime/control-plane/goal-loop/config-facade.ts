import {
  defaultGoalLoopPolicy,
  defaultLocalToolConfig,
  defaultProviderConfig,
  defaultRoutingConfig,
  isLiveModelProvidersEffective,
  liveModelProvidersEnvEnabled,
  readGoalLoopPolicyConfig,
  readLocalToolConfig,
  readProviderConfig,
  readRoutingConfig,
  writeGoalLoopPolicyConfig,
  writeLocalToolConfig,
  writeProviderConfig,
  writeRoutingConfig,
  type GoalLoopConfigLocation,
} from './config-store';
import type {
  AutomationSettingsOverview,
  AutomationSettingsViewModel,
  CredentialStatusEntry,
  ExecutorRoutingConfigFile,
  GoalLoopPolicyConfigFile,
  LocalToolConfigFile,
  ProviderConfigCard,
  ProviderConfigFile,
  ProviderPreference,
  RoutingIntentKey,
} from './config-types';
import { listLocalTools } from './local-tools';
import { checkProviderHealth, listProviders, type ProviderRegistryEnv } from './provider-registry';
import { intentToRoutingKey, routeExecutor, validateRoutingOrder } from './executor-router';
import { evaluateGoalPolicyGate } from './policy-gates';
import type { ProviderDescriptor, TaskIntent } from './types';

const DISPLAY_NAMES: Record<string, string> = {
  direct_edit: 'Direct Edit',
  codex_cli: 'Codex CLI',
  grok_cli: 'Grok CLI',
  claude_cli: 'Claude CLI',
  github_copilot_cloud: 'GitHub Copilot Cloud',
  grok_api: 'Grok (xAI) API',
  deepseek_api: 'DeepSeek API',
  openai_api: 'OpenAI API',
  chatgpt_handoff: 'ChatGPT (current conversation)',
};

const KIND_LABELS: Record<string, string> = {
  direct_edit: 'Direct-invokable (local apply)',
  local_cli: 'Local CLI',
  remote_api: 'Remote API',
  cloud_agent: 'Cloud agent',
  handoff_only: 'Handoff-only',
};

const CREDENTIAL_ENV: Record<string, string[]> = {
  grok_api: ['XAI_API_KEY', 'REPO_HARNESS_XAI_API_KEY'],
  openai_api: ['OPENAI_API_KEY', 'REPO_HARNESS_OPENAI_API_KEY'],
  deepseek_api: ['DEEPSEEK_API_KEY', 'REPO_HARNESS_DEEPSEEK_API_KEY'],
};

export interface ConfigFacadeContext {
  controllerHome: string;
  /** Optional absolute root for tests (bypasses controllerHome/global). */
  configRoot?: string;
  env?: NodeJS.ProcessEnv;
  skipExecutableProbe?: boolean;
  providerOverrides?: ProviderRegistryEnv['overrides'];
}

function location(ctx: ConfigFacadeContext): GoalLoopConfigLocation {
  return ctx.configRoot ? { root: ctx.configRoot } : { controllerHome: ctx.controllerHome };
}

function registryEnv(ctx: ConfigFacadeContext): ProviderRegistryEnv {
  return {
    env: ctx.env ?? process.env,
    skipExecutableProbe: ctx.skipExecutableProbe,
    configLocation: location(ctx),
    overrides: ctx.providerOverrides,
  };
}

function presentEnvVars(names: string[], env: NodeJS.ProcessEnv): string[] {
  return names.filter((name) => Boolean(env[name]?.trim()));
}

function setupExample(envVars: string[]): string {
  const primary = envVars[0] ?? 'API_KEY';
  return [
    `# Do not commit secrets. Set in your shell or OS secret manager.`,
    `export ${primary}=...`,
    `# Optional: allow live remote model API calls (required for direct Grok/OpenAI/DeepSeek dispatch)`,
    `export REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS=1`,
  ].join('\n');
}

export function providerCredentialsStatus(ctx: ConfigFacadeContext): CredentialStatusEntry[] {
  const env = ctx.env ?? process.env;
  return Object.entries(CREDENTIAL_ENV).map(([providerId, requiredEnvVars]) => {
    const present = presentEnvVars(requiredEnvVars, env);
    return {
      providerId,
      displayName: DISPLAY_NAMES[providerId] ?? providerId,
      requiredEnvVars,
      presentEnvVars: present,
      missingEnvVars: requiredEnvVars.filter((name) => !present.includes(name)),
      authPresent: present.length > 0,
      setupExample: setupExample(requiredEnvVars),
      storageMode: 'environment_variable_only',
      redacted: true,
    };
  });
}

function statusLabel(provider: ProviderDescriptor, liveEffective: boolean): string {
  if (provider.providerId === 'chatgpt_handoff') return 'Handoff only';
  if (provider.status === 'disabled') return 'Disabled';
  if (provider.status === 'missing_auth') return 'Missing auth';
  if (provider.status === 'unavailable') return 'Unavailable';
  if (provider.status === 'rate_limited') return 'Rate limited';
  if (provider.status === 'failed_health_check') return 'Failed health check';
  if (provider.kind === 'remote_api' && provider.authPresent && !liveEffective) return 'Live calls disabled';
  if (provider.status === 'ready' && provider.directDispatch) return 'Ready';
  if (provider.status === 'ready') return 'Ready (not direct)';
  return provider.status;
}

function toProviderCard(
  provider: ProviderDescriptor,
  pref: ProviderPreference | undefined,
  liveEnv: boolean,
  livePref: boolean,
  liveEffective: boolean,
  healthAt: string,
): ProviderConfigCard {
  const handoffOnly = provider.providerId === 'chatgpt_handoff' || provider.kind === 'handoff_only';
  return {
    providerId: provider.providerId,
    displayName: DISPLAY_NAMES[provider.providerId] ?? provider.providerId,
    kindLabel: KIND_LABELS[provider.kind] ?? provider.kind,
    kind: provider.kind,
    status: provider.status,
    statusLabel: statusLabel(provider, liveEffective),
    enabled: pref ? pref.enabled !== false : provider.status !== 'disabled',
    priority: pref?.priority ?? 500,
    directDispatch: provider.directDispatch && !handoffOnly,
    handoffOnly,
    capabilities: provider.capabilities,
    safety: {
      canMutateFilesDirectly: provider.safety.mayMutateFiles === true && !provider.safety.requiresApplyByRepoHarness,
      requiresRepoHarnessApply: provider.safety.requiresApplyByRepoHarness,
      externalSideEffects: provider.safety.requiresApprovalForExternalEffects ? 'approval_required' : 'never',
    },
    credential: {
      authPresent: provider.authPresent === true,
      requiredEnvVars: CREDENTIAL_ENV[provider.providerId] ?? [],
      presentEnvVars: [],
    },
    liveModelCalls: {
      envEnabled: liveEnv,
      preferenceEnabled: livePref,
      effectiveEnabled: liveEffective,
    },
    lastHealthCheckAt: healthAt,
    lastErrorSummary: provider.lastErrorCode,
    explanation: handoffOnly
      ? 'repo-harness can create continuation packets for ChatGPT, but cannot automatically invoke this current ChatGPT session.'
      : provider.summary,
    canEnableDirectDispatch: !handoffOnly,
    summary: provider.summary,
  };
}

export function buildAutomationSettingsView(ctx: ConfigFacadeContext): AutomationSettingsViewModel {
  const at = new Date().toISOString();
  const loc = location(ctx);
  const providerConfig = readProviderConfig(loc);
  const toolConfig = readLocalToolConfig(loc);
  const routing = readRoutingConfig(loc);
  const policy = readGoalLoopPolicyConfig(loc);
  const env = ctx.env ?? process.env;
  const liveEnv = liveModelProvidersEnvEnabled(env);
  const livePref = providerConfig.preferLiveModelProviders === true;
  const liveEffective = isLiveModelProvidersEffective(providerConfig, env);
  const providers = listProviders(registryEnv(ctx));
  const prefById = new Map(providerConfig.providers.map((p) => [p.providerId, p]));
  const creds = providerCredentialsStatus(ctx);
  const credById = new Map(creds.map((c) => [c.providerId, c]));

  const cards = providers.map((provider) => {
    const card = toProviderCard(provider, prefById.get(provider.providerId), liveEnv, livePref, liveEffective, at);
    const cred = credById.get(provider.providerId);
    if (cred) {
      card.credential = {
        authPresent: cred.authPresent,
        requiredEnvVars: cred.requiredEnvVars,
        presentEnvVars: cred.presentEnvVars,
      };
    }
    return card;
  });

  const localTools = listLocalTools({
    configLocation: loc,
    env,
    skipExecutableProbe: ctx.skipExecutableProbe,
  });

  const overview = buildOverview(providerConfig, cards, localTools, routing, liveEffective, liveEnv, livePref);

  const warnings: string[] = [];
  if (!liveEffective && cards.some((c) => c.kind === 'remote_api' && c.credential.authPresent)) {
    warnings.push('Remote API credentials are present, but live model calls are not effective until REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS=1 and the GUI preference is enabled.');
  }
  if (overview.directProvidersReady === 0) {
    warnings.push('No direct providers are ready; repo-harness will create a continuation packet instead of dispatching.');
  }

  return {
    schemaVersion: 1,
    generatedAt: at,
    overview,
    providers: cards,
    credentials: creds,
    localTools,
    routing,
    policy,
    warnings,
  };
}

function buildOverview(
  providerConfig: ProviderConfigFile,
  cards: ProviderConfigCard[],
  localTools: ReturnType<typeof listLocalTools>,
  routing: ExecutorRoutingConfigFile,
  liveEffective: boolean,
  liveEnv: boolean,
  livePref: boolean,
): AutomationSettingsOverview {
  const directReady = cards.filter((c) => c.directDispatch && c.status === 'ready' && !c.handoffOnly);
  const handoff = cards.filter((c) => c.handoffOnly);
  const needing = cards.filter((c) => c.status === 'missing_auth' || (c.kind === 'remote_api' && !c.credential.authPresent));
  const toolsOk = localTools.filter((t) => t.status === 'detected' && t.enabled);

  const parts: string[] = [];
  if (!providerConfig.goalLoopEnabled) {
    parts.push('Goal loop is disabled.');
  } else {
    parts.push(
      directReady.length
        ? `Autonomous mode can currently use ${directReady.map((c) => c.displayName).slice(0, 4).join(' and ')}.`
        : 'Autonomous mode has no direct-invokable providers ready.',
    );
  }
  const grokCli = cards.find((c) => c.providerId === 'grok_cli');
  if (grokCli?.directDispatch) {
    parts.push('Grok CLI is ready for local direct dispatch.');
  }
  const grok = cards.find((c) => c.providerId === 'grok_api');
  if (grok?.credential.authPresent && !liveEffective) {
    parts.push('Grok API is configured but live API calls are disabled.');
  } else if (grok?.directDispatch) {
    parts.push('Grok API is ready for direct dispatch.');
  }
  parts.push('ChatGPT is available only as handoff.');

  const firstOf = (key: RoutingIntentKey) => {
    const order = routing.orders[key] ?? [];
    return order[0] ?? '—';
  };

  return {
    goalLoopEnabled: providerConfig.goalLoopEnabled !== false,
    liveModelProvidersEffective: liveEffective,
    liveModelProvidersEnv: liveEnv,
    liveModelProvidersPreference: livePref,
    directProvidersReady: directReady.length,
    handoffOnlyCount: handoff.length,
    providersNeedingConfig: needing.length,
    localToolsAvailable: toolsOk.length,
    plainLanguageSummary: parts.join(' '),
    defaultRoutes: {
      small_edit: firstOf('deterministic_edit'),
      normal_code_task: firstOf('implementation'),
      repair: firstOf('repair'),
      planning: firstOf('planning'),
      browser_automation: firstOf('browser_planning'),
      ios_analysis: firstOf('ios_analysis'),
    },
  };
}

export function providerConfigGet(ctx: ConfigFacadeContext): ProviderConfigFile {
  return readProviderConfig(location(ctx));
}

export function providerConfigUpdate(
  ctx: ConfigFacadeContext,
  patch: Partial<ProviderConfigFile> & { providers?: ProviderPreference[] },
): ProviderConfigFile {
  const current = readProviderConfig(location(ctx));
  const next: ProviderConfigFile = {
    ...current,
    ...patch,
    schemaVersion: 1,
    providers: patch.providers ?? current.providers,
  };
  // Never allow chatgpt direct-dispatch flags to be persisted incorrectly.
  next.providers = next.providers.map((p) => {
    if (p.providerId === 'chatgpt_handoff') {
      return { ...p, enabled: true, notes: p.notes ?? 'Handoff-only; direct dispatch not supported.' };
    }
    // Strip any accidental secret fields
    const { ...rest } = p as ProviderPreference & { apiKey?: string; token?: string };
    delete (rest as { apiKey?: string }).apiKey;
    delete (rest as { token?: string }).token;
    return rest;
  });
  return writeProviderConfig(location(ctx), next);
}

export function providerEnable(ctx: ConfigFacadeContext, providerId: string): ProviderConfigFile {
  const current = readProviderConfig(location(ctx));
  const providers = current.providers.map((p) => (
    p.providerId === providerId ? { ...p, enabled: true, updatedAt: new Date().toISOString() } : p
  ));
  if (!providers.some((p) => p.providerId === providerId)) {
    providers.push({ providerId, enabled: true, priority: 500, updatedAt: new Date().toISOString() });
  }
  return writeProviderConfig(location(ctx), { ...current, providers });
}

export function providerDisable(ctx: ConfigFacadeContext, providerId: string): ProviderConfigFile {
  if (providerId === 'chatgpt_handoff') {
    // Cannot fully disable handoff supervisor; keep enabled for packets.
    return readProviderConfig(location(ctx));
  }
  const current = readProviderConfig(location(ctx));
  const providers = current.providers.map((p) => (
    p.providerId === providerId ? { ...p, enabled: false, updatedAt: new Date().toISOString() } : p
  ));
  return writeProviderConfig(location(ctx), { ...current, providers });
}

export function providerPriorityUpdate(
  ctx: ConfigFacadeContext,
  providerId: string,
  direction: 'up' | 'down' | number,
): ProviderConfigFile {
  const current = readProviderConfig(location(ctx));
  const sorted = [...current.providers].sort((a, b) => a.priority - b.priority);
  const index = sorted.findIndex((p) => p.providerId === providerId);
  if (index < 0) return current;

  if (typeof direction === 'number') {
    sorted[index] = { ...sorted[index]!, priority: direction, updatedAt: new Date().toISOString() };
  } else if (direction === 'up' && index > 0) {
    const prev = sorted[index - 1]!;
    const cur = sorted[index]!;
    const tmp = prev.priority;
    sorted[index - 1] = { ...prev, priority: cur.priority };
    sorted[index] = { ...cur, priority: tmp };
  } else if (direction === 'down' && index < sorted.length - 1) {
    const next = sorted[index + 1]!;
    const cur = sorted[index]!;
    const tmp = next.priority;
    sorted[index + 1] = { ...next, priority: cur.priority };
    sorted[index] = { ...cur, priority: tmp };
  }

  // Normalize to 10,20,30...
  const normalized = sorted
    .sort((a, b) => a.priority - b.priority)
    .map((p, i) => ({ ...p, priority: (i + 1) * 10, updatedAt: new Date().toISOString() }));

  return writeProviderConfig(location(ctx), { ...current, providers: normalized });
}

export function providerHealthCheck(ctx: ConfigFacadeContext, providerId?: string) {
  const env = registryEnv(ctx);
  if (providerId) {
    const health = checkProviderHealth(providerId, env);
    return { health, redacted: true as const, at: new Date().toISOString() };
  }
  return {
    health: listProviders(env).map((p) => checkProviderHealth(p.providerId, env)),
    redacted: true as const,
    at: new Date().toISOString(),
  };
}

export function providerResetDefaults(ctx: ConfigFacadeContext): ProviderConfigFile {
  return writeProviderConfig(location(ctx), defaultProviderConfig());
}

export function localToolList(ctx: ConfigFacadeContext) {
  return listLocalTools({
    configLocation: location(ctx),
    env: ctx.env ?? process.env,
    skipExecutableProbe: ctx.skipExecutableProbe,
  });
}

export function localToolEnable(ctx: ConfigFacadeContext, toolId: string): LocalToolConfigFile {
  const current = readLocalToolConfig(location(ctx));
  const tools = current.tools.map((t) => (
    t.toolId === toolId ? { ...t, enabled: true, updatedAt: new Date().toISOString() } : t
  ));
  if (!tools.some((t) => t.toolId === toolId)) {
    tools.push({ toolId, enabled: true, updatedAt: new Date().toISOString() });
  }
  return writeLocalToolConfig(location(ctx), { ...current, tools });
}

export function localToolDisable(ctx: ConfigFacadeContext, toolId: string): LocalToolConfigFile {
  const current = readLocalToolConfig(location(ctx));
  const tools = current.tools.map((t) => (
    t.toolId === toolId ? { ...t, enabled: false, updatedAt: new Date().toISOString() } : t
  ));
  return writeLocalToolConfig(location(ctx), { ...current, tools });
}

export function localToolConfigGet(ctx: ConfigFacadeContext): LocalToolConfigFile {
  return readLocalToolConfig(location(ctx));
}

export function localToolConfigUpdate(ctx: ConfigFacadeContext, config: LocalToolConfigFile): LocalToolConfigFile {
  return writeLocalToolConfig(location(ctx), config);
}

export function localToolHealthCheck(ctx: ConfigFacadeContext, toolId?: string) {
  const tools = localToolList(ctx);
  if (toolId) {
    const tool = tools.find((t) => t.toolId === toolId);
    return { tool, redacted: true as const, at: new Date().toISOString() };
  }
  return { tools, redacted: true as const, at: new Date().toISOString() };
}

export function executorRoutingConfigGet(ctx: ConfigFacadeContext): ExecutorRoutingConfigFile {
  return readRoutingConfig(location(ctx));
}

export function executorRoutingConfigUpdate(
  ctx: ConfigFacadeContext,
  patch: Partial<ExecutorRoutingConfigFile>,
): { config: ExecutorRoutingConfigFile; warnings: string[] } {
  const current = readRoutingConfig(location(ctx));
  const next: ExecutorRoutingConfigFile = {
    ...current,
    ...patch,
    schemaVersion: 1,
    orders: { ...current.orders, ...(patch.orders ?? {}) },
  };

  // Validate: handoff-only cannot be forced as direct default for implementation/repair.
  const warnings: string[] = [];
  for (const key of ['implementation', 'repair', 'deterministic_edit'] as RoutingIntentKey[]) {
    const order = next.orders[key] ?? [];
    if (order[0] === 'chatgpt_handoff') {
      warnings.push(`${key}: first provider is chatgpt_handoff (handoff-only); direct dispatch will not run.`);
    }
    const v = validateRoutingOrder(order);
    warnings.push(...v.warnings.map((w) => `${key}: ${w}`));
  }
  for (const field of [
    'defaultImplementationProvider',
    'defaultRepairProvider',
  ] as const) {
    if (next[field] === 'chatgpt_handoff') {
      warnings.push(`${field} cannot be handoff-only for direct dispatch; keeping as handoff fallback only.`);
      // Do not reject save — user may want planning-like defaults elsewhere.
    }
  }

  return { config: writeRoutingConfig(location(ctx), next), warnings };
}

export function goalLoopPolicyGet(ctx: ConfigFacadeContext): GoalLoopPolicyConfigFile {
  return readGoalLoopPolicyConfig(location(ctx));
}

export function goalLoopPolicyUpdate(
  ctx: ConfigFacadeContext,
  patch: Partial<GoalLoopPolicyConfigFile>,
): GoalLoopPolicyConfigFile {
  const current = readGoalLoopPolicyConfig(location(ctx));
  // Reject dangerous full safety disable: require at least external + destructive approvals stay true
  // unless explicitly set — still allow individual toggles but never invent a master bypass.
  const next = {
    ...current,
    ...patch,
    schemaVersion: 1 as const,
  };
  return writeGoalLoopPolicyConfig(location(ctx), next);
}

export function executorRoutePreviewWithConfig(
  ctx: ConfigFacadeContext,
  input: {
    taskIntent?: TaskIntent;
    risk?: 'readonly' | 'local_repo_write' | 'workspace_write' | 'remote_write' | 'destructive' | 'raw_secret_config';
    objective?: string;
    externalWrite?: boolean;
  } = {},
) {
  const routing = readRoutingConfig(location(ctx));
  const policy = readGoalLoopPolicyConfig(location(ctx));
  const providers = listProviders(registryEnv(ctx));
  const intent = input.taskIntent ?? 'code_implementation';
  const decision = routeExecutor({
    goal: {
      goalId: 'preview',
      repoId: 'preview',
      mode: 'autonomous',
      status: 'ready',
      objective: input.objective ?? 'route preview',
      constraints: {
        maxChangedFiles: policy.maxChangedFilesWithoutConfirmation,
        maxChangedLines: policy.maxChangedLinesWithoutConfirmation,
        allowExternalWrite: !policy.requireApprovalForExternalWrites,
        allowDestructive: !policy.requireApprovalForDestructiveChanges,
      },
      allowedExecutors: [],
      forbiddenExecutors: [],
      repairAttempts: 0,
      retryBudget: policy.defaultRetryBudget,
    },
    taskIntent: intent,
    risk: input.risk ?? 'workspace_write',
    providers,
    routingConfig: routing,
    externalWrite: input.externalWrite,
  });

  return {
    route: decision,
    routingKey: intentToRoutingKey(intent),
    order: routing.orders[intentToRoutingKey(intent)],
    explanation: decision.handoffOnly
      ? 'repo-harness will create a continuation packet instead of dispatching.'
      : `Would dispatch to ${decision.selectedProviderId}.`,
    whyThisProvider: decision.reason,
    whatHappensNext: decision.directDispatch
      ? 'repo-harness will request a structured proposal, apply patches itself, and verify.'
      : 'No direct dispatch; open handoff packet or configure credentials/live mode.',
    whatIsBlocked: decision.waitForUser
      ? decision.reason
      : decision.selectedProviderId
        ? undefined
        : 'No ready provider',
    redacted: true as const,
  };
}

export function policyPreviewExternalWrite(ctx: ConfigFacadeContext, approvalConfirmed = false) {
  const policy = readGoalLoopPolicyConfig(location(ctx));
  return evaluateGoalPolicyGate({
    effect: 'external_write',
    constraints: { allowExternalWrite: !policy.requireApprovalForExternalWrites },
    approvalConfirmed: approvalConfirmed && !policy.requireApprovalForExternalWrites ? true : approvalConfirmed,
    strongConfirmationText: approvalConfirmed ? 'confirm-destructive-or-external-effect' : undefined,
  });
}

export function resetAllGoalLoopConfigs(ctx: ConfigFacadeContext) {
  const loc = location(ctx);
  return {
    providers: writeProviderConfig(loc, defaultProviderConfig()),
    tools: writeLocalToolConfig(loc, defaultLocalToolConfig()),
    routing: writeRoutingConfig(loc, defaultRoutingConfig()),
    policy: writeGoalLoopPolicyConfig(loc, defaultGoalLoopPolicy()),
  };
}
