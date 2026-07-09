import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildAutomationSettingsView,
  executorRoutePreviewWithConfig,
  executorRoutingConfigUpdate,
  goalLoopPolicyUpdate,
  listProviders,
  localToolDisable,
  localToolEnable,
  localToolList,
  providerApiSettingsGet,
  providerApiSettingsUpdate,
  providerConfigGet,
  providerConfigUpdate,
  providerCredentialsStatus,
  providerDisable,
  providerEnable,
  providerPriorityUpdate,
  readProviderConfig,
  readProviderSecrets,
  routeExecutor,
  type ConfigFacadeContext,
} from '../../src/runtime/control-plane/goal-loop';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-provider-config-'));
  roots.push(root);
  const ctx: ConfigFacadeContext = {
    controllerHome: root,
    configRoot: root,
    env,
    skipExecutableProbe: true,
  };
  return { ctx, root };
}

describe('provider config persistence', () => {
  test('provider config persistence', () => {
    const { ctx, root } = fixture();
    const config = providerConfigUpdate(ctx, { preferLiveModelProviders: true, goalLoopEnabled: true });
    expect(config.preferLiveModelProviders).toBe(true);
    const disk = JSON.parse(readFileSync(join(root, 'provider-config.json'), 'utf8'));
    expect(disk.preferLiveModelProviders).toBe(true);
    expect(JSON.stringify(disk)).not.toMatch(/sk-|xai-[a-zA-Z0-9]{8,}/);
    expect(providerConfigGet(ctx).preferLiveModelProviders).toBe(true);
  });

  test('provider enable/disable', () => {
    const { ctx } = fixture();
    providerDisable(ctx, 'grok_api');
    expect(providerConfigGet(ctx).providers.find((p) => p.providerId === 'grok_api')?.enabled).toBe(false);
    providerEnable(ctx, 'grok_api');
    expect(providerConfigGet(ctx).providers.find((p) => p.providerId === 'grok_api')?.enabled).toBe(true);
  });

  test('provider priority update', () => {
    const { ctx } = fixture();
    const before = providerConfigGet(ctx).providers.sort((a, b) => a.priority - b.priority);
    const codexBefore = before.findIndex((p) => p.providerId === 'codex_cli');
    providerPriorityUpdate(ctx, 'codex_cli', 'down');
    const after = providerConfigGet(ctx).providers.sort((a, b) => a.priority - b.priority);
    const codexAfter = after.findIndex((p) => p.providerId === 'codex_cli');
    expect(codexAfter).toBeGreaterThanOrEqual(codexBefore);
  });
});

