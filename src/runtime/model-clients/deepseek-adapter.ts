import type {
  DeepSeekControllerHandoffInput,
  DeepSeekControllerHandoffPacket,
  DeepSeekControllerRequestInput,
  DeepSeekControllerRequestPreview,
  DeepSeekHandoffReason,
  DeepSeekPreparedToolCall,
  ModelClientSummary,
  ModelControlPlaneSummary,
} from './types';

const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions' as const;

function deepSeekConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DEEPSEEK_API_KEY || env.REPO_HARNESS_DEEPSEEK_API_KEY);
}

export function buildModelClientSummary(env: NodeJS.ProcessEnv = process.env): ModelClientSummary[] {
  const configured = deepSeekConfigured(env);
  return [
    {
      clientId: 'chatgpt-mcp',
      kind: 'chatgpt_mcp',
      enabled: true,
      configured: true,
      role: 'Interactive MCP host using low-interception structured tools.',
      allowedToolPrefixes: ['toolchain_', 'web_', 'work_', 'model_'],
      safetyBoundary: 'repo-harness-policy',
      controllerModes: ['interactive_primary'],
      canInitiateTurns: true,
      canExecuteToolsDirectly: false,
    },
    {
      clientId: 'deepseek-function-calling',
      kind: 'deepseek_function_calling',
      enabled: true,
      configured,
      role: 'Compatibility adapter. DeepSeek returns function calls; repo-harness translates them into safe operations.',
      allowedToolPrefixes: ['repo_harness_web_', 'repo_harness_work_', 'repo_harness_plugin_'],
      safetyBoundary: 'repo-harness-policy',
      controllerModes: ['tool_call_adapter'],
      canInitiateTurns: false,
      canExecuteToolsDirectly: false,
    },
    {
      clientId: 'deepseek-backup-controller',
      kind: 'deepseek_backup_controller',
      enabled: true,
      configured,
      role: 'Backup primary controller for manual handoff, ChatGPT connector blockage fallback, and parallel review. It proposes repo-harness tool calls but never executes them directly.',
      allowedToolPrefixes: ['repo_harness_web_', 'repo_harness_work_', 'repo_harness_plugin_'],
      safetyBoundary: 'repo-harness-policy',
      controllerModes: ['backup_primary', 'parallel_reviewer'],
      canInitiateTurns: configured,
      canExecuteToolsDirectly: false,
    },
    {
      clientId: 'local-gui',
      kind: 'local_gui',
      enabled: true,
      configured: true,
      role: 'Human-supervised local control plane and approval surface.',
      allowedToolPrefixes: ['api'],
      safetyBoundary: 'repo-harness-policy',
      controllerModes: ['interactive_primary'],
      canInitiateTurns: true,
      canExecuteToolsDirectly: false,
    },
    {
      clientId: 'ios-companion',
      kind: 'ios_companion',
      enabled: true,
      configured: false,
      role: 'Mobile approval, monitoring, and task preview client.',
      allowedToolPrefixes: ['mobile-intent'],
      safetyBoundary: 'repo-harness-policy',
      controllerModes: ['parallel_reviewer'],
      canInitiateTurns: false,
      canExecuteToolsDirectly: false,
    },
  ];
}

export function buildModelControlPlaneSummary(env: NodeJS.ProcessEnv = process.env): ModelControlPlaneSummary {
  const clientSummaries = buildModelClientSummary(env);
  return {
    policyOwner: 'repo-harness',
    primaryController: 'chatgpt-mcp',
    backupControllers: ['deepseek-backup-controller', 'local-gui'],
    activeController: 'chatgpt-mcp',
    handoffSupported: true,
    handoffReasons: ['manual', 'chatgpt_platform_blocked', 'chatgpt_unavailable', 'parallel_review', 'local_gui_request'],
    concurrencyPolicy: {
      readonlyShared: true,
      workspaceWriteRequiresLease: true,
      remoteWriteRequiresApproval: true,
      destructiveRequiresStrongConfirmation: true,
      browserSessionExclusive: true,
    },
    clientSummaries,
  };
}

