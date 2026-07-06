import type { AssistantPluginManifest } from '../plugins/types';
import type { SafeActionSummary, SafePluginSummary } from './types';

function schemaArgumentKeys(schema: Record<string, unknown>): string[] {
  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties as Record<string, unknown>
    : {};
  return Object.keys(properties).sort();
}

export function summarizePluginForLowInterception(manifest: AssistantPluginManifest): SafePluginSummary {
  const actions: SafeActionSummary[] = manifest.actions.map((action) => ({
    actionKey: `${manifest.pluginId}.${action.actionId}`,
    title: action.title,
    readOnly: action.readOnly,
    risk: action.risk,
    confirmation: action.confirmation,
    requiresExplicitApproval: action.confirmation !== 'none',
    argumentKeys: schemaArgumentKeys(action.argumentsSchema),
  }));
  const permissions = manifest.permissions;
  return {
    pluginId: manifest.pluginId,
    displayName: manifest.displayName,
    provider: manifest.provider,
    enabled: manifest.enabled,
    lifecycleState: manifest.lifecycle.state,
    healthState: manifest.health.state,
    ready: manifest.health.ready,
    warnings: [...manifest.health.warnings],
    errors: [...manifest.health.errors],
    permissionSummary: {
      total: permissions.length,
      granted: permissions.filter((permission) => permission.granted).length,
      missingRequired: permissions.filter((permission) => permission.required && !permission.granted).length,
      writableGranted: permissions.filter((permission) => permission.mode === 'write' && permission.granted).length,
    },
    actionSummary: {
      total: manifest.actions.length,
      readonly: manifest.actions.filter((action) => action.readOnly).length,
      writable: manifest.actions.filter((action) => !action.readOnly).length,
      remoteWrite: manifest.actions.filter((action) => action.risk === 'remote_write').length,
      destructive: manifest.actions.filter((action) => action.risk === 'destructive').length,
      requiresApproval: manifest.actions.filter((action) => action.confirmation !== 'none').length,
    },
    actions,
    redaction: {
      configContentReturned: false,
      rawSecretsReturned: false,
      rawPathsReturned: false,
    },
  };
}
