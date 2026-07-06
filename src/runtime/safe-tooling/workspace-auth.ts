import { URLSearchParams } from 'url';
import type { AssistantPluginManifest } from '../plugins/types';

export type WorkspaceAuthService = 'gmail' | 'calendar' | 'tasks' | 'google-workspace';

interface WorkspaceAuthLoginInput {
  service?: string;
  scopes?: string[];
  redirectUri?: string;
}

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

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
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks',
  ],
};

const TOKEN_ENV: Record<WorkspaceAuthService, string[]> = {
  gmail: ['REPO_HARNESS_GMAIL_ACCESS_TOKEN', 'REPO_HARNESS_GOOGLE_WORKSPACE_ACCESS_TOKEN', 'REPO_HARNESS_GOOGLE_ACCESS_TOKEN'],
  calendar: ['REPO_HARNESS_GOOGLE_CALENDAR_ACCESS_TOKEN', 'REPO_HARNESS_GOOGLE_WORKSPACE_ACCESS_TOKEN', 'REPO_HARNESS_GOOGLE_ACCESS_TOKEN'],
  tasks: ['REPO_HARNESS_GOOGLE_TASKS_ACCESS_TOKEN', 'REPO_HARNESS_GOOGLE_WORKSPACE_ACCESS_TOKEN', 'REPO_HARNESS_GOOGLE_ACCESS_TOKEN'],
  'google-workspace': ['REPO_HARNESS_GOOGLE_WORKSPACE_ACCESS_TOKEN', 'REPO_HARNESS_GOOGLE_ACCESS_TOKEN'],
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
      next: 'Call workspace_auth_login_prepare for a scoped local login handoff. Tokens are not stored in repository files.',
    })),
    safety: {
      credentialMaterialReturned: false,
      credentialMaterialPersisted: false,
      repositoryMutation: false,
    },
  };
}

export function prepareWorkspaceAuthLogin(input: WorkspaceAuthLoginInput = {}): Record<string, unknown> {
  const service = normalizeService(input.service);
  const clientId = process.env.REPO_HARNESS_GOOGLE_CLIENT_ID?.trim() || process.env.GOOGLE_CLIENT_ID?.trim();
  const redirectUri = input.redirectUri || process.env.REPO_HARNESS_GOOGLE_REDIRECT_URI || 'http://127.0.0.1:8766/oauth/google/callback';
  const requestedScopes = Array.isArray(input.scopes) && input.scopes.length > 0
    ? input.scopes.map(String).filter(Boolean)
    : SERVICE_SCOPES[service];
  const params = new URLSearchParams({
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    redirect_uri: redirectUri,
    scope: requestedScopes.join(' '),
  });
  if (clientId) params.set('client_id', clientId);
  return {
    schemaVersion: 1,
    provider: 'google-workspace',
    service,
    readyToOpenBrowser: Boolean(clientId),
    authorizationUrl: clientId ? `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}` : undefined,
    missingConfiguration: clientId ? [] : ['Set REPO_HARNESS_GOOGLE_CLIENT_ID before generating an OAuth URL.'],
    redirectUri,
    scopes: requestedScopes,
    tokenEnvironmentVariables: TOKEN_ENV[service],
    exchangeGuidance: {
      implementedAs: 'handoff',
      reason: 'The MCP tool must not receive or persist Google credential material. Exchange the code in a local CLI/browser flow and expose the access token through environment variables or a future OS-keychain backend.',
      localNextSteps: [
        'Open the authorizationUrl locally when readyToOpenBrowser=true.',
        'Exchange the returned code in a local trusted process using your Google OAuth client credentials.',
        `Export one of: ${TOKEN_ENV[service].join(', ')}.`,
        'Restart repo-harness controller so plugin health can re-probe the environment.',
      ],
    },
    safety: {
      credentialMaterialReturned: false,
      credentialMaterialPersisted: false,
      opensBrowserAutomatically: false,
      requiresLocalTrustedProcess: true,
    },
  };
}
