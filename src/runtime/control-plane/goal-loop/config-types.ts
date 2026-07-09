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
  /**
   * Remote API base URL (e.g. https://api.x.ai/v1). Never a secret.
   * Only used for kind=remote_api providers.
   */
  baseUrl?: string;
  /** Default model id for remote API providers (non-secret). */
  model?: string;
  notes?: string;
  updatedAt?: string;
}

/**
 * Secrets for remote API providers — stored under controllerHome/global/provider-secrets.json
 * (never in the git repo). Values must never appear in facade list/status responses.
 */
export interface ProviderSecretEntry {
  /** Raw API key / bearer token. */
  apiKey?: string;
  updatedAt?: string;
}

export interface ProviderSecretsFile {
  schemaVersion: 1;
  updatedAt: string;
  providers: Record<string, ProviderSecretEntry>;
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
  /** Auth from process env. */
  envAuthPresent: boolean;
  /** Auth from controllerHome stored secret (GUI-configured). */
  storedAuthPresent: boolean;
  /** Masked hint only, e.g. …abc1 — never full key. */
  storedKeyHint?: string;
  baseUrl?: string;
  model?: string;
  defaultBaseUrl?: string;
  defaultModel?: string;
  setupExample: string;
  storageMode: 'environment_or_controller_home';
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
    envAuthPresent?: boolean;
    storedAuthPresent?: boolean;
    storedKeyHint?: string;
  };
  /** Remote API settings shown/edited in GUI (non-secret fields). */
  apiSettings?: {
    configurable: boolean;
    baseUrl: string;
    model: string;
    defaultBaseUrl: string;
    defaultModel: string;
    hasStoredApiKey: boolean;
    storedKeyHint?: string;
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
