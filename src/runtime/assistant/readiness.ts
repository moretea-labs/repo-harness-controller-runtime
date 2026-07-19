import type { RepositoryRecord } from '../../cli/repositories/types';
import { listAssistantPluginManifests } from '../plugins/store';
import { listAssistantInbox, listAssistantMemory, listAssistantRoutines } from './store';
import { assistantModelReadiness } from './model-provider';
import { listAssistantStandingGrants } from './standing-grants';

export interface AssistantCapabilitySummary {
  capabilityId: string;
  state: 'ready' | 'mock' | 'needs_configuration' | 'disabled' | 'error';
  summary: string;
  recommendedNextActions: string[];
}

export interface AssistantReadinessReport {
  schemaVersion: 1;
  generatedAt: string;
  status: 'ready_for_live' | 'ready_for_mock' | 'needs_google_setup' | 'needs_attention';
  summary: string;
  plugins: Array<{
    pluginId: string;
    provider: string;
    enabled: boolean;
    lifecycleState: string;
    healthState: string;
    ready: boolean;
    providerMode?: unknown;
    credentialSource?: unknown;
    readinessMode?: unknown;
    userFacingStatus?: unknown;
    warnings: string[];
    errors: string[];
    actions: Array<{ actionId: string; readOnly: boolean; risk: string; confirmation: string }>;
  }>;
  capabilities: AssistantCapabilitySummary[];
  assistantState: {
    routines: number;
    enabledRoutines: number;
    inboxItems: number;
    unreadInboxItems: number;
    memoryEntries: number;
    activeStandingGrants: number;
  };
  model: Record<string, unknown>;
  recommendations: string[];
}

function pluginMode(plugin: ReturnType<typeof listAssistantPluginManifests>[number]): unknown {
  return plugin.health.details && typeof plugin.health.details === 'object'
    ? (plugin.health.details as Record<string, unknown>).provider
    : undefined;
}

function credentialSource(plugin: ReturnType<typeof listAssistantPluginManifests>[number]): unknown {
  return plugin.health.details && typeof plugin.health.details === 'object'
    ? (plugin.health.details as Record<string, unknown>).credentialSource
    : undefined;
}

function readinessMode(plugin: ReturnType<typeof listAssistantPluginManifests>[number]): unknown {
  return plugin.health.details && typeof plugin.health.details === 'object'
    ? (plugin.health.details as Record<string, unknown>).readinessMode
    : undefined;
}

function userFacingStatus(plugin: ReturnType<typeof listAssistantPluginManifests>[number]): unknown {
  return plugin.health.details && typeof plugin.health.details === 'object'
    ? (plugin.health.details as Record<string, unknown>).userFacingStatus
    : undefined;
}

function googleCapability(
  capabilityId: string,
  displayName: string,
  plugin: ReturnType<typeof listAssistantPluginManifests>[number] | undefined,
): AssistantCapabilitySummary {
  if (!plugin) {
    return {
      capabilityId,
      state: 'needs_configuration',
      summary: `${displayName} plugin is not registered.`,
      recommendedNextActions: ['Verify plugin registration and rebuild the runtime tool surface.'],
    };
  }
  if (!plugin.enabled) {
    return {
      capabilityId,
      state: 'disabled',
      summary: `${displayName} plugin is disabled.`,
      recommendedNextActions: [`Enable ${plugin.pluginId} in mock mode for dry-run testing or google-workspace mode for real use.`],
    };
  }
  if (plugin.health.state === 'error') {
    return {
      capabilityId,
      state: 'error',
      summary: plugin.health.errors[0] ?? `${displayName} plugin is in error state.`,
      recommendedNextActions: plugin.health.errors.length > 0 ? plugin.health.errors : [`Reconfigure ${plugin.pluginId}.`],
    };
  }
  if (plugin.health.ready && pluginMode(plugin) === 'mock') {
    return {
      capabilityId,
      state: 'mock',
      summary: `${displayName} is ready in mock mode; this validates the execution path without touching real Google data.`,
      recommendedNextActions: [`Switch ${plugin.pluginId} to google-workspace and provide the matching REPO_HARNESS_*_ACCESS_TOKEN for live testing.`],
    };
  }
  if (plugin.health.ready) {
    return {
      capabilityId,
      state: 'ready',
      summary: `${displayName} is ready for live use via ${String(credentialSource(plugin) ?? 'configured credentials')}.`,
      recommendedNextActions: [],
    };
  }
  if (readinessMode(plugin) === 'missing_token') {
    return {
      capabilityId,
      state: 'needs_configuration',
      summary: `${displayName} live token is missing; mock mode remains available for dry runs.`,
      recommendedNextActions: [
        `Set the matching REPO_HARNESS_*_ACCESS_TOKEN, or switch ${plugin.pluginId} provider to mock.`,
      ],
    };
  }
  return {
    capabilityId,
    state: 'needs_configuration',
    summary: plugin.health.errors[0] ?? plugin.health.warnings[0] ?? `${displayName} needs configuration.`,
    recommendedNextActions: [`Configure ${plugin.pluginId} credentials and run a read-only self-test.`],
  };
}

