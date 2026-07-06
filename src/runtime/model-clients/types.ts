export type ModelClientKind = 'chatgpt_mcp' | 'deepseek_function_calling' | 'deepseek_backup_controller' | 'local_gui' | 'ios_companion';
export type ModelControllerMode = 'interactive_primary' | 'backup_primary' | 'parallel_reviewer' | 'tool_call_adapter';
export type DeepSeekHandoffReason = 'manual' | 'chatgpt_platform_blocked' | 'chatgpt_unavailable' | 'parallel_review' | 'local_gui_request';

export interface ModelClientSummary {
  clientId: string;
  kind: ModelClientKind;
  enabled: boolean;
  configured: boolean;
  role: string;
  allowedToolPrefixes: string[];
  safetyBoundary: 'repo-harness-policy';
  controllerModes?: ModelControllerMode[];
  canInitiateTurns?: boolean;
  canExecuteToolsDirectly?: false;
}

export interface ModelControlPlaneSummary {
  policyOwner: 'repo-harness';
  primaryController: string;
  backupControllers: string[];
  activeController?: string;
  handoffSupported: boolean;
  handoffReasons: DeepSeekHandoffReason[];
  concurrencyPolicy: {
    readonlyShared: true;
    workspaceWriteRequiresLease: true;
    remoteWriteRequiresApproval: true;
    destructiveRequiresStrongConfirmation: true;
    browserSessionExclusive: true;
  };
  clientSummaries: ModelClientSummary[];
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

export interface DeepSeekControllerHandoffInput {
  reason?: DeepSeekHandoffReason;
  objective?: string;
  repoId?: string;
  currentController?: string;
  blockedToolName?: string;
  recentSafeError?: string;
}

export interface DeepSeekControllerHandoffPacket {
  provider: 'deepseek';
  controllerClientId: 'deepseek-backup-controller';
  role: 'backup_primary_controller';
  accepted: true;
  reason: DeepSeekHandoffReason;
  objective: string;
  repoId?: string;
  currentController: string;
  safety: {
    executesToolsDirectly: false;
    requiresRepoHarnessPolicy: true;
    approvalOwner: 'repo-harness';
    leasesOwner: 'repo-harness';
    rawRepositoryContentIncluded: false;
    opaquePayloadAccepted: false;
  };
  recommendedFirstAction: string;
  availableFunctionNames: string[];
  handoffInstructions: string[];
}

export interface DeepSeekControllerRequestInput extends DeepSeekControllerHandoffInput {
  userMessage?: string;
  maxToolCalls?: number;
  model?: string;
}

export interface DeepSeekControllerRequestPreview {
  provider: 'deepseek';
  controllerClientId: 'deepseek-backup-controller';
  configured: boolean;
  requiresApiKey: boolean;
  endpoint: 'https://api.deepseek.com/chat/completions';
  model: string;
  sendsRawRepositoryContent: false;
  request: {
    model: string;
    messages: Array<{ role: 'system' | 'user'; content: string }>;
    tools: Array<Record<string, unknown>>;
    tool_choice: 'auto';
  };
  handoff: DeepSeekControllerHandoffPacket;
}