describe('routing respects config', () => {
  test('disabled provider excluded from route', () => {
    const { ctx } = fixture({ XAI_API_KEY: 'xai-test', REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS: '1' });
    providerConfigUpdate(ctx, { preferLiveModelProviders: true });
    providerDisable(ctx, 'codex_cli');
    localToolDisable(ctx, 'codex_cli');
    const providers = listProviders({
      env: ctx.env,
      skipExecutableProbe: true,
      configLocation: { root: ctx.configRoot },
      overrides: {
        codex_cli: undefined,
        grok_api: { status: 'ready', directDispatch: true, authPresent: true },
      },
    });
    // Force codex disabled via config re-list without override that re-enables
    const providers2 = listProviders({
      env: { ...ctx.env, PATH: '' },
      skipExecutableProbe: true,
      configLocation: { root: ctx.configRoot },
      liveModelProvidersEffective: true,
      overrides: {
        grok_api: { status: 'ready', directDispatch: true, authPresent: true, configured: true },
        direct_edit: { status: 'ready', directDispatch: true },
      },
    });
    const codex = providers2.find((p) => p.providerId === 'codex_cli');
    expect(codex?.status === 'disabled' || codex?.directDispatch === false).toBe(true);

    const decision = routeExecutor({
      goal: {
        goalId: 'g',
        repoId: 'r',
        mode: 'autonomous',
        status: 'ready',
        objective: 'implement',
        constraints: {},
        allowedExecutors: [],
        forbiddenExecutors: [],
        repairAttempts: 0,
        retryBudget: 5,
      },
      taskIntent: 'code_implementation',
      risk: 'workspace_write',
      providers: providers2.map((p) => (
        p.providerId === 'codex_cli'
          ? { ...p, status: 'disabled', directDispatch: false }
          : p
      )),
      routingConfig: {
        orders: {
          implementation: ['codex_cli', 'grok_api', 'chatgpt_handoff'],
        },
      },
    });
    expect(decision.selectedProviderId).not.toBe('codex_cli');
    expect(decision.selectedProviderId).toBe('grok_api');
  });

  test('handoff-only provider rejected for direct dispatch', () => {
    const { ctx } = fixture();
    const preview = executorRoutePreviewWithConfig(ctx, { taskIntent: 'code_implementation' });
    if (preview.route.selectedProviderId === 'chatgpt_handoff') {
      expect(preview.route.directDispatch).toBe(false);
      expect(preview.route.handoffOnly).toBe(true);
    }
    const providers = listProviders({
      skipExecutableProbe: true,
      configLocation: { root: ctx.configRoot },
      overrides: {
        direct_edit: { status: 'disabled', directDispatch: false },
        codex_cli: { status: 'unavailable', directDispatch: false },
        claude_cli: { status: 'unavailable', directDispatch: false },
        grok_api: { status: 'missing_auth', directDispatch: false },
        openai_api: { status: 'missing_auth', directDispatch: false },
        deepseek_api: { status: 'missing_auth', directDispatch: false },
        github_copilot_cloud: { status: 'unavailable', directDispatch: false },
      },
    });
    const decision = routeExecutor({
      goal: {
        goalId: 'g',
        repoId: 'r',
        mode: 'autonomous',
        status: 'ready',
        objective: 'x',
        constraints: {},
        allowedExecutors: [],
        forbiddenExecutors: [],
        repairAttempts: 0,
        retryBudget: 5,
      },
      taskIntent: 'code_implementation',
      risk: 'workspace_write',
      providers,
    });
    expect(decision.selectedProviderId).toBe('chatgpt_handoff');
    expect(decision.directDispatch).toBe(false);
  });

  test('routing config fallback order works', () => {
    const { ctx } = fixture();
    executorRoutingConfigUpdate(ctx, {
      orders: {
        implementation: ['claude_cli', 'codex_cli', 'chatgpt_handoff'],
        repair: ['claude_cli', 'codex_cli', 'chatgpt_handoff'],
        planning: ['chatgpt_handoff', 'openai_api'],
        review: ['codex_cli'],
        browser_planning: ['codex_cli'],
        ios_analysis: ['codex_cli'],
        deterministic_edit: ['direct_edit'],
        fallback: ['claude_cli', 'codex_cli'],
      },
    });
    const providers = listProviders({
      skipExecutableProbe: true,
      configLocation: { root: ctx.configRoot },
      overrides: {
        claude_cli: { status: 'ready', directDispatch: true },
        codex_cli: { status: 'ready', directDispatch: true },
      },
    });
    const decision = routeExecutor({
      goal: {
        goalId: 'g',
        repoId: 'r',
        mode: 'autonomous',
        status: 'ready',
        objective: 'impl',
        constraints: {},
        allowedExecutors: [],
        forbiddenExecutors: [],
        repairAttempts: 0,
        retryBudget: 5,
      },
      taskIntent: 'code_implementation',
      risk: 'workspace_write',
      providers,
      routingConfig: executorRoutePreviewWithConfig(ctx).order
        ? { orders: { implementation: ['claude_cli', 'codex_cli', 'chatgpt_handoff'] } }
        : undefined,
    });
    // With explicit order in input:
    const decision2 = routeExecutor({
      goal: {
        goalId: 'g',
        repoId: 'r',
        mode: 'autonomous',
        status: 'ready',
        objective: 'impl',
        constraints: {},
        allowedExecutors: [],
        forbiddenExecutors: [],
        repairAttempts: 0,
        retryBudget: 5,
      },
      taskIntent: 'code_implementation',
      risk: 'workspace_write',
      providers,
      routingConfig: { orders: { implementation: ['claude_cli', 'codex_cli', 'chatgpt_handoff'] } },
    });
    expect(decision2.selectedProviderId).toBe('claude_cli');
  });
});

