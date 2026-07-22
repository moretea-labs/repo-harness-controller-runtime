/**
 * Authoritative Local Bridge / Local Controller surface resolution.
 *
 * Port mapping (blue/green):
 * - Root template default: 8766
 * - Inactive slot offsets by +10 (e.g. green inactive often → 8776)
 * - Active slot keeps base ports unless slot-local config overrides
 *
 * Never hardcode "8776 is correct"; prefer active-slot runtime state and
 * slot-local config under controller-home/runtime-slots/<slot>/mcp/.
 */

import {
  loadMcpLocalConfig,
  loadMcpRuntimeState,
  loadMcpServiceLocalConfig,
  loadMcpServiceRuntimeState,
  type McpLocalConfig,
  type McpRuntimeState,
} from '../../cli/mcp/auth';
import {
  readActiveSlotAuthority,
  runtimeSlotForHome,
  slotHomePath,
} from '../../cli/controller/runtime-slots';
import { inferLocalControllerProcess } from '../diagnostics/performance';
import type { LocalBridgeMode } from '../health/evaluator';

export type LocalBridgeSurfaceMode = LocalBridgeMode;

export interface LocalBridgeSurface {
  mode: LocalBridgeSurfaceMode;
  /** True when the product intends a Local Controller surface for this repo/runtime. */
  enabled: boolean;
  /** True when readiness must fail closed without a healthy surface. */
  requiredForReadiness: boolean;
  /** Configured or observed endpoint URL (may be undefined when disabled / not applicable). */
  endpoint?: string;
  endpointConfigured: boolean;
  /** Expected surface kind for operators and probes. */
  expectedSurface: 'local-controller' | 'none';
  processRunning?: boolean;
  pid?: number;
  generation?: string;
  error?: string;
  /** Where endpoint/mode were resolved from. */
  source: 'service-runtime' | 'repo-runtime' | 'service-config' | 'repo-config' | 'process-scan' | 'none';
  ownerKind: 'mcp-keepalive' | 'controller-service' | 'external' | 'unknown' | 'none';
  /** Active runtime slot when resolved from blue/green homes. */
  activeSlot?: 'blue' | 'green';
}

function normalizeEndpoint(host: string, port: number): string {
  const safeHost = host.trim() || '127.0.0.1';
  const displayHost = safeHost === '0.0.0.0' || safeHost === '::' ? '127.0.0.1' : safeHost;
  return `http://${displayHost}:${port}/`;
}

function modeFromRuntime(runtime: McpRuntimeState | null | undefined): LocalBridgeSurfaceMode | undefined {
  const mode = runtime?.localController?.mode;
  if (mode === 'standalone' || mode === 'embedded' || mode === 'remote' || mode === 'disabled' || mode === 'unknown') {
    return mode;
  }
  return undefined;
}

/**
 * Prefer the active blue/green slot home when the caller passes root controller-home.
 * Slot homes already contain their own mcp/ tree; do not re-nest.
 */
function resolveAuthoritativeMcpHomes(controllerHome: string | undefined): {
  homes: string[];
  activeSlot?: 'blue' | 'green';
} {
  if (!controllerHome) return { homes: [] };
  const existingSlot = runtimeSlotForHome(controllerHome);
  if (existingSlot) {
    return { homes: [controllerHome], activeSlot: existingSlot };
  }
  try {
    const authority = readActiveSlotAuthority(controllerHome);
    const activeHome = slotHomePath(controllerHome, authority.activeSlot);
    // Prefer active slot, then root controller-home as fallback template.
    return {
      homes: [activeHome, controllerHome],
      activeSlot: authority.activeSlot,
    };
  } catch {
    return { homes: [controllerHome] };
  }
}

function firstServiceRuntime(homes: string[]): {
  runtime: McpRuntimeState | null;
  home?: string;
} {
  // Do not pass legacyRepoRoot while scanning homes: an empty slot home would
  // otherwise inherit repo-local runtime and shadow a later authoritative home.
  for (const home of homes) {
    const runtime = loadMcpServiceRuntimeState(home);
    if (runtime?.localController) return { runtime, home };
  }
  for (const home of homes) {
    const runtime = loadMcpServiceRuntimeState(home);
    if (runtime) return { runtime, home };
  }
  return { runtime: null };
}

function firstServiceConfig(homes: string[]): {
  config: McpLocalConfig | null;
  home?: string;
} {
  // Same rule as runtime: slot homes without mcp/* must not fall back to
  // repo-local disabled/legacy config before later homes are considered.
  for (const home of homes) {
    const config = loadMcpServiceLocalConfig(home);
    if (config?.localController) return { config, home };
  }
  for (const home of homes) {
    const config = loadMcpServiceLocalConfig(home);
    if (config) return { config, home };
  }
  return { config: null };
}

/**
 * Resolve Local Bridge capability from controller-home (authoritative) then repo-local fallbacks.
 * When blue/green is active, the active slot's mcp.runtime.json / mcp.local.json win over root.
 */
