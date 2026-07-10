import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import type {
  ProviderCapability,
  ProviderDescriptor,
  ProviderHealthReport,
  ProviderKind,
  ProviderLimits,
  ProviderSafety,
  ProviderStatus,
} from './types';

import {
  isLiveModelProvidersEffective,
  isLocalToolEnabledInConfig,
  isProviderEnabledInConfig,
  readLocalToolConfig,
  readProviderConfig,
  REMOTE_API_DEFAULTS,
  resolveProviderAuthPresent,
  sortProvidersByPriority,
  type GoalLoopConfigLocation,
} from './config-store';

export interface ProviderRegistryEnv {
  env?: NodeJS.ProcessEnv;
  /** Injected availability overrides for tests (never used to store secrets). */
  overrides?: Partial<Record<string, Partial<ProviderDescriptor>>>;
  /** When true, skip process/PATH probes (tests). */
  skipExecutableProbe?: boolean;
  /** Optional mock health map for tests. */
  mockHealth?: Partial<Record<string, Partial<ProviderHealthReport>>>;
  /** Load enable/disable + priority + live preference from controllerHome/global. */
  configLocation?: GoalLoopConfigLocation;
  /**
   * When set, overrides computed live-effective flag for remote APIs.
   * Prefer using configLocation + env in production.
   */
  liveModelProvidersEffective?: boolean;
}

const DEFAULT_LIMITS: ProviderLimits = {
  maxContextChars: 80_000,
  maxRuntimeMs: 600_000,
  maxPatchFiles: 40,
  maxChangedLines: 2_000,
};

/** Local/cloud agent CLIs are full executors: they may edit files and run commands. */
const AGENT_CLI_LIMITS: ProviderLimits = {
  maxContextChars: 200_000,
  maxRuntimeMs: 1_800_000,
  maxPatchFiles: 500,
  maxChangedLines: 50_000,
};

const AGENT_CLI_SAFETY: ProviderSafety = {
  mayMutateFiles: true,
  mayRunCommands: true,
  requiresApplyByRepoHarness: false,
  requiresApprovalForExternalEffects: true,
};

/** Remote model APIs only return proposals; repo-harness applies patches. */
const APPLY_BY_HARNESS: ProviderSafety = {
  mayMutateFiles: false,
  mayRunCommands: false,
  requiresApplyByRepoHarness: true,
  requiresApprovalForExternalEffects: true,
};

function hasAnyKey(env: NodeJS.ProcessEnv, keys: string[]): boolean {
  return keys.some((key) => Boolean(env[key]?.trim()));
}

function commandExists(command: string, skip?: boolean): boolean {
  if (skip) return false;
  try {
    if (process.platform === 'win32') {
      execFileSync('where', [command], { stdio: 'ignore', timeout: 2_000 });
    } else {
      execFileSync('which', [command], { stdio: 'ignore', timeout: 2_000 });
    }
    return true;
  } catch {
    // Fallback: common install prefixes (incl. user-local grok/codex-style bins).
    return (
      existsSync(`/usr/local/bin/${command}`)
      || existsSync(`/opt/homebrew/bin/${command}`)
      || existsSync(join(homedir(), '.local', 'bin', command))
    );
  }
}

function baseProvider(
  providerId: string,
  kind: ProviderKind,
  modelFamily: ProviderDescriptor['modelFamily'],
  status: ProviderStatus,
  capabilities: ProviderCapability[],
  summary: string,
  extras: Partial<ProviderDescriptor> = {},
): ProviderDescriptor {
  const directDispatch =
    extras.directDispatch
    ?? (kind !== 'handoff_only' && status === 'ready');
  return {
    providerId,
    kind,
    modelFamily,
    status,
    capabilities,
    limits: extras.limits ?? DEFAULT_LIMITS,
    safety: extras.safety ?? APPLY_BY_HARNESS,
    directDispatch,
    summary,
    configured: extras.configured,
    authPresent: extras.authPresent,
    lastErrorCode: extras.lastErrorCode,
    rateLimited: extras.rateLimited,
  };
}

