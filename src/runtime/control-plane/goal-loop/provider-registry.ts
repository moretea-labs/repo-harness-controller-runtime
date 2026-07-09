import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import type {
  ProviderCapability,
  ProviderDescriptor,
  ProviderHealthReport,
  ProviderKind,
  ProviderLimits,
  ProviderSafety,
  ProviderStatus,
} from './types';

export interface ProviderRegistryEnv {
  env?: NodeJS.ProcessEnv;
  /** Injected availability overrides for tests (never used to store secrets). */
  overrides?: Partial<Record<string, Partial<ProviderDescriptor>>>;
  /** When true, skip process/PATH probes (tests). */
  skipExecutableProbe?: boolean;
  /** Optional mock health map for tests. */
  mockHealth?: Partial<Record<string, Partial<ProviderHealthReport>>>;
}

const DEFAULT_LIMITS: ProviderLimits = {
  maxContextChars: 80_000,
  maxRuntimeMs: 600_000,
  maxPatchFiles: 40,
  maxChangedLines: 2_000,
};

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
    // Fallback: common absolute paths are not required; treat as missing.
    return existsSync(`/usr/local/bin/${command}`) || existsSync(`/opt/homebrew/bin/${command}`);
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

/**
 * Build the model/code executor registry.
 * ChatGPT current conversation is always handoff_only (never direct-invokable).
 */
export function listProviders(options: ProviderRegistryEnv = {}): ProviderDescriptor[] {
  const env = options.env ?? process.env;
  const skipProbe = options.skipExecutableProbe === true;
  const codexReady = commandExists('codex', skipProbe);
  const claudeReady = commandExists('claude', skipProbe);
  const ghReady = commandExists('gh', skipProbe);

  const grokAuth = hasAnyKey(env, ['XAI_API_KEY', 'REPO_HARNESS_XAI_API_KEY', 'GROK_API_KEY']);
  const deepseekAuth = hasAnyKey(env, ['DEEPSEEK_API_KEY', 'REPO_HARNESS_DEEPSEEK_API_KEY']);
  const openaiAuth = hasAnyKey(env, ['OPENAI_API_KEY', 'REPO_HARNESS_OPENAI_API_KEY']);

  const providers: ProviderDescriptor[] = [
    baseProvider(
      'direct_edit',
      'direct_edit',
      'none',
      'ready',
      ['code_patch', 'local_file_mutation'],
      'Bounded direct edit applied by repo-harness for deterministic small source changes.',
      {
        directDispatch: true,
        configured: true,
        authPresent: true,
        safety: {
          mayMutateFiles: true,
          mayRunCommands: false,
          requiresApplyByRepoHarness: true,
          requiresApprovalForExternalEffects: true,
        },
        limits: { ...DEFAULT_LIMITS, maxPatchFiles: 3, maxChangedLines: 200 },
      },
    ),
    baseProvider(
      'codex_cli',
      'local_cli',
      'codex',
      codexReady ? 'ready' : 'unavailable',
      ['code_patch', 'code_review', 'test_failure_repair', 'structured_output', 'tool_calling'],
      codexReady
        ? 'Local Codex CLI executor; patches applied and verified by repo-harness.'
        : 'Codex CLI not found on PATH.',
      {
        configured: codexReady,
        authPresent: codexReady,
        lastErrorCode: codexReady ? undefined : 'CODEX_CLI_UNAVAILABLE',
      },
    ),
    baseProvider(
      'claude_cli',
      'local_cli',
      'claude',
      claudeReady ? 'ready' : 'unavailable',
      ['code_patch', 'code_review', 'test_failure_repair', 'long_context', 'structured_output', 'tool_calling'],
      claudeReady
        ? 'Local Claude CLI executor when configured.'
        : 'Claude CLI not found on PATH.',
      {
        configured: claudeReady,
        authPresent: claudeReady,
        lastErrorCode: claudeReady ? undefined : 'CLAUDE_CLI_UNAVAILABLE',
      },
    ),
    baseProvider(
      'github_copilot_cloud',
      'cloud_agent',
      'github_copilot',
      ghReady ? 'ready' : 'unavailable',
      ['code_patch', 'code_review', 'remote_side_effects'],
      ghReady
        ? 'GitHub Copilot cloud agent via gh when cloud sessions are enabled.'
        : 'GitHub CLI (gh) unavailable for Copilot cloud sessions.',
      {
        configured: ghReady,
        authPresent: ghReady,
        lastErrorCode: ghReady ? undefined : 'GITHUB_CLI_UNAVAILABLE',
      },
    ),
    baseProvider(
      'grok_api',
      'remote_api',
      'grok',
      grokAuth ? 'ready' : 'missing_auth',
      ['code_patch', 'code_review', 'architecture_planning', 'test_failure_repair', 'structured_output', 'long_context'],
      grokAuth
        ? 'Grok/xAI API configured; direct dispatch allowed for bounded structured patch proposals.'
        : 'Grok/xAI API missing auth (set XAI_API_KEY or REPO_HARNESS_XAI_API_KEY).',
      {
        configured: grokAuth,
        authPresent: grokAuth,
        directDispatch: grokAuth,
        lastErrorCode: grokAuth ? undefined : 'MISSING_XAI_API_KEY',
      },
    ),
    baseProvider(
      'deepseek_api',
      'remote_api',
      'deepseek',
      deepseekAuth ? 'ready' : 'missing_auth',
      ['code_patch', 'code_review', 'architecture_planning', 'structured_output', 'tool_calling'],
      deepseekAuth
        ? 'DeepSeek API configured as invokable remote provider (policy-bound).'
        : 'DeepSeek API missing auth (set DEEPSEEK_API_KEY or REPO_HARNESS_DEEPSEEK_API_KEY).',
      {
        configured: deepseekAuth,
        authPresent: deepseekAuth,
        directDispatch: deepseekAuth,
        lastErrorCode: deepseekAuth ? undefined : 'MISSING_DEEPSEEK_API_KEY',
      },
    ),
    baseProvider(
      'openai_api',
      'remote_api',
      'openai',
      openaiAuth ? 'ready' : 'missing_auth',
      ['code_patch', 'code_review', 'architecture_planning', 'structured_output', 'long_context'],
      openaiAuth
        ? 'OpenAI API configured as invokable remote provider (policy-bound).'
        : 'OpenAI API missing auth (set OPENAI_API_KEY or REPO_HARNESS_OPENAI_API_KEY).',
      {
        configured: openaiAuth,
        authPresent: openaiAuth,
        directDispatch: openaiAuth,
        lastErrorCode: openaiAuth ? undefined : 'MISSING_OPENAI_API_KEY',
      },
    ),
    baseProvider(
      'chatgpt_handoff',
      'handoff_only',
      'chatgpt_handoff',
      'handoff_only',
      ['architecture_planning', 'code_review', 'long_context', 'browser_planning'],
      'Current ChatGPT conversation is handoff-only; not directly invokable via local CLI/API.',
      {
        directDispatch: false,
        configured: true,
        authPresent: false,
        lastErrorCode: 'HANDOFF_ONLY_SUPERVISOR',
      },
    ),
  ];

  if (options.overrides) {
    for (const provider of providers) {
      const override = options.overrides[provider.providerId];
      if (!override) continue;
      Object.assign(provider, override);
      const kind = provider.kind;
      const status = provider.status;
      if (status === 'handoff_only' || kind === 'handoff_only') {
        provider.directDispatch = false;
      } else if (override.directDispatch !== undefined) {
        provider.directDispatch = override.directDispatch;
      } else {
        provider.directDispatch = status === 'ready';
      }
    }
  }

  return providers;
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
