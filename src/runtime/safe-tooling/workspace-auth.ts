import type { AssistantPluginManifest } from '../plugins/types';
import { bootstrapManagedRuntimeEnv } from '../shared/managed-env';
import { prepareGoogleOAuthLogin, type GoogleOAuthService } from './google-oauth-broker';

export type WorkspaceAuthService = GoogleOAuthService;

interface WorkspaceAuthLoginInput {
  service?: string;
  scopes?: string[];
  redirectUri?: string;
}

const SERVICE_SCOPES: Record<WorkspaceAuthService, string[]> = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
  ],
  calendar: ['https://www.googleapis.com/auth/calendar'],
  tasks: ['https://www.googleapis.com/auth/tasks'],
  'google-workspace': [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks',
  ],
};

const SCOPE_ALIASES: Record<string, string> = {
  'gmail.readonly': 'https://www.googleapis.com/auth/gmail.readonly',
  'gmail.compose': 'https://www.googleapis.com/auth/gmail.compose',
  'gmail.modify': 'https://www.googleapis.com/auth/gmail.modify',
  'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
  'calendar.events.readonly': 'https://www.googleapis.com/auth/calendar',
  'calendar.events.write': 'https://www.googleapis.com/auth/calendar',
  'calendar.events.delete': 'https://www.googleapis.com/auth/calendar',
  'tasks.readonly': 'https://www.googleapis.com/auth/tasks',
  'tasks.write': 'https://www.googleapis.com/auth/tasks',
  'tasks.delete': 'https://www.googleapis.com/auth/tasks',
};

function normalizeService(value: unknown): WorkspaceAuthService {
  const raw = String(value ?? 'google-workspace').trim().toLowerCase().replace(/^google_/, 'google-');
  if (raw === 'gmail' || raw === 'calendar' || raw === 'tasks' || raw === 'google-workspace') return raw;
  throw new Error('WORKSPACE_AUTH_SERVICE_UNSUPPORTED: choose gmail, calendar, tasks, or google-workspace');
}

function pluginAuthSummary(manifest: AssistantPluginManifest): Record<string, unknown> {
  return {
    pluginId: manifest.pluginId,
    enabled: manifest.enabled,
    lifecycleState: manifest.lifecycle.state,
    lifecycleReason: manifest.lifecycle.reason,
    healthState: manifest.health.state,
    ready: manifest.health.ready,
    authRequired: manifest.health.errors.some((error) => /access token|auth|authorization|oauth/i.test(error)),
    errors: manifest.health.errors.slice(0, 5),
    warnings: manifest.health.warnings.slice(0, 5),
    grantedPermissions: manifest.permissions.filter((permission) => permission.granted).map((permission) => permission.scope),
    missingRequiredPermissions: manifest.permissions.filter((permission) => permission.required && !permission.granted).map((permission) => permission.scope),
  };
}

export function buildWorkspaceAuthStatus(manifests: AssistantPluginManifest[]): Record<string, unknown> {
  const workspacePlugins = manifests.filter((manifest) => ['gmail', 'google_calendar', 'google_tasks', 'google-calendar', 'google-tasks'].includes(manifest.pluginId));
  const summaries = workspacePlugins.map(pluginAuthSummary);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    providers: summaries,
    actionRequired: summaries.filter((entry) => entry.authRequired === true || entry.ready !== true).map((entry) => ({
      pluginId: entry.pluginId,
      reason: entry.lifecycleReason,
      next: 'Call workspace_auth_login_prepare and open the returned local OAuth URL. The callback stores the refresh token in macOS Keychain.',
    })),
    safety: {
      credentialMaterialReturned: false,
      credentialMaterialPersistedInRepository: false,
      repositoryMutation: false,
    },
  };
}

export function prepareWorkspaceAuthLogin(
  controllerHomeOrInput: string | WorkspaceAuthLoginInput = {},
  maybeInput: WorkspaceAuthLoginInput = {},
): Record<string, unknown> {
  bootstrapManagedRuntimeEnv();
  const controllerHome = typeof controllerHomeOrInput === 'string'
    ? controllerHomeOrInput
    : process.env.REPO_HARNESS_CONTROLLER_HOME?.trim() || process.cwd();
  const input = typeof controllerHomeOrInput === 'string' ? maybeInput : controllerHomeOrInput;
  const service = normalizeService(input.service);
  const redirectUri = input.redirectUri || process.env.REPO_HARNESS_GOOGLE_REDIRECT_URI || 'http://127.0.0.1:8766/oauth/google/callback';
  const requestedScopes = Array.isArray(input.scopes) && input.scopes.length > 0
    ? input.scopes.map((scope) => SCOPE_ALIASES[String(scope)] ?? String(scope)).filter(Boolean)
    : SERVICE_SCOPES[service];
  const prepared = prepareGoogleOAuthLogin(controllerHome, { service, scopes: requestedScopes, redirectUri });
  const priorSafety = prepared.safety && typeof prepared.safety === 'object' && !Array.isArray(prepared.safety)
    ? prepared.safety as Record<string, unknown>
    : {};
  return {
    ...prepared,
    tokenEnvironmentVariables: service === 'gmail'
      ? ['REPO_HARNESS_GMAIL_ACCESS_TOKEN', 'REPO_HARNESS_GMAIL_REFRESH_TOKEN']
      : ['REPO_HARNESS_GOOGLE_WORKSPACE_ACCESS_TOKEN', 'REPO_HARNESS_GOOGLE_WORKSPACE_REFRESH_TOKEN'],
    safety: {
      ...priorSafety,
      credentialMaterialPersisted: false,
      credentialMaterialPersistedInRepository: false,
    },
  };
}
