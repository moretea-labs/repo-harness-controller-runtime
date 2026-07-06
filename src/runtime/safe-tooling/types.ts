import type { AssistantPluginActionConfirmation, AssistantPluginActionRisk } from '../plugins/types';

export type SafeToolRisk = AssistantPluginActionRisk | 'low' | 'medium' | 'high';

export interface SafeActionSummary {
  actionKey: string;
  title: string;
  readOnly: boolean;
  risk: AssistantPluginActionRisk;
  confirmation: AssistantPluginActionConfirmation;
  requiresExplicitApproval: boolean;
  argumentKeys: string[];
}

export interface SafePluginSummary {
  pluginId: string;
  displayName: string;
  provider: string;
  enabled: boolean;
  lifecycleState: string;
  healthState: string;
  ready: boolean;
  warnings: string[];
  errors: string[];
  permissionSummary: {
    total: number;
    granted: number;
    missingRequired: number;
    writableGranted: number;
  };
  actionSummary: {
    total: number;
    readonly: number;
    writable: number;
    remoteWrite: number;
    destructive: number;
    requiresApproval: number;
  };
  actions: SafeActionSummary[];
  redaction: {
    configContentReturned: false;
    rawSecretsReturned: false;
    rawPathsReturned: false;
  };
}

export interface WebTarget {
  targetKey: string;
  domain: string;
  origin: string;
  allowed: true;
  defaultPath: '/';
}

export interface WebDomainAccessPreview {
  ticketId: string;
  normalizedDomain: string;
  domainKey: string;
  reason: string;
  expiresAt: string;
  alreadyAllowed: boolean;
  currentAllowedDomainCount: number;
  risk: 'workspace_write';
  confirmation: 'authorization';
  localOnly: true;
  willChange: {
    pluginId: 'browser';
    configField: 'allowedDomains';
    addDomain: string;
  };
  safety: {
    arbitraryUrlAccepted: false;
    domainOnly: true;
    sensitiveConfigReturned: false;
  };
}

export interface SafeJobResultSummary {
  jobId: string;
  repoId: string;
  status: string;
  type: string;
  operation: string;
  plugin?: { pluginId?: string; actionId?: string };
  safeError?: {
    code?: string;
    class: 'dependency_missing' | 'policy_denied' | 'authorization_required' | 'platform_blocked' | 'runtime_error' | 'unknown';
    retryable?: boolean;
    message: string;
    suggestedFixes: string[];
  };
  resultAvailable: boolean;
  evidenceIds: string[];
  redaction: {
    rawStdoutReturned: false;
    rawStderrReturned: false;
    rawPathsReturned: false;
    rawSecretsReturned: false;
  };
}
