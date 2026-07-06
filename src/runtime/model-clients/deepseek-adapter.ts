import type { DeepSeekPreparedToolCall, ModelClientSummary } from './types';

export function buildModelClientSummary(env: NodeJS.ProcessEnv = process.env): ModelClientSummary[] {
  return [
    {
      clientId: 'chatgpt-mcp',
      kind: 'chatgpt_mcp',
      enabled: true,
      configured: true,
      role: 'Interactive MCP host using low-interception structured tools.',
      allowedToolPrefixes: ['toolchain_', 'web_', 'work_', 'model_'],
      safetyBoundary: 'repo-harness-policy',
    },
    {
      clientId: 'deepseek-function-calling',
      kind: 'deepseek_function_calling',
      enabled: true,
      configured: Boolean(env.DEEPSEEK_API_KEY || env.REPO_HARNESS_DEEPSEEK_API_KEY),
      role: 'Optional parallel model client. DeepSeek returns function calls; repo-harness executes only after policy checks.',
      allowedToolPrefixes: ['repo_harness_web_', 'repo_harness_work_', 'repo_harness_plugin_'],
      safetyBoundary: 'repo-harness-policy',
    },
    {
      clientId: 'local-gui',
      kind: 'local_gui',
      enabled: true,
      configured: true,
      role: 'Human-supervised local control plane and approval surface.',
      allowedToolPrefixes: ['api'],
      safetyBoundary: 'repo-harness-policy',
    },
    {
      clientId: 'ios-companion',
      kind: 'ios_companion',
      enabled: true,
      configured: false,
      role: 'Mobile approval, monitoring, and task preview client.',
      allowedToolPrefixes: ['mobile-intent'],
      safetyBoundary: 'repo-harness-policy',
    },
  ];
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
        name: 'repo_harness_work_result_summary',
        description: 'Read a redacted job result summary with suggested next actions. Does not return raw stdout/stderr.',
        parameters: {
          type: 'object',
          properties: { job_id: { type: 'string' } },
          required: ['job_id'],
          additionalProperties: false,
        },
      },
    },
  ];
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
      return {
        provider: 'deepseek',
        accepted: true,
        functionName,
        mappedOperation: 'work_result_summary',
        mappedArguments: { job_id: functionArguments.job_id },
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
