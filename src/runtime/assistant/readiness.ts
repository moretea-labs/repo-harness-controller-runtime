import type { RepositoryRecord } from '../../cli/repositories/types';
import { listAssistantPluginManifests } from '../plugins/store';
import { listAssistantInbox, listAssistantMemory, listAssistantRoutines } from './store';

export interface AssistantCapabilitySummary {
  capabilityId: string;
  state: 'ready' | 'mock' | 'needs_configuration' | 'disabled' | 'error';
  summary: string;
  recommendedNextActions: string[];
}

export interface AssistantReadinessReport {
  schemaVersion: 1;
  generatedAt: string;
  status: 'ready_for_mock' | 'needs_google_setup' | 'needs_attention';
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
  };
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
  return {
    capabilityId,
    state: 'needs_configuration',
    summary: plugin.health.errors[0] ?? `${displayName} needs configuration.`,
    recommendedNextActions: [`Configure ${plugin.pluginId} credentials and run a read-only self-test.`],
  };
}

export function buildAssistantReadinessReport(controllerHome: string, repository: RepositoryRecord): AssistantReadinessReport {
  const plugins = listAssistantPluginManifests(controllerHome, repository);
  const routines = listAssistantRoutines(repository.canonicalRoot).routines;
  const inbox = listAssistantInbox(repository.canonicalRoot, 200).items;
  const memory = listAssistantMemory(repository.canonicalRoot).entries;
  const byId = new Map(plugins.map((plugin) => [plugin.pluginId, plugin]));
  const capabilities = [
    googleCapability('gmail_read', 'Gmail read', byId.get('gmail')),
    googleCapability('calendar_read', 'Google Calendar read', byId.get('google_calendar')),
    googleCapability('tasks_read', 'Google Tasks read', byId.get('google_tasks')),
  ];
  const liveReady = capabilities.filter((capability) => capability.state === 'ready').length;
  const mockReady = capabilities.filter((capability) => capability.state === 'mock').length;
  const errors = capabilities.filter((capability) => capability.state === 'error').length;
  const status: AssistantReadinessReport['status'] = errors > 0
    ? 'needs_attention'
    : liveReady >= 2
      ? 'ready_for_mock'
      : 'needs_google_setup';
  const recommendations = [
    ...(mockReady > 0 ? ['Mock provider is useful for dry runs, but real Gmail/Calendar/Tasks routines require google-workspace credentials.'] : []),
    ...(capabilities.some((capability) => capability.state === 'disabled') ? ['Enable Gmail, Calendar, and Tasks plugins before expecting natural-language routines to collect real data.'] : []),
    ...(routines.length === 0 ? ['Create one routine such as: 每天早上 9 点整理过去 24 小时重要邮件。'] : []),
    ...(memory.length === 0 ? ['Seed assistant memory with communication tone, work keywords, and default safety preferences.'] : []),
  ];
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    summary: liveReady > 0
      ? `Assistant has ${liveReady} live Google capability group(s) and ${mockReady} mock group(s).`
      : `Assistant has ${mockReady} mock Google capability group(s); live Google setup is still needed.`,
    plugins: plugins.map((plugin) => ({
      pluginId: plugin.pluginId,
      provider: plugin.provider,
      enabled: plugin.enabled,
      lifecycleState: plugin.lifecycle.state,
      healthState: plugin.health.state,
      ready: plugin.health.ready,
      providerMode: pluginMode(plugin),
      credentialSource: credentialSource(plugin),
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
    },
    recommendations,
  };
}
