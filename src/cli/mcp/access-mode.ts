import { existsSync } from 'fs';
import {
  loadMcpServiceLocalConfig,
  mcpControllerHomeLocalConfigPath,
  mcpLocalConfigPath,
  type McpLocalConfig,
  writeMcpServiceLocalConfig,
} from './auth';
import type { McpToolset } from './types';
import {
  isAccessMode,
  type AccessMode,
} from '../../runtime/control-plane/governance/access-policy';

export type ControllerAccessConfigSource =
  | 'runtime_override.toolset'
  | 'controller_home.access_mode'
  | 'repo_local_fallback.access_mode'
  | 'controller_home.legacy_toolset'
  | 'repo_local_fallback.legacy_toolset'
  | 'default';

export interface ControllerAccessState {
  configuredAccessMode: AccessMode;
  effectiveAccessMode: AccessMode;
  effectiveToolset: McpToolset;
  source: ControllerAccessConfigSource;
  lastAppliedAt?: string;
  exposureRevision: number;
  configPathSource: 'runtime_override' | 'controller_home' | 'repo_local_fallback' | 'default';
  legacyToolset?: McpToolset;
}

export interface ResolveControllerAccessStateInput {
  controllerHome: string;
  repoRoot?: string;
  toolsetOverride?: McpToolset;
  toolsetLocked?: boolean;
}

export interface PersistControllerAccessModeResult {
  configPath: string;
  config: McpLocalConfig;
  state: ControllerAccessState;
}

function normalizeMaybeToolset(value: unknown): McpToolset | undefined {
  if (value === 'core' || value === 'advanced' || value === 'full') return value;
  return undefined;
}

export function accessModeForLegacyToolset(toolset: McpToolset): AccessMode {
  return toolset === 'core' ? 'request' : 'full_access';
}

export function legacyToolsetForAccessMode(mode: AccessMode): McpToolset {
  return mode === 'full_access' ? 'advanced' : 'core';
}

function configLocation(controllerHome: string, repoRoot?: string): 'controller_home' | 'repo_local_fallback' | 'default' {
  if (existsSync(mcpControllerHomeLocalConfigPath(controllerHome))) return 'controller_home';
  if (repoRoot && existsSync(mcpLocalConfigPath(repoRoot))) return 'repo_local_fallback';
  return 'default';
}

function normalizedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export function resolveControllerAccessState(input: ResolveControllerAccessStateInput): ControllerAccessState {
  const location = configLocation(input.controllerHome, input.repoRoot);
  const config = loadMcpServiceLocalConfig(input.controllerHome, input.repoRoot);
  const lastAppliedAt = typeof config?.accessModeUpdatedAt === 'string' && config.accessModeUpdatedAt.trim()
    ? config.accessModeUpdatedAt
    : undefined;
  const exposureRevision = normalizedRevision(config?.accessModeRevision);

  if (input.toolsetLocked === true && input.toolsetOverride) {
    const mode = accessModeForLegacyToolset(input.toolsetOverride);
    return {
      configuredAccessMode: mode,
      effectiveAccessMode: mode,
      effectiveToolset: input.toolsetOverride,
      source: 'runtime_override.toolset',
      lastAppliedAt,
      exposureRevision,
      configPathSource: 'runtime_override',
      legacyToolset: input.toolsetOverride,
    };
  }

  if (isAccessMode(config?.accessMode)) {
    return {
      configuredAccessMode: config.accessMode,
      effectiveAccessMode: config.accessMode,
      effectiveToolset: legacyToolsetForAccessMode(config.accessMode),
      source: location === 'controller_home' ? 'controller_home.access_mode' : 'repo_local_fallback.access_mode',
      lastAppliedAt,
      exposureRevision,
      configPathSource: location,
      legacyToolset: normalizeMaybeToolset(config?.toolset),
    };
  }

  const legacyToolset = normalizeMaybeToolset(config?.toolset);
  if (legacyToolset) {
    const mode = accessModeForLegacyToolset(legacyToolset);
    return {
      configuredAccessMode: mode,
      effectiveAccessMode: mode,
      effectiveToolset: legacyToolset,
      source: location === 'controller_home' ? 'controller_home.legacy_toolset' : 'repo_local_fallback.legacy_toolset',
      lastAppliedAt,
      exposureRevision,
      configPathSource: location,
      legacyToolset,
    };
  }

  return {
    configuredAccessMode: 'request',
    effectiveAccessMode: 'request',
    effectiveToolset: 'core',
    source: 'default',
    exposureRevision,
    configPathSource: 'default',
  };
}

export function persistControllerAccessMode(
  controllerHome: string,
  mode: AccessMode,
  repoRoot?: string,
): PersistControllerAccessModeResult {
  const existing = loadMcpServiceLocalConfig(controllerHome, repoRoot) ?? {};
  const accessModeUpdatedAt = new Date().toISOString();
  const accessModeRevision = normalizedRevision(existing.accessModeRevision) + 1;
  const config: McpLocalConfig = {
    ...existing,
    version: existing.version ?? 1,
    profile: existing.profile ?? 'controller',
    accessMode: mode,
    accessModeUpdatedAt,
    accessModeRevision,
    toolset: legacyToolsetForAccessMode(mode),
  };
  const configPath = writeMcpServiceLocalConfig(controllerHome, config);
  return {
    configPath,
    config,
    state: resolveControllerAccessState({ controllerHome, repoRoot }),
  };
}