export function resolveLocalBridgeSurface(input: {
  controllerHome?: string;
  repoRoot: string;
  /** Optional process scan; when omitted, scan only if runtime state is missing. */
  allowProcessScan?: boolean;
}): LocalBridgeSurface {
  const allowProcessScan = input.allowProcessScan !== false;
  const { homes, activeSlot } = resolveAuthoritativeMcpHomes(input.controllerHome);

  const { runtime: serviceRuntime } = firstServiceRuntime(homes);
  const repoRuntime = loadMcpRuntimeState(input.repoRoot);
  const runtime = serviceRuntime?.localController ? serviceRuntime : (repoRuntime ?? serviceRuntime);
  const runtimeSource: LocalBridgeSurface['source'] = serviceRuntime?.localController
    ? 'service-runtime'
    : repoRuntime?.localController
      ? 'repo-runtime'
      : 'none';

  const { config: serviceConfig } = firstServiceConfig(homes);
  const repoConfig = loadMcpLocalConfig(input.repoRoot);
  const config = serviceConfig?.localController ? serviceConfig : (repoConfig ?? serviceConfig);
  const configSource: LocalBridgeSurface['source'] = serviceConfig?.localController
    ? 'service-config'
    : repoConfig?.localController
      ? 'repo-config'
      : 'none';

  const configuredEnabled = config?.localController?.enabled;
  const configuredMode = config?.localController?.mode;
  const configuredHost = config?.localController?.host ?? '127.0.0.1';
  const configuredPort = config?.localController?.port;
  const configuredEndpoint = typeof configuredPort === 'number' && Number.isFinite(configuredPort)
    ? normalizeEndpoint(configuredHost, configuredPort)
    : undefined;

  const runtimeLc = runtime?.localController;
  if (runtimeLc) {
    const mode = modeFromRuntime(runtime) ?? configuredMode ?? 'unknown';
    const enabled = mode !== 'disabled' && configuredEnabled !== false;
    // Prefer live runtime endpoint; fall back to matching config from the same authority chain.
    const endpoint = runtimeLc.endpoint?.trim() || configuredEndpoint;
    const ownerKind = mode === 'embedded'
      ? 'mcp-keepalive'
      : mode === 'remote'
        ? 'external'
        : mode === 'standalone'
          ? 'controller-service'
          : 'unknown';
    return {
      mode: enabled ? mode : 'disabled',
      enabled,
      // Embedded UI is operationally useful but not a hard readiness gate unless
      // standalone mode is configured and required by deployment.
      requiredForReadiness: enabled && mode === 'standalone',
      endpoint,
      endpointConfigured: Boolean(endpoint),
      expectedSurface: enabled ? 'local-controller' : 'none',
      processRunning: runtimeLc.running,
      pid: runtimeLc.pid,
      generation: runtimeLc.generation ?? runtime?.generation,
      error: runtimeLc.error,
      source: runtimeSource === 'none' ? 'service-runtime' : runtimeSource,
      ownerKind,
      ...(activeSlot ? { activeSlot } : {}),
    };
  }

  if (configuredEnabled === false || configuredMode === 'disabled') {
    return {
      mode: 'disabled',
      enabled: false,
      requiredForReadiness: false,
      endpoint: configuredEndpoint,
      endpointConfigured: Boolean(configuredEndpoint),
      expectedSurface: 'none',
      source: configSource === 'none' ? 'service-config' : configSource,
      ownerKind: 'none',
      ...(activeSlot ? { activeSlot } : {}),
    };
  }

  if (configuredEndpoint) {
    const mode = configuredMode ?? 'standalone';
    return {
      mode,
      enabled: true,
      requiredForReadiness: mode === 'standalone',
      endpoint: configuredEndpoint,
      endpointConfigured: true,
      expectedSurface: 'local-controller',
      source: configSource === 'none' ? 'service-config' : configSource,
      ownerKind: mode === 'embedded' ? 'mcp-keepalive' : mode === 'standalone' ? 'controller-service' : 'unknown',
      ...(activeSlot ? { activeSlot } : {}),
    };
  }

  if (allowProcessScan) {
    const inferred = inferLocalControllerProcess(input.repoRoot);
    if (inferred?.running) {
      return {
        mode: 'standalone',
        enabled: true,
        requiredForReadiness: false,
        endpoint: inferred.endpoint,
        endpointConfigured: Boolean(inferred.endpoint),
        expectedSurface: 'local-controller',
        processRunning: true,
        pid: inferred.pid,
        source: 'process-scan',
        ownerKind: 'controller-service',
        ...(activeSlot ? { activeSlot } : {}),
      };
    }
  }

  // No configured surface: do not invent legacy 8766 as an expected endpoint.
  return {
    mode: 'unknown',
    enabled: false,
    requiredForReadiness: false,
    endpointConfigured: false,
    expectedSurface: 'none',
    source: 'none',
    ownerKind: 'none',
    ...(activeSlot ? { activeSlot } : {}),
  };
}

export function summarizeRecentJobs(jobs: Array<{ status: string }>): {
  activeJobCount: number;
  recentJobSummary: Record<string, number>;
} {
  const recentJobSummary: Record<string, number> = {};
  let activeJobCount = 0;
  for (const job of jobs) {
    recentJobSummary[job.status] = (recentJobSummary[job.status] ?? 0) + 1;
    if (['approved', 'running', 'dispatched'].includes(job.status)) activeJobCount += 1;
  }
  return { activeJobCount, recentJobSummary };
}