function remoteDirectAllowed(
  authPresent: boolean,
  liveEffective: boolean,
): { status: ProviderStatus; directDispatch: boolean; lastErrorCode?: string; summarySuffix: string } {
  if (!authPresent) {
    return { status: 'missing_auth', directDispatch: false, lastErrorCode: undefined, summarySuffix: '' };
  }
  if (!liveEffective) {
    return {
      status: 'ready',
      directDispatch: false,
      lastErrorCode: 'LIVE_CALLS_DISABLED',
      summarySuffix: ' Credential present; live model API calls are disabled (env + preference both required).',
    };
  }
  return { status: 'ready', directDispatch: true, summarySuffix: ' Direct dispatch allowed.' };
}

/**
 * Build the model/code executor registry.
 * ChatGPT current conversation is always handoff_only (never direct-invokable).
 * User config (enable/disable/priority/live preference) is applied when configLocation is set.
 */
export function listProviders(options: ProviderRegistryEnv = {}): ProviderDescriptor[] {
  const env = options.env ?? process.env;
  const skipProbe = options.skipExecutableProbe === true;
  const providerConfig = options.configLocation ? readProviderConfig(options.configLocation) : undefined;
  const toolConfig = options.configLocation ? readLocalToolConfig(options.configLocation) : undefined;
  const liveEffective = options.liveModelProvidersEffective
    ?? (providerConfig ? isLiveModelProvidersEffective(providerConfig, env) : false);

  const codexReady = commandExists('codex', skipProbe);
  const claudeReady = commandExists('claude', skipProbe);
  const grokCliReady = commandExists('grok', skipProbe);
  const ghReady = commandExists('gh', skipProbe);

  const configLoc = options.configLocation;
  const grokAuthInfo = resolveProviderAuthPresent(
    configLoc,
    'grok_api',
    env,
    REMOTE_API_DEFAULTS.grok_api!.envVars,
  );
  const deepseekAuthInfo = resolveProviderAuthPresent(
    configLoc,
    'deepseek_api',
    env,
    REMOTE_API_DEFAULTS.deepseek_api!.envVars,
  );
  const openaiAuthInfo = resolveProviderAuthPresent(
    configLoc,
    'openai_api',
    env,
    REMOTE_API_DEFAULTS.openai_api!.envVars,
  );
  // Fall back to env-only when no configLocation (unit tests without secrets store).
  const grokAuth = grokAuthInfo.authPresent || (!configLoc && hasAnyKey(env, REMOTE_API_DEFAULTS.grok_api!.envVars));
  const deepseekAuth = deepseekAuthInfo.authPresent || (!configLoc && hasAnyKey(env, REMOTE_API_DEFAULTS.deepseek_api!.envVars));
  const openaiAuth = openaiAuthInfo.authPresent || (!configLoc && hasAnyKey(env, REMOTE_API_DEFAULTS.openai_api!.envVars));

  const grokRemote = remoteDirectAllowed(grokAuth, liveEffective);
  const deepseekRemote = remoteDirectAllowed(deepseekAuth, liveEffective);
  const openaiRemote = remoteDirectAllowed(openaiAuth, liveEffective);

  const directEditEnabled = toolConfig ? isLocalToolEnabledInConfig(toolConfig, 'direct_edit') : true;
  const codexToolEnabled = toolConfig ? isLocalToolEnabledInConfig(toolConfig, 'codex_cli') : true;
  const claudeToolEnabled = toolConfig ? isLocalToolEnabledInConfig(toolConfig, 'claude_cli') : true;
  const grokCliToolEnabled = toolConfig ? isLocalToolEnabledInConfig(toolConfig, 'grok_cli') : true;

  const providers: ProviderDescriptor[] = [
    baseProvider(
      'direct_edit',
      'direct_edit',
      'none',
      directEditEnabled ? 'ready' : 'disabled',
      ['code_patch', 'local_file_mutation'],
      directEditEnabled
        ? 'Bounded direct edit applied by repo-harness for deterministic small source changes.'
        : 'Direct edit disabled in local tool configuration.',
      {
        directDispatch: directEditEnabled,
        configured: true,
        authPresent: true,
        safety: {
          mayMutateFiles: true,
          mayRunCommands: false,
          requiresApplyByRepoHarness: true,
          requiresApprovalForExternalEffects: true,
        },
        limits: { ...DEFAULT_LIMITS, maxPatchFiles: 3, maxChangedLines: 200 },
        lastErrorCode: directEditEnabled ? undefined : 'TOOL_DISABLED',
      },
    ),
    baseProvider(
      'codex_cli',
      'local_cli',
      'codex',
      !codexToolEnabled ? 'disabled' : codexReady ? 'ready' : 'unavailable',
      ['code_patch', 'code_review', 'test_failure_repair', 'structured_output', 'tool_calling', 'local_file_mutation'],
      !codexToolEnabled
        ? 'Codex CLI disabled in local tool configuration.'
        : codexReady
          ? 'Local Codex CLI agent: may edit files and run commands; repo-harness still owns policy, verification, and external side effects.'
          : 'Codex CLI not found on PATH.',
      {
        configured: codexReady,
        authPresent: codexReady,
        directDispatch: codexToolEnabled && codexReady,
        safety: AGENT_CLI_SAFETY,
        limits: AGENT_CLI_LIMITS,
        lastErrorCode: !codexToolEnabled ? 'TOOL_DISABLED' : codexReady ? undefined : 'CODEX_CLI_UNAVAILABLE',
      },
    ),
    baseProvider(
      'claude_cli',
      'local_cli',
      'claude',
      !claudeToolEnabled ? 'disabled' : claudeReady ? 'ready' : 'unavailable',
      ['code_patch', 'code_review', 'test_failure_repair', 'long_context', 'structured_output', 'tool_calling', 'local_file_mutation'],
      !claudeToolEnabled
        ? 'Claude CLI disabled in local tool configuration.'
        : claudeReady
          ? 'Local Claude CLI agent: may edit files and run commands; repo-harness still owns policy, verification, and external side effects.'
          : 'Claude CLI not found on PATH.',
      {
        configured: claudeReady,
        authPresent: claudeReady,
        directDispatch: claudeToolEnabled && claudeReady,
        safety: AGENT_CLI_SAFETY,
        limits: AGENT_CLI_LIMITS,
        lastErrorCode: !claudeToolEnabled ? 'TOOL_DISABLED' : claudeReady ? undefined : 'CLAUDE_CLI_UNAVAILABLE',
      },
    ),
    baseProvider(
      'grok_cli',
      'local_cli',
      'grok',
      !grokCliToolEnabled ? 'disabled' : grokCliReady ? 'ready' : 'unavailable',
      ['code_patch', 'code_review', 'test_failure_repair', 'architecture_planning', 'structured_output', 'tool_calling', 'long_context', 'local_file_mutation'],
      !grokCliToolEnabled
        ? 'Grok CLI disabled in local tool configuration.'
        : grokCliReady
          ? 'Local Grok CLI agent: may edit files and run commands (no live remote API flag required); repo-harness still owns policy and verification.'
          : 'Grok CLI not found on PATH (install Grok Build TUI `grok` binary).',
      {
        configured: grokCliReady,
        authPresent: grokCliReady,
        directDispatch: grokCliToolEnabled && grokCliReady,
        safety: AGENT_CLI_SAFETY,
        limits: AGENT_CLI_LIMITS,
        lastErrorCode: !grokCliToolEnabled ? 'TOOL_DISABLED' : grokCliReady ? undefined : 'GROK_CLI_UNAVAILABLE',
      },
    ),
    baseProvider(
      'github_copilot_cloud',
      'cloud_agent',
      'github_copilot',
      ghReady ? 'ready' : 'unavailable',
      ['code_patch', 'code_review', 'remote_side_effects', 'local_file_mutation'],
      ghReady
        ? 'GitHub Copilot cloud agent may mutate its worktree/files; external publish still needs approval.'
        : 'GitHub CLI (gh) unavailable for Copilot cloud sessions.',
      {
        configured: ghReady,
        authPresent: ghReady,
        safety: AGENT_CLI_SAFETY,
        limits: AGENT_CLI_LIMITS,
        lastErrorCode: ghReady ? undefined : 'GITHUB_CLI_UNAVAILABLE',
      },
    ),
    baseProvider(
      'grok_api',
      'remote_api',
      'grok',
      grokRemote.status,
      ['code_patch', 'code_review', 'architecture_planning', 'test_failure_repair', 'structured_output', 'long_context'],
      (grokAuth
        ? 'Grok/xAI API credential present (proposal-only; repo-harness applies patches).'
        : 'Grok/xAI API missing auth (set XAI_API_KEY or configure in GUI).')
        + grokRemote.summarySuffix,
      {
        configured: grokAuth,
        authPresent: grokAuth,
        directDispatch: grokRemote.directDispatch,
        safety: APPLY_BY_HARNESS,
        lastErrorCode: grokAuth ? grokRemote.lastErrorCode : 'MISSING_XAI_API_KEY',
      },
    ),
    baseProvider(
      'deepseek_api',
      'remote_api',
      'deepseek',
      deepseekRemote.status,
      ['code_patch', 'code_review', 'architecture_planning', 'structured_output', 'tool_calling'],
      (deepseekAuth
        ? 'DeepSeek API credential present (proposal-only; repo-harness applies patches).'
        : 'DeepSeek API missing auth (set DEEPSEEK_API_KEY or configure in GUI).')
        + deepseekRemote.summarySuffix,
      {
        configured: deepseekAuth,
        authPresent: deepseekAuth,
        directDispatch: deepseekRemote.directDispatch,
        safety: APPLY_BY_HARNESS,
        lastErrorCode: deepseekAuth ? deepseekRemote.lastErrorCode : 'MISSING_DEEPSEEK_API_KEY',
      },
    ),
    baseProvider(
      'openai_api',
      'remote_api',
      'openai',
      openaiRemote.status,
      ['code_patch', 'code_review', 'architecture_planning', 'structured_output', 'long_context'],
      (openaiAuth
        ? 'OpenAI API credential present (proposal-only; repo-harness applies patches).'
        : 'OpenAI API missing auth (set OPENAI_API_KEY or configure in GUI).')
        + openaiRemote.summarySuffix,
      {
        configured: openaiAuth,
        authPresent: openaiAuth,
        directDispatch: openaiRemote.directDispatch,
        safety: APPLY_BY_HARNESS,
        lastErrorCode: openaiAuth ? openaiRemote.lastErrorCode : 'MISSING_OPENAI_API_KEY',
      },
    ),
    baseProvider(
      'chatgpt_handoff',
      'handoff_only',
      'chatgpt_handoff',
      'handoff_only',
      ['architecture_planning', 'code_review', 'long_context', 'browser_planning'],
      'Current ChatGPT conversation is handoff-only; not directly invokable via local CLI/API. repo-harness can create continuation packets, but cannot automatically invoke this ChatGPT session.',
      {
        directDispatch: false,
        configured: true,
        authPresent: false,
        lastErrorCode: 'HANDOFF_ONLY_SUPERVISOR',
      },
    ),
  ];

  // Apply user provider enable/disable from config.
  if (providerConfig) {
    for (const provider of providers) {
      if (provider.providerId === 'chatgpt_handoff') {
        provider.directDispatch = false;
        continue;
      }
      if (!isProviderEnabledInConfig(providerConfig, provider.providerId)) {
        provider.status = 'disabled';
        provider.directDispatch = false;
        provider.lastErrorCode = 'PROVIDER_DISABLED';
        provider.summary = `${provider.providerId} disabled in provider configuration.`;
      }
    }
  }

  if (options.overrides) {
    for (const provider of providers) {
      const override = options.overrides[provider.providerId];
      if (!override) continue;
      Object.assign(provider, override);
      const kind = provider.kind;
      const status = provider.status;
      if (status === 'handoff_only' || kind === 'handoff_only' || provider.providerId === 'chatgpt_handoff') {
        provider.directDispatch = false;
      } else if (override.directDispatch !== undefined) {
        provider.directDispatch = override.directDispatch;
      } else {
        provider.directDispatch = status === 'ready';
      }
    }
  }

  // Always force ChatGPT handoff-only after all overrides.
  const chat = providers.find((p) => p.providerId === 'chatgpt_handoff');
  if (chat) {
    chat.kind = 'handoff_only';
    chat.status = 'handoff_only';
    chat.directDispatch = false;
  }

  return providerConfig ? sortProvidersByPriority(providers, providerConfig) : providers;
}

