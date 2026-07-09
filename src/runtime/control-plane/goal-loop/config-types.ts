import type { ProviderCapability } from './types';

/** Non-secret provider preference stored under controllerHome/global/. */
export interface ProviderPreference {
  providerId: string;
  enabled: boolean;
  /** Lower number = higher priority (1 first). */
  priority: number;
  /** Optional capability subset override; empty means use registry defaults. */
  enabledCapabilities?: ProviderCapability[];
  /** Env var name references only — never values. */
  credentialEnvVars?: string[];
  notes?: string;
  updatedAt?: string;
}

export interface ProviderConfigFile {
  schemaVersion: 1;
  updatedAt: string;
  /**
   * When true, remote API providers may attempt live calls if also allowed by env.
   * GUI preference is AND-gated with REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS.
   */
  preferLiveModelProviders: boolean;
  /** Master switch for autonomous goal loop ticks. */
  goalLoopEnabled: boolean;
  providers: ProviderPreference[];
}

export interface LocalToolPreference {
  toolId: string;
  enabled: boolean;
  notes?: string;
  updatedAt?: string;
}

export interface LocalToolConfigFile {
  schemaVersion: 1;
  updatedAt: string;
  tools: LocalToolPreference[];
}

export type RoutingIntentKey =
  | 'implementation'
  | 'repair'
  | 'planning'
  | 'review'
  | 'browser_planning'
  | 'ios_analysis'
  | 'deterministic_edit'
  | 'fallback';

export interface ExecutorRoutingConfigFile {
  schemaVersion: 1;
  updatedAt: string;
  /** Ordered provider ids per intent. Handoff-only may appear only as last resort. */
  orders: Record<RoutingIntentKey, string[]>;
  defaultImplementationProvider?: string;
  defaultRepairProvider?: string;
  defaultPlanningProvider?: string;
  defaultReviewProvider?: string;
  defaultBrowserPlanningProvider?: string;
  defaultIosAnalysisProvider?: string;
}

export interface GoalLoopPolicyConfigFile {
  schemaVersion: 1;
  updatedAt: string;
  requireApprovalForExternalWrites: boolean;
  requireApprovalForDestructiveChanges: boolean;
  requireApprovalForBroadRefactors: boolean;
  requireApprovalForBrowserFormSubmit: boolean;
  requireApprovalForGmailSendOrTrash: boolean;
  requireApprovalForAppStoreConnectWrites: boolean;
  requireApprovalBeforeFinalMerge: boolean;
  maxChangedFilesWithoutConfirmation: number;
  maxChangedLinesWithoutConfirmation: number;
  defaultRetryBudget: number;
  maxRepairAttemptsPerProvider: number;
}

export interface CredentialStatusEntry {
  providerId: string;
  displayName: string;
  requiredEnvVars: string[];
  presentEnvVars: string[];
  missingEnvVars: string[];
  authPresent: boolean;
  setupExample: string;
  storageMode: 'environment_variable_only';
  /** Never includes values. */
  redacted: true;
}

export interface LocalToolDescriptor {
  toolId: string;
  displayName: string;
  status: 'detected' | 'missing' | 'disabled';
  enabled: boolean;
  executablePath?: string;
  version?: string;
  lastHealthCheckAt?: string;
  capabilityTags: string[];
  usedByWorkflows: string[];
  summary: string;
  healthOk: boolean;
  lastErrorSummary?: string;
}

export interface ProviderConfigCard {
  providerId: string;
  displayName: string;
  kindLabel: string;
  kind: string;
  status: string;
  statusLabel: string;
  enabled: boolean;
  priority: number;
  directDispatch: boolean;
  handoffOnly: boolean;
  capabilities: string[];
  safety: {
    canMutateFilesDirectly: boolean;
    requiresRepoHarnessApply: boolean;
    externalSideEffects: 'never' | 'approval_required';
  };
  credential: {
    authPresent: boolean;
    requiredEnvVars: string[];
    presentEnvVars: string[];
  };
  liveModelCalls: {
    envEnabled: boolean;
    preferenceEnabled: boolean;
    effectiveEnabled: boolean;
  };
  lastHealthCheckAt?: string;
  lastErrorSummary?: string;
  explanation?: string;
  canEnableDirectDispatch: boolean;
  summary: string;
}

export interface AutomationSettingsOverview {
  goalLoopEnabled: boolean;
  liveModelProvidersEffective: boolean;
  liveModelProvidersEnv: boolean;
  liveModelProvidersPreference: boolean;
  directProvidersReady: number;
  handoffOnlyCount: number;
  providersNeedingConfig: number;
  localToolsAvailable: number;
  plainLanguageSummary: string;
  defaultRoutes: Record<string, string>;
}

export interface AutomationSettingsViewModel {
  schemaVersion: 1;
  generatedAt: string;
  overview: AutomationSettingsOverview;
  providers: ProviderConfigCard[];
  credentials: CredentialStatusEntry[];
  localTools: LocalToolDescriptor[];
  routing: ExecutorRoutingConfigFile;
  policy: GoalLoopPolicyConfigFile;
  warnings: string[];
}
