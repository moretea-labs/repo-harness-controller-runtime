export type ModelClientKind = 'chatgpt_mcp' | 'deepseek_function_calling' | 'local_gui' | 'ios_companion';

export interface ModelClientSummary {
  clientId: string;
  kind: ModelClientKind;
  enabled: boolean;
  configured: boolean;
  role: string;
  allowedToolPrefixes: string[];
  safetyBoundary: 'repo-harness-policy';
}

export interface DeepSeekPreparedToolCall {
  provider: 'deepseek';
  accepted: boolean;
  functionName: string;
  mappedOperation?: string;
  mappedArguments?: Record<string, unknown>;
  reason?: string;
  safety: {
    executesLocally: false;
    requiresRepoHarnessPolicy: true;
    opaquePayloadAccepted: false;
  };
}