export function getProvider(
  providerId: string,
  options: ProviderRegistryEnv = {},
): ProviderDescriptor | undefined {
  return listProviders(options).find((provider) => provider.providerId === providerId);
}

export function checkProviderHealth(
  providerId: string,
  options: ProviderRegistryEnv = {},
): ProviderHealthReport {
  const mock = options.mockHealth?.[providerId];
  if (mock?.providerId || mock?.status) {
    const provider = getProvider(providerId, options);
    return {
      providerId,
      configured: mock.configured ?? provider?.configured ?? false,
      authPresent: mock.authPresent ?? provider?.authPresent ?? false,
      executableOrApiReachable: mock.executableOrApiReachable ?? provider?.status === 'ready',
      modelAvailable: mock.modelAvailable ?? (provider?.status === 'ready' ? true : 'skipped'),
      lastErrorCode: mock.lastErrorCode ?? provider?.lastErrorCode,
      rateLimitState: mock.rateLimitState ?? (provider?.rateLimited ? 'limited' : 'unknown'),
      directDispatchAllowed: mock.directDispatchAllowed
        ?? (provider?.directDispatch === true && provider.status === 'ready'),
      handoffOnly: mock.handoffOnly ?? provider?.kind === 'handoff_only',
      status: mock.status ?? provider?.status ?? 'unavailable',
      summary: mock.summary ?? provider?.summary ?? 'Unknown provider',
      redacted: true,
    };
  }

  const provider = getProvider(providerId, options);
  if (!provider) {
    return {
      providerId,
      configured: false,
      authPresent: false,
      executableOrApiReachable: false,
      modelAvailable: false,
      lastErrorCode: 'PROVIDER_NOT_FOUND',
      rateLimitState: 'unknown',
      directDispatchAllowed: false,
      handoffOnly: false,
      status: 'unavailable',
      summary: `Provider ${providerId} is not registered.`,
      redacted: true,
    };
  }

  const handoffOnly = provider.kind === 'handoff_only' || provider.status === 'handoff_only';
  const ready = provider.status === 'ready';
  return {
    providerId: provider.providerId,
    configured: provider.configured !== false,
    authPresent: provider.authPresent === true,
    executableOrApiReachable: ready || handoffOnly,
    modelAvailable: ready ? true : handoffOnly ? 'skipped' : false,
    lastErrorCode: provider.lastErrorCode,
    rateLimitState: provider.rateLimited ? 'limited' : 'unknown',
    directDispatchAllowed: provider.directDispatch === true && ready && !handoffOnly,
    handoffOnly,
    status: provider.status,
    summary: provider.summary,
    redacted: true,
  };
}