function automationCapability(
  capabilityId: string,
  displayName: string,
  plugin: ReturnType<typeof listAssistantPluginManifests>[number] | undefined,
): AssistantCapabilitySummary {
  if (!plugin) {
    return {
      capabilityId,
      state: 'needs_configuration',
      summary: `${displayName} plugin is not registered.`,
      recommendedNextActions: ['Verify plugin registration.'],
    };
  }
  const userFacing = plugin.health.details && typeof plugin.health.details === 'object'
    ? String((plugin.health.details as Record<string, unknown>).userFacingStatus ?? '')
    : '';
  if (!plugin.enabled) {
    return {
      capabilityId,
      state: 'disabled',
      summary: userFacing || `${displayName} is disabled.`,
      recommendedNextActions: [`Enable ${plugin.pluginId} via configure.`],
    };
  }
  if (plugin.health.ready) {
    return {
      capabilityId,
      state: pluginMode(plugin) === 'mock' ? 'mock' : 'ready',
      summary: userFacing || `${displayName} is ready.`,
      recommendedNextActions: [],
    };
  }
  if (plugin.health.state === 'error') {
    return {
      capabilityId,
      state: 'error',
      summary: plugin.health.errors[0] ?? `${displayName} is in error state.`,
      recommendedNextActions: plugin.health.errors,
    };
  }
  return {
    capabilityId,
    state: 'needs_configuration',
    summary: userFacing || plugin.health.warnings[0] || `${displayName} needs setup.`,
    recommendedNextActions: plugin.health.warnings.slice(0, 3),
  };
}

export function buildAssistantReadinessReport(controllerHome: string, repository: RepositoryRecord): AssistantReadinessReport {
  const plugins = listAssistantPluginManifests(controllerHome, repository);
  const routines = listAssistantRoutines(repository.canonicalRoot).routines;
  const inbox = listAssistantInbox(repository.canonicalRoot, 200).items;
  const memory = listAssistantMemory(repository.canonicalRoot).entries;
  const model = assistantModelReadiness();
  const standingGrants = listAssistantStandingGrants(controllerHome, repository, { status: 'active', limit: 500 }).grants;
  const byId = new Map(plugins.map((plugin) => [plugin.pluginId, plugin]));
  const capabilities = [
    googleCapability('gmail_read', 'Gmail read', byId.get('gmail')),
    googleCapability('calendar_read', 'Google Calendar read', byId.get('google_calendar')),
    googleCapability('tasks_read', 'Google Tasks read', byId.get('google_tasks')),
    automationCapability('ios_smoke_review', 'iOS smoke review', byId.get('ios')),
    automationCapability('app_store_connect', 'App Store Connect', byId.get('app_store_connect')),
    automationCapability('browser_automation', 'Browser automation', byId.get('browser')),
  ];
  const googleCapabilities = capabilities.filter((capability) =>
    capability.capabilityId === 'gmail_read'
      || capability.capabilityId === 'calendar_read'
      || capability.capabilityId === 'tasks_read');
  const liveGoogleReady = googleCapabilities.filter((capability) => capability.state === 'ready').length;
  const mockGoogleReady = googleCapabilities.filter((capability) => capability.state === 'mock').length;
  const errors = capabilities.filter((capability) => capability.state === 'error').length;
  const status: AssistantReadinessReport['status'] = errors > 0
    ? 'needs_attention'
    : liveGoogleReady > 0
      ? 'ready_for_live'
      : mockGoogleReady > 0
        ? 'ready_for_mock'
        : 'needs_google_setup';
  const recommendations = [
    ...(mockGoogleReady > 0 ? ['Mock provider is useful for dry runs, but real Gmail/Calendar/Tasks routines require google-workspace credentials.'] : []),
    ...(capabilities.some((capability) => capability.state === 'disabled') ? ['Enable Gmail, Calendar, and Tasks plugins before expecting natural-language routines to collect real data.'] : []),
    ...(routines.length === 0 ? ['Create one routine such as: 每天早上 9 点整理过去 24 小时重要邮件。'] : []),
    ...(memory.length === 0 ? ['Seed assistant memory with communication tone, work keywords, and default safety preferences.'] : []),
    ...(model.configured !== true ? ['Configure the optional Assistant model provider for richer mail analysis; deterministic rules remain available.'] : []),
  ];
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    summary: liveGoogleReady > 0 || mockGoogleReady > 0
      ? `Assistant has ${liveGoogleReady} live Google capability group(s) and ${mockGoogleReady} mock group(s).`
      : 'Assistant has 0 live Google capability group(s) and 0 mock group(s); live Google setup is still needed.',
    plugins: plugins.map((plugin) => ({
      pluginId: plugin.pluginId,
      provider: plugin.provider,
      enabled: plugin.enabled,
      lifecycleState: plugin.lifecycle.state,
      healthState: plugin.health.state,
      ready: plugin.health.ready,
      providerMode: pluginMode(plugin),
      credentialSource: credentialSource(plugin),
      readinessMode: readinessMode(plugin),
      userFacingStatus: userFacingStatus(plugin),
      warnings: plugin.health.warnings,
      errors: plugin.health.errors,
      actions: plugin.actions.map((action) => ({
        actionId: action.actionId,
        readOnly: action.readOnly,
        risk: action.risk,
        confirmation: action.confirmation,
      })),
    })),
    capabilities,
    assistantState: {
      routines: routines.length,
      enabledRoutines: routines.filter((routine) => routine.status === 'enabled').length,
      inboxItems: inbox.length,
      unreadInboxItems: inbox.filter((item) => item.status === 'unread').length,
      memoryEntries: memory.length,
      activeStandingGrants: standingGrants.length,
    },
    model,
    recommendations,
  };
}