export function deepSeekFunctionToolManifest(): Array<Record<string, unknown>> {
  return [
    {
      type: 'function',
      function: {
        name: 'repo_harness_web_target_snapshot',
        description: 'Create a read-only snapshot for a pre-allowed web target by target_key and path. Does not accept arbitrary URLs.',
        parameters: {
          type: 'object',
          properties: {
            target_key: { type: 'string' },
            path: { type: 'string' },
            capture: { type: 'string', enum: ['title', 'text', 'screenshot'] },
            max_chars: { type: 'number' },
          },
          required: ['target_key'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'repo_harness_plugin_config_summary',
        description: 'Read a redacted plugin configuration and permission summary. Does not return raw config files.',
        parameters: {
          type: 'object',
          properties: { plugin_id: { type: 'string' } },
          required: ['plugin_id'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'repo_harness_work_status_digest',
        description: 'Read a redacted work status digest with suggested next actions. Does not return raw stdout/stderr.',
        parameters: {
          type: 'object',
          properties: { work_ref: { type: 'string' } },
          required: ['work_ref'],
          additionalProperties: false,
        },
      },
    },
  ];
}

export function deepSeekControllerManifest(): Record<string, unknown> {
  return {
    provider: 'deepseek',
    controllerClientId: 'deepseek-backup-controller',
    role: 'backup_primary_controller',
    policyOwner: 'repo-harness',
    functionCallingTools: deepSeekFunctionToolManifest(),
    controlModes: ['manual_handoff', 'chatgpt_platform_blocked_fallback', 'parallel_review'],
    boundaries: {
      executesToolsDirectly: false,
      approvalOwner: 'repo-harness',
      leasesOwner: 'repo-harness',
      rawRepositoryContentIncludedByDefault: false,
      opaquePayloadAccepted: false,
    },
  };
}

function normalizeHandoffReason(reason: unknown): DeepSeekHandoffReason {
  const value = typeof reason === 'string' ? reason : '';
  return ['manual', 'chatgpt_platform_blocked', 'chatgpt_unavailable', 'parallel_review', 'local_gui_request'].includes(value)
    ? value as DeepSeekHandoffReason
    : 'manual';
}

function boundedText(value: unknown, fallback: string, max = 1200): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, max);
}

export function prepareDeepSeekControllerHandoff(input: DeepSeekControllerHandoffInput = {}, env: NodeJS.ProcessEnv = process.env): DeepSeekControllerHandoffPacket {
  const reason = normalizeHandoffReason(input.reason);
  const objective = boundedText(input.objective, 'Continue repo-harness supervision through the backup controller.');
  const blockedTool = typeof input.blockedToolName === 'string' && input.blockedToolName.trim() ? input.blockedToolName.trim() : undefined;
  const safeError = typeof input.recentSafeError === 'string' && input.recentSafeError.trim() ? input.recentSafeError.trim().slice(0, 240) : undefined;
  const configured = deepSeekConfigured(env);
  const availableFunctionNames = deepSeekFunctionToolManifest()
    .map((tool) => (tool.function as { name?: unknown } | undefined)?.name)
    .filter((name): name is string => typeof name === 'string');
  return {
    provider: 'deepseek',
    controllerClientId: 'deepseek-backup-controller',
    role: 'backup_primary_controller',
    accepted: true,
    reason,
    objective,
    ...(typeof input.repoId === 'string' && input.repoId ? { repoId: input.repoId } : {}),
    currentController: typeof input.currentController === 'string' && input.currentController ? input.currentController : 'chatgpt-mcp',
    safety: {
      executesToolsDirectly: false,
      requiresRepoHarnessPolicy: true,
      approvalOwner: 'repo-harness',
      leasesOwner: 'repo-harness',
      rawRepositoryContentIncluded: false,
      opaquePayloadAccepted: false,
    },
    recommendedFirstAction: blockedTool
      ? `Inspect a safe digest for the blocked operation (${blockedTool}) before proposing any follow-up.`
      : configured
        ? 'Ask DeepSeek to choose one safe function call or ask the user for clarification.'
        : 'Configure DEEPSEEK_API_KEY or REPO_HARNESS_DEEPSEEK_API_KEY before starting a live DeepSeek turn.',
    availableFunctionNames,
    handoffInstructions: [
      'Act as a backup controller, not as a direct executor.',
      'Return only one supported function call at a time, or ask a clarification question.',
      'Do not request arbitrary shell commands, raw config files, secrets, cookies, browser profiles, private keys, or unrestricted URLs.',
      'All workspace writes, remote writes, browser interactions, and destructive actions remain gated by repo-harness policy and human approval.',
      ...(safeError ? [`Recent safe error context: ${safeError}`] : []),
    ],
  };
}

function deepSeekControllerSystemPrompt(handoff: DeepSeekControllerHandoffPacket): string {
  return [
    'You are the DeepSeek backup controller for repo-harness.',
    'You can propose safe function calls, but repo-harness is the only execution and policy authority.',
    'Never request arbitrary URLs, raw local files, shell commands, secrets, cookies, private keys, or opaque payloads.',
    'Use the supplied low-interception function tools only.',
    'If a requested action is outside the manifest, ask for a human-supervised handoff instead of inventing a tool.',
    `Handoff reason: ${handoff.reason}.`,
    `Objective: ${handoff.objective}.`,
  ].join('\n');
}

export function prepareDeepSeekControllerRequest(input: DeepSeekControllerRequestInput = {}, env: NodeJS.ProcessEnv = process.env): DeepSeekControllerRequestPreview {
  const handoff = prepareDeepSeekControllerHandoff(input, env);
  const model = boundedText(input.model, env.REPO_HARNESS_DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL, 80);
  const userMessage = boundedText(input.userMessage, input.objective || handoff.objective, 2000);
  return {
    provider: 'deepseek',
    controllerClientId: 'deepseek-backup-controller',
    configured: deepSeekConfigured(env),
    requiresApiKey: !deepSeekConfigured(env),
    endpoint: DEEPSEEK_ENDPOINT,
    model,
    sendsRawRepositoryContent: false,
    request: {
      model,
      messages: [
        { role: 'system', content: deepSeekControllerSystemPrompt(handoff) },
        { role: 'user', content: userMessage },
      ],
      tools: deepSeekFunctionToolManifest(),
      tool_choice: 'auto',
    },
    handoff,
  };
}

export function prepareDeepSeekToolCall(functionName: string, functionArguments: Record<string, unknown>): DeepSeekPreparedToolCall {
  const safety = {
    executesLocally: false as const,
    requiresRepoHarnessPolicy: true as const,
    opaquePayloadAccepted: false as const,
  };
  switch (functionName) {
    case 'repo_harness_web_target_snapshot':
      return {
        provider: 'deepseek',
        accepted: true,
        functionName,
        mappedOperation: 'web_target_snapshot',
        mappedArguments: {
          target_key: functionArguments.target_key,
          path: functionArguments.path,
          capture: functionArguments.capture,
          max_chars: functionArguments.max_chars,
        },
        safety,
      };
    case 'repo_harness_plugin_config_summary':
      return {
        provider: 'deepseek',
        accepted: true,
        functionName,
        mappedOperation: 'toolchain_plugin_summary',
        mappedArguments: { plugin_id: functionArguments.plugin_id },
        safety,
      };
    case 'repo_harness_work_result_summary':
    case 'repo_harness_work_status_digest':
      return {
        provider: 'deepseek',
        accepted: true,
        functionName,
        mappedOperation: 'work_status_digest',
        mappedArguments: { work_ref: functionArguments.work_ref ?? functionArguments.job_id },
        safety,
      };
    default:
      return {
        provider: 'deepseek',
        accepted: false,
        functionName,
        reason: `Unsupported DeepSeek function: ${functionName}`,
        safety,
      };
  }
}