export function listProviderHealth(options: ProviderRegistryEnv = {}): ProviderHealthReport[] {
  return listProviders(options).map((provider) => checkProviderHealth(provider.providerId, options));
}

export function providerConfigStatus(options: ProviderRegistryEnv = {}): {
  invokable: Array<{ providerId: string; status: ProviderStatus; summary: string }>;
  handoffOnly: Array<{ providerId: string; status: ProviderStatus; summary: string }>;
  missingAuth: Array<{ providerId: string; lastErrorCode?: string; summary: string }>;
  redacted: true;
} {
  const providers = listProviders(options);
  return {
    invokable: providers
      .filter((p) => p.directDispatch && p.status === 'ready')
      .map((p) => ({ providerId: p.providerId, status: p.status, summary: p.summary })),
    handoffOnly: providers
      .filter((p) => p.kind === 'handoff_only' || p.status === 'handoff_only')
      .map((p) => ({ providerId: p.providerId, status: p.status, summary: p.summary })),
    missingAuth: providers
      .filter((p) => p.status === 'missing_auth')
      .map((p) => ({ providerId: p.providerId, lastErrorCode: p.lastErrorCode, summary: p.summary })),
    redacted: true,
  };
}

/**
 * Assert that a redacted summary never contains common secret patterns.
 * Used by tests and handoff sanitization.
 */
export function assertNoSecretsInText(text: string): boolean {
  const patterns = [
    /sk-[a-zA-Z0-9]{10,}/,
    /xai-[a-zA-Z0-9]{10,}/,
    /Bearer\s+[a-zA-Z0-9._-]{10,}/i,
    /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i,
    /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  ];
  return !patterns.some((pattern) => pattern.test(text));
}

export function redactProviderSummary(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/sk-[a-zA-Z0-9]{10,}/g, '[REDACTED]')
      .replace(/xai-[a-zA-Z0-9]{10,}/g, '[REDACTED]')
      .replace(/Bearer\s+[a-zA-Z0-9._-]{10,}/gi, 'Bearer [REDACTED]')
      .replace(/(api[_-]?key\s*[:=]\s*)(['"]?)[^'"\s]+(['"]?)/gi, '$1$2[REDACTED]$3');
  }
  if (Array.isArray(value)) return value.map(redactProviderSummary);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|authorization|api[_-]?key/i.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactProviderSummary(entry);
      }
    }
    return out;
  }
  return value;
}