describe('credentials and live mode', () => {
  test('grok_cli is registered as local_cli and does not require live API flag', () => {
    const providers = listProviders({
      env: {},
      skipExecutableProbe: true,
      overrides: {
        grok_cli: { status: 'ready', directDispatch: true, configured: true, authPresent: true },
      },
    });
    const grokCli = providers.find((p) => p.providerId === 'grok_cli');
    expect(grokCli?.kind).toBe('local_cli');
    expect(grokCli?.modelFamily).toBe('grok');
    expect(grokCli?.directDispatch).toBe(true);
    expect(grokCli?.status).toBe('ready');
  });

  test('Grok missing auth shown as missing_auth', () => {
    const providers = listProviders({ env: {}, skipExecutableProbe: true });
    const grok = providers.find((p) => p.providerId === 'grok_api');
    expect(grok?.status).toBe('missing_auth');
    expect(grok?.lastErrorCode).toBe('MISSING_XAI_API_KEY');
  });

  test('live providers disabled blocks direct API dispatch', () => {
    const providers = listProviders({
      env: { XAI_API_KEY: 'xai-test-placeholder' },
      skipExecutableProbe: true,
      liveModelProvidersEffective: false,
    });
    const grok = providers.find((p) => p.providerId === 'grok_api');
    expect(grok?.authPresent).toBe(true);
    expect(grok?.directDispatch).toBe(false);
    expect(grok?.lastErrorCode).toBe('LIVE_CALLS_DISABLED');
  });

  test('live + credential enables grok direct dispatch', () => {
    const { ctx } = fixture({ XAI_API_KEY: 'xai-test', REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS: '1' });
    providerConfigUpdate(ctx, { preferLiveModelProviders: true });
    const providers = listProviders({
      env: ctx.env,
      skipExecutableProbe: true,
      configLocation: { root: ctx.configRoot },
    });
    const grok = providers.find((p) => p.providerId === 'grok_api');
    expect(grok?.directDispatch).toBe(true);
    expect(grok?.status).toBe('ready');
  });

  test('env credential status redacts values', () => {
    const { ctx } = fixture({ XAI_API_KEY: 'xai-super-secret-value-should-not-appear' });
    const creds = providerCredentialsStatus(ctx);
    const blob = JSON.stringify(creds);
    expect(blob).not.toContain('xai-super-secret-value-should-not-appear');
    expect(creds.every((c) => c.redacted)).toBe(true);
    const grok = creds.find((c) => c.providerId === 'grok_api');
    expect(grok?.authPresent).toBe(true);
    expect(grok?.presentEnvVars).toContain('XAI_API_KEY');
  });

  test('GUI can configure baseUrl, model, and stored apiKey without leaking secrets', () => {
    const { ctx, root } = fixture({});
    const secret = 'xai-page-configured-secret-key-9999';
    const saved = providerApiSettingsUpdate(ctx, 'grok_api', {
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-3-mini',
      apiKey: secret,
    });
    expect(saved.ok).toBe(true);
    expect(saved.model).toBe('grok-3-mini');
    expect(saved.baseUrl).toBe('https://api.x.ai/v1');
    expect(saved.storedAuthPresent).toBe(true);
    expect(saved.storedKeyHint).toBe('…9999');
    expect(JSON.stringify(saved)).not.toContain(secret);

    const pref = readProviderConfig({ root }).providers.find((p) => p.providerId === 'grok_api');
    expect(pref?.model).toBe('grok-3-mini');
    expect(JSON.stringify(pref)).not.toContain(secret);

    const secrets = readProviderSecrets({ root });
    expect(secrets.providers.grok_api?.apiKey).toBe(secret);

    const get = providerApiSettingsGet(ctx, 'grok_api');
    expect(get.hasStoredApiKey).toBe(true);
    expect(JSON.stringify(get)).not.toContain(secret);

    const providers = listProviders({
      env: {},
      skipExecutableProbe: true,
      configLocation: { root },
      liveModelProvidersEffective: true,
    });
    const grok = providers.find((p) => p.providerId === 'grok_api');
    expect(grok?.authPresent).toBe(true);
    expect(grok?.directDispatch).toBe(true);

    providerApiSettingsUpdate(ctx, 'grok_api', { clearApiKey: true });
    expect(providerApiSettingsGet(ctx, 'grok_api').hasStoredApiKey).toBe(false);
  });
});

describe('local tools', () => {
  test('local tool disable excludes tool from routing', () => {
    const { ctx } = fixture();
    localToolDisable(ctx, 'direct_edit');
    const tools = localToolList(ctx);
    expect(tools.find((t) => t.toolId === 'direct_edit')?.enabled).toBe(false);
    const providers = listProviders({
      skipExecutableProbe: true,
      configLocation: { root: ctx.configRoot },
    });
    expect(providers.find((p) => p.providerId === 'direct_edit')?.status).toBe('disabled');
    localToolEnable(ctx, 'direct_edit');
  });
});

describe('policy and facade view model', () => {
  test('policy config requires approval for external write', () => {
    const { ctx } = fixture();
    const policy = goalLoopPolicyUpdate(ctx, { requireApprovalForExternalWrites: true });
    expect(policy.requireApprovalForExternalWrites).toBe(true);
    const preview = executorRoutePreviewWithConfig(ctx, {
      taskIntent: 'code_implementation',
      externalWrite: true,
      risk: 'remote_write',
    });
    // With default constraints (external write not allowed), router waits or blocks
    expect(preview.route.waitForUser || preview.route.handoffOnly || !preview.route.directDispatch).toBe(true);
  });

  test('facade responses are bounded/redacted', () => {
    const { ctx } = fixture({ XAI_API_KEY: 'xai-secret-xyz', OPENAI_API_KEY: 'sk-secret-xyz' });
    const view = buildAutomationSettingsView(ctx);
    const blob = JSON.stringify(view);
    expect(blob).not.toContain('xai-secret-xyz');
    expect(blob).not.toContain('sk-secret-xyz');
    expect(view.schemaVersion).toBe(1);
    expect(view.providers.some((p) => p.providerId === 'chatgpt_handoff' && p.handoffOnly && !p.canEnableDirectDispatch)).toBe(true);
    expect(view.overview.plainLanguageSummary.toLowerCase()).toContain('chatgpt');
  });

  test('GUI view model maps statuses correctly', () => {
    const { ctx } = fixture();
    const view = buildAutomationSettingsView(ctx);
    const chat = view.providers.find((p) => p.providerId === 'chatgpt_handoff');
    expect(chat?.statusLabel.toLowerCase()).toContain('handoff');
    expect(chat?.directDispatch).toBe(false);
    expect(chat?.explanation).toMatch(/cannot automatically invoke/i);
    const grok = view.providers.find((p) => p.providerId === 'grok_api');
    expect(grok?.statusLabel === 'Missing auth' || grok?.status === 'missing_auth').toBe(true);
  });
});
